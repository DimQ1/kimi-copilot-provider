/**
 * The OpenAI-compatible Chat Completions ecosystem never standardized a wire
 * field for reasoning/thinking content. Three names circulate in the wild:
 *
 * - `reasoning_content` — DeepSeek's original convention, used by the Moonshot
 *   Kimi API, pre-rename vLLM, and most OpenAI-compatible gateways.
 * - `reasoning_details` — OpenRouter.
 * - `reasoning` — OpenAI's GPT-OSS guidance; current vLLM renamed to this.
 *
 * Inbound we accept any of them via a priority scan; outbound we echo back the
 * dialect the peer actually spoke, learned per endpoint by ReasoningKeyDialect.
 *
 * Ported from kimi-code: packages/kosong/src/providers/reasoning-key.ts
 */

// Inbound scan order; the first entry doubles as the default outbound dialect.
export const KNOWN_REASONING_KEYS = [
  'reasoning_content',
  'reasoning_details',
  'reasoning',
] as const;

export type ReasoningKey = (typeof KNOWN_REASONING_KEYS)[number];

export const DEFAULT_REASONING_KEY: ReasoningKey = KNOWN_REASONING_KEYS[0];

/**
 * Find the reasoning text on an inbound chat-completions message or stream
 * delta, returning the wire key it was found under.
 */
export function extractReasoning(
  source: unknown,
  explicitKey?: string,
): { key: string; value: string } | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const keys: readonly string[] = explicitKey !== undefined ? [explicitKey] : KNOWN_REASONING_KEYS;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return { key, value };
  }
  return undefined;
}

/**
 * Per-endpoint reasoning-field dialect: observes inbound responses, remembers
 * which wire key carried reasoning, and echoes that key when serializing
 * thinking back into outbound messages ("reply in the dialect the peer spoke").
 *
 * Precedence: an explicit constructor key always wins and disables detection;
 * otherwise the last observed key; otherwise DEFAULT_REASONING_KEY.
 */
export class ReasoningKeyDialect {
  private _detected: string | undefined;

  constructor(private readonly _explicitKey?: string) {}

  /**
   * Extract reasoning text from an inbound message or stream delta, remembering
   * the key it arrived under (unless an explicit key pins the dialect).
   */
  observe(source: unknown): string | undefined {
    const found = extractReasoning(source, this._explicitKey);
    if (found === undefined) return undefined;
    if (this._explicitKey === undefined) {
      this._detected = found.key;
    }
    return found.value;
  }

  /** The wire key to serialize thinking content into on outbound messages. */
  outboundKey(): string {
    return this._explicitKey ?? this._detected ?? DEFAULT_REASONING_KEY;
  }
}
