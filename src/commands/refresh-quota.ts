import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { ConfigurationManager } from '../config';
import type { UsageTracker } from '../usage';
import type { KimiUsageClient } from '../usage-client';

/**
 * Command: "Kimi Copilot: Refresh Quota"
 * Fetches managed usage from the Kimi Code API.
 */
export class RefreshQuotaCommand extends BaseCommand {
	readonly id = 'kimi-copilot.refreshQuota';

	constructor(
		private readonly configManager: ConfigurationManager,
		private readonly usageTracker: UsageTracker,
		private readonly usageClient: KimiUsageClient,
	) {
		super();
	}

	async execute(): Promise<void> {
		const apiKey = await this.configManager.getApiKey();
		if (!apiKey) {
			vscode.window.showErrorMessage('Kimi API key is not set. Run "Kimi Copilot: Set API Key".');
			return;
		}
		const result = await this.usageClient.fetchUsage(apiKey);
		if (result.kind === 'ok') {
			this.usageTracker.setQuota(result.usage, null);
			vscode.window.showInformationMessage('Kimi Copilot quota refreshed.');
		} else {
			this.usageTracker.setQuota(null, result.message);
			vscode.window.showErrorMessage(result.message);
		}
	}
}
