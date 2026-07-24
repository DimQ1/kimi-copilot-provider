import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { ConfigurationManager } from '../config';
import type { KimiChatProvider } from '../provider';

/**
 * Command: "Kimi Copilot: Edit Model Configuration"
 * Lets the user edit per-model JSON overrides.
 */
export class EditModelConfigCommand extends BaseCommand {
	readonly id = 'kimi-copilot.editModelConfig';

	constructor(
		private readonly configManager: ConfigurationManager,
		private readonly provider: KimiChatProvider,
	) {
		super();
	}

	async execute(): Promise<void> {
		const { MODELS } = await import('../models.js');

		const selected = await vscode.window.showQuickPick(
			MODELS.map((m): vscode.QuickPickItem => ({
				label: m.name,
				description: m.id,
				detail: m.detail,
			})),
			{ placeHolder: 'Select model to configure', ignoreFocusOut: true },
		);

		if (!selected) return;

		const modelId = selected.description ?? '';
		const currentConfig = this.configManager.getModelConfig(modelId);

		const updated = await vscode.window.showInputBox({
			prompt: `Edit JSON overrides for ${modelId}`,
			value: JSON.stringify(currentConfig, null, 2),
			ignoreFocusOut: true,
			validateInput: (input) => {
				try {
					if (input.trim().length > 0) JSON.parse(input);
					return undefined;
				} catch (err) {
					return `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
		});

		if (updated === undefined) return;

		const parsed = updated.trim().length > 0 ? JSON.parse(updated) : {};
		const configs = this.configManager.config.get<Record<string, object>>('modelConfigs', {});
		configs[modelId] = parsed;

		await this.configManager.config.update('modelConfigs', configs, true);
		this.provider.refreshModelPicker();

		const { MODELS: allModels } = await import('../models.js');
		const model = allModels.find((m) => m.id === modelId);
		vscode.window.showInformationMessage(`Updated configuration for ${model?.name ?? modelId}.`);
	}
}
