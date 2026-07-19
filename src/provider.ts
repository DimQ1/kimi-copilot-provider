import * as vscode from 'vscode';
import { ConfigurationManager } from './config';
import { SessionContextTracker } from './context-tracker';
import { MODELS, toChatInfo, getModelCapabilities, getMaxOutputTokens, getModelDefaults, findModelById, applyServerModelCatalog, getEffectiveModels } from './models';
import { fetchKimiModels } from './models-client';
import { UsageTracker, hasUsage } from './usage';
import type { KimiContentPart, KimiMessage, KimiTool, KimiToolCall, KimiRequest, KimiStreamChunk, ModelDefaults, ModelConfigOverride } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_ENDPOINT = 'https://api.kimi.com/coding/v1/chat/completions';
const DEFAULT_MODELS_ENDPOINT = 'https://api.kimi.com/coding/v1/models';

// ═══════════════════════════════════════════════════════════════════════
// Provider class — implements the non-generic LanguageModelChatProvider
// ═══════════════════════════════════════════════════════════════════════

export class KimiChatProvider implements vscode.LanguageModelChatProvider {

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

    private readonly outputChannel: vscode.LogOutputChannel;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly configManager: ConfigurationManager,
        private readonly usageTracker: UsageTracker,
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
        applyServerModelCatalog(this.configManager.getServerModels());
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
        applyServerModelCatalog(result.models);
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

    /** Access the local usage tracker for status bar / commands. */
    getUsageTracker(): UsageTracker {
        return this.usageTracker;
    }

    // ── Model information ──────────────────────────────────────────

    async provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelChatInformation[]> {
        // Always return models — the `silent` flag means "don't prompt for credentials",
        // not "don't report models". The official sample ignores it entirely.
        const hasApiKey = !!(await this.configManager.getApiKey());
        return getEffectiveModels().map((model) => toChatInfo(model, hasApiKey, this.configManager.getModelConfig(model.id)));
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

        const endpoint = this.configManager.getEndpoint() || DEFAULT_ENDPOINT;
        const modelName = this.configManager.getApiModelId(modelInfo.id);
        const modelConfig = this.configManager.getModelConfig(modelInfo.id);
        const modelDefaults = getModelDefaults(modelInfo.id);
        const modelDefinition = findModelById(modelInfo.id);
        const requestPolicy = modelName === 'kimi-k3'
            ? 'k3'
            : modelDefinition?.requestPolicy ?? modelDefaults?.requestPolicy ?? 'k2';

        // Effective parameters: model config > global setting > hard-coded model default.
        const temperature =
            modelConfig.temperature ??
            this.configManager.getTemperature() ??
            modelDefaults?.temperature ??
            1.0;
        const topP =
            modelConfig.topP ?? this.configManager.getTopP() ?? modelDefaults?.topP ?? 0.95;
        const presencePenalty =
            modelConfig.presencePenalty ??
            this.configManager.getPresencePenalty(modelInfo.id) ??
            0.0;
        const frequencyPenalty =
            modelConfig.frequencyPenalty ??
            this.configManager.getFrequencyPenalty(modelInfo.id) ??
            0.0;
        const thinking =
            modelConfig.thinking ??
            this.configManager.getThinking(modelInfo.id) ??
            modelDefaults?.thinking;
        const reasoningEffort = resolveReasoningEffortFromOptions(options, modelDefaults, modelConfig);

        const maxTokensSetting = this.configManager.getMaxTokens(modelInfo.id);
        const maxOutputTokens = modelConfig.maxOutputTokens ?? getMaxOutputTokens(modelInfo.id);
        const maxTokens = maxTokensSetting > 0
            ? Math.min(maxTokensSetting, 1048576)
            : maxOutputTokens;

        const enableStreaming = extras?.testMode ? false : this.configManager.getEnableStreaming();
        const timeout = this.configManager.getTimeout();
        const systemPrompt = this.configManager.getSystemPrompt(modelInfo.id);

        const capabilities = getModelCapabilities(modelInfo.id);
        const toolCallingEnabled = modelConfig.toolCalling ?? capabilities?.toolCalling ?? false;

        // Convert messages to API format and prepend system prompt
        const allMessages = convertMessages(messages);
        if (!allMessages.some((m) => m.role === 'system')) {
            allMessages.unshift({ role: 'system', content: systemPrompt });
        }

        // Estimate and guard against session context limits.
        const tracker = new SessionContextTracker({
            maxInputTokens: modelConfig.maxInputTokens ?? modelInfo.maxInputTokens,
            singleRequestLimit: modelDefinition?.singleRequestLimit,
            multiTierContext: modelDefinition?.multiTierContext,
            warningThreshold: this.configManager.getContextWarningThreshold(),
            errorThreshold: this.configManager.getContextErrorThreshold(),
            plan: this.configManager.getPlan(),
        });
        const estimate = tracker.estimate(allMessages);
        this.outputChannel.info(
            `Context estimate: ~${estimate.tokens.toLocaleString('en-US')} / ${estimate.limit.toLocaleString('en-US')} tokens (${Math.round(estimate.ratio * 100)}%)`,
        );
        if (estimate.status === 'exceeded' || estimate.status === 'critical') {
            const guidance = estimate.status === 'exceeded'
                ? 'Start a new chat session, run "/compact", or remove files from the context.'
                : 'The context is almost full. Consider starting a new chat session or running "/compact" soon.';
            const planHint = modelDefinition?.multiTierContext
                ? ' Allegretto+ users can configure up to 1M context via settings, but a single request still cannot exceed 262144 tokens.'
                : '';
            this.usageTracker.setContextStats(estimate);
            throw new vscode.LanguageModelError(
                `Kimi context ${estimate.status}: ~${estimate.tokens.toLocaleString('en-US')} / ${estimate.limit.toLocaleString('en-US')} tokens.${planHint}\n\n${guidance}`,
            );
        }

        this.usageTracker.setContextStats(estimate);

        const request = buildKimiRequest({
            model: modelName,
            messages: allMessages,
            stream: enableStreaming,
            includeUsage: enableStreaming,
            requestPolicy,
            maxTokens: extras?.testMode ? 1 : maxTokens,
            temperature,
            topP,
            presencePenalty,
            frequencyPenalty,
            thinking,
            reasoningEffort,
        });

        // Convert tools if the model supports tool calling
        const tools = convertTools(toolCallingEnabled, options.tools);
        if (tools && tools.length > 0) {
            request.tools = tools;
            request.tool_choice = toolCallingEnabled ? 'auto' : 'none';
        }

        this.outputChannel.info(
            `→ ${allMessages.length} messages + ${tools?.length ?? 0} tools → ${endpoint} (model: ${modelName})`,
        );

        const startTime = Date.now();
        try {
            const response = await this.fetchWithRetry(
                endpoint,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                        Accept: enableStreaming ? 'text/event-stream' : 'application/json',
                    },
                    body: JSON.stringify(request),
                },
                timeout,
                token,
            );

            if (!response.ok) {
                const errText = await response.text().catch(() => 'unknown');
                throw this.toLanguageModelError(response.status, errText);
            }

            if (enableStreaming) {
                await streamSSEResponse(response, progress, token, this.outputChannel, this.usageTracker);
            } else {
                await completeResponse(response, progress, this.outputChannel, this.usageTracker);
            }

            this.outputChannel.info(`← completed in ${Date.now() - startTime}ms`);
        } catch (err) {
            this.outputChannel.error('Request failed', err);
            if (err instanceof vscode.LanguageModelError) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            // Improve network-related diagnostics
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

    // ── Fetch with timeout, retry and cancellation ─────────────────

    private async fetchWithRetry(
        url: string,
        init: RequestInit,
        timeoutMs: number,
        token: vscode.CancellationToken,
        attempt = 1,
    ): Promise<Response> {
        try {
            return await this.fetchWithTimeout(url, init, timeoutMs, token);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isRetryable =
                err instanceof vscode.LanguageModelError &&
                (message.includes('429') || message.includes('server error'));

            if (isRetryable && attempt < 3) {
                const delay = Math.min(1000 * 2 ** attempt, 8000);
                this.outputChannel.warn(`Retryable error, waiting ${delay}ms before attempt ${attempt + 1}`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                return this.fetchWithRetry(url, init, timeoutMs, token, attempt + 1);
            }

            throw err;
        }
    }

    private async fetchWithTimeout(
        url: string,
        init: RequestInit,
        timeoutMs: number,
        token: vscode.CancellationToken,
    ): Promise<Response> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const disposables: vscode.Disposable[] = [];
        disposables.push(token.onCancellationRequested(() => controller.abort()));

        try {
            return await fetch(url, { ...init, signal: controller.signal });
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                throw new Error(`Kimi API request timed out after ${timeoutMs}ms or was cancelled.`);
            }
            throw err;
        } finally {
            clearTimeout(timeout);
            disposables.forEach((d) => d.dispose());
        }
    }

    // ── Error mapping ───────────────────────────────────────────────

    private toLanguageModelError(status: number, body: string): vscode.LanguageModelError {
        switch (status) {
            case 401:
                {
                    const detail = body.trim().replace(/\s+/g, ' ').slice(0, 240);
                    const credentialHint = 'For the default /coding/ endpoint, use a key created in the Kimi Code Console, not a Kimi Platform key.';
                    return new vscode.LanguageModelError(
                        `Invalid Kimi API key (401). ${credentialHint} Run "Kimi Copilot: Set API Key" to update.${detail ? ` Server response: ${detail}` : ''}`,
                    );
                }
            case 403:
                return new vscode.LanguageModelError(
                    'Access denied by Kimi API (403).',
                );
            case 429:
                return new vscode.LanguageModelError(
                    'Kimi API rate limit exceeded (429). Retry later.',
                );
            case 500:
            case 502:
            case 503:
                return new vscode.LanguageModelError(
                    'Kimi API server error. Retry later.',
                );
            default:
                return new vscode.LanguageModelError(
                    `Kimi API error ${status}: ${body.slice(0, 300)}`,
                );
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers — message conversion
// ═══════════════════════════════════════════════════════════════════════

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

export function buildKimiRequest(options: {
    model: string;
    messages: KimiMessage[];
    stream: boolean;
    includeUsage?: boolean;
    requestPolicy: 'k2' | 'k3';
    maxTokens: number;
    temperature: number;
    topP: number;
    presencePenalty: number;
    frequencyPenalty: number;
    thinking?: { type: 'enabled' | 'disabled' };
    reasoningEffort?: 'low' | 'high' | 'max';
}): KimiRequest {
    const request: KimiRequest = {
        model: options.model,
        messages: options.messages,
        stream: options.stream,
    };

    if (options.stream && options.includeUsage) {
        request.stream_options = { include_usage: true };
    }

    if (options.requestPolicy === 'k3') {
        request.max_completion_tokens = options.maxTokens;
        request.reasoning_effort = options.reasoningEffort ?? 'max';
    } else {
        request.temperature = options.temperature;
        request.top_p = options.topP;
        request.max_tokens = options.maxTokens;
        request.presence_penalty = options.presencePenalty;
        request.frequency_penalty = options.frequencyPenalty;
        if (options.thinking) {
            request.thinking = options.thinking;
        }
    }

    return request;
}

export function convertTools(
    toolCallingCapability: boolean | undefined,
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
): KimiTool[] | undefined {
    if (!toolCallingCapability || !tools || tools.length === 0) {
        return undefined;
    }

    return tools.map((tool) => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as Record<string, unknown> | undefined,
        },
    }));
}

// ═══════════════════════════════════════════════════════════════════════
// Non-streaming response
// ═══════════════════════════════════════════════════════════════════════

async function completeResponse(
    response: Response,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    outputChannel: vscode.LogOutputChannel,
    usageTracker: UsageTracker,
): Promise<void> {
    const data = (await response.json()) as {
        choices: Array<{
            message?: {
                role?: string;
                content?: string | null;
                tool_calls?: KimiToolCall[];
            };
            finish_reason: string | null;
        }>;
        usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            cached_tokens?: number;
        };
    };

    if (hasUsage(data.usage)) {
        usageTracker.recordUsage(data.usage);
        reportCopilotContextUsage(progress, data.usage);
    }

    const message = data.choices[0]?.message;
    if (!message) {
        outputChannel.warn('Empty response from Kimi API');
        return;
    }

    if (message.content) {
        progress.report(new vscode.LanguageModelTextPart(message.content));
    }

    if (message.tool_calls) {
        for (const call of message.tool_calls) {
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
// SSE streaming — OpenAI-compatible
// ═══════════════════════════════════════════════════════════════════════

async function streamSSEResponse(
    response: Response,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    outputChannel: vscode.LogOutputChannel,
    usageTracker: UsageTracker,
): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('No response body from Kimi API');
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const pendingToolCalls = new Map<
        number,
        { id: string; name: string; args: string }
    >();

    const emitPendingToolCalls = (): void => {
        if (pendingToolCalls.size === 0) {
            return;
        }
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

    try {
        while (true) {
            if (token.isCancellationRequested) {
                await reader.cancel();
                return;
            }

            let readResult: ReadableStreamReadResult<Uint8Array>;
            try {
                readResult = await reader.read();
            } catch (err) {
                if (err instanceof Error && err.name === 'AbortError') {
                    outputChannel.warn('SSE stream aborted');
                    return;
                }
                throw err;
            }

            const { done, value } = readResult;
            if (done) {
                emitPendingToolCalls();
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) {
                    continue;
                }

                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') {
                    emitPendingToolCalls();
                    return;
                }

                try {
                    const parsed = JSON.parse(payload) as KimiStreamChunk;
                    const delta = parsed.choices[0]?.delta;

                    if (hasUsage(parsed.usage)) {
                        usageTracker.recordUsage(parsed.usage);
                        reportCopilotContextUsage(progress, parsed.usage);
                    }

                    if (!delta) {
                        continue;
                    }

                    if (delta.reasoning_content) {
                        outputChannel.debug(`Kimi reasoning delta received (${delta.reasoning_content.length} chars)`);
                    }

                    // Text content
                    if (delta.content) {
                        progress.report(new vscode.LanguageModelTextPart(delta.content));
                    }

                    // Tool calls (accumulate across chunks)
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            let existing = pendingToolCalls.get(tc.index);
                            if (!existing) {
                                existing = { id: '', name: '', args: '' };
                                pendingToolCalls.set(tc.index, existing);
                            }

                            if (tc.id) {
                                existing.id = tc.id;
                            }
                            if (tc.function?.name) {
                                existing.name += tc.function.name;
                            }
                            if (tc.function?.arguments) {
                                existing.args += tc.function.arguments;
                            }
                        }
                    }

                    // Emit completed tool calls on finish
                    if (parsed.choices[0].finish_reason) {
                        emitPendingToolCalls();
                    }
                } catch (parseErr) {
                    outputChannel.warn('Skipping malformed SSE chunk', parseErr);
                }
            }
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            /* already released */
        }
    }
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
