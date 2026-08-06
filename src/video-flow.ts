import * as vscode from 'vscode';
import type { ConfigurationManager } from './config';
import { deriveApiBaseUrl, VIDEO_FILE_EXTENSIONS } from './video-client';

export interface VideoQuestion {
    videoPath: string;
    question: string;
}

export interface VideoApiConfiguration {
    apiKey: string;
    baseUrl: string;
    model: string;
}

export async function pickVideoQuestion(initialQuestion = ''): Promise<VideoQuestion | undefined> {
    const videoUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Analyze Video',
        filters: {
            Video: VIDEO_FILE_EXTENSIONS,
        },
    });
    if (!videoUris || videoUris.length === 0) return undefined;

    const question = initialQuestion.trim() || await vscode.window.showInputBox({
        title: 'Ask Kimi About This Video',
        prompt: 'What should Kimi analyze or answer about the video?',
        placeHolder: 'For example: What happens between 00:10 and 00:20?',
        validateInput: (value) => (value.trim().length > 0 ? undefined : 'A question is required.'),
    });
    if (!question?.trim()) return undefined;

    return {
        videoPath: videoUris[0].fsPath,
        question: question.trim(),
    };
}

export async function getVideoApiConfiguration(
    configManager: ConfigurationManager,
): Promise<VideoApiConfiguration | undefined> {
    const apiKey = getEnvironmentApiKey() ?? (await configManager.getApiKey());
    if (!apiKey) return undefined;

    return {
        apiKey,
        baseUrl: deriveApiBaseUrl(configManager.getEndpoint()),
        model: configManager.getApiModelId(configManager.getModel()),
    };
}

function getEnvironmentApiKey(): string | undefined {
    for (const name of ['KIMI_API_KEY', 'MOONSHOT_API_KEY']) {
        const value = process.env[name]?.trim();
        if (value) return value;
    }
    return undefined;
}
