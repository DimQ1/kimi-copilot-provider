# AGENTS.md — Kimi Copilot Provider

VS Code extension that registers **Kimi K2/K2.7 Code** models as custom `LanguageModelChatProvider` for GitHub Copilot Chat. Proxies chat requests to the Kimi API via SSE streaming.

## Quick Reference

| Task | Command |
|---|---|
| Compile (once) | `npm run compile` |
| Compile (watch) | `npm run watch` |
| Launch extension | `F5` (Extension Development Host) |
| Package .vsix | `npx @vscode/vsce package --no-dependencies` |

## Versioning (REQUIRED on every local release)

**Always bump `version` in `package.json` before packaging a `.vsix` for local install.** VS Code caches extensions by version — reinstalling the same version number may keep the old build, so the new code silently won't load.

Rules:
- Bump the **patch** number for every local test build (`1.8.0` → `1.8.1` → `1.8.2`…). Use minor/major only for real public releases.
- The `.vsix` filename embeds the version, so a fresh number makes it obvious which build is installed.
- Verify with `code --list-extensions --show-versions | findstr kimi` after `code --install-extension --force`.
- Update `CHANGELOG.md` under a matching version heading (or an `Unreleased` section) when the change is user-facing.

## Supported Models

K3 uses `kimi-k3`, up to 1M context, `max_completion_tokens`, and `reasoning_effort`. It always has thinking enabled, omits K2.x fixed sampling parameters, and accepts image data as base64 content parts. Live probing (2026-07-20) confirmed the API accepts a full 1M-token prompt on higher tiers — there is NO fixed per-request token cap below the context window. The only hard per-request stop is the **2 MiB request body limit** (no gzip/brotli support), which the context tracker enforces as a byte guard.

| Picker ID | API Model | Context | Notes |
|---|---|---|---|
| `kimi-k3` | `kimi-k3` | 1M (512K fallback before the /models catalog loads) | Native vision, tool calling, reasoning effort; **limited only by the 2 MiB request body** |
| `kimi-k2.7-code` | `kimi-k2.7-code` | 256K | Default coding model, thinking required |
| `kimi-k2.7-code-highspeed` | `kimi-k2.7-code-highspeed` | 256K | Faster output (~180 T/s) |
| `kimi-k2.6` | `kimi-k2.6` | 256K | Multimodal + thinking |
| `kimi-k2.5` | `kimi-k2.5` | 256K | Multimodal + thinking |

## Architecture

```
src/
├── config.ts      # ConfigurationManager: settings + SecretStorage API key
├── extension.ts   # activate(): registers provider and commands
├── models.ts      # Model registry + LanguageModelChatInformation mapping
├── provider.ts    # KimiChatProvider implements LanguageModelChatProvider
└── types.ts       # Shared API and model types
```

Provider implements 3 mandatory methods of `LanguageModelChatProvider<T>`:
1. **`provideLanguageModelChatInformation`** — returns `LanguageModelChatInformation[]` (model metadata)
2. **`provideLanguageModelChatResponse`** — streams response via `Progress<LanguageModelResponsePart>` callback
3. **`provideTokenCount`** — estimates token count

Kimi API: `POST https://api.kimi.com/coding/v1/chat/completions`, auth via `Bearer sk-kimi-...`, SSE `data:` streaming.
Response format: OpenAI-compatible `{"choices":[{"delta":{"content":"..."}}]}` with `data: [DONE]` terminator.

Local usage statistics (prompt/completion/total/cached tokens and request count) are persisted in `ExtensionContext.globalState` and updated from the `usage` field in every chat completion response.

## Per-Model Configuration

Use `kimiCopilot.modelConfigs` to override settings per picker model. Example:

```json
{
  "kimiCopilot.modelConfigs": {
    "kimi-k2.7-code": {
      "maxInputTokens": 256000,
      "maxOutputTokens": 32768,
      "temperature": 1.0,
      "topP": 0.95,
      "presencePenalty": 0.0,
      "frequencyPenalty": 0.0,
      "thinking": { "type": "enabled" }
    }
  }
}
```

Precedence: per-model config > global setting > hard-coded model default.

### Transliterate optimizer (v1.8.0+)

`kimiCopilot.modelConfigs.<model>.transliterate: true` transliterates Cyrillic request content to Latin before sending (in `provider.ts` after `convertMessages`, before the context estimator). Measured effect: 5.3 → 2.7 bytes/token, ~2× smaller request bodies for Cyrillic-heavy chats — delays hitting the 2 MiB body cap. K3 answers in Russian anyway. Implementation: `src/transliterate.ts` (GOST-style mapping, fast-path skips pure-ASCII, images/tool ids/names untouched). Default: off.

## K2.7 API Constraints

- `temperature` is fixed at `1.0` by the API; any other value errors.
- `top_p` is fixed at `0.95` by the API; any other value errors.
- `presence_penalty` and `frequency_penalty` are fixed at `0.0`.
- `thinking` defaults to `{ "type": "enabled" }` and cannot be disabled for K2.7 Code.
- `tool_choice` only supports `"auto"` or `"none"`.

## Conventions

- **`languageModelChatProviders` contribution required** — declare in `package.json` → `contributes.languageModelChatProviders` with `vendor` + `displayName`. Without this, the provider won't be recognized.
- **Vendor must match everywhere**: `package.json` contribution `.vendor` === 1st arg to `registerLanguageModelChatProvider()` === `"kimi-copilot"`.
- **Settings prefix**: All user-facing settings use `kimiCopilot.*` namespace.
- **VS Code API version**: Targets `^1.93.0` engines.

## Key Gotchas

1. **Model won't appear in chat until user enables it**: Chat → model picker → "Manage Models" → find provider → ✅ check models.
2. **`options.silent: true`**: Must return `[]` to avoid prompting for credentials in silent mode. If `silent: false` and no API key is set, prompt the user.
3. **Debug logs**: Output panel → "Extension Host" → look for `[Kimi Copilot]` prefix.
4. **Token counting** is approximate (chars ÷ 3.5 for mixed CN/EN) — Kimi doesn't expose a tokenizer.
5. **`onDidChangeLanguageModelChatInformation`**: Fire this event when models change (e.g., API key added/removed) so VS Code re-queries.

## Official References

- [Language Model Chat Provider API Guide](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [Chat Model Provider Sample](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-model-provider-sample)
- [Language Model API Guide](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- [VS Code lm API Reference](https://code.visualstudio.com/api/references/vscode-api#lm)
- [Kimi K2.7 Code Quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart)
- [Kimi Models](https://platform.kimi.ai/docs/models)
