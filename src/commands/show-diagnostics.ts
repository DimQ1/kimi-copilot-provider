import * as vscode from 'vscode';
import { BaseCommand } from './base';
import type { KimiChatProvider } from '../provider';

export class ShowDiagnosticsCommand extends BaseCommand {
    readonly id = 'kimi-copilot.showDiagnostics';

    constructor(
        private readonly provider: KimiChatProvider,
    ) {
        super();
    }

    async execute(): Promise<void> {
        const report = await this.provider.getDiagnosticsReport();
        const document = await vscode.workspace.openTextDocument({
            language: 'plaintext',
            content: report,
        });
        await vscode.window.showTextDocument(document, { preview: false });
    }
}
