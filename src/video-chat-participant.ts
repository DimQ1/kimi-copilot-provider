import * as vscode from 'vscode';
import type { ConfigurationManager } from './config';
import {
    KimiVideoClient,
    VideoClientCancelledError,
    VideoClientError,
} from './video-client';
import { getVideoApiConfiguration, pickVideoQuestion } from './video-flow';

export const VIDEO_CHAT_PARTICIPANT_ID = 'kimi-copilot.video';

export function registerVideoChatParticipant(
    context: vscode.ExtensionContext,
    configManager: ConfigurationManager,
): void {
    if (!vscode.chat) return;

    const participant = vscode.chat.createChatParticipant(
        VIDEO_CHAT_PARTICIPANT_ID,
        async (request, _chatContext, response, cancellationToken) => {
            const selection = await pickVideoQuestion(request.prompt);
            if (!selection) return;

            const api = await getVideoApiConfiguration(configManager);
            if (!api) {
                response.markdown(
                    'Kimi API key is not configured. Run **Kimi Copilot: Set API Key** and try `@kimi /video` again.',
                );
                return;
            }

            try {
                const result = await new KimiVideoClient(api.baseUrl).analyze({
                    apiKey: api.apiKey,
                    videoPath: selection.videoPath,
                    model: api.model,
                    question: selection.question,
                    cancellationToken,
                    onProgress: (message) => response.progress(message),
                });
                response.markdown(result.answer);
                return {
                    metadata: {
                        source: 'kimi-video',
                        fileName: result.fileName,
                    },
                };
            } catch (error) {
                if (error instanceof VideoClientCancelledError) {
                    response.progress('Video analysis cancelled.');
                    return;
                }
                const message = error instanceof VideoClientError ? error.message : String(error);
                response.markdown(`I could not analyze the video: ${message}`);
                return {
                    errorDetails: { message },
                };
            }
        },
    );
    participant.iconPath = new vscode.ThemeIcon('device-camera-video');
    context.subscriptions.push(participant);
}
