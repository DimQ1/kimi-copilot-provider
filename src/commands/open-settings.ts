import * as vscode from 'vscode';
import { BaseCommand } from './base';

/**
 * Command: "Kimi Copilot: Open Settings"
 * Opens VS Code settings filtered to the kimiCopilot section.
 */
export class OpenSettingsCommand extends BaseCommand {
	readonly id = 'kimi-copilot.openSettings';

	execute(): void {
		vscode.commands.executeCommand('workbench.action.openSettings', 'kimiCopilot');
	}
}
