import * as vscode from 'vscode';
import { ConfigurationManager } from './config';
import { KimiChatProvider } from './provider';
import { UsageTracker } from './usage';
import { KimiUsageClient } from './usage-client';
import { showUsageDetailsPanel } from './usage-webview';
import { showUsageQuickPick } from './usage-popup';

const QUOTA_REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const QUOTA_WARNING_THRESHOLD = 0.8;
const QUOTA_CRITICAL_THRESHOLD = 0.95;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const configManager = new ConfigurationManager(context.secrets, context.globalState);
    const usageTracker = new UsageTracker(context.globalState);
    const provider = new KimiChatProvider(configManager, usageTracker);
    const usageClient = new KimiUsageClient();

    // Layer the cached server catalog (from a previous session) over the
    // hard-coded registry, then refresh it live with the API key.
    provider.applyCachedServerModels();
    void provider.refreshModelsFromServer();

    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('kimi-copilot', provider),
        provider,
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

    registerCommands(context, configManager, provider, usageTracker, usageClient);
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
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration('kimiCopilot')) {
                void refresh();
            }
        }),
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

function registerCommands(
    context: vscode.ExtensionContext,
    configManager: ConfigurationManager,
    provider: KimiChatProvider,
    usageTracker: UsageTracker,
    usageClient: KimiUsageClient,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('kimi-copilot.setApiKey', async () => {
            const current = await configManager.getApiKey();
            const value = await vscode.window.showInputBox({
                prompt: 'Enter your Kimi API key (sk-kimi-...)',
                value: current,
                password: true,
                ignoreFocusOut: true,
                validateInput: (input) => {
                    if (!input || input.trim().length === 0) {
                        return 'API key cannot be empty';
                    }
                    return undefined;
                },
            });

            if (value !== undefined) {
                await configManager.setApiKey(value);
                provider.refreshModelPicker();
                void provider.refreshModelsFromServer();
                vscode.window.showInformationMessage('Kimi API key saved securely.');
            }
        }),

        vscode.commands.registerCommand('kimi-copilot.clearApiKey', async () => {
            await configManager.deleteApiKey();
            await configManager.clearServerModels();
            provider.applyCachedServerModels();
            provider.refreshModelPicker();
            vscode.window.showInformationMessage('Stored Kimi API key cleared.');
        }),

        vscode.commands.registerCommand('kimi-copilot.selectModel', async () => {
            const { MODELS } = await import('./models.js');
            const current = configManager.getModel();

            const items: vscode.QuickPickItem[] = MODELS.map((m) => ({
                label: m.name,
                description: m.id,
                detail: m.detail,
                picked: m.id === current,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select default Kimi model',
                ignoreFocusOut: true,
            });

            if (selected) {
                await configManager.config.update('model', selected.description, true);
                provider.refreshModelPicker();
                vscode.window.showInformationMessage(`Default Kimi model set to ${selected.label}`);
            }
        }),

        vscode.commands.registerCommand('kimi-copilot.editModelConfig', async () => {
            const { MODELS } = await import('./models.js');

            const selected = await vscode.window.showQuickPick(
                MODELS.map((m): vscode.QuickPickItem => ({
                    label: m.name,
                    description: m.id,
                    detail: m.detail,
                })),
                { placeHolder: 'Select model to configure', ignoreFocusOut: true },
            );

            if (!selected) {
                return;
            }

            const modelId = selected.description ?? '';
            const currentConfig = configManager.getModelConfig(modelId);
            const model = MODELS.find((m) => m.id === modelId);

            const updated = await vscode.window.showInputBox({
                prompt: `Edit JSON overrides for ${modelId}`,
                value: JSON.stringify(currentConfig, null, 2),
                ignoreFocusOut: true,
                validateInput: (input) => {
                    try {
                        if (input.trim().length > 0) {
                            JSON.parse(input);
                        }
                        return undefined;
                    } catch (err) {
                        return `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
                    }
                },
            });

            if (updated === undefined) {
                return;
            }

            const parsed = updated.trim().length > 0 ? JSON.parse(updated) : {};
            const configs = configManager.config.get<Record<string, object>>('modelConfigs', {});
            configs[modelId] = parsed;

            await configManager.config.update('modelConfigs', configs, true);
            provider.refreshModelPicker();
            vscode.window.showInformationMessage(
                `Updated configuration for ${model?.name ?? modelId}.`,
            );
        }),

        vscode.commands.registerCommand('kimi-copilot.testConnection', async () => {
            const apiKey = await configManager.getApiKey();
            if (!apiKey) {
                vscode.window.showErrorMessage('Kimi API key is not set. Run "Kimi Copilot: Set API Key".');
                return;
            }

            try {
                await provider.testConnection(configManager.getModel());
                vscode.window.showInformationMessage('Kimi connection OK.');
            } catch (err) {
                vscode.window.showErrorMessage(`Kimi connection failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),

        vscode.commands.registerCommand('kimi-copilot.showUsagePopup', async () => {
            await showUsageQuickPick(context, usageTracker);
        }),

        vscode.commands.registerCommand('kimi-copilot.showUsageStats', () => {
            showUsageDetailsPanel(
                context,
                usageTracker,
                () => vscode.commands.executeCommand('kimi-copilot.refreshQuota'),
                () => vscode.commands.executeCommand('kimi-copilot.openKimiConsole'),
            );
        }),

        vscode.commands.registerCommand('kimi-copilot.refreshQuota', async () => {
            const apiKey = await configManager.getApiKey();
            if (!apiKey) {
                vscode.window.showErrorMessage('Kimi API key is not set. Run "Kimi Copilot: Set API Key".');
                return;
            }
            const result = await usageClient.fetchUsage(apiKey);
            if (result.kind === 'ok') {
                usageTracker.setQuota(result.usage, null);
                vscode.window.showInformationMessage('Kimi Copilot quota refreshed.');
            } else {
                usageTracker.setQuota(null, result.message);
                vscode.window.showErrorMessage(result.message);
            }
        }),

        vscode.commands.registerCommand('kimi-copilot.openKimiConsole', () => {
            void vscode.env.openExternal(vscode.Uri.parse('https://platform.kimi.ai/console'));
        }),

        vscode.commands.registerCommand('kimi-copilot.resetUsageStats', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Reset local Kimi Copilot usage statistics?',
                { modal: true },
                'Reset',
            );
            if (answer === 'Reset') {
                usageTracker.reset();
                vscode.window.showInformationMessage('Kimi Copilot usage statistics reset.');
            }
        }),

        vscode.commands.registerCommand('kimi-copilot.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'kimiCopilot');
        }),
    );
}

export async function deactivate(): Promise<void> {
    // Nothing to clean up; VS Code disposes subscriptions automatically.
}
