import type { KimiRequest, KimiMessage } from './types';

// ═══════════════════════════════════════════════════════════════════════
// RequestPolicy — GoF Strategy pattern
//
// Each model family has a distinct API contract. Rather than branching
// inline with `if (requestPolicy === 'k3')`, we encapsulate each contract
// in its own Strategy class. Adding a new model variant (K4, etc.) means
// adding one new Strategy — no changes to the builder or the provider.
// ═══════════════════════════════════════════════════════════════════════

export interface RequestPolicyParams {
	maxTokens: number;
	temperature: number;
	topP: number;
	presencePenalty: number;
	frequencyPenalty: number;
	thinking?: { type: 'enabled' | 'disabled' };
	reasoningEffort?: 'low' | 'high' | 'max';
}

/**
 * Applies the model's API-specific parameters to the request object.
 */
export interface RequestPolicy {
	/** Human-readable label for logging. */
	readonly label: string;
	/** Mutates the request in-place with policy-specific fields. */
	apply(request: KimiRequest, params: RequestPolicyParams): void;
}

// ── K2 Policy (K2.7, K2.6, K2.5) ──────────────────────────────────

export class K2RequestPolicy implements RequestPolicy {
	readonly label = 'k2';

	apply(request: KimiRequest, params: RequestPolicyParams): void {
		request.temperature = params.temperature;
		request.top_p = params.topP;
		request.max_tokens = params.maxTokens;
		request.presence_penalty = params.presencePenalty;
		request.frequency_penalty = params.frequencyPenalty;
		if (params.thinking) {
			request.thinking = params.thinking;
		}
	}
}

// ── K3 Policy (K3) ────────────────────────────────────────────────

export class K3RequestPolicy implements RequestPolicy {
	readonly label = 'k3';

	apply(request: KimiRequest, params: RequestPolicyParams): void {
		// K3 uses max_completion_tokens instead of max_tokens.
		request.max_completion_tokens = params.maxTokens;
		// K3 uses reasoning_effort instead of thinking.type.
		request.reasoning_effort = params.reasoningEffort ?? 'max';
		// K3 does NOT accept temperature, top_p, presence_penalty,
		// frequency_penalty, or thinking — they are intentionally omitted.
	}
}

// ── Factory ────────────────────────────────────────────────────────

const POLICIES: Record<string, RequestPolicy> = {
	k2: new K2RequestPolicy(),
	k3: new K3RequestPolicy(),
};

/** Returns the Strategy for a given request policy name. Falls back to K2. */
export function getRequestPolicy(name: string): RequestPolicy {
	return POLICIES[name] ?? POLICIES.k2;
}

/** Detects the request policy to use for a given model. */
export function detectRequestPolicy(apiModelName: string, explicitPolicy?: string): string {
	if (explicitPolicy === 'k3' || apiModelName === 'kimi-k3') {
		return 'k3';
	}
	return explicitPolicy ?? 'k2';
}

// ═══════════════════════════════════════════════════════════════════════
// Legacy compatibility — re-export the standalone function shape
// used by provider.test.ts and the old buildKimiRequest.
// Keep for now; tests can be migrated later.
// ═══════════════════════════════════════════════════════════════════════

export function buildKimiRequest(options: {
	model: string;
	messages: KimiMessage[];
	stream: boolean;
	includeUsage?: boolean;
	requestPolicy: 'k2' | 'k3';
	maxTokens: number;
	temperature: number;
	topP: number;
	presencePenalty: number;
	frequencyPenalty: number;
	thinking?: { type: 'enabled' | 'disabled' };
	reasoningEffort?: 'low' | 'high' | 'max';
}): KimiRequest {
	const request: KimiRequest = {
		model: options.model,
		messages: options.messages,
		stream: options.stream,
	};

	if (options.stream && options.includeUsage) {
		request.stream_options = { include_usage: true };
	}

	const policy = getRequestPolicy(options.requestPolicy);
	policy.apply(request, {
		maxTokens: options.maxTokens,
		temperature: options.temperature,
		topP: options.topP,
		presencePenalty: options.presencePenalty,
		frequencyPenalty: options.frequencyPenalty,
		thinking: options.thinking,
		reasoningEffort: options.reasoningEffort,
	});

	return request;
}
