# 基础设施加固设计

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: claude-code + openclaude + oh-my-claudecode
**Priority**: P1/P2
**Effort**: M

---

## 1. 概述

基础设施加固覆盖：LSP Passive Feedback、Tool Argument Normalization、MiniMax Provider、Persistent Agent Memory、Pre-Compact Checkpoint、Empty Message Sanitizer、Non-Interactive Env、Agent Usage Reminder、File Change Watcher、Post-Sampling Hook、Session History Search、Model Benchmarking。

### 依赖矩阵

- Pre-Compact Checkpoint → 无外部依赖（独立实现）
- LSP Passive Feedback → 依赖 [lsp-tools-design.md](./2026-06-03-lsp-tools-design.md) 的 LSP 基础设施（已确认文件存在）

---

## 2. LSP Passive Feedback (P1)

**Source**: `/Users/heal/claude-code/src/services/lsp/passiveFeedback.ts`

### 2.1 核心机制

自动将 LSP 发现的诊断信息注入到对话上下文中，作为 attachment 追加到消息。

### 2.2 接口定义

```typescript
interface LspPassiveFeedbackConfig {
  /** 启用的诊断严重度级别 */
  severityFilter: ('error' | 'warning' | 'information' | 'hint')[]

  /** 每条消息最多注入的诊断数量，防止上下文膨胀 */
  maxDiagnosticsPerMessage: number

  /** 注入格式：'attachment' 追加到消息，'system' 注入为系统消息 */
  injectionMode: 'attachment' | 'system'

  /** 忽略的诊断来源（如某些 noisy linter） */
  ignoredSources: string[]
}

interface LspDiagnostic {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'information' | 'hint'
  message: string
  source: string
  code?: string | number
}
```

### 2.3 流程

```
LSP 诊断 → 过滤严重度 → 格式化为 attachment → 追加到用户消息
```

### 2.4 代码骨架

```typescript
// src/services/lsp/passiveFeedback.ts
export function collectDiagnostics(
  files: string[],
  config: LspPassiveFeedbackConfig
): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = []
  for (const file of files) {
    const raw = lspClient.getDiagnostics(file)
    for (const d of raw) {
      if (!config.severityFilter.includes(d.severity)) continue
      if (config.ignoredSources.includes(d.source)) continue
      diagnostics.push(normalizeDiagnostic(d, file))
    }
  }
  return diagnostics.slice(0, config.maxDiagnosticsPerMessage)
}

export function formatDiagnosticsAsAttachment(diagnostics: LspDiagnostic[]): string {
  return diagnostics
    .map(d => `[${d.severity}] ${d.file}:${d.line}:${d.column} — ${d.message} (${d.source})`)
    .join('\n')
}
```

### 2.5 Integration

| File | Operation |
|------|-----------|
| `src/services/lsp/passiveFeedback.ts` | **New** |
| `src/query/query.ts` | Modify — 消息中追加 LSP 诊断 |

---

## 3. Tool Argument Normalization (P1)

**Source**: `/Users/heal/openclaude/src/services/api/toolArgumentNormalization.ts`

### 3.1 核心功能

自动修复 LLM 输出的格式错误：
- 纯字符串参数自动包装为 `{command: "..."}` 格式
- 处理 malformed JSON
- 类型强制转换

### 3.2 接口定义

```typescript
interface NormalizationRule {
  /** 规则名称，用于日志和调试 */
  name: string

  /** 匹配条件：工具名 + 参数类型 */
  matches: {
    toolName?: string
    paramType?: 'string' | 'array' | 'object' | 'malformed-json'
  }

  /** 转换函数：输入原始参数，返回规范化后的参数 */
  transform: (raw: unknown, schema: ToolInputSchema) => unknown
}

interface NormalizationResult {
  original: unknown
  normalized: unknown
  appliedRules: string[]
  changed: boolean
}
```

### 3.3 代码骨架

```typescript
// src/services/api/toolArgumentNormalization.ts
export function normalizeToolArgs(
  toolName: string,
  rawArgs: unknown,
  schema: ToolInputSchema,
  rules: NormalizationRule[]
): NormalizationResult {
  let current = rawArgs
  const applied: string[] = []

  for (const rule of rules) {
    if (!rule.matches.toolName || rule.matches.toolName === toolName) {
      const type = detectParamType(current)
      if (!rule.matches.paramType || rule.matches.paramType === type) {
        current = rule.transform(current, schema)
        applied.push(rule.name)
      }
    }
  }

  return {
    original: rawArgs,
    normalized: current,
    appliedRules: applied,
    changed: current !== rawArgs
  }
}

function detectParamType(value: unknown): NormalizationRule['matches']['paramType'] {
  if (typeof value === 'string') {
    try { JSON.parse(value); return 'malformed-json' } catch { return 'string' }
  }
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object' && value !== null) return 'object'
  return undefined
}
```

### 3.4 Integration

| File | Operation |
|------|-----------|
| `src/services/api/toolArgumentNormalization.ts` | **New** |
| `src/query.ts` | Modify — 工具调用前规范化参数 |

---

## 4. MiniMax Provider (P2)

**Source**: `/Users/heal/openclaude/src/utils/model/minimaxModels.ts`

### 4.1 核心功能

MiniMax 模型完整集成：M2/M2.5/M3 等模型列表、模型选择器、API 兼容层。

### 4.2 Provider 集成说明

集成到 `src/services/api/client.ts` 的 provider 选择逻辑中，通过 `CLAUDE_CODE_USE_MINIMAX` 环境变量激活。与现有的 `CLAUDE_CODE_USE_OPENAI`、`CLAUDE_CODE_USE_BEDROCK` 等环境变量并列，遵循统一的 provider 分发模式。

### 4.3 Integration

| File | Operation |
|------|-----------|
| `src/utils/model/minimaxModels.ts` | **New** |
| `src/services/api/client.ts` | Modify — 添加 CLAUDE_CODE_USE_MINIMAX 分支 |

---

## 5. Persistent Agent Memory (P1)

**Source**: `/Users/heal/openclaude/src/tools/AgentTool/agentMemory.ts`

### 5.1 三作用域

| 作用域 | 路径 | 用途 |
|--------|------|------|
| user | `~/.claude/` | 用户级偏好 |
| project | `.claude/` | 项目级知识 |
| local | `.claude/local/` | 本地临时 |

支持远程目录挂载（`CLAUDE_CODE_REMOTE_MEMORY_DIR`）。

### 5.2 接口定义

```typescript
interface AgentMemoryStore {
  /** 读取指定 key 的记忆条目，不存在返回 undefined */
  read(scope: 'user' | 'project' | 'local', key: string): Promise<MemoryEntry | undefined>

  /** 写入记忆条目，覆盖已有值 */
  write(scope: 'user' | 'project' | 'local', key: string, entry: MemoryEntry): Promise<void>

  /** 列出指定作用域下所有记忆条目的 key 和元数据 */
  list(scope: 'user' | 'project' | 'local'): Promise<MemoryIndex[]>

  /** 删除指定记忆条目，不存在时静默成功 */
  delete(scope: 'user' | 'project' | 'local', key: string): Promise<void>
}

interface MemoryEntry {
  content: string
  createdAt: number
  updatedAt: number
  tags: string[]
  source: 'auto-extract' | 'manual' | 'consolidation'
}

interface MemoryIndex {
  key: string
  summary: string
  updatedAt: number
  tags: string[]
}
```

### 5.3 Integration

| File | Operation |
|------|-----------|
| `src/tools/AgentTool/agentMemory.ts` | **New** |
| `src/tools/AgentTool/` | Modify — 集成记忆系统 |

---

## 6. Pre-Compact Checkpoint (P1)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/pre-compact/index.ts`

### 6.1 核心机制

Pre-Compact Checkpoint 在 compact 触发前保存当前状态快照（活动模式、TODO 摘要、后台任务状态）。独立实现，不依赖外部 mode-registry 概念。

**性能估算**：典型会话快照大小约 5-20KB JSON，compact 前额外延迟 <50ms（序列化 + 写入临时文件）。

### 6.2 接口定义

```typescript
interface PreCompactCheckpoint {
  /** 快照时间戳 */
  timestamp: number

  /** 会话 ID */
  sessionId: string

  /** 活动模式状态（autopilot/ralph/ultraqa/none） */
  activeMode: string

  /** TODO 摘要：未完成任务列表 */
  todoSummary: Array<{ id: string; text: string; status: string }>

  /** Wisdom 条目：学习系统的关键记忆 */
  wisdom: Array<{ key: string; content: string }>

  /** 后台任务状态 */
  backgroundTasks: Array<{ id: string; name: string; status: string; progress?: number }>

  /** compact 前的消息数量 */
  messageCount: number

  /** 快照序列化后的字节大小 */
  sizeBytes: number
}
```

### 6.3 保存内容

| 内容 | 来源 |
|------|------|
| 活动模式状态 | 当前会话状态 |
| TODO 摘要 | todo 系统 |
| Wisdom | 学习系统 |
| 后台任务状态 | task 系统 |

### 6.4 代码骨架

```typescript
// src/services/compact/preCompactCheckpoint.ts
export async function savePreCompactCheckpoint(
  sessionId: string,
  state: AppState,
  deps: {
    todoSystem: TodoSystem
    wisdomSystem: WisdomSystem
    taskSystem: BackgroundTaskSystem
  }
): Promise<PreCompactCheckpoint> {
  const checkpoint: PreCompactCheckpoint = {
    timestamp: Date.now(),
    sessionId,
    activeMode: state.activeMode ?? 'none',
    todoSummary: await deps.todoSystem.getIncomplete(),
    wisdom: await deps.wisdomSystem.export(),
    backgroundTasks: await deps.taskSystem.getStatuses(),
    messageCount: state.messages.length,
    sizeBytes: 0
  }

  const serialized = JSON.stringify(checkpoint)
  checkpoint.sizeBytes = serialized.length

  const checkpointPath = path.join(getCheckpointDir(sessionId), `pre-compact-${checkpoint.timestamp}.json`)
  await fs.promises.writeFile(checkpointPath, serialized, 'utf-8')

  return checkpoint
}
```

### 6.5 Integration

| File | Operation |
|------|-----------|
| `src/services/compact/preCompactCheckpoint.ts` | **New** |
| `src/services/compact/compact.ts` | Modify — 压缩前保存快照 |

---

## 7. Empty Message Sanitizer (P2)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/empty-message-sanitizer/index.ts`

### 7.1 核心功能

防止空消息导致 API 错误：自动检测并注入占位符到空内容消息。

### 7.2 代码骨架

```typescript
// src/services/api/emptyMessageSanitizer.ts
const PLACEHOLDER = '[empty message — no content provided]'

export function sanitizeMessages(messages: ApiMessage[]): ApiMessage[] {
  return messages.map(msg => {
    if (msg.role !== 'user' && msg.role !== 'assistant') return msg

    const content = msg.content
    if (typeof content === 'string' && content.trim() === '') {
      return { ...msg, content: PLACEHOLDER }
    }
    if (Array.isArray(content) && content.length === 0) {
      return { ...msg, content: [{ type: 'text', text: PLACEHOLDER }] }
    }
    if (Array.isArray(content)) {
      const hasNonEmpty = content.some(
        block => block.type === 'text' && block.text?.trim() !== ''
      )
      if (!hasNonEmpty) {
        return { ...msg, content: [...content, { type: 'text', text: PLACEHOLDER }] }
      }
    }
    return msg
  })
}
```

### 7.3 Integration

| File | Operation |
|------|-----------|
| `src/services/api/emptyMessageSanitizer.ts` | **New** |
| `src/query.ts` | Modify — 发送前检查空消息 |

---

## 8. Non-Interactive Environment Hook (P2)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/non-interactive-env/index.ts`

### 8.1 核心功能

CI/cron 环境适配：自动检测非交互环境，注入 `GIT_TERMINAL_PROMPT=0` 等变量，禁止 vim/less 等交互命令。

### 8.2 代码骨架

```typescript
// src/hooks/non-interactive-env/index.ts
interface NonInteractiveEnvConfig {
  /** 需要注入的环境变量 */
  envVars: Record<string, string>
  /** 禁止的命令列表 */
  blockedCommands: string[]
}

const DEFAULT_CONFIG: NonInteractiveEnvConfig = {
  envVars: {
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: ':',
    EDITOR: ':',
    VISUAL: '',
    PAGER: 'cat',
    npm_config_yes: 'true',
    HOMEBREW_NO_AUTO_UPDATE: '1'
  },
  blockedCommands: ['vim', 'vi', 'nano', 'less', 'more', 'top', 'htop']
}

export function isNonInteractive(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.JENKINS_URL ||
    process.env.CIRCLECI ||
    !process.stdin.isTTY
  )
}

export function applyNonInteractiveEnv(config = DEFAULT_CONFIG): void {
  if (!isNonInteractive()) return
  for (const [key, value] of Object.entries(config.envVars)) {
    if (!process.env[key]) process.env[key] = value
  }
}
```

### 8.3 Integration

| File | Operation |
|------|-----------|
| `src/hooks/non-interactive-env/` | **New** |
| `src/setup.ts` | Modify — 环境检测 |

---

## 9. Agent Usage Reminder (P2)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/agent-usage-reminder/index.ts`

### 9.1 核心功能

智能代理使用提醒：当用户直接调用搜索/获取工具而未委托给 agent 时，追加提醒消息。

### 9.2 接口定义

```typescript
interface UsageReminderConfig {
  /** 触发提醒的工具名称列表（如 Grep, Glob, WebSearch） */
  monitoredTools: string[]

  /** 同一工具连续调用次数阈值，超过后触发提醒 */
  threshold: number

  /** 提醒消息模板，支持 {{toolName}} 和 {{count}} 占位符 */
  messageTemplate: string

  /** 提醒冷却时间（秒），冷却期内不重复提醒同一工具 */
  cooldownSeconds: number

  /** 是否在子代理中禁用提醒 */
  disableInSubagent: boolean
}
```

### 9.3 Integration

| File | Operation |
|------|-----------|
| `src/hooks/agent-usage-reminder/` | **New** |

---

## 10. File Change Watcher (P2)

**Source**: `/Users/heal/openclaude/src/utils/hooks/fileChangedWatcher.ts`

### 10.1 核心功能

实时文件变更监听：使用 chokidar 监听 `.envrc|.env` 等文件变化，自动触发 CwdChanged/FileChanged hooks。

**兼容性说明**：Bun 原生支持 `fs.watch`，可作为首选方案。chokidar 作为 fallback，用于处理跨平台兼容性问题（如 Linux 上的 inotify 限制）。实现时优先使用 `fs.watch`，检测到不支持时自动降级到 chokidar。

**清理策略**：提供 `dispose()` 方法，在 session 结束时关闭所有 watcher 并释放资源。

### 10.2 接口定义

```typescript
interface FileWatcherConfig {
  /** 监听的文件路径或 glob 模式列表 */
  paths: string[]

  /** 防抖延迟（毫秒），变更事件在此时间内合并 */
  debounceMs: number

  /** 监听的事件类型 */
  events: ('add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir')[]

  /** 忽略的路径模式（glob） */
  ignored: string[]

  /** 是否递归监听子目录 */
  recursive: boolean

  /** 文件变更时的回调 */
  onChange: (event: FileChangeEvent) => void | Promise<void>
}

interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
  timestamp: number
}
```

### 10.3 Integration

| File | Operation |
|------|-----------|
| `src/utils/hooks/fileChangedWatcher.ts` | **New** |

---

## 11. Post-Sampling Hook API (P2)

**Source**: `/Users/heal/openclaude/src/utils/hooks/postSamplingHooks.ts`

### 11.1 核心功能

模型采样后回调 API：`registerPostSamplingHook()` 注册回调，在每次模型响应完成后执行。

### 11.2 接口定义

```typescript
interface PostSamplingHook {
  /** Hook 名称，用于日志和取消注册 */
  name: string

  /** 优先级，数值越小越先执行 */
  priority: number

  /** 回调函数：接收采样结果，可修改或记录 */
  onSample: (context: PostSamplingContext) => void | Promise<void>
}

interface PostSamplingContext {
  /** 模型响应的完整文本 */
  responseText: string

  /** 使用的模型 ID */
  modelId: string

  /** Token 用量统计 */
  usage: { inputTokens: number; outputTokens: number }

  /** 响应延迟（毫秒） */
  latencyMs: number

  /** 是否被中断 */
  interrupted: boolean
}
```

### 11.3 Integration

| File | Operation |
|------|-----------|
| `src/utils/hooks/postSamplingHooks.ts` | **New** |

---

## 12. Session History Search (P2)

**Source**: `/Users/heal/oh-my-claudecode/src/features/session-history-search/index.ts`

### 12.1 核心功能

跨会话历史搜索：搜索 JSONL 转录文件，支持时间范围过滤（`30m`/`2h`/`7d`）、项目路径过滤、worktree 感知。

### 12.2 接口定义

```typescript
interface SessionHistorySearchQuery {
  /** 搜索关键词（支持正则） */
  pattern: string

  /** 时间范围过滤，支持相对时间（30m/2h/7d）和绝对时间 */
  timeRange?: { from?: string; to?: string }

  /** 项目路径过滤 */
  projectPath?: string

  /** 是否搜索 worktree 会话 */
  includeWorktrees: boolean

  /** 最大返回结果数 */
  limit: number
}

interface SessionSearchResult {
  sessionId: string
  projectPath: string
  timestamp: number
  matches: Array<{ role: string; snippet: string; lineIndex: number }>
  score: number
}
```

### 12.3 Integration

| File | Operation |
|------|-----------|
| `src/services/session-history-search/` | **New** |
| `src/commands/search/` | **New** — /search 命令 |

---

## 13. Model Benchmarking (P3)

**Source**: `/Users/heal/openclaude/src/utils/model/benchmark.ts`

### 13.1 核心功能

模型速度/质量基准测试：测量首 token 延迟、token/s、支持多 provider 对比。

### 13.2 Integration

| File | Operation |
|------|-----------|
| `src/utils/model/benchmark.ts` | **New** |
| `src/commands/benchmark/` | **New** |

---

## 14. 架构师视角

### 14.1 分层架构

```
加固层:    Empty Message Sanitizer → Tool Argument Normalization → Non-Interactive Env
反馈层:    LSP Passive Feedback → Agent Usage Reminder → Post-Sampling Hook
状态层:    Pre-Compact Checkpoint → Persistent Agent Memory → Session History Search
扩展层:    MiniMax Provider → Model Benchmarking → File Change Watcher
```

### 14.2 ola-cc 适配

- LSP Passive Feedback：可与现有 LSP 工具集成
- Pre-Compact Checkpoint：可与现有 compact 系统集成
- Persistent Agent Memory：可与现有 memory 系统集成
- Tool Argument Normalization：可集成到工具执行流程

---

## 15. 产品经理视角

### 15.1 用户价值

| 功能 | 解决的痛点 | 频率 | 影响 |
|------|-----------|------|------|
| LSP Passive Feedback | "AI 不知道代码有诊断问题" | 每次编辑 | 高 |
| Pre-Compact Checkpoint | "压缩后丢失模式状态" | 每次压缩 | 高 |
| Tool Argument Normalization | "工具调用格式错误" | 偶发 | 中 |
| Session History Search | "找不到之前会话的内容" | 每周 | 中 |
| Empty Message Sanitizer | "空消息导致 API 错误" | 偶发 | 低 |
| Non-Interactive Env | "CI 环境下行为异常" | CI 场景 | 中 |

---

## 16. Feature Flags

所有功能默认关闭，通过环境变量激活。

| Flag 名称 | 默认 | 功能模块 | 降级策略 |
|-----------|------|---------|---------|
| `OLA_CC_LSP_PASSIVE_FEEDBACK` | off | LSP Passive Feedback | 不注入 LSP 诊断，用户手动查看 |
| `OLA_CC_TOOL_ARG_NORMALIZATION` | off | Tool Argument Normalization | 跳过规范化，原始参数直接传递给工具 |
| `OLA_CC_MINIMAX_PROVIDER` | off | MiniMax Provider | 不识别 MiniMax 模型，回退到 OpenAI 兼容层 |
| `OLA_CC_PERSISTENT_AGENT_MEMORY` | off | Persistent Agent Memory | 降级为会话内临时记忆（内存 Map） |
| `OLA_CC_PRE_COMPACT_CHECKPOINT` | off | Pre-Compact Checkpoint | 压缩前不保存快照，模式状态可能丢失 |
| `OLA_CC_EMPTY_MSG_SANITIZER` | off | Empty Message Sanitizer | 不注入占位符，空消息直接发送（可能触发 API 错误） |
| `OLA_CC_NON_INTERACTIVE_ENV` | off | Non-Interactive Environment | 不检测 CI 环境，按交互模式运行 |
| `OLA_CC_AGENT_USAGE_REMINDER` | off | Agent Usage Reminder | 不追加提醒消息 |
| `OLA_CC_FILE_CHANGE_WATCHER` | off | File Change Watcher | 不监听文件变更，需手动刷新 |
| `OLA_CC_POST_SAMPLING_HOOK` | off | Post-Sampling Hook | 不执行采样后回调 |
| `OLA_CC_SESSION_HISTORY_SEARCH` | off | Session History Search | `/search` 命令不可用 |
| `OLA_CC_MODEL_BENCHMARKING` | off | Model Benchmarking | `/benchmark` 命令不可用 |

---

## 17. LOC 估算总表

| # | 功能 | 文件 | 难度 | 新增 LOC | 修改 LOC | 说明 |
|---|------|------|------|---------|---------|------|
| 1 | LSP Passive Feedback | `src/services/lsp/passiveFeedback.ts` | M | ~120 | — | 含接口 + 过滤逻辑 + 格式化 |
| 2 | Tool Argument Normalization | `src/services/api/toolArgumentNormalization.ts` | M | ~150 | — | 含规则引擎 + JSON 修复 + 类型强制 |
| 3 | MiniMax Provider | `src/utils/model/minimaxModels.ts` | S | ~80 | — | 模型列表 + 选择器 |
| 4 | Persistent Agent Memory | `src/tools/AgentTool/agentMemory.ts` | L | ~200 | — | 三作用域 CRUD + 远程挂载 |
| 5 | Pre-Compact Checkpoint | `src/services/compact/preCompactCheckpoint.ts` | M | ~130 | — | 快照序列化 + 保存 + 恢复 |
| 6 | Empty Message Sanitizer | `src/services/api/emptyMessageSanitizer.ts` | S | ~60 | — | 检测 + 占位符注入 |
| 7 | Non-Interactive Env | `src/hooks/non-interactive-env/index.ts` | S | ~80 | — | 环境检测 + 变量注入 |
| 8 | Agent Usage Reminder | `src/hooks/agent-usage-reminder/index.ts` | M | ~100 | — | 计数器 + 阈值 + 提醒模板 |
| 9 | File Change Watcher | `src/utils/hooks/fileChangedWatcher.ts` | M | ~110 | — | fs.watch + chokidar fallback |
| 10 | Post-Sampling Hook | `src/utils/hooks/postSamplingHooks.ts` | S | ~70 | — | Hook 注册 + 执行 + 优先级 |
| 11 | Session History Search | `src/services/session-history-search/index.ts` | L | ~180 | — | JSONL 解析 + 搜索 + 过滤 |
| 12 | Model Benchmarking | `src/utils/model/benchmark.ts` | M | ~140 | — | 延迟测量 + 多 provider 对比 |
| | **合计** | **12 个新文件** | | **~1420** | | |

修改文件汇总：

| 文件 | 修改内容 | 修改 LOC |
|------|---------|---------|
| `src/query/query.ts` | 追加 LSP 诊断 + 空消息检查 | ~40 |
| `src/services/api/client.ts` | 添加 MiniMax provider 分支 | ~20 |
| `src/services/compact/compact.ts` | compact 前保存快照 | ~25 |
| `src/setup.ts` | 非交互环境检测 | ~15 |
| `src/tools/AgentTool/` | 集成记忆系统 | ~30 |
| `src/commands/search/` | /search 命令入口 | ~50 |
| `src/commands/benchmark/` | /benchmark 命令入口 | ~40 |
| | **合计** | **~220** |

---

## 18. 实施路线图

| Phase | 功能 | 优先级 | 依赖 | 难度 |
|-------|------|--------|------|------|
| Phase 1 | Tool Argument Normalization + LSP Passive Feedback | P1 | 无 | M |
| Phase 2 | Pre-Compact Checkpoint + Persistent Agent Memory | P1 | compact/memory | L |
| Phase 3 | Session History Search + Post-Sampling Hook | P2 | JSONL 解析 | L |
| Phase 4 | 其余加固项（6 项） | P2/P3 | 无 | M |
