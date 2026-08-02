import * as assert from 'assert';
import { wrapAsyncIterableWithCleanup } from '../api-client';

suite('API client stream lifecycle', () => {
	test('cleans up after a stream is fully consumed', async () => {
		let cleanupCount = 0;
		const source = {
			async *[Symbol.asyncIterator](): AsyncIterator<number> {
				yield 1;
				yield 2;
			},
		};

		const values: number[] = [];
		for await (const value of wrapAsyncIterableWithCleanup(source, () => cleanupCount++)) {
			values.push(value);
		}

		assert.deepStrictEqual(values, [1, 2]);
		assert.strictEqual(cleanupCount, 1);
	});

	test('cleans up when the consumer stops early', async () => {
		let cleanupCount = 0;
		const source = {
			async *[Symbol.asyncIterator](): AsyncIterator<number> {
				yield 1;
				yield 2;
			},
		};

		const iterator = wrapAsyncIterableWithCleanup(source, () => cleanupCount++)[
			Symbol.asyncIterator
		]();
		await iterator.next();
		await iterator.return?.();

		assert.strictEqual(cleanupCount, 1);
	});
});
