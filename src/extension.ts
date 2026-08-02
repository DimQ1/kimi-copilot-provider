import * as vscode from 'vscode';
import { ConfigurationManager } from './config';
import { ModelRegistry } from './model-registry';
import { KimiChatProvider } from './provider';
import { UsageTracker } from './usage';
import { KimiUsageClient } from './usage-client';
import { registerAllCommands } from './commands';
import { disposeUsageDetailsPanel } from './usage-webview';

const QUOTA_REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const QUOTA_WARNING_THRESHOLD = 0.8;
const QUOTA_CRITICAL_THRESHOLD = 0.95;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const configManager = new ConfigurationManager(context.secrets, context.globalState);
    const modelRegistry = new ModelRegistry();
    const usageTracker = new UsageTracker(context.globalState);
    const provider = new KimiChatProvider(configManager, usageTracker, modelRegistry);
    const usageClient = new KimiUsageClient();

    // Layer the cached server catalog (from a previous session) over the
    // hard-coded registry, then refresh it live with the API key.
    provider.applyCachedServerModels();
    void provider.refreshModelsFromServer();

    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('kimi-copilot', provider),
        provider,
        usageTracker,
        usageClient,
        new vscode.Disposable(disposeUsageDetailsPanel),
    );

    const statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100,
    );
    statusBar.command = 'kimi-copilot.showUsagePopup';
    statusBar.tooltip = new vscode.MarkdownString('Kimi Copilot usage statistics\n\nClick to open usage popup.', true);
    statusBar.text = usageTracker.getStatusBarText();
    statusBar.show();
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        usageTracker.onDidChange(() => {
            statusBar.text = usageTracker.getStatusBarText();
        }),
    );

    registerAllCommands(context, configManager, provider, usageTracker, usageClient);
    startQuotaRefresh(context, configManager, usageTracker, usageClient);

    // Copilot Chat may serve cached model info. Activate it first so the
    // refresh reaches a live listener and re-queries the provider.
    try {
        await vscode.extensions.getExtension('github.copilot-chat')?.activate();
    } catch {
        // Best-effort; Copilot Chat may not be installed.
    }

    provider.refreshModelPicker();
}

function startQuotaRefresh(
    context: vscode.ExtensionContext,
    configManager: ConfigurationManager,
    usageTracker: UsageTracker,
    usageClient: KimiUsageClient,
): void {
    const refresh = async (): Promise<void> => {
        const apiKey = await configManager.getApiKey();
        if (!apiKey) {
            usageTracker.setQuota(null, 'API key not set');
            return;
        }
        try {
            const result = await usageClient.fetchUsage(apiKey);
            if (result.kind === 'ok') {
                usageTracker.setQuota(result.usage, null);
                notifyQuotaThresholds(usageTracker);
            } else {
                usageTracker.setQuota(null, result.message);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            usageTracker.setQuota(null, message);
        }
    };

    // Refresh immediately on activation, then periodically.
    void refresh();
    const timer = setInterval(refresh, QUOTA_REFRESH_INTERVAL_MS);
    context.subscriptions.push(
        new vscode.Disposable(() => clearInterval(timer)),
    );

    // Also refresh when the API key changes.
    context.subscriptions.push(
        configManager.onDidChangeApiKey(() => void refresh()),
    );
}

let lastQuotaNotification: { ratio: number; level: 'warning' | 'critical' } | null = null;

function notifyQuotaThresholds(usageTracker: UsageTracker): void {
    const highest = usageTracker.getHighestQuotaUsage();
    if (!highest) return;

    const { row, ratio } = highest;
    let level: 'warning' | 'critical' | null = null;
    if (ratio >= QUOTA_CRITICAL_THRESHOLD) {
        level = 'critical';
    } else if (ratio >= QUOTA_WARNING_THRESHOLD) {
        level = 'warning';
    }

    if (!level) {
        lastQuotaNotification = null;
        return;
    }

    if (lastQuotaNotification && lastQuotaNotification.level === level && lastQuotaNotification.ratio >= ratio) {
        return;
    }
    lastQuotaNotification = { ratio, level };

    const percent = Math.round(ratio * 100);
    const message = `Kimi Copilot ${row.label.toLowerCase()} is at ${percent}% (${row.used}/${row.limit}).`;
    if (level === 'critical') {
        void vscode.window.showErrorMessage(message, 'Open Kimi Console').then((selection) => {
            if (selection === 'Open Kimi Console') {
                void vscode.env.openExternal(vscode.Uri.parse('https://platform.kimi.ai/console'));
            }
        });
    } else {
        void vscode.window.showWarningMessage(message);
    }
}

export async function deactivate(): Promise<void> {
    // Nothing to clean up; VS Code disposes subscriptions automatically.
}
