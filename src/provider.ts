import * as vscode from 'vscode';
import { ConfigurationManager } from './config';
import { SessionContextTracker, formatBytes } from './context-tracker';
import { MODELS, toChatInfo, getModelCapabilities, getMaxOutputTokens, getModelDefaults, findModelById, applyServerModelCatalog, getEffectiveModels } from './models';
import { fetchKimiModels } from './models-client';
import { transliterateMessages } from './transliterate';
import { UsageTracker, hasUsage } from './usage';
import type { KimiContentPart, KimiMessage, KimiTool, KimiToolCall, KimiRequest, KimiStreamChunk, ModelDefaults, ModelConfigOverride } from './types';

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

        const endpoint = this.configManager.getEndpoint();
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
        let thinking =
            modelConfig.thinking ??
            this.configManager.getThinking(modelInfo.id) ??
            modelDefaults?.thinking;
        // When the server declares supports_thinking_type: "only" (all current
        // Kimi Code models), the API rejects thinking.type: "disabled" — drop a
        // stale user override instead of failing the request.
        if (thinking?.type === 'disabled' && modelDefinition?.supportsThinkingType === 'only') {
            this.outputChannel.warn(
                `Model ${modelInfo.id} does not support disabling thinking (supports_thinking_type: "only"); ignoring the override.`,
            );
            thinking = { type: 'enabled' };
        }
        const reasoningEffort = resolveReasoningEffortFromOptions(options, modelDefaults, modelConfig);

        const maxTokensSetting = this.configManager.getMaxTokens(modelInfo.id);
        const maxOutputTokens = modelConfig.maxOutputTokens ?? getMaxOutputTokens(modelInfo.id);
        const maxTokens = maxTokensSetting > 0
            ? Math.min(maxTokensSetting, 1048576)
            : maxOutputTokens;

        const enableStreaming = extras?.testMode ? false : this.configManager.getEnableStreaming();
        const timeout = this.configManager.getTimeout();
        const transliterate = this.configManager.getTransliterate(modelInfo.id);
        let systemPrompt = this.configManager.getSystemPrompt(modelInfo.id);
        if (transliterate) {
            // Transliteration is enabled, so the reply must always be in
            // proper Russian (Cyrillic) — never mirrored transliteration.
            // A custom instruction can be set without a reload via
            // kimiCopilot.transliterateSystemPrompt (per-model or global).
            const replyInstruction =
                this.configManager.getTransliterateSystemPrompt(modelInfo.id) ??
                TRANSLITERATE_REPLY_INSTRUCTION;
            systemPrompt = `${systemPrompt}\n\n${replyInstruction}`;
        }

        const capabilities = getModelCapabilities(modelInfo.id);
        const toolCallingEnabled = modelConfig.toolCalling ?? capabilities?.toolCalling ?? false;

        // Convert messages to API format and prepend system prompt
        const allMessages = convertMessages(messages);
        if (!allMessages.some((m) => m.role === 'system')) {
            allMessages.unshift({ role: 'system', content: systemPrompt });
        }

        // Optional context optimizer: transliterate Cyrillic → Latin. This
        // roughly halves the request body for Cyrillic-heavy chats (5.3 →
        // 2.7 bytes/token measured) and delays hitting the 2 MiB body cap.
        // The estimator below runs AFTER transliteration, so its byte count
        // reflects what is actually sent.
        if (transliterate) {
            const changed = transliterateMessages(allMessages);
            if (changed > 0) {
                this.outputChannel.info(`Transliterate: converted Cyrillic content in ${changed} message(s).`);
            }
        }

        // Estimate and guard against context limits. The server-resolved
        // context window (per subscription) is the source of truth; the
        // per-request API cap is enforced separately inside tracker.check().
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
            // Fallback: compact the conversation so the user can resend.
            this.triggerAutoCompact('local', true);
            throw err;
        }
        if (estimate.status === 'critical') {
            this.outputChannel.warn(
                'The context is almost full. Consider starting a new chat session or running "/compact" soon.',
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
                // A context-length rejection may mean the subscription tier
                // changed since the last catalog fetch (e.g. downgrade from
                // Allegretto+ to Moderato). Refresh /models in the background
                // so the next request uses the server-resolved limits.
                if (this.isContextLengthError(response.status, errText)) {
                    this.outputChannel.warn(
                        'Server rejected the request for context length; refreshing model catalog in the background.',
                    );
                    void this.refreshModelsFromServer();
                    // Fallback: compact the conversation and ask the user to
                    // resend — the rejected request was dropped by the server.
                    this.triggerAutoCompact('api', true);
                }
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

    /**
     * Fetches with retries on retryable conditions:
     * - HTTP 429 (rate limit) — honors the `Retry-After` header when present;
     * - HTTP 500/502/503 (server errors);
     * - network failures (fetch rejects) — the server never saw the request.
     *
     * Non-retryable statuses (400, 401, 403, …) are returned to the caller
     * immediately so it can map them to a LanguageModelError. The response
     * body of a retried attempt is always drained to free the connection.
     */
    private async fetchWithRetry(
        url: string,
        init: RequestInit,
        timeoutMs: number,
        token: vscode.CancellationToken,
    ): Promise<Response> {
        const maxAttempts = this.configManager.getMaxRetries() + 1;
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // Network-level failure (DNS, connection reset, timeout, abort).
            try {
                const response = await this.fetchWithTimeout(url, init, timeoutMs, token);
                if (response.ok || !this.isRetryableStatus(response.status)) {
                    return response;
                }
                // Retryable HTTP status. Read the body ONCE — Response.text()
                // consumes the stream, and the caller re-reads it for the error
                // message on the final attempt.
                const retryAfterMs = this.parseRetryAfterMs(response.headers.get('retry-after'));
                const bodyText = await response.text().catch(() => '');
                if (attempt >= maxAttempts) {
                    // Final attempt: hand the caller a fresh Response with the
                    // same status/headers and the buffered body, so its
                    // response.text() in the error path still works.
                    return new Response(bodyText, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                }
                const delayMs = this.computeRetryDelayMs(attempt, retryAfterMs);
                this.notifyRetry(attempt, maxAttempts, delayMs, `HTTP ${response.status}`, retryAfterMs !== undefined);
                await this.sleep(delayMs, token);
                continue;
            } catch (err) {
                lastError = err;
                if (token.isCancellationRequested || attempt >= maxAttempts) {
                    throw err;
                }
                const delayMs = this.computeRetryDelayMs(attempt, undefined);
                this.notifyRetry(attempt, maxAttempts, delayMs, 'network error', false);
                await this.sleep(delayMs, token);
            }
        }
        throw lastError;
    }

    /** 429 and 5xx are worth retrying; everything else is a hard failure. */
    private isRetryableStatus(status: number): boolean {
        return status === 429 || status === 500 || status === 502 || status === 503;
    }

    /**
     * Parses the `Retry-After` header. Supports both delta-seconds and an
     * HTTP-date. Returns undefined when absent or unparsable.
     */
    private parseRetryAfterMs(value: string | null): number | undefined {
        return parseRetryAfterHeader(value);
    }

    /**
     * Computes the wait before the next attempt: server `Retry-After` wins;
     * otherwise exponential backoff (base × 2^(attempt-1)) with ±25% jitter,
     * capped at the configured maximum.
     */
    private computeRetryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
        return computeBackoffDelayMs({
            attempt,
            retryAfterMs,
            baseDelayMs: this.configManager.getRetryBaseDelayMs(),
            maxDelayMs: this.configManager.getRetryMaxDelayMs(),
        });
    }

    /** Logs the retry and shows a non-intrusive status notification. */
    private notifyRetry(
        attempt: number,
        maxAttempts: number,
        delayMs: number,
        reason: string,
        serverHinted: boolean,
    ): void {
        const seconds = (delayMs / 1000).toFixed(1);
        this.outputChannel.warn(
            `Retry ${attempt}/${maxAttempts - 1} after ${reason}: waiting ${seconds}s${serverHinted ? ' (server Retry-After)' : ''}`,
        );
        if (attempt === 1) {
            // Notify once per request — subsequent retries stay in the log.
            void vscode.window.showInformationMessage(
                `Kimi Copilot: rate limited by the API (${reason}). Retrying automatically — this may take a moment…`,
            );
        }
    }

    /** Sleep that resolves early when the request is cancelled. */
    private sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                disposable.dispose();
                resolve();
            }, ms);
            const disposable = token.onCancellationRequested(() => {
                clearTimeout(timer);
                resolve();
            });
        });
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

    // ── Error mapping ───────────────────────────────────────────────

    /**
     * Detects the Kimi Code API "request exceeded model token limit"
     * rejection (HTTP 400 with a context-length marker in the body).
     */
    private isContextLengthError(status: number, body: string): boolean {
        if (status !== 400) {
            return false;
        }
        const text = body.toLowerCase();
        return (
            text.includes('context_length_exceeded') ||
            text.includes('token limit') ||
            text.includes('context length') ||
            text.includes('maximum context')
        );
    }

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
            case 400:
                if (this.isContextLengthError(status, body)) {
                    return new vscode.LanguageModelError(
                        'The Kimi Code API rejected this request because it exceeds the per-request token limit, regardless of your subscription context window. Start a new chat session, run "/compact", or remove files from the context.',
                    );
                }
                return new vscode.LanguageModelError(
                    `Kimi API error ${status}: ${body.slice(0, 300)}`,
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

/**
 * Parses the `Retry-After` response header (RFC 9110 §10.2.3): either
 * delta-seconds or an HTTP-date. Returns milliseconds, or undefined when the
 * header is absent/unparsable. Pure — exported for unit tests.
 */
export function parseRetryAfterHeader(value: string | null | undefined): number | undefined {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    // Delta-seconds: a non-negative integer per RFC 9110 §10.2.3. A bare
    // signed number is NOT valid and must not fall through to Date.parse
    // (V8 happily parses '-3' as a timestamp in the past).
    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed) * 1000;
    }
    if (/^[+-]?\d*\.?\d+$/.test(trimmed)) {
        return undefined;
    }
    const date = Date.parse(trimmed);
    if (!Number.isNaN(date)) {
        return Math.max(0, date - Date.now());
    }
    return undefined;
}

export interface BackoffOptions {
    /** 1-based attempt number (the attempt that just failed). */
    attempt: number;
    /** Server-provided Retry-After in ms, when present — wins over backoff. */
    retryAfterMs?: number | undefined;
    /** Base delay for the first retry. */
    baseDelayMs: number;
    /** Cap for the computed backoff delay. */
    maxDelayMs: number;
    /** Jitter source, injectable for tests. Defaults to Math.random. */
    random?: () => number;
}

/**
 * Computes the wait before the next retry. Server `Retry-After` wins (capped
 * at 4× maxDelayMs so a hostile header cannot park the caller forever);
 * otherwise exponential backoff (base × 2^(attempt-1)) with ±25% jitter,
 * capped at maxDelayMs. Pure — exported for unit tests.
 */
export function computeBackoffDelayMs(options: BackoffOptions): number {
    if (options.retryAfterMs !== undefined) {
        return Math.min(options.retryAfterMs, options.maxDelayMs * 4);
    }
    const exponential = Math.min(
        options.baseDelayMs * 2 ** (options.attempt - 1),
        options.maxDelayMs,
    );
    const random = options.random ?? Math.random;
    const jitter = exponential * (0.75 + random() * 0.5);
    return Math.round(Math.min(jitter, options.maxDelayMs));
}

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
                reasoning_content?: string | null;
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

    // Reasoning / thinking content (non-streaming responses may include it)
    if (message.reasoning_content) {
        outputChannel.debug(`Kimi reasoning content in non-streaming response (${message.reasoning_content.length} chars)`);
        const reported = tryReportThinkingPart(progress, message.reasoning_content);
        if (!reported) {
            // Fallback: prepend thinking as a formatted text block
            outputChannel.debug('LanguageModelThinkingPart unavailable, using text fallback for reasoning content');
            progress.report(new vscode.LanguageModelTextPart(formatThinkingAsText(message.reasoning_content)));
        }
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

    // Fallback reasoning buffer — used when LanguageModelThinkingPart is unavailable.
    // Reasoning typically arrives before text content. We buffer it and flush at the
    // first text chunk (or at stream end) as a formatted markdown block.
    let fallbackReasoningBuffer: string | undefined;
    let thinkingPartAvailable: boolean | undefined; // undefined = not yet determined

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

    /** Flush accumulated fallback reasoning as a text part, if any. */
    const flushFallbackReasoning = (): void => {
        if (fallbackReasoningBuffer && fallbackReasoningBuffer.length > 0) {
            outputChannel.debug(`Flushing accumulated reasoning (${fallbackReasoningBuffer.length} chars) as text fallback`);
            progress.report(new vscode.LanguageModelTextPart(formatThinkingAsText(fallbackReasoningBuffer)));
            fallbackReasoningBuffer = undefined;
        }
    };

    /** Attempt to report a reasoning delta as a native thinking part. Falls back to buffering on error. */
    const handleReasoningDelta = (text: string): void => {
        if (thinkingPartAvailable === undefined) {
            // Probe once: try reporting natively. If it works, mark as available.
            // LanguageModelThinkingPart is a proposed API accessible at runtime
            // when GitHub.copilot-chat (which has it enabled) renders the response.
            // We do NOT declare it in enabledApiProposals — see package.json.
            const success = tryReportThinkingPart(progress, text);
            thinkingPartAvailable = success;
            if (success) {
                return; // already reported via tryReportThinkingPart
            }
        }
        if (thinkingPartAvailable) {
            // Proven available — report each subsequent delta natively
            tryReportThinkingPart(progress, text);
        } else {
            // Fallback: buffer until we hit text content or stream end
            fallbackReasoningBuffer = (fallbackReasoningBuffer ?? '') + text;
        }
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
                // Stream ended — flush any remaining fallback reasoning before tool calls
                if (fallbackReasoningBuffer) {
                    flushFallbackReasoning();
                }
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
                    if (fallbackReasoningBuffer) {
                        flushFallbackReasoning();
                    }
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

                    // Reasoning / thinking content (streaming delta)
                    if (delta.reasoning_content) {
                        outputChannel.debug(`Kimi reasoning delta received (${delta.reasoning_content.length} chars)`);
                        handleReasoningDelta(delta.reasoning_content);
                    }

                    // Text content
                    if (delta.content) {
                        // Flush any buffered fallback reasoning before the first text chunk
                        if (fallbackReasoningBuffer) {
                            flushFallbackReasoning();
                        }
                        if (thinkingPartAvailable === undefined) {
                            // No reasoning was seen — mark thinking as unavailable so we don't probe later
                            thinkingPartAvailable = false;
                        }
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
                        if (fallbackReasoningBuffer) {
                            flushFallbackReasoning();
                        }
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
