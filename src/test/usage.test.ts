import * as assert from 'assert';
import * as vscode from 'vscode';
import { UsageTracker, hasUsage, type UsageStats } from '../usage';

class FakeMemento implements vscode.Memento {
	private readonly storage = new Map<string, unknown>();

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return this.storage.has(key) ? (this.storage.get(key) as T) : defaultValue;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.storage.set(key, value);
	}

	keys(): readonly string[] {
		return Array.from(this.storage.keys());
	}
}

suite('UsageTracker', () => {
	let memento: FakeMemento;

	setup(() => {
		memento = new FakeMemento();
	});

	test('starts empty', () => {
		const tracker = new UsageTracker(memento);
		const stats = tracker.getStats();
		assert.strictEqual(stats.requestCount, 0);
		assert.strictEqual(stats.promptTokens, 0);
		assert.strictEqual(stats.completionTokens, 0);
		assert.strictEqual(stats.totalTokens, 0);
		assert.strictEqual(stats.cachedTokens, 0);
	});

	test('recordUsage aggregates tokens', () => {
		const tracker = new UsageTracker(memento);
		tracker.recordUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cached_tokens: 5 });
		tracker.recordUsage({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });

		const stats = tracker.getStats();
		assert.strictEqual(stats.requestCount, 2);
		assert.strictEqual(stats.promptTokens, 15);
		assert.strictEqual(stats.completionTokens, 25);
		assert.strictEqual(stats.totalTokens, 40);
		assert.strictEqual(stats.cachedTokens, 5);
	});

	test('recordUsage computes total_tokens when omitted', () => {
		const tracker = new UsageTracker(memento);
		tracker.recordUsage({ prompt_tokens: 7, completion_tokens: 3 });

		const stats = tracker.getStats();
		assert.strictEqual(stats.totalTokens, 10);
	});

	test('reset clears statistics', () => {
		const tracker = new UsageTracker(memento);
		tracker.recordUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
		tracker.reset();

		const stats = tracker.getStats();
		assert.strictEqual(stats.requestCount, 0);
		assert.strictEqual(stats.totalTokens, 0);
	});

	test('persists statistics to memento', async () => {
		const tracker = new UsageTracker(memento);
		tracker.recordUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
		// wait for async save
		await new Promise((resolve) => setTimeout(resolve, 10));

		const saved = memento.get<UsageStats>('kimiCopilot.usageStats');
		assert.ok(saved);
		assert.strictEqual(saved!.requestCount, 1);
		assert.strictEqual(saved!.totalTokens, 3);
	});

	test('fires onDidChange when recording usage', () => {
		const tracker = new UsageTracker(memento);
		let fired = false;
		const disposable = tracker.onDidChange(() => {
			fired = true;
		});

		tracker.recordUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
		assert.strictEqual(fired, true);
		disposable.dispose();
	});

	test('fires onDidChange when resetting', () => {
		const tracker = new UsageTracker(memento);
		let fired = false;
		const disposable = tracker.onDidChange(() => {
			fired = true;
		});

		tracker.reset();
		assert.strictEqual(fired, true);
		disposable.dispose();
	});

	test('getStatusBarText summarizes totals compactly', () => {
		const tracker = new UsageTracker(memento);
		tracker.recordUsage({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
		const text = tracker.getStatusBarText();
		assert.ok(text.includes('1.5k'));
		assert.ok(text.includes('1 req'));
	});
});

suite('hasUsage', () => {
	test('returns true for non-empty usage', () => {
		assert.strictEqual(hasUsage({ prompt_tokens: 1 }), true);
		assert.strictEqual(hasUsage({ completion_tokens: 1 }), true);
		assert.strictEqual(hasUsage({ total_tokens: 1 }), true);
	});

	test('returns false for empty or missing usage', () => {
		assert.strictEqual(hasUsage(undefined), false);
		assert.strictEqual(hasUsage(null), false);
		assert.strictEqual(hasUsage({}), false);
		assert.strictEqual(hasUsage({ prompt_tokens: 0 }), false);
	});
});
