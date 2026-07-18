import * as assert from 'assert';
import {
	KimiUsageClient,
	parseManagedUsagePayload,
	formatResetTime,
	formatDuration,
} from '../usage-client';
import type { KimiManagedUsage } from '../types';

suite('parseManagedUsagePayload', () => {
	test('parses the live Kimi /usages response shape', () => {
		const payload = {
			user: { userId: 'u123', region: 'REGION_OVERSEA', membership: { level: 'LEVEL_INTERMEDIATE' } },
			usage: { limit: '100', used: '41', remaining: '59', resetTime: '2026-07-24T10:12:49.684822Z' },
			limits: [
				{
					window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
					detail: { limit: '100', used: '3', remaining: '97', resetTime: '2026-07-18T15:00:00Z' },
				},
			],
			parallel: { limit: '20' },
			totalQuota: { limit: '100', remaining: '99' },
			authentication: { method: 'METHOD_API_KEY', scope: 'FEATURE_CODING' },
			subType: 'TYPE_PURCHASE',
		};

		const parsed = parseManagedUsagePayload(payload);
		assert.ok(parsed.summary);
		assert.strictEqual(parsed.summary!.used, 41);
		assert.strictEqual(parsed.summary!.limit, 100);
		assert.ok(parsed.summary!.resetHint);

		assert.strictEqual(parsed.limits.length, 1);
		assert.strictEqual(parsed.limits[0]!.label, '5h limit');
		assert.strictEqual(parsed.limits[0]!.used, 3);
		assert.strictEqual(parsed.limits[0]!.limit, 100);
		assert.strictEqual(parsed.extraUsage, null);
	});

	test('parses booster wallet when present', () => {
		const payload = {
			usage: { limit: '100', used: '0' },
			boosterWallet: {
				balance: { type: 'BOOSTER', amount: 500000000, amountLeft: 250000000 },
				monthlyChargeLimit: { priceInCents: 10000, currency: 'USD' },
				monthlyUsed: { priceInCents: 2500, currency: 'USD' },
				monthlyChargeLimitEnabled: true,
			},
		};

		const parsed = parseManagedUsagePayload(payload);
		assert.ok(parsed.extraUsage);
		assert.strictEqual(parsed.extraUsage!.balanceCents, 250);
		assert.strictEqual(parsed.extraUsage!.totalCents, 500);
		assert.strictEqual(parsed.extraUsage!.monthlyChargeLimitCents, 10000);
		assert.strictEqual(parsed.extraUsage!.monthlyUsedCents, 2500);
		assert.strictEqual(parsed.extraUsage!.currency, 'USD');
		assert.strictEqual(parsed.extraUsage!.monthlyChargeLimitEnabled, true);
	});

	test('computes used from remaining when used is missing', () => {
		const parsed = parseManagedUsagePayload({ usage: { limit: '50', remaining: '20' } });
		assert.strictEqual(parsed.summary!.used, 30);
		assert.strictEqual(parsed.summary!.limit, 50);
	});

	test('returns empty result for non-object payload', () => {
		const parsed = parseManagedUsagePayload(null);
		assert.strictEqual(parsed.summary, null);
		assert.deepStrictEqual(parsed.limits, []);
	});
});

suite('formatDuration', () => {
	test('formats days, hours, minutes', () => {
		assert.strictEqual(formatDuration(90061), '1d 1h 1m');
		assert.strictEqual(formatDuration(3661), '1h 1m');
		assert.strictEqual(formatDuration(59), '59s');
	});

	test('returns 0s for zero or invalid input', () => {
		assert.strictEqual(formatDuration(0), '0s');
		assert.strictEqual(formatDuration(-10), '0s');
	});
});

suite('formatResetTime', () => {
	test('formats ISO reset time as relative duration', () => {
		const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
		const text = formatResetTime(future.toISOString());
		assert.ok(text.startsWith('resets in'));
	});

	test('returns reset for past timestamps', () => {
		const past = new Date(Date.now() - 1000).toISOString();
		assert.strictEqual(formatResetTime(past), 'reset');
	});
});

suite('KimiUsageClient', () => {
	function buildFetchStub(response: unknown, ok = true, status = 200) {
		return async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
			return {
				ok,
				status,
				json: async () => response,
				text: async () => JSON.stringify(response),
			} as Response;
		};
	}

	async function withFetchStub(stub: typeof fetch, action: () => Promise<void>): Promise<void> {
		const original = globalThis.fetch;
		globalThis.fetch = stub as typeof fetch;
		try {
			await action();
		} finally {
			globalThis.fetch = original;
		}
	}

	test('fetchUsage returns parsed usage on 200', async () => {
		const usage: KimiManagedUsage = {
			summary: { label: 'Weekly limit', used: 10, limit: 100 },
			limits: [],
			extraUsage: null,
		};
		await withFetchStub(buildFetchStub({ usage: { limit: '100', used: '10' } }), async () => {
			const client = new KimiUsageClient();
			const result = await client.fetchUsage('sk-test');
			assert.strictEqual(result.kind, 'ok');
			if (result.kind === 'ok') {
				assert.strictEqual(result.usage.summary!.used, usage.summary!.used);
				assert.strictEqual(result.usage.summary!.limit, usage.summary!.limit);
			}
		});
	});

	test('fetchUsage returns error on 401', async () => {
		await withFetchStub(buildFetchStub({}, false, 401), async () => {
			const client = new KimiUsageClient({ timeoutMs: 1000 });
			const result = await client.fetchUsage('sk-test');
			assert.strictEqual(result.kind, 'error');
			if (result.kind === 'error') {
				assert.ok(result.message.includes('unauthorized'));
				assert.strictEqual(result.status, 401);
			}
		});
	});
});
