# Headroom 上下文压缩增强方案 v4

> 基于 `chopratejas/headroom` (16K stars) **本地源码深度分析** + ola-cc compact 系统架构审计
> v3: Rust 核心 + TypeScript SDK 源码的系统架构师分析
> v4: AgentTool 架构师+算法专家+系统架构师三视角 ola-cc 能力缺陷补偿方案

## 一、Headroom 源码架构分析

### 1.1 SDK 核心模块

```
sdk/typescript/src/
├── compress.ts          # 通用压缩入口（格式自动检测 + hooks）
├── client.ts            # HTTP 客户端（proxy 通信 + SSE 流式）
├── hooks.ts             # 压缩钩子（pre/post/computeBiases）
├── shared-context.ts    # 跨代理共享上下文（压缩 + TTL + LRU）
├── types.ts             # 核心类型定义
├── errors.ts            # 错误类层次
├── adapters/            # 四种 LLM 适配器
│   ├── openai.ts
│   ├── anthropic.ts
│   ├── gemini.ts
│   └── vercel-ai.ts
├── utils/
│   ├── format.ts        # 格式检测 + OpenAI 双向转换
│   ├── case.ts          # camelCase/snake_case 转换
│   └── stream.ts        # SSE 解析
└── types/
    ├── config.ts        # HeadroomConfig + HeadroomMode
    └── models.ts        # 响应模型定义
```

### 1.2 压缩管线 (compress.ts)

```typescript
// 核心流程（7 步）
export async function compress(messages, options): Promise<CompressResult> {
  // 1. Pre-compress hook — 修改消息
  processedMessages = await hooks.preCompress(messages, ctx)

  // 2. 检测输入格式 (OpenAI/Anthropic/Vercel/Gemini)
  inputFormat = detectFormat(processedMessages)

  // 3. 统一转换为 OpenAI 格式（proxy 的 lingua franca）
  openaiMessages = toOpenAI(processedMessages)

  // 4. 计算每条消息的压缩偏差 (>1=多保留, <1=多压缩)
  biases = await hooks.computeBiases(openaiMessages, ctx)

  // 5. 通过 proxy 执行压缩
  result = await client.compress(openaiMessages, { model, tokenBudget })

  // 6. 转换回原始格式
  outputMessages = fromOpenAI(result.messages, inputFormat)

  // 7. Post-compress hook — 只读观察
  await hooks.postCompress(event)
}
```

**关键设计**：
- **格式无关**：自动检测 4 种 LLM 消息格式，统一转 OpenAI 处理后转回
- **Hook 系统**：`preCompress` (可修改) → `computeBiases` (每条消息偏差) → `postCompress` (只读)
- **Token Budget**：支持目标 token 数压缩（用于 compaction 场景）
- **CCR Hashes**：返回可逆压缩的哈希值，用于后续检索

### 1.3 SharedContext（跨代理共享）

```typescript
// 核心：压缩后的上下文共享，带 TTL + LRU 淘汰
class SharedContext {
  async put(key, content, { agent }): Promise<ContextEntry> {
    result = await this.client.compress([{ role: "user", content }], { model })
    entry = {
      key, original: content, compressed: result.messages[0].content,
      originalTokens: result.tokensBefore,
      compressedTokens: result.tokensAfter,
      savingsPercent: ((before - after) / before) * 100,
      transforms: result.transformsApplied,
    }
  }

  get(key, { full?: boolean }): string | null {
    // full=true 返回原文，默认返回压缩版
    return full ? entry.original : entry.compressed
  }
}
```

**关键特性**：
- **原文保留**：`entry.original` 始终保存原文，`entry.compressed` 是压缩版
- **TTL 淘汰**：默认 3600 秒过期
- **LRU 淘汰**：默认最多 100 条，超限删最旧
- **统计**：`stats()` 返回总节省 token 数和压缩率

### 1.4 Hooks 系统 (hooks.ts)

```typescript
class CompressionHooks {
  // 压缩前：可修改消息（如注入 bias、保护特定消息）
  preCompress(messages, ctx): messages | Promise<messages>

  // 计算偏差：index → bias (>1=多保留, <1=多压缩)
  computeBiases(messages, ctx): Record<number, number>

  // 压缩后：只读观察（如日志、指标）
  postCompress(event: CompressEvent): void
}
```

**CompressContext**：
```typescript
interface CompressContext {
  model: string        // 当前模型
  userQuery: string    // 最后一条用户消息
  turnNumber: number   // 对话轮次数
  toolCalls: string[]  // 工具调用名称列表
  provider: string     // 提供商
}
```

### 1.5 Client (client.ts)

```typescript
class HeadroomClient {
  // 直接压缩
  async compress(messages, { model, tokenBudget }): CompressResult

  // OpenAI 风格透传（自动压缩）
  chat.completions.create({ model, messages, stream, headroomMode, ... })

  // Anthropic 风格透传（自动压缩）
  messages.create({ model, messages, max_tokens, system, stream, ... })

  // 模拟压缩（不调用 LLM）
  chat.completions.simulate({ model, messages }): SimulationResult

  // CCR 检索
  retrieve(hash): RetrieveResult
}
```

**HeadroomMode**：
- `default` — 标准压缩
- `simulate` — 仅模拟，不实际压缩
- `passthrough` — 透传，不压缩

### 1.6 代理配置参数

```typescript
interface HeadroomParams {
  headroomMode?: HeadroomMode           // 压缩模式
  headroomCachePrefixTokens?: number    // 缓存前缀 token 数
  headroomOutputBufferTokens?: number   // 输出缓冲 token 数
  headroomKeepTurns?: number            // 保留最近 N 轮
  headroomToolProfiles?: Record<string, Record<string, any>>  // 工具压缩配置
}
```

## 二、ola-cc compact 系统架构审计

### 2.1 四层压缩架构

```
[1] MicroCompact (microCompact.ts) — 每次 API 调用前
    ├─ 时间触发: 清除旧工具结果
    ├─ 缓存编辑: consumePendingCacheEdits()
    └─ 保护: shouldProtectToolResult() (源码+错误)

[2] Session Memory (sessionMemory.ts) — 后台异步
    ├─ 触发: token 增长 + 工具调用次数双阈值
    ├─ 执行: runForkedAgent() 隔离子代理
    └─ 输出: 结构化 markdown 笔记

[3] SM-Compact (sessionMemoryCompact.ts) — 阈值触发
    ├─ 触发: autoCompactIfNeeded() 优先尝试
    ├─ 策略: 保留 10K-40K tokens + ≥5 条文本消息
    └─ 失败: 降级到 Full-compact

[4] Full-Compact (compact.ts) — LLM 摘要
    ├─ prompt: 9 段结构化摘要模板
    ├─ 附件: 文件(50K) + 技能(25K) + 计划 + 目标
    └─ 重试: PTL 3 次 + 流式 2 次
```

### 2.2 精确集成点

| 集成点 | 文件:行号 | 说明 | 风险 |
|--------|----------|------|------|
| A1 | `compact.ts:471` | 压缩前消息预处理（`let messagesToSummarize = messages` 之前） | 高 |
| A2 | `compact.ts:549` | 摘要后处理增强（`streamCompactSummary` 完成后） | 中高 |
| A3 | `compact.ts:580-648` | 后压缩附件选择优化（`Promise.all` 附件构建区） | 中 |
| A4 | `microCompact.ts:118-146` | 保护策略增强（`shouldProtectToolResult` 函数） | 中 |
| A5 | `sessionMemoryCompact.ts:328-401` | SM-Compact 保留策略（`calculateMessagesToKeepIndex`） | 中 |
| A6 | `prompt.ts:72-154` | 压缩 Prompt 增强（`BASE_COMPACT_PROMPT` 常量） | 低 |
| A7 | `sessionMemory.ts:134-181` | 提取触发优化（`shouldExtractMemory` 函数） | 中 |
| A8 | `sessionMemory.ts:272-350` | Session→Auto Memory 沉淀 | 高 |

### 2.3 已知风险点

| 风险 | 位置 | 影响 |
|------|------|------|
| lastSummarizedMessageId 竞态 | sessionMemoryUtils.ts:44-69 | SM-compact 可能用过时 ID |
| Token 估算不一致 | 多处使用 4 种不同方法 | 阈值判断偏差 20-30% |
| MC≥5 跳过 SM-compact | autoCompact.ts:349-362 | 硬编码阈值 5 可能不准 |
| Worker 降级状态丢失 | compactOrchestrator.ts:181-222 | context 被部分修改 |
| 向量索引异步不一致 | memoryIndex.ts:121-138 | BM25 同步但向量异步 |

## 三、优化方案

### 方案 1: CCR 可逆压缩层（Headroom SharedContext 模式）

**核心思想**：借鉴 Headroom 的 `SharedContext.put()` 模式 — 压缩时保留原文，按需检索。

#### 3.1.1 架构设计

```
┌──────────────────────────────────────────────────────────┐
│                    CCR 可逆压缩层                         │
├──────────────────────────────────────────────────────────┤
│  CCRStore (借鉴 SharedContext)                            │
│  ├─ put(key, content) → { compressed, refId }            │
│  ├─ get(key, { full?: boolean }) → string                │
│  ├─ TTL: 3600s (可配置)                                   │
│  ├─ LRU: 最多 200 条 (可配置)                              │
│  └─ 存储: .ola-cc/ccr-store/{session-id}/                │
├──────────────────────────────────────────────────────────┤
│  CompressionHooks (借鉴 Headroom hooks.ts)               │
│  ├─ preCompactHook: 注入 bias，保护高价值消息             │
│  ├─ computeBiases: 基于消息类型计算偏差                   │
│  └─ postCompactHook: 记录压缩指标                        │
├──────────────────────────────────────────────────────────┤
│  CCRRetrieveTool (新增)                                   │
│  └─ LLM 按 refId 检索原始内容                             │
└──────────────────────────────────────────────────────────┘
```

#### 3.1.2 核心实现

```typescript
// src/services/compact/ccr.ts

import { createHash } from 'crypto'
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises'
import { join } from 'path'

interface CCREntry {
  key: string
  original: string
  compressed: string
  originalTokens: number
  compressedTokens: number
  refId: string
  messageId: string
  blockIndex: number
  type: 'tool_result' | 'text' | 'image'
  timestamp: number
  transforms: string[]
}

interface CCRStats {
  entries: number
  totalOriginalTokens: number
  totalCompressedTokens: number
  savingsPercent: number
}

export class CCRStore {
  private entries = new Map<string, CCREntry>()
  private storeDir: string
  private ttl: number
  private maxEntries: number

  constructor(options: {
    storeDir: string
    ttl?: number      // 默认 3600s
    maxEntries?: number // 默认 200
  }) {
    this.storeDir = options.storeDir
    this.ttl = options.ttl ?? 3600
    this.maxEntries = options.maxEntries ?? 200
  }

  async init(): Promise<void> {
    await mkdir(this.storeDir, { recursive: true, mode: 0o700 })
    await this.loadFromDisk()
  }

  /**
   * 存储原始内容，返回压缩版和引用 ID
   * 借鉴 SharedContext.put() 设计
   */
  async put(
    content: string,
    metadata: {
      messageId: string
      blockIndex: number
      type: CCREntry['type']
      compressed?: string  // 如果已有压缩版
    }
  ): Promise<{ compressed: string; refId: string }> {
    this.evictExpired()
    this.evictIfFull()

    const refId = this.computeRefId(content, metadata.messageId, metadata.blockIndex)
    const compressed = metadata.compressed ?? this.localCompress(content)

    const entry: CCREntry = {
      key: `${metadata.messageId}:${metadata.blockIndex}`,
      original: content,
      compressed,
      originalTokens: this.estimateTokens(content),
      compressedTokens: this.estimateTokens(compressed),
      refId,
      messageId: metadata.messageId,
      blockIndex: metadata.blockIndex,
      type: metadata.type,
      timestamp: Date.now() / 1000,
      transforms: metadata.compressed ? ['proxy'] : ['local'],
    }

    this.entries.set(entry.key, entry)
    await this.persistToDisk(entry)
    return { compressed: entry.compressed, refId }
  }

  /**
   * 检索内容
   * 借鉴 SharedContext.get() 设计
   */
  get(key: string, options?: { full?: boolean }): string | null {
    const entry = this.entries.get(key)
    if (!entry) return null

    if (Date.now() / 1000 - entry.timestamp > this.ttl) {
      this.entries.delete(key)
      return null
    }

    return options?.full ? entry.original : entry.compressed
  }

  /**
   * 按 refId 检索原文（供 CCRRetrieveTool 使用）
   */
  async retrieveByRefId(refId: string): Promise<string | null> {
    // 先查内存
    for (const entry of this.entries.values()) {
      if (entry.refId === refId) return entry.original
    }
    // 再查磁盘
    try {
      return await readFile(join(this.storeDir, `${refId}.txt`), 'utf-8')
    } catch {
      return null
    }
  }

  stats(): CCRStats {
    this.evictExpired()
    let totalOriginal = 0
    let totalCompressed = 0
    for (const entry of this.entries.values()) {
      totalOriginal += entry.originalTokens
      totalCompressed += entry.compressedTokens
    }
    const saved = totalOriginal - totalCompressed
    return {
      entries: this.entries.size,
      totalOriginalTokens: totalOriginal,
      totalCompressedTokens: totalCompressed,
      savingsPercent: totalOriginal > 0 ? (saved / totalOriginal) * 100 : 0,
    }
  }

  // --- 内部方法 ---

  private computeRefId(content: string, messageId: string, blockIndex: number): string {
    return createHash('sha256')
      .update(`${messageId}:${blockIndex}:${content.slice(0, 200)}`)
      .digest('hex')
      .slice(0, 16)
  }

  private localCompress(content: string): string {
    // 本地轻量压缩：保留首尾 + 中间摘要
    const lines = content.split('\n')
    if (lines.length <= 10) return content
    const head = lines.slice(0, 5).join('\n')
    const tail = lines.slice(-3).join('\n')
    const omitted = lines.length - 8
    return `${head}\n\n[... ${omitted} lines omitted ...]\n\n${tail}`
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  private evictExpired(): void {
    const now = Date.now() / 1000
    for (const [key, entry] of this.entries) {
      if (now - entry.timestamp > this.ttl) {
        this.entries.delete(key)
      }
    }
  }

  private evictIfFull(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const files = await readdir(this.storeDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const data = JSON.parse(await readFile(join(this.storeDir, file), 'utf-8'))
          if (data.key) this.entries.set(data.key, data)
        } catch { /* skip corrupted */ }
      }
    } catch { /* dir not exists */ }
  }

  private async persistToDisk(entry: CCREntry): Promise<void> {
    await writeFile(
      join(this.storeDir, `${entry.refId}.json`),
      JSON.stringify(entry, null, 2),
      { mode: 0o600 }
    )
    await writeFile(
      join(this.storeDir, `${entry.refId}.txt`),
      entry.original,
      { mode: 0o600 }
    )
  }
}
```

#### 3.1.3 CompressionHooks 实现

```typescript
// src/services/compact/ccrHooks.ts

import type { Message } from '../../types/message.js'
import type { CCRStore } from './ccr.js'

/**
 * 借鉴 Headroom hooks.ts 的 computeBiases 设计
 * 为每条消息计算压缩偏差
 */
export function computeCompactBiases(
  messages: Message[],
  ccrStore: CCRStore
): Map<number, number> {
  const biases = new Map<number, number>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    let bias = 1.0

    // 最近 3 轮用户消息：高保留
    if (msg.type === 'user' && i >= messages.length - 6) {
      bias = 2.0
    }

    // 含工具调用的助手消息：中等保留
    if (msg.type === 'assistant' && msg.message?.content) {
      const content = msg.message.content
      if (Array.isArray(content) && content.some(b => b.type === 'tool_use')) {
        bias = 1.5
      }
    }

    // 含错误的工具结果：高保留
    if (msg.type === 'user' && msg.message?.content) {
      const content = JSON.stringify(msg.message.content)
      if (/error|failed|panic|exception/i.test(content)) {
        bias = 2.5
      }
    }

    // 已被 CCR 存储的内容：可压缩更多
    const key = `${msg.uuid}:0`
    if (ccrStore.get(key)) {
      bias *= 0.5  // 已有原文备份，可以更激进地压缩
    }

    biases.set(i, bias)
  }

  return biases
}
```

#### 3.1.4 集成到 compact 管线

**集成点 A4** — `microCompact.ts:118-146`（保护策略增强）

```typescript
// 扩展 shouldProtectToolResult
function shouldProtectToolResult(
  toolName: string,
  toolResultContent: string,
  toolInput: unknown
): boolean {
  // 现有逻辑：源码文件保护
  if (isSourceCodeFile(toolInput)) return true
  // 现有逻辑：错误保护
  if (hasBashError(toolResultContent)) return true

  // 新增：配置文件保护
  if (isConfigFile(toolInput)) return true

  // 新增：Grep/Glob 结果保护（含搜索上下文）
  if (toolName === 'Grep' || toolName === 'Glob') return true

  // 新增：用户显式引用的内容
  if (isUserReferenced(toolResultContent)) return true

  return false
}

function isConfigFile(toolInput: unknown): boolean {
  const path = (toolInput as any)?.file_path ?? ''
  return /\.(env|dockerfile|yaml|yml|toml|json)$/.test(path) ||
    /(^|\/)(Dockerfile|Makefile|\.env|\.gitignore)$/.test(path)
}
```

**集成点 A1** — `compact.ts:471`（压缩前 CCR 存储）

```typescript
// 在 compactConversation 中，messagesToSummarize 赋值前
// 为即将被压缩的消息创建 CCR 备份

const ccrStore = new CCRStore({
  storeDir: join(getCwd(), '.ola-cc', 'ccr-store', sessionId),
  ttl: 3600,
  maxEntries: 200,
})
await ccrStore.init()

// 为长工具结果创建 CCR 备份
for (let i = 0; i < messages.length; i++) {
  const msg = messages[i]
  if (msg.type === 'user' && msg.message?.content) {
    const content = JSON.stringify(msg.message.content)
    if (content.length > 2000) { // 超过 2000 字符的内容
      await ccrStore.put(content, {
        messageId: msg.uuid ?? `msg-${i}`,
        blockIndex: 0,
        type: 'tool_result',
      })
    }
  }
}
```

**集成点 A2** — `compact.ts:549`（摘要后 CCR 注入）

```typescript
// 在 streamCompactSummary 完成后
// 将 CCR 引用注入摘要，供后续检索

const ccrStats = ccrStore.stats()
if (ccrStats.entries > 0) {
  summary += `\n\n[CCR] ${ccrStats.entries} items stored (${ccrStats.savingsPercent.toFixed(0)}% savings). Use CCRRetrieveTool to access original content.`
}
```

### 方案 2: 自适应压缩阈值

**集成点** — `autoCompact.ts:81-89`

```typescript
// 当前硬编码
const AUTOCOMPACT_BUFFER_TOKENS = 40_000

// 改为模型感知
function getAutoCompactBuffer(model: string): number {
  const configs: Record<string, number> = {
    'claude-sonnet-4-5-20250929': 40_000,   // 200K context
    'claude-opus-4-5-20250929': 60_000,     // 200K context, 更贵
    'claude-haiku-4-5-20250929': 20_000,    // 200K context, 更快
    'gpt-4o': 30_000,                       // 128K context
    'gpt-4o-mini': 15_000,                  // 128K context
  }
  return configs[model] ?? 40_000
}
```

### 方案 3: 压缩质量反馈机制

```typescript
// src/services/compact/quality.ts

interface CompactQualityMetrics {
  preCompactTokens: number
  postCompactTokens: number
  compressionRatio: number
  preservedToolResults: number
  preservedErrors: number
  preservedUserCode: number
  ccrBackupCount: number
}

function evaluateCompactQuality(
  before: Message[],
  after: Message[],
  ccrStore: CCRStore
): CompactQualityMetrics {
  const preTokens = estimateMessageTokens(before)
  const postTokens = estimateMessageTokens(after)

  return {
    preCompactTokens: preTokens,
    postCompactTokens: postTokens,
    compressionRatio: postTokens / preTokens,
    preservedToolResults: countToolResults(after),
    preservedErrors: countErrors(after),
    preservedUserCode: countUserCode(after),
    ccrBackupCount: ccrStore.stats().entries,
  }
}
```

## 四、实施路线（修订版）

### Phase 1: CCR 可逆压缩核心（1.5 周）

| 任务 | 文件 | 行数 | 依赖 |
|------|------|------|------|
| 实现 CCRStore | 新建 `compact/ccr.ts` | ~200 行 | 无 |
| 实现 ccrHooks | 新建 `compact/ccrHooks.ts` | ~80 行 | CCRStore |
| 扩展保护策略 | 修改 `microCompact.ts:118` | ~30 行 | 无 |
| 集成到 compact 管线 | 修改 `compact.ts:471,549` | ~40 行 | CCRStore |
| 实现 CCRRetrieveTool | 新建 `tools/CCRRetrieveTool/` | ~100 行 | CCRStore |
| 测试 | 新建 `compact/ccr.test.ts` | ~150 行 | 全部 |

**总计**: ~600 行新增代码，~70 行修改

### Phase 2: 自适应阈值 + 质量反馈（1 周）

| 任务 | 文件 | 行数 | 依赖 |
|------|------|------|------|
| 模型感知缓冲区 | 修改 `autoCompact.ts:81` | ~20 行 | 无 |
| 压缩质量评估 | 新建 `compact/quality.ts` | ~80 行 | 无 |
| 遥测集成 | 修改 `autoCompact.ts` | ~15 行 | quality.ts |

### Phase 3: 图片上下文保留（1 周）

| 任务 | 文件 | 行数 | 依赖 |
|------|------|------|------|
| 修改 stripImages | 修改 `compact.ts:152` | ~30 行 | CCRStore |
| 图片 CCR 存储 | 修改 `ccr.ts` | ~40 行 | 无 |

## 五、验收标准（修订版）

| 指标 | 当前值 | Phase 1 目标 | Phase 3 目标 |
|------|--------|-------------|-------------|
| 压缩后信息恢复率 | 0% | ≥90% | ≥95% |
| .env/Dockerfile 保护率 | 0% | 100% | 100% |
| Grep/Glob 结果保护率 | 0% | 100% | 100% |
| 图片上下文丢失率 | 100% | 100% | ≤10% |
| 压缩质量可观测 | 否 | 是 | 是 |

## 六、与 ola-cc 现有代码的兼容性

| 约束 | 影响 | 应对 |
|------|------|------|
| `compactConversation` L477 的 PTL 重试循环 | CCR 存储必须在重试前完成 | 存储放在 L471 之前 |
| `microcompactMessages` 是同步的 | CCR 检索必须是同步的 | 内存缓存 + 异步预加载 |
| Worker 降级丢失 context | CCR store 需要持久化 | 磁盘存储 + 启动时加载 |
| Bun 运行时不支持 Worker | 始终走本地路径 | 无需特殊处理 |
| `readFileState` L569 清空 | CCR 不能依赖 readFileState | 独立存储 |

## 八、v3 深度源码分析补充（本地 Rust 源码）

> 基于 `/Users/heal/tmp/headroom` 本地源码，系统架构师分析 Rust 核心引擎 + TypeScript SDK + 架构文档

### 8.1 Rust 核心模块依赖图

```
headroom-proxy (axum HTTP 反向代理)
  │
  ├── headroom-core (核心压缩引擎)
  │     ├── auth_mode          — 请求认证分类 (Payg/OAuth/Subscription)
  │     ├── compression_policy — 按认证模式派生压缩策略
  │     ├── cache_control      — Anthropic cache_control marker 步行器
  │     ├── ccr/               — CCR 存储层 (InMemory/Sqlite/Redis)
  │     ├── tokenizer/         — Token 计数 (Tiktoken/HF/Estimation)
  │     ├── signals/           — 重要性检测 (Keyword/Tiered)
  │     ├── relevance/         — 相关性评分 (BM25/Embedding/Hybrid)
  │     └── transforms/        — 压缩变换管线
  │           ├── live_zone           — Live-Zone 区域调度器
  │           ├── content_detector    — 内容类型检测
  │           ├── smart_crusher       — JSON 数组统计压缩
  │           ├── log_compressor      — 日志/构建输出压缩
  │           ├── search_compressor   — grep/ripgrep 结果压缩
  │           ├── diff_compressor     — unified-diff 压缩
  │           ├── adaptive_sizer      — 自适应 K 值计算
  │           └── pipeline            — 压缩管线编排
  │
  └── headroom-py (Python 绑定, PyO3)
```

### 8.2 CCR 存储层精确实现（本地源码发现）

**CcrStore trait** (`crates/headroom-core/src/ccr/mod.rs:40-57`):
- `put(hash, payload)` — 存储原始内容，相同 hash 幂等覆盖
- `get(hash) -> Option<String>` — 检索，支持 TTL 过期
- `len()` — 活跃条目数

**三种后端**:
| 后端 | 用途 | 特性 |
|------|------|------|
| InMemoryCcrStore | 测试默认 | DashMap 分片 |
| SqliteCcrStore | 生产默认 | WAL 模式，预编译语句，惰性 TTL 清理 |
| RedisCcrStore | 多 worker | feature gate |

**哈希算法**: BLAKE3，取前 24 个 hex 字符 (96 bits)。`compute_key()` 对 payload 原始字节做 BLAKE3 哈希。

**标记格式**: `<<ccr:HASH>>`，正则 `[a-f0-9]{24}`。

**容量与 TTL**: 默认 1000 条目，5 分钟 TTL。

### 8.3 各压缩器的 CCR 集成模式

所有压缩器遵循三步 CCR 协议：

1. **压缩并判断是否需要 CCR** — 每个压缩器有独立阈值：
   - DiffCompressor: `min_compression_ratio_for_ccr = 0.8`
   - SearchCompressor: `min_matches_for_ccr = 10` + `min_compression_ratio_for_ccr = 0.8`
   - LogCompressor: `min_compression_ratio_for_ccr = 0.5`

2. **存储原始内容** — `store.put(key, original_content)`

3. **注入标记** — 压缩输出末尾追加：
   ```
   [N lines compressed to M. Retrieve more: hash=HASH]
   ```

### 8.4 Live-Zone 概念与 ola-cc 对齐（关键发现）

Headroom 的核心洞察：**只压缩 cache prefix 之后的部分**。

- `frozen_count` = Anthropic `cache_control` marker 之前的不压缩消息数
- `live zone` = frozen_count 到 latest_user_msg 之间的可压缩区域
- **Byte-Range Surgery**: 字节级精确替换（非 JSON 反序列化→修改→重序列化），保证缓存前缀不变

**ola-cc 移植建议**: compact worker 应采纳 "frozen prefix" 概念，将 Anthropic cache_control marker 作为冻结边界。对 system prompt 和 frozen messages 做字节级保留，只对 live zone 的 tool_result 做压缩。

### 8.5 SmartCrusher 统计压缩策略（新发现）

SmartCrusher (`smart_crusher.rs`) 的核心算法：

1. **字段分析**: 计算 `unique_ratio` (0.0=常量, 1.0=全唯一) 和 variance
2. **模式检测**: TIME_SERIES (有时间戳+数值方差) / CLUSTER (日志) / TOP_N (搜索结果)
3. **常量提取**: `__headroom_constants` 将重复字段因子化
4. **变化点保留**: 时间序列中检测 spike，保留变化点周围的点

**ola-cc 价值**: 当前 tool output 不做任何结构化压缩。引入 SmartCrusher 可将 tool_result token 量减少 70-95%。

### 8.6 认证模式驱动的压缩策略（新发现）

`CompressionPolicy` (`compression_policy.rs:139-173`):

| 模式 | max_lossy_ratio | volatile_threshold | cache_aligner |
|------|-----------------|-------------------|---------------|
| PAYG | 0.45 | 128 | 启用 |
| Subscription | 0.25 | 32 | 禁用 |
| OAuth | 0.45 | 128 | 启用 |

**ola-cc 移植建议**: 根据用户 API plan 类型（免费/付费/企业）调整 compact 策略的激进程度。

### 8.7 自适应 K 值计算（新发现）

`adaptive_sizer` 的 `compute_optimal_k()` 根据内容特征自适应决定保留多少条目，替代固定阈值。ola-cc 的 micro compact 和 rolling window 都可用类似方法替代硬编码的 "保留最近 N 条消息"。

### 8.8 CCR 检索路径

- `/v1/retrieve` 端点: POST, 接受 `{hash, query?}`
- 完整检索: `store.get(hash)` 返回原始 JSON
- 搜索检索: `store.search(hash, query)` 在缓存内容中做 BM25 搜索
- Response Handler: 自动拦截 LLM 响应中的 `headroom_retrieve` tool call，执行检索，继续对话（最多 3 轮）

### 8.9 Headroom 局限性与 ola-cc 应对

| 局限性 | 影响 | ola-cc 应对 |
|--------|------|-------------|
| 代理模式（HTTP 反向代理） | ola-cc 是 CLI 直接集成 | 将压缩逻辑移植为库调用 |
| Python/Rust 双实现维护成本高 | — | ola-cc 只维护一个实现 (TypeScript) |
| CCR 默认 5 分钟 TTL | 长时间会话中压缩内容过期 | ola-cc 改为 3600s (与 SharedContext 一致) |
| 默认 1000 条目上限 | 大型项目可能不够 | ola-cc 改为 200 条（CLI 场景足够） |

### 8.10 关键文件清单（本地源码）

**Rust 核心引擎**:
- `crates/headroom-core/src/ccr/mod.rs` — CCR 存储 trait + BLAKE3 哈希 + 标记格式
- `crates/headroom-core/src/compression_policy.rs` — 按认证模式的压缩策略
- `crates/headroom-core/src/transforms/live_zone.rs` — Live-Zone 区域调度器
- `crates/headroom-core/src/transforms/smart_crusher.rs` — SmartCrusher JSON 数组压缩
- `crates/headroom-core/src/transforms/diff_compressor.rs` — unified-diff 压缩器
- `crates/headroom-core/src/transforms/search_compressor.rs` — grep/ripgrep 结果压缩
- `crates/headroom-core/src/transforms/log_compressor.rs` — 日志/构建输出压缩

**架构文档**:
- `wiki/ARCHITECTURE.md` — 完整架构文档（含 CCR 6 阶段详解）
- `docs/spec/002-architecture.md` — 系统架构规范
- `docs/spec/004-domain-model.md` — 领域模型

## 九、v4 ola-cc 能力缺陷补偿方案（三专家联合分析）

> AgentTool 架构师 + 资深算法专家 + 系统架构师共同分析 ola-cc 源码后，聚焦"ola-cc 当前能力不足"的 13 个具体问题

### 9.1 AgentTool 架构缺陷（3 个）

#### 缺陷 A1: 无跨会话记忆注入

**现状**: `runAgent.ts` 的 `buildAgentPrompt()` 只包含当前任务描述。`LearningSystem` 记录了执行历史但从未注入 agent 上下文。

**补偿方案**: AgentMemory 的 `context.ts` + `enrich.ts` 多源上下文组装

**集成点**: `src/tools/AgentTool/agentToolUtils.ts` 的 `buildAgentPrompt()`

```
修改: 从 LearningSystem 加载当前 skill 的 lessons 和 contrast insights
     按 token 预算截断后追加到 prompt 末尾
限制: 硬限 2000 token
```

#### 缺陷 A2: 无行动链结晶→可复用知识管线

**现状**: 多次连续工具调用形成的行动链无法被总结为结构化经验。

**补偿方案**: AgentMemory 的 `crystallize.ts` + `consolidation-pipeline.ts`

**集成点**: `runAgent.ts` 的 agent 完成后逻辑（~500-600 行）

```
新增: LearningSystem.crystallize(skill, actionChain) 方法
触发: 仅在 agent 失败或 score<60 时
执行: 异步不阻塞返回
```

#### 缺陷 A3: 无依赖感知的任务优先级排序

**现状**: 多 agent 排队时只能 FIFO，无依赖图分析。

**补偿方案**: AgentMemory 的 `frontier.ts` 依赖图分析

**集成点**: `SingularityTool.ts` 新增 `agent_frontier` 操作

```
评分: priority*10 + age_hours*0.5 + unlockCount*5 + active*15
退化: 无边数据时按 priority 排序
```

---

### 9.2 算法缺陷（5 个）

#### 缺陷 B1: 无记忆衰减机制（P0）

**现状**: 记忆只增不减，context 不断膨胀。

**补偿算法**: AgentMemory 的 `retention.ts`

```
R(t) = min(1, S * exp(-λ * Δt) + σ * Σ(1/daysSinceAccess_i))
λ = 0.005 (ola-cc 调低，会话 1-3 小时)
分层: hot≥0.7, warm≥0.4, cold≥0.15, evictable<0.15
集成: sessionMemoryCompact.ts 的 compact 前钩子
```

#### 缺陷 B2: 无记忆去重（P1）

**现状**: 重复记忆堆积，依赖 LLM 自行判断。

**补偿算法**: AgentMemory 的 Jaccard 去重

```
jaccard(a, b) = |A∩B| / |A∪B|
阈值: 英文 0.7, 中文 0.6
优化: concept 索引将 O(K²) 缩小到 O(K * avg_overlap)
集成: microCompact.ts 的 per-tool-result 压缩阶段
```

#### 缺陷 B3: 上下文压缩无自适应尺寸控制（P2）

**现状**: 固定策略截断，无法根据内容冗余度动态调整。

**补偿算法**: Headroom 的 `compute_optimal_k`（Kneedle 信息饱和检测）

```
1. SimHash 去重 + 累积 bigram 覆盖曲线
2. Kneedle 拐点检测: max(y_norm - x_norm)
3. k = min_k.max(knee * bias)  // bias=0.8
集成: microCompact.ts 替换固定截断
```

#### 缺陷 B4: 工具排名缺乏语义扩展（P3）

**现状**: `toolRanker.ts` 纯词匹配，无同义词/前缀/CJK。

**补偿算法**: AgentMemory search.ts 的 BM25 增强

```
1. 同义词扩展: Map<string, string[]> 映射表
2. 前缀匹配: 长度≥4 查询词匹配前缀文档词（权重 0.5x）
3. CJK 分词: bigram 切分
集成: toolRanker.ts 的 extractTerms()
```

#### 缺陷 B5: 经验教训无强化/衰减系统（P4）

**现状**: `LearningSystem.ts` 只做执行记录，无 confidence 强化/衰减。

**补偿算法**: AgentMemory 的 lessons 三层机制

```
1. 强化: confidence += 0.1 * (1 - confidence)
2. 衰减: confidence -= 0.1 * weeksSinceBaseline
3. 召回: score = confidence * relevance * recencyBoost
集成: LearningSystem.ts 的 contrastAnalysis() 输出后
```

---

### 9.3 架构缺陷（5 个）

#### 缺陷 C1: 记忆无生命周期管理

**现状**: 记忆写入后永不清理。MEMORY.md 200 行硬上限暴力截断。

**补偿方案**: AgentMemory 的 `evict.ts` 五级驱逐

```
新增: src/services/compact/memoryEviction.ts
策略: 会话 TTL(30天) + 重要度衰减 + 按重要度排序保留
集成: autoCompact.ts 的 shouldTriggerAutoCompact()
```

#### 缺陷 C2: microCompact 不感知缓存冻结区（P0）

**现状**: `microCompact.ts` 无差别清理旧 tool_result，不区分 cache_control marker 之前。

**补偿方案**: Headroom 的 `live_zone.rs` frozen boundary

```
修改: microCompactMessages() 入口增加 frozenCount 参数
逻辑: frozen_count 之前的消息完全跳过 microCompact
风险: 高 — 误删 frozen 区消息破坏 prompt cache
```

#### 缺陷 C3: 压缩无质量反馈和自纠正

**现状**: `compactConversation()` 不验证摘要质量。

**补偿方案**: AgentMemory 的 `compress.ts` 三步质量闭环

```
新增: 结构验证 + 信息密度评分 + 评分低于阈值自动重试
集成: compactConversation() 返回后、buildPostCompactMessages() 之前
```

#### 缺陷 C4: 压缩策略无差异化

**现状**: 所有用户、所有会话使用相同压缩参数。

**补偿方案**: Headroom 的 `compression_policy.rs` 认证模式驱动

```
新增: src/services/compact/CompressionPolicy.ts
策略: free tier(激进) / paid tier(保守) / long-session(优先不超限)
集成: autoCompact.ts 的 buffer token 从 policy 读取
```

#### 缺陷 C5: 图引擎无级联失效

**现状**: 文件修改/删除时，图节点不会被标记为 stale。

**补偿方案**: AgentMemory 的 `cascade.ts` 级联失效

```
新增: src/services/graph/CascadeInvalidator.ts
逻辑: 记忆修改时标记相关图节点 stale
集成: IncrementalSync.ts 的 sync() 末尾
```

---

### 9.4 缺陷总览与实施优先级

| 优先级 | 缺陷 | 类型 | 严重度 | 难度 | 来源 |
|--------|------|------|--------|------|------|
| **P0** | B1 记忆衰减 | 算法 | 高 | 低 | AgentMemory retention.ts |
| **P0** | C2 缓存冻结区感知 | 架构 | 高 | 中 | Headroom live_zone.rs |
| **P1** | B2 记忆去重 | 算法 | 高 | 低 | AgentMemory remember.ts |
| **P1** | C1 记忆生命周期 | 架构 | 高 | 中 | AgentMemory evict.ts |
| **P1** | A1 跨会话记忆注入 | AgentTool | 高 | 低 | AgentMemory context.ts |
| **P2** | C3 压缩质量反馈 | 架构 | 中 | 中 | AgentMemory compress.ts |
| **P2** | B3 压缩自适应尺寸 | 算法 | 中 | 中 | Headroom adaptive_sizer |
| **P2** | A2 行动链结晶 | AgentTool | 中 | 中 | AgentMemory crystallize.ts |
| **P3** | C4 压缩策略差异化 | 架构 | 中 | 低 | Headroom compression_policy |
| **P3** | B4 搜索语义扩展 | 算法 | 中 | 中 | AgentMemory search.ts |
| **P3** | A3 依赖感知排序 | AgentTool | 中 | 低 | AgentMemory frontier.ts |
| **P4** | B5 经验强化/衰减 | 算法 | 低 | 低 | AgentMemory lessons.ts |
| **P4** | C5 图级联失效 | 架构 | 低 | 中 | AgentMemory cascade.ts |

### 9.5 推荐实施路径

**Week 1** (P0+P1, 5 项):
- B1 记忆衰减 → `memory/retention.ts`
- C2 缓存冻结区 → `microCompact.ts` frozenCount
- B2 记忆去重 → `memory/dedup.ts`
- C1 记忆生命周期 → `compact/memoryEviction.ts`
- A1 跨会话记忆注入 → `agentToolUtils.ts`

**Week 2** (P2, 3 项):
- C3 压缩质量反馈 → `compact.ts`
- B3 压缩自适应 → `microCompact.ts`
- A2 行动链结晶 → `runAgent.ts`

**Week 3** (P3, 3 项):
- C4 压缩策略差异化 → `CompressionPolicy.ts`
- B4 搜索语义扩展 → `toolRanker.ts`
- A3 依赖感知排序 → `SingularityTool.ts`

**Week 4** (P4+收尾, 2 项):
- B5 经验强化/衰减 → `LearningSystem.ts`
- C5 图级联失效 → `CascadeInvalidator.ts`

---

## 10. v5 — TDD 深度评审修正（2026-06-07）

> 由 AgentTool 架构师 + 资深算法专家 + 系统架构师三位专家进行 TDD 深度评审后整合。
> 本节修正 v4 中的错误、补充遗漏、调整优先级，并为每个缺陷提供 TDD 测试设计。

### 10.1 关键修正汇总

| 缺陷 | v4 错误 | v5 修正 | 影响 |
|------|---------|---------|------|
| A1 | 集成点 `agentToolUtils.ts:buildAgentPrompt()` | 实际在 `promptTemplate.ts:47`，仅 built-in agent 用。正确注入点: `runAgent.ts:590-601` 的 `agentSystemPrompt` 构建后 | 高 |
| A2 | 触发条件 `score<60` | `runAgent.ts` 无 score 概念。正确触发: `validationGate verdict=FAIL/PARTIAL` 或 `qualityScan error-level` | 高 |
| B1 | λ=0.005 适用于 ola-cc | λ=0.005 对 1-3 小时会话衰减≈0。需要 λ≈0.5-2.0 | 高 |
| B1 | `Σ(1/daysSinceAccess_i)` 强化项 | `daysSinceAccess→0` 时发散。需 `1/max(0.01, days)` 防护 | 中 |
| B2 | Jaccard 去重 + 中文阈值 0.6 | `split(/\s+/)` 对中文产生单 token，Jaccard 恒为 0。需 bigram tokenizer | **致命** |
| B4 | CJK bigram 切分 | `\b` 不匹配 CJK 边界，中文搜索完全失效。需移除 `\b` 约束 | **致命** |
| B5 | `weeksSinceBaseline` 基线 | 实现用 `updatedAt` 做基线，每次 `save()` 重置衰减时钟 → 教训永不衰减 | 高 |
| C2 | 统一 frozenCount 参数 | microCompact 有两条路径: cached MC 不修改内容、time-based MC 才修改。frozenCount 仅适用于后者 | 高 |
| C3 | 质量验证在 compactConversation 返回后 | 应嵌入重试循环内部，否则浪费一次完整 LLM 调用 | 中 |
| C5 | 级联失效集成到 IncrementalSync | `IncrementalSync.sync()` 是 `markDirty()` + `store.load()` 全量重载。级联失效在全量重载后无意义 | **根本矛盾** |

### 10.2 C2 修正: 双路径 microCompact

ola-cc 的 `microCompact.ts` 实际有两条路径:

1. **Cached MC 路径** (`cachedMicrocompactPath`): 通过 `cache_edits` API 层操作，**不修改 message content**。frozenCount 概念不适用。
2. **Time-based MC 路径**: 直接修改 messages 数组，清除旧 tool_result。frozenCount **仅适用于此路径**。

v4 方案将 frozenCount 作为统一参数传入 `microcompactMessages()` 是错误的。修正方案:
- frozenCount 在 `query.ts` 的调用层预计算（同步获取 `claude.ts` 的 cache_control 标记位置）
- 仅在 time-based MC 路径中使用 frozenCount
- cached MC 路径不受影响

### 10.3 C5 修正: 根本矛盾分析

**问题**: v4 方案要求在 `IncrementalSync.sync()` 末尾调用 `CascadeInvalidator.invalidate(changedFiles)`。但 `IncrementalSync.sync()` 的实际实现是:

```typescript
// IncrementalSync.ts:69-71
async sync(): Promise<SyncResult> {
  this.store.markDirty()
  await this.store.load()  // 全量替换
}
```

`store.load()` 从 codegraph.db + knowledge-graph.json 全量加载，替换所有节点和边。级联失效标记 stale 的节点在下一次 `load()` 时会被完全覆盖，毫无意义。

**前置条件**: C5 需要 GraphStore 支持增量更新（保留现有节点，仅替换变更节点）。这是最大的架构变更。

**建议**: C5 降级为 P4+，推迟到 GraphStore 增量更新改造完成后实施。

### 10.4 C3 修正: 质量验证嵌入重试循环

ola-cc 的 compact 有 3 次 PTL 重试 + 2 次流式重试（`compact.ts:477`）。v4 方案将质量验证放在 `compactConversation()` 返回后，这意味着:
1. 如果摘要质量不达标，需要重新发起完整的 LLM 调用
2. 浪费已有的重试计数器

修正: 在 `streamCompactSummary` 流式完成后、`buildPostCompactMessages` 前插入验证。失败时复用已有重试计数器，而非外层重新调用。

### 10.5 C1 修正: 并发保护

ola-cc 的 MEMORY.md 有 `MAX_ENTRYPOINT_LINES=200` 和 `MAX_ENTRYPOINT_BYTES=25_000` 双限制（`memdir.ts:36-38`）。v4 方案用 retention 评分替代暴力截断，但未说明如何共存。

修正: retention 评分用于决定**哪 200 行**进入 MEMORY.md，而非替代行数限制。驱逐扫描是异步操作，与 auto-memory 写入存在 TOCTOU 竞态。需要:
1. 驱逐扫描和 MEMORY.md 写入用 `sequential()` 保护
2. 驱逐结果缓存，不在 LLM 读取期间写入

### 10.6 Feature Flags

| Flag | 默认值 | 控制缺陷 | 回滚行为 |
|------|--------|---------|---------|
| `OLA_CC_RETENTION_DECAY` | false | B1 | 跳过衰减计算 |
| `OLA_CC_MEMORY_DEDUP` | false | B2 | 跳过去重 |
| `OLA_CC_ADAPTIVE_COMPRESS` | false | B3 | 固定截断 |
| `OLA_CC_SEARCH_CJK` | false | B4 | 跳过 bigram |
| `OLA_CC_LESSON_DECAY` | false | B5 | 跳过 confidence 衰减 |
| `OLA_CC_LESSONS_INJECT` | false | A1 | 不注入 lessons |
| `OLA_CC_CRYSTALLIZE` | false | A2 | 不触发结晶 |
| `OLA_CC_AGENT_FRONTIER` | false | A3 | 默认排序 |
| `OLA_CC_MEMORY_LIFECYCLE` | false | C1 | 暴力截断 |
| `OLA_CC_FROZEN_ZONE` | false | C2 | frozenCount=0 |
| `OLA_CC_COMPACT_QUALITY` | false | C3 | 跳过验证 |
| `OLA_CC_COMPRESSION_POLICY` | false | C4 | 硬编码 40K |
| `OLA_CC_CASCADE_INVALIDATE` | false | C5 | 跳过级联 |

所有 flag 通过 `isEnvTruthy()` + GrowthBook 双重控制。

### 10.7 C4 修正: 与现有机制的优先级

ola-cc 已有:
- `OLA_CC_AUTO_COMPACT_WINDOW` 环境变量覆盖（`autoCompact.ts:42-48`）
- GrowthBook feature flag `auto_compact_buffer_tokens`
- `getAutoCompactThreshold()` 函数

CompressionPolicy 的优先级链:
1. `OLA_CC_AUTO_COMPACT_WINDOW` 环境变量（最高）
2. GrowthBook `auto_compact_buffer_tokens`
3. CompressionPolicy 按 tier 计算
4. 硬编码 40K 默认值（最低）

### 10.8 TDD 测试设计

#### C1: 记忆生命周期

**契约测试:**
- `calculateRetention(entry)` 在 30 天 TTL 后返回 <0.15
- hot/warm/cold/evictable 分层边界值精确

**集成测试:**
- 写入 300 条记忆 → 触发驱逐 → MEMORY.md ≤ 200 行且保留最高分条目

**故障注入:**
- 磁盘满时 `writeFile` 失败 → 不丢失已有记忆

**Feature flag 测试:**
- `OLA_CC_MEMORY_LIFECYCLE=0` 时驱逐不触发

#### C2: 缓存冻结区

**契约测试:**
- `microcompactMessages(messages, ctx, source, frozenCount=5)` 对 index<5 的 tool_result 不清除

**集成测试:**
- 构造含 `cache_control` marker 的消息序列 → frozen 区完整

**故障注入:**
- frozenCount > messages.length → 不崩溃

**关键修正:** frozenCount 在 `query.ts` 预计算，仅 time-based MC 路径使用。

#### C3: 压缩质量反馈

**契约测试:**
- `evaluateCompactQuality(before, after)` 的 `compressionRatio` 在 [0.3, 0.8] 合理区间
- 结构验证检测缺失的 `key_files`/`decisions` 段

**集成测试:**
- 模拟 LLM 返回空摘要 → 触发重试（复用已有重试计数器）

**故障注入:**
- 重试 3 次均质量不达标 → 使用最后一次结果而非崩溃

#### C4: 压缩策略差异化

**契约测试:**
- `getCompressionPolicy('free')` 返回 buffer=20K
- `getCompressionPolicy('paid')` 返回 buffer=60K

**集成测试:**
- env var `OLA_CC_AUTO_COMPACT_WINDOW=30000` 覆盖 policy 值

**故障注入:**
- 未知 tier 名称 → 使用默认值

#### C5: 图级联失效（P4+ 延后）

**前提:** GraphStore 支持增量更新。

**契约测试:**
- `CascadeInvalidator.invalidate(changedFiles)` 标记依赖图中相关节点 stale

**集成测试:**
- 修改文件 A → A 的节点标记 stale，B 不受影响

**故障注入:**
- `detect()` 返回空 changedFiles → 级联不执行

### 10.9 修正后的优先级与实施路径

| 优先级 | 缺陷 | v4 | v5 | 修正原因 |
|--------|------|----|----|---------|
| **P0** | B2 CJK 去重 | P1 | **P0** | 中文核心功能失效 |
| **P0** | B4 CJK 搜索 | P3 | **P0** | 中文核心功能失效 |
| **P0** | B1 衰减参数 | P0 | P0 | λ+奇点修复 |
| **P0** | C2 冻结区 | P0 | P0 | 修正双路径 |
| **P1** | B5 衰减基线 | P4 | **P1** | updatedAt 重置 |
| **P1** | A1 注入点 | P1 | P1 | 修正集成点 |
| **P1** | C1 生命周期 | P1 | P1 | 增加并发保护 |
| **P2** | A2 结晶 | P2 | P2 | 风险升为高 |
| **P2** | C3 质量反馈 | P2 | P2 | 嵌入重试循环 |
| **P2** | B3 自适应 | P2 | P2 | Kneedle 阈值放宽 |
| **P3** | C4 策略差异化 | P3 | P3 | 优先级链明确 |
| **P3** | A3 排序 | P3 | P3 | 数据模型扩展 |
| **P4+** | C5 级联失效 | P4 | **P4+** | 根本矛盾: 需 GraphStore 增量更新先行 |

**Phase 1 — CJK 基础修复（1-2 天）:**
1. `tokenizeCJK(text)` bigram tokenizer（B2+B4 共用）
2. 修复 `jaccardSimilarity` 使用 bigram
3. 修复 `toolRanker.ts` 的 `\b` 问题

**Phase 2 — P0 算法修复（3-5 天）:**
1. B1: `Σ(1/days)` 奇点防护 + λ=0.5 校准
2. C2: frozenCount 仅 time-based MC 路径，预计算于 `query.ts`
3. B5: `updatedAt` → `lastDecayedAt` 基线修复

**Phase 3 — AgentTool 集成（1 周）:**
1. A1: 注入点修正到 `runAgent.ts:600`，增加质量门控
2. A2: 增加 abort 处理，调整 agentMessages 清空时序
3. C1: MEMORY.md 并发保护 + retention 评分决定哪 200 行

**Phase 4 — 质量增强（1 周）:**
1. C3: 质量验证嵌入重试循环内部
2. B3: Kneedle `max_diff > 0.02` + SimHash 短文本优化
3. C4: CompressionPolicy + 优先级链

**Phase 5 — 高级功能（1 周）:**
1. A3: ExecutionRecord 扩展
2. C5: 降级为 P4+，等待 GraphStore 增量更新

---

## 11. v6 — 第六轮深度评审修正（2026-06-07）

> 三位专家对 v5 进行验证性评审，确认核心修正正确，发现 18 个遗留问题。
> 本节聚焦 Headroom 相关发现（B3/C2/C3/C4/C5），跨方案通用发现见 AgentMemory 方案 11 节。

### 11.1 v5 核心修正验证结论

| v5 修正 | 验证结果 |
|---------|---------|
| C2 双路径识别 | ✅ 正确 — cached MC 不修改内容，frozenCount 仅适用 time-based |
| C5 根本矛盾 | ✅ 正确 — `IncrementalSync.sync()` 确实是全量重载 |
| C3 质量验证位置 | ✅ 方向正确 — 但实现细节需调整 |
| C4 优先级链 | ⚠️ 部分错误 — GrowthBook flag 不存在 |
| B3 Kneedle 阈值 | ⚠️ 不完整 — 缺少 diversity 保护 |

### 11.2 新发现的 Headroom 相关问题

#### C2: frozenCount 预计算与 claude.ts 耦合 [中等]

**问题**: `cache_control` 标记在 `claude.ts:631-691` 的 `getCacheControl()` 中设置（API 请求构建阶段）。microCompact 在请求**之前**调用。预计算 frozenCount 需复制 `claude.ts` 的 cache key 逻辑，引入隐式依赖。

**修正**: frozenCount 不在 `query.ts` 预计算。两种方案:
1. **方案 A**: 在 `microcompactMessages` 内部检查 messages 中已有的 `cache_control` 标记位置
2. **方案 B**: 作为 `claude.ts` 构建请求时的副产品输出，通过 `ToolUseContext` 传递给下一轮 microCompact

方案 A 更简单但需要 microCompact 理解 `cache_control` 标记格式。方案 B 更解耦但引入跨轮次状态。

#### C3: 质量验证复用 PTL 重试会导致不必要截断 [中等]

**问题**: `compact.ts:477` 的 PTL 重试循环在失败时调用 `truncateHeadForPTLRetry`（丢弃最旧消息组）。质量不达标时应用相同 messages 重新生成，不应截断。

**修正**: 质量验证需独立的重试逻辑:
```
streamCompactSummary 返回后:
  if (质量不达标 && qualityRetryCount < 1):
    qualityRetryCount++
    用原始 messagesToSummarize 重新调用 streamCompactSummary
  else:
    break  // 使用当前结果
```

#### C4: GrowthBook `auto_compact_buffer_tokens` flag 不存在 [高]

**问题**: `autoCompact.ts` 中不存在此 GrowthBook flag。buffer 是硬编码 `AUTOCOMPACT_BUFFER_TOKENS = 40_000`（L81）。唯一运行时覆盖是 `OLA_CC_AUTO_COMPACT_WINDOW` 环境变量（覆盖 context window，非 buffer）。

**修正优先级链:**
1. `OLA_CC_AUTO_COMPACT_WINDOW` 环境变量（覆盖 context window）
2. CompressionPolicy 按 tier 计算 buffer
3. 硬编码 40K 默认值

如需 GrowthBook 层，需先在 `autoCompact.ts` 中添加:
```typescript
const bufferTokens = getFeatureValue_CACHED_MAY_BE_STALE(
  'auto_compact_buffer_tokens',
  AUTOCOMPACT_BUFFER_TOKENS
)
```
这是 C4 实施的前置工作。

#### B3: Kneedle 0.02 阈值缺少 diversity 保护 [中等]

**问题**: Headroom 原始 Rust 代码有 `diversity_ratio > 0.7` 的高多样性保护（`adaptive_sizer.rs:84-91`）:
```rust
if diversity_ratio > 0.7 {
    floor = min_k.max((n as f64 * (0.3 + 0.7 * diversity_ratio)) as usize);
}
```
v5 降低 Kneedle 阈值到 0.02 但未引入此保护。高多样性场景（每条 tool_result 内容不同）可能过度压缩。

**修正**: 移植 floor 逻辑到 `computeOptimalK`:
```typescript
if (diversity > 0.7) {
  const floor = Math.max(minK, Math.round(n * (0.3 + 0.7 * diversity)));
  k = Math.max(k, floor);
}
```

#### C5: GraphStore 增量更新工作量评估 [延后]

`GraphStore.load()` 从 SQLite 全量查询所有 nodes/edges，`clear()` 清空三个 Map 后重建。增量更新需要:
1. 检测变更节点（需 SQLite `updated_at` 时间戳或 diff 逻辑）
2. 保留未变更节点，仅替换/删除变更节点
3. 处理边的级联更新
4. 处理 Grok JSON 的增量合并（无时间戳字段）

**估算**: 3-5 天。P4+ 延后合理。

### 11.3 修正后的 C2 数据流设计

```
claude.ts 构建 API 请求
  ├─ getCacheControl() 标记 cache_control 块
  ├─ 计算 frozenCount = 最后一个 cache_control 块之后的消息数
  └─ 将 frozenCount 存入 ToolUseContext.metadata

microcompactMessages(messages, ctx, source)
  ├─ if (ctx.metadata.frozenCount > 0):
  │   └─ time-based MC: 跳过 frozenCount 之前的消息
  └─ else:
      └─ cached MC: 通过 cache_edits API 操作（不修改 messages）
```

### 11.4 统一实施路径（与 AgentMemory 方案合并）

| Phase | 时间 | Headroom 项 | AgentMemory 项 |
|-------|------|-------------|----------------|
| 1 | 1 周 | C2 frozenCount + B3 Kneedle+diversity | B2 CJK 去重 + B4 CJK 搜索 + B1 衰减 |
| 2 | 1 周 | C4 CompressionPolicy | B5 衰减基线 + A1 注入 + C1 生命周期 |
| 3 | 1 周 | C3 质量独立重试 | B3 自适应 + C4 优先级链 |
| 4 | 1 周 | — | A2 结晶 + A3 排序 |
| 5 | 待定 | C5 GraphStore 增量更新 | C5 级联失效 |

### 11.5 新增 TDD 测试（v6 补充）

| 缺陷 | 新增测试 | 类型 |
|------|---------|------|
| C2 | frozenCount 从 messages 中已有 cache_control 标记正确计算 | 契约 |
| C2 | frozenCount=0 时走 cached MC 路径 | 集成 |
| C3 | 质量验证失败用原始 messages 重试（非截断后） | 集成 |
| C3 | 质量重试最多 1 次，第 2 次失败使用最后结果 | 边界 |
| C4 | CompressionPolicy 计算值被 env var 覆盖 | 集成 |
| C4 | 无 GrowthBook 时回退到硬编码 40K | 边界 |
| B3 | 高多样性（diversity>0.7）时不过度压缩 | 数学性质 |
| B3 | diversity=1.0 时 keep_fraction ≥ 0.8 | 边界 |
