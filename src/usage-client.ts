import type { KimiManagedUsage, KimiManagedUsageResult, KimiUsageRow, KimiBoosterWallet } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Kimi Code managed usage client
//
// Fetches quota / limits from the Kimi Code `/usages` endpoint. This is the
// same endpoint the official Kimi Code CLI uses for its /usage command.
//
// Endpoint: GET https://api.kimi.com/coding/v1/usages
// Headers:  Authorization: Bearer <token>
//           Accept: application/json
//
// The response shape is loose across versions; the parser tolerates both
// `used` and `remaining`, camelCase / snake_case field names, and nested
// detail/window objects.
// ═══════════════════════════════════════════════════════════════════════

export const DEFAULT_USAGE_ENDPOINT = 'https://api.kimi.com/coding/v1/usages';

const FIXED_POINT_CENTS = 1_000_000;

function fixedPointToCents(value: number): number {
	const cents = value / FIXED_POINT_CENTS;
	if (cents > 0 && cents < 1) return 1;
	return Math.round(cents);
}

function toInt(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? Math.trunc(value) : null;
	}
	if (typeof value === 'string') {
		const n = Number(value);
		return Number.isFinite(n) ? Math.trunc(n) : null;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMoney(raw: unknown): { cents: number; currency: string } | null {
	if (!isRecord(raw)) return null;
	const cents = toInt(raw['priceInCents']);
	if (cents === null) return null;
	const currency = typeof raw['currency'] === 'string' ? raw['currency'] : '';
	return { cents, currency };
}

function parseBoosterWallet(raw: unknown): KimiBoosterWallet | null {
	if (!isRecord(raw)) return null;
	const balance = raw['balance'];
	if (!isRecord(balance)) return null;
	if (balance['type'] !== 'BOOSTER') return null;

	const amountRaw = toInt(balance['amount']);
	if (amountRaw === null || amountRaw <= 0) return null;
	const totalCents = fixedPointToCents(amountRaw);

	const amountLeftRaw = toInt(balance['amountLeft']);
	const balanceCents = amountLeftRaw !== null ? fixedPointToCents(amountLeftRaw) : 0;

	const monthlyLimit = parseMoney(raw['monthlyChargeLimit']);
	const monthlyUsed = parseMoney(raw['monthlyUsed']);
	const monthlyChargeLimitEnabled = raw['monthlyChargeLimitEnabled'] === true;

	const currency =
		monthlyLimit && monthlyLimit.currency.length > 0
			? monthlyLimit.currency
			: monthlyUsed && monthlyUsed.currency.length > 0
				? monthlyUsed.currency
				: 'USD';

	return {
		balanceCents,
		totalCents,
		monthlyChargeLimitEnabled,
		monthlyChargeLimitCents: monthlyLimit?.cents ?? 0,
		monthlyUsedCents: monthlyUsed?.cents ?? 0,
		currency,
	};
}

function resetHintFrom(raw: Record<string, unknown>): string | undefined {
	for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
		const v = raw[key];
		if (typeof v === 'string' && v.length > 0) {
			return formatResetTime(v);
		}
	}
	for (const key of ['reset_in', 'resetIn', 'ttl', 'window']) {
		const seconds = toInt(raw[key]);
		if (seconds !== null && seconds > 0) {
			return `resets in ${formatDuration(seconds)}`;
		}
	}
	return undefined;
}

export function formatResetTime(val: string): string {
	let normalised = val;
	if (normalised.includes('.') && normalised.endsWith('Z')) {
		const [base, frac] = normalised.slice(0, -1).split('.');
		if (base !== undefined && frac !== undefined) {
			normalised = `${base}.${frac.slice(0, 3)}Z`;
		}
	}
	const parsed = Date.parse(normalised);
	if (!Number.isFinite(parsed)) return `resets at ${val}`;
	const diffSec = Math.floor((parsed - Date.now()) / 1000);
	if (diffSec <= 0) return 'reset';
	return `resets in ${formatDuration(diffSec)}`;
}

export function formatDuration(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s';
	const seconds = Math.floor(totalSeconds);
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	const parts: string[] = [];
	if (days) parts.push(`${String(days)}d`);
	if (hours) parts.push(`${String(hours)}h`);
	if (minutes) parts.push(`${String(minutes)}m`);
	if (secs && parts.length === 0) parts.push(`${String(secs)}s`);
	return parts.length > 0 ? parts.join(' ') : '0s';
}

function limitLabel(
	item: Record<string, unknown>,
	detail: Record<string, unknown>,
	window: Record<string, unknown>,
	idx: number,
): string {
	for (const key of ['name', 'title', 'scope']) {
		const v = item[key] ?? detail[key];
		if (typeof v === 'string' && v.length > 0) return v;
	}
	const duration = toInt(window['duration'] ?? item['duration'] ?? detail['duration']);
	const rawUnit = window['timeUnit'] ?? item['timeUnit'] ?? detail['timeUnit'];
	const timeUnit = typeof rawUnit === 'string' ? rawUnit : '';
	if (duration !== null) {
		if (timeUnit.includes('MINUTE')) {
			if (duration >= 60 && duration % 60 === 0) return `${String(duration / 60)}h limit`;
			return `${String(duration)}m limit`;
		}
		if (timeUnit.includes('HOUR')) return `${String(duration)}h limit`;
		if (timeUnit.includes('DAY')) return `${String(duration)}d limit`;
		return `${String(duration)}s limit`;
	}
	return `Limit #${String(idx + 1)}`;
}

function toUsageRow(raw: unknown, defaultLabel: string): KimiUsageRow | null {
	if (!isRecord(raw)) return null;
	const limit = toInt(raw['limit']);
	let used = toInt(raw['used']);
	if (used === null) {
		const remaining = toInt(raw['remaining']);
		if (remaining !== null && limit !== null) {
			used = limit - remaining;
		}
	}
	if (used === null && limit === null) return null;
	const name =
		typeof raw['name'] === 'string'
			? raw['name']
			: typeof raw['title'] === 'string'
				? raw['title']
				: defaultLabel;
	return {
		label: name,
		used: used ?? 0,
		limit: limit ?? 0,
		resetHint: resetHintFrom(raw),
	};
}

export function parseManagedUsagePayload(payload: unknown): KimiManagedUsage {
	if (!isRecord(payload)) {
		return { summary: null, limits: [], extraUsage: null };
	}
	const summary = toUsageRow(payload['usage'], 'Weekly limit');
	const limits: KimiUsageRow[] = [];
	const rawLimits = payload['limits'];
	if (Array.isArray(rawLimits)) {
		for (let idx = 0; idx < rawLimits.length; idx++) {
			const item = rawLimits[idx];
			if (!isRecord(item)) continue;
			const detailRaw = item['detail'];
			const detail = isRecord(detailRaw) ? detailRaw : item;
			const windowRaw = item['window'];
			const window = isRecord(windowRaw) ? windowRaw : {};
			const label = limitLabel(item, detail, window, idx);
			const row = toUsageRow(detail, label);
			if (row !== null) limits.push(row);
		}
	}
	return { summary, limits, extraUsage: parseBoosterWallet(payload['boosterWallet']) };
}

export interface UsageClientOptions {
	endpoint?: string;
	timeoutMs?: number;
}

export class KimiUsageClient {
	constructor(private readonly options: UsageClientOptions = {}) {}

	async fetchUsage(accessToken: string): Promise<KimiManagedUsageResult> {
		const endpoint = this.options.endpoint ?? DEFAULT_USAGE_ENDPOINT;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8000);
		try {
			const res = await fetch(endpoint, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
				},
				signal: controller.signal,
			});
			if (!res.ok) {
				const status = res.status;
				let message: string;
				if (status === 401) {
					message = 'Kimi usage endpoint unauthorized. Please check your API key.';
				} else if (status === 404) {
					message = 'Usage endpoint not available for this API key type.';
				} else {
					message = `Failed to fetch Kimi usage: HTTP ${String(status)}`;
				}
				const body = await res.text().catch(() => '');
				if (body) {
					try {
						const json = JSON.parse(body) as { error?: { message?: string } };
						if (json.error?.message) message = json.error.message;
					} catch {
						// ignore
					}
				}
				return { kind: 'error', status, message };
			}
			const json: unknown = await res.json();
			return { kind: 'ok', usage: parseManagedUsagePayload(json) };
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				return { kind: 'error', message: 'Failed to fetch Kimi usage: request timed out.' };
			}
			const msg = error instanceof Error ? error.message : String(error);
			return { kind: 'error', message: `Failed to fetch Kimi usage: ${msg}` };
		} finally {
			clearTimeout(timer);
		}
	}
}
