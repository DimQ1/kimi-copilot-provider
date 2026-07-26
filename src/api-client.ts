import * as vscode from 'vscode';
import OpenAI from 'openai';
import type { KimiRequest } from './types';
import { createErrorChain, isContextLengthError } from './error-handlers';

// ═══════════════════════════════════════════════════════════════════════
// KimiApiClient — GoF Facade pattern (OpenAI SDK–backed)
//
// Uses the official `openai` SDK (same as kimi-code's kosong layer) for
// SSE streaming, error classification, and trace-id extraction via
// `withResponse()`. The SDK resolves `withResponse()` as soon as response
// headers arrive — before the stream body — so `x-trace-id` is available
// even for streams the caller later cancels mid-flight.
// ═══════════════════════════════════════════════════════════════════════

export interface ApiClientOptions {
	timeoutMs: number;
	maxRetries: number;
	retryBaseDelayMs: number;
	retryMaxDelayMs: number;
	/**
	 * Called when the API returns a context-length overflow error (HTTP 400
	 * with context_length_exceeded marker). The callback runs BEFORE the
	 * retry — hosts should compact the conversation here so the retry has
	 * room. When omitted, context overflow is non-retryable.
	 */
	onContextOverflow?: () => void | Promise<void>;
}

const DEFAULT_OPTIONS: ApiClientOptions = {
	timeoutMs: 60000,
	maxRetries: 1,
	retryBaseDelayMs: 1000,
	retryMaxDelayMs: 30000,
};

/**
 * The result of a chat request — either a stream or a non-stream completion.
 * Carries the x-trace-id extracted from response headers for diagnostics.
 */
export interface ChatResult {
	/** The OpenAI SDK stream or completion. */
	data: OpenAI.Chat.Completions.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
	/** Provider trace identifier from `x-trace-id` header, or null. */
	traceId: string | null;
	/** Whether the response is a stream. */
	isStream: boolean;
}

export class KimiApiClient {
	private readonly errorChain = createErrorChain();
	private readonly client: OpenAI;

	constructor(
		private readonly apiKey: string,
		private readonly endpoint: string,
		private readonly options: ApiClientOptions = DEFAULT_OPTIONS,
	) {
		// Strip /chat/completions suffix to get the base URL for the SDK.
		const baseURL = endpoint.endsWith('/chat/completions')
			? endpoint.slice(0, -'/chat/completions'.length)
			: endpoint;
		this.client = new OpenAI({ apiKey, baseURL });
	}

	// ── Public API ──────────────────────────────────────────────────

	/**
	 * Sends a chat request via the OpenAI SDK with automatic retries.
	 * Returns a {@link ChatResult} with the data and trace-id.
	 *
	 * Uses `withResponse()` so `x-trace-id` is available as soon as
	 * response headers arrive — before the stream body is drained.
	 */
	async chat(
		request: KimiRequest,
		token: vscode.CancellationToken,
	): Promise<ChatResult> {
		return this.chatWithRetry(request, token);
	}

	/**
	 * Maps an error to a LanguageModelError.
	 * Accepts either a raw Error (from SDK) or status+body (legacy path).
	 */
	toLanguageModelError(
		statusOrError: number | unknown,
		body?: string,
	): vscode.LanguageModelError | null {
		if (typeof statusOrError === 'number') {
			return this.errorChain.handle(statusOrError, body ?? '');
		}
		// Extract status from OpenAI SDK error
		const err = statusOrError as Record<string, unknown> | null | undefined;
		const status = typeof err?.status === 'number' ? err.status : 0;
		const message = typeof err?.message === 'string' ? err.message : '';
		if (status > 0) {
			return this.errorChain.handle(status, message);
		}
		return null;
	}

	/** Checks whether the given error indicates a context-length rejection. */
	isContextLengthError(statusOrError: number | unknown, body?: string): boolean {
		if (typeof statusOrError === 'number') {
			return isContextLengthError(statusOrError, body ?? '');
		}
		const err = statusOrError as Record<string, unknown> | null | undefined;
		const status = typeof err?.status === 'number' ? err.status : 0;
		const message = typeof err?.message === 'string' ? err.message : '';
		return isContextLengthError(status, message);
	}

	// ── Internal: chat with retry ───────────────────────────────────

	private async chatWithRetry(
		request: KimiRequest,
		token: vscode.CancellationToken,
	): Promise<ChatResult> {
		const maxAttempts = this.options.maxRetries + 1;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const { signal, cleanup } = this.createTimeoutSignal(token);
			try {
				// withResponse() resolves when headers arrive, before the stream body.
				const { data, response } = await this.client.chat.completions
					.create(
						request as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams,
						{ signal },
					)
					.withResponse();

				const traceId = parseTraceId(response.headers);

				return {
					data: data as unknown as
						| OpenAI.Chat.Completions.ChatCompletion
						| AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
					traceId,
					isStream: request.stream === true,
				};
			} catch (err) {
				lastError = err;

				// Context-length overflow: trigger compaction callback, then retry once.
				// The callback (auto-compact) frees context space so the retry can succeed.
				if (isOpenAIContextOverflow(err) && this.options.onContextOverflow) {
					if (attempt < maxAttempts && !token.isCancellationRequested) {
						await this.options.onContextOverflow();
						// Give the compaction a moment to flush before retrying.
						const delayMs = this.computeRetryDelay(attempt, undefined);
						await this.sleep(delayMs, token);
						continue;
					}
				}

				// Non-retryable: auth, bad request etc.
				if (!this.isRetryableError(err)) {
					throw this.translateError(err);
				}

				if (token.isCancellationRequested || attempt >= maxAttempts) {
					throw this.translateError(err);
				}

				const retryAfterMs = extractRetryAfterFromError(err);
				const delayMs = this.computeRetryDelay(attempt, retryAfterMs ?? undefined);
				await this.sleep(delayMs, token);
			} finally {
				cleanup();
			}
		}
		throw this.translateError(lastError);
	}

	private createTimeoutSignal(
		token: vscode.CancellationToken,
	): { signal: AbortSignal; cleanup: () => void } {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
		const disposable = token.onCancellationRequested(() => controller.abort());

		const cleanup = (): void => {
			clearTimeout(timeout);
			disposable.dispose();
		};

		// Defense-in-depth: also clean up if the signal itself is aborted.
		controller.signal.addEventListener('abort', cleanup, { once: true });

		return { signal: controller.signal, cleanup };
	}

	private isRetryableError(err: unknown): boolean {
		if (err instanceof OpenAI.APIError) {
			return err.status === 429 || err.status >= 500;
		}
		if (err instanceof Error) {
			const msg = err.message.toLowerCase();
			return (
				msg.includes('fetch failed') ||
				msg.includes('econnrefused') ||
				msg.includes('enotfound') ||
				msg.includes('timeout')
			);
		}
		return false;
	}

	private translateError(err: unknown): Error {
		if (err instanceof OpenAI.APIError) {
			const parsed = parseApiErrorJson(err);
			const apiMsg: string = parsed
				? `${parsed.message}${parsed.type ? ` [${parsed.type}]` : ''}`
				: ((err as { message?: string }).message ?? String(err));

			// Check for context-length overflow first (uses parsed body, no re-parse)
			if (err.status === 400 && isOpenAIContextOverflow(err)) {
				return new vscode.LanguageModelError(
					`Kimi API context overflow: ${apiMsg}. Start a new chat, run "/compact", or remove files from the context. (HTTP 400)`,
				);
			}

			const mapped = this.toLanguageModelError(err);
			if (mapped) return mapped;

			return new vscode.LanguageModelError(`Kimi API: ${apiMsg} (HTTP ${err.status}).`);
		}

		if (err instanceof Error) {
			const msg = err.message;
			if (msg.includes('fetch failed') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
				return new vscode.LanguageModelError(
					`Unable to reach Kimi API at ${this.endpoint}. Check your network connection.`,
					{ cause: err },
				);
			}
			if (msg.includes('aborted') || msg.includes('AbortError') || err.name === 'AbortError') {
				return new vscode.LanguageModelError(
					'Kimi API request was cancelled or timed out.',
					{ cause: err },
				);
			}
			return new vscode.LanguageModelError(msg, { cause: err });
		}

		return new vscode.LanguageModelError(String(err));
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
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse the `x-trace-id` header from response headers.
 * Kimi/KFC returns a trace ID for request diagnostics.
 */
function parseTraceId(headers: Headers | undefined): string | null {
	if (!headers) return null;
	const value = headers.get('x-trace-id');
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Extract Retry-After from an OpenAI error's response headers.
 */
function extractRetryAfterFromError(err: unknown): number | null {
	const apiErr = err as { response?: { headers?: Headers } } | null;
	const value = apiErr?.response?.headers?.get('retry-after');
	return parseRetryAfterMs(value);
}

interface ParsedApiError { message: string; type?: string }

/**
 * Try to parse the structured Kimi API error from an OpenAI SDK error.
 * Returns null when the body is not valid JSON or missing error.message.
 */
function parseApiErrorJson(err: unknown): ParsedApiError | null {
	if (!(err instanceof OpenAI.APIError)) return null;
	const apiErr: { message?: string } = err;
	try {
		const body = apiErr.message ?? '';
		const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
		if (parsed.error?.message) {
			return { message: parsed.error.message.trim(), type: parsed.error.type };
		}
	} catch { /* not JSON */ }
	return null;
}

/**
 * Check whether an error is a context-length overflow from the API
 * (HTTP 400 with context_length_exceeded / token limit markers).
 */
function isOpenAIContextOverflow(err: unknown): boolean {
	if (!(err instanceof OpenAI.APIError)) return false;
	if (err.status !== 400) return false;
	const body = (err as { message?: string }).message ?? '';
	return (
		body.includes('context_length_exceeded') ||
		body.includes('token limit') ||
		body.includes('context length') ||
		body.includes('maximum context')
	);
}

/**
 * Parses the `Retry-After` response header (RFC 9110 §10.2.3).
 * Exported for unit tests and backward compatibility.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		return Number(trimmed) * 1000;
	}
	if (/^[+-]?\d*\.?\d+$/.test(trimmed)) {
		return null;
	}
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}
	return null;
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
