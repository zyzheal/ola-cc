# yoloClassifier Auto Mode Safety Classifier Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: claude-code-best v2.6.6
**Priority**: P1
**Effort**: L (5+ new files + 3 modified)

---

## 1. Overview

yoloClassifier 是 auto mode 的核心安全机制。当用户启用 auto/bypass permissions 模式时，每个工具调用都会经过 yoloClassifier 分类，决定是否需要用户确认。这是防止 AI 自动执行危险操作的关键防线。

## 2. Core Interface

```typescript
// src/utils/permissions/yoloClassifier.ts
export async function classifyYoloAction(
  messages: Message[],
  action: TranscriptEntry,
  tools: Tools,
  context: ToolPermissionContext,
  signal: AbortSignal,
  parentSpan?: LangfuseSpan | null,
): Promise<YoloClassifierResult>

type YoloClassifierResult = {
  shouldBlock: boolean    // Whether to block the operation
  reason: string          // Classification reason
  model: string           // Classification model used
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }
  durationMs?: number
}
```

## 3. Classification Flow

### 3.1 Transcript Building

```typescript
buildTranscriptEntries(messages) → TranscriptEntry[]
```

- Extract user text messages
- Extract assistant tool_use blocks
- **Exclude assistant text** to prevent prompt injection via assistant messages

### 3.2 Action Compression

```typescript
toCompact(action, lookup) → CompactAction
```

- Uses `Tool.toAutoClassifierInput()` to compress current action
- Reduces token usage for classification

### 3.3 System Prompt Assembly

```typescript
buildYoloSystemPrompt(context) → string
```

Components:
- Base system prompt (classifier instructions)
- Permissions template (what's allowed/denied)
- User allow/deny rules from settings
- Environment context

### 3.4 Classification Modes

**Mode 1: Single-stage structured output**
- Uses `tool_choice` to force structured JSON response
- Faster, fewer tokens

**Mode 2: Two-stage XML**
- Stage 1: `<block>yes/no</block>` classification
- Stage 2: `<reason>` explanation
- More robust, better explanations

### 3.5 Side Query

```typescript
sideQuery(systemPrompt, userMessage, model, signal) → Response
```

- Independent API call channel (not part of main conversation)
- Uses small model (haiku/sonnet) for cost efficiency
- Abortable via AbortSignal

**独立实现方案**（不依赖外部已有的 `sideQuery` 函数）：

```typescript
// 独立实现，不依赖外部 sideQuery
// 优势: 无外部依赖、可独立测试、支持自定义重试策略
async function classifySideQuery(
  prompt: string,
  maxTokens = 1024
): Promise<string> {
  const client = createClient({ model: 'haiku', maxTokens })
  const response = await client.messages.create({
    messages: [{ role: 'user', content: prompt }],
    system: YOLO_CLASSIFIER_SYSTEM_PROMPT,
    max_tokens: maxTokens
  })
  return response.content[0].text
}

// 带重试和超时的包装器
async function classifyWithRetry(
  prompt: string,
  options: { maxRetries?: number; timeoutMs?: number } = {}
): Promise<YoloClassifierResult> {
  const { maxRetries = 2, timeoutMs = 5000 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const text = await classifySideQuery(prompt)
        return parseClassifierResponse(text)
      } catch (err) {
        if (attempt === maxRetries) throw err
        // 指数退避: 100ms, 200ms, 400ms
        await sleep(100 * Math.pow(2, attempt))
      }
    }
    throw new Error('unreachable')
  } finally {
    clearTimeout(timer)
  }
}
```

**与外部 `sideQuery` 的关系**：优先复用 `src/services/api/` 中已有的 `sideQuery` 实现（如果存在）。上述独立实现作为 fallback，在以下场景使用：
1. 外部 `sideQuery` 不存在或接口不兼容
2. 需要自定义重试策略（分类器场景要求低延迟、快速失败）
3. 单元测试中需要 mock 独立的分类通道

## 4. Related Files

| File | Purpose |
|------|---------|
| `yoloClassifier.ts` | Main classifier logic (1500+ lines) |
| `classifierShared.ts` | Shared utilities (transcript building, prompt assembly) |
| `bashClassifier.ts` | Bash-specific classification rules |
| `yolo-classifier-prompts/` | Prompt templates directory |

## 5. Integration Points

### 5.1 Permission Flow

```
User tool call
  → checkPermissions()
    → hasPermissionsToUseToolInner()
      → if auto/bypass mode:
        → classifyYoloAction()
          → if shouldBlock: prompt user for confirmation
          → if !shouldBlock: auto-approve
```

### 5.2 Feature Gate

```typescript
feature('TRANSCRIPT_CLASSIFIER')  // Compile-time gate
```

## 6. Files to Modify

| File | Operation | Description |
|------|-----------|-------------|
| `src/utils/permissions/yoloClassifier.ts` | **New** | Main classifier |
| `src/utils/permissions/classifierShared.ts` | **New** | Shared utilities |
| `src/utils/permissions/bashClassifier.ts` | **New** | Bash-specific rules |
| `src/utils/permissions/yolo-classifier-prompts/` | **New** | Prompt templates |
| `src/utils/permissions/permissions.ts` | Modify | Hook classifier into permission flow |
| `src/Tool.ts` | Modify | Add `toAutoClassifierInput()` method |
| `scripts/build.ts` | Modify | Add `TRANSCRIPT_CLASSIFIER` feature flag |

## 7. Dependencies

- `sideQuery()` — Independent API call channel (need to verify existence in ola-cc)
- GrowthBook feature flags — Runtime gating
- CLAUDE.md cache loop breaking mechanism — Prevents circular dependency in prompt assembly
- `Tool.toAutoClassifierInput()` — Each tool needs to implement this method

## 8. Risks

- **Heavy dependency chain**: sideQuery, GrowthBook, CLAUDE.md caching
- **Per-tool implementation**: Each tool needs `toAutoClassifierInput()` — 53+ tools to update
- **Cost**: Classification uses additional API calls (small model, but still cost)
- **Latency**: Each tool call adds classification latency (~1-2s)
- **False positives**: Classifier may block safe operations, requiring user override

## 9. `toAutoClassifierInput()` Phased Implementation Strategy

53+ 工具需要实现 `toAutoClassifierInput()` 方法，采用分批实施策略降低风险：

### Phase 1: Core 8 Tools (Priority: Highest, covers ~90% usage)

| Tool | Reason |
|------|--------|
| `Bash` | Highest risk, most frequent tool call |
| `Edit` | File modification, high frequency |
| `Write` | File creation/overwrite, high risk |
| `Read` | Low risk but high frequency, baseline |
| `Glob` | Low risk, high frequency |
| `Grep` | Low risk, high frequency |
| `AgentTool` | Subagent delegation, complex context |
| `WebFetch` | External network access, medium risk |

**Phase 1 工时估算**:

```
Phase 1: 8 核心工具 (~3 天)
  - Bash: 0.5d
      最复杂，需 command analysis（解析 shell 命令提取风险因子:
      pipe、重定向、rm -rf、curl | bash 等危险模式）
  - Read/Write/Edit: 0.5d
      文件操作，规则明确（路径白名单、文件大小、敏感文件检测）
  - AgentTool: 0.5d
      复杂上下文压缩（子代理嵌套深度、token 预算、递归调用检测）
  - Glob/Grep: 0.5d
      搜索操作，低风险（仅需检查搜索路径范围）
  - WebFetch: 包含在上述 0.5d 中
      网络访问，URL 白名单/黑名单检测
  - 测试 + 集成: 1d
      8 个工具的单元测试 + 权限流程集成测试 + 分类器准确率基准测试
```

### Phase 2: File Operations 6 Tools (Priority: High)

| Tool | Reason |
|------|--------|
| `FileEdit` | Alternative file edit path |
| `FileRead` | Alternative file read path |
| `FileWrite` | Alternative file write path |
| `FileDelete` | Destructive operation |
| `FileMove` | File system mutation |
| `FileCopy` | File system mutation |

### Phase 3: System Tools 10 Tools (Priority: Medium)

| Tool | Reason |
|------|--------|
| `ProcessDiagnostic` | System inspection |
| `Skill` | Skill invocation |
| `MCPTool` | MCP server interaction |
| `NotebookEdit` | Notebook mutation |
| `TodoWrite` | State mutation |
| `AskUserQuestion` | User interaction |
| `WebSearch` | External API call |
| `Task` | Background task management |
| `SubagentResult` | Subagent output handling |
| `ToolSearchTool` | Tool discovery |

### Phase 4: Remaining ~29 Tools (Priority: Low)

Low-frequency tools (buddy, voice, bridge, template, etc.) can be added incrementally. These tools either have minimal risk or are rarely invoked in auto mode.

Each tool's `toAutoClassifierInput()` should return a `ClassifierInput` 结构：

```typescript
interface ClassifierInput {
  toolName: string
  toolDescription: string
  inputSummary: string        // 截断到 500 chars
  riskFactors: string[]       // 从 input 中提取的风险因子
  contextSummary: string      // 最近 3 条消息摘要
}
```

- `inputSummary`：序列化工具输入参数，超过 500 字符时截断并追加 `...[truncated]`
- `riskFactors`：从输入中提取的可操作风险标记（如 `["deletes_file", "network_access", "runs_shell"]`）
- `contextSummary`：取最近 3 条用户/助手消息的前 200 字符拼接，为分类器提供上下文

## 10. Classification Mode Selection Criteria

| Criterion | Single-stage | Two-stage |
|-----------|-------------|-----------|
| Tool count | < 20 | >= 20 |
| Latency budget | < 100ms | No strict limit |
| Accuracy requirement | Moderate | High |
| Explanation needed | No | Yes |
| Token cost sensitivity | High | Low |

**Decision logic:**
1. Default to **Two-stage** mode for production (better accuracy and explainability)
2. Switch to **Single-stage** via feature flag `YOLO_CLASSIFIER_SINGLE_STAGE` when latency is critical
3. Dynamic switching: if tool count in a session drops below 20, auto-downgrade to Single-stage

```typescript
// Runtime mode selection
function selectClassifierMode(toolCount: number): 'single' | 'two-stage' {
  if (feature('YOLO_CLASSIFIER_SINGLE_STAGE')) return 'single'
  if (toolCount < 20 && getLatencyBudget() < 100) return 'single'
  return 'two-stage'
}
```

## 11. Mitigation Strategy

1. Start with conservative classification (block more, allow less)
2. Add user feedback loop (report false positives)
3. Cache classification results for repeated patterns
4. Make classification model configurable (cheaper models for less critical tools)

### 11.1 分类结果缓存策略

相同 `toolName + inputHash` 的分类结果缓存 60 秒，避免重复分类相同操作：

```typescript
const classificationCache = new Map<string, { result: YoloClassifierResult; expiry: number }>()

function getCacheKey(toolName: string, input: ClassifierInput): string {
  const inputHash = hashObject(input)  // 稳定 hash，忽略字段顺序
  return `${toolName}:${inputHash}`
}

async function classifyWithCache(...args: Parameters<typeof classifyYoloAction>): Promise<YoloClassifierResult> {
  const key = getCacheKey(args[2].toolName, args[2])
  const cached = classificationCache.get(key)
  if (cached && cached.expiry > Date.now()) return cached.result

  const result = await classifyYoloAction(...args)
  classificationCache.set(key, { result, expiry: Date.now() + 60_000 })
  return result
}
```

缓存 TTL 选择 60 秒的理由：工具调用间隔通常 < 5 秒，60 秒覆盖连续重复操作；同时避免长期缓存导致用户修改设置后仍命中旧结果。
