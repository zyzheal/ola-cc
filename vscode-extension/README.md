# Claude Code VSCode Extension

Embed Claude Code's AI capabilities directly inside Visual Studio Code. Chat with Claude, explain code, refactor, generate tests, and more -- all without leaving your editor.

## Features

- **Chat Panel**: A dedicated sidebar panel for conversing with Claude about your code
- **Context-Aware**: Automatically includes the active file and selected text in prompts
- **Streaming Responses**: Real-time streaming of Claude's responses with typing indicators
- **Code Actions**: Right-click on selected code to explain, refactor, fix, or review
- **Apply to Editor**: One-click to apply Claude's suggested code changes
- **Status Bar Indicator**: Visual feedback showing Claude's current state
- **Configurable**: Choose your model, set API key, customize the system prompt

## Commands

| Command | Description | Default Shortcut |
|---------|-------------|-------------------|
| `Claude: Open Chat` | Open or focus the chat panel | Cmd+Shift+L |
| `Claude: Explain Code` | Explain selected code | Cmd+Shift+E |
| `Claude: Refactor Code` | Refactor selected code | - |
| `Claude: Fix Issue` | Fix issues in selected code | - |
| `Claude: Generate Tests` | Generate tests for selected code | - |
| `Claude: Review Code` | Review selected code | - |
| `Claude: Clear Chat` | Clear the conversation history | - |
| `Claude: Focus Chat Input` | Focus the chat input field | Cmd+Shift+I |

## Configuration

Configure the extension via VSCode Settings (`Cmd+,`):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `claude.apiKey` | string | "" | Anthropic API key (or use `ANTHROPIC_API_KEY` env var) |
| `claude.model` | enum | `claude-sonnet-4-20250514` | Model to use |
| `claude.maxTokens` | number | 8192 | Maximum response tokens |
| `claude.temperature` | number | 0 | Sampling temperature (0-1) |
| `claude.systemPrompt` | string | (default) | Custom system prompt |
| `claude.includeFileContext` | boolean | true | Include active file in prompts |
| `claude.includeSelectionOnly` | boolean | true | Use selection vs full file |
| `claude.showThinking` | boolean | false | Show Claude's thinking process |
| `claude.enableHoverInsights` | boolean | false | Enable hover provider (opt-in) |

## Setup

### 1. Install Dependencies

```bash
cd vscode-extension
bun install
```

### 2. Configure API Key

Set your Anthropic API key in one of these ways:

- VSCode Settings: Search for "claude.apiKey"
- Environment variable: `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY`

### 3. Run in Development

Open the `vscode-extension` folder in VSCode and press `F5` to launch the Extension Development Host.

Or from the command line:

```bash
cd vscode-extension
bun run watch  # Start watch mode for rebuilds
```

### 4. Build for Production

```bash
cd vscode-extension
bun run build  # Creates dist/extension.js and dist/webview/app.js
```

### 5. Package as VSIX

```bash
cd vscode-extension
bun run package  # Creates claude-code-vscode-0.1.0.vsix
```

Install the .vsix file in VSCode:
```bash
code --install-extension claude-code-vscode-0.1.0.vsix
```

## Usage

### Quick Start

1. Open a file in VSCode
2. Press `Cmd+Shift+L` to open the Claude chat
3. Type your question or use a suggested prompt
4. Claude responds with streaming text

### Code Actions

1. Select some code in the editor
2. Right-click to see Claude actions:
   - **Explain with Claude**: Get an explanation
   - **Refactor with Claude**: Improve the code
   - **Fix with Claude**: Fix issues (shown when diagnostics exist)
   - **Generate Tests with Claude**: Create test cases
   - **Review with Claude**: Get a code review

### Applying Changes

When Claude returns code blocks, you'll see:
- **Apply to Editor**: Inserts the code at your cursor position (or replaces selection)
- **Copy Code**: Copies the code to clipboard

## Architecture

```
vscode-extension/
├── package.json              # VSCode extension manifest
├── tsconfig.json             # TypeScript config
├── build.mjs                 # esbuild build script
├── README.md                 # This file
└── src/
    ├── extension.ts          # Extension entry point
    ├── panels/
    │   └── ChatPanel.ts      # Webview panel manager
    ├── providers/
    │   ├── CodeActionProvider.ts  # Context menu actions
    │   └── HoverProvider.ts       # Hover insights
    ├── webview/
    │   └── app.tsx           # Webview frontend
    └── utils/
        ├── ClaudeClient.ts        # Anthropic API client
        └── StatusBarManager.ts    # Status bar indicator
```

## Requirements

- VSCode 1.85.0 or higher
- Node.js 18+ (for native `fetch`)
- Anthropic API key

## License

See LICENSE.md in the repository root.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `bun run build` to verify
5. Submit a pull request

## Future Enhancements

- MCP server integration for tool access
- Inline code suggestions (ghost text)
- Multi-file context awareness
- Agent mode for complex tasks
- Session persistence across restarts
- Syntax-highlighted code blocks
- Custom theme integration
