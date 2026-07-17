import * as vscode from 'vscode';
import type { ModelDefinition, ModelCapabilities, ModelDefaults, ModelConfigOverride } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Model Registry
// ═══════════════════════════════════════════════════════════════════════

export const MODELS: ModelDefinition[] = [
	{
		id: 'kimi-k3',
		name: 'Kimi K3',
		family: 'kimi',
		version: 'kimi-k3',
		detail: 'Flagship model (256K context on Moderato, 1M on Allegretto+, native vision, reasoning effort)',
		maxInputTokens: 262144,
		maxOutputTokens: 131072,
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
}

export function toChatInfo(
	m: ModelDefinition,
	hasApiKey: boolean,
	overrides?: Partial<ModelConfigOverride>,
): ModelPickerChatInformation {
	const maxInputTokens = overrides?.maxInputTokens ?? m.maxInputTokens;
	const maxOutputTokens = overrides?.maxOutputTokens ?? m.maxOutputTokens;
	return {
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
	};
}

export function getModelCapabilities(modelId: string): ModelCapabilities | undefined {
	return MODELS.find((m) => m.id === modelId)?.capabilities;
}

export function getModelDefaults(modelId: string): ModelDefaults | undefined {
	return MODELS.find((m) => m.id === modelId)?.defaults;
}

export function getMaxOutputTokens(modelId: string): number {
	return MODELS.find((m) => m.id === modelId)?.maxOutputTokens ?? 32768;
}

export function findModelById(modelId: string): ModelDefinition | undefined {
	return MODELS.find((m) => m.id === modelId);
}
