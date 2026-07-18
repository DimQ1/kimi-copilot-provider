# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.5] - 2026-07-18

### Fixed
- Reduced default `maxInputTokens` for `kimi-k3` to 262144 (256K) to match the Kimi Code Moderato plan limit. Allegretto+ users can still override to 1M via `kimiCopilot.modelConfigs`.

## [1.4.4] - 2026-07-18

### Fixed
- Added `stream_options: { include_usage: true }` to streaming chat completion requests so the status bar usage counter updates correctly.

## [Unreleased]

## [1.5.2] - 2026-07-18

### Changed
- Status-bar click now opens a compact usage **popup** (QuickPick) with quota summary and quick actions instead of opening the full editor panel immediately.
- Added "Open detailed usage panel" action in the popup to open the rich editor view.
- The existing `Kimi Copilot: Show Usage Statistics` command still opens the detailed editor panel directly.

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
