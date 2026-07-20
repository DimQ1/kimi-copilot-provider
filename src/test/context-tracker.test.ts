import * as assert from 'assert';
import { SessionContextTracker, estimateRequestBodyBytes, formatBytes, DEFAULT_MAX_BODY_BYTES } from '../context-tracker';

suite('SessionContextTracker', () => {
	test('estimates text message tokens', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 1000,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		const estimate = tracker.estimate([{ role: 'user', content: 'hello world' }]);
		assert.strictEqual(estimate.tokens, Math.ceil('hello world'.length / 3.5) + 4);
		assert.strictEqual(estimate.limit, 1000);
		assert.strictEqual(estimate.status, 'ok');
	});

	test('warns when crossing warning threshold', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 1000,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		const longText = 'a'.repeat(820 * 4); // ~937 tokens
		const estimate = tracker.estimate([{ role: 'user', content: longText }]);
		assert.ok(estimate.ratio >= 0.8);
		assert.strictEqual(estimate.status, 'warning');
	});

	test('exceeds when over limit', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 100,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		const estimate = tracker.estimate([{ role: 'user', content: 'a'.repeat(500) }]);
		assert.strictEqual(estimate.status, 'exceeded');
		assert.throws(() => tracker.check([{ role: 'user', content: 'a'.repeat(500) }]));
	});

	test('uses singleRequestLimit when set', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 1000000,
			singleRequestLimit: 262144,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		assert.strictEqual(tracker.getEffectiveLimit(), 262144);
	});

	test('uses higher tier context for Allegretto+ plan', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 262144,
			singleRequestLimit: 262144,
			multiTierContext: { default: 262144, allegretto: 1048576 },
			warningThreshold: 0.8,
			errorThreshold: 0.95,
			plan: 'allegretto',
		});
		assert.strictEqual(tracker.getEffectiveLimit(), 1048576);
	});

	test('server context length wins over the manual plan hint', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 262144,
			singleRequestLimit: 262144,
			multiTierContext: { default: 262144, allegretto: 1048576 },
			serverContextLength: 1048576,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
			// No plan hint — the server value alone must unlock the full window.
		});
		assert.strictEqual(tracker.getEffectiveLimit(), 1048576);
	});

	test('server context length also wins over a lower plan hint', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 262144,
			singleRequestLimit: 262144,
			multiTierContext: { default: 262144, allegretto: 1048576 },
			serverContextLength: 262144,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
			plan: 'allegretto', // stale hint after a downgrade
		});
		assert.strictEqual(tracker.getEffectiveLimit(), 262144);
	});

	test('per-request cap follows the 1M session window', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 1048576,
			singleRequestLimit: 1048576,
			serverContextLength: 1048576,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		assert.strictEqual(tracker.getEffectiveLimit(), 1048576);
		assert.strictEqual(tracker.getRequestLimit(), 1048576);
	});

	test('per-request cap shrinks with a smaller server window', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 131072,
			singleRequestLimit: 262144,
			serverContextLength: 131072,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		assert.strictEqual(tracker.getRequestLimit(), 131072);
	});

	test('check() rejects a request above the per-request cap on a 1M plan', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 1048576,
			singleRequestLimit: 1000,
			serverContextLength: 1048576,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		// ~1429 tokens: inside the 1M session window but above the request cap.
		const messages = [{ role: 'user' as const, content: 'a'.repeat(5000) }];
		const estimate = tracker.estimate(messages);
		assert.strictEqual(estimate.status, 'ok');
		assert.throws(
			() => tracker.check(messages),
			(err: Error) => err.message.includes('per-request limit'),
		);
	});

	test('conservative estimate for image parts', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 10000,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		const estimate = tracker.estimate([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'What is this?' },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
				],
			},
		]);
		assert.ok(estimate.tokens >= 1024 + 4 + 4);
	});

	suite('request body byte limit (2 MiB API cap)', () => {
		test('estimateRequestBodyBytes counts UTF-8 bytes, not characters', () => {
			// '你' is 1 char but 3 bytes in UTF-8 — the API cap is on bytes.
			const ascii = estimateRequestBodyBytes([{ role: 'user', content: 'a'.repeat(100) }]);
			const cjk = estimateRequestBodyBytes([{ role: 'user', content: '你'.repeat(100) }]);
			assert.ok(cjk > ascii, `CJK (${cjk}) should weigh more than ASCII (${ascii})`);
			assert.strictEqual(cjk - ascii, 200);
		});

		test('exceeded when body crosses the byte cap while tokens fit', () => {
			const tracker = new SessionContextTracker({
				maxInputTokens: 1048576,
				warningThreshold: 0.8,
				errorThreshold: 0.95,
			});
			// 3-byte chars: 700_000 chars ≈ 2.1 MB body, but only ~200K tokens.
			const big = '你'.repeat(700_000);
			const estimate = tracker.estimate([{ role: 'user', content: big }]);
			assert.ok(estimate.bodyBytes >= DEFAULT_MAX_BODY_BYTES);
			assert.strictEqual(estimate.status, 'exceeded');
			assert.throws(
				() => tracker.check([{ role: 'user', content: big }]),
				(err: Error) => err.message.includes('request-size limit'),
			);
		});

		test('byte limit is overridable', () => {
			const tracker = new SessionContextTracker({
				maxInputTokens: 1048576,
				warningThreshold: 0.8,
				errorThreshold: 0.95,
				maxBodyBytes: 1024,
			});
			const estimate = tracker.estimate([{ role: 'user', content: 'a'.repeat(2000) }]);
			assert.strictEqual(estimate.status, 'exceeded');
		});

		test('estimate includes bodyBytes and byteRatio', () => {
			const tracker = new SessionContextTracker({
				maxInputTokens: 1048576,
				warningThreshold: 0.8,
				errorThreshold: 0.95,
			});
			const estimate = tracker.estimate([{ role: 'user', content: 'hello' }]);
			assert.ok(estimate.bodyBytes > 0);
			assert.ok(estimate.byteRatio >= 0 && estimate.byteRatio <= 1);
			assert.strictEqual(estimate.status, 'ok');
		});

		test('formatBytes renders KiB/MiB', () => {
			assert.strictEqual(formatBytes(500), '500 B');
			assert.strictEqual(formatBytes(2048), '2.0 KiB');
			assert.strictEqual(formatBytes(2 * 1024 * 1024), '2.00 MiB');
		});
	});
});
