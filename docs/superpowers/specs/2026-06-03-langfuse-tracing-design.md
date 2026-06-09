# Langfuse Tracing Integration Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: claude-code-best v2.6.6
**Priority**: P0
**Effort**: M (4 new files + 4 modified + 3 deps)

---

## 1. Overview

Langfuse 是基于 OpenTelemetry 的 LLM 可观测性平台，提供 trace → generation → span 的完整调用链追踪。claude-code-best 通过 4 个文件实现了完整的 Langfuse 集成，包括敏感数据脱敏。

### 1.1 Feature Flag

本功能通过 compile-time feature flag 门控，使用 `bun:bundle` 的 `feature()` 函数：

```typescript
// scripts/build.ts — 添加到 feature list
'LANGFUSE_TRACING'

// 运行时检查（所有 Langfuse 入口点必须守卫）
import { feature } from 'bun:bundle'
if (!feature('LANGFUSE_TRACING')) {
  // 所有 tracing 函数降级为 no-op，零开销
}
```

**门控策略**：`isLangfuseEnabled()` 同时检查 feature flag 和环境变量，两者都满足才激活 tracing。未启用时所有导出函数为 no-op，不创建任何 OTel 资源。

### 1.2 与现有 logEvent 分析系统的关系

Langfuse 专注 LLM 调用追踪（traces/spans），`logEvent` 专注用户行为事件（commands/errors）。两者互补，不冲突。

| 维度 | Langfuse | logEvent |
|------|----------|----------|
| 数据类型 | LLM 调用链（trace → generation → span） | 用户行为事件（command/error/perf） |
| 存储 | Langfuse 服务端 | 本地 JSONL + AnalyticsEvents |
| 查询 | Langfuse UI（可视化 trace 树） | `analyze-tool` skill（聚合统计） |
| 触发时机 | 每次 API 调用、工具执行 | 用户操作、错误、性能指标 |
| 脱敏 | 3 层 sanitize（home/key/output） | 无（本地存储） |

## 2. Architecture

```
src/services/langfuse/
├── client.ts      — SDK 初始化和生命周期
├── tracing.ts     — Trace/Generation/Span 创建和关联
├── convert.ts     — Anthropic → OpenAI 消息格式转换
└── sanitize.ts    — 敏感数据脱敏（3 层策略）
```

### Type Hierarchy

```
RootTrace (agent)
  └── LangfuseSpan (generation) — LLM 调用
       ├── LangfuseSpan (tool) — 工具执行
       └── LangfuseSpan (batch) — 并发工具批次
```

## 3. Core Implementation

### 3.1 client.ts — SDK Init

```typescript
export function isLangfuseEnabled(): boolean  // Check LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY
export function initLangfuse(): boolean        // Create LangfuseSpanProcessor + BasicTracerProvider
export function flushLangfuse(): Promise<void>
export function shutdownLangfuse(): Promise<void>
export function getLangfuseProcessor(): LangfuseSpanProcessor | null
```

**Init flow**:
1. Check `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` env vars
2. Create `LangfuseSpanProcessor` with `mask` function pointing to `sanitizeGlobal`
3. Create `BasicTracerProvider`, register processor
4. Call `setLangfuseTracerProvider(provider)` to register globally

**Environment variables**:

| Variable | Default | Description |
|----------|---------|-------------|
| `LANGFUSE_PUBLIC_KEY` | — | Required |
| `LANGFUSE_SECRET_KEY` | — | Required |
| `LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` | Server URL |
| `LANGFUSE_FLUSH_AT` | 20 | Batch size |
| `LANGFUSE_FLUSH_INTERVAL` | 10s | Flush interval |
| `LANGFUSE_TRACING_ENVIRONMENT` | `development` | Environment tag |
| `LANGFUSE_EXPORT_MODE` | `batched` | `batched` or `immediate` |
| `LANGFUSE_TIMEOUT` | 5s | Request timeout |
| `LANGFUSE_USER_ID` | — | Optional user identifier |

### 3.2 tracing.ts — Trace Management

```typescript
export function createTrace(params): LangfuseSpan | null           // Root trace (asType: 'agent')
export function recordLLMObservation(rootSpan, params): void       // LLM generation
export function recordToolObservation(rootSpan, params): void      // Tool execution (asType: 'tool')
export function createToolBatchSpan(rootSpan, params): LangfuseSpan | null  // Concurrent tool batch
export function endToolBatchSpan(batchSpan): void
export function createSubagentTrace(params): LangfuseSpan | null   // Sub-agent trace
export function createChildSpan(parentSpan, params): LangfuseSpan | null
export function endTrace(rootSpan, output?, status?): void
```

**Key design points**:
- `startObservation` uses global function (not instance method) to preserve `startTime` parameter
- Session ID and user ID propagated via `otelSpan.setAttribute` to all child spans
- `recordLLMObservation` merges cache_read + cache_creation + input_tokens into total input tokens
- `PROVIDER_GENERATION_NAMES` maps provider names to Langfuse generation names

### 3.3 convert.ts — Message Format Conversion

```typescript
export function convertMessagesToLangfuse(messages, systemPrompt?): LangfuseChatMessage[]
export function convertToolsToLangfuse(tools): unknown[]
export function convertOutputToLangfuse(messages): LangfuseChatMessage | LangfuseChatMessage[] | null
```

**Conversion rules**:
- `tool_use` blocks → `tool_calls[]` at message level
- `tool_result` blocks → standalone `{ role: 'tool' }` messages
- `thinking` / `redacted_thinking` → `{ type: 'thinking', thinking: string }`
- `image` → `[image]` text placeholder
- `document` → `[document: filename]`

### 3.4 sanitize.ts — Data Redaction

**3-layer strategy**:

| Layer | Function | Scope |
|-------|----------|-------|
| Global | `sanitizeGlobal` | Home directory → `~` in all paths |
| Tool input | `sanitizeToolInput` | Sensitive keys (api_key, token, secret) → `[REDACTED]` |
| Tool output | `sanitizeToolOutput` | Per-tool-type: FileRead→redacted, Bash→500 char truncation, Config→full redaction |

**sanitizeGlobal 正则实现**：

```typescript
import { escapeRegex } from '../utils/regex.js'

// Home directory replacement
const homeDir = process.env.HOME || process.env.USERPROFILE || ''
const homeRegex = homeDir ? new RegExp(escapeRegex(homeDir), 'gi') : null

function sanitizeGlobal(value: string): string {
  if (!value) return value
  let result = value
  if (homeRegex) result = result.replace(homeRegex, '~')
  // API keys: 32+ hex/base64 chars after common prefixes
  result = result.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[a-z0-9_-]{32,}['"]?/gi, '$1=***')
  return result
}
```

**正则说明**：
- `homeRegex`：动态构建，转义 `$HOME` 路径中的特殊字符（`.`、`/` 等），全局替换为 `~`
- API key 正则：匹配 `api_key`/`api-key`/`token`/`secret`/`password` 后跟 32+ 字符的值，支持 `=`/`:` 分隔符和可选引号
- `escapeRegex` 工具函数确保路径中的 `.`、`/`、`\` 等字符被正确转义

## 4. Integration Points in ola-cc

### 4.1 API Call Recording

**File**: `src/services/api/claude.ts`

After each API call, record LLM generation:
```typescript
import { recordLLMObservation } from '../langfuse/tracing.js'

// In the API call handler:
recordLLMObservation(rootSpan, {
  model,
  input: convertMessagesToLangfuse(messages),
  output: convertOutputToLangfuse(response),
  usage: { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens },
  metadata: { provider, modelId },
})
```

### 4.2 Tool Execution Recording

**File**: `src/services/tools/toolExecution.ts`

After each tool call, record tool observation:
```typescript
import { recordToolObservation } from '../langfuse/tracing.js'

// In the tool execution handler:
recordToolObservation(rootSpan, {
  name: tool.name,
  input: sanitizeToolInput(toolInput),
  output: sanitizeToolOutput(toolOutput, tool.name),
  durationMs,
  statusMessage: isError ? 'error' : 'success',
})
```

### 4.3 Trace Lifecycle

**File**: `src/QueryEngine.ts`

```typescript
import { createTrace, endTrace } from '../langfuse/tracing.js'

// At conversation start:
const rootSpan = createTrace({ name: 'conversation', sessionId, userId })

// At conversation end:
endTrace(rootSpan, output, status)
```

### 4.4 Batch Span Management

**File**: `src/query.ts`

```typescript
import { createToolBatchSpan, endToolBatchSpan } from '../langfuse/tracing.js'

// Before parallel tool calls:
const batchSpan = createToolBatchSpan(rootSpan, { toolNames })

// After all tools complete:
endToolBatchSpan(batchSpan)
```

## 5. Files to Modify

| File | Operation | Description |
|------|-----------|-------------|
| `package.json` | Modify | Add `@langfuse/otel`, `@langfuse/tracing`, `@opentelemetry/sdk-trace-base` |
| `src/services/langfuse/client.ts` | **New** | SDK init + lifecycle |
| `src/services/langfuse/tracing.ts` | **New** | Trace/Generation/Span |
| `src/services/langfuse/convert.ts` | **New** | Message format conversion |
| `src/services/langfuse/sanitize.ts` | **New** | Data redaction |
| `src/services/api/claude.ts` | Modify | Add recordLLMObservation |
| `src/services/tools/toolExecution.ts` | Modify | Add recordToolObservation |
| `src/QueryEngine.ts` | Modify | Add trace lifecycle |
| `src/query.ts` | Modify | Add batch span management |

## 6. Dependencies

- `@langfuse/otel` — OpenTelemetry integration
- `@langfuse/tracing` — Langfuse tracing SDK
- `@opentelemetry/sdk-trace-base` — OTel trace provider

### 6.1 OTel 依赖冲突缓解方案

`@opentelemetry/sdk-trace-base` 可能与 ola-cc 现有 OTel 依赖冲突。缓解措施：

**package.json 约束**：
```json
{
  "peerDependencies": {
    "@opentelemetry/sdk-trace-base": "^1.x"
  },
  "peerDependenciesMeta": {
    "@opentelemetry/sdk-trace-base": { "optional": true }
  }
}
```

**安装降级选项**：
```bash
# 正常安装（推荐）
bun install

# 如果出现 peer dependency 冲突
bun install --legacy-peer-deps
```

**运行时隔离**：Langfuse 使用独立的 `BasicTracerProvider` 实例，不与 ola-cc 其他 OTel 使用共享 provider，避免全局污染。

## 7. Risks

- `@opentelemetry/sdk-trace-base` may conflict with existing OTel dependencies in ola-cc（缓解方案见 §6.1）
- `MACRO.VERSION` availability needs verification (build-time injection)
- Home directory regex in sanitize needs adaptation for ola-cc path structure
- When Langfuse is not configured (`isLangfuseEnabled() === false`), all tracing functions must be no-ops with zero overhead
