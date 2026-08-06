# Kimi Copilot Provider

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-blue?style=flat-square&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=kimi-ext.kimi-copilot-provider)
[![Referral](https://img.shields.io/badge/Kimi-Subscribe%20%26%20Get%201--Year%20Credits-purple?style=flat-square&logo=kimi)](https://kimi-bot.com/activities/viral-referral/share?scenario=subscribe&from=share_poster&invitation_code=ZKH245)

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

### Video context in Chat

Use the Kimi chat participant when the request needs a video:

1. In Copilot Chat, enter `@kimi /video` followed by the question, for example `@kimi /video What happens between 00:10 and 00:20?`.
2. Select a local video in the file picker. If the chat request did not include a question, Kimi asks for one after the file is selected.
3. The extension uploads the file, waits until Kimi marks it `ready`, sends the question with `video_url: { url: "ms://<file-id>" }`, and returns the textual answer into the current Chat response.
4. The temporary remote file is removed after the answer. The video is not retained as provider state; the answer is the context for the next turn.

The configured `kimiCopilot.endpoint` and model mapping are used. With the default Kimi Code settings this is the proven Coding Files API flow. The participant is registered as `@kimi` with the `/video` command.

If the Chat participant is unavailable, run **Kimi Copilot: Ask About Video** from the Command Palette. It follows the same upload flow, opens the answer in **Kimi Video Answers**, and offers **Copy Answer** so it can be pasted into the current chat.

### Experimental video context probe

Run **Kimi Copilot: Probe Video Context (Experimental)** to test the complete video flow without changing normal Copilot Chat requests. The command:

1. Selects a local video file (up to 100 MB).
2. Uploads it to the selected Files API with `purpose=video`.
3. Waits for processing, sends `video_url: { url: "ms://<file-id>" }`, and displays the model response in the **Kimi Video Probe** output channel.
4. Deletes the temporary remote file after the request.

The command offers both the configured Kimi Code API base and the official Kimi Platform base (`https://api.moonshot.ai/v1`). It uses `KIMI_API_KEY` or `MOONSHOT_API_KEY` first, then falls back to the key stored by **Kimi Copilot: Set API Key**. Environment variables must be present when the Extension Host starts; setting one in an already running integrated terminal does not update the existing extension process. On Windows, launch the development host from a terminal where the variable is set, for example:

```powershell
$env:MOONSHOT_API_KEY = 'paste-key-here'
code .
```

The probe is diagnostic only and keeps its endpoint/model selection UI. It never writes the API key to the output channel. For normal use, prefer `@kimi /video` or **Kimi Copilot: Ask About Video**.

## Architecture

```
src/
├── config.ts      # ConfigurationManager: settings + SecretStorage API key
├── extension.ts   # activate(): registers provider and commands
├── models.ts      # Model registry + LanguageModelChatInformation mapping
├── provider.ts    # KimiChatProvider implements LanguageModelChatProvider
├── video-client.ts # Files API upload, processing, video chat request, cleanup
├── video-flow.ts  # Shared file picker and video API configuration
├── video-chat-participant.ts # @kimi /video Chat integration
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
- **Kimi Copilot: Ask About Video** — upload a video and copy the textual answer
- **Kimi Copilot: Probe Video Context (Experimental)** — upload a video and test `video_url` context support
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
