# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The server-resolved `context_length` from `GET /models` is now the source of truth for the session context window (256K Moderato / 1M Allegretto+). The manual `kimiCopilot.plan` hint is only a fallback used before the first successful catalog fetch.
- The per-request API cap (262144 tokens) is now tracked separately from the session context window: a 1M subscription still cannot send more than 262144 tokens in a single request, and the error message now says so explicitly.

### Added
- `SessionContextTracker.getRequestLimit()` — returns the hard per-request cap, clamped to the session window.
- Automatic background refresh of the `/models` catalog when the API rejects a request for context length (HTTP 400) — picks up subscription tier changes (e.g. downgrade from Allegretto+ to Moderato) without a manual refresh.
- A dedicated error message for HTTP 400 context-length rejections explaining the 262144 per-request cap.
- **Auto-compact fallback** (`kimiCopilot.autoCompactOnLimit`, default `true`): when a request exceeds the token limit — either caught by the local pre-flight estimate or rejected by the API with HTTP 400 — the provider warns the user and runs `github.copilot.chat.compact` (the Copilot Chat `/compact` command) once per session, then asks the user to resend the message. Falls back to a manual `/compact` hint when the command is unavailable.
- Unit tests covering: server context wins over the plan hint (both directions), per-request cap on a 1M plan, cap shrinking with a smaller server window, and `applyServerModels` propagating `serverContextLength`.

## [1.4.5] - 2026-07-18

### Fixed
- Reduced default `maxInputTokens` for `kimi-k3` to 262144 (256K) to match the Kimi Code Moderato plan limit. Allegretto+ users can still override to 1M via `kimiCopilot.modelConfigs`.

## [1.4.4] - 2026-07-18

### Fixed
- Added `stream_options: { include_usage: true }` to streaming chat completion requests so the status bar usage counter updates correctly.

## [1.6.1] - 2026-07-20

### Fixed
- Removed `languageModelThinkingPart` from `enabledApiProposals` — the VS Code proposal gate was blocking third-party access. The class is available at runtime because `GitHub.copilot-chat` has it enabled.
- Fixed duplicate reporting of the first `reasoning_content` delta in streaming responses (probe-then-report pattern, same approach as `deepseek-v4-for-copilot`).

### Added
- Unit tests for `formatThinkingAsText`, `tryReportThinkingPart`, and `buildKimiRequest` thinking parameters (K2.x `thinking` vs K3 `reasoning_effort`).

## [1.6.0] - 2026-07-20

### Added
- **Thinking / reasoning content is now displayed** in Copilot Chat. When the Kimi API returns `reasoning_content` in streaming or non-streaming responses, the provider forwards it to the Chat UI via `LanguageModelThinkingPart` (VS Code proposed API) so it renders as a collapsible "Thinking" section. When the proposed API is unavailable, the thinking text falls back to a formatted markdown blockquote prefixed before the first text chunk.

## [1.5.7] - 2026-07-19

### Added
- The extension now fetches the live model catalog from the Kimi Code `GET /models` endpoint with the configured API key on startup (and after setting the API key). Server-returned parameters — context window (`context_length`), capability flags, and thinking effort levels — are layered over the hard-coded model registry, so per-subscription limits (e.g. K3 1M context on Allegretto+) apply automatically.
- The fetched catalog is cached in `globalState` and re-applied on the next start; it is cleared when the API key is removed. On any fetch failure the extension silently falls back to the hard-coded/cached values (details in the "Kimi Copilot" log channel).

## [1.5.6] - 2026-07-18

### Fixed
- Reported Kimi API usage back to Copilot Chat via `LanguageModelDataPart` with mime type `usage`, matching the undocumented convention used by DeepSeek V4 for Copilot. This enables the native "Session Info" / "Context Window" UI to update token counts.

## [1.5.5] - 2026-07-18

### Added
- Added referral links to the README and extension description so new users can subscribe or sign up on Kimi and both sides receive up to 1-Year Membership Credits.

## [1.5.4] - 2026-07-18

### Added
- Added `SessionContextTracker` that estimates the token size of the current chat session (history + prompt + files + images) before sending a request.
- Context usage is shown in the status bar as a percentage (e.g. `Ctx 45%`).
- Added `kimiCopilot.contextWarningThreshold` (default 0.8) and `kimiCopilot.contextErrorThreshold` (default 0.95) settings.
- When the context error threshold is exceeded, the request is rejected with a clear message telling the user to start a new session, run `/compact`, or remove files from the context.
- Added `kimiCopilot.plan` setting (`moderato`/`allegretto`/`allegro`/`vivace`) so K3 can use the higher 1M context window on Allegretto+ while still enforcing the 262144 single-request limit.
- Added unit tests for the session context tracker.

### Changed
- The status bar now shows context usage alongside the existing quota/token summary.
- The usage tooltip and usage panel include the current context estimate when available.

## [1.5.3] - 2026-07-18

### Fixed
- Reduced `kimi-k3` `maxInputTokens` to 262144 to match the Kimi Code API single-request limit (prompt + history + files). Allegretto+ users can still override to 1M via `kimiCopilot.modelConfigs`.
- Reduced `kimi-k3` `maxOutputTokens` to 32768, aligning with the recommended coding-agent maximum.
- Added `singleRequestLimit` and `multiTierContext` metadata to the K3 model definition for clearer limit reporting.

## [1.5.2] - 2026-07-18

### Changed
- Status-bar click now opens a standard VS Code notification popup with the usage summary and action buttons.
- Replaced the QuickPick usage popup with a clearer notification layout: each quota/limit is shown on its own line with an ASCII progress bar, used/remaining counts, and reset time.
- Local token statistics are listed per metric (requests, prompt, completion, total, cached) for easier reading.
- Added "Open details" button in the popup to open the rich editor usage panel.

## [1.5.1] - 2026-07-18

### Added
- Added a detailed usage panel that opens on status-bar click. It shows the Kimi Code quota with a progress bar, remaining credits, reset time, extra usage / booster wallet balance, and local token statistics.
- Added Refresh Quota and Open Kimi Console buttons inside the usage panel.
- Status-bar tooltip now indicates that clicking opens the detailed usage panel.

## [1.5.0] - 2026-07-18

### Fixed
- Restored default `maxInputTokens` for `kimi-k3` to 1048576 (1M) to match the Kimi K3 up-to-1M context window. Users on the Moderato plan can lower it to 262144 via `kimiCopilot.modelConfigs`.
- Added support for Copilot Chat's **Thinking Effort** UI option for `kimi-k3`. Values from the UI (`modelOptions.reasoning_effort` or proposed `modelConfiguration.reasoningEffort`) are now mapped to Kimi's `low`/`high`/`max` and sent to the API, taking precedence over model defaults and per-model config.

### Added
- Added managed Kimi Code quota / usage tracking via the `/usages` endpoint. The status bar now shows the current quota percentage (e.g., `41% used (59 left)`) instead of local token counts, with a hover exposing the full breakdown and any limits.
- Added `Kimi Copilot: Refresh Quota` command to fetch the latest usage on demand.
- Added `Kimi Copilot: Open Kimi Console` command to jump to the Kimi platform console.
- Added quota threshold notifications at 80% (warning) and 95% (critical) to warn before limits are reached.
- Added per-model pricing metadata (`inputCost`, `outputCost`, `cacheCost`, `priceCategory`) to render the native Copilot Chat cost panel for Kimi models.
- Added Kimi K3 support with up to 1M context, `reasoning_effort`, native image input conversion, and K3-specific request parameters.
- Added a command to clear the stored API key and diagnostics for invalid credentials.
- Added local usage statistics tracking (prompt/completion/total/cached tokens and request count) from Kimi API responses, shown in the status bar.
- Added ESLint configuration using `typescript-eslint`.
- Added GitHub Actions CI workflow for build and lint checks.
- Added per-model `modelConfigs` overrides (temperature, topP, max tokens, system prompt, tool calling, etc.).
- Added `kimiCopilot.modelIdOverrides` setting to remap picker model IDs to custom API model IDs.
- Added secure API key storage via VS Code SecretStorage with plain-text fallback for migration.
- Added `Kimi Copilot: Test Connection` command.
- Added `Kimi Copilot: Edit Model Configuration` command.
- Added exponential backoff retry for transient Kimi API errors (429, 5xx).
- Added request latency logging.
- Added unit tests for message/tool conversion helpers.
- Added Prettier configuration and `npm run format` script.

### Changed
- Updated model registry to Kimi K2.x series: `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, `kimi-k2.5`.
- README updated to reflect the current model lineup and settings.
- Improved SSE streaming and non-streaming response handling.
- Improved error mapping for Kimi API HTTP status codes and network failures.
- `Kimi Copilot: Test Connection` now performs a real lightweight API call instead of only listing models.
- `top_p` now respects per-model defaults instead of being hard-coded to 0.95 for every model.
- Upgraded TypeScript `moduleResolution` from `node10` to `node16`.

### Deprecated
- `kimiCopilot.apiKey` plain-text setting is deprecated; use the `Kimi Copilot: Set API Key` command instead.

### Fixed
- Tool calling conversion now correctly accumulates streamed tool call deltas.
- System prompt is only prepended when the request does not already contain one.
- Fixed `Disposable` leak: configuration change listener is now properly disposed.
- Fixed model picker behavior in silent mode by returning an empty model list when `silent` is requested.

## [1.3.0] - 2026-07-10

### Added
- Added support for `kimi-k2.7-code-highspeed` model.
- Added `toolCalling` capability flag per model.

### Changed
- Refactored configuration into `ConfigurationManager`.

## [1.2.0] - 2026-07-09

### Added
- Introduced `kimiCopilot.modelConfigs` per-model overrides.

## [1.1.0] - 2026-07-08

### Changed
- Migrated API key storage from plain-text settings to SecretStorage.

## [1.0.0] - 2026-07-07

### Added
- Initial release with `kimi-k2.7-code` support.
- SSE streaming response support.
- Basic model picker integration for GitHub Copilot Chat.
