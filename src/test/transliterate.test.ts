import * as assert from 'assert';
import { transliterateCyrillic, transliterateMessages } from '../transliterate';
import type { KimiMessage } from '../types';

suite('transliterate', () => {
	test('converts common Cyrillic characters', () => {
		assert.strictEqual(transliterateCyrillic('Привет'), 'Privet');
		assert.strictEqual(transliterateCyrillic('Архитектура микросервисов'), 'Arkhitektura mikroservisov');
	});

	test('handles digraphs and soft/hard signs', () => {
		assert.strictEqual(transliterateCyrillic('щётка'), 'shchyotka');
		assert.strictEqual(transliterateCyrillic('жюри'), 'zhyuri');
		assert.strictEqual(transliterateCyrillic('объект'), 'obekt');
	});

	test('preserves case on multi-char mappings', () => {
		assert.strictEqual(transliterateCyrillic('Щука'), 'Shchuka');
		assert.strictEqual(transliterateCyrillic('Я'), 'Ya');
	});

	test('returns the same instance for pure-ASCII text (fast path)', () => {
		const ascii = 'hello world 123';
		assert.strictEqual(transliterateCyrillic(ascii), ascii);
	});

	test('leaves non-Cyrillic scripts untouched', () => {
		assert.strictEqual(transliterateCyrillic('你好'), '你好');
		assert.strictEqual(transliterateCyrillic('Οδυσσεύς'), 'Οδυσσεύς');
	});

	test('transliterates mixed content, keeps Latin intact', () => {
		assert.strictEqual(
			transliterateCyrillic('Use 함수 Функция with await'),
			'Use 함수 Funktsiya with await',
		);
	});

	test('transliterateMessages converts string content', () => {
		const messages: KimiMessage[] = [{ role: 'user', content: 'Привет мир' }];
		const changed = transliterateMessages(messages);
		assert.strictEqual(changed, 1);
		assert.strictEqual(messages[0].content, 'Privet mir');
	});

	test('transliterateMessages converts text parts but not images', () => {
		const messages: KimiMessage[] = [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'Что это?' },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
				],
			},
		];
		const changed = transliterateMessages(messages);
		assert.strictEqual(changed, 1);
		const parts = messages[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
		assert.strictEqual(parts[0].text, 'Chto eto?');
		assert.strictEqual(parts[1].image_url?.url, 'data:image/png;base64,abc');
	});

	test('transliterateMessages converts tool call arguments', () => {
		const messages: KimiMessage[] = [
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'call-1',
						type: 'function',
						function: { name: 'search', arguments: '{"q":"погода"}' },
					},
				],
			},
		];
		const changed = transliterateMessages(messages);
		assert.strictEqual(changed, 1);
		assert.strictEqual(messages[0].tool_calls?.[0].function.arguments, '{"q":"pogoda"}');
		// Tool call ids and function names are identifiers — never touched.
		assert.strictEqual(messages[0].tool_calls?.[0].id, 'call-1');
		assert.strictEqual(messages[0].tool_calls?.[0].function.name, 'search');
	});

	test('transliterateMessages reports 0 for pure-ASCII history', () => {
		const messages: KimiMessage[] = [
			{ role: 'system', content: 'You are helpful.' },
			{ role: 'user', content: 'hello' },
		];
		assert.strictEqual(transliterateMessages(messages), 0);
	});
});
