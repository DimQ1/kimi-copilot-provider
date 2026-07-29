import * as vscode from 'vscode';

// ═══════════════════════════════════════════════════════════════════════
// Error Handlers — GoF Chain of Responsibility pattern
//
// Each handler checks whether it can process a given HTTP error (status +
// body). If yes, it returns a LanguageModelError; if not, it delegates to
// the next handler in the chain.
//
// The Kimi API returns structured errors:
//   { "error": { "message": "...", "type": "..." } }
// parseApiErrorBody() extracts the message so every handler can surface it.
// ═══════════════════════════════════════════════════════════════════════

export interface ErrorHandler {
	/** Returns a LanguageModelError when this handler can process the error, or null to delegate. */
	handle(status: number, body: string): vscode.LanguageModelError | null;
	/** Links the next handler in the chain, returns it for fluent chaining. */
	setNext(handler: ErrorHandler): ErrorHandler;
}

// ── API error body parser ──────────────────────────────────────────

interface KimiApiError {
	error?: {
		message?: string;
		type?: string;
		code?: string;
	};
}

/**
 * Tries to parse the JSON error body from the Kimi API and extract a
 * human-readable message. Falls back to the raw body (truncated) when
 * parsing fails.
 */
function parseApiErrorBody(body: string): string {
	try {
		const parsed: KimiApiError = JSON.parse(body);
		if (parsed.error?.message) {
			const msg = parsed.error.message.trim();
			const type = parsed.error.type ? ` [${parsed.error.type}]` : '';
			return `${msg}${type}`;
		}
	} catch {
		// not JSON — use raw body
	}
	return body.trim().replace(/\s+/g, ' ').slice(0, 300) || 'no details';
}

// ── Base class ─────────────────────────────────────────────────────

abstract class BaseErrorHandler implements ErrorHandler {
	private next: ErrorHandler | null = null;

	setNext(handler: ErrorHandler): ErrorHandler {
		this.next = handler;
		return handler;
	}

	handle(status: number, body: string): vscode.LanguageModelError | null {
		const result = this.tryHandle(status, body);
		if (result) return result;
		return this.next?.handle(status, body) ?? null;
	}

	protected abstract tryHandle(status: number, body: string): vscode.LanguageModelError | null;
}

// ── Auth errors (401, 403) ─────────────────────────────────────────

class AuthErrorHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		const apiMsg = parseApiErrorBody(body);
		if (status === 401) {
			return new vscode.LanguageModelError(
				`Kimi API: ${apiMsg} (HTTP 401). Run "Kimi Copilot: Set API Key" to update your key.`,
			);
		}
		if (status === 403) {
			return new vscode.LanguageModelError(`Kimi API: ${apiMsg} (HTTP 403).`);
		}
		return null;
	}
}

// ── Payment required (402) ─────────────────────────────────────────

class PaymentRequiredHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		if (status === 402) {
			const apiMsg = parseApiErrorBody(body);
			return new vscode.LanguageModelError(
				`Kimi API: ${apiMsg} (HTTP 402). Visit: https://www.kimi.com/code/#pricing`,
			);
		}
		return null;
	}
}

// ── Quota / balance exhausted (429, fail-fast) ─────────────────────

class QuotaExhaustedHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		if (!isQuotaExhaustedError(status, body)) return null;
		const apiMsg = parseApiErrorBody(body);
		return new vscode.LanguageModelError(
			`Kimi API: ${apiMsg} (HTTP 429). Your Kimi quota or balance is exhausted — top up your account or check your plan: https://www.kimi.com/code/console`,
		);
	}
}

// ── Rate limit (429) ───────────────────────────────────────────────

class RateLimitHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		if (status === 429) {
			const apiMsg = parseApiErrorBody(body);
			return new vscode.LanguageModelError(`Kimi API: ${apiMsg} (HTTP 429).`);
		}
		return null;
	}
}

// ── Context length errors (400 + marker text) ──────────────────────

class ContextLengthHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		if (status !== 400) return null;
		const text = body.toLowerCase();
		if (
			text.includes('context_length_exceeded') ||
			text.includes('token limit') ||
			text.includes('context length') ||
			text.includes('maximum context')
		) {
			const apiMsg = parseApiErrorBody(body);
			return new vscode.LanguageModelError(
				`Kimi API context overflow: ${apiMsg}. Start a new chat, run "/compact", or remove files from the context.`,
			);
		}
		return null;
	}
}

// ── Generic 400 (bad request) ──────────────────────────────────────

class BadRequestHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		if (status === 400) {
			const apiMsg = parseApiErrorBody(body);
			return new vscode.LanguageModelError(`Kimi API: ${apiMsg} (HTTP 400).`);
		}
		return null;
	}
}

// ── Server errors (5xx) ────────────────────────────────────────────

class ServerErrorHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		if (status >= 500 && status < 600) {
			const apiMsg = parseApiErrorBody(body);
			return new vscode.LanguageModelError(`Kimi API: ${apiMsg} (HTTP ${status}).`);
		}
		return null;
	}
}

// ── Fallback (any unhandled status) ────────────────────────────────

class FallbackHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		const apiMsg = parseApiErrorBody(body);
		return new vscode.LanguageModelError(`Kimi API: ${apiMsg} (HTTP ${status}).`);
	}
}

// ── Chain factory ──────────────────────────────────────────────────

/**
 * Assembles the error-handling chain once.
 * Order matters: earlier handlers take priority for overlapping status codes
 * (e.g. ContextLengthHandler must precede BadRequestHandler for 400).
 */
export function createErrorChain(): ErrorHandler {
	const auth = new AuthErrorHandler();
	const payment = new PaymentRequiredHandler();
	const quotaExhausted = new QuotaExhaustedHandler();
	const rateLimit = new RateLimitHandler();
	const contextLength = new ContextLengthHandler();
	const badRequest = new BadRequestHandler();
	const serverError = new ServerErrorHandler();
	const fallback = new FallbackHandler();

	auth.setNext(payment);
	// Quota exhaustion must precede the generic rate-limit handler for 429.
	payment.setNext(quotaExhausted);
	quotaExhausted.setNext(rateLimit);
	rateLimit.setNext(contextLength);
	contextLength.setNext(badRequest);
	badRequest.setNext(serverError);
	serverError.setNext(fallback);

	return auth;
}
// ── Predicate helpers (re-exported for the provider's auto-compact logic) ──

/** Detects the Kimi Code API "request exceeded model token limit" rejection. */
export function isContextLengthError(status: number, body: string): boolean {
	if (status !== 400) return false;
	const text = body.toLowerCase();
	return (
		text.includes('context_length_exceeded') ||
		text.includes('token limit') ||
		text.includes('context length') ||
		text.includes('maximum context')
	);
}

// ── Quota-exhausted 429 classifier ─────────────────────────────────
//
// Mirrors kimi-code kosong's `classifyKimiQuotaError` (commit cdbd33c13):
// a 429 whose body marks the Moonshot account's quota/balance as exhausted
// must fail fast instead of being retried as a transient rate limit.

/** Structured `error.type` / `error.code` values meaning quota exhaustion. */
const QUOTA_EXHAUSTED_ERROR_CODES = new Set([
	'exceeded_current_quota_error', // Moonshot
	'insufficient_quota',           // OpenAI-compatible
]);

/**
 * Message fallback for gateways that flatten the body to text. Anchored to
 * billing wording — deliberately no bare /quota/ or /balance/, which would
 * also match transient throttle messages like "token quota per minute".
 */
const QUOTA_EXHAUSTED_MESSAGE_PATTERNS = [
	/exceeded your current (?:token )?quota/,
	/check your account balance/,
	/insufficient balance/,
	/recharge your account|please recharge/,
	/account (?:is )?in arrears/,
] as const;

/**
 * Detects a quota/balance-exhausted 429 (as opposed to a transient rate
 * limit) from a raw status + body pair. Handles both the raw JSON body
 * string and pre-parsed SDK error messages containing embedded JSON.
 */
export function isQuotaExhaustedError(status: number, body: string): boolean {
	if (status !== 429) return false;

	// Structured path: parse the body and walk nested error objects.
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		let current: Record<string, unknown> | undefined = parsed;
		for (let depth = 0; current !== undefined && depth < 3; depth += 1) {
			const code = current['code'];
			if (typeof code === 'string' && QUOTA_EXHAUSTED_ERROR_CODES.has(code)) return true;
			const type = current['type'];
			if (typeof type === 'string' && QUOTA_EXHAUSTED_ERROR_CODES.has(type)) return true;
			const nested: unknown = current['error'];
			current =
				typeof nested === 'object' && nested !== null
					? (nested as Record<string, unknown>)
					: undefined;
		}
	} catch {
		// not JSON — fall through to the wording check
	}

	// Wording fallback: billing phrases in the (lowercased) body/message.
	const lower = body.toLowerCase();
	return QUOTA_EXHAUSTED_MESSAGE_PATTERNS.some((pattern) => pattern.test(lower));
}
