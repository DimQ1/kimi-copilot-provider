import * as assert from 'assert';
import { readBoundedResponseText, ResponseBodyTooLargeError } from '../response-body';

suite('readBoundedResponseText', () => {
	test('reads a response within the byte limit', async () => {
		const response = new Response('hello');
		assert.strictEqual(await readBoundedResponseText(response, 5), 'hello');
	});

	test('rejects a response declared above the byte limit', async () => {
		const response = new Response('hello', {
			headers: { 'content-length': '100' },
		});
		await assert.rejects(
			() => readBoundedResponseText(response, 5),
			ResponseBodyTooLargeError,
		);
	});

	test('stops a streamed response after crossing the byte limit', async () => {
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('1234'));
				controller.enqueue(new TextEncoder().encode('5678'));
				controller.close();
			},
		}));
		await assert.rejects(
			() => readBoundedResponseText(response, 6),
			ResponseBodyTooLargeError,
		);
	});
});
