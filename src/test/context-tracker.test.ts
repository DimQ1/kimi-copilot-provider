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
		const longText = 'a'.repeat(820 * 3); // ~820 tokens
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
