# VSCode Extension Design Document

**Date:** 2026-04-16
**Author:** Claude Code Engineering
**Status:** Implementation

## Summary

This document describes the design for a VSCode extension that embeds Claude Code's AI capabilities directly inside Visual Studio Code, providing an integrated chat panel, code actions, and editor-based AI interactions.

## Motivation

Claude Code currently operates as a terminal-based CLI tool. While powerful, many developers spend most of their time inside their IDE. A VSCode extension would:

1. Reduce context switching between terminal and editor
2. Enable AI-assisted coding directly at the point of writing code
3. Leverage VSCode's rich editor APIs (selection, diagnostics, file system)
4. Provide a familiar chat-based interface within the developer's primary workspace

## Architecture

### Overview

The extension is structured as a VSCode extension package (`vscode-extension/`) that lives alongside the main Claude Code source tree. It communicates with the Anthropic API directly using the Messages API, with streaming support for real-time responses.

```
vscode-extension/
├── package.json          # VSCode extension manifest
├── tsconfig.json         # TypeScript config for extension
├── build.mjs             # esbuild build script
├── src/
│   ├── extension.ts      # Extension entry point
│   ├── panels/
│   │   └── ChatPanel.ts  # Webview panel management
│   ├── providers/
│   │   ├── CodeActionProvider.ts  # Context menu actions
│   │   └── HoverProvider.ts       # Hover insights
│   ├── webview/
│   │   └── app.tsx       # Webview frontend
│   └── utils/
│       ├── ClaudeClient.ts    # API client
│       └── StatusBarManager.ts # Status bar indicator
```

### Key Components

#### 1. Extension Entry Point (`extension.ts`)

- **Responsibility**: Lifecycle management, command registration, event listeners
- **Activation**: Triggered by command execution or sidebar view
- **Commands**:
  - `claude.chat` - Open/focus chat panel
  - `claude.explain` - Explain selected code
  - `claude.refactor` - Refactor selected code
  - `claude.fix` - Fix issues in selected code
  - `claude.generateTests` - Generate tests for selected code
  - `claude.review` - Review selected code
  - `claude.clearChat` - Clear chat history
  - `claude.focusInput` - Focus chat input

#### 2. Chat Panel (`ChatPanel.ts`)

- **Responsibility**: Manages the VSCode webview panel
- **UI**: Webview-based chat interface with streaming responses
- **Features**:
  - Message history with persistence (via `vscode.getState`)
  - Streaming response rendering
  - Code block extraction and "Apply to Editor" action
  - Active file context tracking
  - Welcome screen with suggested prompts

#### 3. Claude Client (`ClaudeClient.ts`)

- **Responsibility**: Communication with Anthropic Messages API
- **Features**:
  - API key management (settings + env vars)
  - Streaming SSE response parsing
  - Message history formatting
  - Model selection and configuration
  - Error handling and retry logic

#### 4. Code Action Provider (`CodeActionProvider.ts`)

- **Responsibility**: Adds Claude actions to editor context menu
- **Triggers**: Appears when text is selected
- **Actions**: Explain, Refactor, Fix, Generate Tests, Review

#### 5. Hover Provider (`HoverProvider.ts`)

- **Responsibility**: Provides hover insights (opt-in)
- **Features**: Rate-limited, contextual hover information
- **Configuration**: Disabled by default to avoid excessive API calls

#### 6. Status Bar Manager (`StatusBarManager.ts`)

- **Responsibility**: Visual status indicator in VSCode status bar
- **States**: Idle, Streaming (with spinner), Error, Ready
- **Interaction**: Click opens chat panel

### Communication Flow

```
User Action (Command/Context Menu)
    │
    ▼
Extension Host (extension.ts)
    │
    ├──► ChatPanel.show() - Create/reveal webview
    │         │
    │         ▼
    │     ChatPanel.sendMessage()
    │         │
    │         ├──► Build API messages (system + history + context)
    │         │
    │         ▼
    │     ClaudeClient.streamCompletion()
    │         │
    │         ├──► POST to Anthropic API (stream: true)
    │         │         │
    │         │         ▼
    │         │     SSE Response Stream
    │         │         │
    │         │         ▼
    │         │     Chunk-by-chunk processing
    │         │
    │         ▼
    │     Webview.postMessage() - Stream chunks to UI
    │         │
    │         ▼
    │     Webview renders incrementally
    │
    └──► StatusBarManager.updateStatus() - Update indicator
```

### Webview Architecture

The webview runs in an isolated sandbox and communicates with the extension host via `postMessage`. The UI is built with vanilla TypeScript/HTML for minimal bundle size, with support for:

- Markdown rendering (basic: code blocks, bold, italic, links)
- Streaming text display
- Code block extraction and actions
- Message history persistence
- File context badge display

### Configuration

Extension settings via VSCode's configuration API:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `claude.apiKey` | string | "" | Anthropic API key |
| `claude.model` | enum | claude-sonnet-4-20250514 | Model to use |
| `claude.maxTokens` | number | 8192 | Max response tokens |
| `claude.temperature` | number | 0 | Sampling temperature |
| `claude.systemPrompt` | string | (default) | Custom system prompt |
| `claude.includeFileContext` | boolean | true | Include active file |
| `claude.includeSelectionOnly` | boolean | true | Selection vs full file |
| `claude.showThinking` | boolean | false | Show thinking process |
| `claude.enableHoverInsights` | boolean | false | Enable hover provider |

### Keybindings

| Shortcut | Command | Context |
|----------|---------|---------|
| Cmd+Shift+L | claude.chat | Editor focus |
| Cmd+Shift+E | claude.explain | Editor focus |
| Cmd+Shift+I | claude.focusInput | Always |

## Security Considerations

1. **API Key Storage**: Stored in VSCode settings with `format: "password"` for masked display. Also supports `ANTHROPIC_API_KEY` env var.

2. **Webview CSP**: Strict Content Security Policy prevents loading external scripts. All resources are local.

3. **No Code Execution**: The extension does not execute code from AI responses. "Apply to Editor" inserts text into the active editor for user review.

4. **File Access**: Only reads the active editor's content. No file system scanning or background file access.

## Future Enhancements

1. **MCP Integration**: Connect to MCP servers configured in Claude Code for tool access
2. **Multi-file Context**: Include related files via import/require analysis
3. **Inline Diff Preview**: Show changes as inline diffs before applying
4. **Agent Mode**: Long-running background tasks for complex refactoring
5. **Session Resume**: Persist and restore conversations across VSCode restarts
6. **Slash Commands**: Port CLI slash commands (/help, /settings, etc.)
7. **Plugin System**: Support Claude Code plugins in the VSCode context

## Build & Distribution

### Development
```bash
cd vscode-extension
bun install
bun run watch  # Watch mode
```

### Packaging
```bash
bun run package  # Creates .vsix file
```

### Publishing
```bash
bun run publish  # Publish to VSCode Marketplace
```

## Testing Strategy

1. **Unit Tests**: Test ClaudeClient, message formatting, SSE parsing
2. **Integration Tests**: Test command registration, webview message passing
3. **E2E Tests**: Use VSCode's test API to simulate user interactions

## Compatibility

- **Minimum VSCode Version**: 1.85.0
- **Node.js**: 18+ (for `fetch` API)
- **Platforms**: macOS, Linux, Windows
