import * as vscode from 'vscode';
import type { UsageTracker } from './usage';
import { showUsageDetailsPanel } from './usage-webview';

export function showUsageQuickPick(
	context: vscode.ExtensionContext,
	usageTracker: UsageTracker,
): void {
	const quota = usageTracker.getQuota();
	const stats = usageTracker.getStats();
	const error = usageTracker.getQuotaError();

	const quickPick = vscode.window.createQuickPick();
	quickPick.title = 'Kimi Copilot Usage';
	quickPick.placeholder = 'Select an action';

	const items: vscode.QuickPickItem[] = [];

	const summary = quota?.summary;
	if (summary && summary.limit > 0) {
		const ratio = summary.used / summary.limit;
		const percent = Math.round(ratio * 100);
		const remaining = Math.max(0, summary.limit - summary.used);
		items.push({
			label: `$(graph) ${percent}% used`,
			detail: `${summary.used} / ${summary.limit} used · ${remaining} left${summary.resetHint ? ` · resets ${summary.resetHint}` : ''}`,
			alwaysShow: true,
		});
	} else if (error) {
		items.push({
			label: `$(warning) Quota unavailable`,
			detail: error,
			alwaysShow: true,
		});
	} else {
		items.push({
			label: `$(graph) No quota data yet`,
			detail: 'Refresh quota to load the latest usage from Kimi.',
			alwaysShow: true,
		});
	}

	for (const limit of quota?.limits ?? []) {
		if (limit.limit <= 0) continue;
		const remaining = Math.max(0, limit.limit - limit.used);
		items.push({
			label: `$(clock) ${limit.label}`,
			detail: `${limit.used} / ${limit.limit} used · ${remaining} left${limit.resetHint ? ` · resets ${limit.resetHint}` : ''}`,
			alwaysShow: true,
		});
	}

	items.push(
		{
			label: '$(graph-line) Open detailed usage panel',
			detail: 'Open full usage breakdown in a new editor tab.',
			alwaysShow: true,
		},
		{
			label: '$(refresh) Refresh quota',
			detail: 'Fetch the latest quota data from Kimi Code.',
			alwaysShow: true,
		},
		{
			label: '$(link-external) Open Kimi Console',
			detail: 'Open the Kimi platform console in your browser.',
			alwaysShow: true,
		},
		{
			label: '$(trash) Reset local statistics',
			detail: `Reset local counters: ${stats.requestCount} requests, ${stats.totalTokens} tokens.`,
			alwaysShow: true,
		},
	);

	quickPick.items = items;

	quickPick.onDidAccept(async () => {
		const selected = quickPick.selectedItems[0];
		quickPick.dispose();

		if (!selected) return;

		if (selected.label.includes('Open detailed usage panel')) {
			showUsageDetailsPanel(
				context,
				usageTracker,
				() => vscode.commands.executeCommand('kimi-copilot.refreshQuota'),
				() => vscode.commands.executeCommand('kimi-copilot.openKimiConsole'),
			);
		} else if (selected.label.includes('Refresh quota')) {
			await vscode.commands.executeCommand('kimi-copilot.refreshQuota');
			showUsageQuickPick(context, usageTracker);
		} else if (selected.label.includes('Open Kimi Console')) {
			await vscode.commands.executeCommand('kimi-copilot.openKimiConsole');
		} else if (selected.label.includes('Reset local statistics')) {
			const answer = await vscode.window.showWarningMessage(
				'Reset local Kimi Copilot usage statistics?',
				{ modal: true },
				'Reset',
			);
			if (answer === 'Reset') {
				usageTracker.reset();
			}
		}
	});

	quickPick.onDidHide(() => quickPick.dispose());
	quickPick.show();
}
