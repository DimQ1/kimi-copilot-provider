import * as vscode from 'vscode';
import type { ModelDefinition, ModelCapabilities, ModelDefaults, ModelConfigOverride, KimiServerModelInfo } from './types';
import { applyServerModels } from './models-client';

// ═══════════════════════════════════════════════════════════════════════
// Model Registry
// ═══════════════════════════════════════════════════════════════════════

export const MODELS: ModelDefinition[] = [
	{
		id: 'kimi-k3',
		name: 'Kimi K3',
		family: 'kimi',
		version: 'kimi-k3',
		detail: 'Flagship model (1M context on Allegretto+, 512K default; requests are limited only by the 2 MiB body cap, native vision, reasoning effort)',
		// Report the full session window so the Chat "Session Info" popover
		// shows the real context size (VS Code renders maxInputTokens +
		// maxOutputTokens as the denominator). The /models catalog overwrites
		// this per subscription (e.g. 1048576 on Allegretto+).
		maxInputTokens: 1048576,
		maxOutputTokens: 32768,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			thinking: true,
		},
		requestPolicy: 'k3',
		defaults: {
			reasoningEffort: 'max',
			requestPolicy: 'k3',
		},
		pricing: {
			USD: { cacheHitInput: 0.30, cacheMissInput: 3.00, output: 15.00 },
			CNY: { cacheHitInput: 2.10, cacheMissInput: 21.00, output: 105.00 },
		},
		priceCategory: 'medium',
		// Live API probing (2026-07-20) showed there is NO fixed per-request
		// token cap below the context window: a 1M-token prompt was accepted.
		// The only hard per-request stop is the 2 MiB body limit, enforced
		// separately by the context tracker. Keep the token cap equal to the
		// largest session window so it never blocks a request the API would
		// have accepted.
		singleRequestLimit: 1048576,
		multiTierContext: { default: 1048576, allegretto: 1048576 },
	},
	{
		id: 'kimi-k2.7-code',
		name: 'Kimi K2.7 Code',
		family: 'kimi',
		version: 'kimi-k2.7-code',
		detail: 'Most capable coding model (256K context, thinking enabled)',
		maxInputTokens: 256000,
		maxOutputTokens: 32768,
		capabilities: {
			toolCalling: true,
			imageInput: false,
			thinking: true,
		},
		requestPolicy: 'k2',
		defaults: {
			temperature: 1.0,
			topP: 0.95,
			thinking: { type: 'enabled' },
		},
		pricing: {
			USD: { cacheHitInput: 0.19, cacheMissInput: 0.95, output: 4.00 },
			CNY: { cacheHitInput: 1.33, cacheMissInput: 6.65, output: 28.00 },
		},
		priceCategory: 'low',
	},
	{
		id: 'kimi-k2.7-code-highspeed',
		name: 'Kimi K2.7 Code (HighSpeed)',
		family: 'kimi',
		version: 'kimi-k2.7-code-highspeed',
		detail: 'HighSpeed version of K2.7 Code (~180 tokens/s, 256K context)',
		maxInputTokens: 256000,
		maxOutputTokens: 32768,
		capabilities: {
			toolCalling: true,
			imageInput: false,
			thinking: true,
		},
		requestPolicy: 'k2',
		defaults: {
			temperature: 1.0,
			topP: 0.95,
			thinking: { type: 'enabled' },
		},
		pricing: {
			USD: { cacheHitInput: 0.38, cacheMissInput: 1.90, output: 8.00 },
			CNY: { cacheHitInput: 2.66, cacheMissInput: 13.30, output: 56.00 },
		},
		priceCategory: 'low',
	},
	{
		id: 'kimi-k2.6',
		name: 'Kimi K2.6',
		family: 'kimi',
		version: 'kimi-k2.6',
		detail: 'Most intelligent versatile model (256K context, multimodal)',
		maxInputTokens: 256000,
		maxOutputTokens: 32768,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			thinking: true,
		},
		requestPolicy: 'k2',
		defaults: {
			temperature: 1.0,
			topP: 0.95,
			thinking: { type: 'enabled' },
		},
		pricing: {
			USD: { cacheHitInput: 0.16, cacheMissInput: 0.95, output: 4.00 },
			CNY: { cacheHitInput: 1.12, cacheMissInput: 6.65, output: 28.00 },
		},
		priceCategory: 'low',
	},
	{
		id: 'kimi-k2.5',
		name: 'Kimi K2.5',
		family: 'kimi',
		version: 'kimi-k2.5',
		detail: 'Versatile multimodal model (256K context, thinking capable)',
		maxInputTokens: 256000,
		maxOutputTokens: 32768,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			thinking: true,
		},
		requestPolicy: 'k2',
		defaults: {
			temperature: 1.0,
			topP: 1.0,
			thinking: { type: 'enabled' },
		},
		priceCategory: 'low',
	},
];

// ═══════════════════════════════════════════════════════════════════════
// Model Picker Information (non-public API surface)
// ═══════════════════════════════════════════════════════════════════════
//
// The fields `isBYOK`, `isUserSelectable`, and `statusIcon` are NOT part
// of the stable `vscode.LanguageModelChatInformation` typings. They are the
// same shape currently consumed by GitHub Copilot Chat to render model
// picker metadata. Without them, the model simply won't appear in the picker.
//

interface ModelPickerChatInformation extends vscode.LanguageModelChatInformation {
	readonly isUserSelectable: boolean;
	readonly isBYOK: true;
	readonly statusIcon?: vscode.ThemeIcon;
	readonly configurationSchema?: vscode.LanguageModelConfigurationSchema;
	readonly inputCost?: string;
	readonly outputCost?: string;
	readonly cacheCost?: string;
	readonly priceCategory?: import('./types').PriceCategory;
	readonly multiplierNumeric?: number;
	readonly singleRequestLimit?: number;
	readonly multiTierContext?: { default: number; allegretto: number };
}

export function toChatInfo(
	m: ModelDefinition,
	hasApiKey: boolean,
	overrides?: Partial<ModelConfigOverride>,
): ModelPickerChatInformation {
	const maxInputTokens = overrides?.maxInputTokens ?? m.maxInputTokens;
	const maxOutputTokens = overrides?.maxOutputTokens ?? m.maxOutputTokens;

	const supportsReasoningEffort = m.capabilities.thinking && m.defaults?.reasoningEffort !== undefined;
	const reasoningLevels: string[] = supportsReasoningEffort ? ['low', 'high', 'max'] : [];

	const info: ModelPickerChatInformation = {
		id: m.id,
		name: m.name,
		family: m.family,
		version: m.version,
		detail: hasApiKey ? m.detail : 'Please run "Kimi Copilot: Set API Key" to configure.',
		tooltip: hasApiKey ? undefined : 'API key not configured',
		statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
		maxInputTokens,
		maxOutputTokens,
		isBYOK: true,
		isUserSelectable: true,
		capabilities: {
			toolCalling: m.capabilities.toolCalling,
			imageInput: m.capabilities.imageInput,
		},
		...toModelCostInfo(m),
		singleRequestLimit: m.singleRequestLimit,
		multiTierContext: m.multiTierContext,
	};

	if (reasoningLevels.length > 0) {
		Object.assign(info, {
			configurationSchema: {
				properties: {
					reasoningEffort: buildReasoningEffortSchemaProperty(reasoningLevels),
				},
			},
		});
	}

	return info;
}

function toModelCostInfo(m: ModelDefinition): { inputCost?: string; outputCost?: string; cacheCost?: string; priceCategory?: import('./types').PriceCategory } {
	const pricing = m.pricing?.USD;
	if (!pricing) {
		return { priceCategory: m.priceCategory };
	}
	return {
		inputCost: formatPriceValue(pricing.cacheMissInput),
		outputCost: formatPriceValue(pricing.output),
		cacheCost: formatPriceValue(pricing.cacheHitInput),
		priceCategory: m.priceCategory,
	};
}

function formatPriceValue(value: number): string {
	return `$${value.toFixed(2)}`;
}

function buildReasoningEffortSchemaProperty(
	effortLevels: readonly string[],
): NonNullable<vscode.LanguageModelConfigurationSchema['properties']>[string] {
	const labels: Record<string, string> = {
		low: 'Low',
		medium: 'Medium',
		high: 'High',
		max: 'Max',
	};
	const descriptions: Record<string, string> = {
		low: 'Faster responses with less reasoning',
		medium: 'Balanced reasoning and speed',
		high: 'Greater reasoning depth but slower',
		max: 'Absolute maximum capability with no constraints',
	};
	const defaultLevel = effortLevels.includes('high') ? 'high' : effortLevels[0];
	return {
		type: 'string',
		title: 'Thinking Effort',
		enum: effortLevels,
		enumItemLabels: effortLevels.map((level) => labels[level] ?? level.charAt(0).toUpperCase() + level.slice(1)),
		enumDescriptions: effortLevels.map((level) => descriptions[level] ?? level),
		default: defaultLevel,
		group: 'navigation',
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Dynamic registry — server catalog layered on top of MODELS
// ═══════════════════════════════════════════════════════════════════════
//
// The hard-coded MODELS table above is the fallback. When the extension
// successfully fetches GET /models with the user's API key, the returned
// per-subscription parameters (context window, capabilities, effort
// levels) are layered on top of it here, so every consumer of the helper
// functions below sees the server-resolved values.

let effectiveModels: ModelDefinition[] = MODELS;

/**
 * Replaces the effective registry with the server catalog merged over the
 * hard-coded fallback. Pass `undefined` to restore the hard-coded table.
 */
export function applyServerModelCatalog(serverModels: readonly KimiServerModelInfo[] | undefined): void {
	effectiveModels =
		serverModels && serverModels.length > 0
			? applyServerModels(MODELS, serverModels)
			: MODELS;
}

/** The effective registry: hard-coded MODELS plus any server overrides. */
export function getEffectiveModels(): readonly ModelDefinition[] {
	return effectiveModels;
}

export function getModelCapabilities(modelId: string): ModelCapabilities | undefined {
	return effectiveModels.find((m) => m.id === modelId)?.capabilities;
}

export function getModelDefaults(modelId: string): ModelDefaults | undefined {
	return effectiveModels.find((m) => m.id === modelId)?.defaults;
}

export function getMaxOutputTokens(modelId: string): number {
	return effectiveModels.find((m) => m.id === modelId)?.maxOutputTokens ?? 32768;
}

export function findModelById(modelId: string): ModelDefinition | undefined {
	return effectiveModels.find((m) => m.id === modelId);
}
