# Goal ReAct Orchestrator 设计文档

> 日期: 2026-05-28
> 状态: Draft v3 (深度评审后修订 — 修复 9 个 P0 + 8 个 P1)
> 作者: heal + AI 协作
> 评审团队: 架构师团队 (6/10→修订) | 算法专家团队 (6.5/10→修订) | 集成测试团队 (7/10→修订) | 场景识别专家

### v3 变更摘要（深度评审后修订）

| # | 问题 | 严重度 | 修复 |
|---|------|--------|------|
| 1 | OrchestratorDecision 接口未定义 | P0 | 新增 §3.1 完整接口定义 |
| 2 | GoalRuntimeState 扩展字段未定义 | P0 | 新增 §3.1 完整类型 + 初始化时机 |
| 3 | goalRuntime "450→200" 目标不现实 | P0 | 修正为 "turn_finished 236→50, 总 ~450" |
| 4 | hadObservableChanges 语义导致收敛维度失效 | P0 | 新增 §4.12 语义重定义为文件系统变更 |
| 5 | TodoWrite 与 orchestrator 交互未设计 | P0 | 新增 §4.11 交互协议 |
| 6 | autoProgressTasks 代码/注释不一致 | P0 | §4.10 标注，Phase 2 前清理 |
| 7 | 中文分词完全失效 | P0 | bigram + unigram 分词 |
| 8 | "no error" 假阴性 | P0 | 负向环视排除否定语境 |
| 9 | 纯分析轮过早收敛 | P0 | hasHadChanges 保护 |
| 10 | ErrorScenario 混合错误原因和恢复策略 | P1 | 拆分为 ErrorCategory + RecoveryLayer |
| 11 | 状态写入权未界定 | P1 | 新增单一写入者原则 |
| 12 | outputSummary 空时信息增益退化 | P1 | 空输出特殊处理 |
| 13 | SkillRegistryScanner 路径不存在 | P1 | 改为 src/utils/goal/skillRegistry.ts |
| 14 | 测试用例缺失边界条件 | P1 | 补充 12 个测试用例 |
| 15 | maxRounds 低质量时不应收敛 | P1 | 新增 max_rounds_low_quality |
| 16 | 窗口大小与 maxRounds 不匹配 | P1 | WINDOW = min(5, maxRounds) |
| 17 | exclusive 保底 0.5 过高 | P1 | 降低至 0.35 |

## 1. 问题陈述

当前 `/goal` 命令存在以下问题：

1. **任务完成率低**：只完成部分任务就停止，不会自动推进到下一个任务
2. **技能利用不足**：本地有 25+ 技能，但 goal 执行中仅被动使用少数几个
3. **缺乏代码分析工具集成**：CodeGraph（实时代码知识图谱）和 Grok（深度语义理解）未被主动利用
4. **单轮执行**：每个任务只执行一轮，没有多轮分析-修复-验证循环
5. **场景单一**：仅适配代码变更场景，不支持设计文档、问题排查、设计改进、重构等
6. **无降级策略**：工具不可用时直接失败
7. **新技能无法自动发现**：手动添加的技能不会自动进入 goal 流程

## 2. 设计目标

| 目标 | 衡量标准 |
|------|---------|
| 任务全完成 | `/goal` 创建的所有任务 100% 完成或明确暂停 |
| 技能全覆盖 | 25+ 技能按场景被智能选用 |
| 工具深度集成 | CodeGraph + Grok 在 ANALYZE/REVIEW 阶段主动调用 |
| 多轮收敛 | 每个任务最多 N 轮 ReAct，3 维收敛检测 |
| 多场景支持 | 5 种场景各有优化的 ReAct 配置 |
| 优雅降级 | 单组件失败不阻塞，连续失败才暂停 |
| 技能自动发现 | 新增技能自动注册到 goal 和普通交互流程 |

## 3. 架构概览

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
│  │CodeGraph│ │25+技能 │ │子Agent │ │编辑 │ │构建  ││
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

**模块提取原则**：`goalRuntime.ts` 的 `turn_finished` 核心决策逻辑委托给 orchestrator（~236 行 → ~50 行），会计/状态更新保留。总行数从 ~730 行降至 ~450 行。新增逻辑全部提取为独立模块。

**模块依赖图**（v3 新增）：

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

**状态写入权原则**（v3 新增）：
- **单一写入者**: 只有 `goalRuntime.ts` 可以修改 `GoalRuntimeState`
- **orchestrator 是纯函数/组合器**: 接收只读输入，返回决策，不修改任何状态
- **goalRuntime 根据 decision 执行**: 更新 goal 状态、注入 prompt、设置 pauseReason

```
goalRuntime.ts (精简后 ~450 行)
    │
    ├── goalOrchestrator.ts (~150行) — 编排器，整合以下三个模块
    │       输入: Goal + GoalRuntimeState + TurnAnalysis
    │       输出: OrchestratorDecision { action, prompt?, reason }
    │
    ├── goalErrorTracker.ts (~180行) — 统一错误追踪
    │       输入: ErrorScenario + turnId
    │       输出: ErrorCheckResult { shouldPause, reason, escalateTo }
    │
    ├── goalConvergence.ts (~120行) — 收敛检测（纯数学，无副作用）
    │       输入: ConvergenceState
    │       输出: ConvergenceResult { converged, reason, strategyHint }
    │
    ├── goalScenario.ts (~100行) — 场景识别 + 配置查表
    │       输入: objective 字符串
    │       输出: ScenarioConfig
    │
    ├── goalReActObserver.ts (~80行) — ReAct 阶段观测
    │       输入: toolCalls[]
    │       输出: ReActObservation { phases, mainPhase, qualitySignals }
    │
    ├── goalSkillRanker.ts (~100行) — 技能排名（纯函数）
    │       输入: query + availableSkills + scenario
    │       输出: RankedSkill[]
    │
    ├── goalSteering.ts (已有 ~280行) — 模板渲染
    └── goalAnalysis.ts (已有) — 轻量分析
```

### 3.1 核心接口定义（v3 新增）

#### OrchestratorDecision — 编排器输出契约

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

**调用链**: goalRuntime 每轮 `turn_finished` 时调用 orchestrator，根据返回的 decision 执行状态更新。orchestrator 不直接修改 GoalRuntimeState。

#### TurnAnalysisContext — orchestrator 输入（只读）

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

#### GoalRuntimeState 扩展字段（v3 新增）

```typescript
// 新增可选字段，向后兼容
interface GoalRuntimeState {
  // ... 现有字段保持不变 ...

  // v3 新增 — 场景
  currentScenario?: ScenarioType          // 当前场景类型

  // v3 新增 — 收敛检测
  convergenceState?: {
    informationGains: number[]   // 滑动窗口 5
    qualityScores: number[]
    changeMagnitudes: number[]
    round: number
  }

  // v3 新增 — 统一错误追踪
  errorTracker?: UnifiedErrorTracker

  // v3 新增 — ReAct 观测（Turn 级别，每轮覆盖）
  lastObservation?: ReActObservation
}
```

**初始化时机**:
- `currentScenario`: `goal_created` 事件时，调用 `resolveScenario(goal.objective)` 初始化
- `convergenceState`: `goal_created` 事件时初始化为空状态 `{ informationGains: [], qualityScores: [], changeMagnitudes: [], round: 0 }`
- `errorTracker`: `goal_created` 事件时初始化为空 tracker
- `lastObservation`: `turn_finished` 事件时每轮覆盖

**更新模式**: 现有代码使用 mutation（`runtime.consecutiveErrors = 0`），新字段沿用同一模式以保持一致。AppStateStore 默认值需同步新增这些可选字段。

**UnifiedErrorTracker 类型定义**:
```typescript
interface UnifiedErrorTracker {
  scenarios: Record<ErrorCategory, { count: number; threshold: number }>  // 用 Record 而非 Map，兼容序列化
  recoveryLayer: RecoveryLayer
  fullRestartUsed: boolean
}
```

> **注意**: 使用 `Record<ErrorCategory, ...>` 而非 `Map`，确保 AppStateStore 序列化/反序列化兼容。

## 4. 核心组件设计

### 4.1 ReAct Loop（已在 goalSteering.ts 中实现基础版）

基础模板已在 `goalSteering.ts` 的 `CONTINUATION_TEMPLATE` 中实现，包含 6 个步骤：

1. **ANALYZE** — 读文件、grep、git log、CodeGraph、Grok
2. **SKILL** — BM25 选择最匹配的技能调用
3. **REVIEW** — spawn 子 agent 审查（架构、代码质量、依赖分析）
4. **FIX** — 最小变更实现
5. **VERIFY** — build + test + smoke
6. **LOOP/ADVANCE** — 收敛检测 → 下一轮或下一任务

**当前状态**: 模板已写入，auto-advance 已移除，任务推进改为 model-driven via TodoWrite。

**待实现**: 场景感知编排器、收敛检测器、技能自动发现。

### 4.2 ReAct Observer — 阶段可观测协议（新增）

**根因 (RC2)**: 当前 ReAct 循环是模型驱动的，代码层面无法感知模型处于哪个阶段。

**解决方案**: `inferReActPhases(toolCalls)` 纯函数，基于静态映射表推断。

```typescript
// src/utils/goal/goalReActObserver.ts

type ReActPhase = "ANALYZE" | "SKILL" | "REVIEW" | "FIX" | "VERIFY"

/** 工具名 → ReAct 阶段的静态映射。新增工具只需加一行。 */
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

interface QualitySignals {
  hasErrors: boolean       // 输出含 error/failed/cannot
  hasSuccess: boolean      // 输出含 success/completed/passed
  hasProgress: boolean     // 输出含 created/added/fixed/updated
}

interface ReActObservation {
  phases: ReActPhase[]              // 本轮涉及的阶段（可能多个）
  mainPhase: ReActPhase | null      // 主阶段（出现最多的）
  phaseTools: Map<ReActPhase, string[]>  // 每个阶段使用的工具
  qualitySignals: QualitySignals
}

/**
 * 从 toolCalls 推断 ReAct 阶段。
 * 纯函数，<1ms。
 */
function inferReActPhases(toolCalls: string[]): ReActObservation {
  const phaseTools = new Map<ReActPhase, string[]>()
  for (const tool of toolCalls) {
    const phase = TOOL_PHASE_MAP[tool] ?? "ANALYZE" // 未知工具默认归 ANALYZE
    if (!phaseTools.has(phase)) phaseTools.set(phase, [])
    phaseTools.get(phase)!.push(tool)
  }
  const phases = [...phaseTools.keys()]
  // 主阶段 = 出现最多工具的阶段
  const mainPhase = phases.sort(
    (a, b) => (phaseTools.get(b)?.length ?? 0) - (phaseTools.get(a)?.length ?? 0)
  )[0] ?? null

  return { phases, mainPhase, phaseTools, qualitySignals: { hasErrors: false, hasSuccess: false, hasProgress: false } }
}

/**
 * 从 outputSummary 提取质量信号。关键词匹配，<1ms。
 */
function extractQualitySignals(outputSummary: string): QualitySignals {
  const lower = (outputSummary ?? "").toLowerCase()
  return {
    hasErrors: /error|failed|cannot|exception|crash/.test(lower),
    hasSuccess: /success|completed|passed|build complete|all tests pass/.test(lower),
    hasProgress: /created|added|fixed|updated|implemented|resolved/.test(lower),
  }
}

/**
 * 完整观测一轮。挂载到 GoalRuntimeState.reactState。
 */
function observeTurn(
  toolCalls: string[],
  outputSummary: string,
): ReActObservation {
  const observation = inferReActPhases(toolCalls)
  observation.qualitySignals = extractQualitySignals(outputSummary)
  return observation
}
```

### 4.3 场景识别算法（增强版）

**根因补充**: 简单关键词匹配存在歧义，需要置信度评分 + 混合场景支持 + 任务级识别。

#### 关键词表

```typescript
// src/utils/goal/goalScenario.ts

interface KeywordEntry {
  keyword: string
  weight: number       // exclusive=3, shared=1
  type: "exclusive" | "shared"
}

const SCENARIO_KEYWORDS: Record<ScenarioType, KeywordEntry[]> = {
  troubleshooting: [
    // Exclusive（权重 3）— 强烈指向排查
    { keyword: "bug", weight: 3, type: "exclusive" },
    { keyword: "crash", weight: 3, type: "exclusive" },
    { keyword: "error", weight: 3, type: "exclusive" },
    { keyword: "exception", weight: 3, type: "exclusive" },
    { keyword: "regression", weight: 3, type: "exclusive" },
    { keyword: "排查", weight: 3, type: "exclusive" },
    { keyword: "漏洞", weight: 3, type: "exclusive" },
    { keyword: "异常", weight: 3, type: "exclusive" },
    { keyword: "崩溃", weight: 3, type: "exclusive" },
    { keyword: "debug", weight: 3, type: "exclusive" },
    // Shared（权重 1）— 可能指向多种场景
    { keyword: "fix", weight: 1, type: "shared" },
    { keyword: "修复", weight: 1, type: "shared" },
    { keyword: "问题", weight: 1, type: "shared" },
    { keyword: "issue", weight: 1, type: "shared" },
  ],
  doc_writing: [
    { keyword: "README", weight: 3, type: "exclusive" },
    { keyword: "documentation", weight: 3, type: "exclusive" },
    { keyword: "文档", weight: 3, type: "exclusive" },
    { keyword: "guide", weight: 3, type: "exclusive" },
    { keyword: "设计文档", weight: 3, type: "exclusive" },
    { keyword: "design doc", weight: 3, type: "exclusive" },
    { keyword: "spec", weight: 2, type: "exclusive" },
    { keyword: "写", weight: 1, type: "shared" },
    { keyword: "编写", weight: 1, type: "shared" },
  ],
  refactoring: [
    { keyword: "重构", weight: 3, type: "exclusive" },
    { keyword: "refactor", weight: 3, type: "exclusive" },
    { keyword: "clean up", weight: 3, type: "exclusive" },
    { keyword: "tech debt", weight: 3, type: "exclusive" },
    { keyword: "解耦", weight: 3, type: "exclusive" },
    { keyword: "simplify", weight: 2, type: "exclusive" },
    { keyword: "优化", weight: 1, type: "shared" },
    { keyword: "optimize", weight: 1, type: "shared" },
  ],
  design_improve: [
    { keyword: "设计", weight: 3, type: "exclusive" },
    { keyword: "design", weight: 3, type: "exclusive" },
    { keyword: "architecture", weight: 3, type: "exclusive" },
    { keyword: "架构", weight: 3, type: "exclusive" },
    { keyword: "方案", weight: 3, type: "exclusive" },
    { keyword: "trade-off", weight: 3, type: "exclusive" },
    { keyword: "改进", weight: 1, type: "shared" },
    { keyword: "完善", weight: 1, type: "shared" },
  ],
  code_change: [
    { keyword: "实现", weight: 2, type: "exclusive" },
    { keyword: "implement", weight: 2, type: "exclusive" },
    { keyword: "添加", weight: 2, type: "exclusive" },
    { keyword: "feature", weight: 2, type: "exclusive" },
    { keyword: "修改", weight: 1, type: "shared" },
    { keyword: "change", weight: 1, type: "shared" },
  ],
}
```

#### 场景识别函数

```typescript
interface ScenarioMatch {
  type: ScenarioType
  confidence: number  // 0-1
  matchedKeywords: { exclusive: string[]; shared: string[] }
}

/**
 * 置信度计算：
 *   confidence = min(1, matchedScore / maxPossibleScore)
 *   exclusive 命中时总分 × 1.5 倍增因子
 *   exclusive 命中保底置信度 0.35（v3: 从 0.5 降低，避免少量匹配过度膨胀）
 *   所有场景 < 0.3 时默认 code_change
 */
function identifyScenarios(objective: string): ScenarioMatch[] {
  const input = objective.toLowerCase().trim()
  const results: ScenarioMatch[] = []

  for (const [scenarioType, keywords] of Object.entries(SCENARIO_KEYWORDS)) {
    const matchedExclusive: string[] = []
    const matchedShared: string[] = []
    let matchedScore = 0
    let maxPossibleScore = 0

    for (const kw of keywords) {
      maxPossibleScore += kw.weight
      if (input.includes(kw.keyword.toLowerCase())) {
        matchedScore += kw.weight
        if (kw.type === "exclusive") matchedExclusive.push(kw.keyword)
        else matchedShared.push(kw.keyword)
      }
    }

    const hasExclusive = matchedExclusive.length > 0
    const effectiveScore = hasExclusive ? matchedScore * 1.5 : matchedScore
    const effectiveMax = hasExclusive ? maxPossibleScore * 1.5 : maxPossibleScore
    let confidence = effectiveMax > 0 ? Math.min(1, effectiveScore / effectiveMax) : 0
    // exclusive 保底（v3 修正：0.5→0.35，避免 1/10 匹配时过度膨胀）
    if (hasExclusive && confidence < 0.35) confidence = 0.35

    if (confidence > 0) {
      results.push({
        type: scenarioType as ScenarioType,
        confidence: Math.round(confidence * 1000) / 1000,
        matchedKeywords: { exclusive: matchedExclusive, shared: matchedShared },
      })
    }
  }

  results.sort((a, b) => b.confidence - a.confidence)

  if (results.length === 0 || results[0].confidence < 0.3) {
    return [{ type: "code_change", confidence: 0.3, matchedKeywords: { exclusive: [], shared: [] } }]
  }
  return results
}
```

#### 混合场景处理

```typescript
/**
 * confidence > 0.7 → 直接使用该场景
 * 0.3 <= confidence <= 0.7 → 主场景 + 注入次场景技能
 * < 0.3 → code_change 兜底
 */
function selectScenarioConfig(matches: ScenarioMatch[]): ScenarioConfig {
  const primary = matches[0]
  if (primary.confidence > 0.7) return getScenarioConfig(primary.type)

  if (primary.confidence >= 0.3) {
    const base = getScenarioConfig(primary.type)
    const secondaries = matches.filter(
      (m, i) => i > 0 && m.confidence >= 0.3 && m.confidence >= primary.confidence * 0.6
    )
    if (secondaries.length > 0) {
      const extraSkills = secondaries.flatMap(m => getScenarioConfig(m.type).preferredSkills)
      return {
        ...base,
        preferredSkills: [...new Set([...base.preferredSkills, ...extraSkills])],
        maxRoundsPerTask: Math.max(base.maxRoundsPerTask, ...secondaries.map(m => getScenarioConfig(m.type).maxRoundsPerTask)),
      }
    }
    return base
  }
  return getScenarioConfig("code_change")
}
```

#### 任务级场景识别

```typescript
/**
 * 子任务独立识别，父场景提供先验（+0.2 加成）。
 * 子任务置信度 > 0.4 时可覆盖父场景。
 */
function identifyTaskScenario(taskContent: string, parentScenario: ScenarioType): ScenarioMatch {
  const matches = identifyScenarios(taskContent)
  if (matches.length === 0 || (matches[0].type === "code_change" && matches[0].confidence === 0.3)) {
    return { type: parentScenario, confidence: 0.5, matchedKeywords: { exclusive: [], shared: [] } }
  }
  const primary = matches[0]
  if (primary.type === parentScenario) return { ...primary, confidence: Math.min(1, primary.confidence + 0.2) }
  if (primary.confidence > 0.4) return primary
  return { type: parentScenario, confidence: 0.4, matchedKeywords: primary.matchedKeywords }
}
```

#### 场景配置表

```typescript
interface ScenarioConfig {
  type: ScenarioType
  phases: PhaseConfig[]
  maxRoundsPerTask: number
  convergenceThreshold: number
  requiredTools: string[]
  preferredSkills: string[]
  skillAffinity: Record<string, number>  // 技能名 → 亲和度 0-1
}

const SCENARIO_CONFIGS: Record<ScenarioType, ScenarioConfig> = {
  code_change: {
    type: "code_change",
    phases: [
      { name: "ANALYZE", weight: 0.8, required: true, preferredSkills: [] },
      { name: "SKILL", weight: 0.6, required: false, preferredSkills: [] },
      { name: "REVIEW", weight: 0.7, required: true, preferredSkills: [] },
      { name: "FIX", weight: 0.9, required: true, preferredSkills: [] },
      { name: "VERIFY", weight: 0.9, required: true, preferredSkills: [] },
    ],
    maxRoundsPerTask: 5, convergenceThreshold: 5,
    requiredTools: ["Bash", "Edit", "Read"],
    preferredSkills: ["test-driven-development", "verification-before-completion"],
    skillAffinity: {},
  },
  doc_writing: {
    type: "doc_writing",
    phases: [
      { name: "ANALYZE", weight: 0.5, required: true, preferredSkills: [] },
      { name: "SKILL", weight: 0.7, required: false, preferredSkills: ["brainstorming"] },
      { name: "REVIEW", weight: 0.9, required: true, preferredSkills: ["design-doc-reviewer"] },
      { name: "FIX", weight: 0.8, required: true, preferredSkills: [] },
      { name: "VERIFY", weight: 0.4, required: false, preferredSkills: [] },
    ],
    maxRoundsPerTask: 3, convergenceThreshold: 3,
    requiredTools: ["Read", "Write"],
    preferredSkills: ["brainstorming", "design-doc-reviewer", "docs-navigator"],
    skillAffinity: {},
  },
  troubleshooting: {
    type: "troubleshooting",
    phases: [
      { name: "ANALYZE", weight: 1.0, required: true, preferredSkills: ["systematic-debugging"] },
      { name: "SKILL", weight: 0.8, required: true, preferredSkills: ["systematic-debugging"] },
      { name: "REVIEW", weight: 0.6, required: false, preferredSkills: [] },
      { name: "FIX", weight: 0.9, required: true, preferredSkills: [] },
      { name: "VERIFY", weight: 0.9, required: true, preferredSkills: [] },
    ],
    maxRoundsPerTask: 8, convergenceThreshold: 8,
    requiredTools: ["Bash", "Read", "Grep"],
    preferredSkills: ["systematic-debugging", "orion-deep-audit"],
    skillAffinity: {},
  },
  design_improve: {
    type: "design_improve",
    phases: [
      { name: "ANALYZE", weight: 0.9, required: true, preferredSkills: [] },
      { name: "SKILL", weight: 0.9, required: true, preferredSkills: ["brainstorming"] },
      { name: "REVIEW", weight: 0.8, required: true, preferredSkills: ["code-design-analyzer"] },
      { name: "FIX", weight: 0.7, required: true, preferredSkills: [] },
      { name: "VERIFY", weight: 0.5, required: false, preferredSkills: [] },
    ],
    maxRoundsPerTask: 5, convergenceThreshold: 5,
    requiredTools: ["Read", "Write"],
    preferredSkills: ["brainstorming", "design-constraint", "design-doc-reviewer", "code-design-analyzer"],
    skillAffinity: {},
  },
  refactoring: {
    type: "refactoring",
    phases: [
      { name: "ANALYZE", weight: 1.0, required: true, preferredSkills: ["code-design-analyzer"] },
      { name: "SKILL", weight: 0.7, required: false, preferredSkills: [] },
      { name: "REVIEW", weight: 0.9, required: true, preferredSkills: ["code-design-analyzer"] },
      { name: "FIX", weight: 0.8, required: true, preferredSkills: [] },
      { name: "VERIFY", weight: 1.0, required: true, preferredSkills: [] },
    ],
    maxRoundsPerTask: 6, convergenceThreshold: 6,
    requiredTools: ["Bash", "Edit", "Read", "Grep"],
    preferredSkills: ["simplify", "code-design-analyzer", "design-constraint"],
    skillAffinity: {},
  },
}

function getScenarioConfig(type: ScenarioType): ScenarioConfig { return SCENARIO_CONFIGS[type] }
function resolveScenario(objective: string): ScenarioConfig {
  return selectScenarioConfig(identifyScenarios(objective))
}
```

#### 场景-技能亲和矩阵（30+ 技能 × 5 场景）

```typescript
const SKILL_SCENARIO_AFFINITY: Record<string, Record<ScenarioType, number>> = {
  // Superpowers
  "systematic-debugging":    { code_change: 0.3, doc_writing: 0.0, troubleshooting: 1.0, design_improve: 0.1, refactoring: 0.3 },
  "brainstorming":           { code_change: 0.4, doc_writing: 0.3, troubleshooting: 0.1, design_improve: 1.0, refactoring: 0.2 },
  "test-driven-development": { code_change: 0.9, doc_writing: 0.0, troubleshooting: 0.5, design_improve: 0.1, refactoring: 0.8 },
  "verification-before-completion": { code_change: 0.8, doc_writing: 0.4, troubleshooting: 0.6, design_improve: 0.3, refactoring: 0.8 },
  "requesting-code-review":  { code_change: 0.7, doc_writing: 0.3, troubleshooting: 0.4, design_improve: 0.4, refactoring: 0.7 },
  "writing-plans":           { code_change: 0.5, doc_writing: 0.5, troubleshooting: 0.2, design_improve: 0.8, refactoring: 0.6 },
  "executing-plans":         { code_change: 0.7, doc_writing: 0.3, troubleshooting: 0.2, design_improve: 0.4, refactoring: 0.6 },
  // Design
  "design-constraint":       { code_change: 0.5, doc_writing: 0.2, troubleshooting: 0.2, design_improve: 0.9, refactoring: 0.7 },
  "design-doc-reviewer":     { code_change: 0.2, doc_writing: 0.8, troubleshooting: 0.1, design_improve: 0.9, refactoring: 0.3 },
  "code-design-analyzer":    { code_change: 0.4, doc_writing: 0.1, troubleshooting: 0.5, design_improve: 0.8, refactoring: 0.8 },
  "task-decomposer":         { code_change: 0.6, doc_writing: 0.3, troubleshooting: 0.3, design_improve: 0.7, refactoring: 0.5 },
  // Orion
  "orion-deep-audit":        { code_change: 0.5, doc_writing: 0.0, troubleshooting: 0.8, design_improve: 0.4, refactoring: 0.7 },
  "orion-repairing":         { code_change: 0.5, doc_writing: 0.0, troubleshooting: 0.7, design_improve: 0.1, refactoring: 0.4 },
  "orion-reviewing":         { code_change: 0.6, doc_writing: 0.2, troubleshooting: 0.4, design_improve: 0.4, refactoring: 0.6 },
  // Feature Dev
  "feature-dev:feature-dev": { code_change: 0.9, doc_writing: 0.1, troubleshooting: 0.2, design_improve: 0.4, refactoring: 0.4 },
  // Other
  "simplify":                { code_change: 0.3, doc_writing: 0.0, troubleshooting: 0.2, design_improve: 0.2, refactoring: 0.9 },
  "docs-navigator":          { code_change: 0.1, doc_writing: 0.7, troubleshooting: 0.0, design_improve: 0.4, refactoring: 0.1 },
}
```

### 4.4 Convergence Detector（修正版）

**修正说明**（来自算法专家评审）：
1. 信息增益阈值 0.1 → 0.15（0.1 过于严格）
2. 质量稳定用 `|a-b| < 8` 替代方差（2 数据点方差 = (a-b)^2/2，原阈值 5 等价于 |a-b| < 3.16，过于严格）
3. 新增质量门控：qualityScore >= 80 才允许收敛（防止低质量收敛）

#### 信息增益计算

```typescript
// src/utils/goal/goalConvergence.ts

/**
 * 信息增益 [0, 1]。三维度加权：
 * - 工具新颖度 (0.4)：本轮新工具调用比例
 * - 可观测变更 (0.35)：hadObservableChanges（语义重定义，见下方注释）
 * - 输出新颖度 (0.25)：outputSummary 的 Jaccard 距离
 *
 * ⚠️ hadObservableChanges 语义重定义（v3 修复）：
 * 原定义: outputGrew || toolCallsThisTurn.length > 0（几乎永远为 true，丧失区分度）
 * 新定义: 有非只读工具产生了文件系统变更（Write/Edit/FileWrite/Bash 且非 --help）
 * 需要在 goalRuntime.ts 的 recordTurnApiUsage 中更新计算逻辑
 */
function computeInformationGain(current: TurnRecord, previous: TurnRecord | undefined): number {
  if (!previous) return 1.0 // 首轮最大增益

  // 维度 1: 新工具比例
  const curr = new Set(current.toolCallsSummary ?? [])
  const prev = new Set(previous.toolCallsSummary ?? [])
  const novel = [...curr].filter(t => !prev.has(t)).length
  const toolNovelty = curr.size > 0 ? Math.min(novel / curr.size, 1.0) : 0

  // 维度 2: 可观测变更（语义重定义后有意义的二值信号）
  const observable = current.hadObservableChanges ? 1.0 : 0.0

  // 维度 3: 输出新颖度（Jaccard 距离）
  const currText = current.outputSummary ?? ""
  const prevText = previous.outputSummary ?? ""
  // 空输出处理：两个都空 → 相同(0)，一个空一个非空 → 最大差异(1)
  let outputNovelty: number
  if (currText.length === 0 && prevText.length === 0) {
    outputNovelty = 0  // 两个空输出 = 无新信息
  } else if (currText.length === 0 || prevText.length === 0) {
    outputNovelty = 1  // 有/无输出 = 最大差异
  } else {
    const currWords = tokenize(currText)
    const prevWords = tokenize(prevText)
    const intersection = [...currWords].filter(w => prevWords.has(w))
    const union = new Set([...currWords, ...prevWords])
    const jaccard = union.size === 0 ? 1.0 : intersection.length / union.size
    outputNovelty = 1.0 - jaccard
  }

  return Math.max(0, Math.min(1, 0.4 * toolNovelty + 0.35 * observable + 0.25 * outputNovelty))
}

function tokenize(text: string): Set<string> {
  const STOP = new Set(["the","a","an","is","are","was","were","be","been","have","has","had","do","does","did","will","would","could","should","may","might","can","shall","i","you","he","she","it","we","they","this","that","to","of","in","for","on","with","at","by","from","as","not","or","and","but","if","then","so"])
  const lower = text.toLowerCase()
  // 英文: 按空格/标点分词
  const englishWords = lower.replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(w => w.length > 1 && !STOP.has(w))
  // 中文: 按字符 bigram 分词（中文无空格分隔，bigram 捕获语义单元）
  const chineseChars = lower.replace(/[^\u4e00-\u9fff]+/g, "")
  const chineseBigrams: string[] = []
  for (let i = 0; i < chineseChars.length - 1; i++) {
    chineseBigrams.push(chineseChars.slice(i, i + 2))
  }
  // 单字也保留（高频语素）
  const chineseUnigrams = [...chineseChars]
  return new Set([...englishWords, ...chineseBigrams, ...chineseUnigrams])
}
```

#### 质量分数计算

```typescript
/**
 * 质量分数 [0, 100]。四维度按场景加权。
 * 基于 outputSummary 的关键词模式匹配。
 *
 * ⚠️ v3 修复：使用负向环视避免 "no error" 假阴性
 * 原问题: /error/ 匹配 "no error" → buildScore=0，实际应为 100
 */
function computeQualityScore(turn: TurnRecord, scenario: ScenarioType): number {
  const weights = SCENARIO_QUALITY_WEIGHTS[scenario]
  const output = (turn.outputSummary ?? "").toLowerCase()

  // 构建状态：错误模式使用负向环视排除 "no error" / "0 errors" 等否定语境
  const hasBuildError = /(?<!no |0 )(?:: error|build failed|syntax error|type error)/.test(output)
  const hasBuildSuccess = /build successful|compiled successfully|no errors|0 errors/.test(output)
  const buildScore = hasBuildError ? 0 : hasBuildSuccess ? 100 : 70

  // 测试状态
  const hasTestError = /test failed|assertion error|failing/.test(output)
  const hasTestSuccess = /test passed|all tests pass|passing|0 failing/.test(output)
  const testScore = hasTestError ? 0 : hasTestSuccess ? 100 : 60

  // 审查分数：错误计数（排除否定语境）
  const errorIndicators = [
    "i cannot", "i can't", "permission denied", "error occurred",
    "failed to", "connection refused"
  ]
  const errorCount = errorIndicators.filter(p => output.includes(p)).length
  const reviewScore = Math.max(0, 100 - errorCount * 30)

  // 回归分数
  const hasRegression = /regression|broke|broken|previously working/.test(output)
  const regressionScore = hasRegression ? 0 : 100

  return Math.round(
    weights.buildStatus * buildScore +
    weights.testPassing * testScore +
    weights.reviewResult * reviewScore +
    weights.noRegression * regressionScore
  )
}

const SCENARIO_QUALITY_WEIGHTS: Record<ScenarioType, { buildStatus: number; testPassing: number; reviewResult: number; noRegression: number }> = {
  code_change:     { buildStatus: 0.30, testPassing: 0.35, reviewResult: 0.20, noRegression: 0.15 },
  doc_writing:     { buildStatus: 0.05, testPassing: 0.10, reviewResult: 0.55, noRegression: 0.30 },
  troubleshooting: { buildStatus: 0.15, testPassing: 0.20, reviewResult: 0.25, noRegression: 0.40 },
  design_improve:  { buildStatus: 0.10, testPassing: 0.15, reviewResult: 0.50, noRegression: 0.25 },
  refactoring:     { buildStatus: 0.25, testPassing: 0.40, reviewResult: 0.20, noRegression: 0.15 },
}
```

#### 变更幅度计算

```typescript
/**
 * 变更幅度 [0, 100]。按工具类型估算文件数和行数，对数缩放。
 * 无 hadObservableChanges 时返回 0。
 */
function computeChangeMagnitude(turn: TurnRecord): number {
  if (!turn.hadObservableChanges) return 0
  let files = 0, lines = 0
  for (const tool of turn.toolCallsSummary ?? []) {
    if (tool === "Write" || tool === "FileWrite") { files++; lines += 50 }
    else if (tool === "Edit" || tool === "FileEdit") { files++; lines += 20 }
    else if (tool === "Bash") { lines += 5 }
  }
  const fileScore = Math.log2(1 + files) / Math.log2(21)
  const lineScore = Math.log2(1 + lines) / Math.log2(501)
  return Math.round(Math.max(0, Math.min(100, (0.4 * fileScore + 0.6 * lineScore) * 100)))
}
```

#### 收敛检测

```typescript
interface ConvergenceState {
  informationGains: number[]  // 滑动窗口 5
  qualityScores: number[]
  changeMagnitudes: number[]
  round: number
}

/**
 * ⚠️ v3 修复：
 * 1. 纯分析轮保护：changesMinimal 必须至少有 1 轮 hadObservableChanges=true 才触发
 * 2. maxRounds 质量门控：低质量但达到 maxRounds → 暂停而非收敛
 * 3. 窗口大小自适应：WINDOW = min(5, maxRounds)
 */
function checkConvergence(state: ConvergenceState, maxRounds: number = 5): ConvergenceResult {
  const { informationGains: ig, qualityScores: qs, changeMagnitudes: cm, round } = state

  const infoGainConverged = ig.length >= 2 && ig.slice(-2).every(g => g < 0.15)
  const qualityStable = qs.length >= 2 && Math.abs(qs[qs.length-1] - qs[qs.length-2]) < 8
  const qualityAbove = qs.length >= 1 && qs[qs.length-1] >= 80
  const changesMinimal = cm.length >= 1 && cm[cm.length-1] < 3
  // 纯分析轮保护：至少有 1 轮产生了实际变更（changeMagnitude > 0）
  const hasHadChanges = cm.some(m => m > 0)

  if (qualityAbove) {
    if (infoGainConverged && qualityStable) return { converged: true, reason: "info_gain_stable" }
    // changesMinimal 收敛需要至少有过一次实际变更（防止纯分析轮过早收敛）
    if (changesMinimal && qualityStable && hasHadChanges) return { converged: true, reason: "changes_minimal" }
  }

  // maxRounds 质量门控：达到上限时，高质量→收敛，低质量→暂停（由 orchestrator 决策）
  if (round >= maxRounds) {
    if (qualityAbove) return { converged: true, reason: "max_rounds" }
    return { converged: true, reason: "max_rounds_low_quality" } // orchestrator 应将其映射为 pause
  }

  return { converged: false }
}

function updateConvergenceState(state: ConvergenceState, current: TurnRecord, prev: TurnRecord | undefined, scenario: ScenarioType, maxRounds: number = 5): void {
  const WINDOW = Math.min(5, maxRounds)  // 窗口自适应：不超过 maxRounds
  state.informationGains.push(computeInformationGain(current, prev))
  state.qualityScores.push(computeQualityScore(current, scenario))
  state.changeMagnitudes.push(computeChangeMagnitude(current))
  state.round++
  if (state.informationGains.length > WINDOW) state.informationGains.shift()
  if (state.qualityScores.length > WINDOW) state.qualityScores.shift()
  if (state.changeMagnitudes.length > WINDOW) state.changeMagnitudes.shift()
}
```

### 4.5 统一错误追踪系统（UnifiedErrorTracker）

**根因 (RC3)**: 3 个现有计数器 + 2 个新增 = 5 套并行计数器，重置条件不一致。

**v3 修复**: 将 `ErrorScenario` 拆分为 `ErrorCategory`（错误原因）和 `RecoveryLayer`（恢复策略），消除概念混淆。

```typescript
// src/utils/goal/goalErrorTracker.ts

/** 错误类别：描述发生了什么（只用于计数和检测） */
type ErrorCategory =
  | "runtime_exception"    // catch 块异常（代码 bug）
  | "dead_turn"            // 无可观测变更
  | "critical_analysis"    // 分析结果 critical

/** 恢复层级：描述正在尝试什么（只用于决策） */
type RecoveryLayer = "FIX_RETRY" | "SKILL_RETRY" | "FULL_RESTART"

interface ErrorCategoryCounter {
  count: number
  threshold: number
}

interface UnifiedErrorTracker {
  categories: Record<ErrorCategory, ErrorCategoryCounter>  // 用 Record 而非 Map，兼容序列化
  recoveryLayer: RecoveryLayer
  fullRestartUsed: boolean
}

const DEFAULT_THRESHOLDS: Record<ErrorCategory, number> = {
  runtime_exception: 3,
  dead_turn: 5,
  critical_analysis: 3,
}

/** tracker 只负责计数和检测，不返回决策 */
function recordError(tracker: UnifiedErrorTracker, category: ErrorCategory): void { /* count++ */ }
function resetCategory(tracker: UnifiedErrorTracker, category: ErrorCategory): void { /* count=0 */ }
function resetOnProgress(tracker: UnifiedErrorTracker): void { /* dead_turn=0, consecutive_failure=0 */ }
function shouldPause(tracker: UnifiedErrorTracker): boolean { /* 任一类别超阈值 */ }
```

**与现有代码的映射**：

| 现有代码 | 替换为 |
|---------|--------|
| `runtime.consecutiveErrors++` (catch 块) | `recordError(tracker, "runtime_exception")` |
| `turnsWithNoChanges++` / `= 0` | `recordError(tracker, "dead_turn")` / `resetOnProgress(tracker)` |
| `consecutiveCritical++` | `recordError(tracker, "critical_analysis")` |
| `getAutoPauseCriticalThreshold()` | 移除，阈值在 `DEFAULT_THRESHOLDS` |
| `getDeadTurnLimit()` | 移除，阈值在 `DEFAULT_THRESHOLDS` |

### 4.6 错误恢复状态机

**职责边界**: tracker 负责"计数和检测"，recovery 负责"决策和生成 prompt"。recovery 读取 tracker 状态，返回 `RecoveryDecision`。

```typescript
// src/utils/goal/goalErrorRecovery.ts

interface RecoveryDecision {
  action: "retry" | "escalate" | "pause" | "continue"
  layer: RecoveryLayer
  recoveryPrompt?: string
}

/**
 * 恢复层级升级逻辑：
 * FIX_RETRY 3 次 → 升级到 SKILL_RETRY
 * SKILL_RETRY 3 次 → 升级到 FULL_RESTART
 * FULL_RESTART 1 次 → 暂停
 *
 * ⚠️ recovery 读取 tracker 的 categories 计数来决定升级，不自行维护计数。
 */
function handleVerifyFailure(tracker: UnifiedErrorTracker, detail: string): RecoveryDecision { /* ... */ }
function handleReviewRejection(tracker: UnifiedErrorTracker, reason: string): RecoveryDecision { /* ... */ }
function handleFullRestart(tracker: UnifiedErrorTracker, context: string): RecoveryDecision { /* ... */ }
function resetRecovery(tracker: UnifiedErrorTracker): void {
  tracker.recoveryLayer = "FIX_RETRY"
  resetCategory(tracker, "runtime_exception")
  resetOnProgress(tracker)
}
```

```typescript
// src/utils/goal/goalErrorRecovery.ts

interface RecoveryDecision {
  action: "retry" | "escalate" | "pause" | "continue"
  layer: "FIX_RETRY" | "SKILL_RETRY" | "FULL_RESTART"
  recoveryPrompt?: string
}

function handleVerifyFailure(tracker: UnifiedErrorTracker, detail: string): RecoveryDecision { /* ... */ }
function handleReviewRejection(tracker: UnifiedErrorTracker, reason: string): RecoveryDecision { /* ... */ }
function handleFullRestart(tracker: UnifiedErrorTracker, context: string): RecoveryDecision { /* ... */ }
function resetRecovery(tracker: UnifiedErrorTracker): void {
  tracker.recoveryLayer = "FIX_RETRY"
  resetScenario(tracker, "fix_retry"); resetScenario(tracker, "skill_retry")
  resetOnProgress(tracker)
}
```

### 4.7 Skills-Tools 适配（独立排名）

**根因 (RC4)**: Skills 是 Command 不是 Tool，类型不匹配。

**解决方案**: 选择方案 B — 独立 `rankSkills()` 纯函数，与 `rankTools()` 完全解耦。

```typescript
// src/utils/goal/goalSkillRanker.ts

/**
 * 独立的技能排名函数。评分权重与 toolRanker 对齐。
 * 结果注入 continuation prompt 的 "Recommended Skills" 区块。
 */
function rankSkills(
  query: string,
  availableSkills: SkillMetadata[],
  scenario: ScenarioConfig,
  limit: number = 5,
): RankedSkill[] {
  const terms = extractTerms(query)
  return availableSkills
    .map(skill => ({
      skill,
      score: scoreSkill(skill, terms, scenario),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

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

### 4.8 Skill Registry Scanner（新增）

```typescript
// src/utils/goal/skillRegistry.ts（新建，复用现有 skillChangeDetector 机制）

interface SkillMetadata {
  name: string; path: string; description: string
  triggers: string[]; priority: number; conflictsWith: string[]
  lastModified: number
}

/**
 * 启动时扫描 ~/.ola-cc/skills/*/SKILL.md。
 * 容错解析：缺少 frontmatter 的跳过，缺少可选字段的用默认值。
 */
async function scanSkillRegistry(): Promise<SkillMetadata[]> {
  const skillDirs = await glob("~/.ola-cc/skills/*/SKILL.md")
  const results: SkillMetadata[] = []
  for (const path of skillDirs) {
    try {
      const content = await readFile(path)
      const frontmatter = parseFrontmatter(content)
      if (!frontmatter.name) continue
      results.push({
        name: frontmatter.name,
        path,
        description: frontmatter.description ?? "",
        triggers: parseTriggers(frontmatter.trigger ?? ""),
        priority: parseInt(frontmatter.priority ?? "0", 10) || 0,
        conflictsWith: (frontmatter["conflicts-with"] ?? "").split(",").map(s => s.trim()).filter(Boolean),
        lastModified: (await stat(path)).mtimeMs,
      })
    } catch { /* 跳过损坏文件 */ }
  }
  return results
}

/** 模块级缓存 + 复用 skillChangeDetector 的文件变化监听 */
let cachedSkills: SkillMetadata[] | null = null
let cacheTimestamp = 0

async function getSkillMetadata(): Promise<SkillMetadata[]> {
  if (cachedSkills && Date.now() - cacheTimestamp < 30_000) return cachedSkills  // 30s 缓存
  cachedSkills = await scanSkillRegistry()
  cacheTimestamp = Date.now()
  return cachedSkills
}

// 监听 skillChangeDetector 的文件变化事件，失效缓存
// skillChangeDetector.ts 已有 chokidar 监听机制，复用其事件
```

### 4.9 CodeGraph + Grok 集成

#### 调用协议

- **首轮 ANALYZE 必调**：CodeGraph 初始化 + 基础扫描
- **FIX 引入新文件时调用**：impact analysis
- **每任务上限**：2 次 CodeGraph / 1 次 Grok
- **防抖**：30 秒内不重复调用同一工具
- **超时**：CodeGraph 10 秒，Grok 15 秒

#### 降级策略

| 工具 | 检测方式 | 降级行为 |
|------|---------|---------|
| CodeGraph 未初始化 | `codegraph_status` → 未初始化 | 自动 init → 失败则跳过，用 Grep/Glob |
| CodeGraph 查询超时 | subprocess timeout 10s | 跳过该查询，继续其他分析 |
| Grok 未生成图谱 | `grok_status` → 无图谱 | 跳过，用 model 自身知识 |
| Agent spawn 失败 | spawn 返回错误 | 跳过子 agent，model 做 self-review |
| Skill 调用失败 | Skill tool 返回错误 | 跳过，选择下一个匹配技能 |

#### 结果注入

CodeGraph/Grok 结果注入 continuation prompt（不占 system prompt），截断到 2000 字符。

### 4.10 Task Auto-Advance 移除（已完成）

**已完成的修改**:
- `goalRuntime.ts`: 移除 auto-advance
- `goalSteering.ts`: 添加 "You MUST call TodoWrite" 指令 + currentTask 注入

**⚠️ v3 发现的代码不一致**: `goalRuntime.ts` 中 `autoProgressTasks` 和 `autoAdvanceGoalTasks` 函数仍然保留（行 178-267），且 `turn_started` 事件中仍在调用（行 309-326），与注释"Removed"不一致。**Phase 2 实现前必须清理此代码。**

### 4.11 TodoWrite 与 Orchestrator 交互（v3 新增）

**问题**: 当前 goalRuntime 不监听 TodoWrite 工具调用，任务完成检测依赖 `turn_finished` 被动检查。如果模型忽略"所有任务已完成"的 prompt，goal 永远不会完成。

**设计**: `goalOrchestrator` 在 `turn_finished` 时主动检测任务状态变化。

```
TodoWrite 调用 → 更新 AppState.todos
    ↓
turn_finished → goalOrchestrator.checkTaskProgress(todos, currentTask)
    ↓
    ├─ 所有任务完成 → OrchestratorDecision { action: "continue", prompt: "Call update_goal(complete)" }
    ├─ 当前任务完成但有后续 → OrchestratorDecision { action: "continue", prompt: "Start next task" }
    ├─ 当前任务无进展 + 连续 N 轮 → OrchestratorDecision { action: "retry", prompt: "Retry with different approach" }
    └─ 模型添加了新任务 → 正常继续（动态任务分解是预期行为）
```

**关键**: orchestrator 不直接调用 TodoWrite 或 update_goal，只通过 prompt 引导模型行为。goalRuntime 根据 decision 执行状态更新。

### 4.12 hadObservableChanges 语义重定义（v3 新增）

**问题**: 当前定义 `outputGrew || toolCallsThisTurn.length > 0` 几乎永远为 true（只要有 tool call），导致信息增益的 0.35 权重维度丧失区分度。

**新定义**: 有非只读工具产生了文件系统变更。

```typescript
// goalRuntime.ts 中的计算逻辑更新
const WRITE_TOOLS = new Set(["Write", "FileWrite", "Edit", "FileEdit"])
const hasFileSystemChanges = toolCallsThisTurn.some(t => WRITE_TOOLS.has(t))
const hadObservableChanges = hasFileSystemChanges || (outputGrew && outputTokens > 100)
```

**影响**: 纯分析轮（Read + Grep + Agent）的 `hadObservableChanges` 为 false，信息增益的 observable 维度为 0，降低该轮的信息增益值，更准确反映"这轮没有产生实际进展"。

## 5. 熔断器

```typescript
// 场景特定阈值
const SCENARIO_CIRCUIT_BREAKER: Record<ScenarioType, { maxPerTask: number; timeoutMs: number }> = {
  code_change:     { maxPerTask: 5,  timeoutMs: 20 * 60 * 1000 },
  doc_writing:     { maxPerTask: 3,  timeoutMs: 15 * 60 * 1000 },
  troubleshooting: { maxPerTask: 8,  timeoutMs: 45 * 60 * 1000 },
  design_improve:  { maxPerTask: 5,  timeoutMs: 25 * 60 * 1000 },
  refactoring:     { maxPerTask: 6,  timeoutMs: 30 * 60 * 1000 },
}
```

**全局限制**: maxTotalRounds=50, maxConsecutiveFailures=3, maxTimeoutMs=30min（可通过环境变量覆盖）。

**触发行为**:
- 超过 `maxPerTask` → 跳过当前任务，标记 "skipped"，继续下一个
- 超过 `maxConsecutiveFailures` → 暂停 goal，输出诊断信息
- 超过 `maxTimeoutMs` → 自动暂停，保存进度
- 超过 `maxTotalRounds` → 完成已完成的任务，暂停剩余

## 6. 实现路线图

```
Phase 1 (已完成) ──→ Phase 2 (场景感知) ──→ Phase 5 (CodeGraph/Grok)
                   ──→ Phase 3 (收敛检测)  ↗
                   ──→ Phase 4 (技能发现) ──┘
```

### Phase 1: 基础加固（已完成）

- [x] 移除 auto-advance，改为 model-driven
- [x] ReAct 模板写入 goalSteering.ts
- [x] currentTask 注入逻辑

### Phase 2: 场景感知 + 模块提取

- [ ] goalScenario.ts — 场景识别 + 配置查表
- [ ] goalReActObserver.ts — ReAct 阶段观测
- [ ] goalRuntime.ts 精简（450→200 行）
- [ ] GoalRuntimeState 扩展（可选字段，向后兼容）

### Phase 3: 收敛检测 + 统一错误追踪

- [ ] goalConvergence.ts — 三维收敛检测
- [ ] goalErrorTracker.ts — 统一错误追踪
- [ ] goalErrorRecovery.ts — 三层恢复状态机
- [ ] goalOrchestrator.ts — 编排器整合

### Phase 4: 技能自动发现

- [ ] localSearch.ts 重写 — SKILL.md 扫描
- [ ] goalSkillRanker.ts — 独立技能排名
- [ ] 亲和矩阵配置
- [ ] continuation prompt 注入推荐技能

### Phase 5: CodeGraph + Grok 深度集成

- [ ] ANALYZE 步骤主动调用
- [ ] 降级策略实现
- [ ] 结果注入 continuation prompt

## 7. 测试策略

### 单元测试

| 组件 | 测试用例 |
|------|---------|
| 场景识别 | "fix the code style" → code_change（排除 shared 误判） |
| 场景识别 | "重构 auth 模块并修复 bug" → 混合场景 refactoring + troubleshooting |
| 场景识别 | "排查生产环境内存泄漏" → troubleshooting（纯中文） |
| 场景识别 | 空 objective → code_change（兜底） |
| 场景识别 | 置信度恰好 0.3/0.7 边界值 → 混合/单一场景选择 |
| 场景识别 | "排查 bug 并重构代码" → 两场景置信度相近时的优先级 |
| 收敛检测 | 信息增益连续 2 轮 < 0.15 + 质量 >= 80 → converged |
| 收敛检测 | 只有 1 轮数据 → not converged |
| 收敛检测 | max_rounds + 高质量 → converged |
| 收敛检测 | max_rounds + 低质量 → max_rounds_low_quality（orchestrator 映射为 pause） |
| 收敛检测 | 纯分析轮（hadObservableChanges=false）→ changesMinimal 不触发收敛 |
| 收敛检测 | outputSummary 为空 → outputNovelty=0（非 0.5，两个都空=无新信息） |
| 收敛检测 | maxRounds=3 时窗口大小自适应为 3 |
| 信息增益 | 中文 objective → bigram 分词正确工作 |
| 信息增益 | "no error" → 不误判为错误信号 |
| 质量分数 | "build failed, no errors" → buildScore=0（"no errors" 不覆盖 "build failed"） |
| 质量分数 | "no error found, all tests pass" → buildScore=100, testScore=100 |
| 质量分数 | 无信号 → 乐观默认（60-70） |
| 错误追踪 | runtime_exception 3 次 → shouldPause=true |
| 错误追踪 | dead_turn 5 次 → shouldPause=true |
| 错误追踪 | recovery FIX_RETRY 3 次 → 升级到 SKILL_RETRY |
| 错误追踪 | recovery FULL_RESTART 用尽 → pause |
| 技能扫描 | 缺少 frontmatter → 跳过 |
| 技能扫描 | 缺少可选字段 → 默认值 |
| 技能排名 | 场景亲和度影响排名（troubleshooting 场景 → systematic-debugging 排名高） |

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
| 技能排名 (100+ 技能) | < 50ms |
| 每轮增加 token | < 3000 tokens |

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 多轮执行消耗过多 token | 中 | 成本增加 | tokenBudget + 场景特定熔断器 |
| 技能选择错误导致方向偏离 | 中 | 浪费轮次 | REVIEW 步骤纠正 + 收敛检测 |
| CodeGraph/Grok 不可用频率高 | 低 | 降级频繁 | 4 级降级（auto init → skip → grep → mark unavailable） |
| 场景识别错误 | 低 | 配置不匹配 | 置信度评分 + 混合场景 + code_change 兜底 |
| goalRuntime.ts 改造风险 | 中 | 回归 | 模块提取，旧字段保留 @deprecated |
| 每轮 token 增加 ~1300-3300 | 中 | 预算消耗 | 结果截断 2000 字符，可选注入 |
| ~~hadObservableChanges 语义失效~~ | ~~高~~ | ~~收敛维度失效~~ | ✅ v3 已修复：重定义为文件系统变更 |
| ~~中文分词失效~~ | ~~高~~ | ~~信息增益计算错误~~ | ✅ v3 已修复：bigram + unigram 分词 |
| ~~"no error" 假阴性~~ | ~~中~~ | ~~质量分数误判~~ | ✅ v3 已修复：负向环视排除否定语境 |
| ~~纯分析轮过早收敛~~ | ~~中~~ | ~~任务未完成就收敛~~ | ✅ v3 已修复：hasHadChanges 保护 |
| TodoWrite 与 orchestrator 脱节 | 中 | goal 不完成 | v3 新增交互设计（4.11） |
| GoalRuntimeState 嵌套对象序列化 | 低 | 状态丢失 | 使用 Record 替代 Map |
| autoProgressTasks 代码未清理 | 低 | 与注释不一致 | Phase 2 实现前删除废弃代码 |
