/**
 * Shared types for the Kimi Copilot extension.
 */

// ---- Cost/pricing metadata (mirrors DeepSeek's shape for Copilot Chat UI) ----

export type PricingCurrency = 'USD' | 'CNY';

export type PriceCategory = 'low' | 'medium' | 'high' | 'very_high';

export interface ModelPricing {
	cacheHitInput: number;
	cacheMissInput: number;
	output: number;
}

// ---- API request/response types ----

export interface KimiMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | KimiContentPart[];
	tool_call_id?: string;
	tool_calls?: KimiToolCall[];
}

export type KimiContentPart = KimiTextContentPart | KimiImageContentPart;

export interface KimiTextContentPart {
	type: 'text';
	text: string;
}

export interface KimiImageContentPart {
	type: 'image_url';
	image_url: { url: string };
}

export interface KimiToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface KimiTool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface KimiUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cached_tokens?: number;
}

export interface KimiRequest {
	model: string;
	messages: KimiMessage[];
	stream: boolean;
	stream_options?: { include_usage: boolean };
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	presence_penalty?: number;
	frequency_penalty?: number;
	thinking?: { type: 'enabled' | 'disabled' };
	reasoning_effort?: 'low' | 'high' | 'max';
	max_completion_tokens?: number;
	tools?: KimiTool[];
	tool_choice?: 'none' | 'auto' | 'required';
}

export interface KimiStreamChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason: string | null;
	}>;
	usage?: KimiUsage;
}

// ---- Model definitions ----

export interface ModelCapabilities {
	/** Whether the model supports function/tool calling. */
	toolCalling: boolean;
	/** Whether the model supports image input natively. */
	imageInput: boolean;
	/** Whether the model supports reasoning/thinking content. */
	thinking: boolean;
}

export interface ModelDefaults {
	/** Sampling temperature the API expects (K2.7 requires 1.0). */
	temperature?: number;
	/** Top-p sampling the API expects (K2.7 requires 0.95). */
	topP?: number;
	/** Thinking mode default (K2.7 requires enabled). */
	thinking?: { type: 'enabled' | 'disabled' };
	/** K3 reasoning effort; K3 always has thinking enabled. */
	reasoningEffort?: 'low' | 'high' | 'max';
	/** Request policy used to select the model-specific API contract. */
	requestPolicy?: 'k2' | 'k3';
}

export interface ModelConfigOverride {
	/** Override API model ID sent for this picker model. */
	overrideModelId?: string;
	/** Override max input tokens reported to Copilot Chat. */
	maxInputTokens?: number;
	/** Override max output tokens reported to Copilot Chat and sent as max_tokens. */
	maxOutputTokens?: number;
	/** Sampling temperature (use model default when omitted). */
	temperature?: number;
	/** Top-p sampling (use model default when omitted). */
	topP?: number;
	/** Presence penalty (K2.7 requires 0.0). */
	presencePenalty?: number;
	/** Frequency penalty (K2.7 requires 0.0). */
	frequencyPenalty?: number;
	/** Thinking mode override. */
	thinking?: { type: 'enabled' | 'disabled' };
	/** Reasoning effort for K3. */
	reasoningEffort?: 'low' | 'high' | 'max';
	/** Per-model system prompt. */
	systemPrompt?: string;
	/** Whether tool calling is enabled for this model. */
	toolCalling?: boolean;
	/**
	 * When true, transliterate Cyrillic text in the request to Latin before
	 * sending. Roughly halves the request body bytes for Cyrillic-heavy
	 * chats (measured 5.3 → 2.7 bytes/token), which matters because the
	 * Kimi Code API caps the request body at 2 MiB. Default: off.
	 */
	transliterate?: boolean;
	/**
	 * Custom instruction appended to the system prompt when transliteration
	 * is on (e.g. forcing the reply language). Applied on the next request.
	 * Falls back to the global setting, then to the built-in default.
	 */
	transliterateSystemPrompt?: string;
}

export interface ModelDefinition {
	/** Unique model identifier used in the model picker. */
	id: string;
	/** Human-readable model name. */
	name: string;
	/** Model family name. */
	family: string;
	/** Model version string. */
	version: string;
	/** Short description shown in the picker detail. */
	detail: string;
	/** Max input tokens the model accepts. */
	maxInputTokens: number;
	/** Max output tokens the model can produce. */
	maxOutputTokens: number;
	/** Capability flags. */
	capabilities: ModelCapabilities;
	/** Hard-coded API defaults for this model. */
	defaults?: ModelDefaults;
	/** API contract family for request construction. */
	requestPolicy: 'k2' | 'k3';
	/** Optional per-1M-token pricing metadata for the Copilot Chat picker cost panel. */
	pricing?: Readonly<Record<PricingCurrency, ModelPricing>>;
	/** Optional price tier label (low/medium/high/very_high). */
	priceCategory?: PriceCategory;
	/** Optional hard per-request token limit (prompt + history + files). */
	singleRequestLimit?: number;
	/** Optional multi-tier context limits for higher subscription plans. */
	multiTierContext?: { default: number; allegretto: number };
	/**
	 * Context window resolved by the server (`context_length` from GET /models)
	 * for the current subscription. Set only after a successful catalog fetch;
	 * takes precedence over the manual plan hint in the context tracker.
	 */
	serverContextLength?: number;
	/**
	 * Server-declared thinking toggle support ('only' = thinking cannot be
	 * disabled). When 'only', a user override `thinking: disabled` is ignored
	 * because the API would reject it.
	 */
	supportsThinkingType?: 'only' | 'no' | 'both';
}

// ---- Server model catalog types (GET /models) ----

/** One model entry from the Kimi Code `/models` endpoint. */
export interface KimiServerModelInfo {
	/** API model id, e.g. `k3`, `kimi-for-coding`. */
	id: string;
	/** Context window in tokens, resolved per subscription. */
	contextLength: number;
	supportsReasoning: boolean;
	supportsImageIn: boolean;
	supportsVideoIn: boolean;
	supportsToolUse: boolean;
	displayName?: string;
	/**
	 * Server-declared thinking toggle support:
	 * - 'only' — thinking cannot be turned off (all current Kimi Code models);
	 * - 'no'   — thinking is not supported at all;
	 * - 'both' — thinking can be toggled on and off.
	 */
	supportsThinkingType?: 'only' | 'no' | 'both';
	/** Thinking effort levels the model accepts (from `think_efforts`). */
	supportEfforts?: string[];
	/** Server default thinking effort. */
	defaultEffort?: string;
}

// ---- Kimi Code managed usage quota types ----

/** A single quota row (e.g. weekly limit, 5-hour limit). */
export interface KimiUsageRow {
	label: string;
	used: number;
	limit: number;
	resetHint?: string;
}

/** Extra Usage / Booster wallet balance. */
export interface KimiBoosterWallet {
	/** Remaining balance in whole cents. */
	balanceCents: number;
	/** Total balance in whole cents. */
	totalCents: number;
	/** Whether the user enabled a monthly spending cap. */
	monthlyChargeLimitEnabled: boolean;
	/** Monthly spending cap in whole cents; 0 means unlimited. */
	monthlyChargeLimitCents: number;
	/** Monthly spend so far in whole cents. */
	monthlyUsedCents: number;
	/** ISO currency code, e.g. USD / CNY. */
	currency: string;
}

/** Parsed response from the Kimi Code `/usages` endpoint. */
export interface KimiManagedUsage {
	/** Summary quota (usually the weekly limit). */
	summary: KimiUsageRow | null;
	/** Additional per-window limits (e.g. 5-hour rate limit). */
	limits: KimiUsageRow[];
	/** Extra Usage balance, if enabled. */
	extraUsage: KimiBoosterWallet | null;
}

/** Result of fetching managed usage from Kimi Code. */
export type KimiManagedUsageResult =
	| { kind: 'ok'; usage: KimiManagedUsage }
	| { kind: 'error'; status?: number; message: string };
