import * as vscode from 'vscode';
import type { KimiRequest } from './types';
import { createErrorChain, isContextLengthError } from './error-handlers';

// ═══════════════════════════════════════════════════════════════════════
// KimiApiClient — GoF Facade pattern
//
// Encapsulates all HTTP communication with the Kimi Code API behind a
// single, focused interface. The provider delegates to this facade for
// chat requests, retry logic, timeout handling, and error mapping — it no
// longer touches raw fetch(), AbortController, or retry/backoff directly.
//
// This also centralises the two concerns that were previously scattered
// across the provider: (1) translating HTTP statuses into
// LanguageModelError, and (2) detecting context-length rejections for
// the auto-compact fallback.
// ═══════════════════════════════════════════════════════════════════════

export interface ApiClientOptions {
	timeoutMs: number;
	maxRetries: number;
	retryBaseDelayMs: number;
	retryMaxDelayMs: number;
}

const DEFAULT_OPTIONS: ApiClientOptions = {
	timeoutMs: 60000,
	maxRetries: 1,
	retryBaseDelayMs: 1000,
	retryMaxDelayMs: 30000,
};

export class KimiApiClient {
	private readonly errorChain = createErrorChain();

	constructor(
		private readonly apiKey: string,
		private readonly endpoint: string,
		private readonly options: ApiClientOptions = DEFAULT_OPTIONS,
	) {}

	// ── Public API ──────────────────────────────────────────────────

	/**
	 * Sends a chat request to the Kimi Code API with automatic retries.
	 * Returns the raw Response (OK or not) — the caller streams the body.
	 */
	async chat(
		request: KimiRequest,
		token: vscode.CancellationToken,
	): Promise<Response> {
		const enableStreaming = request.stream === true;
		return this.fetchWithRetry(
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
					Accept: enableStreaming ? 'text/event-stream' : 'application/json',
				},
				body: JSON.stringify(request),
			},
			token,
		);
	}

	/**
	 * Maps an HTTP error response to a LanguageModelError.
	 * Returns null when the response is OK.
	 */
	toLanguageModelError(status: number, body: string): vscode.LanguageModelError | null {
		return this.errorChain.handle(status, body);
	}

	/** Checks whether the given status/body indicates a context-length rejection. */
	isContextLengthError(status: number, body: string): boolean {
		return isContextLengthError(status, body);
	}

	// ── Internal: fetch with retry ──────────────────────────────────

	private async fetchWithRetry(
		init: RequestInit,
		token: vscode.CancellationToken,
	): Promise<Response> {
		const maxAttempts = this.options.maxRetries + 1;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const response = await this.fetchWithTimeout(init, token);
				if (response.ok || !this.isRetryableStatus(response.status)) {
					return response;
				}

				const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
				const bodyText = await response.text().catch(() => '');

				if (attempt >= maxAttempts) {
					return new Response(bodyText, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				}

				const delayMs = this.computeRetryDelay(attempt, retryAfterMs);
				await this.sleep(delayMs, token);
			} catch (err) {
				lastError = err;
				if (token.isCancellationRequested || attempt >= maxAttempts) {
					throw err;
				}
				const delayMs = this.computeRetryDelay(attempt, undefined);
				await this.sleep(delayMs, token);
			}
		}
		throw lastError;
	}

	private async fetchWithTimeout(
		init: RequestInit,
		token: vscode.CancellationToken,
	): Promise<Response> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

		const disposables: vscode.Disposable[] = [];
		disposables.push(token.onCancellationRequested(() => controller.abort()));

		try {
			return await fetch(this.endpoint, { ...init, signal: controller.signal });
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				throw new Error(
					`Kimi API request timed out after ${this.options.timeoutMs}ms or was cancelled.`,
				);
			}
			throw err;
		} finally {
			clearTimeout(timeout);
			disposables.forEach((d) => d.dispose());
		}
	}

	private isRetryableStatus(status: number): boolean {
		return status === 429 || status === 500 || status === 502 || status === 503;
	}

	private computeRetryDelay(attempt: number, retryAfterMs: number | undefined): number {
		if (retryAfterMs !== undefined) {
			return Math.min(retryAfterMs, this.options.retryMaxDelayMs * 4);
		}
		const exponential = Math.min(
			this.options.retryBaseDelayMs * 2 ** (attempt - 1),
			this.options.retryMaxDelayMs,
		);
		const jitter = exponential * (0.75 + Math.random() * 0.5);
		return Math.round(Math.min(jitter, this.options.retryMaxDelayMs));
	}

	private sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				disposable.dispose();
				resolve();
			}, ms);
			const disposable = token.onCancellationRequested(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers — extracted from the old provider for backward compatibility.
// Keep exported for provider.test.ts; the provider itself now delegates
// to KimiApiClient.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parses the `Retry-After` response header (RFC 9110 §10.2.3).
 * Exported for unit tests; the client uses this internally.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		return Number(trimmed) * 1000;
	}
	if (/^[+-]?\d*\.?\d+$/.test(trimmed)) {
		return undefined;
	}
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}
	return undefined;
}

export interface BackoffOptions {
	attempt: number;
	retryAfterMs?: number | undefined;
	baseDelayMs: number;
	maxDelayMs: number;
	random?: () => number;
}

export function computeBackoffDelayMs(options: BackoffOptions): number {
	if (options.retryAfterMs !== undefined) {
		return Math.min(options.retryAfterMs, options.maxDelayMs * 4);
	}
	const exponential = Math.min(
		options.baseDelayMs * 2 ** (options.attempt - 1),
		options.maxDelayMs,
	);
	const random = options.random ?? Math.random;
	const jitter = exponential * (0.75 + random() * 0.5);
	return Math.round(Math.min(jitter, options.maxDelayMs));
}
