import * as vscode from 'vscode';
import { Command } from './base';
import { SetApiKeyCommand } from './set-api-key';
import { ClearApiKeyCommand } from './clear-api-key';
import { SelectModelCommand } from './select-model';
import { EditModelConfigCommand } from './edit-model-config';
import { TestConnectionCommand } from './test-connection';
import { ShowUsagePopupCommand } from './show-usage-popup';
import { ShowUsageStatsCommand } from './show-usage-stats';
import { RefreshQuotaCommand } from './refresh-quota';
import { OpenKimiConsoleCommand } from './open-kimi-console';
import { ResetUsageStatsCommand } from './reset-usage-stats';
import { OpenSettingsCommand } from './open-settings';
import { ShowDiagnosticsCommand } from './show-diagnostics';
import type { ConfigurationManager } from '../config';
import type { KimiChatProvider } from '../provider';
import type { UsageTracker } from '../usage';
import type { KimiUsageClient } from '../usage-client';

/**
 * Creates all registered commands and wires them into the extension lifetime.
 * Each command is a separate class (GoF Command Pattern) with its own file.
 */
export function registerAllCommands(
	context: vscode.ExtensionContext,
	configManager: ConfigurationManager,
	provider: KimiChatProvider,
	usageTracker: UsageTracker,
	usageClient: KimiUsageClient,
): void {
	const commands: Command[] = [
		new SetApiKeyCommand(configManager, provider),
		new ClearApiKeyCommand(configManager, provider),
		new SelectModelCommand(configManager, provider),
		new EditModelConfigCommand(configManager, provider),
		new TestConnectionCommand(configManager, provider),
		new ShowUsagePopupCommand(context, usageTracker),
		new ShowUsageStatsCommand(usageTracker),
		new RefreshQuotaCommand(configManager, usageTracker, usageClient),
		new OpenKimiConsoleCommand(),
		new ResetUsageStatsCommand(usageTracker),
		new OpenSettingsCommand(),
		new ShowDiagnosticsCommand(provider),
	];

	for (const cmd of commands) {
		cmd.register(context);
	}
}
