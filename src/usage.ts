import * as vscode from 'vscode';
import type { KimiUsage } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Local usage statistics — tracks token consumption reported by the
// Kimi API (prompt, completion, total and cached tokens). Persisted in
// globalState so it survives VS Code restarts.
// ═══════════════════════════════════════════════════════════════════════

const USAGE_STATE_KEY = 'kimiCopilot.usageStats';

export interface UsageStats {
	requestCount: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens: number;
}

const DEFAULT_STATS: UsageStats = {
	requestCount: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
};

export class UsageTracker {
	private stats: UsageStats;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly globalState: vscode.Memento) {
		this.stats = this.loadStats();
	}

	/** Adds a single response usage to the running totals. */
	recordUsage(usage: Partial<KimiUsage>): void {
		const prompt_tokens = usage.prompt_tokens ?? 0;
		const completion_tokens = usage.completion_tokens ?? 0;
		const total_tokens = usage.total_tokens ?? prompt_tokens + completion_tokens;
		const cached_tokens = usage.cached_tokens ?? 0;

		this.stats.requestCount += 1;
		this.stats.promptTokens += prompt_tokens;
		this.stats.completionTokens += completion_tokens;
		this.stats.totalTokens += total_tokens;
		this.stats.cachedTokens += cached_tokens;

		void this.saveStats();
		this._onDidChange.fire();
	}

	getStats(): UsageStats {
		return { ...this.stats };
	}

	reset(): void {
		this.stats = { ...DEFAULT_STATS };
		void this.saveStats();
		this._onDidChange.fire();
	}

	/** One-line summary for the status bar. */
	getStatusBarText(): string {
		return `$(graph) ${this.formatCompact(this.stats.totalTokens)} tokens • ${this.stats.requestCount} req`;
	}

	/** Multi-line summary for messages / hover. */
	getFormattedStats(): string {
		return [
			`Requests: ${this.stats.requestCount}`,
			`Prompt tokens: ${this.formatNumber(this.stats.promptTokens)}`,
			`Completion tokens: ${this.formatNumber(this.stats.completionTokens)}`,
			`Total tokens: ${this.formatNumber(this.stats.totalTokens)}`,
			`Cached tokens: ${this.formatNumber(this.stats.cachedTokens)}`,
		].join('  \u2502  ');
	}

	private loadStats(): UsageStats {
		const saved = this.globalState.get<UsageStats>(USAGE_STATE_KEY);
		if (!saved) {
			return { ...DEFAULT_STATS };
		}
		return {
			requestCount: saved.requestCount ?? 0,
			promptTokens: saved.promptTokens ?? 0,
			completionTokens: saved.completionTokens ?? 0,
			totalTokens: saved.totalTokens ?? 0,
			cachedTokens: saved.cachedTokens ?? 0,
		};
	}

	private async saveStats(): Promise<void> {
		await this.globalState.update(USAGE_STATE_KEY, this.stats);
	}

	private formatNumber(value: number): string {
		return value.toLocaleString('en-US');
	}

	private formatCompact(value: number): string {
		if (value < 1000) {
			return String(value);
		}
		if (value < 1_000_000) {
			return `${(value / 1000).toFixed(1)}k`;
		}
		return `${(value / 1_000_000).toFixed(2)}M`;
	}
}

/** Checks whether a usage object looks valid and non-empty. */
export function hasUsage(usage: unknown): usage is Partial<KimiUsage> {
	if (!usage || typeof usage !== 'object') {
		return false;
	}
	const u = usage as Partial<KimiUsage>;
	return (
		(u.prompt_tokens !== undefined && u.prompt_tokens > 0) ||
		(u.completion_tokens !== undefined && u.completion_tokens > 0) ||
		(u.total_tokens !== undefined && u.total_tokens > 0)
	);
}
