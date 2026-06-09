# Agent 智能增强系统设计

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: oh-my-claudecode + claude-code
**Priority**: P1/P2
**Effort**: M-L

---

## 1. 概述

Agent 智能增强系统覆盖：Rate Limit Wait Daemon、Codebase Map、Factcheck Guard、Magic Keywords、Delegation Enforcer、Context Injector、AgentSummary、Snip Compact、Frustration Detection。

### 1.1 LOC 估算总表

| # | 子功能 | 优先级 | 难度 | 新增文件 | 新增 LOC | 修改文件 | 修改 LOC | 总 LOC |
|---|--------|--------|------|----------|----------|----------|----------|--------|
| 1 | Rate Limit Wait Daemon | P1 | Hard | 3 (`daemon.ts`, `rateLimitChecker.ts`, `tmuxScanner.ts`) | ~700 | 1 (`commands/rate-limit.ts`) | ~80 | ~780 |
| 2 | Codebase Map Generator | P1 | Easy | 2 (`codebaseMap.ts`, `scanner.ts`) | ~300 | 2 (`setup.ts`, `prompts.ts`) | ~40 | ~340 |
| 3 | Factcheck Guard | P2 | Medium | 3 (`factcheck.ts`, `gateChecker.ts`, `pathChecker.ts`) | ~400 | 1 (`postSamplingHooks.ts`) | ~30 | ~430 |
| 4 | Magic Keywords | P2 | Easy | 2 (`magicKeywords.ts`, `patterns.ts`) | ~320 | 1 (`preProcessingHooks.ts`) | ~25 | ~345 |
| 5 | Delegation Enforcer | P1 | Medium | 2 (`delegationEnforcer.ts`, `modelNormalizer.ts`) | ~350 | 1 (`AgentTool.tsx`) | ~30 | ~380 |
| 6 | Context Injector | P2 | Medium | 2 (`contextInjector.ts`, `injectionStrategies.ts`) | ~300 | 1 (`query.ts`) | ~25 | ~325 |
| 7 | AgentSummary | P2 | Easy | 2 (`agentSummary.ts`, `summaryPrompt.ts`) | ~260 | 1 (`UI.tsx`) | ~20 | ~280 |
| 8 | Snip Compact | P2 | Easy | 1 (`snipCompact.ts`) | ~180 | 1 (`query.ts`) | ~20 | ~200 |
| 9 | Frustration Detection | P3 | Easy | 2 (`useFrustrationDetection.ts`, `FeedbackSurvey.tsx`) | ~80 | 0 | 0 | ~80 |
| **合计** | | | | **19 files** | **~2,890** | **8 files** | **~270** | **~3,160** |

---

## 2. Rate Limit Wait Daemon (P1)

**Source**: `/Users/heal/oh-my-claudecode/src/features/rate-limit-wait/` (3 files, 753+174+437 LOC)

### 2.1 接口定义

```typescript
interface RateLimitWaitConfig {
  pollIntervalMs: number          // 轮询间隔（默认 10000）
  maxWaitMs: number               // 最大等待时间（默认 3600000 = 1h）
  tmuxEnabled: boolean            // 是否启用 tmux pane 扫描（默认 true）
  confidenceThreshold: number     // pane 置信度阈值（默认 0.6）
  retryAfterFallback: boolean     // 无 tmux 时降级为 Retry-After 等待（默认 true）
  maxRetries: number              // 降级模式最大重试次数（默认 3）
}

interface RateLimitStatus {
  isLimited: boolean
  retryAfterSeconds: number | null
  limitType: 'minute' | 'hour' | 'day' | 'weekly' | null
  detectedAt: number
}

interface TmuxPaneInfo {
  paneId: string                  // 格式 %\d+
  confidence: number              // 0-1 置信度评分
  hasClaudeCode: boolean
  hasRateLimitMessage: boolean
  isBlocked: boolean
}

interface RateLimitWaitDaemon {
  start(config: RateLimitWaitConfig): Promise<void>
  stop(): Promise<void>
  getStatus(): { running: boolean; currentLimit: RateLimitStatus | null }
}
```

### 2.2 核心机制

后台守护进程监控 API 速率限制，自动在限流重置后恢复 Claude Code 会话。

### 2.3 架构

```
daemon (pollLoop) → checkRateLimitStatus() → tmux pane 扫描 → 恢复序列
```

### 2.4 代码骨架

```typescript
// src/services/rate-limit-wait/daemon.ts
export class RateLimitWaitDaemonImpl implements RateLimitWaitDaemon {
  private config: RateLimitWaitConfig
  private currentLimit: RateLimitStatus | null = null
  private running = false
  private abortController: AbortController | null = null

  async start(config: RateLimitWaitConfig): Promise<void> {
    this.config = config
    this.running = true
    this.abortController = new AbortController()
    await this.pollLoop(this.abortController.signal)
  }

  async stop(): Promise<void> {
    this.running = false
    this.abortController?.abort()
  }

  getStatus() {
    return { running: this.running, currentLimit: this.currentLimit }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      const status = await withTimeout(
        checkRateLimitStatus(),
        30_000
      )
      if (status.isLimited && !this.currentLimit?.isLimited) {
        // 刚进入限流状态
        this.currentLimit = status
        await this.handleRateLimited(status)
      } else if (!status.isLimited && this.currentLimit?.isLimited) {
        // 限流解除
        this.currentLimit = status
        await this.handleRateLimitCleared()
      }
      await sleep(this.config.pollIntervalMs, signal)
    }
  }

  private async handleRateLimited(status: RateLimitStatus): Promise<void> {
    if (this.config.tmuxEnabled && isTmuxAvailable()) {
      const panes = scanTmuxPanes(this.config.confidenceThreshold)
      // 记录被阻塞的 pane，等待限流解除后恢复
      this.blockedPanes = panes.filter(p => p.isBlocked)
    }
  }

  private async handleRateLimitCleared(): Promise<void> {
    for (const pane of this.blockedPanes) {
      await sendTmuxKeys(pane.paneId, 'Enter') // 发送恢复序列
    }
    this.blockedPanes = []
  }
}
```

### 2.5 主循环

每轮执行：
1. 调用 `checkRateLimitStatus()`（带 30 秒超时）
2. 比较前后状态，判断是否需要恢复
3. 如果受限且 tmux 可用，扫描被阻塞的 pane
4. 限制刚解除时，向被阻塞 pane 发送恢复序列

### 2.6 tmux Pane 分析

置信度评分系统：
- 有 Claude Code 指标: +0.4
- 有速率限制消息: +0.4
- 有等待用户输入模式: +0.2
- 多个匹配: +0.1
- 阈值: `isBlocked = hasClaudeCode && hasRateLimitMessage && confidence >= 0.6`

### 2.7 防误报

- `stripGitOutputLines()` 过滤 git log/diff 输出
- `WEEKLY_RATE_LIMIT_PATTERN` 要求相邻有 rate-limit 相关词
- `isValidPaneId()` 校验 `%\d+` 格式防注入
- `sanitizeForTmux()` 转义单引号

### 2.8 安全设计

- 环境变量白名单 `DAEMON_ENV_ALLOWLIST`
- 文件权限 0600
- 配置通过临时文件传递而非命令行参数

### 2.9 非 tmux 降级方案

当 tmux 不可用时，降级为基于时间的等待策略：

```
检测到 429 响应
├── Retry-After header 存在?
│   ├── 是 → 等待 Retry-After 秒数
│   └── 否 → 指数退避: 30s → 60s → 120s (上限 300s)
├── 等待期间 → 显示 spinner + 倒计时 (如 "Rate limited, retrying in 45s...")
└── 等待结束 → 重新发送请求
```

实现要点：
- 无需 tmux pane 扫描，直接在当前进程内阻塞等待
- 使用 `AbortSignal.timeout()` 防止无限等待
- 倒计时通过 `setInterval` 更新 spinner 文案
- 最大重试 3 次，超过后抛出错误让用户手动处理

### 2.10 Integration

| File | Operation |
|------|-----------|
| `src/services/rate-limit-wait/` | **New** — 3 files |
| `src/commands/rate-limit.ts` | **New** — start/stop/status 命令 |

---

## 3. Codebase Map Generator (P1)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/codebase-map.ts` (272 LOC)

### 3.1 接口定义

```typescript
interface CodebaseMapConfig {
  maxFiles: number                // 最大文件数（默认 200）
  maxDepth: number                // 最大递归深度（默认 4）
  ignorePatterns: string[]        // 忽略目录列表
  sourceExtensions: string[]      // 源文件扩展名
  importantFiles: string[]        // 始终包含的文件名
}

interface CodebaseMapResult {
  tree: string                    // 格式化的目录树文本
  fileCount: number
  totalSize: number
  generatedAt: number
  truncated: boolean              // 是否因 maxFiles 被截断
}

interface CodebaseMapGenerator {
  generate(rootPath: string, config?: Partial<CodebaseMapConfig>): Promise<CodebaseMapResult>
  formatForInjection(result: CodebaseMapResult): string  // 输出 [CODEBASE_CONTEXT] 块
}
```

### 3.2 核心机制

会话启动时生成压缩的项目结构快照，注入为上下文减少 30-50% 盲目文件探索。

### 3.3 扫描参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxFiles | 200 | 最大文件数 |
| maxDepth | 4 | 最大递归深度 |
| ignorePatterns | 30+ 目录 | node_modules, .git 等 |

### 3.4 代码骨架

```typescript
// src/services/codebase-map/codebaseMap.ts
export class CodebaseMapGeneratorImpl implements CodebaseMapGenerator {
  async generate(
    rootPath: string,
    config?: Partial<CodebaseMapConfig>
  ): Promise<CodebaseMapResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    const entries: string[] = []
    let fileCount = 0
    let truncated = false

    const walk = async (dir: string, prefix: string, depth: number) => {
      if (depth > cfg.maxDepth) return
      const items = await readdir(dir, { withFileTypes: true })
      const sorted = sortEntries(items) // 目录优先，然后字母序

      for (const item of sorted) {
        if (fileCount >= cfg.maxFiles) { truncated = true; return }
        if (shouldSkip(item.name, cfg.ignorePatterns)) continue

        const fullPath = path.join(dir, item.name)
        const relativePath = path.relative(rootPath, fullPath)

        if (item.isDirectory()) {
          entries.push(`${prefix}${item.name}/`)
          await walk(fullPath, `${prefix}  `, depth + 1)
        } else if (isSourceFile(item.name, cfg) || cfg.importantFiles.includes(item.name)) {
          entries.push(`${prefix}${item.name}`)
          fileCount++
        }
      }
    }

    await walk(rootPath, '', 0)
    return {
      tree: entries.join('\n'),
      fileCount,
      totalSize: await dirSize(rootPath),
      generatedAt: Date.now(),
      truncated
    }
  }

  formatForInjection(result: CodebaseMapResult): string {
    return [
      '[CODEBASE_CONTEXT]',
      result.tree,
      result.truncated ? `// ... truncated (${result.fileCount} files shown)` : '',
      '[/CODEBASE_CONTEXT]'
    ].filter(Boolean).join('\n')
  }
}
```

### 3.5 过滤规则

- 跳过 `SKIP_DIRS`（30+ 目录）
- 跳过隐藏目录、lock 文件
- 只包含 `SOURCE_EXTENSIONS`（35+ 扩展）
- 只包含 `IMPORTANT_FILES`（package.json, tsconfig.json 等）

### 3.6 输出格式

```
├── src/
│   ├── components/
│   │   ├── App.tsx
│   │   └── Header.tsx
│   ├── services/
│   │   └── api.ts
│   └── index.ts
├── package.json
└── tsconfig.json
```

### 3.7 输出格式注入方式

Codebase Map 生成后，作为 system prompt 的 `[CODEBASE_CONTEXT]` 块注入：

```
[CODEBASE_CONTEXT]
├── src/
│   ├── components/
│   │   ├── App.tsx
│   │   └── Header.tsx
│   ├── services/
│   │   └── api.ts
│   └── index.ts
├── package.json
└── tsconfig.json
[/CODEBASE_CONTEXT]
```

注入位置: 在 `src/constants/prompts.ts` 的 system prompt 构建流程中，插入到 tool definitions 之前。使用 `[CODEBASE_CONTEXT]` 标记包裹，便于 agent 识别和引用，也便于 compact 时选择性丢弃。

### 3.8 Integration

| File | Operation |
|------|-----------|
| `src/services/codebase-map/` | **New** — 2 files |
| `src/setup.ts` | Modify — 启动时生成 |
| `src/constants/prompts.ts` | Modify — 注入 `[CODEBASE_CONTEXT]` 块 |

---

## 4. Factcheck Guard (P2)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/factcheck/` (3 files, 175+189 LOC)

### 4.1 接口定义

```typescript
interface FactcheckConfig {
  mode: 'strict' | 'declared' | 'manual' | 'quick'
  gates: Record<string, { check: string; threshold: number }>
  timeout: number                 // 单次检查超时 ms（默认 5000）
}

interface FactcheckResult {
  verdict: 'FAIL' | 'WARN' | 'PASS'
  mismatches: FactcheckMismatch[]
  checkedAt: number
  duration: number
}

interface FactcheckMismatch {
  category: 'A' | 'B' | 'H' | 'C' | 'CWD'
  severity: 'FAIL' | 'WARN'
  message: string
  field?: string
}

interface FactcheckGuard {
  check(claims: Record<string, unknown>, config: FactcheckConfig): Promise<FactcheckResult>
}
```

### 4.2 四种模式

| 模式 | Gate 检查 | 路径检查 | 严格度 |
|------|----------|---------|--------|
| strict | 必须全部 true | 存在性 + 禁止前缀 | 最严 |
| declared | warn if false | 存在性 + 禁止前缀 | 中等 |
| manual | warn if false | 禁止前缀 | 较松 |
| quick | skip | skip | 最松 |

### 4.3 检查类别

| 类别 | 检查项 |
|------|--------|
| A | 缺失必填字段 + 缺失必填 gates |
| B | gate 值检查 |
| H/C | 路径检查（禁止前缀/子串 + 文件存在性） |
| H | 命令检查（禁止变更操作） |
| CWD | claims.cwd 与运行时 cwd 一致性 |

### 4.4 裁决逻辑

最终裁决取所有 mismatch 中最严重的等级：FAIL > WARN > PASS

### 4.5 Gate 值示例

```typescript
const FACTCHECK_GATES = {
  codeChange: {
    check: 'syntax + type check',
    threshold: 0.8
  },
  apiCall: {
    check: 'endpoint exists + params valid',
    threshold: 0.9
  },
  fileOperation: {
    check: 'path safety + permissions',
    threshold: 0.95
  },
  configChange: {
    check: 'schema validation',
    threshold: 0.85
  }
}
```

`threshold` 含义: 当 gate 检查的置信度低于阈值时，strict 模式下裁决为 FAIL。例如 `apiCall` 的 0.9 意味着 API 端点存在性和参数有效性必须高度确信才能通过。

### 4.6 Integration

| File | Operation |
|------|-----------|
| `src/services/factcheck/` | **New** — 3 files |
| `src/query/postSamplingHooks.ts` | Modify — 添加 factcheck hook |

---

## 5. Magic Keywords (P2)

**Source**: `/Users/heal/oh-my-claudecode/src/features/magic-keywords.ts` (298 LOC)

### 5.1 接口定义

```typescript
interface MagicKeywordPattern {
  mode: 'ultrawork' | 'search' | 'analyze' | 'ultrathink'
  triggers: string[]              // 英文触发词
  localizedTriggers: Record<string, string[]> // 多语言触发词 { ko: [...], ja: [...], zh: [...], vi: [...] }
  systemPromptSuffix: string      // 注入的系统提示后缀
}

interface MagicKeywordMatch {
  matched: boolean
  mode: MagicKeywordPattern['mode'] | null
  triggerWord: string | null
  isInformational: boolean        // 是否为信息性上下文（如 "what is X?"）
  confidence: number
}

interface MagicKeywordEngine {
  detect(input: string): MagicKeywordMatch
  buildEnhancedPrompt(match: MagicKeywordMatch, originalPrompt: string): string
}
```

### 5.2 代码骨架

```typescript
// src/services/magic-keywords/magicKeywords.ts
const INFORMATIONAL_PATTERNS = [
  /what\s+is\s+/i, /how\s+does\s+/i, /explain\s+/i,
  /什么是/, /怎么用/, /如何/,
  /무엇/, /어떻게/, /何ですか/, /là gì/
]

export class MagicKeywordEngineImpl implements MagicKeywordEngine {
  private patterns: MagicKeywordPattern[]

  detect(input: string): MagicKeywordMatch {
    const lower = input.toLowerCase().trim()
    for (const pattern of this.patterns) {
      for (const trigger of [...pattern.triggers, ...Object.values(pattern.localizedTriggers).flat()]) {
        if (lower.startsWith(trigger) || lower.includes(` ${trigger} `)) {
          const isInformational = this.checkInformationalContext(input, trigger)
          return {
            matched: !isInformational,
            mode: isInformational ? null : pattern.mode,
            triggerWord: trigger,
            isInformational,
            confidence: isInformational ? 0.1 : 0.95
          }
        }
      }
    }
    return { matched: false, mode: null, triggerWord: null, isInformational: false, confidence: 0 }
  }

  private checkInformationalContext(input: string, trigger: string): boolean {
    // 80 字符窗口内检测信息性意图
    const windowStart = Math.max(0, input.indexOf(trigger) - 40)
    const window = input.slice(windowStart, windowStart + 80)
    return INFORMATIONAL_PATTERNS.some(p => p.test(window))
  }

  buildEnhancedPrompt(match: MagicKeywordMatch, originalPrompt: string): string {
    const pattern = this.patterns.find(p => p.mode === match.mode)
    if (!pattern) return originalPrompt
    return `${originalPrompt}\n\n${pattern.systemPromptSuffix}`
  }
}
```

### 5.3 四种增强模式

| 模式 | 触发词 | 效果 |
|------|--------|------|
| ultrawork | ultrawork, ulw, uw | 最大性能模式，并行 agent 编排 |
| search | search, find, locate 等 16 词 + 多语言 | 附加搜索模式指令 |
| analyze | analyze, investigate 等 20 词 + 多语言 | 深度分析模式 |
| ultrathink | ultrathink, think, reason | 扩展思维模式 |

### 5.4 防误触发

`isInformationalKeywordContext()` 检测信息性上下文（如 "what is ultrawork?"），80 字符窗口内匹配信息性意图模式，避免在询问触发词含义时误触发。

### 5.5 多语言支持

英/韩/日/中/越 五种语言的触发词和信息性意图模式。

### 5.6 Integration

| File | Operation |
|------|-----------|
| `src/services/magic-keywords/` | **New** — 2 files |
| `src/query/preProcessingHooks.ts` | Modify — 添加关键词检测 |

---

## 6. Delegation Enforcer (P1)

**Source**: `/Users/heal/oh-my-claudecode/src/features/delegation-enforcer.ts` (310 LOC)

### 6.1 接口定义

```typescript
interface DelegationEnforcerConfig {
  forceInherit: boolean           // 强制继承父代理模型（默认 false）
  cacheTTL: number                // 配置缓存 TTL ms（默认 60000）
  normalizeAliases: boolean       // 是否规范化模型别名（默认 true）
}

interface DelegationDecision {
  action: 'inherit' | 'normalize' | 'use-default' | 'skip'
  originalModel: string | undefined
  resolvedModel: string | undefined
  reason: string
}

interface DelegationEnforcer {
  enforceModel(
    agentDef: { model?: string },
    parentModel: string,
    config: DelegationEnforcerConfig
  ): DelegationDecision
  normalizeToCcAlias(modelName: string): string
}
```

### 6.2 三层决策

1. **forceInherit 模式**：删除 model 参数，让 agent 继承用户配置的模型
2. **已有 model**：规范化为 CC 支持的别名（sonnet/opus/haiku）
3. **无 model**：从 agent 定义中查找默认模型

### 6.3 配置缓存

基于 20+ 个环境变量构建缓存键，避免每次调用都读磁盘。

### 6.4 与 agent.ts 的优先级

当 Delegation Enforcer 的 `forceInherit` 与 `getAgentModel()` 的非 Claude 保护逻辑冲突时：
1. `getAgentModel()` 的非 Claude 保护优先（安全第一）
2. `forceInherit` 仅在 parent 是 Claude 模型时生效
3. 非 Claude parent 时，Delegation Enforcer 跳过 model 参数注入

### 6.5 模型名规范化

```typescript
normalizeToCcAlias('claude-sonnet-4-6') // → 'sonnet'
normalizeToCcAlias('bedrock/anthropic.claude-3-sonnet') // → 保持不变
```

### 6.6 Integration

| File | Operation |
|------|-----------|
| `src/services/delegation-enforcer/` | **New** — 2 files |
| `src/tools/AgentTool/AgentTool.tsx` | Modify — 调用 enforceModel |

---

## 7. Context Injector (P2)

**Source**: `/Users/heal/oh-my-claudecode/src/features/context-injector/` (2 files, 147+137 LOC)

### 7.1 接口定义

```typescript
interface ContextInjectorConfig {
  strategy: 'prepend' | 'append' | 'wrap'  // 注入策略（默认 'prepend'）
  maxEntriesPerSession: number              // 每 session 最大条目数（默认 100）
  maxEntrySize: number                      // 单条 entry 最大字节数（默认 10240）
  separator: string                         // 分隔符（默认 '\n\n---\n\n')
}

interface ContextEntry {
  id: string
  source: string
  content: string
  priority: 'critical' | 'high' | 'normal' | 'low'
  timestamp: number
  metadata?: Record<string, unknown>
}

interface ContextInjector {
  addEntry(sessionId: string, entry: ContextEntry): void
  injectContext(sessionId: string, originalText: string, config: ContextInjectorConfig): string
  clearSession(sessionId: string): void
  getSessionEntries(sessionId: string): ContextEntry[]
}
```

### 7.2 三种注入策略

| 策略 | 效果 |
|------|------|
| prepend（默认） | context + separator + originalText |
| append | originalText + separator + context |
| wrap | `<injected-context>context</injected-context>` + separator + originalText |

### 7.3 存储模型

`Map<sessionId, Map<"source:id", ContextEntry>>` — 按 session 隔离，按优先级排序。

### 7.4 生命周期管理

- **Session 结束清理**: 监听 session 销毁事件，调用 `store.delete(sessionId)` 释放内存
- **最大条目数**: 每个 session 最多 100 条 ContextEntry，超出时触发 LRU 淘汰
- **LRU 淘汰策略**: 按 `timestamp` 升序淘汰最旧条目；相同 timestamp 时优先淘汰 `priority: 'low'`
- **内存保护**: 单条 entry 最大 10KB，超出截断并标记 `metadata: { truncated: true }`

```typescript
// 生命周期钩子
function onSessionEnd(sessionId: string) {
  store.delete(sessionId)
}

function addEntry(sessionId: string, entry: ContextEntry) {
  const sessionEntries = store.get(sessionId) ?? new Map()
  if (sessionEntries.size >= MAX_ENTRIES_PER_SESSION) {
    evictOldest(sessionEntries)
  }
  sessionEntries.set(`${entry.source}:${entry.id}`, entry)
  store.set(sessionId, sessionEntries)
}
```

### 7.5 Integration

| File | Operation |
|------|-----------|
| `src/services/context-injector/` | **New** — 2 files |
| `src/query/query.ts` | Modify — 用户消息注入 context |

---

## 8. AgentSummary 后台摘要 (P2)

**Source**: `/Users/heal/claude-code/src/services/AgentSummary/` (2 files, 213+33 LOC)

### 8.1 接口定义

```typescript
interface AgentSummaryConfig {
  intervalMs: number              // 摘要生成间隔（默认 30000）
  maxSummaryLength: number        // 最大摘要长度（默认 200 字符）
  promptTemplate: string          // few-shot 提示模板
}

interface AgentSummary {
  agentId: string
  summary: string                 // 1-2 句进度摘要
  generatedAt: number
  actionCount: number             // 自上次摘要以来的操作数
}

interface AgentSummaryService {
  generateSummary(agentId: string, recentMessages: Message[]): Promise<AgentSummary>
  getLatestSummary(agentId: string): AgentSummary | null
  clearSummary(agentId: string): void
}
```

### 8.2 核心机制

Coordinator 模式下子代理的周期性（~30s）后台摘要。fork 子代理生成 1-2 句进度摘要。

### 8.3 Cache 共享

使用与父代理相同的 `CacheSafeParams`，工具保留但通过 callback 拒绝，保证 prompt cache 命中。

### 8.4 Prompt 设计

```typescript
// Few-shot prompting
'Describe your most recent action in 3-5 words using present tense (-ing).'
// Good: "Reading runAgent.ts"
// Bad: "Analyzed the branch diff"
```

### 8.5 Integration

| File | Operation |
|------|-----------|
| `src/services/agent-summary/` | **New** — 2 files |
| `src/tools/AgentTool/UI.tsx` | Modify — 显示后台摘要 |

---

## 9. Snip Compact 消息压缩 (P2)

**Source**: `/Users/heal/claude-code/src/services/compact/snipCompact.ts` (166 LOC)

### 9.1 接口定义

```typescript
interface SnipCompactConfig {
  snipMarker: string              // snip 标记文本（默认 '[SNIPPED]'）
  nudgeThreshold: number          // 触发 nudge 的消息数（默认 30）
  tokenEstimateCharsPerToken: number // 字符/token 比率（默认 4）
  maxSnipRatio: number            // 最大压缩比（默认 0.5，即最多压缩 50% 消息）
}

interface SnipResult {
  originalMessageCount: number
  snippedMessageCount: number
  tokensSaved: number
  snippedIndices: number[]        // 被压缩的消息索引
}

interface SnipCompact {
  shouldNudge(messages: Message[]): boolean
  snipMessages(messages: Message[], config: SnipCompactConfig): { messages: Message[]; result: SnipResult }
  estimateMessageTokens(message: Message): number
}
```

### 9.2 核心机制

基于 snip marker 的消息压缩。当对话超过 30 条消息时，nudge 模型考虑使用 `/force-snip`。

### 9.3 Token 估算

`estimateMessageTokens()` 按 4 字符/token 粗略计算，处理 string/array/object 三种 content 格式。

### 9.4 Integration

| File | Operation |
|------|-----------|
| `src/services/compact/snipCompact.ts` | **New** |
| `src/query.ts` | Modify — 发送 API 前剥离 snipped 消息 |

---

## 10. Frustration Detection (P3)

**Source**: `/Users/heal/claude-code/src/components/FeedbackSurvey/useFrustrationDetection.ts` (60 LOC)

### 10.1 接口定义

```typescript
interface FrustrationConfig {
  errorThreshold: number          // 连续错误次数阈值（默认 2）
  cooldownMs: number              // 触发后冷却时间（默认 300000 = 5min）
}

type FrustrationState = 'closed' | 'transcript_prompt' | 'submitted'

interface FrustrationDetection {
  state: FrustrationState
  consecutiveErrors: number
  recordError(isApiError: boolean): void
  reset(): void
  shouldPrompt(): boolean
}
```

### 10.2 检测逻辑

`isApiErrorMessage` 计数 >= 2 → 判定为挫败。

### 10.3 状态机

`closed` → `transcript_prompt` → `submitted`

### 10.4 Integration

| File | Operation |
|------|-----------|
| `src/hooks/useFrustrationDetection.ts` | **New** |
| `src/components/FeedbackSurvey.tsx` | **New** |

---

## 11. 架构师视角

### 11.1 分层架构

```
Hook 层:    Magic Keywords → Context Injector → Factcheck
Agent 层:   Delegation Enforcer → AgentSummary
系统层:     Rate Limit Wait → Codebase Map → Snip Compact
UI 层:      Frustration Detection
```

### 11.2 与 ola-cc 现有系统的集成点

| 新功能 | ola-cc 现有系统 | 集成方式 |
|--------|----------------|---------|
| Rate Limit Wait | 无 | 新增 daemon |
| Codebase Map | 无 | setup.ts hook |
| Factcheck | codeAuditor | 扩展审计维度 |
| Magic Keywords | 无 | pre-processing hook |
| Delegation Enforcer | AgentTool | 中间件 |
| Context Injector | 无 | query.ts hook |
| AgentSummary | AgentTool UI | 扩展 UI |
| Snip Compact | compact.ts | 扩展压缩策略 |

---

## 12. 产品经理视角

### 12.1 用户价值矩阵

| 功能 | 解决的痛点 | 频率 | 影响 |
|------|-----------|------|------|
| Rate Limit Wait | "rate limit 打断工作" | 每日 | 高 |
| Codebase Map | "agent 不了解项目结构" | 每会话 | 高 |
| Delegation Enforcer | "agent 不用指定的模型" | 每次委托 | 中 |
| Context Injector | "上下文不够丰富" | 每消息 | 中 |
| Magic Keywords | "想快速切换模式" | 每日 | 中 |
| Factcheck | "agent 虚报完成" | 每任务 | 高 |
| AgentSummary | "不知道后台 agent 在干嘛" | 每任务 | 中 |
| Snip Compact | "长对话 token 爆了" | 长会话 | 高 |
| Frustration Detection | "连续出错无人知" | 偶发 | 低 |

---

## Feature Flags

| Flag | 默认 | 环境变量覆盖 | 降级策略 |
|------|------|-------------|---------|
| `OLA_CC_RATE_LIMIT_WAIT` | off | `OLA_CC_RATE_LIMIT_WAIT=1` | 使用现有重试逻辑 |
| `OLA_CC_CODEBASE_MAP` | off | `OLA_CC_CODEBASE_MAP=1` | 跳过启动时结构快照 |
| `OLA_CC_FACTCHECK_GUARD` | off | `OLA_CC_FACTCHECK_GUARD=1` | 使用现有 codeAuditor |
| `OLA_CC_MAGIC_KEYWORDS` | off | `OLA_CC_MAGIC_KEYWORDS=1` | 无关键词增强，手动切换模式 |
| `OLA_CC_DELEGATION_ENFORCER` | off | `OLA_CC_DELEGATION_ENFORCER=1` | 使用现有 getAgentModel() |
| `OLA_CC_CONTEXT_INJECTOR` | off | `OLA_CC_CONTEXT_INJECTOR=1` | 无自动上下文注入 |
| `OLA_CC_AGENT_SUMMARY` | off | `OLA_CC_AGENT_SUMMARY=1` | 不显示后台 agent 摘要 |
| `OLA_CC_SNIP_COMPACT` | off | `OLA_CC_SNIP_COMPACT=1` | 使用现有 compact 逻辑 |
| `OLA_CC_FRUSTRATION_DETECTION` | off | `OLA_CC_FRUSTRATION_DETECTION=1` | 不检测用户挫败状态 |

---

## 13. 实施路线图

| Phase | 功能 | 优先级 | 依赖 |
|-------|------|--------|------|
| Phase 1 | Codebase Map + Delegation Enforcer | P1 | 无 |
| Phase 2 | Rate Limit Wait Daemon | P1 | tmux 集成 |
| Phase 3 | Context Injector + Magic Keywords | P2 | 无 |
| Phase 4 | Factcheck + AgentSummary | P2 | AgentTool |
| Phase 5 | Snip Compact + Frustration Detection | P2/P3 | compact 系统 |
