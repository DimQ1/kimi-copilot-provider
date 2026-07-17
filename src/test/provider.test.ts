import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildKimiRequest, convertMessages, convertTools, extractTextContent } from '../provider';
import { MODELS } from '../models';
import type { KimiTool } from '../types';

suite('provider helpers', () => {
    suite('Kimi K3 model', () => {
        test('is registered with the K3 API contract', () => {
            const model = MODELS.find((item) => item.id === 'kimi-k3');
            assert.ok(model);
            assert.strictEqual(model.requestPolicy, 'k3');
            assert.strictEqual(model.maxInputTokens, 262144);
            assert.strictEqual(model.maxOutputTokens, 131072);
            assert.strictEqual(model.capabilities.imageInput, true);
            assert.strictEqual(model.defaults?.reasoningEffort, 'max');
        });

        test('builds a K3 request without K2-only parameters', () => {
            const request = buildKimiRequest({
                model: 'kimi-k3',
                messages: [{ role: 'user', content: 'hello' }],
                stream: true,
                requestPolicy: 'k3',
                maxTokens: 131072,
                temperature: 1,
                topP: 0.95,
                presencePenalty: 0,
                frequencyPenalty: 0,
                thinking: { type: 'enabled' },
            });

            assert.strictEqual(request.max_completion_tokens, 131072);
            assert.strictEqual(request.reasoning_effort, 'max');
            assert.strictEqual('max_tokens' in request, false);
            assert.strictEqual('thinking' in request, false);
            assert.strictEqual('temperature' in request, false);
            assert.strictEqual('top_p' in request, false);
            assert.strictEqual('presence_penalty' in request, false);
            assert.strictEqual('frequency_penalty' in request, false);
        });
    });

    suite('convertMessages', () => {
        test('converts a single user message', () => {
            const messages = [vscode.LanguageModelChatMessage.User('hello')];
            const result = convertMessages(messages);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].role, 'user');
            assert.strictEqual(result[0].content, 'hello');
        });

        test('converts an assistant message with tool calls', () => {
            const messages = [
                vscode.LanguageModelChatMessage.Assistant([
                    new vscode.LanguageModelTextPart('Thinking...'),
                    new vscode.LanguageModelToolCallPart('call-1', 'getWeather', { city: 'Paris' }),
                ]),
            ];

            const result = convertMessages(messages);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].role, 'assistant');
            assert.strictEqual(result[0].content, 'Thinking...');
            assert.deepStrictEqual(result[0].tool_calls, [
                {
                    id: 'call-1',
                    type: 'function',
                    function: {
                        name: 'getWeather',
                        arguments: JSON.stringify({ city: 'Paris' }),
                    },
                },
            ]);
        });

        test('converts tool result parts', () => {
            const messages = [
                vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelToolResultPart('call-1', [
                        new vscode.LanguageModelTextPart('Sunny'),
                    ]),
                ]),
            ];

            const result = convertMessages(messages);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].role, 'tool');
            assert.strictEqual(result[0].content, 'Sunny');
            assert.strictEqual(result[0].tool_call_id, 'call-1');
        });

        test('converts image data parts to Kimi vision content', () => {
            const messages = [
                vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelTextPart('What is this?'),
                    new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
                ]),
            ];

            const result = convertMessages(messages);
            assert.deepStrictEqual(result[0].content, [
                { type: 'text', text: 'What is this?' },
                {
                    type: 'image_url',
                    image_url: { url: 'data:image/png;base64,AQID' },
                },
            ]);
        });
    });

    suite('convertTools', () => {
        test('returns undefined when tool calling is disabled', () => {
            const result = convertTools(false, [
                { name: 'tool1', description: 'desc', inputSchema: {} },
            ] as vscode.LanguageModelChatTool[]);
            assert.strictEqual(result, undefined);
        });

        test('returns undefined for empty tools', () => {
            const result = convertTools(true, []);
            assert.strictEqual(result, undefined);
        });

        test('converts tools to Kimi format', () => {
            const schema = { type: 'object', properties: {} };
            const tools = [
                { name: 'tool1', description: 'first tool', inputSchema: schema },
            ] as vscode.LanguageModelChatTool[];
            const result = convertTools(true, tools);

            const expected: KimiTool[] = [
                {
                    type: 'function',
                    function: {
                        name: 'tool1',
                        description: 'first tool',
                        parameters: schema,
                    },
                },
            ];
            assert.deepStrictEqual(result, expected);
        });
    });

    suite('extractTextContent', () => {
        test('extracts text from string message', () => {
            const msg = vscode.LanguageModelChatMessage.User('hello world');
            assert.strictEqual(extractTextContent(msg), 'hello world');
        });

        test('returns empty string for empty content', () => {
            const msg = vscode.LanguageModelChatMessage.User([]);
            assert.strictEqual(extractTextContent(msg), '');
        });
    });
});
