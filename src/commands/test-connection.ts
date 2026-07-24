import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { ConfigurationManager } from '../config';
import type { KimiChatProvider } from '../provider';

/**
 * Command: "Kimi Copilot: Test Connection"
 * Sends a lightweight ping to verify API connectivity.
 */
export class TestConnectionCommand extends BaseCommand {
	readonly id = 'kimi-copilot.testConnection';

	constructor(
		private readonly configManager: ConfigurationManager,
		private readonly provider: KimiChatProvider,
	) {
		super();
	}

	async execute(): Promise<void> {
		const apiKey = await this.configManager.getApiKey();
		if (!apiKey) {
			vscode.window.showErrorMessage('Kimi API key is not set. Run "Kimi Copilot: Set API Key".');
			return;
		}

		try {
			await this.provider.testConnection(this.configManager.getModel());
			vscode.window.showInformationMessage('Kimi connection OK.');
		} catch (err) {
			vscode.window.showErrorMessage(
				`Kimi connection failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
