# Goal Quality-Gated Single Loop 设计文档

> 日期: 2026-05-29
> 状态: Draft v1（整合版）
> 来源: goal-react-orchestrator-design.md (v3) + goal-redesign-ecc-fusion.md + hermes-everos-evolution-enhancement-plan.md (v1.4)
> 作者: heal + AI 协作

## 1. 问题陈述

当前 `/goal` 命令存在以下问题：

1. **任务完成率低**：只完成部分任务就停止，不会自动推进到下一个任务
2. **技能利用不足**：本地有 325+ 技能，但 goal 执行中仅被动使用少数几个
3. **缺乏代码分析工具集成**：CodeGraph（实时代码知识图谱）和 Grok（深度语义理解）未被主动利用
4. **单轮执行**：每个任务只执行一轮，没有多轮分析-修复-验证循环
5. **场景单一**：仅适配代码变更场景，不支持设计文档、问题排查、设计改进、重构等
6. **无降级策略**：工具不可用时直接失败
7. **新技能无法自动发现**：手动添加的技能不会自动进入 goal 流程
8. **缺少质量门控**：无确定性检查，依赖模型自评（不可靠）

## 2. 设计目标

| 目标 | 衡量标准 |
|------|---------|
| 任务全完成 | `/goal` 创建的所有任务 100% 完成或明确暂停 |
| 技能全覆盖 | 325+ 技能按场景被智能选用 |
| 工具深度集成 | CodeGraph + Grok 在 ANALYZE/REVIEW 阶段主动调用 |
| 多轮收敛 | 每个任务最多 N 轮 ReAct，3 维收敛检测 |
| 多场景支持 | 5 种场景各有优化的 ReAct 配置 |
| 优雅降级 | 单组件失败不阻塞，连续失败才暂停 |
| 技能自动发现 | 新增技能自动注册到 goal 和普通交互流程 |
| 确定性质量门控 | 每阶段用 design-constraint --verify 检查，不依赖模型自评 |

## 3. 推荐方案：Quality-Gated Single Loop

### 3.1 核心决策

三团队深度评审（研究 agent + 架构师 + 算法专家）一致推荐 **Quality-Gated Single Loop**：

- **80% 收益，20% 复杂度**
- **不添加 outer loop**，单循环 + 确定性质量门控
- 收敛检测仅在 VERIFY 阶段评估

### 3.2 循环结构

```
ANALYZE → SKILL → REVIEW → FIX → VERIFY → (不通过则回到 FIX, max 3 cycles)
```

### 3.3 七个致命风险（已识别并规避）

| # | 风险 | 缓解策略 |
|---|------|---------|
| 1 | 收敛信号污染 | 收敛检测仅在 VERIFY 阶段评估，非每轮 |
| 2 | Error tracker 烧穿 | 三层恢复状态机 + 阈值隔离 |
| 3 | 电路断路器误触发 | 场景特定阈值，非全局统一 |
| 4 | 窗口混叠 | WINDOW = min(5, maxRounds)，自适应 |
| 5 | 模型自评不可靠 | 确定性质量门控替代模型自评 |
| 6 | dead-turn 误报 | hasHadChanges 保护，至少 1 轮有实际变更 |
| 7 | 过度结构化 | 单循环 + 确定性门控，不引入 outer loop |

## 4. 架构概览

```
┌─────────────────────────────────────────────────────┐
│                  Goal Command (/goal)                │
│  goal.tsx → 创建 Goal + 1 个初始任务 → 触发 auto-execute │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              Goal Runtime (goalRuntime.ts)           │
│  turn_finished → 委托 goalOrchestrator → 返回决策    │
│  turn_finished 核心决策从 ~236 行压缩到 ~50 行       │
│  会计/状态更新保留，总行数 ~450 行                    │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
┌──────────────┐ ┌──────────┐ ┌──────────────┐
│goalScenario  │ │goalError │ │goalConvergenc│
│场景识别+配置 │ │Tracker   │ │e 收敛检测    │
│(~100行)      │ │统一错误  │ │(~120行)      │
│              │ │(~180行)  │ │              │
└──────────────┘ └──────────┘ └──────────────┘
          │            │            │
          └────────────┼────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│           goalOrchestrator.ts (~150行)               │
│  整合场景+错误+收敛 → OrchestratorDecision            │
│  ┌─────────┐ ┌────────┐ ┌────────┐ ┌─────┐ ┌──────┐│
│  │ANALYZE  │→│SKILL   │→│REVIEW  │→│FIX  │→│VERIFY││
│  │CodeGraph│ │325+技能│ │子Agent │ │编辑 │ │构建  ││
│  │Grok     │ │BM25选  │ │自审查  │ │     │ │测试  ││
│  └─────────┘ └────────┘ └────────┘ └─────┘ └──────┘│
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│            Skill Registry Scanner (新增)              │
│  启动扫描 + 动态发现 → 独立 Skills 排名               │
│  rankSkills() 纯函数，与 toolRanker 解耦              │
└─────────────────────────────────────────────────────┘
```

### 4.1 模块依赖图

```
goalRuntime.ts (~450行, turn_finished 委托决策)
    │ 调用 orchestrator, 接收 decision, 执行状态更新
    │
    ├── goalOrchestrator.ts (~150行) — 编排器，纯组合器，不修改状态
    │       输入: TurnAnalysisContext (只读)
    │       输出: OrchestratorDecision
    │       依赖: goalScenario, goalErrorTracker, goalConvergence, goalReActObserver, goalSkillRanker
    │
    ├── goalScenario.ts (~100行) — 场景识别 + 配置查表 + 亲和矩阵
    │       输入: objective 字符串
    │       输出: ScenarioConfig
    │       依赖: 无（纯函数 + 静态数据）
    │
    ├── goalErrorTracker.ts (~120行) — 统一错误计数和检测
    │       输入: ErrorCategory + turnId
    │       输出: { count, shouldPause, threshold }
    │       依赖: 无（纯计数器）
    │
    ├── goalErrorRecovery.ts (~100行) — 三层恢复决策 + prompt 生成
    │       输入: UnifiedErrorTracker + 错误上下文
    │       输出: RecoveryDecision { action, layer, recoveryPrompt? }
    │       依赖: goalErrorTracker（读取计数）
    │
    ├── goalConvergence.ts (~120行) — 收敛检测（纯数学，无副作用）
    │       输入: ConvergenceState + maxRounds
    │       输出: ConvergenceResult { converged, reason, strategyHint }
    │       依赖: 无（纯函数）
    │
    ├── goalReActObserver.ts (~80行) — ReAct 阶段观测
    │       输入: toolCalls[], outputSummary
    │       输出: ReActObservation { phases, mainPhase, qualitySignals }
    │       依赖: 无（纯函数）
    │       消费者: goalOrchestrator（每轮调用 observeTurn）
    │
    ├── goalSkillRanker.ts (~100行) — 技能排名（纯函数）
    │       输入: query + availableSkills + scenario
    │       输出: RankedSkill[]
    │       依赖: goalScenario（读取亲和矩阵）
    │
    ├── goalSteering.ts (已有 ~280行) — 模板渲染
    └── goalAnalysis.ts (已有) — 轻量分析
```

### 4.2 状态写入权原则

- **单一写入者**: 只有 `goalRuntime.ts` 可以修改 `GoalRuntimeState`
- **orchestrator 是纯函数/组合器**: 接收只读输入，返回决策，不修改任何状态
- **goalRuntime 根据 decision 执行**: 更新 goal 状态、注入 prompt、设置 pauseReason

## 5. 核心接口定义

### 5.1 OrchestratorDecision — 编排器输出契约

```typescript
interface OrchestratorDecision {
  action: "continue" | "pause" | "skip_task" | "retry"
  prompt?: string        // 注入的 continuation prompt（action=continue 时必填）
  reason: string         // 决策原因（用于日志和 pauseReason）
  pauseReason?: string   // 仅 action="pause" 时使用
  updateGoalPatch?: Partial<Goal>  // 可选的 goal 状态补丁
}
```

**action 映射到 GoalRuntimeResult**:
- `"continue"` → `{ shouldContinue: true, injectedPrompt: decision.prompt }`
- `"pause"` → `{ shouldContinue: false, injectedPrompt: decision.pauseReason }`
- `"skip_task"` → 标记当前任务 "skipped"，注入下一个任务的 prompt
- `"retry"` → 重新注入当前任务的 continuation prompt（不推进）

### 5.2 TurnAnalysisContext — orchestrator 输入（只读）

```typescript
interface TurnAnalysisContext {
  goal: Goal                          // 当前 goal（只读）
  runtime: Readonly<GoalRuntimeState> // 运行时状态（只读）
  currentTurn: TurnRecord | undefined // 当前轮记录
  previousTurn: TurnRecord | undefined // 上轮记录
  todos: TodoItem[]                   // 当前任务列表
  currentTask: string | undefined     // 当前任务内容
  observation: ReActObservation       // ReAct 阶段观测结果
  scenarioConfig: ScenarioConfig      // 当前场景配置
}
```

### 5.3 GoalRuntimeState 扩展字段

```typescript
interface GoalRuntimeState {
  // ... 现有字段保持不变 ...

  // 新增 — 场景
  currentScenario?: ScenarioType

  // 新增 — 收敛检测
  convergenceState?: {
    informationGains: number[]   // 滑动窗口 5
    qualityScores: number[]
    changeMagnitudes: number[]
    round: number
  }

  // 新增 — 统一错误追踪
  errorTracker?: UnifiedErrorTracker

  // 新增 — ReAct 观测（Turn 级别，每轮覆盖）
  lastObservation?: ReActObservation
}
```

**初始化时机**:
- `currentScenario`: `goal_created` 事件时，调用 `resolveScenario(goal.objective)` 初始化
- `convergenceState`: `goal_created` 事件时初始化为空状态
- `errorTracker`: `goal_created` 事件时初始化为空 tracker
- `lastObservation`: `turn_finished` 事件时每轮覆盖

## 6. 质量门控系统（Quality Gates）

### 6.1 设计原则

- **确定性检查优先**: 使用 design-constraint --verify，不依赖模型自评
- **每阶段独立门控**: 每个阶段有独立的质量检查函数
- **门控失败 → 回退到 FIX**: 不通过则带着诊断信息回到 FIX 阶段

### 6.2 阶段质量门控函数

| 阶段 | 门控函数 | 检查内容 | 通过条件 |
|------|---------|---------|---------|
| ANALYZE | `gateAnalyze()` | CodeGraph/Grok 调用次数、分析覆盖率 | ≥1 次 L3 工具调用 |
| SKILL | `gateSkill()` | 技能匹配度、亲和度 | 选中技能亲和度 ≥ 0.3 |
| REVIEW | `gateReview()` | 子 Agent 审查结果、安全扫描 | 无 critical 问题 |
| FIX | `gateFix()` | 代码变更最小化、SurgicalPatch 约束 | 变更 ≤ 15% 或 30 行 |
| VERIFY | `gateVerify()` | build + test + smoke | build 成功 + test 100% 通过 |

### 6.3 GateVerify 详细设计

```typescript
interface GateVerifyResult {
  passed: boolean
  buildStatus: "success" | "failure" | "skipped"
  testStatus: "pass" | "fail" | "skip"
  testPassRate: number      // 0-1
  regressionDetected: boolean
  details: string
}

function gateVerify(outputSummary: string, toolCalls: string[]): GateVerifyResult {
  const hasBash = toolCalls.includes("Bash")
  if (!hasBash) return { passed: false, buildStatus: "skipped", testStatus: "skip", testPassRate: 0, regressionDetected: false, details: "No Bash calls for verification" }

  const output = outputSummary.toLowerCase()
  const hasBuildError = /(?<!no |0 )(?:: error|build failed|syntax error|type error)/.test(output)
  const hasTestError = /test failed|assertion error|failing/.test(output)
  const hasRegression = /regression|broke|broken|previously working/.test(output)
  const hasTestSuccess = /test passed|all tests pass|passing|0 failing/.test(output)

  const buildStatus = hasBuildError ? "failure" : "success"
  const testStatus = hasTestError ? "fail" : hasTestSuccess ? "pass" : "skip"
  const testPassRate = testStatus === "pass" ? 1.0 : testStatus === "fail" ? 0.0 : 0.5

  return {
    passed: !hasBuildError && !hasTestError && !hasRegression,
    buildStatus,
    testStatus,
    testPassRate,
    regressionDetected: hasRegression,
    details: outputSummary.slice(0, 500),
  }
}
```

## 7. 工具层级系统（Tool Tier Hierarchy）

### 7.1 ANALYZE 阶段工具层级

```
L3 (深度分析) ──→ CodeGraph / Grok
  │  代码知识图谱 + 语义理解
  │  每任务上限: 2 次 CodeGraph / 1 次 Grok
  │  超时: CodeGraph 10s, Grok 15s
  │
L2 (结构搜索) ──→ Grep / Glob
  │  模式匹配 + 文件发现
  │  无限制
  │
L1 (基础读取) ──→ Read
     文件内容读取
     无限制
```

### 7.2 调用协议

- **首轮 ANALYZE 必调**: CodeGraph 初始化 + 基础扫描
- **FIX 引入新文件时调用**: impact analysis
- **防抖**: 30 秒内不重复调用同一工具
- **结果注入**: CodeGraph/Grok 结果注入 continuation prompt（不占 system prompt），截断到 2000 字符

### 7.3 降级策略

| 工具 | 检测方式 | 降级行为 |
|------|---------|---------|
| CodeGraph 未初始化 | `codegraph_status` → 未初始化 | 自动 init → 失败则跳过，用 Grep/Glob |
| CodeGraph 查询超时 | subprocess timeout 10s | 跳过该查询，继续其他分析 |
| Grok 未生成图谱 | `grok_status` → 无图谱 | 跳过，用 model 自身知识 |
| Agent spawn 失败 | spawn 返回错误 | 跳过子 agent，model 做 self-review |
| Skill 调用失败 | Skill tool 返回错误 | 跳过，选择下一个匹配技能 |

## 8. 场景识别系统

### 8.1 五种场景

| 场景 | 识别关键词（exclusive 权重 3, shared 权重 1） | maxRounds |
|------|---------------------------------------------|-----------|
| code_change | 实现/2, 添加/2, feature/2, 修改/1, change/1 | 5 |
| doc_writing | README/3, documentation/3, 文档/3, guide/3, spec/2 | 3 |
| troubleshooting | bug/3, crash/3, error/3, 排查/3, debug/3, fix/1 | 8 |
| design_improve | 设计/3, design/3, architecture/3, 架构/3, 方案/3 | 5 |
| refactoring | 重构/3, refactor/3, clean up/3, tech debt/3, 解耦/3 | 6 |

### 8.2 置信度计算

```
confidence = min(1, matchedScore / maxPossibleScore)
exclusive 命中时总分 × 1.5 倍增因子
exclusive 命中保底置信度 0.35
所有场景 < 0.3 时默认 code_change
```

### 8.3 混合场景处理

```
confidence > 0.7  → 直接使用该场景
0.3 <= confidence <= 0.7  → 主场景 + 注入次场景技能
< 0.3  → code_change 兜底
```

### 8.4 场景配置表

```typescript
interface ScenarioConfig {
  type: ScenarioType
  phases: PhaseConfig[]
  maxRoundsPerTask: number
  convergenceThreshold: number
  requiredTools: string[]
  preferredSkills: string[]
  skillAffinity: Record<string, number>
}
```

## 9. 技能集成系统

### 9.1 技能-场景亲和矩阵（325+ 技能 × 5 场景）

#### 核心技能映射表（/goal 阶段）

| 阶段 | 核心技能 | 补充技能 |
|------|---------|---------|
| ANALYZE | systematic-debugging, codegraph, grok | docs-navigator, search-first, workspace-surface-audit |
| SKILL | (场景选择) | design-architect, design-doc-reviewer, code-design-analyzer |
| REVIEW | requesting-code-review, design-constraint, orion-deep-audit | security-review, code-design-analyzer, plankton-code-quality |
| FIX | receiving-code-review, task-decomposer, tdd-workflow | error-handling, 语言模式(patterns) |
| VERIFY | verification-before-completion, eval-harness | production-audit, canary-watch |

#### 亲和度权重（部分示例）

```typescript
const SKILL_SCENARIO_AFFINITY: Record<string, Record<ScenarioType, number>> = {
  "systematic-debugging":    { code_change: 0.3, doc_writing: 0.0, troubleshooting: 1.0, design_improve: 0.1, refactoring: 0.3 },
  "brainstorming":           { code_change: 0.4, doc_writing: 0.3, troubleshooting: 0.1, design_improve: 1.0, refactoring: 0.2 },
  "test-driven-development": { code_change: 0.9, doc_writing: 0.0, troubleshooting: 0.5, design_improve: 0.1, refactoring: 0.8 },
  "verification-before-completion": { code_change: 0.8, doc_writing: 0.4, troubleshooting: 0.6, design_improve: 0.3, refactoring: 0.8 },
  "design-constraint":       { code_change: 0.5, doc_writing: 0.2, troubleshooting: 0.2, design_improve: 0.9, refactoring: 0.7 },
  "orion-deep-audit":        { code_change: 0.5, doc_writing: 0.0, troubleshooting: 0.8, design_improve: 0.4, refactoring: 0.7 },
  "simplify":                { code_change: 0.3, doc_writing: 0.0, troubleshooting: 0.2, design_improve: 0.2, refactoring: 0.9 },
  // ... 325+ 技能完整映射
}
```

### 9.2 技能排名算法

```typescript
function scoreSkill(skill: SkillMetadata, terms: string[], scenario: ScenarioConfig): number {
  let score = 0
  // name 匹配（权重 100）
  if (terms.some(t => skill.name.toLowerCase().includes(t))) score += 100
  // trigger 匹配（权重 12）
  for (const trigger of skill.triggers) {
    if (terms.some(t => trigger.toLowerCase().includes(t))) score += 12
  }
  // description 匹配（权重 8）
  if (terms.some(t => skill.description.toLowerCase().includes(t))) score += 8
  // 场景亲和度（权重 40）
  const affinity = SKILL_SCENARIO_AFFINITY[skill.name]?.[scenario.type] ?? 0
  score += affinity * 40
  // priority 加成
  score += (skill.priority / 10) * 20
  return score
}
```

### 9.3 Skill Registry Scanner

```typescript
interface SkillMetadata {
  name: string; path: string; description: string
  triggers: string[]; priority: number; conflictsWith: string[]
  lastModified: number
}

// 启动时扫描 ~/.ola-cc/skills/*/SKILL.md
// 容错解析：缺少 frontmatter 的跳过，缺少可选字段的用默认值
// 模块级缓存 + 30s TTL
async function scanSkillRegistry(): Promise<SkillMetadata[]>
async function getSkillMetadata(): Promise<SkillMetadata[]>
```

## 10. 收敛检测系统

### 10.1 三维收敛检测

| 维度 | 权重 | 计算方式 | 阈值 |
|------|------|---------|------|
| 信息增益 | 0.4 | 工具新颖度 + 可观测变更 + 输出新颖度 | < 0.15 连续 2 轮 |
| 质量分数 | 0.35 | buildStatus + testPassing + reviewResult + noRegression | >= 80 才允许收敛 |
| 变更幅度 | 0.25 | 文件数 + 行数，对数缩放 | < 3 |

### 10.2 信息增益计算

```typescript
function computeInformationGain(current: TurnRecord, previous: TurnRecord | undefined): number {
  if (!previous) return 1.0 // 首轮最大增益

  // 维度 1: 新工具比例 (0.4)
  const toolNovelty = ...

  // 维度 2: 可观测变更 (0.35)
  // 语义重定义：有非只读工具产生了文件系统变更
  const observable = current.hadObservableChanges ? 1.0 : 0.0

  // 维度 3: 输出新颖度 (0.25) — Jaccard 距离
  const outputNovelty = ...

  return 0.4 * toolNovelty + 0.35 * observable + 0.25 * outputNovelty
}
```

### 10.3 质量分数计算

```typescript
const SCENARIO_QUALITY_WEIGHTS: Record<ScenarioType, {...}> = {
  code_change:     { buildStatus: 0.30, testPassing: 0.35, reviewResult: 0.20, noRegression: 0.15 },
  doc_writing:     { buildStatus: 0.05, testPassing: 0.10, reviewResult: 0.55, noRegression: 0.30 },
  troubleshooting: { buildStatus: 0.15, testPassing: 0.20, reviewResult: 0.25, noRegression: 0.40 },
  design_improve:  { buildStatus: 0.10, testPassing: 0.15, reviewResult: 0.50, noRegression: 0.25 },
  refactoring:     { buildStatus: 0.25, testPassing: 0.40, reviewResult: 0.20, noRegression: 0.15 },
}
```

### 10.4 收敛判定

```typescript
function checkConvergence(state: ConvergenceState, maxRounds: number = 5): ConvergenceResult {
  const WINDOW = Math.min(5, maxRounds)

  if (qualityAbove) {
    if (infoGainConverged && qualityStable) return { converged: true, reason: "info_gain_stable" }
    if (changesMinimal && qualityStable && hasHadChanges) return { converged: true, reason: "changes_minimal" }
  }

  if (round >= maxRounds) {
    if (qualityAbove) return { converged: true, reason: "max_rounds" }
    return { converged: true, reason: "max_rounds_low_quality" } // orchestrator 映射为 pause
  }

  return { converged: false }
}
```

## 11. 错误追踪与恢复系统

### 11.1 统一错误追踪器

```typescript
type ErrorCategory = "runtime_exception" | "dead_turn" | "critical_analysis"
type RecoveryLayer = "FIX_RETRY" | "SKILL_RETRY" | "FULL_RESTART"

interface UnifiedErrorTracker {
  categories: Record<ErrorCategory, { count: number; threshold: number }>
  recoveryLayer: RecoveryLayer
  fullRestartUsed: boolean
}

const DEFAULT_THRESHOLDS: Record<ErrorCategory, number> = {
  runtime_exception: 3,
  dead_turn: 5,
  critical_analysis: 3,
}
```

### 11.2 三层恢复状态机

```
FIX_RETRY (3次) ──→ SKILL_RETRY (3次) ──→ FULL_RESTART (1次) ──→ PAUSE
```

- **FIX_RETRY**: 同一策略重试
- **SKILL_RETRY**: 换技能/策略重试
- **FULL_RESTART**: 重新分析整个问题
- **PAUSE**: 人工介入

### 11.3 熔断器

```typescript
const SCENARIO_CIRCUIT_BREAKER: Record<ScenarioType, { maxPerTask: number; timeoutMs: number }> = {
  code_change:     { maxPerTask: 5,  timeoutMs: 20 * 60 * 1000 },
  doc_writing:     { maxPerTask: 3,  timeoutMs: 15 * 60 * 1000 },
  troubleshooting: { maxPerTask: 8,  timeoutMs: 45 * 60 * 1000 },
  design_improve:  { maxPerTask: 5,  timeoutMs: 25 * 60 * 1000 },
  refactoring:     { maxPerTask: 6,  timeoutMs: 30 * 60 * 1000 },
}

// 全局: maxTotalRounds=50, maxConsecutiveFailures=3, maxTimeoutMs=30min
```

## 12. ReAct Observer — 阶段可观测协议

### 12.1 工具→阶段映射

```typescript
const TOOL_PHASE_MAP: Record<string, ReActPhase> = {
  // ANALYZE 阶段
  Read: "ANALYZE", Glob: "ANALYZE", Grep: "ANALYZE",
  codegraph: "ANALYZE", grok: "ANALYZE",
  // SKILL 阶段
  Skill: "SKILL", SkillTool: "SKILL",
  // REVIEW 阶段
  Agent: "REVIEW", AgentTool: "REVIEW",
  // FIX 阶段
  Edit: "FIX", Write: "FIX", FileEdit: "FIX", FileWrite: "FIX",
  // VERIFY 阶段
  Bash: "VERIFY",
  // 不参与阶段推断
  TodoWrite: "ANALYZE", update_goal: "VERIFY",
}
```

### 12.2 质量信号提取

```typescript
interface QualitySignals {
  hasErrors: boolean       // 输出含 error/failed/cannot
  hasSuccess: boolean      // 输出含 success/completed/passed
  hasProgress: boolean     // 输出含 created/added/fixed/updated
}

function extractQualitySignals(outputSummary: string): QualitySignals {
  const lower = (outputSummary ?? "").toLowerCase()
  return {
    hasErrors: /error|failed|cannot|exception|crash/.test(lower),
    hasSuccess: /success|completed|passed|build complete|all tests pass/.test(lower),
    hasProgress: /created|added|fixed|updated|implemented|resolved/.test(lower),
  }
}
```

## 13. Hermes + EverOS 融合点

### 13.1 三个融合点

| 融合点 | 来源 | 目标阶段 | 功能 |
|--------|------|---------|------|
| BM25 记忆检索 | EverOS | ANALYZE | 模糊查询召回率从 ~20% → ≥80% |
| LLM 文本反馈 | Hermes | REVIEW | K=4 策略从"泛泛" →"精准" |
| Eval 数据集 | Hermes | VERIFY | 进化验证从"盲试" →"有基准" |

### 13.2 BM25 记忆检索增强

```
Phase 4 实施:
- BM25 算法 (k1=1.2, b=0.75)
- RRF 多路融合 (k=60)
- 中英文混合分词 (英文按空格 + 中文 bigram/unigram + camelCase/snake_case 分割)
- MemoryIndex 独立服务，与 extractMemories 并列
- 降级: indexReady=false 时 fallback 到 MEMORY.md substring 匹配
```

### 13.3 LLM 文本反馈

```
Phase 2 实施:
- rubricEvaluator 新增 feedback 字段
- enableLLMFeedback 默认 false（向后兼容）
- 仅失败维度调用 LLM（≤5 次/进化）
- 与 contrastAnalysis 互补: feedback=当前诊断, contrast=历史趋势
- 成本上限: $0.50/进化
```

### 13.4 Eval 数据集自动生成

```
Phase 1 实施:
- SyntheticDatasetBuilder: LLM 读取 SKILL.md → 生成 20 个评估用例
- 自动分割: 50% train / 25% val / 25% holdout
- holdout 集独立验证进化结果
- 降级: LLM 失败 → mineFromHistory()
- McNemar's test 统计显著性检验
```

### 13.5 约束系统增强

```
Phase 3 实施:
- 三层约束: 绝对大小(15KB) + 增长比例(20%) + 行数(30行)
- 结构完整性: frontmatter (name + description) 必须存在
- 测试门控: bun test 100% 通过才放行
- 环境变量覆盖: CONSTRAINT_MAX_SKILL_SIZE 等
```

## 14. 实现路线图

```
Phase 1 (已完成) ──→ Phase 2 (场景感知 + 模块提取) ──→ Phase 5 (CodeGraph/Grok)
                   ──→ Phase 3 (收敛检测 + 错误追踪)  ↗
                   ──→ Phase 4 (技能发现 + 排名) ──────┘

Hermes+EverOS 融合:
  Phase H1 (数据集) ──┐
                       ├──→ Phase H3 (约束增强)
  Phase H2 (文本反馈) ─┘
  Phase H4 (BM25) ──── 独立
```

### Phase 1: 基础加固（已完成）

- [x] 移除 auto-advance，改为 model-driven
- [x] ReAct 模板写入 goalSteering.ts
- [x] currentTask 注入逻辑

### Phase 2: 场景感知 + 模块提取

- [ ] goalScenario.ts — 场景识别 + 配置查表
- [ ] goalReActObserver.ts — ReAct 阶段观测
- [ ] goalRuntime.ts 精简（turn_finished 委托决策）
- [ ] GoalRuntimeState 扩展（可选字段，向后兼容）
- [ ] 清理 autoProgressTasks 废弃代码

### Phase 3: 收敛检测 + 统一错误追踪

- [ ] goalConvergence.ts — 三维收敛检测
- [ ] goalErrorTracker.ts — 统一错误追踪
- [ ] goalErrorRecovery.ts — 三层恢复状态机
- [ ] goalOrchestrator.ts — 编排器整合

### Phase 4: 技能自动发现

- [ ] skillRegistry.ts — SKILL.md 扫描
- [ ] goalSkillRanker.ts — 独立技能排名
- [ ] 亲和矩阵配置（325+ 技能）
- [ ] continuation prompt 注入推荐技能

### Phase 5: CodeGraph + Grok 深度集成

- [ ] ANALYZE 步骤主动调用
- [ ] 降级策略实现
- [ ] 结果注入 continuation prompt

### Phase H1-H4: Hermes+EverOS 融合

- [ ] H1: datasetBuilder.ts + evalDataset.ts
- [ ] H2: rubricEvaluator.ts 增强 + EvolutionEngine P2 消费 feedback
- [ ] H3: constraintValidator.ts
- [ ] H4: bm25.ts + rrf.ts + memoryIndex.ts

## 15. 测试策略

### 单元测试

| 组件 | 测试用例 |
|------|---------|
| 场景识别 | "fix the code style" → code_change |
| 场景识别 | "重构 auth 模块并修复 bug" → 混合场景 |
| 场景识别 | "排查生产环境内存泄漏" → troubleshooting |
| 场景识别 | 空 objective → code_change（兜底） |
| 收敛检测 | 信息增益连续 2 轮 < 0.15 + 质量 >= 80 → converged |
| 收敛检测 | max_rounds + 低质量 → pause |
| 收敛检测 | 纯分析轮 → changesMinimal 不触发 |
| 质量分数 | "no error found, all tests pass" → 100 |
| 质量分数 | "build failed, no errors" → buildScore=0 |
| 错误追踪 | runtime_exception 3 次 → shouldPause |
| 错误追踪 | recovery FIX_RETRY 3 次 → 升级到 SKILL_RETRY |
| 技能排名 | troubleshooting → systematic-debugging 排名高 |
| 质量门控 | gateVerify 无 Bash → passed=false |

### 集成测试

| 场景 | 验证点 |
|------|--------|
| 完整 ReAct 循环 | 5 轮内收敛，任务自动推进 |
| 错误恢复 | 3 次 build 失败 → skill_retry → 换方案成功 |
| 混合场景 | 技能选择包含两个场景的 preferredSkills |
| CodeGraph 降级 | 未初始化 → Grep 替代，不阻塞 |

### 性能测试

| 指标 | 目标 |
|------|------|
| 场景识别 | < 1ms |
| 收敛检测 | < 1ms |
| 技能排名 (325+ 技能) | < 50ms |
| 每轮增加 token | < 3000 tokens |

## 16. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 多轮执行消耗过多 token | 中 | 成本增加 | tokenBudget + 场景特定熔断器 |
| 技能选择错误导致方向偏离 | 中 | 浪费轮次 | REVIEW 步骤纠正 + 收敛检测 |
| CodeGraph/Grok 不可用频率高 | 低 | 降级频繁 | 4 级降级策略 |
| 场景识别错误 | 低 | 配置不匹配 | 置信度评分 + 混合场景 + code_change 兜底 |
| goalRuntime.ts 改造风险 | 中 | 回归 | 模块提取，旧字段保留 @deprecated |
| TodoWrite 与 orchestrator 脱节 | 中 | goal 不完成 | v3 新增交互设计 |

## 17. 关键文件

| 文件 | 用途 |
|------|------|
| `src/utils/goal/goalScenario.ts` | 场景识别 + 配置查表 |
| `src/utils/goal/goalReActObserver.ts` | 阶段推断 |
| `src/utils/goal/goalOrchestrator.ts` | 决策矩阵 |
| `src/utils/goal/goalConvergence.ts` | 收敛检测 |
| `src/utils/goal/goalRuntime.ts` | 状态机 |
| `src/utils/goal/goalSteering.ts` | 续写 prompt |
| `src/utils/goal/goalErrorTracker.ts` | 统一错误追踪 |
| `src/utils/goal/goalErrorRecovery.ts` | 三层恢复 |
| `src/utils/goal/goalSkillRanker.ts` | 技能排名 |
| `src/utils/goal/skillRegistry.ts` | 技能扫描 |
| `src/tools/CodegraphTool/CodegraphTool.ts` | 11 操作 |
| `src/tools/GrokTool/GrokTool.ts` | 8 操作 |
| `src/services/singularity/datasetBuilder.ts` | 合成数据集生成 |
| `src/services/singularity/evalDataset.ts` | 数据集管理 |
| `src/services/singularity/constraintValidator.ts` | 约束验证 |
| `src/utils/memory/bm25.ts` | BM25 算法 |
| `src/utils/memory/rrf.ts` | RRF 融合 |
| `src/services/memory/memoryIndex.ts` | 记忆索引 |

## 18. 验收标准

### Phase 2-5 验收

- [ ] 5 种场景识别准确率 ≥ 90%
- [ ] 混合场景正确注入双场景技能
- [ ] 收敛检测 3 维信号正确计算
- [ ] 错误恢复三层状态机正确升级
- [ ] 325+ 技能全部注册到 SkillRegistry
- [ ] 技能排名 < 50ms
- [ ] CodeGraph/Grok 降级不阻塞流程

### Hermes+EverOS 融合验收

- [ ] H1: 生成 ≥15 个有效评估用例/技能
- [ ] H2: feedback 文本包含具体修改建议
- [ ] H3: 超过 15KB 的技能被自动拒绝
- [ ] H4: "Windows crash Bun" 能召回 "fix-windows-bun-crash" 记忆
