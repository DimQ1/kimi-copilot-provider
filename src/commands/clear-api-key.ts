import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { ConfigurationManager } from '../config';
import type { KimiChatProvider } from '../provider';

/**
 * Command: "Kimi Copilot: Clear API Key"
 * Removes the stored API key and cached server models.
 */
export class ClearApiKeyCommand extends BaseCommand {
	readonly id = 'kimi-copilot.clearApiKey';

	constructor(
		private readonly configManager: ConfigurationManager,
		private readonly provider: KimiChatProvider,
	) {
		super();
	}

	async execute(): Promise<void> {
		await this.configManager.deleteApiKey();
		await this.configManager.clearServerModels();
		this.provider.applyCachedServerModels();
		this.provider.refreshModelPicker();
		vscode.window.showInformationMessage('Stored Kimi API key cleared.');
	}
}
