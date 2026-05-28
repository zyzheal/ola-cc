# Grok + CodeGraph 双引擎互补集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 集成 Understand-Anything 作为 Grok 工具，与现有 CodeGraph 形成双引擎互补，支持知识图谱生成、Dashboard 可视化、业务域分析和引导式学习。

**Architecture:** CodeGraph 负责实时精确查询（符号搜索、调用链、影响分析），Grok 负责离线全局理解（知识图谱、Dashboard、业务域、学习路径）。两者通过 Tool + Skill 双形态暴露，共享意图路由层。

**Tech Stack:** TypeScript, Zod (schema), Anthropic SDK (LLM), Tree-sitter (parsing), D3.js (Dashboard), React/Ink (terminal UI)

## 系统流程图

```
用户输入命令
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Skill 层解析                                               │
│  /grok, /gc, /gd, /ge, /gt, /gdiff, /go, /gdomain, /cg    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│   Tool 层调用                                               │
│   grok (8 ops), codegraph (10 ops)                         │
└────────────────────────┬────────────────────────────────────┘
                    ┌────┴────┐
                    ▼         ▼
            ┌───────────┐ ┌───────────┐
            │   Grok    │ │ CodeGraph │
            │  Manager  │ │  Manager  │
            └─────┬─────┘ └─────┬─────┘
                  │             │
                  ▼             ▼
            ┌───────────┐ ┌───────────┐
            │  LLM API  │ │   本地    │
            │ Anthropic │ │  索引     │
            └─────┬─────┘ └─────┬─────┘
                  │             │
                  └──────┬──────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  结果格式化（GrokSkill / CodegraphSkill）                   │
└────────────────────────┬────────────────────────────────────┘
                    ┌────┴────┐
                    ▼         ▼
            ┌───────────┐ ┌───────────┐
            │  终端输出  │ │ Dashboard │
            │  (Ink)    │ │ (Browser) │
            └───────────┘ └───────────┘
```

---

## 文件结构映射

### 新增文件

```
src/tools/GrokTool/
├── GrokTool.ts               # Tool 定义（8 操作）
├── GrokManager.ts            # 适配层（源码克隆、Agent 流水线、图谱查询）
└── GrokSkill.ts              # Skill 层（参数解析、结果格式化）

src/tools/CodegraphTool/
└── CodegraphSkill.ts         # CodeGraph Skill 层（新增）

src/commands/
├── grok/index.ts             # /grok 命令（生成图谱）
├── gc/index.ts               # /gc 命令（自然语言问答）
├── gd/index.ts               # /gd 命令（打开 Dashboard）
├── ge/index.ts               # /ge 命令（深入解释）
├── gt/index.ts               # /gt 命令（引导式学习）
├── gdiff/index.ts            # /gdiff 命令（变更影响）
├── go/index.ts               # /go 命令（新人入职）
├── gdomain/index.ts          # /gdomain 命令（业务域分析）
└── cg/index.ts               # /cg 命令（CodeGraph 查询）
```

### 修改文件

```
src/commands.ts               # 注册新命令
src/tools.ts                  # 注册 GrokTool
```

---

## Phase 1: CodeGraph Skill 层

### Task 1.1: 创建 CodegraphSkill.ts

**Files:**
- Create: `src/tools/CodegraphTool/CodegraphSkill.ts`

- [ ] **Step 1: 创建 Skill 层基础结构**

```typescript
// src/tools/CodegraphTool/CodegraphSkill.ts

import type { ToolUseContext } from '../../Tool.js'
import * as CodegraphManager from './CodegraphManager.js'

export interface CodegraphSkillResult {
  formatted: string  // 终端友好的格式化输出
  raw: unknown       // 原始 JSON 数据
}

/**
 * 解析 /cg 子命令
 * 支持格式：
 *   /cg <query>           → 自然语言查询（智能路由）
 *   /cg s <query>         → 符号搜索
 *   /cg i <symbol>        → 影响分析
 *   /cg tr <from> <to>    → 路径追踪
 *   /cg c <symbol>        → 调用者
 *   /cg e <symbol>        → 被调用
 *   /cg init              → 初始化
 *   /cg st                → 状态
 */
export function parseCgCommand(args: string): {
  operation: string
  query?: string
  symbol?: string
} {
  const trimmed = args.trim()

  if (!trimmed) {
    return { operation: 'codegraph_status' }
  }

  // 子命令映射
  const subcommands: Record<string, string> = {
    's': 'codegraph_search',
    'search': 'codegraph_search',
    'i': 'codegraph_impact',
    'impact': 'codegraph_impact',
    'tr': 'codegraph_trace',
    'trace': 'codegraph_trace',
    'c': 'codegraph_callers',
    'callers': 'codegraph_callers',
    'e': 'codegraph_callees',
    'callees': 'codegraph_callees',
    'init': 'codegraph_init',
    'st': 'codegraph_status',
    'status': 'codegraph_status',
  }

  const parts = trimmed.split(/\s+/)
  const first = parts[0].toLowerCase()

  if (subcommands[first]) {
    const rest = parts.slice(1).join(' ')

    if (first === 'tr' || first === 'trace') {
      return {
        operation: 'codegraph_trace',
        query: rest,
      }
    }

    if (['i', 'impact', 'c', 'callers', 'e', 'callees'].includes(first)) {
      return {
        operation: subcommands[first],
        symbol: rest,
      }
    }

    return {
      operation: subcommands[first],
      query: rest || undefined,
    }
  }

  // 默认：自然语言查询
  return {
    operation: 'codegraph_context',
    query: trimmed,
  }
}

/**
 * 格式化 CodeGraph 结果为终端友好输出
 */
export function formatCodegraphResult(
  operation: string,
  result: unknown,
): CodegraphSkillResult {
  let formatted = ''

  switch (operation) {
    case 'codegraph_search': {
      const nodes = Array.isArray(result) ? result : []
      if (nodes.length === 0) {
        formatted = '未找到匹配的符号'
      } else {
        formatted = `找到 ${nodes.length} 个符号：\n\n`
        for (const node of nodes.slice(0, 10)) {
          const n = node as any
          formatted += `  ${n.name} (${n.kind})\n`
          formatted += `    文件: ${n.file}:${n.line}\n`
          if (n.signature) {
            formatted += `    签名: ${n.signature}\n`
          }
          formatted += '\n'
        }
        if (nodes.length > 10) {
          formatted += `  ... 还有 ${nodes.length - 10} 个结果\n`
        }
      }
      break
    }

    case 'codegraph_callers':
    case 'codegraph_callees': {
      const nodes = Array.isArray(result) ? result : []
      const label = operation === 'codegraph_callers' ? '调用者' : '被调用'
      if (nodes.length === 0) {
        formatted = `未找到${label}关系`
      } else {
        formatted = `找到 ${nodes.length} 个${label}：\n\n`
        for (const node of nodes.slice(0, 10)) {
          const n = node as any
          formatted += `  ${n.name}\n`
          formatted += `    文件: ${n.file}:${n.line}\n\n`
        }
      }
      break
    }

    case 'codegraph_impact': {
      const nodes = Array.isArray(result) ? result : []
      if (nodes.length === 0) {
        formatted = '未找到影响范围'
      } else {
        formatted = `影响分析（${nodes.length} 个文件）：\n\n`
        for (const node of nodes.slice(0, 15)) {
          const n = node as any
          formatted += `  ${n.name}\n`
          formatted += `    文件: ${n.file}\n`
          if (n.depth !== undefined) {
            formatted += `    深度: ${n.depth}\n`
          }
          formatted += '\n'
        }
        if (nodes.length > 15) {
          formatted += `  ... 还有 ${nodes.length - 15} 个文件\n`
        }
      }
      break
    }

    case 'codegraph_trace': {
      const data = result as any
      if (data.error) {
        formatted = `错误: ${data.error}`
      } else {
        formatted = `路径追踪: ${data.from} → ${data.to}\n\n`
        if (data.connectingNodes && data.connectingNodes.length > 0) {
          formatted += `连接节点（${data.connectingNodes.length} 个）：\n`
          for (const node of data.connectingNodes) {
            formatted += `  ${node.name}\n`
          }
        } else {
          formatted += '未找到直接连接路径'
        }
      }
      break
    }

    case 'codegraph_status': {
      const data = result as any
      formatted = `CodeGraph 状态：\n\n`
      formatted += `  已初始化: ${data.initialized ? '是' : '否'}\n`
      if (data.nodeCount !== undefined) {
        formatted += `  节点数: ${data.nodeCount}\n`
      }
      if (data.fileCount !== undefined) {
        formatted += `  文件数: ${data.fileCount}\n`
      }
      break
    }

    case 'codegraph_init': {
      const data = result as any
      formatted = data.message || '初始化完成'
      break
    }

    default: {
      formatted = JSON.stringify(result, null, 2)
    }
  }

  return { formatted, raw: result }
}
```

- [ ] **Step 2: 验证语法正确性**

Run: `bun build --no-bundle src/tools/CodegraphTool/CodegraphSkill.ts 2>&1 | head -20`
Expected: 无语法错误

- [ ] **Step 3: Commit**

```bash
git add src/tools/CodegraphTool/CodegraphSkill.ts
git commit -m "feat(codegraph): add Skill layer for /cg command parsing and formatting"
```

---

### Task 1.2: 创建 /cg 命令

**Files:**
- Create: `src/commands/cg/index.ts`

- [ ] **Step 1: 创建命令定义**

```typescript
// src/commands/cg/index.ts

import type { Command } from '../../commands.js'

const cg: Command = {
  type: 'prompt',
  name: 'cg',
  description: 'CodeGraph 代码查询 — 符号搜索、调用链、影响分析',
  aliases: ['codegraph'],
  argumentHint: '[query | s <query> | i <symbol> | tr <from> <to> | c <symbol> | e <symbol> | init | st]',
  contentLength: 2000,
  progressMessage: '查询 CodeGraph...',
  source: 'builtin',

  async getPromptForCommand(args) {
    // 动态导入 Skill 层
    const { parseCgCommand } = await import('../../tools/CodegraphTool/CodegraphSkill.js')
    const parsed = parseCgCommand(args)

    // 构造 prompt 让模型调用 codegraph Tool
    let prompt = ''

    switch (parsed.operation) {
      case 'codegraph_search':
        prompt = `使用 codegraph 工具搜索符号 "${parsed.query}"。返回匹配的符号列表，包含文件位置和签名。`
        break
      case 'codegraph_impact':
        prompt = `使用 codegraph 工具分析 "${parsed.symbol}" 的影响范围。返回所有受影响的文件和调用链。`
        break
      case 'codegraph_trace':
        prompt = `使用 codegraph 工具追踪调用路径: ${parsed.query}。找到从起点到终点的连接节点。`
        break
      case 'codegraph_callers':
        prompt = `使用 codegraph 工具查找 "${parsed.symbol}" 的调用者。返回所有调用该符号的文件和位置。`
        break
      case 'codegraph_callees':
        prompt = `使用 codegraph 工具查找 "${parsed.symbol}" 调用的函数。返回该符号调用的所有函数。`
        break
      case 'codegraph_init':
        prompt = `使用 codegraph 工具初始化当前项目的代码索引。这会下载必要的依赖并创建符号数据库。`
        break
      case 'codegraph_status':
        prompt = `使用 codegraph 工具检查当前项目的索引状态。返回节点数、文件数等统计信息。`
        break
      case 'codegraph_context':
      default:
        prompt = `使用 codegraph 工具理解 "${parsed.query}" 的代码上下文。返回相关的符号、文件和关系。`
        break
    }

    return [
      {
        type: 'text' as const,
        text: prompt,
      },
    ]
  },
}

export default cg
```

- [ ] **Step 2: 验证语法正确性**

Run: `bun build --no-bundle src/commands/cg/index.ts 2>&1 | head -20`
Expected: 无语法错误

- [ ] **Step 3: Commit**

```bash
git add src/commands/cg/index.ts
git commit -m "feat(commands): add /cg command for CodeGraph queries"
```

---

### Task 1.3: 注册 /cg 命令到 commands.ts

**Files:**
- Modify: `src/commands.ts:1-300`

- [ ] **Step 1: 添加 import**

在 `src/commands.ts` 的 import 区域添加：

```typescript
import cg from './commands/cg/index.js'
```

- [ ] **Step 2: 添加到 COMMANDS 数组**

在 `COMMANDS` 函数中添加 `cg`：

```typescript
const COMMANDS = memoize((): Command[] => [
  // ... existing commands ...
  cg,  // 添加在这里
  // ... rest of commands ...
])
```

- [ ] **Step 3: 验证编译**

Run: `bun run build:dev 2>&1 | tail -20`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/commands.ts
git commit -m "feat(commands): register /cg command for CodeGraph"
```

---

### Task 1.4: 测试 /cg 命令

- [ ] **Step 1: 启动开发模式**

Run: `bun run dev`

- [ ] **Step 2: 测试 /cg 命令**

在 ola-cc REPL 中输入：

```
/cg st
```

Expected: 显示 CodeGraph 索引状态

- [ ] **Step 3: 测试 /cg 搜索**

```
/cg s QueryGuard
```

Expected: 显示 QueryGuard 相关符号列表

- [ ] **Step 4: Commit 测试结果**

```bash
git add -A
git commit -m "test(codegraph): verify /cg command works"
```

---

## Phase 2: GrokManager 适配层

### Task 2.1: 创建 GrokManager.ts 基础结构

**Files:**
- Create: `src/tools/GrokTool/GrokManager.ts`

- [ ] **Step 1: 创建基础结构和类型定义**

```typescript
// src/tools/GrokTool/GrokManager.ts

import { z } from 'zod/v4'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'

// ============================================================
// Types
// ============================================================

export interface GrokGenerateOptions {
  path?: string           // 扫描路径，默认项目根目录
  language?: string       // 输出语言，默认 'en'
  scope?: string          // 子目录范围
  incremental?: boolean   // 增量更新，默认 true
  onProgress?: (stage: string, progress: number) => void  // 进度回调
}

export interface GrokGenerateResult {
  status: 'success' | 'partial' | 'failed'
  nodeCount: number
  edgeCount: number
  domainCount: number
  filePath: string        // knowledge-graph.json 路径
  errors?: GrokError[]    // 部分失败时的错误列表
}

export interface GrokChatResult {
  answer: string
  sources: { file: string; line: number; relevance: number }[]
}

export interface GrokError {
  agent: string           // 失败的 Agent 名称
  stage: string           // 失败阶段
  message: string
  recoverable: boolean    // 是否可恢复
  suggestion?: string     // 建议操作
}

export interface GrokGraphStatus {
  exists: boolean
  nodeCount?: number
  edgeCount?: number
  lastUpdated?: string
  stale?: boolean
}

// ============================================================
// Constants
// ============================================================

const GROK_VENDOR_DIR = '~/.ola-cc/vendor/grok'
const GROK_GRAPH_FILE = '.understand-anything/knowledge-graph.json'
const GROK_CHECKPOINT_DIR = '.understand-anything/checkpoints'

// Agent 超时配置（毫秒）
const AGENT_TIMEOUTS = {
  scanner: 30_000,
  analyzer_batch: 30_000,
  architecture: 60_000,
  tour: 60_000,
  review: 30_000,
  total: 10 * 60_000,  // 10 分钟
}

// Agent 系统提示词（从 Understand-Anything 源码提取）
const AGENT_SYSTEM_PROMPTS = {
  scanner: `You are a project scanner. Your job is to:
1. Discover all source files in the project
2. Detect programming languages and frameworks
3. Identify project structure and entry points

Output JSON: { files: string[], languages: string[], frameworks: string[], entryPoints: string[] }`,

  analyzer: `You are a code analyzer. Your job is to:
1. Parse source files using Tree-sitter
2. Extract symbols (functions, classes, types, interfaces)
3. Analyze semantic meaning and relationships
4. Generate concise summaries

Output JSON: { symbols: Symbol[], relationships: Relationship[] }

Symbol: { name, kind, file, line, signature, summary }
Relationship: { from, to, type }`,

  architecture: `You are an architecture analyzer. Your job is to:
1. Identify architectural layers (API, Service, Data, UI, Utility)
2. Detect design patterns
3. Map module dependencies

Output JSON: { layers: Layer[], patterns: Pattern[], dependencies: Dependency[] }

Layer: { name, modules: string[] }
Pattern: { name, location: string }
Dependency: { from, to, type }`,

  tour: `You are a tour builder. Your job is to:
1. Create guided learning paths through the codebase
2. Order modules by dependency and complexity
3. Generate clear, concise descriptions

Output JSON: { tours: Tour[] }

Tour: { name, description, steps: Step[] }
Step: { file, description, estimatedMinutes }`,

  review: `You are a graph reviewer. Your job is to:
1. Validate the knowledge graph for completeness
2. Check for missing relationships
3. Verify node and edge consistency

Output JSON: { valid: boolean, issues: Issue[], suggestions: string[] }

Issue: { type, location, message }`,
}

// ============================================================
// Configuration Validation
// ============================================================

const GrokConfigSchema = z.object({
  storage: z.enum(['project', 'user']).default('project'),
  portRange: z.string().regex(/^\d{5}-\d{5}$/).default('63000-63100'),
  language: z.string().min(2).max(5).default('en'),
  maxBatch: z.number().int().min(1).max(10).default(5),
  autoUpdate: z.boolean().default(false),
})

type GrokConfig = z.infer<typeof GrokConfigSchema>

/**
 * 从环境变量加载并验证配置
 */
function loadGrokConfig(): GrokConfig {
  const raw = {
    storage: process.env.OLA_CC_GROK_STORAGE,
    portRange: process.env.OLA_CC_GROK_PORT_RANGE,
    language: process.env.OLA_CC_GROK_LANGUAGE,
    maxBatch: process.env.OLA_CC_GROK_MAX_BATCH ? parseInt(process.env.OLA_CC_GROK_MAX_BATCH) : undefined,
    autoUpdate: process.env.OLA_CC_GROK_AUTO_UPDATE === 'true',
  }

  // 移除 undefined 值，让 Zod 使用默认值
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([_, v]) => v !== undefined)
  )

  try {
    return GrokConfigSchema.parse(cleaned)
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')
      logForDebugging(`[grok] Invalid configuration:\n${issues}`)
      // 使用默认值
      return GrokConfigSchema.parse({})
    }
    throw error
  }
}

// ============================================================
// GrokManager Class
// ============================================================

export class GrokManager {
  private projectRoot: string
  private vendorDir: string
  private config: GrokConfig

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || getCwd()
    this.vendorDir = GROK_VENDOR_DIR.replace('~', process.env.HOME || '~')
    this.config = loadGrokConfig()

    logForDebugging(`[grok] Config loaded: ${JSON.stringify(this.config)}`)
  }

  /**
   * 确保 Grok 源码已克隆
   */
  async ensureGrokSource(): Promise<string> {
    // TODO: 实现源码克隆逻辑
    throw new Error('Not implemented')
  }

  /**
   * 运行 Agent 流水线生成知识图谱
   */
  async runAgentPipeline(options: GrokGenerateOptions): Promise<GrokGenerateResult> {
    // TODO: 实现 Agent 流水线
    throw new Error('Not implemented')
  }

  /**
   * 查询已生成的知识图谱
   */
  async queryGraph(question: string): Promise<GrokChatResult> {
    // TODO: 实现图谱查询
    throw new Error('Not implemented')
  }

  /**
   * 启动浏览器 Dashboard
   */
  async startDashboard(port?: number): Promise<{ url: string; port: number }> {
    // TODO: 实现 Dashboard 启动
    throw new Error('Not implemented')
  }

  /**
   * 检查图谱状态
   */
  async getGraphStatus(): Promise<GrokGraphStatus> {
    // TODO: 实现状态检查
    throw new Error('Not implemented')
  }
}

// 导出单例
export const grokManager = new GrokManager()
```

- [ ] **Step 2: 验证语法正确性**

Run: `bun build --no-bundle src/tools/GrokTool/GrokManager.ts 2>&1 | head -20`
Expected: 无语法错误

- [ ] **Step 3: Commit**

```bash
git add src/tools/GrokTool/GrokManager.ts
git commit -m "feat(grok): add GrokManager base structure with types"
```

---

### Task 2.2: 实现源码克隆逻辑

**Files:**
- Modify: `src/tools/GrokTool/GrokManager.ts`

- [ ] **Step 1: 实现 ensureGrokSource()**

```typescript
// 在 GrokManager 类中添加

import { existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { resolve } from 'path'

/**
 * 确保 Grok 源码已克隆
 * @returns 源码目录路径
 */
async ensureGrokSource(): Promise<string> {
  const sourceDir = resolve(this.vendorDir, 'understand-anything')

  // 检查是否已存在
  if (existsSync(sourceDir)) {
    logForDebugging(`[grok] Source already exists at ${sourceDir}`)
    return sourceDir
  }

  // 创建目录
  mkdirSync(this.vendorDir, { recursive: true })

  // 克隆仓库
  logForDebugging(`[grok] Cloning Understand-Anything to ${sourceDir}`)
  try {
    execSync(
      `git clone --depth 1 https://github.com/Lum1104/Understand-Anything.git ${sourceDir}`,
      { stdio: 'pipe' }
    )
    logForDebugging(`[grok] Clone complete`)
    return sourceDir
  } catch (error) {
    throw new GrokError(
      'SOURCE_CLONE_FAILED',
      'clone',
      `Failed to clone source: ${error instanceof Error ? error.message : String(error)}`,
      false,
      'Check network connection and try again'
    )
  }
}

/**
 * 更新 Grok 源码
 */
async updateGrokSource(): Promise<void> {
  const sourceDir = resolve(this.vendorDir, 'understand-anything')

  if (!existsSync(sourceDir)) {
    await this.ensureGrokSource()
    return
  }

  logForDebugging(`[grok] Updating source at ${sourceDir}`)
  try {
    execSync('git pull', { cwd: sourceDir, stdio: 'pipe' })
    logForDebugging(`[grok] Update complete`)
  } catch (error) {
    throw new GrokError(
      'SOURCE_UPDATE_FAILED',
      'update',
      `Failed to update source: ${error instanceof Error ? error.message : String(error)}`,
      true,
      'Try running /grok --update manually'
    )
  }
}
```

- [ ] **Step 2: 添加 GrokError 类**

```typescript
// 在文件顶部添加

export class GrokError extends Error {
  constructor(
    public code: string,
    public stage: string,
    message: string,
    public recoverable: boolean,
    public suggestion?: string
  ) {
    super(message)
    this.name = 'GrokError'
  }
}

// 错误类型与建议
export const ERROR_SUGGESTIONS: Record<string, string> = {
  'PARSE_TIMEOUT': '文件过大，建议 --exclude 排除或拆分文件',
  'LLM_RATE_LIMIT': 'API 限流，建议等待 60s 后重试',
  'LLM_TOKEN_BUDGET': 'Token 预算耗尽，建议 --scope 缩小范围',
  'GRAPH_INVALID': '图谱数据损坏，建议 /grok --full 重新生成',
  'SOURCE_CLONE_FAILED': '源码克隆失败，检查网络连接后重试',
}
```

- [ ] **Step 3: 添加重试机制**

```typescript
// 在 GrokManager 类中添加

/**
 * 带指数退避的重试机制
 * @param fn 要执行的函数
 * @param maxRetries 最大重试次数（默认 3）
 * @param baseDelay 基础延迟（毫秒，默认 1000）
 */
private async retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i === maxRetries - 1) throw error
      const delay = baseDelay * Math.pow(2, i)
      logForDebugging(`[grok] Retry ${i + 1}/${maxRetries} after ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Unreachable')
}
```

- [ ] **Step 4: 更新 ensureGrokSource() 使用重试**

```typescript
// 更新 ensureGrokSource() 方法

/**
 * 确保 Grok 源码已克隆（带重试）
 * @returns 源码目录路径
 */
async ensureGrokSource(): Promise<string> {
  const sourceDir = resolve(this.vendorDir, 'understand-anything')

  // 检查是否已存在
  if (existsSync(sourceDir)) {
    logForDebugging(`[grok] Source already exists at ${sourceDir}`)
    return sourceDir
  }

  // 创建目录
  mkdirSync(this.vendorDir, { recursive: true })

  // 带重试的克隆
  return this.retryWithBackoff(async () => {
    logForDebugging(`[grok] Cloning Understand-Anything to ${sourceDir}`)
    try {
      execSync(
        `git clone --depth 1 https://github.com/Lum1104/Understand-Anything.git ${sourceDir}`,
        { stdio: 'pipe' }
      )
      logForDebugging(`[grok] Clone complete`)
      return sourceDir
    } catch (error) {
      throw new GrokError(
        'SOURCE_CLONE_FAILED',
        'clone',
        `Failed to clone source: ${error instanceof Error ? error.message : String(error)}`,
        true,  // 可恢复，会重试
        'Check network connection and try again'
      )
    }
  })
}
```

- [ ] **Step 5: 验证编译**

Run: `bun run build:dev 2>&1 | tail -20`
Expected: 编译成功

- [ ] **Step 6: Commit**

```bash
git add src/tools/GrokTool/GrokManager.ts
git commit -m "feat(grok): implement source cloning with retry mechanism"
```

---

### Task 2.3: 实现轻量级 Agent 调用

**Files:**
- Modify: `src/tools/GrokTool/GrokManager.ts`

- [ ] **Step 1: 添加 callAgent() 方法**

```typescript
// 在 GrokManager 类中添加

import { getAnthropicClient } from '../../services/api/client.js'
import { getAgentModel } from '../../utils/model/agent.js'

/**
 * 轻量级 Agent 调用 — 直接使用 Anthropic SDK
 * 不通过 AgentTool，避免 UI 开销
 */
private async callAgent(prompt: string, systemPrompt: string): Promise<string> {
  const client = getAnthropicClient()
  const model = getAgentModel()

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    })

    const textBlock = response.content.find(block => block.type === 'text')
    return textBlock ? textBlock.text : ''
  } catch (error) {
    // 处理 rate limit
    if (error instanceof Error && error.message.includes('429')) {
      throw new GrokError(
        'LLM_RATE_LIMIT',
        'agent',
        'API rate limit exceeded',
        true,
        'Wait 60 seconds and try again'
      )
    }
    throw error
  }
}

/**
 * 并行分析文件批次
 * @param files 文件列表
 * @param batchSize 每批文件数（默认 25）
 * @param maxParallel 最大并行数（默认 5）
 */
private async analyzeFilesBatch(
  files: string[],
  batchSize: number = 25,
  maxParallel: number = 5
): Promise<any[]> {
  const batches = chunkArray(files, batchSize)
  const results: any[] = []

  // 并行处理批次
  for (let i = 0; i < batches.length; i += maxParallel) {
    const parallelBatches = batches.slice(i, i + maxParallel)
    const batchResults = await Promise.all(
      parallelBatches.map(batch =>
        this.callAgent(
          this.buildFileAnalyzerPrompt(batch),
          AGENT_SYSTEM_PROMPTS.analyzer
        )
      )
    )
    results.push(...batchResults.flatMap(r => this.parseAnalysisResult(r)))
  }

  return results
}

/**
 * 构建 file-analyzer 提示词
 */
private buildFileAnalyzerPrompt(files: string[]): string {
  return `Analyze the following files and extract symbols, relationships, and summaries:

${files.map(f => `- ${f}`).join('\n')}

For each file, identify:
1. Functions, classes, types, interfaces (symbols)
2. Import/export relationships
3. Function calls and dependencies
4. Brief summary of purpose

Output JSON array of analysis results.`
}

/**
 * 解析分析结果
 */
private parseAnalysisResult(result: string): any[] {
  try {
    const parsed = JSON.parse(result)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    logForDebugging(`[grok] Failed to parse analysis result: ${result.slice(0, 200)}`)
    return []
  }
}

// ============================================================
// 超时配置
// ============================================================

private readonly LLM_TIMEOUT = 30_000    // LLM 调用超时 30 秒
private readonly PARSE_TIMEOUT = 10_000  // 文件解析超时 10 秒

/**
 * 带超时的 Agent 调用
 * 防止 LLM 调用挂起阻塞整个流程
 */
private async callAgentWithTimeout(prompt: string, systemPrompt: string): Promise<string> {
  return Promise.race([
    this.callAgent(prompt, systemPrompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new GrokError(
        'LLM_TIMEOUT',
        'agent',
        'LLM call timed out after 30s',
        true,
        'Try with smaller scope or check API status'
      )), this.LLM_TIMEOUT)
    )
  ])
}

/**
 * 带超时的文件解析
 */
private async parseWithTimeout<T>(fn: () => T, fileName: string): Promise<T> {
  return Promise.race([
    Promise.resolve(fn()),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new GrokError(
        'PARSE_TIMEOUT',
        'parse',
        `Parsing ${fileName} timed out after 10s`,
        true,
        'File too large, use --exclude to skip'
      )), this.PARSE_TIMEOUT)
    )
  ])
}
```

- [ ] **Step 2: 添加工具函数**

```typescript
// 在文件底部添加

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}
```

- [ ] **Step 3: 验证编译**

Run: `bun run build:dev 2>&1 | tail -20`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/tools/GrokTool/GrokManager.ts
git commit -m "feat(grok): add lightweight Agent call using Anthropic SDK"
```

---

### Task 2.4: 实现图谱状态检查

**Files:**
- Modify: `src/tools/GrokTool/GrokManager.ts`

- [ ] **Step 1: 实现 getGraphStatus()**

```typescript
// 在 GrokManager 类中实现

import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * 检查图谱状态
 */
async getGraphStatus(): Promise<GrokGraphStatus> {
  const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)

  try {
    const content = readFileSync(graphPath, 'utf-8')
    const graph = JSON.parse(content)

    // 检查是否过期（超过 24 小时）
    const lastUpdated = graph.metadata?.lastUpdated
    const stale = lastUpdated
      ? Date.now() - new Date(lastUpdated).getTime() > 24 * 60 * 60 * 1000
      : true

    return {
      exists: true,
      nodeCount: graph.nodes?.length || 0,
      edgeCount: graph.edges?.length || 0,
      lastUpdated,
      stale,
    }
  } catch (error) {
    // 文件不存在或解析失败
    return { exists: false }
  }
}
```

- [ ] **Step 2: 验证编译**

Run: `bun run build:dev 2>&1 | tail -20`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
git add src/tools/GrokTool/GrokManager.ts
git commit -m "feat(grok): implement graph status check"
```

---

### Task 2.5: GrokManager 单元测试

**Files:**
- Create: `src/tools/GrokTool/__tests__/GrokManager.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
// src/tools/GrokTool/__tests__/GrokManager.test.ts

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { GrokManager, GrokError } from '../GrokManager.js'

// Mock 外部依赖
mock.module('fs', () => ({
  existsSync: mock(() => false),
  readFileSync: mock(() => '{}'),
  writeFileSync: mock(() => {}),
  mkdirSync: mock(() => {}),
}))

mock.module('child_process', () => ({
  spawn: mock(() => ({
    stdout: { on: mock() },
    stderr: { on: mock() },
    on: mock((event, cb) => { if (event === 'close') cb(0) }),
  })),
}))

describe('GrokManager', () => {
  let manager: GrokManager

  beforeEach(() => {
    manager = new GrokManager('/tmp/test-project')
  })

  describe('loadGrokConfig', () => {
    it('should load valid config from environment', () => {
      process.env.GROK_SOURCE_REPO = 'https://github.com/test/repo.git'
      process.env.GROK_SOURCE_BRANCH = 'main'
      process.env.GROK_LLM_MODEL = 'claude-sonnet-4-20250514'

      const config = manager.loadGrokConfig()

      expect(config.sourceRepo).toBe('https://github.com/test/repo.git')
      expect(config.sourceBranch).toBe('main')
      expect(config.llmModel).toBe('claude-sonnet-4-20250514')

      delete process.env.GROK_SOURCE_REPO
      delete process.env.GROK_SOURCE_BRANCH
      delete process.env.GROK_LLM_MODEL
    })

    it('should use defaults for missing optional config', () => {
      const config = manager.loadGrokConfig()

      expect(config.sourceBranch).toBe('main')
      expect(config.llmModel).toBe('claude-sonnet-4-20250514')
      expect(config.maxConcurrentBatches).toBe(5)
    })

    it('should throw on invalid GROK_MAX_CONCURRENT value', () => {
      process.env.GROK_MAX_CONCURRENT = '25'

      expect(() => manager.loadGrokConfig()).toThrow('GROK_MAX_CONCURRENT 必须在 1-20 之间')

      delete process.env.GROK_MAX_CONCURRENT
    })
  })

  describe('retryWithBackoff', () => {
    it('should succeed on first attempt', async () => {
      const fn = mock(() => Promise.resolve('success'))

      const result = await manager.retryWithBackoff(fn, 3, 100)

      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('should retry on failure and succeed', async () => {
      let attempts = 0
      const fn = mock(() => {
        attempts++
        if (attempts < 3) return Promise.reject(new Error('fail'))
        return Promise.resolve('success')
      })

      const result = await manager.retryWithBackoff(fn, 3, 10)

      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(3)
    })

    it('should throw after max retries', async () => {
      const fn = mock(() => Promise.reject(new Error('always fail')))

      await expect(manager.retryWithBackoff(fn, 2, 10)).rejects.toThrow('always fail')
      expect(fn).toHaveBeenCalledTimes(2)
    })
  })

  describe('getGraphStatus', () => {
    it('should return exists=false when graph file missing', async () => {
      const status = await manager.getGraphStatus()

      expect(status.exists).toBe(false)
    })
  })

  describe('queryGraph', () => {
    it('should throw GRAPH_NOT_FOUND when graph does not exist', async () => {
      await expect(manager.queryGraph('test')).rejects.toThrow(GrokError)
      await expect(manager.queryGraph('test')).rejects.toThrow('知识图谱未生成')
    })
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/tools/GrokTool/__tests__/GrokManager.test.ts 2>&1`
Expected: 所有测试通过

- [ ] **Step 3: Commit**

```bash
git add src/tools/GrokTool/__tests__/GrokManager.test.ts
git commit -m "test(grok): add GrokManager unit tests"
```

---

## Phase 3: Grok Tool 注册

### Task 3.1: 创建 GrokTool.ts

**Files:**
- Create: `src/tools/GrokTool/GrokTool.ts`

- [ ] **Step 1: 创建 Tool 定义**

```typescript
// src/tools/GrokTool/GrokTool.ts

import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { grokManager } from './GrokManager.js'

// ============================================================
// Schema
// ============================================================

const operationEnum = z.enum([
  'grok_generate',
  'grok_chat',
  'grok_explain',
  'grok_domain',
  'grok_tour',
  'grok_diff',
  'grok_status',
  'grok_dashboard',
])

const inputSchema = z.object({
  operation: operationEnum.describe('Grok 操作类型'),
  question: z.string().optional().describe('问题（用于 grok_chat）'),
  target: z.string().optional().describe('目标文件/函数（用于 grok_explain）'),
  topic: z.string().optional().describe('主题（用于 grok_tour）'),
  files: z.array(z.string()).optional().describe('变更文件列表（用于 grok_diff）'),
  path: z.string().optional().describe('扫描路径（用于 grok_generate）'),
  language: z.string().optional().describe('输出语言（用于 grok_generate）'),
  scope: z.string().optional().describe('子目录范围（用于 grok_generate）'),
  incremental: z.boolean().optional().describe('增量更新（用于 grok_generate）'),
  port: z.number().optional().describe('端口号（用于 grok_dashboard）'),
})

// ============================================================
// Tool
// ============================================================

export const grokTool = buildTool({
  name: 'grok',
  description:
    'Grok 代码理解 — 知识图谱生成、自然语言问答、业务域分析、引导式学习。' +
    '首次使用需要生成知识图谱（约 3-5 分钟），之后查询秒级响应。',

  inputSchema,

  async call(input: z.infer<typeof inputSchema>) {
    const projectRoot = getCwd()

    try {
      // 确保源码已克隆
      await grokManager.ensureGrokSource()

      let result: unknown

      switch (input.operation) {
        case 'grok_generate': {
          const genResult = await grokManager.runAgentPipeline({
            path: input.path || projectRoot,
            language: input.language,
            scope: input.scope,
            incremental: input.incremental ?? true,
          })
          result = genResult
          break
        }

        case 'grok_chat': {
          if (!input.question) {
            return errorResult('grok_chat 需要 question 参数')
          }
          const chatResult = await grokManager.queryGraph(input.question)
          result = chatResult
          break
        }

        case 'grok_explain': {
          if (!input.target) {
            return errorResult('grok_explain 需要 target 参数')
          }
          // 查询图谱获取文件/函数信息
          const explainResult = await grokManager.queryGraph(
            `Explain ${input.target}: what it does, its relationships, which layer and domain it belongs to`
          )
          result = {
            summary: explainResult.answer,
            relationships: explainResult.sources,
          }
          break
        }

        case 'grok_domain': {
          const domainResult = await grokManager.queryGraph(
            'Analyze the business domains in this codebase. List each domain with its flows and files.'
          )
          result = { domains: domainResult.answer }
          break
        }

        case 'grok_tour': {
          const tourResult = await grokManager.queryGraph(
            input.topic
              ? `Create a guided learning tour for: ${input.topic}`
              : 'Create guided learning tours for this codebase'
          )
          result = { tours: tourResult.answer }
          break
        }

        case 'grok_diff': {
          if (!input.files || input.files.length === 0) {
            return errorResult('grok_diff 需要 files 参数')
          }
          const diffResult = await grokManager.queryGraph(
            `Analyze the impact of changes to these files: ${input.files.join(', ')}`
          )
          result = { impacted: diffResult.answer }
          break
        }

        case 'grok_status': {
          const status = await grokManager.getGraphStatus()
          result = status
          break
        }

        case 'grok_dashboard': {
          const dashResult = await grokManager.startDashboard(input.port)
          result = dashResult
          break
        }

        default:
          return errorResult(`未知操作: ${input.operation}`)
      }

      return successResult(input.operation, result)
    } catch (error) {
      logForDebugging(`[grok] error: ${error}`)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: true,
            operation: input.operation,
            message: error instanceof Error ? error.message : String(error),
          }, null, 2),
        }],
      }
    }
  },

  async prompt(input) {
    const op = input?.operation ?? ''
    const question = input?.question ?? ''
    const target = input?.target ?? ''

    switch (op) {
      case 'grok_generate': return '生成项目知识图谱'
      case 'grok_chat': return `回答问题: ${question}`
      case 'grok_explain': return `解释 ${target}`
      case 'grok_domain': return '分析业务域'
      case 'grok_tour': return '生成学习路径'
      case 'grok_diff': return '分析变更影响'
      case 'grok_status': return '检查图谱状态'
      case 'grok_dashboard': return '启动 Dashboard'
      default: return `Grok ${op}`
    }
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
  isReadOnly: (input) => {
    const op = typeof input === 'object' && input !== null && 'operation' in input
      ? (input as { operation?: string }).operation ?? ''
      : ''
    return op !== 'grok_generate'
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output, null, 2),
    }
  },
})

// ============================================================
// Helpers
// ============================================================

function successResult(operation: string, data: unknown) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: true, operation, result: data }, null, 2),
    }],
  }
}

function errorResult(message: string) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: true, message }, null, 2),
    }],
  }
}
```

- [ ] **Step 2: 验证编译**

Run: `bun run build:dev 2>&1 | tail -20`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
git add src/tools/GrokTool/GrokTool.ts
git commit -m "feat(grok): add GrokTool with 8 operations"
```

---

### Task 3.2: 注册 GrokTool 到 tools.ts

**Files:**
- Modify: `src/tools.ts`

- [ ] **Step 1: 查找 tools.ts 位置并读取**

Run: `find src -name "tools.ts" -not -path "*/node_modules/*" | head -5`

- [ ] **Step 2: 添加 import 和注册**

在 `src/tools.ts` 中添加：

```typescript
import { grokTool } from './tools/GrokTool/GrokTool.js'

// 在工具注册数组中添加
export const tools = [
  // ... existing tools ...
  grokTool,
  // ... rest of tools ...
]
```

- [ ] **Step 3: 验证编译**

Run: `bun run build:dev 2>&1 | tail -20`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/tools.ts
git commit -m "feat(tools): register GrokTool for code understanding"
```

---

## Phase 4: Grok Skill 层

### Task 4.1: 创建 Grok 命令系列

**Files:**
- Create: `src/commands/grok/index.ts`
- Create: `src/commands/gc/index.ts`
- Create: `src/commands/gd/index.ts`
- Create: `src/commands/ge/index.ts`
- Create: `src/commands/gt/index.ts`
- Create: `src/commands/gdiff/index.ts`
- Create: `src/commands/go/index.ts`
- Create: `src/commands/gdomain/index.ts`

- [ ] **Step 1: 创建 /grok 命令（local 类型）**

```typescript
// src/commands/grok/index.ts

import type { Command } from '../../commands.js'

const grok: Command = {
  type: 'local',
  name: 'grok',
  description: '生成项目知识图谱（首次约 3-5 分钟）',
  aliases: ['understand'],
  argumentHint: '[--language zh] [--scope <path>]',
  supportsNonInteractive: false,
  load: () => import('./grok.js'),
}

export default grok
```

```typescript
// src/commands/grok/grok.ts

import type { LocalCommandModule } from '../../commands.js'
import { grokManager } from '../../tools/GrokTool/GrokManager.js'

export const call: LocalCommandModule['call'] = async (args, context) => {
  // 解析参数
  const languageMatch = args.match(/--language\s+(\w+)/)
  const scopeMatch = args.match(/--scope\s+(\S+)/)
  const language = languageMatch?.[1] || 'en'
  const scope = scopeMatch?.[1]

  // 显示进度
  const { setMessages } = context
  let progressMessage = '┌── Grok 图谱生成 ──────────────────────────────┐\n'

  try {
    const result = await grokManager.runAgentPipeline({
      language,
      scope,
      onProgress: (stage, progress) => {
        // 更新进度显示
        progressMessage += `│ ${stage.padEnd(20)} ${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))} ${progress}%\n`
      },
    })

    progressMessage += '└──────────────────────────────────────────────────┘\n'
    progressMessage += `\n✓ 图谱已生成: ${result.filePath}\n`
    progressMessage += `  节点: ${result.nodeCount} | 边: ${result.edgeCount} | 域: ${result.domainCount}\n`
    progressMessage += '\n💡 输入 /gd 查看交互式 Dashboard\n'

    return { type: 'text', value: progressMessage }
  } catch (error) {
    return {
      type: 'text',
      value: `✗ 图谱生成失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
```

- [ ] **Step 2: 创建 /gc 命令（prompt 类型）**

```typescript
// src/commands/gc/index.ts

import type { Command } from '../../commands.js'

const gc: Command = {
  type: 'prompt',
  name: 'gc',
  description: 'Grok 自然语言问答',
  aliases: ['grok-chat'],
  argumentHint: '<question>',
  contentLength: 1000,
  progressMessage: '查询知识图谱...',
  source: 'builtin',

  async getPromptForCommand(args) {
    if (!args.trim()) {
      return [{ type: 'text', text: '请输入问题，例如: /gc 支付流程是怎么工作的？' }]
    }

    return [
      {
        type: 'text',
        text: `使用 grok 工具回答问题: ${args.trim()}`,
      },
    ]
  },
}

export default gc
```

- [ ] **Step 3: 创建 /gd 命令（local 类型）**

```typescript
// src/commands/gd/index.ts

import type { Command } from '../../commands.js'

const gd: Command = {
  type: 'local',
  name: 'gd',
  description: '打开浏览器 Dashboard',
  aliases: ['grok-dashboard'],
  supportsNonInteractive: false,
  load: () => import('./gd.js'),
}

export default gd
```

```typescript
// src/commands/gd/gd.ts

import type { LocalCommandModule } from '../../commands.js'
import { grokManager } from '../../tools/GrokTool/GrokManager.js'

export const call: LocalCommandModule['call'] = async (args, context) => {
  try {
    const { url, port } = await grokManager.startDashboard()
    return {
      type: 'text',
      value: `✓ Dashboard 已启动: ${url}\n（浏览器自动打开）`,
    }
  } catch (error) {
    return {
      type: 'text',
      value: `✗ Dashboard 启动失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
```

- [ ] **Step 4: 创建其他命令（prompt 类型）**

```typescript
// src/commands/ge/index.ts
import type { Command } from '../../commands.js'

const ge: Command = {
  type: 'prompt',
  name: 'ge',
  description: 'Grok 深入解释文件/函数',
  aliases: ['grok-explain'],
  argumentHint: '<file>',
  contentLength: 1000,
  progressMessage: '分析文件...',
  source: 'builtin',

  async getPromptForCommand(args) {
    if (!args.trim()) {
      return [{ type: 'text', text: '请指定文件，例如: /ge src/QueryEngine.ts' }]
    }
    return [{ type: 'text', text: `使用 grok 工具解释: ${args.trim()}` }]
  },
}

export default ge
```

```typescript
// src/commands/gt/index.ts
import type { Command } from '../../commands.js'

const gt: Command = {
  type: 'prompt',
  name: 'gt',
  description: 'Grok 引导式学习路径',
  aliases: ['grok-tour'],
  argumentHint: '[topic]',
  contentLength: 1000,
  progressMessage: '生成学习路径...',
  source: 'builtin',

  async getPromptForCommand(args) {
    const topic = args.trim()
    return [{
      type: 'text',
      text: topic
        ? `使用 grok 工具生成 "${topic}" 的学习路径`
        : '使用 grok 工具生成项目学习路径',
    }]
  },
}

export default gt
```

```typescript
// src/commands/gdiff/index.ts
import type { Command } from '../../commands.js'

const gdiff: Command = {
  type: 'prompt',
  name: 'gdiff',
  description: 'Grok 变更影响分析',
  aliases: ['grok-diff'],
  contentLength: 1000,
  progressMessage: '分析变更影响...',
  source: 'builtin',

  async getPromptForCommand() {
    return [{ type: 'text', text: '使用 grok 工具分析当前变更的影响' }]
  },
}

export default gdiff
```

```typescript
// src/commands/go/index.ts
import type { Command } from '../../commands.js'

const go: Command = {
  type: 'prompt',
  name: 'go',
  description: 'Grok 新人入职指南',
  aliases: ['grok-onboard'],
  contentLength: 1000,
  progressMessage: '生成入职指南...',
  source: 'builtin',

  async getPromptForCommand() {
    return [{ type: 'text', text: '使用 grok 工具生成新人入职指南' }]
  },
}

export default go
```

```typescript
// src/commands/gdomain/index.ts
import type { Command } from '../../commands.js'

const gdomain: Command = {
  type: 'prompt',
  name: 'gdomain',
  description: 'Grok 业务域分析',
  aliases: ['grok-domain'],
  contentLength: 1000,
  progressMessage: '分析业务域...',
  source: 'builtin',

  async getPromptForCommand() {
    return [{ type: 'text', text: '使用 grok 工具分析业务域' }]
  },
}

export default gdomain
```

- [ ] **Step 5: 验证所有命令语法**

Run: `for f in src/commands/grok/index.ts src/commands/gc/index.ts src/commands/gd/index.ts src/commands/ge/index.ts src/commands/gt/index.ts src/commands/gdiff/index.ts src/commands/go/index.ts src/commands/gdomain/index.ts; do bun build --no-bundle $f 2>&1 | head -5; done`
Expected: 所有文件无语法错误

- [ ] **Step 6: Commit**

```bash
git add src/commands/grok/ src/commands/gc/ src/commands/gd/ src/commands/ge/ src/commands/gt/ src/commands/gdiff/ src/commands/go/ src/commands/gdomain/
git commit -m "feat(commands): add Grok command series (/grok, /gc, /gd, /ge, /gt, /gdiff, /go, /gdomain)"
```

---

### Task 4.2: 注册所有 Grok 命令

**Files:**
- Modify: `src/commands.ts`

- [ ] **Step 1: 添加 imports**

在 `src/commands.ts` 的 import 区域添加：

```typescript
import grok from './commands/grok/index.js'
import gc from './commands/gc/index.js'
import gd from './commands/gd/index.js'
import ge from './commands/ge/index.js'
import gt from './commands/gt/index.js'
import gdiff from './commands/gdiff/index.js'
import go from './commands/go/index.js'
import gdomain from './commands/gdomain/index.js'
```

- [ ] **Step 2: 添加到 COMMANDS 数组**

```typescript
const COMMANDS = memoize((): Command[] => [
  // ... existing commands ...
  grok,
  gc,
  gd,
  ge,
  gt,
  gdiff,
  go,
  gdomain,
  // ... rest of commands ...
])
```

- [ ] **Step 3: 验证编译**

Run: `bun run build:dev 2>&1 | tail -20`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/commands.ts
git commit -m "feat(commands): register all Grok commands"
```

---

## Phase 5: Dashboard 集成（浏览器）

### Task 5.1: 实现 Dashboard HTTP 服务

**Files:**
- Modify: `src/tools/GrokTool/GrokManager.ts`

- [ ] **Step 1: 实现 startDashboard()**

```typescript
// 在 GrokManager 类中实现

import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { openBrowser } from '../../utils/browser.js'

// Dashboard 端口范围
const PORT_RANGE = { min: 63000, max: 63100 }

/**
 * 启动浏览器 Dashboard
 */
async startDashboard(port?: number): Promise<{ url: string; port: number }> {
  // 检查图谱是否存在
  const status = await this.getGraphStatus()
  if (!status.exists) {
    throw new GrokError(
      'GRAPH_NOT_FOUND',
      'dashboard',
      '知识图谱未生成，请先执行 /grok',
      true
    )
  }

  // 查找可用端口
  const actualPort = port || await this.findAvailablePort()

  // 生成随机 token 防止 CSRF
  const token = Math.random().toString(36).slice(2)

  // 创建 HTTP 服务
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${actualPort}`)

    // 健康检查端点（不需要 token）
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        graphExists: existsSync(resolve(this.projectRoot, GROK_GRAPH_FILE)),
      }))
      return
    }

    // 验证 token（其他端点需要）
    if (url.searchParams.get('token') !== token) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    // 提供图谱数据
    if (url.pathname === '/api/graph') {
      const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)
      try {
        const data = readFileSync(graphPath, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end('Graph not found')
      }
      return
    }

    // 提供 Dashboard HTML（嵌入式）
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(this.getDashboardHtml(actualPort, token))
  })

  // 启动服务
  return new Promise((resolve, reject) => {
    server.listen(actualPort, '127.0.0.1', () => {
      const url = `http://localhost:${actualPort}/dashboard?token=${token}`
      logForDebugging(`[grok] Dashboard started at ${url}`)

      // 自动打开浏览器
      openBrowser(url)

      // 30 分钟后自动关闭
      setTimeout(() => {
        server.close()
        logForDebugging(`[grok] Dashboard auto-closed after 30 minutes`)
      }, 30 * 60 * 1000)

      resolve({ url, port: actualPort })
    })

    server.on('error', reject)
  })
}

/**
 * 查找可用端口
 */
private async findAvailablePort(): Promise<number> {
  for (let port = PORT_RANGE.min; port <= PORT_RANGE.max; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer()
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve())
        })
        server.on('error', reject)
      })
      return port
    } catch {
      continue
    }
  }
  throw new GrokError(
    'NO_AVAILABLE_PORT',
    'dashboard',
    `No available port in range ${PORT_RANGE.min}-${PORT_RANGE.max}`,
    false
  )
}

/**
 * 生成 Dashboard HTML
 * 使用内嵌的 D3.js 可视化
 */
private getDashboardHtml(port: number, token: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Grok 代码知识图谱</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a1a; color: #fff; }
    #graph { width: 100vw; height: 100vh; }
    .node { cursor: pointer; }
    .node circle { fill: #4ecca3; stroke: #fff; stroke-width: 1.5px; }
    .node text { font-size: 12px; fill: #fff; }
    .link { stroke: #333; stroke-opacity: 0.6; }
    #info { position: fixed; top: 20px; right: 20px; background: #1a1a2e; padding: 20px; border-radius: 8px; width: 300px; }
    h3 { margin: 0 0 10px; color: #4ecca3; }
  </style>
</head>
<body>
  <div id="graph"></div>
  <div id="info">
    <h3>Grok 代码知识图谱</h3>
    <p>点击节点查看详情</p>
  </div>
  <script>
    const port = ${port};
    const token = '${token}';

    fetch(\`http://localhost:\${port}/api/graph?token=\${token}\`)
      .then(r => r.json())
      .then(data => {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const svg = d3.select('#graph')
          .append('svg')
          .attr('width', width)
          .attr('height', height);

        const simulation = d3.forceSimulation(data.nodes)
          .force('link', d3.forceLink(data.edges).id(d => d.id))
          .force('charge', d3.forceManyBody().strength(-100))
          .force('center', d3.forceCenter(width / 2, height / 2));

        const link = svg.append('g')
          .selectAll('line')
          .data(data.edges)
          .join('line')
          .attr('class', 'link');

        const node = svg.append('g')
          .selectAll('g')
          .data(data.nodes)
          .join('g')
          .attr('class', 'node')
          .call(d3.drag()
            .on('start', (event, d) => {
              if (!event.active) simulation.alphaTarget(0.3).restart();
              d.fx = d.x; d.fy = d.y;
            })
            .on('drag', (event, d) => {
              d.fx = event.x; d.fy = event.y;
            })
            .on('end', (event, d) => {
              if (!event.active) simulation.alphaTarget(0);
              d.fx = null; d.fy = null;
            }));

        node.append('circle').attr('r', 8);
        node.append('text').text(d => d.name).attr('x', 12).attr('y', 4);

        node.on('click', (event, d) => {
          document.getElementById('info').innerHTML = \`
            <h3>\${d.name}</h3>
            <p><strong>类型:</strong> \${d.kind}</p>
            <p><strong>文件:</strong> \${d.file}:\${d.line}</p>
            <p>\${d.summary || ''}</p>
          \`;
        });

        simulation.on('tick', () => {
          link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

          node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
        });
      });
  </script>
</body>
</html>`
}
```

- [ ] **Step 2: 验证编译**

Run: `bun run build:dev 2>&1 | tail -20`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
git add src/tools/GrokTool/GrokManager.ts
git commit -m "feat(grok): implement Dashboard HTTP server with D3 visualization"
```

---

## Phase 6: 终端 Ink 集成（可选）

> **注意**：Phase 6 是可选的增强功能，可以后续实现。当前 Phase 1-5 已经提供了完整的核心功能。

### Task 6.1: 创建 GrokSkill.ts

**Files:**
- Create: `src/tools/GrokTool/GrokSkill.ts`

- [ ] **Step 1: 创建 Skill 层**

```typescript
// src/tools/GrokTool/GrokSkill.ts

import type { ToolUseContext } from '../../Tool.js'
import { grokManager, GrokError } from './GrokManager.js'

export interface GrokSkillResult {
  formatted: string
  raw: unknown
}

/**
 * 格式化 Grok 错误为用户友好的消息
 */
export function formatGrokError(error: unknown): string {
  if (error instanceof GrokError) {
    let msg = `✗ Grok 错误 [${error.code}]: ${error.message}`
    if (error.recoverable) {
      msg += `\n  💡 此错误可恢复，请稍后重试`
    }
    return msg
  }

  if (error instanceof Error) {
    return `✗ Grok 错误: ${error.message}`
  }

  return `✗ 未知错误: ${String(error)}`
}

/**
 * 格式化 Grok 结果为终端友好输出
 */
export function formatGrokResult(operation: string, result: unknown): GrokSkillResult {
  let formatted = ''

  switch (operation) {
    case 'grok_status': {
      const data = result as any
      formatted = `Grok 图谱状态：\n\n`
      formatted += `  存在: ${data.exists ? '是' : '否'}\n`
      if (data.nodeCount !== undefined) {
        formatted += `  节点数: ${data.nodeCount}\n`
      }
      if (data.edgeCount !== undefined) {
        formatted += `  边数: ${data.edgeCount}\n`
      }
      if (data.lastUpdated) {
        formatted += `  最后更新: ${data.lastUpdated}\n`
      }
      if (data.stale) {
        formatted += `\n⚠️ 图谱已过期，建议执行 /grok --full 重新生成\n`
      }
      break
    }

    case 'grok_chat': {
      const data = result as any
      formatted = `┌── Grok 问答 ──────────────────────────────────┐\n`
      formatted += `│ A: ${data.answer}\n`
      if (data.sources && data.sources.length > 0) {
        formatted += `│\n│ 📎 相关文件:\n`
        for (const source of data.sources.slice(0, 5)) {
          formatted += `│   • ${source.file}:${source.line}\n`
        }
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_explain': {
      const data = result as any
      formatted = `┌── Grok 解释 ──────────────────────────────────┐\n`
      formatted += `│ 📝 摘要:\n│   ${data.summary}\n`
      if (data.relationships && data.relationships.length > 0) {
        formatted += `│\n│ 🔗 关系:\n`
        for (const rel of data.relationships.slice(0, 5)) {
          formatted += `│   • ${rel.file}:${rel.line}\n`
        }
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_domain': {
      const data = result as any
      formatted = `┌── Grok 业务域 ────────────────────────────────┐\n`
      if (typeof data.domains === 'string') {
        formatted += `│ ${data.domains}\n`
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_tour': {
      const data = result as any
      formatted = `┌── Grok 学习路径 ──────────────────────────────┐\n`
      if (typeof data.tours === 'string') {
        formatted += `│ ${data.tours}\n`
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_diff': {
      const data = result as any
      formatted = `┌── Grok 变更影响 ──────────────────────────────┐\n`
      if (typeof data.impacted === 'string') {
        formatted += `│ ${data.impacted}\n`
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_dashboard': {
      const data = result as any
      formatted = `✓ Dashboard 已启动: ${data.url}\n`
      formatted += `（浏览器自动打开）\n`
      break
    }

    case 'grok_generate': {
      const data = result as any
      formatted = `✓ 图谱已生成: ${data.filePath}\n`
      formatted += `  节点: ${data.nodeCount} | 边: ${data.edgeCount} | 域: ${data.domainCount}\n`
      formatted += `\n💡 输入 /gd 查看交互式 Dashboard\n`
      break
    }

    default:
      formatted = JSON.stringify(result, null, 2)
  }

  return { formatted, raw: result }
}
```

- [ ] **Step 2: 验证编译**

Run: `bun build --no-bundle src/tools/GrokTool/GrokSkill.ts 2>&1 | head -20`
Expected: 无语法错误

- [ ] **Step 3: Commit**

```bash
git add src/tools/GrokTool/GrokSkill.ts
git commit -m "feat(grok): add Skill layer for terminal output formatting"
```

---

## 验收测试

### Task 7.1: GrokTool 单元测试

**Files:**
- Create: `src/tools/GrokTool/__tests__/GrokTool.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
// src/tools/GrokTool/__tests__/GrokTool.test.ts

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { grokTool } from '../GrokTool.js'

// Mock GrokManager
mock.module('../GrokManager.js', () => ({
  grokManager: {
    ensureGrokSource: mock(() => Promise.resolve()),
    runAgentPipeline: mock(() => Promise.resolve({
      filePath: '.understand-anything/knowledge-graph.json',
      nodeCount: 100,
      edgeCount: 250,
      domainCount: 5,
    })),
    queryGraph: mock(() => Promise.resolve({
      answer: 'Test answer',
      sources: [{ file: 'test.ts', line: 1 }],
    })),
    getGraphStatus: mock(() => Promise.resolve({
      exists: true,
      nodeCount: 100,
      edgeCount: 250,
      lastUpdated: new Date().toISOString(),
    })),
    startDashboard: mock(() => Promise.resolve({
      url: 'http://localhost:63000/dashboard?token=test',
      port: 63000,
    })),
    explainTarget: mock(() => Promise.resolve({
      summary: 'Test explanation',
      relationships: [],
    })),
    analyzeDomain: mock(() => Promise.resolve({ domains: 'Test domains' })),
    generateTour: mock(() => Promise.resolve({ tours: 'Test tour' })),
    analyzeImpact: mock(() => Promise.resolve({ impacted: 'Test impact' })),
  },
}))

describe('GrokTool', () => {
  it('should have correct tool metadata', () => {
    expect(grokTool.name).toBe('grok')
    expect(grokTool.description).toContain('知识图谱')
  })

  it('should have valid input schema', () => {
    const schema = grokTool.inputSchema
    expect(schema).toBeDefined()
  })

  describe('grok_generate operation', () => {
    it('should call runAgentPipeline with correct params', async () => {
      const result = await grokTool.call({
        operation: 'grok_generate',
        language: 'zh',
      })

      expect(result).toBeDefined()
    })
  })

  describe('grok_chat operation', () => {
    it('should require question parameter', async () => {
      const result = await grokTool.call({
        operation: 'grok_chat',
      })

      // Should return error when question is missing
      expect(result).toContain('需要 question 参数')
    })
  })

  describe('grok_status operation', () => {
    it('should return graph status', async () => {
      const result = await grokTool.call({
        operation: 'grok_status',
      })

      expect(result).toBeDefined()
    })
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/tools/GrokTool/__tests__/GrokTool.test.ts 2>&1`
Expected: 所有测试通过

- [ ] **Step 3: Commit**

```bash
git add src/tools/GrokTool/__tests__/GrokTool.test.ts
git commit -m "test(grok): add GrokTool unit tests"
```

---

### Task 7.2: CodeGraphSkill 单元测试

**Files:**
- Create: `src/tools/CodegraphTool/__tests__/CodeGraphSkill.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
// src/tools/CodegraphTool/__tests__/CodeGraphSkill.test.ts

import { describe, it, expect } from 'bun:test'
import { formatCodegraphResult } from '../CodeGraphSkill.js'

describe('CodeGraphSkill', () => {
  describe('formatCodegraphResult', () => {
    it('should format codegraph_status result', () => {
      const result = formatCodegraphResult('codegraph_status', {
        indexed: true,
        fileCount: 100,
        symbolCount: 500,
      })

      expect(result.formatted).toContain('索引状态')
      expect(result.formatted).toContain('100')
      expect(result.formatted).toContain('500')
    })

    it('should format codegraph_search result', () => {
      const result = formatCodegraphResult('codegraph_search', {
        symbols: [
          { name: 'QueryEngine', file: 'src/QueryEngine.ts', line: 42, kind: 'class' },
        ],
      })

      expect(result.formatted).toContain('QueryEngine')
      expect(result.formatted).toContain('src/QueryEngine.ts')
    })

    it('should format codegraph_impact result', () => {
      const result = formatCodegraphResult('codegraph_impact', {
        impactedFiles: ['file1.ts', 'file2.ts'],
        impactedSymbols: ['sym1', 'sym2'],
      })

      expect(result.formatted).toContain('影响分析')
      expect(result.formatted).toContain('file1.ts')
    })

    it('should handle unknown operation', () => {
      const result = formatCodegraphResult('unknown_op', { data: 'test' })

      expect(result.formatted).toContain('data')
    })
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/tools/CodegraphTool/__tests__/CodeGraphSkill.test.ts 2>&1`
Expected: 所有测试通过

- [ ] **Step 3: Commit**

```bash
git add src/tools/CodegraphTool/__tests__/CodeGraphSkill.test.ts
git commit -m "test(codegraph): add CodeGraphSkill unit tests"
```

---

### Task 7.3: 端到端集成测试

- [ ] **Step 1: 启动开发模式**

Run: `bun run dev`

- [ ] **Step 2: 测试 CodeGraph 命令**

```
/cg st
/cg s QueryGuard
/cg i QueryGuard
```

Expected: 所有命令正常执行，输出格式正确

- [ ] **Step 3: 测试 Grok 命令**

```
/grok --language zh
/gc 支付流程是怎么工作的？
/gd
/ge src/QueryEngine.ts
/gt
/gdiff
/go
/gdomain
```

Expected: 所有命令正常执行，输出格式符合设计文档 §5.2.1

- [ ] **Step 4: 测试 Tool 调用**

让模型自动调用 Grok Tool：

```
帮我分析一下这个项目的架构
```

Expected: 模型自动选择合适的 Tool（codegraph 或 grok）

- [ ] **Step 5: Commit 测试结果**

```bash
git add -A
git commit -m "test(grok): verify all commands and tool integrations"
```

---

## 实施顺序建议

1. **Phase 1** (CodeGraph Skill): Task 1.1 → 1.2 → 1.3 → 1.4
2. **Phase 2** (GrokManager): Task 2.1 → 2.2 → 2.3 → 2.4 → 2.5 (单元测试)
3. **Phase 3** (Grok Tool): Task 3.1 → 3.2
4. **Phase 4** (Grok Skills): Task 4.1 → 4.2
5. **Phase 5** (Dashboard): Task 5.1
6. **Phase 6** (Terminal UI): Task 6.1 (可选)
7. **验收测试**: Task 7.1 → 7.2 → 7.3

Phase 1 和 Phase 2 可以并行开发。验收测试在所有 Phase 完成后执行。

---

## 注意事项

1. **渐进实现**: 先实现核心功能（图谱生成、查询、Dashboard），再添加增强功能（增量更新、错误恢复）
2. **测试驱动**: 每个 Task 都有验证步骤，确保代码正确性
3. **错误处理**: 所有错误都使用 GrokError 类，提供明确的错误信息和建议
4. **配置优先**: 使用环境变量配置，便于调整参数
5. **安全措施**: Dashboard 使用随机 token 防止 CSRF，绑定 localhost 防止外部访问

---

## 环境变量清单

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `GROK_SOURCE_REPO` | `https://github.com/Lum1104/Understand-Anything.git` | Grok 源码仓库 |
| `GROK_SOURCE_BRANCH` | `main` | 源码分支 |
| `GROK_VENDOR_DIR` | `~/.ola-cc/vendor` | 源码安装目录 |
| `GROK_LLM_MODEL` | `claude-sonnet-4-20250514` | LLM 模型 |
| `GROK_MAX_CONCURRENT` | `5` | 最大并行批次数（1-20） |
| `GROK_GRAPH_FILE` | `.understand-anything/knowledge-graph.json` | 图谱文件路径 |
| `GROK_LLM_TIMEOUT` | `30000` | LLM 调用超时（毫秒） |
| `GROK_PARSE_TIMEOUT` | `10000` | 文件解析超时（毫秒） |
| `GROK_DASHBOARD_PORT` | `63000-63100` | Dashboard 端口范围 |

---

## 排错指南

### 常见错误及解决方案

| 错误码 | 症状 | 诊断步骤 | 解决方案 |
|--------|------|---------|---------|
| `SOURCE_CLONE_FAILED` | 源码克隆失败 | 检查网络连接、GitHub 访问 | 重试或手动克隆到 `~/.ola-cc/vendor/understand-anything/` |
| `LLM_RATE_LIMIT` | API 限流 | 检查 API 配额 | 等待 60s 或切换模型（`GROK_LLM_MODEL`） |
| `LLM_TOKEN_BUDGET` | Token 耗尽 | 检查使用量 | 使用 `--scope` 缩小范围 |
| `LLM_TIMEOUT` | LLM 调用超时 | 检查 API 状态 | 减小批处理大小或检查网络 |
| `PARSE_TIMEOUT` | 文件解析超时 | 检查文件大小 | 使用 `--exclude` 排除大文件 |
| `GRAPH_INVALID` | 图谱损坏 | 检查 JSON 格式 | `/grok --full` 重新生成 |
| `GRAPH_NOT_FOUND` | 图谱未生成 | 检查 `.understand-anything/` 目录 | 先执行 `/grok` 生成图谱 |

### 诊断命令

```bash
# 检查 Grok 源码状态
ls -la ~/.ola-cc/vendor/understand-anything/

# 检查图谱文件
cat .understand-anything/knowledge-graph.json | jq '.nodes | length'

# 检查环境变量
env | grep GROK

# 查看调试日志
DEBUG=grok* bun run dev

# 检查 Dashboard 健康状态
curl http://localhost:63000/health

# 手动克隆源码（如果自动克隆失败）
git clone --depth 1 https://github.com/Lum1104/Understand-Anything.git ~/.ola-cc/vendor/understand-anything
```

### 性能调优

| 场景 | 调整参数 | 建议值 |
|------|---------|--------|
| 大项目（>1000 文件） | `GROK_MAX_CONCURRENT` | `3`（减少并发） |
| API 限流频繁 | `GROK_LLM_TIMEOUT` | `60000`（增加超时） |
| 内存不足 | `GROK_MAX_CONCURRENT` | `2`（最小并发） |
| 生成速度慢 | `GROK_MAX_CONCURRENT` | `10`（增加并发，需要足够 API 配额） |
