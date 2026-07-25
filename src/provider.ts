import * as vscode from 'vscode';
import OpenAI from 'openai';
import { KimiApiClient, type ChatResult } from './api-client';
import { ConfigurationManager } from './config';
import { SessionContextTracker, formatBytes } from './context-tracker';
import { MODELS, toChatInfo } from './models';
import { fetchKimiModels } from './models-client';
import { KimiRequestBuilder } from './request-builder';
import { getRequestPolicy, detectRequestPolicy } from './request-policy';
import { transliterateMessages } from './transliterate';
import { UsageTracker, hasUsage } from './usage';
import { ModelRegistry } from './model-registry';
import { ReasoningKeyDialect } from './reasoning-key';
import { normalizeToolCallIds } from './tool-call-id';
import { normalizeKimiToolSchema } from './kimi-schema';
import type { KimiContentPart, KimiMessage, KimiTool, KimiToolCall, KimiStreamChunk, ModelDefaults, ModelConfigOverride } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_MODELS_ENDPOINT = 'https://api.kimi.com/coding/v1/models';

/**
 * Appended to the system prompt when the transliterate optimizer is on.
 * When the user enabled transliteration, the request is sent transliterated
 * to Latin — so the reply must always be in proper Russian (Cyrillic), never
 * mirrored transliteration. Appended as a strong, explicit instruction.
 */
const TRANSLITERATE_REPLY_INSTRUCTION =
    'CRITICAL LANGUAGE RULE: reply on russian language. The user has enabled Cyrillic transliteration for their messages, so you will receive Russian text written in Latin (transliterated) characters. Regardless of this, you MUST always write your entire reply in proper Russian using Cyrillic characters. NEVER answer in transliterated (Latin) Russian — always respond in correct Cyrillic Russian.';

// ═══════════════════════════════════════════════════════════════════════
// Provider class — implements the non-generic LanguageModelChatProvider
// ═══════════════════════════════════════════════════════════════════════

export class KimiChatProvider implements vscode.LanguageModelChatProvider {

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

    private readonly outputChannel: vscode.LogOutputChannel;
    private readonly disposables: vscode.Disposable[] = [];
    /** Guards against repeatedly triggering compaction within one session. */
    private autoCompactTriggered = false;

    constructor(
        private readonly configManager: ConfigurationManager,
        private readonly usageTracker: UsageTracker,
        private readonly modelRegistry: ModelRegistry,
    ) {
        this.outputChannel = vscode.window.createOutputChannel('Kimi Copilot', { log: true });

        // Watch for API key / config changes and refresh the model picker.
        this.disposables.push(
            configManager.onDidChange(() => {
                this.outputChannel.info('Configuration changed, refreshing model picker');
                this._onDidChange.fire();
            }),
        );
    }

    /** Force Copilot Chat to re-query model information. */
    refreshModelPicker(): void {
        this._onDidChange.fire();
    }

    /** Applies the cached server catalog (survives restarts) to the registry. */
    applyCachedServerModels(): void {
        this.modelRegistry.applyServerCatalog(this.configManager.getServerModels());
    }

    /**
     * Fetches GET /models with the API key and layers the returned
     * per-subscription parameters over the hard-coded registry. On success
     * the catalog is cached and the picker is refreshed; on any failure the
     * hard-coded/cached values stay in effect. Safe to fire-and-forget.
     */
    async refreshModelsFromServer(): Promise<void> {
        const apiKey = await this.configManager.getApiKey();
        if (!apiKey) {
            this.outputChannel.info('Skipping /models refresh: API key not set');
            return;
        }
        const endpoint = this.deriveModelsEndpoint();
        const result = await fetchKimiModels(apiKey, endpoint, this.configManager.getTimeout());
        if (result.kind !== 'ok') {
            this.outputChannel.warn(
                `Failed to refresh model catalog from ${endpoint}: ${result.message}`,
            );
            return;
        }
        this.modelRegistry.applyServerCatalog(result.models);
        await this.configManager.setServerModels([...result.models]);
        this.outputChannel.info(
            `Model catalog refreshed from server (${result.models.length} models): ` +
            result.models.map((m) => `${m.id} ctx=${m.contextLength}`).join(', '),
        );
        this._onDidChange.fire();
    }

    /** Derives the /models endpoint from the configured chat endpoint. */
    private deriveModelsEndpoint(): string {
        const endpoint = this.configManager.getEndpoint();
        if (endpoint.endsWith('/chat/completions')) {
            return endpoint.slice(0, -'/chat/completions'.length) + '/models';
        }
        return DEFAULT_MODELS_ENDPOINT;
    }

    // ── Model information ──────────────────────────────────────────

    async provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelChatInformation[]> {
        // Always return models — the `silent` flag means "don't prompt for credentials",
        // not "don't report models". The official sample ignores it entirely.
        const hasApiKey = !!(await this.configManager.getApiKey());
        return this.modelRegistry.getAll().map((model) => toChatInfo(model, hasApiKey, this.configManager.getModelConfig(model.id)));
    }

    // ── Chat response ──────────────────────────────────────────────

    async provideLanguageModelChatResponse(
        modelInfo: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        await this.doChatRequest(modelInfo, messages, options, progress, token);
    }

    /**
     * Sends a lightweight completion request to verify connectivity and credentials.
     * This is exposed for the "Test Connection" command.
     */
    async testConnection(modelId?: string, token?: vscode.CancellationToken): Promise<void> {
        const targetModel = modelId ?? this.configManager.getModel();
        const modelInfo = MODELS.find((m) => m.id === targetModel);
        if (!modelInfo) {
            throw new vscode.LanguageModelError(`Unknown model: ${targetModel}`);
        }

        const fakeProgress: vscode.Progress<vscode.LanguageModelResponsePart> = {
            report: () => { /* no-op */ },
        };

        await this.doChatRequest(
            toChatInfo(modelInfo, true, this.configManager.getModelConfig(modelInfo.id)),
            [vscode.LanguageModelChatMessage.User('ping')],
            { toolMode: vscode.LanguageModelChatToolMode.Auto },
            fakeProgress,
            token ?? new vscode.CancellationTokenSource().token,
            { testMode: true },
        );
    }

    private async doChatRequest(
        modelInfo: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        extras?: { testMode?: boolean },
    ): Promise<void> {
        const apiKey = await this.configManager.getApiKey();
        if (!apiKey) {
            throw new vscode.LanguageModelError(
                'Kimi API key is not configured. Run "Kimi Copilot: Set API Key".',
            );
        }

        const modelName = this.configManager.getApiModelId(modelInfo.id);
        const modelConfig = this.configManager.getModelConfig(modelInfo.id);
        const modelDefaults = this.modelRegistry.getDefaults(modelInfo.id);
        const modelDefinition = this.modelRegistry.findById(modelInfo.id);
        const requestPolicy = detectRequestPolicy(
            modelName,
            modelDefinition?.requestPolicy ?? modelDefaults?.requestPolicy,
        );

        // ── Resolve thinking (with supports_thinking_type guard) ────
        let thinking =
            modelConfig.thinking ??
            this.configManager.getThinking(modelInfo.id) ??
            modelDefaults?.thinking;
        if (thinking?.type === 'disabled' && modelDefinition?.supportsThinkingType === 'only') {
            this.outputChannel.warn(
                `Model ${modelInfo.id} does not support disabling thinking (supports_thinking_type: "only"); ignoring the override.`,
            );
            thinking = { type: 'enabled' };
        }

        const reasoningEffort = resolveReasoningEffortFromOptions(options, modelDefaults, modelConfig);

        const maxTokensSetting = this.configManager.getMaxTokens(modelInfo.id);
        const maxOutputTokens = modelConfig.maxOutputTokens ?? this.modelRegistry.getMaxOutputTokens(modelInfo.id);
        let maxTokens = maxTokensSetting > 0
            ? Math.min(maxTokensSetting, 1048576)
            : maxOutputTokens;

        const enableStreaming = extras?.testMode ? false : this.configManager.getEnableStreaming();
        const transliterate = this.configManager.getTransliterate(modelInfo.id);
        let systemPrompt = this.configManager.getSystemPrompt(modelInfo.id);
        if (transliterate) {
            const replyInstruction =
                this.configManager.getTransliterateSystemPrompt(modelInfo.id) ??
                TRANSLITERATE_REPLY_INSTRUCTION;
            systemPrompt = `${systemPrompt}\n\n${replyInstruction}`;
        }

        const capabilities = this.modelRegistry.getCapabilities(modelInfo.id);
        const toolCallingEnabled = modelConfig.toolCalling ?? capabilities?.toolCalling ?? false;

        // ── Convert messages ────────────────────────────────────────
        const allMessages = convertMessages(messages);
        if (!allMessages.some((m) => m.role === 'system')) {
            allMessages.unshift({ role: 'system', content: systemPrompt });
        }

        if (transliterate) {
            const changed = transliterateMessages(allMessages);
            if (changed > 0) {
                this.outputChannel.info(`Transliterate: converted Cyrillic content in ${changed} message(s).`);
            }
        }

        // ── Context estimation ─────────────────────────────────────
        const tracker = new SessionContextTracker({
            maxInputTokens: modelConfig.maxInputTokens ?? modelInfo.maxInputTokens,
            singleRequestLimit: modelDefinition?.singleRequestLimit,
            multiTierContext: modelDefinition?.multiTierContext,
            serverContextLength: modelDefinition?.serverContextLength,
            warningThreshold: this.configManager.getContextWarningThreshold(),
            errorThreshold: this.configManager.getContextErrorThreshold(),
            plan: this.configManager.getPlan(),
        });
        const estimate = tracker.estimate(allMessages);
        this.outputChannel.info(
            `Context estimate: ~${estimate.tokens.toLocaleString('en-US')} / ${estimate.limit.toLocaleString('en-US')} tokens (${Math.round(estimate.ratio * 100)}%), per-request cap ${tracker.getRequestLimit().toLocaleString('en-US')}, body ~${formatBytes(estimate.bodyBytes)} / 2 MiB (${Math.round(estimate.byteRatio * 100)}%)`,
        );
        try {
            tracker.check(allMessages);
        } catch (err) {
            this.usageTracker.setContextStats(estimate);
            this.triggerAutoCompact('local', true);
            throw err;
        }
        if (estimate.status === 'critical') {
            this.outputChannel.warn(
                'The context is almost full. Consider starting a new chat session or running "/compact" soon.',
            );
        }
        this.usageTracker.setContextStats(estimate);

        // ── Clamp max completion tokens against remaining context ─────
        // Mirrors kimi-code's completion budget: cap = min(requested, window - used).
        // Prevents the API from rejecting the request because requested output
        // tokens + estimated input tokens exceed the model's context window.
        const remainingContext = estimate.limit - estimate.tokens;
        const clampedMaxTokens = extras?.testMode
            ? 1
            : Math.max(1, Math.min(maxTokens, remainingContext));
        if (clampedMaxTokens < maxTokens && !extras?.testMode) {
            const reductionPct = Math.round((1 - clampedMaxTokens / maxTokens) * 100);
            this.outputChannel.info(
                `Completion budget clamped: ${maxTokens.toLocaleString('en-US')} → ${clampedMaxTokens.toLocaleString('en-US')} (context window ${estimate.limit.toLocaleString('en-US')} − estimated ${estimate.tokens.toLocaleString('en-US')} input = ${remainingContext.toLocaleString('en-US')} remaining, −${reductionPct}%)`,
            );

            // If clamping cut more than 50% of the requested output budget,
            // the context is too full for a meaningful response — trigger
            // compaction so the NEXT request has room. The current request
            // still goes through with the clamped budget.
            if (reductionPct > 50) {
                this.outputChannel.warn(
                    `Completion budget cut by ${reductionPct}% — context is nearly full; triggering auto-compact for the next request.`,
                );
                this.triggerAutoCompact('local', true);
            }
        }

        // ── Normalize tool call IDs for Kimi API (max 64 chars) ──────
        const normalizedMessages = normalizeToolCallIds(allMessages);

        // ── Build request via Builder ───────────────────────────────
        const tools = convertTools(toolCallingEnabled, options.tools);
        const requestPolicyStrategy = getRequestPolicy(requestPolicy);

        const builder = new KimiRequestBuilder(modelInfo.id, modelName)
            .withMessages(normalizedMessages)
            .withStreaming(enableStreaming, enableStreaming)
            .withMaxTokens(clampedMaxTokens)
            .withModelConfig(modelConfig)
            .withModelDefaults(modelDefaults)
            .withGlobalSettings(this.configManager)
            .withThinking(thinking)
            .withReasoningEffort(reasoningEffort)
            .withRequestPolicy(requestPolicyStrategy.label as 'k2' | 'k3')
            .withToolCalling(toolCallingEnabled, tools)
            .withSystemPrompt(systemPrompt)
            .withTransliterate(transliterate);

        const request = builder.build();

        // ── Send via Facade ─────────────────────────────────────────
        const endpoint = this.configManager.getEndpoint();
        const apiClient = new KimiApiClient(apiKey, endpoint, {
            timeoutMs: this.configManager.getTimeout(),
            maxRetries: this.configManager.getMaxRetries(),
            retryBaseDelayMs: this.configManager.getRetryBaseDelayMs(),
            retryMaxDelayMs: this.configManager.getRetryMaxDelayMs(),
        });

        this.outputChannel.info(
            `→ ${normalizedMessages.length} messages + ${tools?.length ?? 0} tools → ${endpoint} (model: ${modelName})`,
        );

        const startTime = Date.now();
        const reasoningDialect = new ReasoningKeyDialect();

        try {
            const chatResult = await apiClient.chat(request, token);

            // Log trace-id for request diagnostics (available from response headers
            // before the stream body, via the OpenAI SDK's withResponse()).
            if (chatResult.traceId) {
                this.outputChannel.info(`trace-id: ${chatResult.traceId}`);
            }

            const networkTime = Date.now() - startTime;

            if (chatResult.isStream) {
                const timing = await streamOpenAIResponse(
                    chatResult.data as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
                    progress,
                    token,
                    this.outputChannel,
                    this.usageTracker,
                    reasoningDialect,
                );
                this.outputChannel.info(
                    `← stream done: TTFT ${timing.ttftMs}ms, decode ${timing.streamDurationMs}ms, ${timing.chunkCount} chunks, network ${networkTime}ms, total ${Date.now() - startTime}ms`,
                );
            } else {
                await completeOpenAIResponse(
                    chatResult.data as OpenAI.Chat.Completions.ChatCompletion,
                    progress,
                    this.outputChannel,
                    this.usageTracker,
                    reasoningDialect,
                );
                this.outputChannel.info(`← completed in ${Date.now() - startTime}ms (non-streaming)`);
            }
        } catch (err) {
            this.outputChannel.error('Request failed', err);
            if (err instanceof vscode.LanguageModelError) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('fetch failed') || message.includes('ENOTFOUND') || message.includes('ECONNREFUSED')) {
                throw new vscode.LanguageModelError(
                    `Unable to reach Kimi API at ${endpoint}. Check your network connection and endpoint configuration.`,
                    { cause: err },
                );
            }
            if (message.includes('aborted') || message.includes('AbortError')) {
                throw new vscode.LanguageModelError(
                    'Kimi API request was cancelled or timed out.',
                    { cause: err },
                );
            }
            // Check for context-length overflow from the API client's translated error
            if (message.includes('per-request token limit') || message.includes('context_length_exceeded')) {
                this.outputChannel.warn(
                    'Server rejected the request for context length; refreshing model catalog in the background.',
                );
                void this.refreshModelsFromServer();
                this.triggerAutoCompact('api', true);
            }
            throw new vscode.LanguageModelError(message, { cause: err });
        }
    }

    // ── Token counting ─────────────────────────────────────────────

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken,
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.max(1, Math.ceil(text.length / 3.5));
        }
        return Math.max(1, Math.ceil(extractTextContent(text).length / 3.5));
    }

    // ── Cleanup ────────────────────────────────────────────────────

    dispose(): void {
        this.outputChannel.dispose();
        this._onDidChange.dispose();
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
    }

    // ── HTTP is now delegated to KimiApiClient (Facade) ────────────
    // fetchWithRetry, fetchWithTimeout, retry/backoff logic, and error
    // mapping live in `src/api-client.ts` and `src/error-handlers.ts`.

    // ── Auto-compact fallback ────────────────────────────────────────

    /**
     * Triggers Copilot Chat compaction (/compact) once per session and warns
     * the user. Controlled by `kimiCopilot.autoCompactOnLimit` (default on).
     *
     * @param reason  What triggered the fallback ('api' = server rejected the
     *                request, 'local' = pre-flight estimate exceeded the cap).
     * @param resend  When true, ask the user to resend the request after
     *                compaction finishes (the rejected request was dropped).
     */
    private triggerAutoCompact(reason: 'api' | 'local', resend: boolean): void {
        if (!this.configManager.getAutoCompactOnLimit()) {
            return;
        }
        if (this.autoCompactTriggered) {
            this.outputChannel.info('Auto-compact already triggered this session; skipping.');
            return;
        }
        this.autoCompactTriggered = true;

        const source =
            reason === 'api'
                ? 'The Kimi API rejected the request because it exceeded the token limit.'
                : 'The request exceeds the per-request token limit.';
        const followUp = resend
            ? ' Resend your message once compaction finishes.'
            : '';
        void vscode.window.showWarningMessage(
            `Kimi Copilot: ${source} Compacting the conversation with /compact…${followUp}`,
        );

        // `github.copilot.chat.compact` is the command registered by the
        // GitHub Copilot Chat extension for its /compact feature. It may be
        // unavailable (extension disabled, older version), so check first.
        void vscode.commands.getCommands(true).then((all) => {
            if (all.includes('github.copilot.chat.compact')) {
                this.outputChannel.warn(
                    `Auto-compact triggered (${reason}): running github.copilot.chat.compact`,
                );
                void vscode.commands.executeCommand('github.copilot.chat.compact');
            } else {
                this.outputChannel.warn(
                    'github.copilot.chat.compact is not available; ask the user to run /compact manually.',
                );
                void vscode.window.showWarningMessage(
                    'Kimi Copilot: automatic compaction is unavailable. Please run "/compact" in the Chat input manually.',
                );
            }
        });
    }

    // ── Error mapping is now delegated to ErrorHandler chain ───────
    // (src/error-handlers.ts). The chain is consumed through
    // KimiApiClient.toLanguageModelError() and
    // KimiApiClient.isContextLengthError().
}

// ═══════════════════════════════════════════════════════════════════════
// Re-exports for backward compatibility — keep provider.test.ts working
// ═══════════════════════════════════════════════════════════════════════

export { parseRetryAfterMs, parseRetryAfterMs as parseRetryAfterHeader, computeBackoffDelayMs } from './api-client';
export { buildKimiRequest } from './request-policy';

// ═══════════════════════════════════════════════════════════════════════
// Helpers — message conversion
// ═══════════════════════════════════════════════════════════════════════

// parseRetryAfterHeader, computeBackoffDelayMs, buildKimiRequest now
// re-exported from './api-client' and './request-policy' above.

function roleToString(role: vscode.LanguageModelChatMessageRole): string {
    switch (role) {
        case vscode.LanguageModelChatMessageRole.User:
            return 'user';
        case vscode.LanguageModelChatMessageRole.Assistant:
            return 'assistant';
        default:
            return 'user';
    }
}

export function extractTextContent(
    msg: vscode.LanguageModelChatMessage | vscode.LanguageModelChatRequestMessage,
): string {
    const parts: string[] = [];
    for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            parts.push(part.value);
        } else if (part instanceof vscode.LanguageModelPromptTsxPart) {
            parts.push(typeof part.value === 'string' ? part.value : JSON.stringify(part.value));
        }
    }
    return parts.join('\n');
}

export function convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
): KimiMessage[] {
    const result: KimiMessage[] = [];

    for (const message of messages) {
        const role = roleToString(message.role);
        let content = '';
        const contentParts: KimiContentPart[] = [];
        const toolCalls: KimiToolCall[] = [];
        const toolResults: Array<{ callId: string; content: string }> = [];

        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                content += part.value;
                contentParts.push({ type: 'text', text: part.value });
            } else if (isLanguageModelDataPart(part)) {
                if (part.mimeType.startsWith('image/')) {
                    contentParts.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`,
                        },
                    });
                }
            } else if (part instanceof vscode.LanguageModelPromptTsxPart) {
                const value = typeof part.value === 'string' ? part.value : JSON.stringify(part.value);
                content += value;
                contentParts.push({ type: 'text', text: value });
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push({
                    id: part.callId,
                    type: 'function',
                    function: {
                        name: part.name,
                        arguments: JSON.stringify(part.input),
                    },
                });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const toolContentParts: string[] = [];
                for (const item of part.content) {
                    if (item instanceof vscode.LanguageModelTextPart) {
                        toolContentParts.push(item.value);
                    } else if (item instanceof vscode.LanguageModelPromptTsxPart) {
                        toolContentParts.push(
                            typeof item.value === 'string' ? item.value : JSON.stringify(item.value),
                        );
                    }
                }
                toolResults.push({
                    callId: part.callId,
                    content: toolContentParts.length > 0 ? toolContentParts.join('\n') : JSON.stringify(part.content),
                });
            }
        }

        if (role === 'assistant') {
            if (content || toolCalls.length > 0) {
                const msg: KimiMessage = {
                    role: 'assistant',
                    content: content || '',
                };
                if (toolCalls.length > 0) {
                    msg.tool_calls = toolCalls;
                }
                result.push(msg);
            }
        } else {
            if (content) {
                result.push({
                    role: role as 'user' | 'assistant',
                    content: contentParts.length > 1 ? contentParts : content,
                });
            } else if (contentParts.length > 0) {
                result.push({ role: role as 'user' | 'assistant', content: contentParts });
            }
        }

        // Tool result messages follow their associated assistant message
        for (const tr of toolResults) {
            result.push({
                role: 'tool',
                content: tr.content,
                tool_call_id: tr.callId,
            });
        }
    }

    return result;
}

function isLanguageModelDataPart(
    part: unknown,
): part is vscode.LanguageModelDataPart {
    return typeof vscode.LanguageModelDataPart !== 'undefined' && part instanceof vscode.LanguageModelDataPart;
}

/**
 * Resolves the effective reasoning effort for a request.
 * Precedence: Copilot Chat UI options > per-model config > model default.
 * Maps common UI values to Kimi K3's accepted low/high/max values.
 */
export function resolveReasoningEffort(
    modelOptions: { readonly [name: string]: unknown } | undefined,
    modelDefaults: ModelDefaults | undefined,
    modelConfig: ModelConfigOverride,
): 'low' | 'high' | 'max' {
    const raw =
        modelOptions?.reasoning_effort ??
        modelOptions?.reasoningEffort ??
        modelConfig.reasoningEffort ??
        modelDefaults?.reasoningEffort ??
        'max';

    switch (String(raw).toLowerCase()) {
        case 'low':
        case 'minimum':
        case 'light':
        case 'none':
            return 'low';
        case 'medium':
        case 'normal':
            return 'high';
        case 'high':
            return 'high';
        case 'max':
        case 'ultra':
        case 'xhigh':
        case 'maximum':
            return 'max';
        default:
            return 'max';
    }
}

export function resolveReasoningEffortFromOptions(
    options: vscode.ProvideLanguageModelChatResponseOptions,
    modelDefaults: ModelDefaults | undefined,
    modelConfig: ModelConfigOverride,
): 'low' | 'high' | 'max' {
    // Copilot Chat passes user-selected configuration values (e.g. from the
    // Thinking Effort picker) through `modelConfiguration` or `configuration`.
    const extendedOptions = options as unknown as {
        modelConfiguration?: { readonly [key: string]: unknown };
        configuration?: { readonly [key: string]: unknown };
    };
    const configured =
        extendedOptions.modelConfiguration?.reasoningEffort ??
        extendedOptions.configuration?.reasoningEffort;
    return resolveReasoningEffort(
        configured !== undefined ? { reasoningEffort: configured } : options.modelOptions,
        modelDefaults,
        modelConfig,
    );
}

// buildKimiRequest is now re-exported from './request-policy' above.
// convertTools and streaming/completion helpers follow.

export function convertTools(
    toolCallingCapability: boolean | undefined,
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
): KimiTool[] | undefined {
    if (!toolCallingCapability || !tools || tools.length === 0) {
        return undefined;
    }

    return tools.map((tool) => {
        const rawParams = tool.inputSchema as Record<string, unknown> | undefined;
        const parameters =
            rawParams !== undefined && Object.keys(rawParams).length > 0
                ? normalizeKimiToolSchema(rawParams)
                : undefined;
        return {
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters,
            },
        };
    });
}

// ═══════════════════════════════════════════════════════════════════════
// LanguageModelThinkingPart helper
// ═══════════════════════════════════════════════════════════════════════
//
// `LanguageModelThinkingPart` is a proposed API available in VS Code 1.129+.
// Only the `github.copilot-chat` extension has it enabled by default in its
// product.json proposals list — third-party providers must use
// `--enable-proposed-api` or check at runtime.
//
// Strategy: try to resolve the constructor at runtime. On success we use the
// native thinking part (renders as a collapsible block in the Chat UI). On
// failure we accumulate the thinking text and either prepend it as markdown
// (non-streaming) or emit it as a regular text part (streaming).

const THINKING_HEADER = '> 💭 **Thinking**';

let _thinkingPartCtor: { new (value: string | string[], id?: string, metadata?: { readonly [key: string]: any }): unknown } | undefined;

function getThinkingPartCtor(): typeof _thinkingPartCtor {
    if (_thinkingPartCtor === undefined) {
        try {
            _thinkingPartCtor = (vscode as any).LanguageModelThinkingPart;
            if (typeof _thinkingPartCtor !== 'function') {
                _thinkingPartCtor = undefined;
            }
        } catch {
            _thinkingPartCtor = undefined;
        }
    }
    return _thinkingPartCtor;
}

/** Format thinking content as a markdown blockquote for text fallback. */
export function formatThinkingAsText(content: string): string {
    return `${THINKING_HEADER}\n> ${content.trim().replace(/\n/g, '\n> ')}\n\n---\n\n`;
}

/** Try to report thinking content using the native VS Code part. Returns true on success. */
export function tryReportThinkingPart(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    content: string,
): boolean {
    const ctor = getThinkingPartCtor();
    if (!ctor) {
        return false;
    }
    try {
        progress.report(new ctor(content) as any);
        return true;
    } catch {
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Non-streaming response (OpenAI SDK)
// ═══════════════════════════════════════════════════════════════════════

async function completeOpenAIResponse(
    completion: OpenAI.Chat.Completions.ChatCompletion,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    outputChannel: vscode.LogOutputChannel,
    usageTracker: UsageTracker,
    reasoningDialect: ReasoningKeyDialect,
): Promise<void> {
    if (completion.usage) {
        const usage = {
            prompt_tokens: completion.usage.prompt_tokens ?? 0,
            completion_tokens: completion.usage.completion_tokens ?? 0,
            total_tokens: completion.usage.total_tokens ?? 0,
            cached_tokens: (completion.usage.prompt_tokens_details as { cached_tokens?: number } | null | undefined)?.cached_tokens,
        };
        if (hasUsage(usage)) {
            usageTracker.recordUsage(usage);
            reportCopilotContextUsage(progress, usage);
        }
    }

    const message = completion.choices[0]?.message;
    if (!message) {
        outputChannel.warn('Empty response from Kimi API');
        return;
    }

    // Reasoning / thinking content — use dialect-aware detection across all known keys
    const rawMsg = message as unknown as Record<string, unknown>;
    const reasoningText = reasoningDialect.observe(rawMsg);
    if (reasoningText) {
        outputChannel.debug(`Reasoning in non-streaming response (${reasoningText.length} chars, key: ${reasoningDialect.outboundKey()})`);
        const reported = tryReportThinkingPart(progress, reasoningText);
        if (!reported) {
            outputChannel.debug('LanguageModelThinkingPart unavailable, using text fallback for reasoning');
            progress.report(new vscode.LanguageModelTextPart(formatThinkingAsText(reasoningText)));
        }
    }

    if (message.content) {
        progress.report(new vscode.LanguageModelTextPart(message.content));
    }

    if (message.tool_calls) {
        for (const call of message.tool_calls) {
            if (call.type !== 'function') continue;
            progress.report(
                new vscode.LanguageModelToolCallPart(
                    call.id,
                    call.function.name,
                    safeParseArgs(call.function.arguments),
                ),
            );
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Streaming response (OpenAI SDK) with dialect-aware reasoning detection
// ═══════════════════════════════════════════════════════════════════════

interface StreamTiming {
    /** Wall-clock ms from function entry to first chunk (TTFT). */
    ttftMs: number;
    /** Wall-clock ms from first chunk to stream end. */
    streamDurationMs: number;
    /** Total number of chunks received. */
    chunkCount: number;
}

async function streamOpenAIResponse(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    outputChannel: vscode.LogOutputChannel,
    usageTracker: UsageTracker,
    reasoningDialect: ReasoningKeyDialect,
): Promise<StreamTiming> {
    const streamStart = Date.now();
    let firstChunkAt: number | undefined;
    let chunkCount = 0;

    const pendingToolCalls = new Map<
        number,
        { id: string; name: string; args: string }
    >();

    // Fallback reasoning buffer — used when LanguageModelThinkingPart is unavailable.
    let fallbackReasoningBuffer: string | undefined;
    let thinkingPartAvailable: boolean | undefined;

    const emitPendingToolCalls = (): void => {
        if (pendingToolCalls.size === 0) return;
        for (const call of pendingToolCalls.values()) {
            if (call.id && call.name) {
                progress.report(
                    new vscode.LanguageModelToolCallPart(
                        call.id,
                        call.name,
                        safeParseArgs(call.args),
                    ),
                );
            }
        }
        pendingToolCalls.clear();
    };

    const flushFallbackReasoning = (): void => {
        if (fallbackReasoningBuffer && fallbackReasoningBuffer.length > 0) {
            outputChannel.debug(`Flushing accumulated reasoning (${fallbackReasoningBuffer.length} chars) as text fallback`);
            progress.report(new vscode.LanguageModelTextPart(formatThinkingAsText(fallbackReasoningBuffer)));
            fallbackReasoningBuffer = undefined;
        }
    };

    const handleReasoningDelta = (text: string): void => {
        if (thinkingPartAvailable === undefined) {
            const success = tryReportThinkingPart(progress, text);
            thinkingPartAvailable = success;
            if (success) return;
        }
        if (thinkingPartAvailable) {
            tryReportThinkingPart(progress, text);
        } else {
            fallbackReasoningBuffer = (fallbackReasoningBuffer ?? '') + text;
        }
    };

    try {
        for await (const chunk of stream) {
            if (token.isCancellationRequested) break;

            chunkCount++;
            if (firstChunkAt === undefined) {
                firstChunkAt = Date.now();
            }

            // Extract usage from chunk (Kimi may place it in choices[0].usage too)
            const rawChunk = chunk as unknown as Record<string, unknown>;
            const rawUsage = extractChunkUsage(rawChunk);
            if (rawUsage && hasUsage(rawUsage)) {
                usageTracker.recordUsage(rawUsage);
                reportCopilotContextUsage(progress, rawUsage);
            }

            const choice = chunk.choices[0];
            if (!choice) continue;

            const delta = choice.delta as Record<string, unknown>;

            // Reasoning / thinking content — dialect-aware detection across all known keys
            const reasoningText = reasoningDialect.observe(delta);
            if (reasoningText) {
                handleReasoningDelta(reasoningText);
            }

            // Text content
            if (typeof delta['content'] === 'string' && (delta['content'] as string).length > 0) {
                if (fallbackReasoningBuffer) flushFallbackReasoning();
                if (thinkingPartAvailable === undefined) thinkingPartAvailable = false;
                progress.report(new vscode.LanguageModelTextPart(delta['content'] as string));
            }

            // Tool calls
            const toolCalls = delta['tool_calls'] as Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
            }> | undefined;

            if (toolCalls) {
                for (const tc of toolCalls) {
                    let existing = pendingToolCalls.get(tc.index);
                    if (!existing) {
                        existing = { id: '', name: '', args: '' };
                        pendingToolCalls.set(tc.index, existing);
                    }
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name += tc.function.name;
                    if (tc.function?.arguments) existing.args += tc.function.arguments;
                }
            }

            // Emit completed tool calls on finish
            if (choice.finish_reason) {
                if (fallbackReasoningBuffer) flushFallbackReasoning();
                emitPendingToolCalls();
            }
        }
    } catch (err) {
        if (err instanceof OpenAI.APIError) {
            throw err; // Let the caller's error handler deal with it
        }
        throw err;
    }

    // Stream ended — flush any remaining state
    if (fallbackReasoningBuffer) flushFallbackReasoning();
    emitPendingToolCalls();

    const streamEnd = Date.now();
    return {
        ttftMs: firstChunkAt !== undefined ? firstChunkAt - streamStart : streamEnd - streamStart,
        streamDurationMs: firstChunkAt !== undefined ? streamEnd - firstChunkAt : 0,
        chunkCount,
    };
}

/**
 * Extract usage from a streaming chunk, checking both top-level and
 * choices[0].usage (Moonshot proprietary placement).
 */
function extractChunkUsage(chunk: Record<string, unknown>): {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens?: number;
} | null {
    // Top-level usage
    const topUsage = chunk['usage'];
    if (topUsage !== null && topUsage !== undefined && typeof topUsage === 'object') {
        const u = topUsage as Record<string, unknown>;
        if (typeof u['total_tokens'] === 'number') {
            return {
                prompt_tokens: (typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0) as number,
                completion_tokens: (typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0) as number,
                total_tokens: u['total_tokens'] as number,
                cached_tokens: typeof u['cached_tokens'] === 'number' ? u['cached_tokens'] as number : undefined,
            };
        }
    }
    // choices[0].usage (Moonshot proprietary)
    const choices = chunk['choices'];
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    if (!firstChoice) return null;
    const choiceUsage = firstChoice['usage'];
    if (choiceUsage !== null && choiceUsage !== undefined && typeof choiceUsage === 'object') {
        const u = choiceUsage as Record<string, unknown>;
        if (typeof u['total_tokens'] === 'number') {
            return {
                prompt_tokens: (typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0) as number,
                completion_tokens: (typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0) as number,
                total_tokens: u['total_tokens'] as number,
                cached_tokens: typeof u['cached_tokens'] === 'number' ? u['cached_tokens'] as number : undefined,
            };
        }
    }
    return null;
}

function safeParseArgs(args: string): Record<string, unknown> {
    try {
        return JSON.parse(args) as Record<string, unknown>;
    } catch {
        return {};
    }
}

const COPILOT_USAGE_DATA_PART_MIME = 'usage';

function reportCopilotContextUsage(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number },
): void {
    const data = {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
        prompt_tokens_details: {
            cached_tokens: usage.cached_tokens ?? 0,
        },
    };

    try {
        progress.report(
            new vscode.LanguageModelDataPart(
                new TextEncoder().encode(JSON.stringify(data)),
                COPILOT_USAGE_DATA_PART_MIME,
            ),
        );
    } catch {
        // Best-effort: Copilot Chat may not consume this mime type in all versions.
    }
}
