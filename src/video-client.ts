import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import * as vscode from 'vscode';

const REQUEST_TIMEOUT_MS = 180_000;
const FILE_READY_TIMEOUT_MS = 120_000;
const FILE_POLL_INTERVAL_MS = 1_000;

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export const VIDEO_MIME_TYPES: Readonly<Record<string, string>> = {
    '.3gp': 'video/3gpp',
    '.avi': 'video/x-msvideo',
    '.flv': 'video/x-flv',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.webm': 'video/webm',
    '.wmv': 'video/x-ms-wmv',
};

export const VIDEO_FILE_EXTENSIONS = Object.keys(VIDEO_MIME_TYPES).map((extension) => extension.slice(1));

export interface VideoFileInfo {
    fileName: string;
    size: number;
    mimeType: string;
}

export interface VideoAnalysisOptions {
    apiKey: string;
    videoPath: string;
    model: string;
    question: string;
    cancellationToken: vscode.CancellationToken;
    onProgress?: (message: string) => void;
}

export interface VideoAnalysisResult extends VideoFileInfo {
    answer: string;
}

export class VideoClientError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'VideoClientError';
    }
}

export class VideoClientCancelledError extends VideoClientError {
    constructor(message = 'Video analysis was cancelled.') {
        super(message);
        this.name = 'VideoClientCancelledError';
    }
}

interface VideoFile {
    id: string;
    status?: string;
    statusDetails?: string;
}

export class KimiVideoClient {
    private readonly baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = deriveApiBaseUrl(baseUrl);
    }

    async analyze(options: VideoAnalysisOptions): Promise<VideoAnalysisResult> {
        const fileInfo = await inspectVideoFile(options.videoPath);
        const question = options.question.trim();
        if (!question) {
            throw new VideoClientError('A question about the video is required.');
        }

        let uploadedFileId: string | undefined;
        try {
            options.onProgress?.(`Uploading ${fileInfo.fileName}...`);
            const videoData = await readFile(options.videoPath);
            const uploaded = await uploadVideo(
                this.baseUrl,
                options.apiKey,
                fileInfo.fileName,
                fileInfo.mimeType,
                videoData,
                options.cancellationToken,
            );
            uploadedFileId = uploaded.id;

            options.onProgress?.('Waiting for Kimi to process the video...');
            const readyFile = await waitForVideoReady(
                this.baseUrl,
                options.apiKey,
                uploaded,
                options.cancellationToken,
                (status) => options.onProgress?.(`Video status: ${status}`),
            );
            options.onProgress?.(`Video is ready (${readyFile.status ?? 'ready'}).`);

            options.onProgress?.('Asking Kimi about the video...');
            const answer = await sendVideoContextRequest(
                this.baseUrl,
                options.apiKey,
                options.model,
                uploadedFileId,
                question,
                options.cancellationToken,
            );
            return { ...fileInfo, answer };
        } finally {
            if (uploadedFileId) {
                options.onProgress?.('Removing the temporary remote video...');
                try {
                    await deleteVideo(this.baseUrl, options.apiKey, uploadedFileId, options.cancellationToken);
                } catch (error) {
                    if (!(error instanceof VideoClientError && error.status === 404)) {
                        options.onProgress?.(`Temporary video cleanup failed: ${formatError(error)}`);
                    }
                }
            }
        }
    }
}

export async function inspectVideoFile(videoPath: string): Promise<VideoFileInfo> {
    const fileName = basename(videoPath);
    const extension = extname(videoPath).toLowerCase();
    const mimeType = VIDEO_MIME_TYPES[extension];
    if (!mimeType) {
        throw new VideoClientError(`Unsupported video extension "${extension || '(none)'}".`);
    }

    let size: number;
    try {
        size = (await stat(videoPath)).size;
    } catch (error) {
        throw new VideoClientError(`Cannot read video metadata: ${formatError(error)}`);
    }
    if (size > MAX_VIDEO_BYTES) {
        throw new VideoClientError(
            `Video is ${formatBytes(size)}; Kimi Files API accepts files up to ${formatBytes(MAX_VIDEO_BYTES)}.`,
        );
    }

    return { fileName, size, mimeType };
}

export function deriveApiBaseUrl(endpoint: string): string {
    const normalized = endpoint.trim().replace(/\/+$/, '');
    const baseUrl = normalized.endsWith('/chat/completions')
        ? normalized.slice(0, -'/chat/completions'.length)
        : normalized;
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new Error('only HTTP(S) URLs are supported');
        }
    } catch (error) {
        throw new VideoClientError(`Invalid video API base URL: ${formatError(error)}`);
    }
    return baseUrl;
}

export function buildVideoContextRequest(model: string, fileId: string, question: string): Record<string, unknown> {
    return {
        model,
        stream: false,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'video_url',
                        video_url: { url: `ms://${fileId}` },
                    },
                    {
                        type: 'text',
                        text: question,
                    },
                ],
            },
        ],
    };
}

async function uploadVideo(
    baseUrl: string,
    apiKey: string,
    fileName: string,
    mimeType: string,
    videoData: Uint8Array,
    cancellationToken: vscode.CancellationToken,
): Promise<VideoFile> {
    const form = new FormData();
    form.append('purpose', 'video');
    const blobBuffer = new ArrayBuffer(videoData.byteLength);
    new Uint8Array(blobBuffer).set(videoData);
    form.append('file', new Blob([blobBuffer], { type: mimeType }), fileName);
    const payload = await requestJson(
        `${baseUrl}/files`,
        apiKey,
        {
            method: 'POST',
            body: form,
        },
        cancellationToken,
    );
    const file = parseVideoFile(payload);
    if (!file) {
        throw new VideoClientError('Kimi upload response did not contain a file id.');
    }
    return file;
}

async function waitForVideoReady(
    baseUrl: string,
    apiKey: string,
    uploadedFile: VideoFile,
    cancellationToken: vscode.CancellationToken,
    reportStatus: (status: string) => void,
): Promise<VideoFile> {
    const deadline = Date.now() + FILE_READY_TIMEOUT_MS;
    let current = uploadedFile;
    while (true) {
        const status = current.status?.toLowerCase();
        if (!status || isReadyStatus(status)) return current;
        if (isFailedStatus(status)) {
            throw new VideoClientError(
                `Kimi marked the video as ${current.status}${current.statusDetails ? `: ${current.statusDetails}` : ''}.`,
            );
        }
        if (Date.now() >= deadline) {
            throw new VideoClientError(`Timed out waiting for video ${current.id} to become ready.`);
        }
        reportStatus(current.status ?? 'processing');
        await sleepWithCancellation(FILE_POLL_INTERVAL_MS, cancellationToken);
        const payload = await requestJson(
            `${baseUrl}/files/${encodeURIComponent(current.id)}`,
            apiKey,
            { method: 'GET' },
            cancellationToken,
        );
        current = parseVideoFile(payload) ?? current;
    }
}

async function sendVideoContextRequest(
    baseUrl: string,
    apiKey: string,
    model: string,
    fileId: string,
    question: string,
    cancellationToken: vscode.CancellationToken,
): Promise<string> {
    const payload = await requestJson(
        `${baseUrl}/chat/completions`,
        apiKey,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildVideoContextRequest(model, fileId, question)),
        },
        cancellationToken,
    );
    const answer = extractAssistantText(payload);
    if (!answer) {
        throw new VideoClientError('Kimi returned no assistant text for the video context request.');
    }
    return answer;
}

async function deleteVideo(
    baseUrl: string,
    apiKey: string,
    fileId: string,
    cancellationToken: vscode.CancellationToken,
): Promise<void> {
    await requestJson(
        `${baseUrl}/files/${encodeURIComponent(fileId)}`,
        apiKey,
        {
            method: 'DELETE',
        },
        cancellationToken,
    );
}

async function requestJson(
    url: string,
    apiKey: string,
    init: RequestInit,
    cancellationToken: vscode.CancellationToken,
): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const cancellation = cancellationToken.onCancellationRequested(() => controller.abort());
    try {
        if (cancellationToken.isCancellationRequested) {
            throw new VideoClientCancelledError();
        }
        const response = await fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                ...init.headers,
            },
            signal: controller.signal,
        });
        const text = await response.text();
        const payload = parseJson(text);
        if (!response.ok) {
            const method = init.method ?? 'GET';
            throw new VideoClientError(
                `${method} ${url} returned HTTP ${response.status}: ${extractErrorMessage(payload, text)}`,
                response.status,
            );
        }
        return payload;
    } catch (error) {
        if (cancellationToken.isCancellationRequested) {
            throw new VideoClientCancelledError();
        }
        if (timedOut) {
            throw new VideoClientError(`${init.method ?? 'GET'} ${url} timed out after ${REQUEST_TIMEOUT_MS} ms.`);
        }
        if (error instanceof TypeError) {
            throw new VideoClientError(`${init.method ?? 'GET'} ${url} failed: ${error.message}`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        cancellation.dispose();
    }
}

function parseVideoFile(payload: unknown): VideoFile | undefined {
    if (!isRecord(payload) || typeof payload.id !== 'string' || payload.id.trim().length === 0) {
        return undefined;
    }
    return {
        id: payload.id,
        status: typeof payload.status === 'string' ? payload.status : undefined,
        statusDetails: typeof payload.status_details === 'string' ? payload.status_details : undefined,
    };
}

function extractAssistantText(payload: unknown): string {
    if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
        return '';
    }
    const firstChoice = payload.choices[0];
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return '';
    const content = firstChoice.message.content;
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
        .filter(isRecord)
        .filter((part) => typeof part.text === 'string')
        .map((part) => String(part.text))
        .join('\n')
        .trim();
}

function extractErrorMessage(payload: unknown, fallback: string): string {
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
        return payload.error.message;
    }
    return fallback.slice(0, 500) || 'empty response';
}

function parseJson(text: string): unknown {
    if (!text) return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

function isReadyStatus(status: string): boolean {
    return ['ready', 'ok', 'completed', 'processed', 'success'].includes(status);
}

function isFailedStatus(status: string): boolean {
    return ['failed', 'error', 'cancelled', 'canceled'].includes(status);
}

async function sleepWithCancellation(milliseconds: number, cancellationToken: vscode.CancellationToken): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cancellation.dispose();
            resolve();
        }, milliseconds);
        const cancellation = cancellationToken.onCancellationRequested(() => {
            clearTimeout(timeout);
            cancellation.dispose();
            reject(new VideoClientCancelledError());
        });
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${bytes} B`;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
