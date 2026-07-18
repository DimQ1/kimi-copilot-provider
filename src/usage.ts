import * as vscode from 'vscode';
import type { KimiUsage, KimiManagedUsage, KimiUsageRow } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Local usage statistics — tracks token consumption reported by the
// Kimi API (prompt, completion, total and cached tokens). Persisted in
// globalState so it survives VS Code restarts.
// ═══════════════════════════════════════════════════════════════════════

const USAGE_STATE_KEY = 'kimiCopilot.usageStats';
const QUOTA_STATE_KEY = 'kimiCopilot.lastQuota';

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
	private quota: KimiManagedUsage | null;
	private quotaError: string | null;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly globalState: vscode.Memento) {
		this.stats = this.loadStats();
		this.quota = this.loadQuota();
		this.quotaError = null;
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

	/** Stores the latest managed quota fetched from Kimi Code. */
	setQuota(quota: KimiManagedUsage | null, error: string | null = null): void {
		this.quota = quota;
		this.quotaError = error;
		if (quota) {
			void this.saveQuota();
		}
		this._onDidChange.fire();
	}

	getQuota(): KimiManagedUsage | null {
		return this.quota;
	}

	getQuotaError(): string | null {
		return this.quotaError;
	}

	reset(): void {
		this.stats = { ...DEFAULT_STATS };
		this.quota = null;
		this.quotaError = null;
		void this.saveStats();
		void this.saveQuota();
		this._onDidChange.fire();
	}

	/** One-line summary for the status bar. */
	getStatusBarText(): string {
		const summary = this.quota?.summary;
		if (summary && summary.limit > 0) {
			const percent = Math.round((summary.used / summary.limit) * 100);
			const remaining = Math.max(0, summary.limit - summary.used);
			return `$(graph) ${percent}% used (${remaining} left)`;
		}
		return `$(graph) ${this.formatCompact(this.stats.totalTokens)} tokens • ${this.stats.requestCount} req`;
	}

	/** Multi-line summary for messages / hover. */
	getFormattedStats(): string {
		const lines = [
			`Requests: ${this.stats.requestCount}`,
			`Prompt tokens: ${this.formatNumber(this.stats.promptTokens)}`,
			`Completion tokens: ${this.formatNumber(this.stats.completionTokens)}`,
			`Total tokens: ${this.formatNumber(this.stats.totalTokens)}`,
			`Cached tokens: ${this.formatNumber(this.stats.cachedTokens)}`,
		];
		const summary = this.quota?.summary;
		if (summary && summary.limit > 0) {
			const percent = Math.round((summary.used / summary.limit) * 100);
			lines.push(`Quota: ${summary.used}/${summary.limit} (${percent}% used)`);
			if (summary.resetHint) lines.push(`Resets: ${summary.resetHint}`);
		}
		for (const limit of this.quota?.limits ?? []) {
			if (limit.limit > 0) {
				const percent = Math.round((limit.used / limit.limit) * 100);
				lines.push(`${limit.label}: ${limit.used}/${limit.limit} (${percent}% used)`);
			}
		}
		if (this.quotaError) {
			lines.push(`Quota error: ${this.quotaError}`);
		}
		return lines.join('  \u2502  ');
	}

	/**
	 * Checks whether any quota is above the given threshold (0..1).
	 * Returns the most relevant row and the actual ratio.
	 */
	getHighestQuotaUsage(): { row: KimiUsageRow; ratio: number } | null {
		const rows = this.quota?.summary ? [this.quota.summary, ...this.quota.limits] : this.quota?.limits ?? [];
		let highest: { row: KimiUsageRow; ratio: number } | null = null;
		for (const row of rows) {
			if (row.limit <= 0) continue;
			const ratio = row.used / row.limit;
			if (!highest || ratio > highest.ratio) {
				highest = { row, ratio };
			}
		}
		return highest;
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

	private loadQuota(): KimiManagedUsage | null {
		const saved = this.globalState.get<KimiManagedUsage>(QUOTA_STATE_KEY);
		if (!saved) return null;
		return {
			summary: saved.summary ?? null,
			limits: Array.isArray(saved.limits) ? saved.limits : [],
			extraUsage: saved.extraUsage ?? null,
		};
	}

	private async saveQuota(): Promise<void> {
		await this.globalState.update(QUOTA_STATE_KEY, this.quota);
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
