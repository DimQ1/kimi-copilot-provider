import * as vscode from 'vscode';
import OpenAI from 'openai';
import type { KimiRequest } from './types';
import { createErrorChain, isContextLengthError, isQuotaExhaustedError } from './error-handlers';

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
	/**
	 * Called when the API rejects the request body as too large (HTTP 413 or
	 * a 400 "request too large" marker). Should return a degraded copy of the
	 * request (e.g. images replaced with text markers) or null/undefined when
	 * no degradation is possible — then the error is fatal. Mirrors kimi-code's
	 * "resend with degraded media" behavior (commit 1bf2c9afe).
	 */
	onRequestTooLarge?: (request: KimiRequest) => KimiRequest | null | undefined;
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
	/** Releases request-scoped timeout and cancellation listeners. Idempotent. */
	dispose: () => void;
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
		let activeRequest = request;
		let mediaDegraded = false;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const { signal, cleanup } = this.createTimeoutSignal(token);
			let cleanupTransferred = false;
			try {
				// withResponse() resolves when headers arrive, before the stream body.
				const { data, response } = await this.client.chat.completions
					.create(
						activeRequest as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams,
						{ signal },
					)
					.withResponse();

				const traceId = parseTraceId(response.headers);

				const resultData = data as unknown as
						| OpenAI.Chat.Completions.ChatCompletion
						| AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
				const isStream = activeRequest.stream === true;
				cleanupTransferred = isStream;
				return {
					data: isStream
						? wrapAsyncIterableWithCleanup(
							resultData as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
							cleanup,
						)
						: resultData,
					traceId,
					isStream,
					dispose: isStream ? cleanup : () => {},
				};
			} catch (err) {
				lastError = err;

				// Request body too large: degrade media once and resend.
				// The callback swaps images for text markers so the retry fits
				// the provider's body cap (mirrors kimi-code commit 1bf2c9afe).
				if (!mediaDegraded && isRequestTooLargeError(err) && this.options.onRequestTooLarge) {
					const degraded = this.options.onRequestTooLarge(activeRequest);
					if (degraded && attempt < maxAttempts && !token.isCancellationRequested) {
						activeRequest = degraded;
						mediaDegraded = true;
						const delayMs = this.computeRetryDelay(attempt, undefined);
						await this.sleep(delayMs, token);
						continue;
					}
				}

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
				if (!cleanupTransferred) {
					cleanup();
				}
			}
		}
		throw this.translateError(lastError);
	}

	private createTimeoutSignal(
		token: vscode.CancellationToken,
	): { signal: AbortSignal; cleanup: () => void } {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
		const cancellation = { disposable: undefined as vscode.Disposable | undefined };
		let cleanedUp = false;

		const cleanup = (): void => {
			if (cleanedUp) return;
			cleanedUp = true;
			clearTimeout(timeout);
			cancellation.disposable?.dispose();
			controller.signal.removeEventListener('abort', cleanup);
		};

		controller.signal.addEventListener('abort', cleanup, { once: true });
		cancellation.disposable = token.onCancellationRequested(() => controller.abort());
		if (cleanedUp) {
			cancellation.disposable.dispose();
		}
		if (token.isCancellationRequested) {
			controller.abort();
		}

		return { signal: controller.signal, cleanup };
	}

	private isRetryableError(err: unknown): boolean {
		if (err instanceof OpenAI.APIError) {
			// Quota/balance-exhausted 429 must fail fast — never retried
			// (mirrors kimi-code kosong commit cdbd33c13).
			if (isQuotaExhaustedApiError(err)) {
				return false;
			}
			// Transient statuses worth retrying. 408 Request Timeout, 409 Conflict
			// (upstream overload marker on some gateways), 429 rate limit, 5xx
			// server errors, and 529 "Site is overloaded" (Cloudflare-style).
			// Mirrors kimi-code's chatWithRetry hardening (commit 9f66ec416).
			if (err.status === 408 || err.status === 409 || err.status === 429 || err.status === 529) {
				return true;
			}
			if (err.status >= 500) {
				return true;
			}
			// Embedded upstream 429 inside a stream error body — the HTTP status
			// may be 200/400 while the payload reports status_code=429.
			const body = (err as { message?: string }).message ?? '';
			if (/"status_code"\s*:\s*429/.test(body) || /"code"\s*:\s*"?429"?/.test(body)) {
				return true;
			}
			return false;
		}
		if (err instanceof Error) {
			const msg = err.message.toLowerCase();
			// `terminated` — undici's raw "response body cut mid-flight" error,
			// common on long streaming responses. Classify as retryable
			// (mirrors kimi-code commit 074bb9ba1).
			return (
				msg.includes('fetch failed') ||
				msg.includes('econnrefused') ||
				msg.includes('enotfound') ||
				msg.includes('timeout') ||
				msg.includes('terminated') ||
				msg.includes('econnreset') ||
				msg.includes('socket hang up')
			);
		}
		return false;
	}

	private translateError(err: unknown): Error {
		// Aborts (user cancellation via CancellationToken, or our own timeout)
		// surface as the OpenAI SDK's APIUserAbortError — an APIError subclass
		// with `status === undefined` — so they must be handled before the
		// APIError branch, or the user sees "(HTTP undefined)".
		if (isAbortLikeError(err)) {
			return new vscode.LanguageModelError(
				'Kimi API request was cancelled or timed out.',
				{ cause: err instanceof Error ? err : undefined },
			);
		}

		if (err instanceof OpenAI.APIError) {
			const parsed = parseApiErrorJson(err);
			const apiMsg: string = parsed
				? `${parsed.message}${parsed.type ? ` [${parsed.type}]` : ''}`
				: ((err as { message?: string }).message ?? String(err));

			// Quota/balance-exhausted 429: dedicated message, no retry hint.
			if (isQuotaExhaustedApiError(err)) {
				return new vscode.LanguageModelError(
					`Kimi API: ${apiMsg} (HTTP 429). Your Kimi quota or balance is exhausted — top up your account or check your plan: https://www.kimi.com/code/console`,
				);
			}

			// Check for context-length overflow first (uses parsed body, no re-parse)
			if (err.status === 400 && isOpenAIContextOverflow(err)) {
				return new vscode.LanguageModelError(
					`Kimi API context overflow: ${apiMsg}. Start a new chat, run "/compact", or remove files from the context. (HTTP 400)`,
				);
			}

			// Request body too large (413 or folded 400)
			if (isRequestTooLargeError(err)) {
				return new vscode.LanguageModelError(
					`Kimi API rejected the request body as too large: ${apiMsg}. Remove images or large attachments from the context. (HTTP ${err.status})`,
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
			let settled = false;
			const cancellation = { disposable: undefined as vscode.Disposable | undefined };
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				cancellation.disposable?.dispose();
				resolve();
			};
			const timer = setTimeout(finish, ms);
			cancellation.disposable = token.onCancellationRequested(finish);
			if (settled) {
				cancellation.disposable.dispose();
			}
			if (token.isCancellationRequested) {
				finish();
			}
		});
	}
}

export function wrapAsyncIterableWithCleanup<T>(
	source: AsyncIterable<T>,
	cleanup: () => void,
): AsyncIterable<T> {
	return {
		async *[Symbol.asyncIterator](): AsyncIterator<T> {
			try {
				for await (const item of source) {
					yield item;
				}
			} finally {
				cleanup();
			}
		},
	};
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
 * Detect request aborts: VS Code cancellation or our own timeout abort the
 * fetch signal, and the OpenAI SDK wraps that in APIUserAbortError — an
 * APIError subclass with `status === undefined` and a message containing
 * "aborted"/"AbortError". Plain DOMExceptions also have name AbortError.
 */
function isAbortLikeError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === 'AbortError') return true;
	if (err instanceof OpenAI.APIError && typeof err.status !== 'number') {
		const msg = err.message.toLowerCase();
		return msg.includes('aborted') || msg.includes('abort');
	}
	return false;
}

/**
 * Classify an OpenAI SDK error as a quota/balance-exhausted 429 using the
 * shared predicate from error-handlers. The SDK hoists `error.type`/`error.code`
 * to the top level and keeps the inner error object on `.error`; serializing
 * the structured fields back to a body string lets `isQuotaExhaustedError`
 * apply both the structured and the wording paths (mirrors kimi-code kosong
 * commit cdbd33c13).
 */
function isQuotaExhaustedApiError(err: InstanceType<typeof OpenAI.APIError>): boolean {
	if (err.status !== 429) return false;
	const record = err as unknown as Record<string, unknown>;
	const pieces: string[] = [];
	const code = record['code'];
	if (typeof code === 'string') pieces.push(JSON.stringify({ code }));
	const type = record['type'];
	if (typeof type === 'string') pieces.push(JSON.stringify({ type }));
	const inner = record['error'];
	if (typeof inner === 'object' && inner !== null) {
		try { pieces.push(JSON.stringify(inner)); } catch { /* ignore */ }
	}
	const message = typeof record['message'] === 'string' ? record['message'] : '';
	pieces.push(message);
	const body = pieces.join(' ');
	return isQuotaExhaustedError(429, body);
}

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
 * Detects "request body too large" rejections: the dedicated HTTP 413, or a
 * 400 whose message reports an oversized request body (some gateways fold 413
 * into 400). Mirrors kimi-code's request-body-too-large error classification.
 */
export function isRequestTooLargeError(err: unknown): boolean {
	if (!(err instanceof OpenAI.APIError)) return false;
	if (err.status === 413) return true;
	if (err.status !== 400) return false;
	const body = ((err as { message?: string }).message ?? '').toLowerCase();
	return (
		body.includes('request entity too large') ||
		body.includes('request too large') ||
		body.includes('body too large') ||
		body.includes('payload too large') ||
		body.includes('exceeds the maximum allowed size')
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
