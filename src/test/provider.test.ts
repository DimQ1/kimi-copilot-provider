import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildKimiRequest, convertMessages, convertTools, extractTextContent, resolveReasoningEffort } from '../provider';
import { MODELS, toChatInfo } from '../models';
import type { KimiTool } from '../types';

suite('provider helpers', () => {
    suite('Kimi K3 model', () => {
        test('is registered with the K3 API contract', () => {
            const model = MODELS.find((item) => item.id === 'kimi-k3');
            assert.ok(model);
            assert.strictEqual(model.requestPolicy, 'k3');
            assert.strictEqual(model.maxInputTokens, 1048576);
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

        test('uses reasoning effort from Copilot Chat UI options', () => {
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
                reasoningEffort: resolveReasoningEffort({ reasoning_effort: 'high' }, undefined, {}),
            });

            assert.strictEqual(request.reasoning_effort, 'high');
        });

        test('maps UI reasoning effort values to Kimi values', () => {
            assert.strictEqual(resolveReasoningEffort({ reasoning_effort: 'none' }, undefined, {}), 'low');
            assert.strictEqual(resolveReasoningEffort({ reasoning_effort: 'low' }, undefined, {}), 'low');
            assert.strictEqual(resolveReasoningEffort({ reasoning_effort: 'medium' }, undefined, {}), 'high');
            assert.strictEqual(resolveReasoningEffort({ reasoning_effort: 'high' }, undefined, {}), 'high');
            assert.strictEqual(resolveReasoningEffort({ reasoning_effort: 'max' }, undefined, {}), 'max');
            assert.strictEqual(resolveReasoningEffort({ reasoning_effort: 'ultra' }, undefined, {}), 'max');
            assert.strictEqual(resolveReasoningEffort(undefined, { reasoningEffort: 'high' }, {}), 'high');
            assert.strictEqual(resolveReasoningEffort(undefined, undefined, { reasoningEffort: 'low' }), 'low');
            assert.strictEqual(resolveReasoningEffort(undefined, undefined, {}), 'max');
        });

        test('exposes configurationSchema for Thinking Effort on K3', () => {
            const info = toChatInfo(MODELS.find((m) => m.id === 'kimi-k3')!, true);
            const schema = (info as unknown as { configurationSchema?: { properties?: { reasoningEffort?: { enum: string[] } } } }).configurationSchema;
            assert.ok(schema);
            assert.deepStrictEqual(schema!.properties!.reasoningEffort!.enum, ['low', 'high', 'max']);
        });

        test('does not expose configurationSchema for non-reasoning models', () => {
            const info = toChatInfo(MODELS.find((m) => m.id === 'kimi-k2.7-code')!, true);
            const schema = (info as unknown as { configurationSchema?: unknown }).configurationSchema;
            assert.strictEqual(schema, undefined);
        });

        test('exposes pricing metadata for K3', () => {
            const info = toChatInfo(MODELS.find((m) => m.id === 'kimi-k3')!, true);
            assert.strictEqual(info.inputCost, '$3.00');
            assert.strictEqual(info.outputCost, '$15.00');
            assert.strictEqual(info.cacheCost, '$0.30');
            assert.strictEqual(info.priceCategory, 'medium');
        });

        test('exposes pricing metadata for K2.7 Code', () => {
            const info = toChatInfo(MODELS.find((m) => m.id === 'kimi-k2.7-code')!, true);
            assert.strictEqual(info.inputCost, '$0.95');
            assert.strictEqual(info.outputCost, '$4.00');
            assert.strictEqual(info.cacheCost, '$0.19');
            assert.strictEqual(info.priceCategory, 'low');
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
