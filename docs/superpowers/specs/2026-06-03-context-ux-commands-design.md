# 上下文管理与用户命令设计

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: claude-code + openclaude
**Priority**: P1/P2
**Effort**: M-L

---

## 1. 概述

上下文管理与用户命令覆盖：Knowledge Graph + Conversation Arc、Context Visualization、Context Collapse、Session Tagging、Fast Mode、Effort Control、Scheduled Triggers、Side Question、Fork Subagent、Deep Link Protocol、Shell Completion。

---

## 2. Knowledge Graph + Conversation Arc (P0)

**Source**: `/Users/heal/openclaude/src/utils/knowledgeGraph.ts` + `conversationArc.ts`

### 2.1 Knowledge Graph

实体-关系-语义摘要知识图谱，使用 Orama 全文搜索引擎。

#### Orama 集成配置

```typescript
interface KnowledgeGraphConfig {
  engine: 'orama'              // 全文搜索引擎
  maxNodes: number             // 最大节点数（默认 10000）
  indexFields: string[]        // 索引字段 ['content', 'title', 'tags']
  persistPath: string          // 持久化路径 ~/.claude/knowledge-graph/
  autoIndex: boolean           // 自动索引新会话（默认 true）
}
```

**Orama 选型理由**：
- 零依赖、纯 JavaScript 全文搜索引擎，~100KB gzip
- 内置 BM25 排序 + 向量相似度搜索
- 支持磁盘持久化（`@orama/orama` 的 `persistToFile`）
- 比 MiniSearch 更适合结构化文档（支持嵌套字段索引）

**索引策略**：
- 每个 KnowledgeNode 作为一个 Orama document
- `content` 字段存储 `name + summary` 拼接
- `tags` 字段存储 `type` + 关系类型
- 查询时使用 Orama 的 `search()` 做全文匹配，再通过 `relations` 做图遍历扩展

```typescript
interface KnowledgeNode {
  id: string
  type: 'entity' | 'concept' | 'file' | 'function'
  name: string
  summary: string
  relations: Relation[]
}

interface Relation {
  type: 'depends_on' | 'extends' | 'implements' | 'uses' | 'related_to'
  source: string  // node ID
  target: string  // node ID
  weight: number  // 0-1, 关联强度
}
```

### 2.2 Conversation Arc

跟踪会话目标、决策、里程碑，会话结束时自动提取持久化记忆。

```typescript
interface ConversationArc {
  goals: Goal[]
  decisions: Decision[]
  milestones: Milestone[]
  extractedMemories: Memory[]
}
```

### 2.3 Integration

| File | Operation |
|------|-----------|
| `src/services/knowledge-graph/` | **New** — Orama 引擎 |
| `src/services/conversation-arc/` | **New** — Arc 跟踪 |
| `src/query/stopHooks.ts` | Modify — 会话结束时提取记忆 |

---

## 3. Context Visualization (P1)

**Source**: `/Users/heal/claude-code/src/commands/context/context.tsx`

### 3.1 核心功能

显示 token 使用分布的可视化分析：
- system prompt 占用
- tools 占用
- messages 占用
- autocompact buffer 占用
- 上下文优化建议

### 3.2 输出示例

```
Context Usage:
  System Prompt:  12,450 tokens (15%)
  Tools:           8,200 tokens (10%)
  Messages:       52,000 tokens (65%)
  Auto-Compact:    8,000 tokens (10%)
  Total:          80,650 / 200,000 tokens (40%)

Suggestions:
  - Consider /compact to reduce message history
  - 3 tools are unused and can be deferred
```

### 3.3 Integration

| File | Operation |
|------|-----------|
| `src/commands/context/` | **New** |
| `src/components/ContextVisualization.tsx` | **Extend** — 已有 `src/components/ContextVisualization.tsx`，需增强交互功能 |

---

## 4. Context Collapse (P1)

**Source**: `/Users/heal/claude-code/src/services/contextCollapse/operations.ts`

### 4.1 核心机制

将旧对话 span 摘要压缩为占位符，`/context` 可视化中显示折叠状态和健康度。

```typescript
interface CollapseConfig {
  threshold: number            // 触发折叠的消息数（默认 50）
  summaryModel: string         // 摘要模型
  maxSummaryTokens: number     // 摘要最大 token（默认 500）
  preserveRecent: number       // 保留最近 N 条消息（默认 10）
}
```

**与 compact 系统的关系**：互补而非替代。compact 压缩整个对话上下文（全量缩减 token），Context Collapse 仅折叠旧对话 span 为摘要占位符，保留结构信息（如工具调用链、决策节点）。两者可叠加使用：先 Context Collapse 折叠旧 span，再 compact 压缩整体上下文。

**与 performance-optimization-design.md 的 Context Partitioning 互补**：Collapse 处理摘要生成，Partitioning 处理优先级裁剪。

### 4.2 Integration

| File | Operation |
|------|-----------|
| `src/services/contextCollapse/` | **New** |
| `src/services/compact/compact.ts` | Modify — 集成折叠策略 |

---

## 5. Session Tagging (P2)

**Source**: `/Users/heal/claude-code/src/commands/tag/tag.tsx`

### 5.1 核心功能

为会话添加标签用于搜索和组织，支持 Unicode 清理防注入。

```typescript
interface SessionTag {
  name: string
  color: string                // hex color
  autoApply: boolean           // 自动标签（基于内容分析）
  rules?: TagRule[]
}

interface TagRule {
  pattern: string              // 正则模式
  tag: string                  // 标签名
}
```

### 5.2 Integration

| File | Operation |
|------|-----------|
| `src/commands/tag/` | **New** |

---

## 6. Fast Mode (P1)

**Source**: `/Users/heal/claude-code/src/commands/fast/fast.tsx`

### 6.1 核心功能

一键切换到更快的模型（如 haiku），有冷却期机制防止频繁切换。

```typescript
interface FastModeConfig {
  cooldownMs: number           // 冷却期，默认 5000
  model: string                // 快速模型 ID
  maxTokens: number            // 快速模式 token 限制
  autoSwitch: boolean          // 自动切换（默认 true）
}
```

### 6.2 Integration

| File | Operation |
|------|-----------|
| `src/commands/fast/` | **New** |
| `src/utils/fastMode.ts` | **New** |

---

## 7. Effort Level Control (P1)

**Source**: `/Users/heal/claude-code/src/commands/effort/effort.tsx`

### 7.1 核心功能

控制模型思考深度（low/medium/high），支持环境变量覆盖，持久化到用户设置。

```typescript
type EffortLevel = 'low' | 'medium' | 'high'

interface EffortControlConfig {
  defaultLevel: EffortLevel    // 默认 effort 级别
  persistAcrossSessions: boolean // 跨会话持久化
  autoUpgrade: boolean         // 自动升级（复杂任务时）
}
```

### 7.2 Integration

| File | Operation |
|------|-----------|
| `src/commands/effort/` | **New** |
| `src/utils/effort.ts` | **New** |

---

## 8. Scheduled Triggers (P1)

**Source**: `/Users/heal/claude-code/src/commands/schedule/ScheduleView.tsx`

### 8.1 核心功能

基于 cron 的定时任务调度：创建、管理、启用/禁用定时触发器，支持 agent 绑定。

```typescript
interface ScheduledTrigger {
  id: string
  cron: string                 // cron 表达式
  command: string              // 要执行的命令
  enabled: boolean
  lastRun?: string             // ISO 时间戳
  nextRun?: string
}
```

#### Cron 引擎选型：croner

使用 [`croner`](https://github.com/hexagon/croner) 库作为 cron 解析和调度引擎：

**选型理由**：
- 零依赖、轻量级（~15KB gzip）
- 完整 cron 表达式支持（含 `L`、`W`、`#` 等扩展语法）
- 内置时区支持（`tz` 参数，基于 IANA 时区数据库）
- `CronJob.nextRun()` 预计算下次执行时间，用于 UI 展示
- 无需外部 daemon 进程，随 ola-cc CLI 进程运行

**运行模式**：
- daemon 模式下：`CronJob` 实例随 CLI 进程常驻，`setTimeout` 驱动调度
- 非 daemon 模式：触发器配置持久化到 `~/.claude/scheduled-triggers.json`，下次启动时恢复
- 进程退出时：通过 `process.on('SIGINT'/'SIGTERM')` 优雅停止所有 CronJob

```typescript
import { Cron } from 'croner'

function createTrigger(trigger: ScheduledTrigger): Cron {
  const job = new Cron(trigger.cron, { tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, () => {
    executeTriggerCommand(trigger)
    trigger.lastRun = new Date().toISOString()
    trigger.nextRun = job.nextRun()?.toISOString()
    persistTriggers()
  })
  return job
}
```

### 8.2 Integration

| File | Operation |
|------|-----------|
| `src/commands/schedule/` | **New** |
| `src/services/scheduler/` | **New** — cron 引擎 |

---

## 9. Side Question /btw (P2)

**Source**: `/Users/heal/claude-code/src/commands/btw/btw.tsx`

### 9.1 核心功能

在不中断当前对话的情况下提问侧面问题。fork 上下文，独立运行，结果可选注入回主对话。

```typescript
interface SideQuestionConfig {
  maxTokens: number            // 独立查询 token 限制（默认 1024）
  injectResult: boolean        // 是否注入回主对话
  timeout: number              // 超时 ms（默认 30000）
}
```

### 9.2 Integration

| File | Operation |
|------|-----------|
| `src/commands/btw/` | **New** |

---

## 10. Fork Subagent /fork (P2)

**Source**: `/Users/heal/claude-code/src/commands/fork/fork.tsx`

### 10.1 核心功能

从当前对话分叉独立子 agent 执行并行任务。继承父会话上下文 + system prompt + 模型。

复用现有 AgentTool 的 fork 执行模式（`src/tools/AgentTool/AgentTool.tsx` 中的 async path），`/fork` 命令是 AgentTool fork 的用户友好入口。

### 10.2 Integration

| File | Operation |
|------|-----------|
| `src/commands/fork/` | **New** |

---

## 11. Deep Link Protocol (P2)

**Source**: `/Users/heal/openclaude/src/utils/deepLink/parseDeepLink.ts`

### 11.1 核心功能

URI 协议处理器：`claude-cli://open?q=...&repo=...&cwd=...`。支持从浏览器/编辑器直接启动并预填 prompt。

### 11.2 Integration

| File | Operation |
|------|-----------|
| `src/utils/deepLink/` | **New** |
| `src/entrypoints/cli.tsx` | Modify — 添加 URI 处理 |

---

## 12. Shell Completion (P2)

**Source**: `/Users/heal/openclaude/src/utils/bash/shellCompletion.ts`

### 12.1 核心功能

Bash 输入的 Tab 补全：命令、变量（$开头）、文件路径。使用 shell quote 解析 + 超时控制。

### 12.2 Integration

| File | Operation |
|------|-----------|
| `src/utils/bash/shellCompletion.ts` | **New** |

---

## 13. 架构师视角

### 13.1 分层架构

```
命令层:    /context → /tag → /fast → /effort → /schedule → /btw → /fork
服务层:    Knowledge Graph → Context Collapse → Scheduler
工具层:    Shell Completion → Deep Link
```

### 13.2 ola-cc 适配

- Context Visualization：ola-cc 已有 compact 进度条，可扩展为完整可视化
- Fast Mode：ola-cc 已有 model override，可添加快捷切换
- Effort Control：ola-cc 已有 effort 系统，可添加 /effort 命令
- Knowledge Graph：可与现有 memory 系统集成

---

## 14. 产品经理视角

### 14.1 用户价值

| 功能 | 解决的痛点 | 频率 | 影响 |
|------|-----------|------|------|
| Context Visualization | "不知道 token 用在哪" | 每会话 | 高 |
| Fast Mode | "想快速得到简单回答" | 每日 | 中 |
| Effort Control | "复杂任务需要更深思考" | 每日 | 中 |
| Scheduled Triggers | "想定时执行任务" | 每周 | 中 |
| Side Question | "想问个问题但不想打断" | 每日 | 中 |
| Knowledge Graph | "跨会话知识不连贯" | 每会话 | 高 |
| Deep Link | "想从浏览器直接启动" | 偶发 | 低 |

---

## 15. Feature Flags

所有功能默认关闭，通过环境变量激活。

| Flag 名称 | 默认 | 功能模块 | 降级策略 |
|-----------|------|---------|---------|
| `OLA_CC_KNOWLEDGE_GRAPH` | off | Knowledge Graph + Conversation Arc | 不构建知识图谱，跨会话查询不可用 |
| `OLA_CC_CONTEXT_VISUALIZATION` | off | Context Visualization | `/context` 命令不可用，token 用量不可见 |
| `OLA_CC_CONTEXT_COLLAPSE` | off | Context Collapse | 不折叠旧对话 span，上下文可能更快耗尽 |
| `OLA_CC_SESSION_TAGGING` | off | Session Tagging | `/tag` 命令不可用 |
| `OLA_CC_FAST_MODE` | off | Fast Mode | `/fast` 命令不可用 |
| `OLA_CC_EFFORT_CONTROL` | off | Effort Level Control | `/effort` 命令不可用，使用默认 effort |
| `OLA_CC_SCHEDULED_TRIGGERS` | off | Scheduled Triggers | `/schedule` 命令不可用，无定时任务 |
| `OLA_CC_SIDE_QUESTION` | off | Side Question | `/btw` 命令不可用 |
| `OLA_CC_FORK_SUBAGENT` | off | Fork Subagent | `/fork` 命令不可用 |
| `OLA_CC_DEEP_LINK` | off | Deep Link Protocol | `claude-cli://` URI 不被处理 |
| `OLA_CC_SHELL_COMPLETION` | off | Shell Completion | 无 Tab 补全支持 |

**命名规范**: 所有 feature flag 统一使用 `OLA_CC_` 前缀，小写下划线风格。

---

## 16. 实施路线图

| Phase | 功能 | 优先级 | 依赖 |
|-------|------|--------|------|
| Phase 1 | Knowledge Graph + Conversation Arc + Context Visualization + Fast Mode + Effort Control | P0/P1 | Orama |
| Phase 2 | Scheduled Triggers + Session Tagging | P1/P2 | cron 引擎 |
| Phase 3 | Side Question + Fork + Deep Link + Shell Completion | P2 | AgentTool |

---

## 17. LOC 估算总表

| # | 功能 | 新增文件 | LOC 估算 | 修改文件 | 难度 |
|---|------|---------|---------|---------|------|
| 1 | Knowledge Graph + Conversation Arc | `knowledge-graph/` + `conversation-arc/` (4 files) | ~600 | `stopHooks.ts` ~40 | High |
| 2 | Context Visualization | `context.tsx` | ~200 | `ContextVisualization.tsx` ~100 | Medium |
| 3 | Context Collapse | `contextCollapse/operations.ts` | ~280 | `compact.ts` ~30 | Medium |
| 4 | Session Tagging | `tag/tag.tsx` | ~180 | — | Low |
| 5 | Fast Mode | `fast/fast.tsx` + `fastMode.ts` | ~200 | — | Low |
| 6 | Effort Level Control | `effort/effort.tsx` + `effort.ts` | ~220 | — | Low |
| 7 | Scheduled Triggers | `schedule/ScheduleView.tsx` + `scheduler/` (3 files) | ~400 | — | Medium |
| 8 | Side Question | `btw/btw.tsx` | ~150 | — | Low |
| 9 | Fork Subagent | `fork/fork.tsx` | ~120 | — | Low |
| 10 | Deep Link Protocol | `deepLink/parseDeepLink.ts` | ~160 | `cli.tsx` ~30 | Medium |
| 11 | Shell Completion | `shellCompletion.ts` | ~180 | — | Medium |
| | **合计** | 16+ 新文件 | **~2,690** | 3 修改文件 **~200** | |

**总计**: ~2,890 LOC 新增/修改
