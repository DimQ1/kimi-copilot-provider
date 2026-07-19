import * as vscode from 'vscode';
import type { ModelConfigOverride, KimiServerModelInfo } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Configuration helpers — read extension settings at runtime.
// Includes secure API key storage via SecretStorage.
// ═══════════════════════════════════════════════════════════════════════

const CONFIG_SECTION = 'kimiCopilot';
const API_KEY_SECRET_KEY = 'kimiCopilot.apiKey';

/** globalState key holding the last successfully fetched /models catalog. */
const MODELS_CACHE_KEY = 'kimiCopilot.serverModels';

const DEFAULT_BASE_URL = 'https://api.kimi.com';
const DEFAULT_ENDPOINT = 'https://api.kimi.com/coding/v1/chat/completions';

export class ConfigurationManager {
	constructor(
		private readonly secretStorage: vscode.SecretStorage,
		private readonly globalState?: vscode.Memento,
	) {}

	get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(CONFIG_SECTION);
	}

	/** Cached server model catalog (undefined when never fetched). */
	getServerModels(): KimiServerModelInfo[] | undefined {
		return this.globalState?.get<KimiServerModelInfo[]>(MODELS_CACHE_KEY);
	}

	/** Persists the server model catalog across restarts. */
	async setServerModels(models: KimiServerModelInfo[]): Promise<void> {
		await this.globalState?.update(MODELS_CACHE_KEY, models);
	}

	/** Removes the cached server model catalog (e.g. when the key is cleared). */
	async clearServerModels(): Promise<void> {
		await this.globalState?.update(MODELS_CACHE_KEY, undefined);
	}

	/** Returns the API key from SecretStorage, with plain-text fallback. */
	async getApiKey(): Promise<string | undefined> {
		const fromSecret = await this.secretStorage.get(API_KEY_SECRET_KEY);
		const normalizedSecret = fromSecret?.trim();
		if (normalizedSecret) {
			return normalizedSecret;
		}

		// Fallback for migration from plain-text settings.
		const fromConfig = this.config.get<string>('apiKey', '');
		const normalizedConfig = fromConfig.trim();
		if (normalizedConfig) {
			return normalizedConfig;
		}

		return undefined;
	}

	/** Stores the API key securely in VS Code SecretStorage. */
	async setApiKey(value: string): Promise<void> {
		const normalizedValue = value.trim();
		if (!normalizedValue) {
			throw new Error('API key cannot be empty');
		}
		await this.secretStorage.store(API_KEY_SECRET_KEY, normalizedValue);
	}

	/** Removes the stored API key. */
	async deleteApiKey(): Promise<void> {
		await this.secretStorage.delete(API_KEY_SECRET_KEY);
	}

	getBaseUrl(): string {
		return this.config.get<string>('baseUrl', DEFAULT_BASE_URL).replace(/\/+$/, '');
	}

	getEndpoint(): string {
		const endpoint = this.config.get<string>('endpoint', DEFAULT_ENDPOINT);
		const candidate = endpoint.trim().length > 0 ? endpoint : DEFAULT_ENDPOINT;
		try {
			new URL(candidate);
			return candidate;
		} catch {
			return DEFAULT_ENDPOINT;
		}
	}

	/** Per-model overrides. */
	getModelConfig(vscodeModelId: string): ModelConfigOverride {
		const configs = this.config.get<Record<string, ModelConfigOverride>>('modelConfigs', {});
		return configs?.[vscodeModelId] ?? {};
	}

	/** Resolves the effective API model ID for a picker model. */
	getApiModelId(vscodeModelId: string): string {
		const modelConfig = this.getModelConfig(vscodeModelId);
		if (modelConfig.overrideModelId) {
			return modelConfig.overrideModelId;
		}

		const overrides = this.config.get<Record<string, string>>('modelIdOverrides', {});
		return overrides?.[vscodeModelId] ?? vscodeModelId;
	}

	getModel(): string {
		return this.config.get<string>('model', 'kimi-k2.7-code');
	}

	/** Effective temperature for a picker model: model config > global default. */
	getTemperature(modelId?: string): number {
		if (modelId) {
			const modelConfig = this.getModelConfig(modelId);
			if (modelConfig.temperature !== undefined) {
				return modelConfig.temperature;
			}
		}
		return this.config.get<number>('temperature', 1.0);
	}

	/** Effective max output tokens for a picker model: model config > global default. */
	getMaxTokens(modelId?: string): number {
		if (modelId) {
			const modelConfig = this.getModelConfig(modelId);
			if (modelConfig.maxOutputTokens !== undefined) {
				return modelConfig.maxOutputTokens;
			}
		}
		return this.config.get<number>('maxTokens', 0);
	}

	getTopP(modelId?: string): number {
		if (modelId) {
			const modelConfig = this.getModelConfig(modelId);
			if (modelConfig.topP !== undefined) {
				return modelConfig.topP;
			}
		}
		return this.config.get<number>('topP', 0.95);
	}

	getPresencePenalty(modelId?: string): number | undefined {
		if (modelId) {
			const modelConfig = this.getModelConfig(modelId);
			if (modelConfig.presencePenalty !== undefined) {
				return modelConfig.presencePenalty;
			}
		}
		return this.config.get<number | undefined>('presencePenalty', undefined);
	}

	getFrequencyPenalty(modelId?: string): number | undefined {
		if (modelId) {
			const modelConfig = this.getModelConfig(modelId);
			if (modelConfig.frequencyPenalty !== undefined) {
				return modelConfig.frequencyPenalty;
			}
		}
		return this.config.get<number | undefined>('frequencyPenalty', undefined);
	}

	getThinking(modelId?: string): { type: 'enabled' | 'disabled' } | undefined {
		if (modelId) {
			const modelConfig = this.getModelConfig(modelId);
			if (modelConfig.thinking) {
				return modelConfig.thinking;
			}
		}
		return undefined;
	}

	getTimeout(): number {
		return this.config.get<number>('timeout', 60000);
	}

	getEnableStreaming(): boolean {
		return this.config.get<boolean>('enableStreaming', true);
	}

	getContextWarningThreshold(): number {
		const value = this.config.get<number>('contextWarningThreshold', 0.8);
		return Math.max(0, Math.min(1, value));
	}

	getContextErrorThreshold(): number {
		const value = this.config.get<number>('contextErrorThreshold', 0.95);
		return Math.max(0, Math.min(1, value));
	}

	/** Optional user plan hint used to pick multi-tier context limits. */
	getPlan(): string | undefined {
		return this.config.get<string>('plan', '');
	}

	getSystemPrompt(modelId?: string): string {
		if (modelId) {
			const modelConfig = this.getModelConfig(modelId);
			if (modelConfig.systemPrompt !== undefined && modelConfig.systemPrompt.trim().length > 0) {
				return modelConfig.systemPrompt;
			}
		}
		return this.config.get<string>(
			'systemPrompt',
			'You are Kimi, an AI assistant provided by Moonshot AI. You are proficient in Chinese and English conversations. You provide users with safe, helpful, and accurate answers. You will reject any questions involving terrorism, racism, or explicit content. Moonshot AI is a proper noun and should not be translated.'
		);
	}

	/** Subscribe to configuration changes in our section. */
	onDidChange(callback: () => void): vscode.Disposable {
		return vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(CONFIG_SECTION)) {
				callback();
			}
		});
	}
}
