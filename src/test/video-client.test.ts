import * as assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
    buildVideoContextRequest,
    deriveApiBaseUrl,
    KimiVideoClient,
} from '../video-client';

suite('video client', () => {
    test('builds the Kimi video context payload', () => {
        assert.deepStrictEqual(buildVideoContextRequest('kimi-for-coding', 'file-123', 'What happens here?'), {
            model: 'kimi-for-coding',
            stream: false,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'video_url',
                            video_url: { url: 'ms://file-123' },
                        },
                        {
                            type: 'text',
                            text: 'What happens here?',
                        },
                    ],
                },
            ],
        });
    });

    test('derives the Files API base from a chat endpoint', () => {
        assert.strictEqual(
            deriveApiBaseUrl('https://api.kimi.com/coding/v1/chat/completions'),
            'https://api.kimi.com/coding/v1',
        );
    });

    test('keeps an API base that does not include chat completions', () => {
        assert.strictEqual(
            deriveApiBaseUrl('https://api.moonshot.ai/v1/'),
            'https://api.moonshot.ai/v1',
        );
    });

    test('uploads, analyzes, and tolerates an already-removed temporary file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'kimi-video-'));
        const videoPath = join(directory, 'sample.mp4');
        await writeFile(videoPath, Buffer.from([0, 1, 2]));

        const originalFetch = globalThis.fetch;
        const requests: Array<{ url: string; method: string; body?: string }> = [];
        let responseNumber = 0;
        globalThis.fetch = async (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            const method = init?.method ?? 'GET';
            const body = typeof init?.body === 'string' ? init.body : undefined;
            requests.push({ url, method, body });
            responseNumber += 1;

            if (responseNumber === 1) {
                return new Response(JSON.stringify({ id: 'file-123', status: 'ready' }), { status: 200 });
            }
            if (responseNumber === 2) {
                return new Response(
                    JSON.stringify({ choices: [{ message: { content: 'The answer from the video.' } }] }),
                    { status: 200 },
                );
            }
            return new Response(JSON.stringify({ error: { message: 'already gone' } }), { status: 404 });
        };

        const cancellationSource = new vscode.CancellationTokenSource();
        try {
            const result = await new KimiVideoClient('https://example.test/v1').analyze({
                apiKey: 'test-key',
                videoPath,
                model: 'kimi-for-coding',
                question: 'What happens?',
                cancellationToken: cancellationSource.token,
            });

            assert.strictEqual(result.answer, 'The answer from the video.');
            assert.deepStrictEqual(
                requests.map(({ method, url }) => ({ method, url })),
                [
                    { method: 'POST', url: 'https://example.test/v1/files' },
                    { method: 'POST', url: 'https://example.test/v1/chat/completions' },
                    { method: 'DELETE', url: 'https://example.test/v1/files/file-123' },
                ],
            );
            assert.strictEqual(requests[1].body && JSON.parse(requests[1].body).messages[0].content[1].text, 'What happens?');
        } finally {
            cancellationSource.dispose();
            globalThis.fetch = originalFetch;
            await rm(directory, { recursive: true, force: true });
        }
    });
});
