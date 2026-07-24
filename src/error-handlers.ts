import * as vscode from 'vscode';

// ═══════════════════════════════════════════════════════════════════════
// Error Handlers — GoF Chain of Responsibility pattern
//
// Each handler checks whether it can process a given HTTP error (status +
// body). If yes, it returns a LanguageModelError; if not, it delegates to
// the next handler in the chain.
//
// The chain is assembled once and reused for every request.
// ═══════════════════════════════════════════════════════════════════════

export interface ErrorHandler {
	/** Returns a LanguageModelError when this handler can process the error, or null to delegate. */
	handle(status: number, body: string): vscode.LanguageModelError | null;
	/** Links the next handler in the chain, returns it for fluent chaining. */
	setNext(handler: ErrorHandler): ErrorHandler;
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
		if (status === 401) {
			const detail = body.trim().replace(/\s+/g, ' ').slice(0, 240);
			return new vscode.LanguageModelError(
				`Invalid Kimi API key (401). For the default /coding/ endpoint, use a key created in the Kimi Code Console, not a Kimi Platform key. Run "Kimi Copilot: Set API Key" to update.${detail ? ` Server response: ${detail}` : ''}`,
			);
		}
		if (status === 403) {
			return new vscode.LanguageModelError('Access denied by Kimi API (403).');
		}
		return null;
	}
}

// ── Rate limit (429) ───────────────────────────────────────────────

class RateLimitHandler extends BaseErrorHandler {
	protected tryHandle(status: number): vscode.LanguageModelError | null {
		if (status === 429) {
			return new vscode.LanguageModelError('Kimi API rate limit exceeded (429). Retry later.');
		}
		return null;
	}
}

// ── Context length errors (400 + marker text) ──────────────────────

class ContextLengthHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		if (status !== 400) {
			return null;
		}
		const text = body.toLowerCase();
		if (
			text.includes('context_length_exceeded') ||
			text.includes('token limit') ||
			text.includes('context length') ||
			text.includes('maximum context')
		) {
			return new vscode.LanguageModelError(
				'The Kimi Code API rejected this request because it exceeds the per-request token limit, regardless of your subscription context window. Start a new chat session, run "/compact", or remove files from the context.',
			);
		}
		return null;
	}
}

// ── Generic 400 (bad request) ──────────────────────────────────────

class BadRequestHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		if (status === 400) {
			return new vscode.LanguageModelError(`Kimi API error ${status}: ${body.slice(0, 300)}`);
		}
		return null;
	}
}

// ── Server errors (5xx) ────────────────────────────────────────────

class ServerErrorHandler extends BaseErrorHandler {
	protected tryHandle(status: number): vscode.LanguageModelError | null {
		if (status >= 500 && status < 600) {
			return new vscode.LanguageModelError('Kimi API server error. Retry later.');
		}
		return null;
	}
}

// ── Fallback (any unhandled status) ────────────────────────────────

class FallbackHandler extends BaseErrorHandler {
	protected tryHandle(status: number, body: string): vscode.LanguageModelError | null {
		return new vscode.LanguageModelError(`Kimi API error ${status}: ${body.slice(0, 300)}`);
	}
}

// ── Chain factory ──────────────────────────────────────────────────

/**
 * Assembles the error-handling chain once.
 * Order matters: earlier handlers take priority for overlapping status codes
 * (e.g. ContextLengthHandler must precede BadRequestHandler for 400).
 */
export function createErrorChain(): ErrorHandler {
	const chain = new AuthErrorHandler();
	chain
		.setNext(new RateLimitHandler())
		.setNext(new ContextLengthHandler())
		.setNext(new BadRequestHandler())
		.setNext(new ServerErrorHandler())
		.setNext(new FallbackHandler());
	return chain;
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
