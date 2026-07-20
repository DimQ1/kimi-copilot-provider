import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildKimiRequest, convertMessages, convertTools, extractTextContent, resolveReasoningEffort, formatThinkingAsText, tryReportThinkingPart, parseRetryAfterHeader, computeBackoffDelayMs } from '../provider';
import { MODELS, toChatInfo } from '../models';
import { applyServerModels } from '../models-client';
import type { KimiTool } from '../types';

suite('provider helpers', () => {
    suite('Kimi K3 model', () => {
        test('is registered with the K3 API contract', () => {
            const model = MODELS.find((item) => item.id === 'kimi-k3');
            assert.ok(model);
            assert.strictEqual(model.requestPolicy, 'k3');
            assert.strictEqual(model.maxInputTokens, 1048576);
            assert.strictEqual(model.maxOutputTokens, 32768);
            assert.strictEqual(model.capabilities.imageInput, true);
            assert.strictEqual(model.defaults?.reasoningEffort, 'max');
            assert.strictEqual(model.singleRequestLimit, 1048576);
            assert.deepStrictEqual(model.multiTierContext, { default: 1048576, allegretto: 1048576 });
        });

        test('builds a K3 request without K2-only parameters', () => {
            const request = buildKimiRequest({
                model: 'kimi-k3',
                messages: [{ role: 'user', content: 'hello' }],
                stream: true,
                requestPolicy: 'k3',
                maxTokens: 32768,
                temperature: 1,
                topP: 0.95,
                presencePenalty: 0,
                frequencyPenalty: 0,
                thinking: { type: 'enabled' },
            });

            assert.strictEqual(request.max_completion_tokens, 32768);
            assert.strictEqual(request.reasoning_effort, 'max');
            assert.strictEqual('max_tokens' in request, false);
            assert.strictEqual('thinking' in request, false);
            assert.strictEqual('temperature' in request, false);
            assert.strictEqual('top_p' in request, false);
            assert.strictEqual('presence_penalty' in request, false);
            assert.strictEqual('frequency_penalty' in request, false);
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

    suite('thinking / reasoning display', () => {
        test('formatThinkingAsText formats single-line reasoning', () => {
            const result = formatThinkingAsText('I need to analyze this carefully.');
            assert.ok(result.startsWith('> 💭 **Thinking**'));
            assert.ok(result.includes('> I need to analyze this carefully.'));
            assert.ok(result.includes('---'));
        });

        test('formatThinkingAsText formats multi-line reasoning', () => {
            const result = formatThinkingAsText('Line 1\nLine 2\nLine 3');
            assert.ok(result.startsWith('> 💭 **Thinking**'));
            assert.ok(result.includes('> Line 1'));
            assert.ok(result.includes('> Line 2'));
            assert.ok(result.includes('> Line 3'));
        });

        test('formatThinkingAsText trims trailing whitespace', () => {
            const result = formatThinkingAsText('  hello  ');
            assert.ok(result.includes('> hello'));
            assert.ok(!result.includes('  hello  '));
        });

        test('tryReportThinkingPart returns true and reports when constructor is available', () => {
            const reported: unknown[] = [];
            const fakeProgress = {
                report: (value: unknown) => { reported.push(value); },
            };

            // If LanguageModelThinkingPart exists in this test runtime, use it
            const result = tryReportThinkingPart(
                fakeProgress as vscode.Progress<vscode.LanguageModelResponsePart>,
                'test reasoning',
            );

            // In test env (which doesn't have proposals enabled), it falls back
            if ((vscode as any).LanguageModelThinkingPart) {
                assert.strictEqual(result, true);
                assert.strictEqual(reported.length, 1);
            } else {
                // Fallback expected — no report, function returns false
                assert.strictEqual(result, false);
                assert.strictEqual(reported.length, 0);
            }
        });

        test('buildKimiRequest for K2.x sends thinking when enabled', () => {
            const request = buildKimiRequest({
                model: 'kimi-k2.7-code',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
                requestPolicy: 'k2',
                maxTokens: 1024,
                temperature: 1.0,
                topP: 0.95,
                presencePenalty: 0,
                frequencyPenalty: 0,
                thinking: { type: 'enabled' },
            });

            assert.deepStrictEqual(request.thinking, { type: 'enabled' });
            assert.strictEqual('reasoning_effort' in request, false);
        });

        test('buildKimiRequest for K3 sends reasoning_effort, not thinking', () => {
            const request = buildKimiRequest({
                model: 'kimi-k3',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
                requestPolicy: 'k3',
                maxTokens: 1024,
                temperature: 1.0,
                topP: 0.95,
                presencePenalty: 0,
                frequencyPenalty: 0,
                thinking: { type: 'enabled' },
                reasoningEffort: 'high',
            });

            assert.strictEqual(request.reasoning_effort, 'high');
            assert.strictEqual('thinking' in request, false);
        });

        test('buildKimiRequest for K3 defaults reasoning_effort to max', () => {
            const request = buildKimiRequest({
                model: 'kimi-k3',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
                requestPolicy: 'k3',
                maxTokens: 1024,
                temperature: 1.0,
                topP: 0.95,
                presencePenalty: 0,
                frequencyPenalty: 0,
            });

            assert.strictEqual(request.reasoning_effort, 'max');
        });
    });

    suite('applyServerModels context limits', () => {
        test('server context_length becomes the source of truth', () => {
            const merged = applyServerModels(MODELS, [
                {
                    id: 'k3',
                    contextLength: 1048576,
                    supportsReasoning: true,
                    supportsImageIn: true,
                    supportsVideoIn: true,
                    supportsToolUse: true,
                },
            ]);
            const k3 = merged.find((m) => m.id === 'kimi-k3');
            assert.ok(k3);
            assert.strictEqual(k3.maxInputTokens, 1048576);
            assert.strictEqual(k3.serverContextLength, 1048576);
            // The per-request cap follows the context window (no fixed cap
            // below it) and is clamped by the server window when smaller.
            assert.strictEqual(k3.singleRequestLimit, 1048576);
            assert.deepStrictEqual(k3.multiTierContext, { default: 1048576, allegretto: 1048576 });
        });

        test('per-request cap shrinks with a smaller server window', () => {
            const merged = applyServerModels(MODELS, [
                {
                    id: 'k3',
                    contextLength: 131072,
                    supportsReasoning: true,
                    supportsImageIn: true,
                    supportsVideoIn: true,
                    supportsToolUse: true,
                },
            ]);
            const k3 = merged.find((m) => m.id === 'kimi-k3');
            assert.ok(k3);
            assert.strictEqual(k3.serverContextLength, 131072);
            assert.strictEqual(k3.singleRequestLimit, 131072);
        });

        test('models without a server entry keep hard-coded limits', () => {
            const merged = applyServerModels(MODELS, [
                {
                    id: 'kimi-for-coding',
                    contextLength: 262144,
                    supportsReasoning: true,
                    supportsImageIn: false,
                    supportsVideoIn: false,
                    supportsToolUse: true,
                },
            ]);
            const k3 = merged.find((m) => m.id === 'kimi-k3');
            assert.ok(k3);
            assert.strictEqual(k3.maxInputTokens, 1048576);
            assert.strictEqual(k3.serverContextLength, undefined);
            assert.strictEqual(k3.singleRequestLimit, 1048576);
        });

        test('server supports_thinking_type and default_effort are applied', () => {
            const merged = applyServerModels(MODELS, [
                {
                    id: 'k3',
                    contextLength: 1048576,
                    supportsReasoning: true,
                    supportsImageIn: true,
                    supportsVideoIn: true,
                    supportsToolUse: true,
                    supportsThinkingType: 'only',
                    supportEfforts: ['low', 'high', 'max'],
                    defaultEffort: 'high',
                },
            ]);
            const k3 = merged.find((m) => m.id === 'kimi-k3');
            assert.ok(k3);
            // Thinking cannot be disabled on this model.
            assert.strictEqual(k3.supportsThinkingType, 'only');
            // The server default_effort wins over the hard-coded 'max'.
            assert.strictEqual(k3.defaults?.reasoningEffort, 'high');
        });

        test('a default_effort outside valid_efforts is ignored', () => {
            const merged = applyServerModels(MODELS, [
                {
                    id: 'k3',
                    contextLength: 1048576,
                    supportsReasoning: true,
                    supportsImageIn: true,
                    supportsVideoIn: true,
                    supportsToolUse: true,
                    supportEfforts: ['low', 'high'],
                    defaultEffort: 'max',
                },
            ]);
            const k3 = merged.find((m) => m.id === 'kimi-k3');
            assert.ok(k3);
            // 'max' is not in valid_efforts → keep the hard-coded default.
            assert.strictEqual(k3.defaults?.reasoningEffort, 'max');
        });
    });

    suite('retry helpers', () => {
        suite('parseRetryAfterHeader', () => {
            test('parses delta-seconds', () => {
                assert.strictEqual(parseRetryAfterHeader('5'), 5000);
                assert.strictEqual(parseRetryAfterHeader(' 12 '), 12000);
                assert.strictEqual(parseRetryAfterHeader('0'), 0);
            });

            test('parses an HTTP-date', () => {
                const future = new Date(Date.now() + 3000).toUTCString();
                const parsed = parseRetryAfterHeader(future);
                assert.ok(parsed !== undefined);
                assert.ok(parsed >= 0 && parsed <= 3000);
            });

            test('clamps a past HTTP-date to zero', () => {
                const past = new Date(Date.now() - 60000).toUTCString();
                assert.strictEqual(parseRetryAfterHeader(past), 0);
            });

            test('returns undefined for absent or invalid values', () => {
                assert.strictEqual(parseRetryAfterHeader(null), undefined);
                assert.strictEqual(parseRetryAfterHeader(undefined), undefined);
                assert.strictEqual(parseRetryAfterHeader(''), undefined);
                assert.strictEqual(parseRetryAfterHeader('not-a-date'), undefined);
                assert.strictEqual(parseRetryAfterHeader('-3'), undefined);
            });
        });

        suite('computeBackoffDelayMs', () => {
            test('Retry-After wins over backoff', () => {
                const delay = computeBackoffDelayMs({
                    attempt: 3,
                    retryAfterMs: 10000,
                    baseDelayMs: 2000,
                    maxDelayMs: 60000,
                });
                assert.strictEqual(delay, 10000);
            });

            test('Retry-After is capped at 4x maxDelayMs', () => {
                const delay = computeBackoffDelayMs({
                    attempt: 1,
                    retryAfterMs: 10 * 60 * 1000,
                    baseDelayMs: 2000,
                    maxDelayMs: 60000,
                });
                assert.strictEqual(delay, 240000);
            });

            test('exponential backoff doubles per attempt (no jitter)', () => {
                const opts = { baseDelayMs: 2000, maxDelayMs: 60000, random: () => 0.5 };
                assert.strictEqual(computeBackoffDelayMs({ attempt: 1, ...opts }), 2000);
                assert.strictEqual(computeBackoffDelayMs({ attempt: 2, ...opts }), 4000);
                assert.strictEqual(computeBackoffDelayMs({ attempt: 3, ...opts }), 8000);
            });

            test('backoff is capped at maxDelayMs', () => {
                const delay = computeBackoffDelayMs({
                    attempt: 10,
                    baseDelayMs: 2000,
                    maxDelayMs: 60000,
                    random: () => 0.5,
                });
                assert.strictEqual(delay, 60000);
            });

            test('jitter stays within ±25% of the exponential value', () => {
                for (const rnd of [0, 0.999]) {
                    const delay = computeBackoffDelayMs({
                        attempt: 2,
                        baseDelayMs: 2000,
                        maxDelayMs: 60000,
                        random: () => rnd,
                    });
                    assert.ok(delay >= 4000 * 0.75 - 1, `lower bound: ${delay}`);
                    assert.ok(delay <= 4000 * 1.25 + 1, `upper bound: ${delay}`);
                }
            });
        });
    });
});
