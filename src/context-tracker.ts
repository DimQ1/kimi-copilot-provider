import * as vscode from 'vscode';
import type { KimiMessage } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Session context tracker — estimates the size of the current conversation
// and warns/blocks when the request is about to exceed model limits.
// ═══════════════════════════════════════════════════════════════════════

export interface ContextEstimate {
	/** Estimated tokens for the next request (history + prompt). */
	tokens: number;
	/** Effective token limit for the active model / plan. */
	limit: number;
	/** 0..1 ratio of tokens to limit. */
	ratio: number;
	/** Human readable status: ok, warning, critical, exceeded. */
	status: 'ok' | 'warning' | 'critical' | 'exceeded';
}

export interface SessionContextTrackerOptions {
	/** Max input tokens reported by the model. */
	maxInputTokens: number;
	/** Hard per-request limit (prompt + history + files). */
	singleRequestLimit?: number;
	/** Multi-tier limits if the user is on a higher plan. */
	multiTierContext?: { default: number; allegretto: number };
	/** Ratio at which we warn the user (0..1). */
	warningThreshold: number;
	/** Ratio at which we refuse to send the request (0..1). */
	errorThreshold: number;
	/** Plan hint from the user (e.g. 'moderato', 'allegretto', 'allegro', 'vivace'). */
	plan?: string;
}

/**
 * Estimates the token count for a Kimi message.
 * - text parts: chars / 3.5
 * - image parts: fixed conservative estimate (images are heavy)
 * - tool results / calls: chars / 3.5
 */
function estimateMessageTokens(message: KimiMessage): number {
	let tokens = 0;
	const overhead = 4; // per-message overhead

	if (typeof message.content === 'string') {
		tokens += Math.max(1, Math.ceil(message.content.length / 3.5));
	} else if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part.type === 'text') {
				tokens += Math.max(1, Math.ceil(part.text.length / 3.5));
			} else if (part.type === 'image_url') {
				// Conservative estimate for a base64 image. Actual size depends on
				// resolution, but this is enough to warn users early.
				tokens += 1024;
			}
		}
	}

	if (message.tool_calls && message.tool_calls.length > 0) {
		for (const tc of message.tool_calls) {
			tokens += Math.max(1, Math.ceil(tc.function.name.length / 3.5));
			tokens += Math.max(1, Math.ceil(tc.function.arguments.length / 3.5));
		}
	}

	return tokens + overhead;
}

export class SessionContextTracker {
	private options: SessionContextTrackerOptions;

	constructor(options: SessionContextTrackerOptions) {
		this.options = options;
	}

	updateOptions(options: Partial<SessionContextTrackerOptions>): void {
		this.options = { ...this.options, ...options };
	}

	/**
	 * Returns the effective input token limit for the active model/plan.
	 * Moderato users are capped at singleRequestLimit; higher plans can use the
	 * full context window from multiTierContext.allegretto.
	 */
	getEffectiveLimit(): number {
		const plan = this.options.plan?.toLowerCase() ?? '';
		if (this.options.multiTierContext) {
			if (plan === 'allegretto' || plan === 'allegro' || plan === 'vivace') {
				return Math.max(this.options.maxInputTokens, this.options.multiTierContext.allegretto);
			}
		}
		return this.options.singleRequestLimit ?? this.options.maxInputTokens;
	}

	/**
	 * Estimates the context usage for the upcoming request.
	 */
	estimate(messages: KimiMessage[]): ContextEstimate {
		const tokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
		const limit = this.getEffectiveLimit();
		const ratio = limit > 0 ? Math.min(1, tokens / limit) : 0;

		let status: ContextEstimate['status'] = 'ok';
		if (tokens >= limit) {
			status = 'exceeded';
		} else if (ratio >= this.options.errorThreshold) {
			status = 'critical';
		} else if (ratio >= this.options.warningThreshold) {
			status = 'warning';
		}

		return { tokens, limit, ratio, status };
	}

	/**
	 * Checks whether the request can proceed. Throws a LanguageModelError with
	 * actionable guidance when the context is exceeded or critically full.
	 */
	check(messages: KimiMessage[]): ContextEstimate {
		const estimate = this.estimate(messages);

		if (estimate.status === 'exceeded') {
			const planHint = this.options.multiTierContext
				? ' On Allegretto+ the model supports up to 1M context, but a single request still cannot exceed 262144 tokens.'
				: '';
			throw new vscode.LanguageModelError(
				`Kimi context limit exceeded: ~${estimate.tokens.toLocaleString('en-US')} tokens estimated, limit is ${estimate.limit.toLocaleString('en-US')}.${planHint}\n\nStart a new chat session, run "/compact", or remove files from the context.`,
			);
		}

		return estimate;
	}

	/**
	 * Formats a short status string for the status bar.
	 */
	formatStatus(estimate: ContextEstimate): string {
		const percent = Math.round(estimate.ratio * 100);
		if (estimate.status === 'exceeded') {
			return `$(error) Ctx ${percent}%`;
		}
		if (estimate.status === 'critical') {
			return `$(warning) Ctx ${percent}%`;
		}
		if (estimate.status === 'warning') {
			return `$(info) Ctx ${percent}%`;
		}
		return `Ctx ${percent}%`;
	}
}

export function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 3.5));
}
