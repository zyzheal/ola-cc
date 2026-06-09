# Autopilot 自主执行管线设计

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: oh-my-claudecode
**Priority**: P0
**Effort**: XL

---

## 1. 概述

Autopilot 是 oh-my-claudecode 的端到端自主开发管线，从想法到可工作代码全自动化。包含**两套管线**：
- **新 Pipeline（4-stage）**：`ralplan | execution | ralph | qa`，通过 `PipelineConfig` 可配置跳过任意阶段
- **Legacy Autopilot（5-phase）**：`expansion | planning | execution | qa | validation`，旧版固定流程

新 Pipeline 是 legacy 的统一替代，通过 `DEPRECATED_MODE_ALIASES` 兼容旧的 `ultrawork`/`ultrapilot` 调用。

---

## 2. 新 Pipeline 4-Stage 管线 (P0)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/autopilot/pipeline.ts` (~556 LOC)
**Types**: `/Users/heal/oh-my-claudecode/src/hooks/autopilot/pipeline-types.ts` (~198 LOC)

### 2.1 阶段定义

```
RALPLAN (Stage 0)    → spec.md + plan.md（共识规划）
    ↓
EXECUTION (Stage 1)  → 代码变更（solo 或 team 模式）
    ↓
RALPH (Stage 2)      → 功能/安全/质量三维验证
    ↓
QA (Stage 3)         → build/lint/test 通过
    ↓
Complete / Failed / Cancelled
```

### 2.2 阶段详情

| 阶段 | ID | 子代理 | 模型策略 | 输出 | 完成信号 |
|------|-----|--------|---------|------|---------|
| RALPLAN | `ralplan` | Planner + Architect + Critic | `resolveStageModel('planning')` | `.omc/autopilot/spec.md` + `plan.md` | `PIPELINE_RALPLAN_COMPLETE` |
| EXECUTION | `execution` | executor-low/normal/high | `resolveStageModel('execution', tier)` | 代码变更 | `PIPELINE_EXECUTION_COMPLETE` |
| RALPH | `ralph` | architect + security-reviewer + code-reviewer | `resolveStageModel('verification')` | 验证报告 | `PIPELINE_RALPH_COMPLETE` |
| QA | `qa` | debugger | `resolveStageModel('qa')` | 修复循环 | `PIPELINE_QA_COMPLETE` |

**模型选择策略**：不写死模型名，通过 `resolveStageModel()` 动态选择，复用 `getAgentModel()` 基础设施：

```typescript
import { getAgentModel } from '../../utils/model/agent.js'

/** 阶段默认模型映射（可被 PipelineConfig.stageModels 覆盖） */
const STAGE_DEFAULT_MODELS: Record<PipelineRole, ModelAlias> = {
  planning: 'opus',      // 规划阶段需要强推理
  execution: 'sonnet',   // 执行阶段平衡速度与质量
  verification: 'sonnet', // 验证阶段中等推理
  qa: 'haiku',           // QA 阶段轻量检查
  'fix-deep': 'opus',    // 深度修复需要强推理
}

/** 三级执行分层（仅 Execution 阶段使用） */
const TIER_MODELS: Record<ExecutionTier, ModelAlias> = {
  low: 'haiku',    // 简单文件操作、格式化
  normal: 'sonnet', // 常规功能实现
  high: 'opus',    // 架构变更、复杂逻辑
}

/**
 * 动态解析阶段模型。
 * 优先级：PipelineConfig.stageModels > 环境变量 > 默认映射 > getAgentModel(inherit)
 *
 * 关键：非 Claude 模型（qwen/llama/gemini）时，getAgentModel() 已有保护逻辑
 * （L84: parentCanonical 不含 'claude' → inherit parent），无需额外处理。
 */
function resolveStageModel(
  role: PipelineRole,
  tier?: ExecutionTier,
  config?: PipelineConfig,
  parentModel?: string,
): string {
  // 1. 用户显式配置优先
  const userOverride = config?.stageModels?.[role]
  if (userOverride) return userOverride

  // 2. 环境变量覆盖
  const envKey = `OLA_CC_AUTOPILOT_MODEL_${role.toUpperCase().replace('-', '_')}`
  if (process.env[envKey]) return process.env[envKey]!

  // 3. 默认映射（tier 分层仅 execution 阶段）
  const defaultAlias = tier ? TIER_MODELS[tier] : STAGE_DEFAULT_MODELS[role]

  // 4. 通过 getAgentModel 解析（处理 Bedrock 前缀、非 Claude 模型继承等）
  return getAgentModel(undefined, parentModel ?? getRuntimeMainLoopModel(), defaultAlias)
}
```

**设计理由**：
1. **非 Claude 模型兼容**：`getAgentModel()` L84 已有保护——当 parent 是 qwen/llama 时，所有 Claude alias 会自动 inherit parent，不会尝试调用不支持的模型
2. **Bedrock 区域继承**：`getAgentModel()` 已处理跨区域推理前缀（L50-67），子 agent 自动继承 parent 的区域
3. **用户可覆盖**：通过 `PipelineConfig.stageModels` 或 `OLA_CC_AUTOPILOT_MODEL_*` 环境变量，用户可自定义任何阶段的模型
4. **成本控制**：用户可将所有阶段设为 sonnet 以降低成本，或设为 inherit 以使用当前会话模型

**注意**：完成信号格式为 `PIPELINE_<STAGE>_COMPLETE`（非 legacy 的 `<STAGE>_COMPLETE`）。

### 2.3 Prompt-Driven Orchestration

每个阶段的 prompt 内嵌 `Task()` 调用指令，让主 agent 按指令 spawn 子 agent：

```typescript
// RALPLAN 阶段示例（consensus planning 模式）
const prompt = `
## PIPELINE STAGE: RALPLAN (Consensus Planning)
Your task: Expand the idea into a detailed spec and implementation plan using consensus-driven planning.

### Part 1: Idea Expansion (Spec Creation)
${getExpansionPrompt(context.idea)}

### Part 2: Consensus Planning
Use the /oh-my-claudecode:ralplan skill to create a consensus-driven implementation plan.

Signal: PIPELINE_RALPLAN_COMPLETE
`
```

### 2.4 三级 Agent 分层（Execution 阶段）

| 层级 | 模型 | 适用任务 |
|------|------|---------|
| executor-low | haiku | 简单文件操作、格式化 |
| executor | sonnet | 常规功能实现 |
| executor-high | opus | 架构变更、复杂逻辑 |

### 2.5 RALPH 三维度验证

RALPH 阶段（Stage 2）执行迭代验证，spawn 并行验证 reviewer：

| 维度 | 子代理 | 检查内容 |
|------|--------|---------|
| functional | `oh-my-claudecode:architect` | 功能完整性、需求覆盖、验收标准 |
| security | `oh-my-claudecode:security-reviewer` | OWASP Top 10、输入验证、注入漏洞 |
| quality | `oh-my-claudecode:code-reviewer` | 代码组织、设计模式、测试覆盖 |

全部 APPROVED → 进入 QA，任一 REJECTED → 修复后重试（最多 `maxIterations` 轮，默认 100）。

**配置方式**：通过 `PipelineConfig.verification` 控制：
```typescript
verification: { engine: 'ralph', maxIterations: 100 }  // 启用
verification: false                                       // 跳过 RALPH 阶段
```

### 2.6 状态持久化

```typescript
// Pipeline 阶段 ID（4-stage）
type PipelineStageId = 'ralplan' | 'execution' | 'ralph' | 'qa'
type PipelinePhase = PipelineStageId | 'complete' | 'failed' | 'cancelled'
type StageStatus = 'pending' | 'active' | 'complete' | 'failed' | 'skipped'

// 每个 stage 的状态
interface PipelineStageState {
  id: PipelineStageId
  status: StageStatus
  startedAt?: string
  completedAt?: string
  iterations: number
  error?: string
}

// Pipeline 追踪状态（嵌入 AutopilotState.pipeline）
interface PipelineTracking {
  pipelineConfig: PipelineConfig
  stages: PipelineStageState[]       // 4 个 stage 的有序列表
  currentStageIndex: number           // 当前活跃 stage 的索引
}

// Pipeline 配置
interface PipelineConfig {
  planning: 'ralplan' | 'direct' | false   // false = 跳过 RALPLAN
  execution: 'team' | 'solo'               // team = 多 worker 并行
  verification: { engine: 'ralph'; maxIterations: number } | false  // false = 跳过 RALPH
  qa: boolean                              // false = 跳过 QA
}
```

存储路径：`.omc/autopilot/state.json`（PipelineTracking 嵌入 `state.pipeline` 字段）

**Stage 执行顺序常量**：`STAGE_ORDER = ['ralplan', 'execution', 'ralph', 'qa']`

### 2.7 状态转换

`advanceStage()` 函数管理阶段转换：
1. 标记当前 stage 为 `complete`，记录 `completedAt` 时间戳
2. 调用当前 adapter 的 `onExit()` 钩子（如果存在）
3. 查找下一个非 skipped 的 stage
4. 如果无更多 stage → 返回 `{ adapter: null, phase: 'complete' }`
5. 标记下一个 stage 为 `active`，记录 `startedAt`
6. 调用下一个 adapter 的 `onEnter()` 钩子（如果存在）
7. 持久化 PipelineTracking 到磁盘

RALPH → QA 转换由 `advanceStage()` 自动处理（无需手动回滚机制）。

### 2.8 可靠性保障

Prompt-driven orchestration 的可靠性通过以下机制保证：

| 机制 | 说明 |
|------|------|
| 完成信号检测 | 每阶段 prompt 要求 LLM 输出 `PIPELINE_RALPLAN_COMPLETE` 等标记，orchestrator 用正则匹配检测完成状态 |
| 超时机制 | 每阶段设置 `maxTurns` 限制（默认 30 轮），超时强制终止并标记失败 |
| 降级策略 | LLM 未按指令执行时（如未输出完成信号），orchestrator 检测异常并重试当前阶段（最多 3 次） |
| Code-driven 状态转换 | 状态转换由 orchestrator 代码控制（`pipeline.ts` 中的 `advanceStage()`），LLM 仅负责任务执行，不控制流程跳转 |

**重试失败处理**：当 3 次重试均失败后，orchestrator 执行以下步骤：
1. 标记当前 phase 为 `failed`
2. 保存错误信息到 `AutopilotState.error` 字段
3. 通知用户失败原因
4. 允许用户通过 `/autopilot resume` 手动恢复

设计原则：**code 控制流程，prompt 驱动执行**。状态机转换、超时、回滚等关键逻辑全部由 TypeScript 代码实现，LLM 仅负责各阶段内的具体任务执行。

### 2.9 Integration — 文件路径与 LOC 估算

| File | Operation | LOC |
|------|-----------|-----|
| `src/hooks/autopilot/pipeline.ts` | **New** — 核心编排器，4-stage 状态机 + advanceStage/signal 检测 | ~556 |
| `src/hooks/autopilot/pipeline-types.ts` | **New** — 类型定义（PipelineStageId, PipelineConfig, PipelineTracking, StageAdapter 接口） | ~198 |
| `src/hooks/autopilot/adapters/ralplan-adapter.ts` | **New** — RALPLAN 阶段适配器（共识规划） | ~93 |
| `src/hooks/autopilot/adapters/execution-adapter.ts` | **New** — EXECUTION 阶段适配器（含 team/solo 模式） | ~131 |
| `src/hooks/autopilot/adapters/ralph-adapter.ts` | **New** — RALPH 阶段适配器（三维度验证） | ~110 |
| `src/hooks/autopilot/adapters/qa-adapter.ts` | **New** — QA 阶段适配器（build/lint/test 循环） | ~38 |
| `src/hooks/autopilot/prompts.ts` | **New** — 阶段 prompt 模板 | ~200 |
| `src/commands/autopilot.ts` | **New** — /autopilot 命令入口 | ~80 |
| **合计** | **8 个新文件** | **~1406** |

改造难度：**XL**（整体）、**L**（pipeline + 2 adapters）、**M**（剩余 2 adapters + prompts）、**M**（integration）。

### 2.10 Feature Flags 汇总

所有功能默认关闭，通过 feature flag 控制。

| Flag 名称 | 默认 | 控制模块 | 降级策略 |
|-----------|------|---------|---------|
| `AUTOPILOT_PIPELINE` | off | Autopilot 4-stage 管线（Section 2） | 不加载 pipeline 状态机和 4 个 adapter，现有 AgentTool 和 Goal 系统行为不变，用户通过 `/goal` 手动驱动开发流程 |
| `BOULDER_STATE` | off | Boulder State 计划追踪（Section 3） | 不加载 boulder-state 模块，Autopilot 跳过计划进度追踪，各阶段独立运行不依赖 checkbox 进度，Goal 系统进度追踪不受影响 |
| `CONTINUATION_ENFORCEMENT` | off | Continuation Enforcement 执行强制（Section 4） | 不加载 continuation 模块，`Stop` 事件不受拦截，LLM 可自由停止执行，System Prompt 不注入强制哲学，用户需手动管理任务完成状态 |

**依赖关系**：`AUTOPILOT_PIPELINE` 是主开关；`BOULDER_STATE` 和 `CONTINUATION_ENFORCEMENT` 可独立启用，但推荐在 `AUTOPILOT_PIPELINE` 启用后配合使用。

**向后兼容保证**：三个 flag 全部默认关闭，启用前不影响现有 AgentTool、Goal 系统和 query 流程的任何行为。

---

## 3. Boulder State 计划追踪 (P1)

**Source**: `/Users/heal/oh-my-claudecode/src/features/boulder-state/` (3 files, 215+55 LOC)

### 3.1 核心接口

```typescript
interface BoulderState {
  active_plan: string       // 活跃计划文件绝对路径
  started_at: string        // ISO 时间戳
  session_ids: string[]     // 参与此计划的 session 列表
  plan_name: string         // 从文件名派生
  active: boolean
  updatedAt: string         // 过期检测
  metadata?: Record<string, unknown>
}

interface PlanProgress {
  total: number
  completed: number
  isComplete: boolean
}
```

### 3.2 核心功能

| 函数 | 功能 |
|------|------|
| `readBoulderState()` | 从 `.omc/boulder/boulder.json` 读取 |
| `writeBoulderState()` | 原子写入（tmp + rename） |
| `appendSessionId()` | 带文件锁的并发安全追加 |
| `getPlanProgress()` | 解析 markdown checkbox 进度 |
| `findPlannerPlans()` | 扫描 `.omc/plans/` 下的计划文件 |
| `getPlanSummaries()` | 返回所有计划摘要 |

### 3.3 Markdown Checkbox 进度解析

```typescript
const uncheckedMatches = content.match(/^[-*]\s*\[\s*\]/gm) || []
const checkedMatches = content.match(/^[-*]\s*\[[xX]\]/gm) || []
```

### 3.4 并发安全

`appendSessionId()` 使用 `withFileLockSync` 保证多进程并发安全。

### 3.5 Integration

| File | Operation | LOC |
|------|-----------|-----|
| `src/services/boulder-state/boulderState.ts` | **New** — 核心读写 + 并发锁 | ~120 |
| `src/services/boulder-state/planProgress.ts` | **New** — markdown checkbox 解析 | ~60 |
| `src/services/boulder-state/types.ts` | **New** — BoulderState / PlanProgress 类型 | ~35 |
| `src/services/autopilot/` | Modify — 集成计划追踪 | ~40 |

### 3.6 Feature Flag

通过 `BOULDER_STATE` feature flag 控制，默认关闭。

**降级策略**：禁用时 Boulder State 模块不加载，Autopilot Pipeline 跳过计划进度追踪，各阶段独立运行不依赖 checkbox 进度。现有 Goal 系统的进度追踪不受影响。

---

## 4. Continuation Enforcement 执行强制 (P1)

**Source**: `/Users/heal/oh-my-claudecode/src/features/continuation-enforcement.ts` (197 LOC)

### 4.1 双重机制

1. **Hook 拦截**：监听 `Stop` 事件，检查未完成任务，阻止停止
2. **System Prompt 注入**：初始化时注入 "THE BOULDER NEVER STOPS" 哲学

### 4.2 提醒消息

5 条递进强度的随机提醒，避免 LLM 适应：
```
[SYSTEM REMINDER - TODO CONTINUATION] — 最温和
...
[THE BOULDER NEVER STOPS] — 最强烈
```

### 4.3 完成检测

```typescript
interface CompletionSignal {
  claimed: boolean    // 是否声明完成
  confidence: number  // 置信度
  reason: string      // 原因
}
```

检测模式：
- 完成：`all tasks are complete`, `I've completed everything` 等
- 不确定：`should be`, `I think`, `probably` 等

### 4.4 停止条件

- 100% 完成
- 用户覆盖（`/cancel`）
- 干净退出

### 4.5 Integration

| File | Operation | LOC |
|------|-----------|-----|
| `src/services/continuation/continuationEnforcement.ts` | **New** — Hook 拦截 + 完成检测 | ~130 |
| `src/services/continuation/types.ts` | **New** — CompletionSignal / ReminderConfig 类型 | ~67 |
| `src/query/stopHooks.ts` | Modify — 添加 continuation 检查 | ~30 |

### 4.6 Feature Flag

通过 `CONTINUATION_ENFORCEMENT` feature flag 控制，默认关闭。

**降级策略**：禁用时 Continuation Enforcement 模块不加载，`Stop` 事件不受拦截，LLM 可自由停止执行。System Prompt 不注入 "THE BOULDER NEVER STOPS" 哲学。用户需手动管理任务完成状态。

---

## 5. Execution Stage 并发模式 (P1)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/autopilot/adapters/execution-adapter.ts`

### 5.1 双模式设计

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| `solo` | 默认 | 单 worker 串行执行所有任务 |
| `team` | plan 中有独立任务 | 多 worker 并行执行，每个 worker 是独立 agent |

### 5.2 独立性检测

```typescript
// execution-adapter.ts:46-51
function detectIndependentTasks(plan: Plan): Task[][] {
  // 分析任务依赖图
  // 无依赖的任务分为一组，可并行执行
  // 有依赖的任务按拓扑排序串行执行
}
```

### 5.3 Worker 管理

- 每个 worker 是独立的 agent 实例
- worker 共享同一份 plan 但各自负责不同任务
- worker 完成后汇总结果到主 orchestrator
- 失败的 worker 不阻塞其他 worker，由 orchestrator 决定重试或跳过

**并发决策逻辑**：
```typescript
const maxWorkers = Math.min(availableTasks.length, 3)  // 最多 3 个并行 worker
```

失败 worker 的任务标记为 `pending`（非 `failed`），由 orchestrator 决定是否重试或降级为串行执行。

### 5.4 Integration

| File | Operation |
|------|-----------|
| `src/services/autopilot/adapters/execution-adapter.ts` | **New** |
| `src/services/autopilot/pipeline.ts` | Modify — 支持 team 模式调度 |

---

## 6. 架构师视角

### 6.1 设计模式

| 模式 | 应用 |
|------|------|
| Pipeline Stage Adapter | 4 个 adapter 统一接口（id/name/completionSignal/shouldSkip/getPrompt） |
| Prompt-driven orchestration | prompt 内嵌 Task() 调用 |
| 可配置管线 | PipelineConfig 控制跳过任意阶段 |
| 原子写入 + 文件锁 | 多进程并发安全 |
| Deprecated mode 兼容 | ultrawork/ultrapilot → autopilot + config override |

### 6.2 ola-cc 适配

ola-cc 已有 Goal 系统和 AgentTool，可复用：

| ola-cc 组件 | 角色 | 说明 |
|-------------|------|------|
| Goal 系统 | 顶层目标编排器 | ReAct 循环 + 三层熔断，负责"做什么"——管理整体目标生命周期 |
| Boulder State | 计划级进度追踪 | markdown checkbox 解析，负责"做到哪了"——追踪计划文件中各步骤的完成状态 |
| AgentTool | 子代理调度 | 替代 Task() 调用，spawn 子 agent 执行各阶段任务 |
| EvolutionEngine | 质量门控 | 替代 RALPH 的三维度验证，提供 AND 门控 + 评分 |

**Goal 系统与 Boulder State 是互补关系，不是替代关系：**
- Goal 系统决定"做什么"（目标设定、ReAct 循环、熔断保护）
- Boulder State 追踪"做到哪了"（计划文件中的 checkbox 进度）
- 集成方式：Goal 系统调用 Autopilot Pipeline，Pipeline 内部使用 Boulder State 追踪各阶段计划进度

需要新增：
- 4-stage 状态机编排（`pipeline.ts`）— 统一 autopilot/ultrawork/ultrapilot
- Adapter 适配层（4 个阶段适配器：ralplan/execution/ralph/qa）
- Prompt 模板系统（`prompts.ts`）
- PipelineConfig 可配置跳过任意阶段

---

## 7. 产品经理视角

### 7.1 用户旅程

```
用户: "实现一个用户认证系统"
    ↓
RALPLAN (Stage 0): 共识规划，生成 spec.md + plan.md
    ↓
EXECUTION (Stage 1): solo/team 模式执行代码变更
    ↓
RALPH (Stage 2): 功能/安全/质量三维验证（最多 100 轮迭代）
    ↓
QA (Stage 3): build/lint/test 循环修复
    ↓
输出: 可工作的代码 + 测试 + 文档
```

### 7.2 竞品对比

| 能力 | OMC Autopilot | Devin | Cursor Agent |
|------|--------------|-------|-------------|
| 端到端自动化 | ✅ 4-stage pipeline | ✅ | ❌ 需手动 |
| 质量门控 | ✅ RALPH 三维度验证 | ❌ | ❌ |
| 状态恢复 | ✅ 跨会话 | ❌ | ❌ |
| 执行强制 | ✅ Continuation | ❌ | ❌ |
| 可配置管线 | ✅ PipelineConfig 跳过任意阶段 | ❌ | ❌ |

---

## 8. 算法工程师视角

### 8.1 成本优化

- 三级 agent 分层：简单任务用 haiku，复杂任务用 opus
- Cache 共享：子代理复用父对话 prompt cache
- 最大重试限制：QA 最大循环数，Validation 最多 3 轮

### 8.2 可靠性设计

- 状态持久化：支持跨会话恢复
- 回滚机制：状态转换失败自动恢复
- 文件锁：多进程并发安全
- 互斥模式：防止多个管线同时运行

---

## 9. 实施路线图

| Phase | 功能 | 优先级 | 依赖 |
|-------|------|--------|------|
| Phase 1 | Pipeline 状态机 + RALPLAN + EXECUTION adapters | P0 | AgentTool |
| Phase 2 | RALPH + QA adapters | P0 | Phase 1 |
| Phase 3 | PipelineConfig 可配置 + deprecated mode 兼容 | P0 | Phase 2 |
| Phase 4 | Boulder State | P1 | Phase 1 |
| Phase 5 | Continuation Enforcement | P1 | Phase 1 |
