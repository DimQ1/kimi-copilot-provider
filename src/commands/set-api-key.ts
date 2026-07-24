import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { ConfigurationManager } from '../config';
import type { KimiChatProvider } from '../provider';

/**
 * Command: "Kimi Copilot: Set API Key"
 * Prompts the user for a Kimi API key and stores it securely.
 */
export class SetApiKeyCommand extends BaseCommand {
	readonly id = 'kimi-copilot.setApiKey';

	constructor(
		private readonly configManager: ConfigurationManager,
		private readonly provider: KimiChatProvider,
	) {
		super();
	}

	async execute(): Promise<void> {
		const current = await this.configManager.getApiKey();
		const value = await vscode.window.showInputBox({
			prompt: 'Enter your Kimi API key (sk-kimi-...)',
			value: current,
			password: true,
			ignoreFocusOut: true,
			validateInput: (input) => {
				if (!input || input.trim().length === 0) {
					return 'API key cannot be empty';
				}
				return undefined;
			},
		});

		if (value !== undefined) {
			await this.configManager.setApiKey(value);
			this.provider.refreshModelPicker();
			void this.provider.refreshModelsFromServer();
			vscode.window.showInformationMessage('Kimi API key saved securely.');
		}
	}
}
