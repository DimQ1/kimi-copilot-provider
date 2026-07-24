import * as vscode from 'vscode';
import { BaseCommand } from './base';

/**
 * Command: "Kimi Copilot: Open Kimi Console"
 * Opens the Kimi Platform console in the browser.
 */
export class OpenKimiConsoleCommand extends BaseCommand {
	readonly id = 'kimi-copilot.openKimiConsole';

	execute(): void {
		void vscode.env.openExternal(vscode.Uri.parse('https://platform.kimi.ai/console'));
	}
}
