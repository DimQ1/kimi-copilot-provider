import * as vscode from 'vscode';
import { BaseCommand } from './base';
import { showUsageQuickPick } from '../usage-popup';
import type { UsageTracker } from '../usage';

/**
 * Command: "Kimi Copilot: Show Usage" (status bar click)
 * Shows the usage quick-pick popup.
 */
export class ShowUsagePopupCommand extends BaseCommand {
	readonly id = 'kimi-copilot.showUsagePopup';

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly usageTracker: UsageTracker,
	) {
		super();
	}

	async execute(): Promise<void> {
		await showUsageQuickPick(this.context, this.usageTracker);
	}
}
