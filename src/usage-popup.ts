import * as vscode from 'vscode';
import type { UsageTracker } from './usage';
import { showUsageDetailsPanel } from './usage-webview';

function renderProgressBar(ratio: number, width = 10): string {
	const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
	const empty = width - filled;
	const bar = '█'.repeat(filled) + '░'.repeat(empty);
	return `${bar} ${Math.round(ratio * 100)}%`;
}

function renderRow(label: string, used: number, limit: number, resetHint?: string): string {
	if (limit <= 0) {
		return `${label}: ${used.toLocaleString('en-US')}`;
	}
	const remaining = Math.max(0, limit - used);
	return [
		`${label}: ${renderProgressBar(used / limit)}`,
		`  ${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} used · ${remaining.toLocaleString('en-US')} left${resetHint ? ` · ${resetHint}` : ''}`,
	].join('\n');
}

export async function showUsageQuickPick(
	context: vscode.ExtensionContext,
	usageTracker: UsageTracker,
): Promise<void> {
	const quota = usageTracker.getQuota();
	const stats = usageTracker.getStats();
	const error = usageTracker.getQuotaError();

	const lines: string[] = [];

	const summary = quota?.summary;
	if (summary && summary.limit > 0) {
		lines.push(renderRow('Kimi Code quota', summary.used, summary.limit, summary.resetHint));
	} else if (error) {
		lines.push(`Quota: ${error}`);
	} else {
		lines.push('Kimi Code quota: no data yet. Refresh to load usage.');
	}

	for (const limit of quota?.limits ?? []) {
		if (limit.limit > 0) {
			lines.push(renderRow(limit.label, limit.used, limit.limit, limit.resetHint));
		}
	}

	lines.push('');
	lines.push('Local stats');
	lines.push(`  Requests: ${stats.requestCount.toLocaleString('en-US')}`);
	lines.push(`  Prompt tokens: ${stats.promptTokens.toLocaleString('en-US')}`);
	lines.push(`  Completion tokens: ${stats.completionTokens.toLocaleString('en-US')}`);
	lines.push(`  Total tokens: ${stats.totalTokens.toLocaleString('en-US')}`);
	lines.push(`  Cached tokens: ${stats.cachedTokens.toLocaleString('en-US')}`);

	const message = lines.join('\n');

	const selection = await vscode.window.showInformationMessage(
		message,
		{ modal: false },
		'Open details',
		'Refresh',
		'Open Kimi Console',
		'Reset local stats',
	);

	if (!selection) return;

	switch (selection) {
		case 'Open details':
			showUsageDetailsPanel(
				context,
				usageTracker,
				() => vscode.commands.executeCommand('kimi-copilot.refreshQuota'),
				() => vscode.commands.executeCommand('kimi-copilot.openKimiConsole'),
			);
			break;
		case 'Refresh':
			await vscode.commands.executeCommand('kimi-copilot.refreshQuota');
			await showUsageQuickPick(context, usageTracker);
			break;
		case 'Open Kimi Console':
			await vscode.commands.executeCommand('kimi-copilot.openKimiConsole');
			break;
		case 'Reset local stats': {
			const answer = await vscode.window.showWarningMessage(
				'Reset local Kimi Copilot usage statistics?',
				{ modal: true },
				'Reset',
			);
			if (answer === 'Reset') {
				usageTracker.reset();
			}
			break;
		}
	}
}
