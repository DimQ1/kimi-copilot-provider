import * as vscode from 'vscode';
import type { UsageTracker } from './usage';
import type { KimiUsageRow, KimiBoosterWallet } from './types';

const PANEL_VIEW_TYPE = 'kimiCopilot.usageDetails';

let activePanel: vscode.WebviewPanel | undefined;

export function showUsageDetailsPanel(
	context: vscode.ExtensionContext,
	usageTracker: UsageTracker,
	onRefresh?: () => void,
	onOpenConsole?: () => void,
): void {
	if (activePanel) {
		activePanel.reveal(vscode.ViewColumn.One);
		activePanel.webview.html = renderHtml(usageTracker);
		return;
	}

	activePanel = vscode.window.createWebviewPanel(
		PANEL_VIEW_TYPE,
		'Kimi Copilot Usage',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		},
	);

	activePanel.webview.html = renderHtml(usageTracker);

	activePanel.webview.onDidReceiveMessage(
		(message: { command: string }) => {
			if (message.command === 'refreshQuota') {
				onRefresh?.();
			} else if (message.command === 'openConsole') {
				onOpenConsole?.();
			}
		},
		undefined,
		context.subscriptions,
	);

	activePanel.onDidDispose(
		() => {
			activePanel = undefined;
		},
		undefined,
		context.subscriptions,
	);

	// Refresh the panel whenever usage/quota changes.
	context.subscriptions.push(
		usageTracker.onDidChange(() => {
			if (activePanel) {
				activePanel.webview.html = renderHtml(usageTracker);
			}
		}),
	);
}

function renderHtml(usageTracker: UsageTracker): string {
	const stats = usageTracker.getStats();
	const quota = usageTracker.getQuota();
	const error = usageTracker.getQuotaError();

	const summary = quota?.summary;
	const summarySection = summary && summary.limit > 0
		? renderProgressRow('Kimi Code quota', summary)
		: renderInfoRow('Kimi Code quota', 'No quota data yet. Run "Refresh Quota" or wait for the next auto-refresh.');

	const limitRows = (quota?.limits ?? [])
		.filter((row) => row.limit > 0)
		.map((row) => renderProgressRow(row.label, row))
		.join('');

	const extraUsage = quota?.extraUsage;
	const extraUsageSection = extraUsage
		? renderExtraUsage(extraUsage)
		: '';

	const errorSection = error
		? `<section class="error">${escapeHtml(error)}</section>`
		: '';

	const localStats = `
<section class="card">
	<h2>Local token statistics</h2>
	<div class="grid">
		${renderStatTile('Requests', stats.requestCount)}
		${renderStatTile('Prompt tokens', formatNumber(stats.promptTokens))}
		${renderStatTile('Completion tokens', formatNumber(stats.completionTokens))}
		${renderStatTile('Total tokens', formatNumber(stats.totalTokens))}
		${renderStatTile('Cached tokens', formatNumber(stats.cachedTokens))}
	</div>
</section>
`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Kimi Copilot Usage</title>
	<style>
		:root {
			--bg: var(--vscode-editor-background, #1e1e1e);
			--fg: var(--vscode-foreground, #cccccc);
			--card-bg: var(--vscode-sideBar-background, #252526);
			--border: var(--vscode-panel-border, #3c3c3c);
			--accent: var(--vscode-progressBar-background, #007acc);
			--accent-bg: var(--vscode-inputOption-hoverBackground, #264f78);
			--error: var(--vscode-errorForeground, #f48771);
			--muted: var(--vscode-descriptionForeground, #9ca3af);
			--font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
		}
		body {
			font-family: var(--font-family);
			background: var(--bg);
			color: var(--fg);
			padding: 24px;
			margin: 0;
		}
		.container {
			max-width: 720px;
			margin: 0 auto;
		}
		header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 24px;
		}
		h1 {
			font-size: 20px;
			font-weight: 600;
			margin: 0;
		}
		.actions {
			display: flex;
			gap: 8px;
		}
		button {
			background: var(--accent-bg);
			color: var(--fg);
			border: 1px solid var(--border);
			padding: 6px 12px;
			border-radius: 4px;
			cursor: pointer;
			font: inherit;
		}
		button:hover {
			background: var(--accent);
			color: white;
		}
		.card {
			background: var(--card-bg);
			border: 1px solid var(--border);
			border-radius: 8px;
			padding: 20px;
			margin-bottom: 16px;
		}
		.card h2 {
			font-size: 14px;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--muted);
			margin: 0 0 16px 0;
			font-weight: 600;
		}
		.row {
			margin-bottom: 20px;
		}
		.row:last-child {
			margin-bottom: 0;
		}
		.row-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 8px;
		}
		.row-label {
			font-weight: 500;
		}
		.row-value {
			color: var(--muted);
			font-size: 13px;
		}
		.row-value strong {
			color: var(--fg);
			font-size: 15px;
		}
		.progress {
			width: 100%;
			height: 8px;
			background: var(--border);
			border-radius: 4px;
			overflow: hidden;
		}
		.progress-bar {
			height: 100%;
			background: var(--accent);
			transition: width 0.3s ease;
		}
		.progress-bar.warning { background: #d97706; }
		.progress-bar.critical { background: #dc2626; }
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
			gap: 12px;
		}
		.tile {
			background: var(--bg);
			border: 1px solid var(--border);
			border-radius: 6px;
			padding: 12px;
		}
		.tile-value {
			font-size: 18px;
			font-weight: 600;
			margin-bottom: 4px;
		}
		.tile-label {
			font-size: 12px;
			color: var(--muted);
		}
		.error {
			background: rgba(220, 38, 38, 0.15);
			border: 1px solid var(--error);
			color: var(--error);
			border-radius: 6px;
			padding: 12px 16px;
			margin-bottom: 16px;
		}
		.extra-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
			gap: 12px;
			margin-top: 12px;
		}
		footer {
			margin-top: 24px;
			font-size: 12px;
			color: var(--muted);
			text-align: center;
		}
	</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>Kimi Copilot Usage</h1>
			<div class="actions">
				<button id="refresh">Refresh quota</button>
				<button id="console">Open Kimi Console</button>
			</div>
		</header>
		${errorSection}
		<section class="card">
			<h2>Quota</h2>
			${summarySection}
			${limitRows}
		</section>
		${extraUsageSection}
		${localStats}
		<footer>Quota refreshes automatically every 2 minutes.</footer>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		document.getElementById('refresh').addEventListener('click', () => {
			vscode.postMessage({ command: 'refreshQuota' });
		});
		document.getElementById('console').addEventListener('click', () => {
			vscode.postMessage({ command: 'openConsole' });
		});
	</script>
</body>
</html>`;
}

function renderProgressRow(label: string, row: KimiUsageRow): string {
	const ratio = row.limit > 0 ? row.used / row.limit : 0;
	const percent = Math.min(100, Math.round(ratio * 100));
	const remaining = Math.max(0, row.limit - row.used);
	const barClass = percent >= 95 ? 'critical' : percent >= 80 ? 'warning' : '';
	const resetText = row.resetHint ? ` · Resets ${row.resetHint}` : '';

	return `
<div class="row">
	<div class="row-header">
		<span class="row-label">${escapeHtml(label)}</span>
		<span class="row-value"><strong>${percent}%</strong> used · ${formatNumber(row.used)} / ${formatNumber(row.limit)} · ${formatNumber(remaining)} left${resetText}</span>
	</div>
	<div class="progress">
		<div class="progress-bar ${barClass}" style="width: ${percent}%;"></div>
	</div>
</div>
`;
}

function renderInfoRow(label: string, message: string): string {
	return `
<div class="row">
	<div class="row-header">
		<span class="row-label">${escapeHtml(label)}</span>
		<span class="row-value">${escapeHtml(message)}</span>
	</div>
</div>
`;
}

function renderExtraUsage(extra: KimiBoosterWallet): string {
	const balance = (extra.balanceCents / 100).toFixed(2);
	const total = (extra.totalCents / 100).toFixed(2);
	const monthlyLimit = extra.monthlyChargeLimitEnabled && extra.monthlyChargeLimitCents > 0
		? `$${(extra.monthlyChargeLimitCents / 100).toFixed(2)}`
		: 'Unlimited';
	const monthlyUsed = `$${(extra.monthlyUsedCents / 100).toFixed(2)}`;

	return `
<section class="card">
	<h2>Extra Usage / Booster Wallet</h2>
	<div class="extra-grid">
		${renderTile('Balance remaining', `$${balance}`)}
		${renderTile('Total balance', `$${total}`)}
		${renderTile('Monthly cap', monthlyLimit)}
		${renderTile('Monthly spent', monthlyUsed)}
	</div>
</section>
`;
}

function renderTile(label: string, value: string): string {
	return `<div class="tile"><div class="tile-value">${escapeHtml(value)}</div><div class="tile-label">${escapeHtml(label)}</div></div>`;
}

function renderStatTile(label: string, value: number | string): string {
	return `<div class="tile"><div class="tile-value">${escapeHtml(String(value))}</div><div class="tile-label">${escapeHtml(label)}</div></div>`;
}

function formatNumber(value: number): string {
	return value.toLocaleString('en-US');
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

export function disposeUsageDetailsPanel(): void {
	activePanel?.dispose();
}
