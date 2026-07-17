# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
