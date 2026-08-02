import * as vscode from 'vscode';
import { BaseCommand } from './base';
import { showUsageDetailsPanel } from '../usage-webview';
import type { UsageTracker } from '../usage';

/**
 * Command: "Kimi Copilot: Show Usage Details"
 * Opens the usage WebView panel.
 */
export class ShowUsageStatsCommand extends BaseCommand {
	readonly id = 'kimi-copilot.showUsageStats';

	constructor(
		private readonly usageTracker: UsageTracker,
	) {
		super();
	}

	execute(): void {
		showUsageDetailsPanel(
			this.usageTracker,
			() => vscode.commands.executeCommand('kimi-copilot.refreshQuota'),
			() => vscode.commands.executeCommand('kimi-copilot.openKimiConsole'),
		);
	}
}
