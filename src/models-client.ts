import type { KimiServerModelInfo, ModelDefinition } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Kimi Code managed /models client
//
// Fetches the live model catalog from the Kimi Code `/models` endpoint
// using the user's API key. This is the same endpoint the official Kimi
// Code CLI refreshes its config.toml model table from.
//
// Endpoint: GET https://api.kimi.com/coding/v1/models
// Headers:  Authorization: Bearer <api key>
//           Accept: application/json
//
// The server resolves the catalog per token: `context_length` (and even
// model availability) may differ between subscription plans, so values
// returned here take precedence over the hard-coded MODELS table.
// ═══════════════════════════════════════════════════════════════════════

export type KimiModelsFetchResult =
	| { kind: 'ok'; models: readonly KimiServerModelInfo[] }
	| { kind: 'error'; status?: number; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
	return out.length > 0 ? out : undefined;
}

/** Parse the nested `think_efforts` object: { support, valid_efforts, default_effort }. */
function parseThinkEfforts(value: unknown): {
	supportEfforts: readonly string[] | undefined;
	defaultEffort: string | undefined;
} {
	if (!isRecord(value) || value['support'] !== true) {
		return { supportEfforts: undefined, defaultEffort: undefined };
	}
	const rawDefault = value['default_effort'];
	return {
		supportEfforts: parseStringArray(value['valid_efforts']),
		defaultEffort:
			typeof rawDefault === 'string' && rawDefault.length > 0 ? rawDefault : undefined,
	};
}

function toModelInfo(item: unknown): KimiServerModelInfo | undefined {
	if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
		return undefined;
	}
	const contextLength = Number(item['context_length']);
	if (!Number.isInteger(contextLength) || contextLength <= 0) {
		return undefined;
	}
	const displayName = item['display_name'];
	const thinkEfforts = parseThinkEfforts(item['think_efforts']);
	const thinkingType = item['supports_thinking_type'];
	return {
		id: item['id'],
		contextLength,
		supportsReasoning: Boolean(item['supports_reasoning']),
		supportsImageIn: Boolean(item['supports_image_in']),
		supportsVideoIn: Boolean(item['supports_video_in']),
		supportsToolUse: Object.hasOwn(item, 'supports_tool_use')
			? Boolean(item['supports_tool_use'])
			: true,
		displayName:
			typeof displayName === 'string' && displayName.length > 0 ? displayName : undefined,
		supportsThinkingType:
			thinkingType === 'only' || thinkingType === 'no' || thinkingType === 'both'
				? thinkingType
				: undefined,
		supportEfforts: thinkEfforts.supportEfforts ? [...thinkEfforts.supportEfforts] : undefined,
		defaultEffort: thinkEfforts.defaultEffort,
	};
}

/**
 * GET {modelsEndpoint} with Bearer auth. Returns a discriminated result so
 * callers can degrade gracefully (401/402/403 = credential/subscription
 * problems, everything else = transient or schema issues).
 */
export async function fetchKimiModels(
	apiKey: string,
	modelsEndpoint: string,
	timeoutMs = 15000,
): Promise<KimiModelsFetchResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(modelsEndpoint, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: 'application/json',
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return {
				kind: 'error',
				status: response.status,
				message: `GET /models failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
			};
		}
		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload['data'])) {
			return { kind: 'error', message: 'Unexpected /models response shape.' };
		}
		const models = payload['data']
			.map(toModelInfo)
			.filter((m): m is KimiServerModelInfo => m !== undefined);
		if (models.length === 0) {
			return { kind: 'error', message: 'The /models response contained no usable models.' };
		}
		return { kind: 'ok', models };
	} catch (error) {
		const message =
			controller.signal.aborted
				? `GET /models timed out after ${timeoutMs}ms`
				: error instanceof Error
					? error.message
					: String(error);
		return { kind: 'error', message };
	} finally {
		clearTimeout(timer);
	}
}

// ── Mapping API model ids → picker model ids ─────────────────────────────
//
// The /models payload uses API ids (`k3`, `kimi-for-coding`, ...), while the
// picker registry in models.ts is keyed by VS Code picker ids (`kimi-k3`,
// `kimi-k2.7-code`, ...). Explicit pairs cover the known catalog; the
// fallback also accepts a direct id match so custom deployments work.
const API_TO_PICKER_ID: Readonly<Record<string, string>> = {
	'k3': 'kimi-k3',
	'kimi-for-coding': 'kimi-k2.7-code',
	'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed',
};

function findPickerModel(
	apiModel: KimiServerModelInfo,
	registry: readonly ModelDefinition[],
): ModelDefinition | undefined {
	const mapped = API_TO_PICKER_ID[apiModel.id];
	if (mapped) {
		const byMapping = registry.find((m) => m.id === mapped);
		if (byMapping) return byMapping;
	}
	return registry.find((m) => m.id === apiModel.id);
}

function clampEffort(
	effort: string | undefined,
	valid: readonly string[] | undefined,
): 'low' | 'high' | 'max' | undefined {
	if (effort === 'low' || effort === 'high' || effort === 'max') {
		if (valid && valid.length > 0 && !valid.includes(effort)) return undefined;
		return effort;
	}
	return undefined;
}

/**
 * Applies the server-returned catalog on top of the hard-coded registry.
 * Only fields the server actually declares are overwritten; pricing, request
 * policy and other local-only metadata survive. Returns a NEW array — the
 * input registry is not mutated.
 */
export function applyServerModels(
	registry: readonly ModelDefinition[],
	serverModels: readonly KimiServerModelInfo[],
): ModelDefinition[] {
	return registry.map((local) => {
		const server = serverModels.find((s) => findPickerModel(s, [local]) !== undefined);
		if (!server) return local;

		const next: ModelDefinition = { ...local, capabilities: { ...local.capabilities } };

		// Context window comes from the server (per-subscription value) and is
		// the source of truth for the session limit — no manual plan hint needed.
		next.maxInputTokens = server.contextLength;
		next.serverContextLength = server.contextLength;
		if (local.multiTierContext) {
			// The per-request cap never exceeds the context window.
			next.multiTierContext = {
				default: Math.min(local.multiTierContext.default, server.contextLength),
				allegretto: server.contextLength,
			};
		}
		if (local.singleRequestLimit !== undefined) {
			// No fixed per-request token cap below the context window: the
			// cap follows the subscription window and only shrinks when the
			// server window is smaller. The 2 MiB body cap is the real stop.
			next.singleRequestLimit = Math.min(local.singleRequestLimit, server.contextLength);
		}

		// Capabilities declared by the server.
		next.capabilities = {
			toolCalling: server.supportsToolUse,
			imageInput: server.supportsImageIn,
			thinking: server.supportsReasoning,
		};
		if (server.supportsThinkingType !== undefined) {
			next.supportsThinkingType = server.supportsThinkingType;
		}

		// Reasoning effort levels (only when the server declares them). The
		// server default_effort wins over the hard-coded default — e.g. K3
		// ships default_effort: "high" while the local table says "max".
		if (server.supportEfforts && server.supportEfforts.length > 0) {
			const defaultEffort = clampEffort(server.defaultEffort, server.supportEfforts);
			if (defaultEffort !== undefined) {
				next.defaults = { ...local.defaults, reasoningEffort: defaultEffort };
			}
		}

		return next;
	});
}
