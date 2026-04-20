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
bun run build:dev              # Build development binary to ./cli-dev
bun run build:dev:full         # Build with all experimental features

# Production
bun run build                  # Build production binary (Bun bytecode, outputs to ./cli)
bun run compile                # Build compiled binary (outputs to ./dist/cli)

# Publish build (Node.js compatible)
bun run ./scripts/build-publish.ts   # Outputs to dist/publish/
```

**Testing:** The publish build can be tested with:
```bash
node dist/publish/cli.js       # Run the Node.js bundle directly
```

## Output Structure

| Output | Description |
|--------|-------------|
| `./cli` | Production binary (Bun bytecode, ~150MB) |
| `./cli-dev` | Development binary |
| `dist/publish/` | npm publish ready package (Node.js >=18 compatible) |
| `dist/cli` | Compiled binary (with `--compile` flag) |

## Key Architecture

### Entry Point & Bootstrap

**`src/entrypoints/cli.tsx`** is the CLI entry point. It uses a fast-path architecture with dynamic imports to minimize module loading for common operations:

1. Fast paths for `--version`, `--help`, `doctor`, `update`
2. Subcommand dispatch for `daemon`, `bridge`, `remote-control`, `environment-runner`
3. Falls through to `src/main.tsx` for the full REPL interactive loop

### Core Loop

The main conversation flow:
```
src/main.tsx → src/setup.ts → src/QueryEngine.ts → src/query.ts → src/services/api/
```

- **QueryEngine** (`src/QueryEngine.ts`): Orchestrates the agentic loop — sends messages to the API, handles tool calls, manages conversation state
- **query** (`src/query.ts`): Low-level API call logic, streaming, and tool execution
- **API clients** (`src/services/api/`): Multiple provider adapters
  - `claude.ts` — Anthropic SDK client (primary)
  - `openai.ts` — OpenAI-compatible adapter (converts Anthropic <-> OpenAI format)
  - `client.ts` — Client factory that selects the right provider based on env vars

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

### Provider Selection

The API client factory (`src/services/api/client.ts`) selects providers based on environment variables:

| Env Var | Provider |
|---------|----------|
| `CLAUDE_CODE_USE_OPENAI` | OpenAI-compatible (Ollama, vLLM, etc.) |
| `CLAUDE_CODE_USE_BEDROCK` | AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | Google Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY` | Azure Foundry |
| (default) | Direct Anthropic API |

### Feature Flags

Controlled via `--feature=<NAME>` in `scripts/build.ts`. Default enabled: `VOICE_MODE`, `BUDDY`.

Key experimental features: `DAEMON`, `BG_SESSIONS`, `BRIDGE_MODE`, `KAIROS`, `PROACTIVE`, `TEMPLATES`, `PROMPT_CACHE_BREAK_DETECTION`, `CACHED_MICROCOMPACT`.

See `scripts/build.ts` for the full list.

### Three-Layer Gating

1. **Compile-time**: `feature()` gates — code inclusion/exclusion at build time
2. **User type**: `USER_TYPE` fixed to `'external'` at compile time (internal builds use `'ant'`)
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

2. **BM25 Tool Ranking** (`src/services/api/toolRanker.ts`): When ToolSearchTool is not enabled and tool count exceeds 25, tools are ranked by relevance to the user's query and limited to top-40. Core tools (Bash, Read, Edit, Write, Glob, Grep) are always included. Ranking uses:
   - Exact name match (weight: 100)
   - Name part match (weight: 20)
   - searchHint match (weight: 15)
   - Full description match (weight: 8)
   - Tool descriptions are fetched via `tool.prompt()` with memoized caching

This saves ~22% of tool-related tokens when ToolSearchTool is not enabled, reducing from ~13K to ~10K tokens per API call.

## Important Files

| File | Purpose |
|------|---------|
| `scripts/build.ts` | Main build script (Bun bundler with bytecode) |
| `scripts/build-publish.ts` | npm publish build script |
| `src/entrypoints/cli.tsx` | CLI entry point with fast-path bootstrap |
| `src/main.tsx` | Main CLI loop and UI orchestration |
| `src/setup.ts` | Session initialization (git root, worktrees, hooks) |
| `src/QueryEngine.ts` | Agentic loop orchestrator |
| `src/query.ts` | API query logic and tool execution |
| `src/services/api/claude.ts` | Anthropic API client with prompt caching |
| `src/services/api/openai.ts` | OpenAI-compatible adapter |
| `src/services/api/toolRanker.ts` | BM25 tool ranking for progressive disclosure |
| `src/constants/prompts.ts` | System prompt construction |
| `src/Tool.ts` | Base tool interface and implementation |
| `src/tools.ts` | Tool registration and loading |
| `src/commands.ts` | Command registration and loading |

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
