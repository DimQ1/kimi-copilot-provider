import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { ConfigurationManager } from '../config';
import type { KimiChatProvider } from '../provider';

/**
 * Command: "Kimi Copilot: Select Model"
 * Shows a QuickPick to select the default Kimi model.
 */
export class SelectModelCommand extends BaseCommand {
	readonly id = 'kimi-copilot.selectModel';

	constructor(
		private readonly configManager: ConfigurationManager,
		private readonly provider: KimiChatProvider,
	) {
		super();
	}

	async execute(): Promise<void> {
		const { MODELS } = await import('../models.js');
		const current = this.configManager.getModel();

		const items: vscode.QuickPickItem[] = MODELS.map((m) => ({
			label: m.name,
			description: m.id,
			detail: m.detail,
			picked: m.id === current,
		}));

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select default Kimi model',
			ignoreFocusOut: true,
		});

		if (selected) {
			await this.configManager.config.update('model', selected.description, true);
			this.provider.refreshModelPicker();
			vscode.window.showInformationMessage(`Default Kimi model set to ${selected.label}`);
		}
	}
}
