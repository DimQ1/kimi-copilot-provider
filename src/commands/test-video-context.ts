import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { ConfigurationManager } from '../config';
import {
    deriveApiBaseUrl,
    inspectVideoFile,
    KimiVideoClient,
    VIDEO_FILE_EXTENSIONS,
    VideoClientCancelledError,
} from '../video-client';

const PLATFORM_API_BASE_URL = 'https://api.moonshot.ai/v1';

type VideoProbeTarget = {
    label: string;
    description: string;
    baseUrl: string;
    defaultModel: string;
};

export class TestVideoContextCommand extends BaseCommand {
    readonly id = 'kimi-copilot.testVideoContext';

    private readonly outputChannel = vscode.window.createOutputChannel('Kimi Video Probe');

    constructor(private readonly configManager: ConfigurationManager) {
        super();
    }

    override register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(this.outputChannel);
        super.register(context);
    }

    async execute(): Promise<void> {
        const apiKey = await this.resolveApiKey();
        if (!apiKey) {
            void vscode.window.showErrorMessage(
                'Kimi Video Probe: set KIMI_API_KEY or MOONSHOT_API_KEY before starting VS Code, or use Kimi Copilot: Set API Key.',
            );
            return;
        }

        const videoUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Test Video Context',
            filters: {
                Video: VIDEO_FILE_EXTENSIONS,
            },
        });
        if (!videoUri || videoUri.length === 0) return;

        const target = await this.selectTarget();
        if (!target) return;

        const model = await vscode.window.showInputBox({
            title: 'Kimi Video Probe Model',
            prompt: 'Enter the model ID accepted by the selected endpoint.',
            value: target.defaultModel,
            validateInput: (value) => (value.trim().length > 0 ? undefined : 'Model ID is required.'),
        });
        if (!model) return;

        const videoPath = videoUri[0].fsPath;
        let videoInfo;
        try {
            videoInfo = await inspectVideoFile(videoPath);
        } catch (error) {
            this.showFailure(`Cannot read video metadata: ${formatError(error)}`);
            return;
        }

        this.outputChannel.clear();
        this.outputChannel.appendLine('Kimi Video Context Probe');
        this.outputChannel.appendLine(`File: ${videoInfo.fileName} (${formatBytes(videoInfo.size)}, ${videoInfo.mimeType})`);
        this.outputChannel.appendLine(`API base: ${target.baseUrl}`);
        this.outputChannel.appendLine(`Model: ${model.trim()}`);
        this.outputChannel.appendLine(
            `API key source: ${this.getEnvironmentApiKey() ? 'environment' : 'SecretStorage/settings'}`,
        );
        this.outputChannel.appendLine('');
        this.outputChannel.show(true);

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Kimi video context probe',
                    cancellable: true,
                },
                async (progress, cancellationToken) => {
                    const result = await new KimiVideoClient(target.baseUrl).analyze({
                        apiKey,
                        videoPath,
                        model: model.trim(),
                        question: 'Describe this video briefly. Mention the main scene and any important actions you can observe.',
                        cancellationToken,
                        onProgress: (message) => {
                            progress.report({ message });
                            this.outputChannel.appendLine(message);
                        },
                    });
                    this.outputChannel.appendLine('');
                    this.outputChannel.appendLine('RESULT: video context request succeeded.');
                    this.outputChannel.appendLine('');
                    this.outputChannel.appendLine(result.answer);
                    this.outputChannel.show(true);
                    void vscode.window.showInformationMessage(
                        `Kimi accepted the video context (${videoInfo.fileName}). See the "Kimi Video Probe" output for the answer.`,
                    );
                },
            );
        } catch (error) {
            if (error instanceof VideoClientCancelledError) {
                this.outputChannel.appendLine('RESULT: probe cancelled.');
                void vscode.window.showWarningMessage(error.message);
                return;
            }
            const message = formatError(error);
            this.outputChannel.appendLine(`RESULT: video context request failed: ${message}`);
            this.outputChannel.show(true);
            this.showFailure(`Kimi video context probe failed: ${message}`);
        }
    }

    private async resolveApiKey(): Promise<string | undefined> {
        return this.getEnvironmentApiKey() ?? (await this.configManager.getApiKey());
    }

    private getEnvironmentApiKey(): string | undefined {
        for (const name of ['KIMI_API_KEY', 'MOONSHOT_API_KEY']) {
            const value = process.env[name]?.trim();
            if (value) return value;
        }
        return undefined;
    }

    private async selectTarget(): Promise<VideoProbeTarget | undefined> {
        const configuredBaseUrl = deriveApiBaseUrl(this.configManager.getEndpoint());
        const configuredModel = this.configManager.getApiModelId(this.configManager.getModel());
        const customBaseUrl = process.env.KIMI_VIDEO_API_BASE_URL?.trim();
        const targets: VideoProbeTarget[] = [
            {
                label: 'Configured Kimi endpoint',
                description: `${configuredBaseUrl} · model default: ${configuredModel}`,
                baseUrl: configuredBaseUrl,
                defaultModel: configuredModel,
            },
            {
                label: 'Official Kimi Platform endpoint',
                description: `${PLATFORM_API_BASE_URL} · model default: kimi-k3`,
                baseUrl: PLATFORM_API_BASE_URL,
                defaultModel: 'kimi-k3',
            },
        ];
        if (customBaseUrl) {
            targets.push({
                label: 'Custom endpoint from KIMI_VIDEO_API_BASE_URL',
                description: customBaseUrl,
                baseUrl: deriveApiBaseUrl(customBaseUrl),
                defaultModel: configuredModel,
            });
        }

        const uniqueTargets = targets.filter(
            (target, index) => targets.findIndex((candidate) => candidate.baseUrl === target.baseUrl) === index,
        );
        return vscode.window.showQuickPick(uniqueTargets, {
            title: 'Kimi Video Context Probe Endpoint',
            placeHolder: 'Choose the API surface to test',
        });
    }

    private showFailure(message: string): void {
        this.outputChannel.appendLine(`RESULT: ${message}`);
        this.outputChannel.show(true);
        void vscode.window.showErrorMessage(message);
    }
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${bytes} B`;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
