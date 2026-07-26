/**
 * Tool call ID sanitization for Kimi API compatibility.
 *
 * Kimi API requires tool call IDs to be at most 64 characters and contain
 * only alphanumeric characters, underscores, and hyphens. VS Code / Copilot
 * Chat may produce IDs that exceed these limits.
 *
 * Ported from kimi-code: packages/kosong/src/providers/tool-call-id.ts
 */

import type { KimiMessage, KimiToolCall } from './types';

const TOOL_CALL_ID_SAFE_CHARS = /[^a-zA-Z0-9_-]/g;
const KIMI_TOOL_CALL_ID_MAX_LENGTH = 64;

/**
 * Sanitize a single tool call ID: replace unsafe chars with `_` and truncate.
 */
export function sanitizeToolCallId(id: string, maxLength = KIMI_TOOL_CALL_ID_MAX_LENGTH): string {
  const sanitized = id.replace(TOOL_CALL_ID_SAFE_CHARS, '_');
  if (maxLength > 0 && sanitized.length > maxLength) {
    return sanitized.slice(0, maxLength);
  }
  return sanitized;
}

/**
 * Normalize all tool call IDs across a conversation history to be Kimi-safe.
 * Returns the normalized messages (or the original array if no changes needed).
 */
export function normalizeToolCallIds(messages: KimiMessage[]): KimiMessage[] {
  const ids = collectToolCallIds(messages);
  if (ids.length === 0) return messages;

  const mappedIds = buildToolCallIdMap(ids);
  let changed = false;

  const normalized = messages.map((message) => {
    let messageChanged = false;

    let toolCalls: KimiToolCall[] | undefined = message.tool_calls;
    if (message.tool_calls && message.tool_calls.length > 0) {
      toolCalls = message.tool_calls.map((tc) => {
        const mappedId = mappedIds.get(tc.id);
        if (mappedId === undefined || mappedId === tc.id) return tc;
        messageChanged = true;
        return { ...tc, id: mappedId };
      });
    }

    const mappedCallId =
      message.tool_call_id !== undefined ? mappedIds.get(message.tool_call_id) : undefined;
    const newToolCallId = mappedCallId ?? message.tool_call_id;

    if (!messageChanged && newToolCallId === message.tool_call_id) return message;
    changed = true;
    return { ...message, tool_calls: toolCalls, tool_call_id: newToolCallId };
  });

  return changed ? normalized : messages;
}

function collectToolCallIds(messages: KimiMessage[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const append = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  for (const message of messages) {
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        append(tc.id);
      }
    }
    if (message.tool_call_id !== undefined) {
      append(message.tool_call_id);
    }
  }

  return ids;
}

function buildToolCallIdMap(rawIds: string[]): Map<string, string> {
  const mapped = new Map<string, string>();
  const usedIds = new Set<string>();

  // First pass: keep IDs that are already safe
  for (const rawId of rawIds) {
    const normalized = sanitizeToolCallId(rawId);
    if (normalized === rawId && normalized.length > 0) {
      mapped.set(rawId, normalized);
      usedIds.add(normalized);
    }
  }

  // Second pass: deduplicate and make unique
  for (const rawId of rawIds) {
    if (mapped.has(rawId)) continue;
    const normalized = sanitizeToolCallId(rawId);
    const unique = makeUniqueId(normalized, usedIds);
    mapped.set(rawId, unique);
    usedIds.add(unique);
  }

  return mapped;
}

function makeUniqueId(base: string, usedIds: Set<string>): string {
  const candidate = base.length > 0 ? base : 'tool_call';
  if (!usedIds.has(candidate)) return candidate;

  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const maxBaseLen = KIMI_TOOL_CALL_ID_MAX_LENGTH - suffix.length;
    const truncated = maxBaseLen > 0 ? candidate.slice(0, maxBaseLen) : candidate;
    const suffixed = `${truncated}${suffix}`;
    if (!usedIds.has(suffixed)) return suffixed;
  }
}
