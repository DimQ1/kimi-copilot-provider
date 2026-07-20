import * as assert from 'assert';
import { SessionContextTracker, estimateTextTokens } from '../context-tracker';

suite('SessionContextTracker', () => {
	test('estimates text message tokens', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 1000,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		const estimate = tracker.estimate([{ role: 'user', content: 'hello world' }]);
		assert.strictEqual(estimate.tokens, estimateTextTokens('hello world') + 4);
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

	test('per-request cap stays at 262144 on a 1M subscription', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 1048576,
			singleRequestLimit: 262144,
			serverContextLength: 1048576,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		assert.strictEqual(tracker.getEffectiveLimit(), 1048576);
		assert.strictEqual(tracker.getRequestLimit(), 262144);
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

	test('formatStatus reflects status', () => {
		const tracker = new SessionContextTracker({
			maxInputTokens: 1000,
			warningThreshold: 0.8,
			errorThreshold: 0.95,
		});
		const ok = tracker.estimate([{ role: 'user', content: 'hi' }]);
		assert.ok(!tracker.formatStatus(ok).includes('warning'));

		const exceeded = tracker.estimate([{ role: 'user', content: 'a'.repeat(5000) }]);
		assert.ok(tracker.formatStatus(exceeded).includes('error'));
	});
});
