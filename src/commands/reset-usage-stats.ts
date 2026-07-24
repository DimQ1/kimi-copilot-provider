import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { UsageTracker } from '../usage';

/**
 * Command: "Kimi Copilot: Reset Usage Stats"
 * Resets local token/call counters.
 */
export class ResetUsageStatsCommand extends BaseCommand {
	readonly id = 'kimi-copilot.resetUsageStats';

	constructor(private readonly usageTracker: UsageTracker) {
		super();
	}

	async execute(): Promise<void> {
		const answer = await vscode.window.showWarningMessage(
			'Reset local Kimi Copilot usage statistics?',
			{ modal: true },
			'Reset',
		);
		if (answer === 'Reset') {
			this.usageTracker.reset();
			vscode.window.showInformationMessage('Kimi Copilot usage statistics reset.');
		}
	}
}
