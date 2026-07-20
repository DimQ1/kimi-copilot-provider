import type { KimiMessage } from './types';

// ═══════════════════════════════════════════════════════════════════════
// Cyrillic → Latin transliteration (optional context optimizer)
//
// Live API measurements (2026-07-20, kimi_api_docs.md) showed that
// Cyrillic text weighs ~5.3 bytes/token while its Latin transliteration
// weighs ~2.7 bytes/token — roughly a 2× reduction of the request body,
// with no measurable quality loss (K3 understands transliterated Russian
// and answers in Russian). Because the Kimi Code API hard-caps the
// request body at 2 MiB, transliteration almost doubles the effective
// context for Cyrillic-heavy chats.
//
// Enabled per model via `kimiCopilot.modelConfigs`: { "kimi-k3": {
// "transliterate": true } }.
// ═══════════════════════════════════════════════════════════════════════

/** Multi-character mappings are applied before single-character ones. */
const DIGRAPHS: ReadonlyArray<readonly [string, string]> = [
	['ё', 'yo'], ['Ё', 'Yo'],
	['ж', 'zh'], ['Ж', 'Zh'],
	['х', 'kh'], ['Х', 'Kh'],
	['ц', 'ts'], ['Ц', 'Ts'],
	['ч', 'ch'], ['Ч', 'Ch'],
	['ш', 'sh'], ['Ш', 'Sh'],
	['щ', 'shch'], ['Щ', 'Shch'],
	['ю', 'yu'], ['Ю', 'Yu'],
	['я', 'ya'], ['Я', 'Ya'],
];

const SINGLE: ReadonlyArray<readonly [string, string]> = [
	['а', 'a'], ['А', 'A'],
	['б', 'b'], ['Б', 'B'],
	['в', 'v'], ['В', 'V'],
	['г', 'g'], ['Г', 'G'],
	['д', 'd'], ['Д', 'D'],
	['е', 'e'], ['Е', 'E'],
	['з', 'z'], ['З', 'Z'],
	['и', 'i'], ['И', 'I'],
	['й', 'y'], ['Й', 'Y'],
	['к', 'k'], ['К', 'K'],
	['л', 'l'], ['Л', 'L'],
	['м', 'm'], ['М', 'M'],
	['н', 'n'], ['Н', 'N'],
	['о', 'o'], ['О', 'O'],
	['п', 'p'], ['П', 'P'],
	['р', 'r'], ['Р', 'R'],
	['с', 's'], ['С', 'S'],
	['т', 't'], ['Т', 'T'],
	['у', 'u'], ['У', 'U'],
	['ф', 'f'], ['Ф', 'F'],
	['ъ', ''], ['Ъ', ''],
	['ы', 'y'], ['Ы', 'Y'],
	['ь', ''], ['Ь', ''],
	['э', 'e'], ['Э', 'E'],
];

const ALL_MAPPINGS: ReadonlyArray<readonly [string, string]> = [...DIGRAPHS, ...SINGLE];

/** Matches any Cyrillic character — fast pre-check to skip pure-ASCII text. */
const CYRILLIC_RE = /[Ѐ-ӿ]/;

/** Transliterates Cyrillic characters in `text` to Latin (GOST-style). */
export function transliterateCyrillic(text: string): string {
	if (!CYRILLIC_RE.test(text)) {
		return text;
	}
	let result = text;
	for (const [from, to] of ALL_MAPPINGS) {
		result = result.split(from).join(to);
	}
	return result;
}

/**
 * Transliterates all textual content of converted Kimi messages in place
 * and returns the number of messages changed. Image payloads and tool call
 * ids/names are left untouched; tool arguments and results are converted
 * because they may carry user-authored Cyrillic text.
 */
export function transliterateMessages(messages: KimiMessage[]): number {
	let changed = 0;
	for (const message of messages) {
		let touched = false;
		if (typeof message.content === 'string') {
			const next = transliterateCyrillic(message.content);
			if (next !== message.content) {
				message.content = next;
				touched = true;
			}
		} else if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === 'text') {
					const next = transliterateCyrillic(part.text);
					if (next !== part.text) {
						part.text = next;
						touched = true;
					}
				}
			}
		}
		if (message.tool_calls) {
			for (const toolCall of message.tool_calls) {
				const next = transliterateCyrillic(toolCall.function.arguments);
				if (next !== toolCall.function.arguments) {
					toolCall.function.arguments = next;
					touched = true;
				}
			}
		}
		if (touched) {
			changed++;
		}
	}
	return changed;
}
