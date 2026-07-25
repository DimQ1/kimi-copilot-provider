import type { KimiRequest, KimiMessage, KimiTool, ModelDefaults, ModelConfigOverride } from './types';

// ═══════════════════════════════════════════════════════════════════════
// KimiRequestBuilder — GoF Builder pattern
//
// Encapsulates the piecemeal construction of a KimiRequest, resolving
// parameters through the layered precedence chain:
//   per-model config > global setting > hard-coded model default > built-in fallback.
//
// Supports both K2 and K3 request policies via setPolicy().
// ═══════════════════════════════════════════════════════════════════════

export interface BuilderParams {
	/** Per-model config override from kimiCopilot.modelConfigs. */
	modelConfig: ModelConfigOverride;
	/** Hard-coded defaults from the model registry. */
	modelDefaults: ModelDefaults | undefined;
}

export interface TemperatureResolution {
	/** Resolves global temperature setting, or undefined. */
	getTemperature(): number | undefined;
}

export interface TopPResolution {
	getTopP(): number | undefined;
}

export interface PenaltyResolution {
	getPresencePenalty(modelId: string): number | undefined;
	getFrequencyPenalty(modelId: string): number | undefined;
}

export interface ThinkingResolution {
	getThinking(modelId: string): { type: 'enabled' | 'disabled' } | undefined;
}

/**
 * Merges the three resolution sources into one shape required by the builder.
 */
export interface GlobalSettings
	extends TemperatureResolution,
		TopPResolution,
		PenaltyResolution {}

export class KimiRequestBuilder {
	private _model = '';
	private _messages: KimiMessage[] = [];
	private _stream = false;
	private _includeUsage = true;
	private _toolCallingEnabled = false;
	private _tools: KimiTool[] | undefined;
	private _systemPrompt = '';
	private _transliterate = false;

	// Resolved parameters
	private _temperature = 1.0;
	private _topP = 0.95;
	private _presencePenalty = 0.0;
	private _frequencyPenalty = 0.0;
	private _thinking?: { type: 'enabled' | 'disabled' };
	private _reasoningEffort?: 'low' | 'high' | 'max';
	private _thinkingKeep?: string;
	private _maxTokens = 32768;
	private _requestPolicy: 'k2' | 'k3' = 'k2';

	// Sources
	private _modelId = '';
	private _modelConfig: ModelConfigOverride = {};
	private _modelDefaults: ModelDefaults | undefined;
	private _globalSettings: GlobalSettings | undefined;

	constructor(modelId: string, apiModelName: string) {
		this._modelId = modelId;
		this._model = apiModelName;
	}

	// ── Fluent setters ──────────────────────────────────────────────

	withMessages(messages: KimiMessage[]): this {
		this._messages = messages;
		return this;
	}

	withStreaming(enabled: boolean, includeUsage = true): this {
		this._stream = enabled;
		this._includeUsage = includeUsage;
		return this;
	}

	withMaxTokens(maxOutputTokens: number): this {
		this._maxTokens = maxOutputTokens;
		return this;
	}

	withToolCalling(enabled: boolean, tools?: KimiTool[]): this {
		this._toolCallingEnabled = enabled;
		this._tools = tools;
		return this;
	}

	withSystemPrompt(prompt: string): this {
		this._systemPrompt = prompt;
		return this;
	}

	withTransliterate(enabled: boolean): this {
		this._transliterate = enabled;
		return this;
	}

	withRequestPolicy(policy: 'k2' | 'k3'): this {
		this._requestPolicy = policy;
		return this;
	}

	/**
	 * Applies the layered parameter resolution.
	 * Precedence: modelConfig > global setting > model default > built-in fallback.
	 */
	withModelConfig(config: ModelConfigOverride): this {
		this._modelConfig = config;
		return this;
	}

	withModelDefaults(defaults: ModelDefaults | undefined): this {
		this._modelDefaults = defaults;
		return this;
	}

	withGlobalSettings(settings: GlobalSettings): this {
		this._globalSettings = settings;
		return this;
	}

	withThinking(thinking: { type: 'enabled' | 'disabled' } | undefined): this {
		this._thinking = thinking;
		return this;
	}

	withReasoningEffort(effort: 'low' | 'high' | 'max' | undefined): this {
		this._reasoningEffort = effort;
		return this;
	}

	/**
	 * Sets the thinking keep value (e.g. 'all'). When set, previous reasoning
	 * content is echoed back to the API so the model can see its own thinking.
	 * Mirrors kimi-code's extra_body.thinking.keep.
	 */
	withThinkingKeep(keep: string | undefined): this {
		this._thinkingKeep = keep;
		return this;
	}

	// ── Parameter resolution ────────────────────────────────────────

	private resolveTemperature(): number {
		return (
			this._modelConfig.temperature ??
			this._globalSettings?.getTemperature() ??
			this._modelDefaults?.temperature ??
			1.0
		);
	}

	private resolveTopP(): number {
		return (
			this._modelConfig.topP ??
			this._globalSettings?.getTopP() ??
			this._modelDefaults?.topP ??
			0.95
		);
	}

	private resolvePresencePenalty(): number {
		return (
			this._modelConfig.presencePenalty ??
			this._globalSettings?.getPresencePenalty(this._modelId) ??
			0.0
		);
	}

	private resolveFrequencyPenalty(): number {
		return (
			this._modelConfig.frequencyPenalty ??
			this._globalSettings?.getFrequencyPenalty(this._modelId) ??
			0.0
		);
	}

	// ── Build ───────────────────────────────────────────────────────

	/**
	 * Validates and constructs the final KimiRequest.
	 * All parameter resolution happens here, deferred until the end.
	 */
	build(): KimiRequest {
		// Resolve parameters lazily — after all fluent calls have set their values.
		this._temperature = this.resolveTemperature();
		this._topP = this.resolveTopP();
		this._presencePenalty = this.resolvePresencePenalty();
		this._frequencyPenalty = this.resolveFrequencyPenalty();

		const request: KimiRequest = {
			model: this._model,
			messages: this._messages,
			stream: this._stream,
		};

		if (this._stream && this._includeUsage) {
			request.stream_options = { include_usage: true };
		}

		if (this._requestPolicy === 'k3') {
			request.max_completion_tokens = this._maxTokens;
			request.reasoning_effort = this._reasoningEffort ?? 'max';
		} else {
			request.temperature = this._temperature;
			request.top_p = this._topP;
			request.max_tokens = this._maxTokens;
			request.presence_penalty = this._presencePenalty;
			request.frequency_penalty = this._frequencyPenalty;
			if (this._thinking) {
				request.thinking = this._thinking;
			}
		}

		// Thinking keep: echo previous reasoning back to the API.
		// Only meaningful when thinking is enabled (not disabled).
		const thinkingEnabled =
			this._requestPolicy === 'k3' || this._thinking?.type !== 'disabled';
		if (thinkingEnabled && this._thinkingKeep) {
			request.extra_body = {
				...(request.extra_body ?? {}),
				thinking: {
					...(request.extra_body?.thinking ?? {}),
					keep: this._thinkingKeep,
				},
			};
		}

		// Tools
		if (this._toolCallingEnabled && this._tools && this._tools.length > 0) {
			request.tools = this._tools;
			request.tool_choice = 'auto';
		}

		return request;
	}

	// ── Getters for use by the caller before build() ─────────────────

	get transpirate(): boolean {
		return this._transliterate;
	}

	get systemPrompt(): string {
		return this._systemPrompt;
	}
}
