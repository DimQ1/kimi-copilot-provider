import { basename } from 'node:path';
import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { ConfigurationManager } from '../config';
import {
    KimiVideoClient,
    VideoClientCancelledError,
    VideoClientError,
} from '../video-client';
import { getVideoApiConfiguration, pickVideoQuestion } from '../video-flow';

export class AskAboutVideoCommand extends BaseCommand {
    readonly id = 'kimi-copilot.askAboutVideo';

    private readonly outputChannel = vscode.window.createOutputChannel('Kimi Video Answers');

    constructor(private readonly configManager: ConfigurationManager) {
        super();
    }

    override register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(this.outputChannel);
        super.register(context);
    }

    async execute(): Promise<void> {
        const selection = await pickVideoQuestion();
        if (!selection) return;

        const api = await getVideoApiConfiguration(this.configManager);
        if (!api) {
            void vscode.window.showErrorMessage(
                'Kimi API key is not configured. Run Kimi Copilot: Set API Key first.',
            );
            return;
        }

        this.outputChannel.clear();
        this.outputChannel.appendLine(`Video: ${basename(selection.videoPath)}`);
        this.outputChannel.appendLine(`Question: ${selection.question}`);
        this.outputChannel.appendLine('');
        this.outputChannel.show(true);

        try {
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Kimi video analysis',
                    cancellable: true,
                },
                async (progress, cancellationToken) => new KimiVideoClient(api.baseUrl).analyze({
                    apiKey: api.apiKey,
                    videoPath: selection.videoPath,
                    model: api.model,
                    question: selection.question,
                    cancellationToken,
                    onProgress: (message) => progress.report({ message }),
                }),
            );

            this.outputChannel.appendLine(result.answer);
            this.outputChannel.show(true);
            const action = await vscode.window.showInformationMessage(
                'Kimi answered the video question. The answer is ready in Kimi Video Answers.',
                'Copy Answer',
            );
            if (action === 'Copy Answer') {
                await vscode.env.clipboard.writeText(result.answer);
                void vscode.window.showInformationMessage('Video answer copied to the clipboard.');
            }
        } catch (error) {
            if (error instanceof VideoClientCancelledError) {
                void vscode.window.showWarningMessage('Kimi video analysis was cancelled.');
                return;
            }
            const message = error instanceof VideoClientError ? error.message : String(error);
            this.outputChannel.appendLine(`Analysis failed: ${message}`);
            this.outputChannel.show(true);
            void vscode.window.showErrorMessage(`Kimi video analysis failed: ${message}`);
        }
    }
}
