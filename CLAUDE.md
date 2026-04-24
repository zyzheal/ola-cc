# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a restored Claude Code source tree reconstructed from source maps. It builds a CLI tool using Bun that provides an AI-powered coding assistant running in the terminal. The project is a fork/variant of the official `@anthropic-ai/claude-code` package.

## Build & Development

**Package Manager:** Bun 1.3.5+

```bash
bun install                    # Install dependencies

# Development
bun run dev                    # Start development mode (tsx, no bytecode)
bun run dev:buddy              # Development mode with buddy/pet feature
bun run build:dev              # Build development binary to ./cli-dev
bun run build:dev:full         # Build with all experimental features (--feature-set=dev-full)

# Production
bun run build                  # Build production binary (Bun bytecode, outputs to ./cli)
bun run compile                # Build compiled binary (outputs to ./dist/cli)

# Publish build (Node.js compatible)
bun run ./scripts/build-publish.ts   # Outputs to dist/publish/

# Platform-specific builds
bun run build:bin              # Build platform-specific binaries
bun run build:bin:wrapper      # Build wrapper only
bun run build:bin:platform     # Build platform-native binary
```

**Testing:** The publish build can be tested with:
```bash
node dist/publish/cli.js       # Run the Node.js bundle directly
```

**Linting:** The project uses Biome for linting/formatting (see `biome.json` if present).

## Output Structure

| Output | Description |
|--------|-------------|
| `./cli` | Production binary (Bun bytecode, ~150MB) |
| `./cli-dev` | Development binary (no bytecode) |
| `dist/publish/` | npm publish ready package (Node.js >=18 compatible, excludes bytecode, injects `feature()` polyfill) |
| `dist/cli` | Compiled binary (with `--compile` flag) |

## Key Architecture

### Entry Point & Bootstrap

**`src/entrypoints/cli.tsx`** is the CLI entry point. It uses a fast-path architecture with dynamic imports to minimize module loading for common operations:

1. Fast paths for `--version`/`-v`/`-V`, `--help`/`-h`, `version`, `update`/`upgrade`, `doctor`
2. Subcommand dispatch for `daemon`, `remote-control`/`rc`/`remote`/`sync`/`bridge`, `ps`/`logs`/`attach`/`kill`, `new`/`list`/`reply` (templates), `environment-runner`, `self-hosted-runner`, `--daemon-worker`, `--bg`/`--background`
3. Chrome/MCP server modes: `--claude-in-chrome-mcp`, `--chrome-native-host`, `--computer-use-mcp`
4. Tmux worktree fast path: `--tmux` + `--worktree`
5. Falls through to `src/main.tsx` for the full REPL interactive loop

### Core Loop

The main conversation flow:
```
src/main.tsx → src/setup.ts → src/QueryEngine.ts → src/query.ts → src/services/api/
```

- **QueryEngine** (`src/QueryEngine.ts`): Orchestrates the agentic loop — sends messages to the API, handles tool calls, manages conversation state, handles compact/recovery flows
- **query** (`src/query.ts`): Low-level API call logic, streaming, tool execution, and state machine for the multi-turn conversation
- **API clients** (`src/services/api/`): Multiple provider adapters
  - `claude.ts` — Anthropic SDK client (primary)
  - `openai.ts` — OpenAI-compatible adapter (converts Anthropic <-> OpenAI format)
  - `client.ts` — Client factory that selects the right provider based on env vars

### Tool System

All tools implement the `Tool` interface from `src/Tool.ts`:
- `name`, `description`, `inputSchema` (Zod), `call()` method
- Optional: `strict`, `prompt()`, `getActivityDescription()`, `backfillObservableInput()`
- Tools are registered in `src/tools.ts` and loaded dynamically
- `ToolUseContext` carries session state, tools, model, MCP clients, and state setters to every tool call
- Subagent tools use `createSubagentContext()` which isolates state for async agents but shares it for sync agents

### Agent System

Agents are defined in `src/tools/AgentTool/loadAgentsDir.ts` and built-in agents live in `src/tools/AgentTool/built-in/`:
- `runAgent.ts` — core agent execution with message streaming
- `AgentTool.tsx` — main tool entry point, handles sync/async/fork execution paths
- `agentToolUtils.ts` — shared utilities (progress tracking, message finalization)
- `UI.tsx` — agent progress rendering in the terminal
- Agent model selection uses `getAgentModel()` in `src/utils/model/agent.ts` — **non-Claude parent models (e.g. qwen, llama) cause all subagents to inherit the parent model**, since Claude aliases would resolve to unsupported models. This check must come before any alias resolution.

### Compact System

Context compression lives in `src/services/compact/`:
- `compact.ts` — main compaction logic, `buildPostCompactMessages()`
- `microCompact.ts` — lightweight per-tool-result compaction
- `autoCompact.ts` — automatic compaction when context exceeds thresholds
- `sessionMemoryCompact.ts` — session-specific memory compaction
- Compact can be triggered by API limits, token budgets, or auto-compact thresholds

### State Management

- **AppState** (`src/state/AppStateStore.ts`) — central Redux-style store for UI state, tasks, notifications
- **bootstrap/state.ts** — session-level state (model overrides, main loop model, perfetto tracing)
- `setAppState` is shared between parent and sync subagents; async agents get isolated copies
- `setAppStateForTasks` always reaches root store for session-scoped infrastructure (background tasks, hooks)

### Major Directories

| Directory | Purpose |
|-----------|---------|
| `src/tools/` | Tool implementations (53+ tools: Bash, FileEdit, FileRead, FileWrite, AgentTool, MCPTool, etc.) |
| `src/commands/` | Slash command handlers (87+ commands: /help, /config, /compact, etc.) |
| `src/services/` | Subsystems: API clients, MCP, analytics, compact (context compression), session memory |
| `src/components/` | Terminal UI components (React + Ink, 148 components) |
| `src/hooks/` | Custom React hooks for the Ink UI (87 hooks) |
| `src/constants/` | Constants: prompts, betas, system prompt sections, tool limits |
| `src/utils/` | Shared utilities (338 files) |
| `src/types/` | TypeScript type definitions |
| `src/ink/` | Ink terminal UI engine (layout, rendering, events) |
| `src/bootstrap/` | App initialization and state management |
| `src/coordinator/` | Multi-agent coordination and orchestration |
| `src/buddy/` | Pet/companion system |
| `src/proactive/` | Autonomous work mode |
| `src/bridge/` | Remote control bridge |
| `src/assistant/` | Persistent assistant mode (KAIROS) |

### Provider Selection

The API client factory (`src/services/api/client.ts`) selects providers based on environment variables:

| Env Var | Provider |
|---------|----------|
| `CLAUDE_CODE_USE_OPENAI` | OpenAI-compatible (Ollama, vLLM, etc.) |
| `CLAUDE_CODE_USE_BEDROCK` | AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | Google Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY` | Azure Foundry |
| (default) | Direct Anthropic API |

**Note:** DashScope, LiteLLM, and similar proxy endpoints route through the default (firstParty) provider when `CLAUDE_CODE_USE_OPENAI` is not set. Model names must be configured via `CLAUDE_CODE_MODEL_*` env vars or `ANTHROPIC_MODEL`.

### Feature Flags

Controlled via `--feature=<NAME>` in `scripts/build.ts`. Default enabled: `VOICE_MODE`, `BUDDY`.

Key experimental features: `DAEMON`, `BG_SESSIONS`, `BRIDGE_MODE`, `KAIROS`, `PROACTIVE`, `TEMPLATES`, `PROMPT_CACHE_BREAK_DETECTION`, `CACHED_MICROCOMPACT`, `COORDINATOR_MODE`, `FORK_SUBAGENT`, `WORKFLOW_SCRIPTS`, `UDS_INBOX`, `TORCH`, `HISTORY_SNIP`, `EXPERIMENTAL_SKILL_SEARCH`, `TRANSCRIPT_CLASSIFIER`, `VERIFICATION_AGENT`.

See `scripts/build.ts` for the full list.

### Three-Layer Gating

1. **Compile-time**: `feature()` gates — code inclusion/exclusion at build time via `bun:bundle`
2. **User type**: `USER_TYPE` fixed to `'ant'` at compile time. The `"external" === 'ant'` pattern enables dead code elimination — in external builds this condition is always false, stripping internal-only features
3. **Runtime**: GrowthBook remote config for A/B testing and feature toggles

### Prompt Caching System

The Anthropic client (`src/services/api/claude.ts`) implements prompt caching via `cache_control` markers on system prompt blocks and tool schemas. The OpenAI-compatible adapter (`src/services/api/openai.ts`) supports automatic prefix caching by:
- Merging all system prompt blocks into a single stable prefix message
- Passing through `OPENAI_EXTRA_BODY` for backend-specific cache config
- Logging cache usage from responses for debugging

Cache break detection (`src/services/api/promptCacheBreakDetection.ts`) monitors cache hit rates and diagnoses causes of cache misses.

### Progressive Tool Disclosure

The system uses two mechanisms to limit tools sent per API call:

1. **ToolSearchTool** (`src/tools/ToolSearchTool/`): Deferred tools (`shouldDefer: true`) are not sent to the API initially. The model discovers them via `tool_reference` blocks. This is enabled for models that support the feature.

2. **BM25 Tool Ranking** (`src/services/api/toolRanker.ts`): When ToolSearchTool is not enabled and tool count exceeds 25, tools are ranked by relevance to the user's query and limited to top-25. Core tools (Bash, Read, Edit, Write, Glob, Grep) are always included. Ranking uses:
   - Exact name match (weight: 100)
   - Name part match (weight: 20)
   - searchHint match (weight: 15)
   - Full description match (weight: 8)
   - Tool descriptions are fetched via `tool.prompt()` with memoized caching

This saves ~22% of tool-related tokens when ToolSearchTool is not enabled, reducing from ~13K to ~10K tokens per API call.

### Model Configuration System

Model configuration is multi-layered (`src/utils/model/`):
- `configs.ts` — per-model configs (token limits, pricing) keyed by provider, all model names via `CLAUDE_CODE_MODEL_*` env vars
- `model.ts` — model resolution logic, aliases (`sonnet`, `opus`, `haiku`, `best`, `sonnet[1m]`, `opus[1m]`, `opusplan`), `parseUserSpecifiedModel()`
- `modelStrings.ts` — provider-specific model ID strings, supports Bedrock inference profile overrides and `modelOverrides` from settings
- `agent.ts` — subagent model selection, **non-Claude parent model protection** (subagents inherit parent when parent is not a Claude model)
- `providers.ts` — API provider detection
- Key env vars: `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_FRONTIER_MODEL_NAME`

### Message Types & Safety

Messages in `src/types/message.ts` include `UserMessage`, `AssistantMessage`, and various system message types. **`AssistantMessage.message` is optional** (`message?: { content, usage, ... }`). Code that accesses `message.message.content` or `message.message.usage` must defensively check `message.message` existence — compact flows, streaming fallback, and API error paths can produce messages with `message` set to `undefined`.

## Important Files

| File | Purpose |
|------|---------|
| `scripts/build.ts` | Main build script (Bun bundler with bytecode) |
| `scripts/build-publish.ts` | npm publish build script — excludes bytecode, injects Node.js `bun:bundle` polyfill for `feature()`, adds shebang |
| `src/entrypoints/cli.tsx` | CLI entry point with fast-path bootstrap |
| `src/main.tsx` | Main CLI loop and UI orchestration |
| `src/setup.ts` | Session initialization (git root, worktrees, hooks) |
| `src/QueryEngine.ts` | Agentic loop orchestrator |
| `src/query.ts` | API query logic, tool execution, state machine |
| `src/services/api/claude.ts` | Anthropic API client with prompt caching |
| `src/services/api/openai.ts` | OpenAI-compatible adapter |
| `src/services/api/toolRanker.ts` | BM25 tool ranking for progressive disclosure |
| `src/constants/prompts.ts` | System prompt construction |
| `src/Tool.ts` | Base tool interface and implementation |
| `src/tools.ts` | Tool registration and loading |
| `src/commands.ts` | Command registration and loading |
| `src/utils/model/agent.ts` | Subagent model selection with non-Claude protection |
| `src/services/compact/compact.ts` | Main context compaction logic |
| `src/state/AppStateStore.ts` | Central application state management |
| `src/bootstrap/state.ts` | Session-level state management |

## Documentation Update Policy

当功能发生变更或新增时，必须同步更新文档：

### 更新规则

1. **README.md** — 主文档，必须覆盖变更：
   - 环境变量表
   - Feature 表（如适用）
   - 系统架构描述（如适用）

2. **CLAUDE.md** — 技术文档，必须覆盖变更：
   - Key Architecture 相关部分
   - Important Files（如新增关键文件）
   - Provider Selection 表（如新增 provider）
   - Model Configuration System 表（如新增模型配置）

3. **docs/** — 深度分析文档，如变更属于某个子系统则更新对应文档

### 提交前检查清单

- [ ] README.md 环境变量表已更新
- [ ] README.md Feature 表已更新（如适用）
- [ ] CLAUDE.md 架构描述已更新（如适用）
- [ ] 相关 docs/ 子文档已更新（如适用）

## Configuration Priority

1. CLI arguments
2. Environment variables
3. `~/.claude/session.json` (session-level)
4. `~/.claude/settings.json` (user-level)
5. `.claude/CLAUDE.md` (project-level)
6. `CLAUDE.md` (project instructions, checked in)

## Skill 中文提示要求

使用任何 superpowers 技能时，必须使用中文与用户交互，包括：
- 技能流程提示（如 "我正在使用 brainstorming 技能..."）
- 可视化助手邀请提示
- 设计方案展示和用户沟通
- 检查清单（Checklist）任务描述

**特别要求：** brainstorming 技能的可视化助手邀请必须使用以下中文提示语：
> "我们接下来要讨论的内容，如果通过浏览器用网页展示给你看会更清楚。我可以随时生成 mockup、图表、对比等可视化内容。要试试看吗？（需要在浏览器中打开本地 URL）"

writing-plans 技能的开始提示必须使用：
> "我正在使用 writing-plans 技能来创建实现计划。"
