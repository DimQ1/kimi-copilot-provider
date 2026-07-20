# Kimi Copilot Provider

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-blue?style=flat-square&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=kimi-ext.kimi-copilot-provider)

VS Code extension that registers **Kimi K3 and K2.x** models as a custom language model provider for GitHub Copilot Chat. Proxies chat requests to the Kimi API via SSE streaming.

## Supported Models

| Picker ID | API Model | Context | Notes |
|---|---|---|---|
| `kimi-k3` | `kimi-k3` | Up to 1M | Native vision, tool calling, reasoning effort |
| `kimi-k2.7-code` | `kimi-k2.7-code` | 256K / 32K | Default coding model, thinking required |
| `kimi-k2.7-code-highspeed` | `kimi-k2.7-code-highspeed` | 256K / 32K | Faster output (~180 T/s) |
| `kimi-k2.6` | `kimi-k2.6` | 256K / 32K | Multimodal + thinking |
| `kimi-k2.5` | `kimi-k2.5` | 256K / 32K | Multimodal + thinking |

## How It Works

The extension implements the `vscode.lm.LanguageModelChatProvider` API (stabilized in VS Code 1.93+) and forwards chat requests to the Kimi API:

```
POST https://api.kimi.com/coding/v1/chat/completions
```

Kimi's API is OpenAI-compatible and supports SSE streaming.

## Setup

### 1. Install dependencies and compile

```bash
npm install
npm run compile
```

### 2. Configure API Key

Run **Kimi Copilot: Set API Key** from the Command Palette (`Ctrl+Shift+P`) and paste your Kimi API key.

For the default endpoint (`https://api.kimi.com/coding/v1/chat/completions`), create the key in the [Kimi Code Console](https://www.kimi.com/code/console). A Kimi Open Platform key belongs to a different API and will return `401`. If an old key is stored in SecretStorage, run **Kimi Copilot: Clear Stored API Key** before setting the new one.

Or open VS Code Settings (`Ctrl+,`) and search for `kimiCopilot`:

| Setting | Default | Description |
|---|---|---|
| `kimiCopilot.model` | `kimi-k2.7-code` | Default Kimi model ID used in chat |
| `kimiCopilot.endpoint` | `https://api.kimi.com/coding/v1/chat/completions` | API endpoint |
| `kimiCopilot.baseUrl` | `https://api.kimi.com` | Base URL for the Kimi API |
| `kimiCopilot.temperature` | `1.0` | Sampling temperature for K2.x; K3 omits this fixed parameter |
| `kimiCopilot.maxTokens` | `0` | Max output tokens; K3 sends `max_completion_tokens` |
| `kimiCopilot.topP` | `0.95` | Sampling parameter for K2.x; K3 omits this fixed parameter |
| `kimiCopilot.systemPrompt` | (see `config.ts`) | System prompt sent with every request |
| `kimiCopilot.modelConfigs` | `{}` | Per-model overrides for parameters |

### 3. Press F5 to Launch

Press `F5` in VS Code to start the Extension Development Host. The Kimi provider will be available to Copilot Chat.

## Architecture

```
src/
├── config.ts      # ConfigurationManager: settings + SecretStorage API key
├── extension.ts   # activate(): registers provider and commands
├── models.ts      # Model registry + LanguageModelChatInformation mapping
├── provider.ts    # KimiChatProvider implements LanguageModelChatProvider
├── types.ts       # Shared API and model types
└── test/          # Unit tests
```

Provider implements the 3 mandatory methods of `LanguageModelChatProvider`:
1. **`provideLanguageModelChatInformation`** — returns model metadata
2. **`provideLanguageModelChatResponse`** — streams response via `Progress<LanguageModelResponsePart>`
3. **`provideTokenCount`** — estimates token count

## Enabling the Model

1. Open Chat in VS Code
2. Click the model picker → **Manage Models**
3. Find **Kimi Copilot Provider** → ✅ check the desired model

### Kimi K3 API behavior

K3 uses `kimi-k3`, native image input, and `reasoning_effort`. Thinking is always enabled for K3. The provider sends `max_completion_tokens` and omits K2.x-only sampling and penalty parameters. K3 image parts are encoded as base64 `data:` URLs; public image URLs are not used.

**Context limits:** the default Kimi Code endpoint exposes K3 with a **256K** context window on the Moderato plan; Allegretto and above unlock the full **1M** context. If you have an Allegretto+ plan, override the reported limit in `kimiCopilot.modelConfigs`:

```json
{
  "kimiCopilot.modelConfigs": {
    "kimi-k3": {
      "maxInputTokens": 1048576
    }
  }
}
```

The extension tracks token usage reported by the Kimi API (prompt, completion, total and cached tokens) and shows it in the VS Code status bar. Click the status bar item or run **Kimi Copilot: Show Usage Statistics** for details. Run **Kimi Copilot: Reset Usage Statistics** to clear the counters. These statistics are local to the extension and do not reflect the remaining account balance shown in the Kimi Code console.

## Management Commands

- **Kimi Copilot: Set API Key** — store API key securely in SecretStorage
- **Kimi Copilot: Clear Stored API Key** — remove the key currently taking precedence over the deprecated setting
- **Kimi Copilot: Select Default Model** — choose the default model
- **Kimi Copilot: Edit Model Configuration** — per-model JSON overrides
- **Kimi Copilot: Test Connection** — verify connectivity and credentials
- **Kimi Copilot: Show Usage Statistics** — view local token/request statistics collected from API responses
- **Kimi Copilot: Reset Usage Statistics** — clear the local usage counters
- **Kimi Copilot: Open Settings** — open settings directly

## Development

| Task | Command |
|---|---|
| Compile (once) | `npm run compile` |
| Compile (watch) | `npm run watch` |
| Launch extension | `F5` (Extension Development Host) |
| Package .vsix | `npx @vscode/vsce package --no-dependencies` |
| Run tests | `npm test` |
| Format code | `npm run format` |

## Requirements

- VS Code **1.93.0** or higher
- Node.js 18+
- Active Kimi API key

## Referral Links

New to Kimi? Use these links to sign up or subscribe — you’ll get a guaranteed benefit and so will I (up to 1-Year Membership Credits):

- **Subscribe:** [Boost me and we both win! Subscribe to Kimi and we each get a guaranteed benefit — up to 1-Year Membership Credits](https://kimi-bot.com/activities/viral-referral/share?scenario=subscribe&from=share_poster&invitation_code=ZKH245)
- **Sign up:** [Boost me and we both win! Sign up on Kimi and we each get a guaranteed benefit — up to 1-Year Membership Credits](https://kimi-bot.com/activities/viral-referral/share?scenario=invite&from=share_poster&invitation_code=ZKH245)

## Official References

- [Language Model Chat Provider API Guide](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [Chat Model Provider Sample](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-model-provider-sample)
- [Language Model API Guide](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- [VS Code lm API Reference](https://code.visualstudio.com/api/references/vscode-api#lm)
- [Kimi K2.7 Code Quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart)
- [Kimi Models](https://platform.kimi.ai/docs/models)

## License

MIT
