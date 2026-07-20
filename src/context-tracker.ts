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
	/**
	 * Estimated request body size in bytes (UTF-8 JSON). The Kimi Code API
	 * rejects bodies above 2 MiB regardless of token count — this matters
	 * for non-Latin text, where a token can weigh 2-3 bytes.
	 */
	bodyBytes: number;
	/** 0..1 ratio of bodyBytes to the byte limit. */
	byteRatio: number;
}

export interface SessionContextTrackerOptions {
	/** Max input tokens reported by the model. */
	maxInputTokens: number;
	/** Hard per-request limit (prompt + history + files). */
	singleRequestLimit?: number;
	/** Multi-tier limits if the user is on a higher plan. */
	multiTierContext?: { default: number; allegretto: number };
	/**
	 * Context window resolved by the server (`context_length` from GET /models)
	 * for the current subscription. When present, this is the source of truth
	 * and takes precedence over the manual `plan` hint.
	 */
	serverContextLength?: number;
	/** Ratio at which we warn the user (0..1). */
	warningThreshold: number;
	/** Ratio at which we refuse to send the request (0..1). */
	errorThreshold: number;
	/**
	 * Plan hint from the user (e.g. 'moderato', 'allegretto', 'allegro', 'vivace').
	 * Fallback only — used when the server catalog has not been fetched yet.
	 */
	plan?: string;
	/**
	 * Hard request-body byte limit (default 2 MiB, the Kimi Code API cap).
	 * Bodies above this are rejected with HTTP 400 even when the token count
	 * fits the context window — see kimi_api_research.md.
	 */
	maxBodyBytes?: number;
}

/** Kimi Code API request body cap: 2 MiB (confirmed by live probing). */
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

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
	 * Returns the session context window for the active model/subscription.
	 * This is the value shown to the user and used for threshold warnings —
	 * NOT the per-request cap (see {@link getRequestLimit}).
	 *
	 * Precedence (mirrors the official Kimi Code CLI):
	 * 1. `serverContextLength` — per-subscription value from GET /models.
	 * 2. `multiTierContext.allegretto` — when the user manually set a higher
	 *    plan hint and the server catalog has not been fetched yet.
	 * 3. `singleRequestLimit` / `maxInputTokens` — hard-coded fallback.
	 */
	getEffectiveLimit(): number {
		if (
			this.options.serverContextLength !== undefined &&
			this.options.serverContextLength > 0
		) {
			return this.options.serverContextLength;
		}
		const plan = this.options.plan?.toLowerCase() ?? '';
		if (this.options.multiTierContext) {
			if (plan === 'allegretto' || plan === 'allegro' || plan === 'vivace') {
				return Math.max(this.options.maxInputTokens, this.options.multiTierContext.allegretto);
			}
		}
		return this.options.singleRequestLimit ?? this.options.maxInputTokens;
	}

	/**
	 * Returns the hard per-request token cap (prompt + history + files).
	 * The Kimi Code API rejects any single request above 262144 tokens, even
	 * when the subscription context window is 1M. The cap never exceeds the
	 * session context window.
	 */
	getRequestLimit(): number {
		const sessionLimit = this.getEffectiveLimit();
		const perRequest = this.options.singleRequestLimit ?? sessionLimit;
		return Math.min(perRequest, sessionLimit);
	}

	/**
	 * Estimates the context usage for the upcoming request.
	 */
	estimate(messages: KimiMessage[]): ContextEstimate {
		const tokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
		const limit = this.getEffectiveLimit();
		const ratio = limit > 0 ? Math.min(1, tokens / limit) : 0;
		const bodyBytes = estimateRequestBodyBytes(messages);
		const maxBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
		const byteRatio = maxBytes > 0 ? Math.min(1, bodyBytes / maxBytes) : 0;

		let status: ContextEstimate['status'] = 'ok';
		if (tokens >= limit || bodyBytes >= maxBytes) {
			status = 'exceeded';
		} else if (ratio >= this.options.errorThreshold || byteRatio >= this.options.errorThreshold) {
			status = 'critical';
		} else if (ratio >= this.options.warningThreshold || byteRatio >= this.options.warningThreshold) {
			status = 'warning';
		}

		return { tokens, limit, ratio, status, bodyBytes, byteRatio };
	}

	/**
	 * Checks whether the request can proceed. Throws a LanguageModelError with
	 * actionable guidance when the context is exceeded or critically full.
	 *
	 * Two distinct limits are enforced:
	 * - the session context window (estimate.status) — start a new chat;
	 * - the per-request API cap ({@link getRequestLimit}) — even a 1M plan
	 *   cannot send more than 262144 tokens in one request.
	 */
	check(messages: KimiMessage[]): ContextEstimate {
		const estimate = this.estimate(messages);
		const requestLimit = this.getRequestLimit();
		const maxBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

		if (estimate.bodyBytes >= maxBytes) {
			throw new vscode.LanguageModelError(
				`Kimi request-size limit exceeded: the request body is ~${formatBytes(estimate.bodyBytes)}, but the API rejects bodies above ${formatBytes(maxBytes)} (Cloudflare cap, compression not supported).\n\nStart a new chat session, run "/compact", or remove files from the context.`,
			);
		}

		if (estimate.tokens >= requestLimit) {
			const sessionLimit = estimate.limit;
			const tierHint =
				sessionLimit > requestLimit
					? ` Your subscription context window is ${sessionLimit.toLocaleString('en-US')} tokens, but the Kimi Code API rejects any single request above ${requestLimit.toLocaleString('en-US')} tokens.`
					: '';
			throw new vscode.LanguageModelError(
				`Kimi per-request limit exceeded: ~${estimate.tokens.toLocaleString('en-US')} tokens in one request, the API cap is ${requestLimit.toLocaleString('en-US')}.${tierHint}\n\nStart a new chat session, run "/compact", or remove files from the context.`,
			);
		}

		if (estimate.status === 'exceeded') {
			throw new vscode.LanguageModelError(
				`Kimi context limit exceeded: ~${estimate.tokens.toLocaleString('en-US')} tokens estimated, the session context window is ${estimate.limit.toLocaleString('en-US')}.\n\nStart a new chat session, run "/compact", or remove files from the context.`,
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

/**
 * Estimates the UTF-8 byte size of the JSON request body for these messages.
 * Uses Buffer.byteLength on the serialized message contents rather than the
 * raw character count, because CJK/Cyrillic characters weigh 2-3 bytes each
 * and the API's hard cap (2 MiB) is on BYTES, not characters.
 * Includes a fixed overhead for JSON structure, the model field and tools.
 */
export function estimateRequestBodyBytes(messages: KimiMessage[]): number {
	const JSON_OVERHEAD_BYTES = 4096;
	let bytes = 0;
	for (const message of messages) {
		if (typeof message.content === 'string') {
			bytes += Buffer.byteLength(message.content, 'utf8');
		} else if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === 'text') {
					bytes += Buffer.byteLength(part.text, 'utf8');
				} else if (part.type === 'image_url') {
					// data: URL — base64 payload, ~4/3 of the raw image bytes.
					bytes += Buffer.byteLength(part.image_url.url, 'utf8');
				}
			}
		}
		if (message.tool_calls) {
			for (const tc of message.tool_calls) {
				bytes += Buffer.byteLength(tc.function.name, 'utf8');
				bytes += Buffer.byteLength(tc.function.arguments, 'utf8');
			}
		}
	}
	return bytes + JSON_OVERHEAD_BYTES;
}

/** Formats a byte count as KiB/MiB for error messages. */
export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
	}
	if (bytes >= 1024) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	return `${bytes} B`;
}
