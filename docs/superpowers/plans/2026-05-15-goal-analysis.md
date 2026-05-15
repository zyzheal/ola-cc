# Goal 智能分析实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Goal 系统添加智能执行分析能力，在每轮结束后进行轻量级规则检测，检测到问题时注入分析上下文

**Architecture:** 采用两层分析架构：1) 轻量级规则分析 (goalAnalysis.ts) 在 turn_finished 时执行；2) 检测到问题时在下一轮开始前注入分析提示到 continuation prompt

**Tech Stack:** TypeScript, 内置 Agent 系统 (BuiltInAgentDefinition)

---

### Task 1: 扩展 TurnRecord 和 GoalRuntimeState 类型

**Files:**
- Modify: `src/commands/goal/types.ts:12-19`
- Modify: `src/commands/goal/types.ts:50-63`

- [ ] **Step 1: 添加 TurnRecord 新字段**

在 `TurnRecord` 接口中添加:
```typescript
export interface TurnRecord {
  turnId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  wallStartMs: number
  wallEndMs: number
  // NEW: Execution summary for analysis
  toolCallsSummary?: string[]   // Tool names called this turn
  outputSummary?: string        // Output summary (first 200 chars)
  hadObservableChanges?: boolean
}
```

- [ ] **Step 2: 添加 GoalRuntimeState 新字段**

在 `GoalRuntimeState` 接口末尾添加:
```typescript
export interface GoalRuntimeState {
  accounting: {
    turn: { turnId: string; lastTokenUsage: TokenUsage; activeGoalId: string | null } | null
    wallClock: { lastAccountedAt: number; activeGoalId: string | null }
  }
  budgetLimitReportedGoalId: string | null
  continuationTurnId: string | null
  turnBuffer: TurnRecord[]        // Ring buffer, max 3
  totalApiTokens: number           // Sum of API response tokens
  totalApiWallMs: number           // Sum of API wall time
  consecutiveErrors: number        // Consecutive error counter
  turnsWithNoChanges: number       // Turns with no observable changes
  _currentTurnWallStartMs: number  // Internal: track current turn API start

  // NEW: Pending analysis request
  pendingAnalysis?: {
    reason: string
    severity: 'warning' | 'critical'
    triggerTurnId: string
  }

  // NEW: Last analysis result (persists across turns)
  lastAnalysisResult?: string
}
```

- [ ] **Step 3: 提交**

```bash
git add src/commands/goal/types.ts
git commit -m "feat(goal): add analysis fields to TurnRecord and GoalRuntimeState"
```

---

### Task 2: 创建 goalAnalysis.ts 轻量分析模块

**Files:**
- Create: `src/utils/goal/goalAnalysis.ts`

- [ ] **Step 1: 编写轻量分析函数**

```typescript
import type { TurnRecord } from '../../commands/goal/types.js'

const WARNING_PATTERNS = [
  'i cannot', 'blocked', 'permission denied',
  'error', 'failed', 'unable to', 'not allowed'
] as const

export interface LightweightAnalysisResult {
  status: 'ok' | 'warning' | 'critical'
  reason?: string
}

/**
 * Lightweight rule-based analysis after each turn.
 * Returns analysis status without spawning an Agent.
 */
export function analyzeTurnLightweight(
  turnRecord: TurnRecord | undefined,
  previousTurnsWithNoChanges: number
): LightweightAnalysisResult {
  // No turn record yet - first turn
  if (!turnRecord) {
    return { status: 'ok' }
  }

  // 1. Error pattern detection
  const outputLower = turnRecord.outputSummary?.toLowerCase() ?? ''
  const hasError = WARNING_PATTERNS.some(p => outputLower.includes(p))

  // 2. Tool call presence
  const hasToolCalls = (turnRecord.toolCallsSummary?.length ?? 0) > 0

  // 3. Observable changes
  const hasChanges = turnRecord.hadObservableChanges ?? false

  // 4. Stall detection
  const isStalled = previousTurnsWithNoChanges >= 2

  // Decision tree
  if (hasError && !hasChanges) {
    return { status: 'critical', reason: 'Errors with no progress' }
  }
  if (!hasToolCalls && !hasChanges) {
    return { status: 'warning', reason: 'No tool calls or changes this turn' }
  }
  if (isStalled && !hasChanges) {
    return { status: 'warning', reason: 'Stalled for multiple turns' }
  }

  return { status: 'ok' }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/utils/goal/goalAnalysis.ts
git commit -m "feat(goal): add lightweight analysis module"
```

---

### Task 3: 在 goalRuntime.ts 中集成轻量分析

**Files:**
- Modify: `src/utils/goal/goalRuntime.ts:245-343`

- [ ] **Step 1: 添加 import**

在文件顶部添加:
```typescript
import { analyzeTurnLightweight } from './goalAnalysis.js'
```

- [ ] **Step 2: 在 turn_finished 事件中调用轻量分析**

在 `case 'turn_finished':` 处理中，找到 `runtime.turnsWithNoChanges = turnsWithNoChanges` 之后（约第270行），添加：

```typescript
      // Lightweight analysis after turn completion
      const analysisResult = analyzeTurnLightweight(
        runtime.turnBuffer?.[runtime.turnBuffer.length - 1],
        turnsWithNoChanges
      )

      if (analysisResult.status !== 'ok') {
        runtime.pendingAnalysis = {
          reason: analysisResult.reason ?? 'Analysis needed',
          severity: analysisResult.status === 'critical' ? 'critical' : 'warning',
          triggerTurnId: lastTurn?.turnId ?? 'unknown'
        }
      }
```

- [ ] **Step 3: 提交**

```bash
git add src/utils/goal/goalRuntime.ts
git commit -m "feat(goal): integrate lightweight analysis in turn_finished"
```

---

### Task 4: 在 goalSteering.ts 中添加分析提示构建

**Files:**
- Modify: `src/utils/goal/goalSteering.ts:1-161`

- [ ] **Step 1: 添加 PendingAnalysis 类型和构建函数**

在文件末尾添加:
```typescript
interface PendingAnalysis {
  reason: string
  severity: 'warning' | 'critical'
  triggerTurnId: string
}

export function buildAnalysisPrompt(pending: PendingAnalysis): string {
  const severity = pending.severity.toUpperCase()
  return `
<analysis_context>
[${severity}] Previous turn flagged: ${pending.reason}
Triggered at turn: ${pending.triggerTurnId}
</analysis_context>

Before continuing, address the above issue.
Consider: adjust strategy, try different approach, or /goal pause if blocked.
`
}
```

- [ ] **Step 2: 提交**

```bash
git add src/utils/goal/goalSteering.ts
git commit -m "feat(goal): add analysis prompt builder"
```

---

### Task 5: 在 query.ts 中集成 pendingAnalysis 检查

**Files:**
- Modify: `src/query.ts` (需要找到正确的位置)

- [ ] **Step 1: 找到注入 prompt 的位置**

搜索 `buildContinuationPrompt` 在 query.ts 中的使用位置:
```bash
grep -n "buildContinuationPrompt" src/query.ts
```

- [ ] **Step 2: 在 continuation prompt 注入前检查 pendingAnalysis**

找到注入 continuation prompt 的位置，添加检查:
```typescript
import { buildAnalysisPrompt } from './utils/goal/goalSteering.js'

// 在构建 continuation prompt 之前:
const runtime = appState.goalRuntime
let analysisPrompt = ''
if (runtime?.pendingAnalysis && appState.goal?.status === 'active') {
  analysisPrompt = buildAnalysisPrompt(runtime.pendingAnalysis) + '\n\n'

  // Clear pending analysis after building prompt
  runtime.pendingAnalysis = undefined
  runtime.lastAnalysisResult = pendingAnalysisReason
}

// 然后将 analysisPrompt 注入到 continuation prompt 中
```

- [ ] **Step 3: 提交**

```bash
git add src/query.ts
git commit -m "feat(goal): check pendingAnalysis before turn execution"
```

---

### Task 6: (可选) 创建 Goal Analysis 内置 Agent

**Note:** 这个任务可选，根据设计 Spec，当前的 lightweight analysis + prompt injection 已经可以工作。完整的 Analysis Agent 需要更多工作来集成到 Agent 系统中。

**Files:**
- Create: `src/tools/AgentTool/built-in/goalAnalysisAgent.ts`
- Modify: `src/tools/AgentTool/builtInAgents.ts`

- [ ] **Step 1: 创建 goalAnalysisAgent.ts**

```typescript
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

const GOAL_ANALYSIS_SYSTEM_PROMPT = `You are analyzing execution trace for an AI agent working toward a goal.

Analyze:
1. Progress: Is the agent making measurable progress?
2. Pattern: Any recurring issues (errors, empty outputs)?
3. Direction: Is current approach effective?

Output format:
- If progressing: "CONTINUE: [brief encouragement]"
- If adjust needed: "ADJUST: [specific next-step recommendation]"
- If pause needed: "PAUSE: [reason] + /goal pause suggestion"
`

export const GOAL_ANALYSIS_AGENT: BuiltInAgentDefinition = {
  agentType: 'goal-analysis',
  whenToUse: 'When goal execution has stalled or produced errors',
  source: 'built-in',
  baseDir: 'built-in',
  model: 'haiku',
  disallowedTools: ['FileEdit', 'FileWrite', 'Bash', 'Edit', 'Write'],
  getSystemPrompt: () => GOAL_ANALYSIS_SYSTEM_PROMPT,
}
```

- [ ] **Step 2: 注册 Agent**

在 `builtInAgents.ts` 中添加导入和注册

- [ ] **Step 3: 提交**

```bash
git add src/tools/AgentTool/built-in/goalAnalysisAgent.ts src/tools/AgentTool/builtInAgents.ts
git commit -m "feat(goal): add goal analysis built-in agent"
```

---

## 依赖关系

```
Task 1 (类型扩展)
    ↓
Task 2 (goalAnalysis.ts) ← Task 1 的类型
    ↓
Task 3 (goalRuntime.ts 集成) ← Task 2 的函数
    ↓
Task 4 (goalSteering.ts) ← 独立的提示构建
    ↓
Task 5 (query.ts 集成) ← Task 4 的函数
```

---

## Spec 覆盖检查

- [x] TurnRecord 扩展 (Task 1)
- [x] GoalRuntimeState 扩展 (Task 1)
- [x] goalAnalysis.ts 轻量分析 (Task 2)
- [x] goalRuntime.ts 集成 (Task 3)
- [x] goalSteering.ts 分析提示 (Task 4)
- [x] query.ts 集成 (Task 5)
- [x] Analysis Agent (Task 6 - 可选)