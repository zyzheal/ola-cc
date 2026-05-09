# Goal Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `/goal` command for Codex to work autonomously toward durable objectives across multiple turns, solving: premature completion, state management chaos, infinite loops, token explosion, and frequent manual intervention.

**Reference:** OpenAI Codex `/goal` implementation (`codex-rs/core/src/goals.rs`)

**Problem Solved:**
- 模型提前宣布完成 → 强制要求调用 `update_goal` 工具 + continuation prompt
- 状态管理错乱 → StateDb 持久化 + `GoalAccountingSnapshot` 运行时状态
- 循环卡死 → `BudgetLimitSteering` + 预算耗尽自动停止
- Token 消耗巨大 → `token_budget` 预算限制 + 到达后注入 steering prompt
- 频繁人工干预 → `MaybeContinueIfIdle` 自动继续 + 无需用户确认

**Architecture:** This feature adds a new slash command that manages a goal state persisted in AppState with dual-budget accounting (token + time). The goal system integrates with the main query loop to enable autonomous multi-turn execution via continuation prompts injected after each turn.

**Key Codex-Inspired Design:**
1. **Continuation Prompt** - After each turn, inject hidden developer message to continue goal
2. **Dual Budget** - Track both token usage and wall-clock time
3. **Budget Limit Steering** - When budget exhausted, inject special prompt to wrap up
4. **State Machine** - Active → Paused → BudgetLimited → Complete
5. **update_goal Tool** - Model must explicitly call tool to complete/pause

---

## File Structure

```
src/
├── commands/goal/
│   ├── index.ts                    # Command export (follows effort/index.ts pattern)
│   ├── goal.tsx                    # Main command component with UI
│   ├── types.ts                    # Goal-related types (ThreadGoalStatus, etc.)
│   └── templates/
│       ├── continuation.md         # Continuation prompt template
│       └── budget_limit.md         # Budget exhausted prompt template
├── state/
│   └── AppStateStore.ts            # Add goal state + accounting
├── utils/
│   └── goal/
│       ├── goalEngine.ts           # Core goal execution logic (follows Codex pattern)
│       ├── goalAccounting.ts       # Token + time budget tracking
│       ├── goalSteering.ts         # Budget limit steering prompts
│       └── goalRuntime.ts          # GoalRuntimeEvent dispatcher
├── tools/
│   └── UpdateGoalTool/
│       └── UpdateGoalTool.tsx      # Tool for model to update goal status
└── components/
    └── goal/
        └── GoalProgress.tsx        # Goal progress indicator component
```

---

## Task 1: Add Goal Types (Codex-Aligned)

**Files:**
- Create: `src/commands/goal/types.ts`
- Modify: `src/state/AppStateStore.ts`

- [ ] **Step 1: Create goal types matching Codex design**

```typescript
// src/commands/goal/types.ts

// Thread goal status - matches Codex protocol
export enum ThreadGoalStatus {
  Active = 'active',
  Paused = 'paused',
  BudgetLimited = 'budget_limited',
  Complete = 'complete',
}

// Goal state persisted in state DB
export interface Goal {
  id: string
  threadId: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget: number | null      // Max tokens allowed (null = unbounded)
  tokensUsed: number              // Tokens consumed so far
  timeUsedSeconds: number         // Wall-clock time consumed
  createdAt: number               // Unix timestamp
  updatedAt: number               // Unix timestamp
}

// Runtime accounting state (per-turn tracking)
export interface GoalTurnAccounting {
  turnId: string
  lastTokenUsage: TokenUsage
  activeGoalId: string | null
}

export interface GoalWallClockAccounting {
  lastAccountedAt: number         // Timestamp
  activeGoalId: string | null
}

// Runtime state for goal execution
export interface GoalRuntimeState {
  accounting: {
    turn: GoalTurnAccounting | null
    wallClock: GoalWallClockAccounting
  }
  budgetLimitReportedGoalId: string | null
  continuationTurnId: string | null
}

// Default idle goal
export const IDLE_GOAL: Goal = {
  id: '',
  threadId: '',
  objective: '',
  status: ThreadGoalStatus.Active,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 0,
  updatedAt: 0,
}

// Token usage tracking
export interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}
```

- [ ] **Step 2: Add goal state to AppStateStore**

In `src/state/AppStateStore.ts`, add to `AppState` type:

```typescript
goal: Goal
goalRuntime: GoalRuntimeState
```

Add to `getDefaultAppState()`:

```typescript
goal: IDLE_GOAL,
goalRuntime: {
  accounting: {
    turn: null,
    wallClock: { lastAccountedAt: Date.now(), activeGoalId: null },
  },
  budgetLimitReportedGoalId: null,
  continuationTurnId: null,
},
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/types.ts src/state/AppStateStore.ts
git commit -m "feat(goal): add Codex-aligned goal types and state"
```

---

## Task 2: Create Goal Accounting System

**Files:**
- Create: `src/utils/goal/goalAccounting.ts`

- [ ] **Step 1: Create accounting logic**

```typescript
// src/utils/goal/goalAccounting.ts
import type { TokenUsage, Goal, GoalTurnAccounting, GoalWallClockAccounting } from '../../commands/goal/types.js'

// Calculate token delta since last accounting (excludes cached input, doesn't double-count reasoning)
export function goalTokenDeltaForUsage(usage: TokenUsage): number {
  const nonCachedInput = usage.inputTokens - usage.cachedInputTokens
  const output = Math.max(usage.outputTokens, 0)
  return nonCachedInput + output
}

export function tokenDeltaSinceLastAccounting(
  last: TokenUsage,
  current: TokenUsage
): number {
  const delta: TokenUsage = {
    inputTokens: current.inputTokens - last.inputTokens,
    cachedInputTokens: current.cachedInputTokens - last.cachedInputTokens,
    outputTokens: current.outputTokens - last.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - last.reasoningOutputTokens,
    totalTokens: current.totalTokens - last.totalTokens,
  }
  return goalTokenDeltaForUsage(delta)
}

export function timeDeltaSinceLastAccounted(lastAccountedAt: number): number {
  return Math.floor((Date.now() - lastAccountedAt) / 1000)
}

// Check if budget is exhausted
export function isBudgetExhausted(goal: Goal): boolean {
  if (goal.tokenBudget === null) return false
  return goal.tokensUsed >= goal.tokenBudget
}

// Calculate remaining budget
export function getRemainingBudget(goal: Goal): number | 'unbounded' {
  if (goal.tokenBudget === null) return 'unbounded'
  return Math.max(0, goal.tokenBudget - goal.tokensUsed)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/goal/goalAccounting.ts
git commit -m "feat(goal): add goal accounting system"
```

---

## Task 3: Create Goal Steering Prompts

**Files:**
- Create: `src/commands/goal/templates/continuation.md`
- Create: `src/commands/goal/templates/budget_limit.md`
- Create: `src/utils/goal/goalSteering.ts`

- [ ] **Step 1: Create continuation prompt template**

```markdown
{# src/commands/goal/templates/continuation.md #}
You are working toward a goal in your current thread.

<untrusted_objective>
{{objective}}
</untrusted_objective>

## Progress
- Tokens used: {{tokens_used}} / {{token_budget}}
- Time elapsed: {{time_used_seconds}}s
- Remaining budget: {{remaining_tokens}} tokens

## Your Task
Continue working toward the objective above. When you believe the objective is fully achieved, call the `update_goal` tool with status "complete".

If you encounter a blocker that cannot be resolved autonomously, explain the situation to the user and call `update_goal` with status "paused" to pause the goal.

Do NOT declare completion unless you have actually achieved the objective.
```

- [ ] **Step 2: Create budget limit prompt template**

```markdown
{# src/commands/goal/templates/budget_limit.md #}
Your token budget for this goal is nearly exhausted or has been exceeded.

<untrusted_objective>
{{objective}}
</untrusted_objective>

## Budget Status
- Token budget: {{token_budget}}
- Tokens used: {{tokens_used}}
- Time elapsed: {{time_used_seconds}}s

## Your Task
Wrap up this turn soon. The goal will be automatically paused due to budget limits.

Complete any final essential work, summarize progress made, and call `update_goal` with status "complete" if finished, or "paused" if more work remains.
```

- [ ] **Step 3: Create steering logic**

```typescript
// src/utils/goal/goalSteering.ts
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../templates')

function renderTemplate(templateName: string, vars: Record<string, string>): string {
  let template = readFileSync(join(TEMPLATES_DIR, templateName), 'utf-8')
  for (const [key, value] of Object.entries(vars)) {
    template = template.replace(new RegExp(`{{${key}}}`, 'g'), value)
  }
  return template
}

export function buildContinuationPrompt(goal: Goal): string {
  const tokenBudget = goal.tokenBudget?.toString() ?? 'unbounded'
  const remaining = goal.tokenBudget 
    ? Math.max(0, goal.tokenBudget - goal.tokensUsed).toString() 
    : 'unbounded'
  
  return renderTemplate('continuation.md', {
    objective: escapeXml(goal.objective),
    tokens_used: goal.tokensUsed.toString(),
    time_used_seconds: goal.timeUsedSeconds.toString(),
    token_budget: tokenBudget,
    remaining_tokens: remaining,
  })
}

export function buildBudgetLimitPrompt(goal: Goal): string {
  const tokenBudget = goal.tokenBudget?.toString() ?? 'none'
  
  return renderTemplate('budget_limit.md', {
    objective: escapeXml(goal.objective),
    tokens_used: goal.tokensUsed.toString(),
    time_used_seconds: goal.timeUsedSeconds.toString(),
    token_budget: tokenBudget,
  })
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
```

- [ ] **Step 4: Commit**

```bash
git add src/commands/goal/templates/ src/utils/goal/goalSteering.ts
git commit -m "feat(goal): add goal steering prompt templates"
```

---

## Task 4: Create update_goal Tool

**Files:**
- Create: `src/tools/UpdateGoalTool/UpdateGoalTool.tsx`
- Create: `src/tools/UpdateGoalTool/index.ts`

- [ ] **Step 1: Create the tool**

```typescript
// src/tools/UpdateGoalTool/UpdateGoalTool.tsx
import type { ToolDefinition } from '../../Tool.js'
import type { Goal, ThreadGoalStatus } from '../../commands/goal/types.js'

// Tool must be called by model to update goal status
export const UPDATE_GOAL_TOOL_NAME = 'update_goal'

export interface UpdateGoalInput {
  status: 'active' | 'paused' | 'complete'
  summary?: string  // Optional summary of progress
}

export function createUpdateGoalTool(goal: Goal): ToolDefinition {
  return {
    name: UPDATE_GOAL_TOOL_NAME,
    description: 'Update the current goal status. Call this when you complete a goal or need to pause.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'paused', 'complete'],
          description: 'The new status for the goal',
        },
        summary: {
          type: 'string',
          description: 'Optional summary of progress made',
        },
      },
      required: ['status'],
    },
  }
}

// Handle tool call
export async function handleUpdateGoalTool(
  input: UpdateGoalInput,
  context: { getAppState(): AppState; setAppState(f: (s: AppState) => AppState): void }
): Promise<string> {
  const appState = context.getAppState()
  const currentGoal = appState.goal
  
  if (!currentGoal.id) {
    return 'No active goal to update.'
  }

  const statusMap: Record<string, ThreadGoalStatus> = {
    active: ThreadGoalStatus.Active,
    paused: ThreadGoalStatus.Paused,
    complete: ThreadGoalStatus.Complete,
  }

  const newGoal: Goal = {
    ...currentGoal,
    status: statusMap[input.status],
    updatedAt: Date.now(),
  }

  context.setAppState(s => ({ ...s, goal: newGoal }))

  if (input.summary) {
    newGoal.progressLog = [...(currentGoal.progressLog || []), input.summary]
  }

  return `Goal status updated to "${input.status}".${input.summary ? ` Progress: ${input.summary}` : ''}`
}
```

- [ ] **Step 2: Register tool in Tool list**

In `src/Tool.ts` or wherever tools are registered, add `update_goal` tool.

- [ ] **Step 3: Commit**

```bash
git add src/tools/UpdateGoalTool/
git commit -m "feat(goal): add update_goal tool for model"
```

---

## Task 5: Create Goal Command

**Files:**
- Create: `src/commands/goal/index.ts`
- Create: `src/commands/goal/goal.tsx`

- [ ] **Step 1: Create command index**

```typescript
// src/commands/goal/index.ts
import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set and manage persistent goals for multi-turn work',
  argumentHint: '[<objective>|status|pause|resume|clear] [--budget <tokens>]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./goal.js'),
} satisfies Command
```

- [ ] **Step 2: Create main goal command**

```typescript
// src/commands/goal/goal.tsx
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { type Goal, type ThreadGoalStatus, IDLE_GOAL } from './types.js';
import { randomUUID } from 'crypto';

interface GoalCommandArgs {
  objective?: string
  action?: 'status' | 'pause' | 'resume' | 'clear'
  tokenBudget?: number
}

function parseGoalArgs(args: string[]): GoalCommandArgs {
  if (args.length === 0) {
    return { action: 'status' }
  }
  
  // Check for --budget flag
  const budgetIndex = args.indexOf('--budget')
  let tokenBudget: number | undefined
  if (budgetIndex !== -1 && args[budgetIndex + 1]) {
    tokenBudget = parseInt(args[budgetIndex + 1], 10)
    args = args.slice(0, budgetIndex)
  }
  
  const firstArg = args[0].toLowerCase()
  
  if (firstArg === 'status') {
    return { action: 'status' }
  }
  if (firstArg === 'pause') {
    return { action: 'pause' }
  }
  if (firstArg === 'resume') {
    return { action: 'resume' }
  }
  if (firstArg === 'clear') {
    return { action: 'clear' }
  }
  
  // Everything else is the objective
  return { objective: args.join(' '), tokenBudget }
}

export function goalCommand(
  args: string[], 
  context: { getAppState(): AppState; setAppState(f: (s: AppState) => AppState): void }
): { message: string; goal?: Goal } {
  const appState = context.getAppState()
  const currentGoal = appState.goal
  const { objective, action, tokenBudget } = parseGoalArgs(args)
  
  if (action === 'status') {
    if (!currentGoal.id || currentGoal.status === ThreadGoalStatus.Complete) {
      return { message: 'No active goal. Use /goal <objective> [--budget <tokens>] to set one.' }
    }
    
    const remaining = currentGoal.tokenBudget 
      ? `${currentGoal.tokenBudget - currentGoal.tokensUsed} remaining` 
      : 'unbounded'
    
    return {
      message: `🎯 Goal: ${currentGoal.objective}\n` +
        `Status: ${currentGoal.status}\n` +
        `Tokens: ${currentGoal.tokensUsed} / ${currentGoal.tokenBudget ?? 'unbounded'} (${remaining})\n` +
        `Time: ${currentGoal.timeUsedSeconds}s`,
    }
  }
  
  if (action === 'clear') {
    context.setAppState(s => ({ ...s, goal: { ...IDLE_GOAL } }))
    return { message: 'Goal cleared.' }
  }
  
  if (action === 'pause' || action === 'resume') {
    if (!currentGoal.id) {
      return { message: 'No active goal to pause/resume. Use /goal <objective> first.' }
    }
    
    const newStatus = action === 'pause' ? ThreadGoalStatus.Paused : ThreadGoalStatus.Active
    const updatedGoal: Goal = {
      ...currentGoal,
      status: newStatus,
      updatedAt: Date.now(),
    }
    
    context.setAppState(s => ({ ...s, goal: updatedGoal }))
    return { message: `Goal ${action}d.`, goal: updatedGoal }
  }
  
  // Create new goal
  const newGoal: Goal = {
    id: randomUUID(),
    threadId: appState.currentThreadId || 'default',
    objective: objective || '',
    status: ThreadGoalStatus.Active,
    tokenBudget: tokenBudget ?? null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  
  context.setAppState(s => ({ 
    ...s, 
    goal: newGoal,
    goalRuntime: {
      ...s.goalRuntime,
      accounting: {
        turn: null,
        wallClock: { lastAccountedAt: Date.now(), activeGoalId: newGoal.id },
      },
    }
  }))
  
  return {
    message: `🎯 Goal set: ${objective}${tokenBudget ? `\nToken budget: ${tokenBudget}` : ''}\n` +
      `Use /goal to check status, /goal pause to pause, /goal clear to cancel.`,
    goal: newGoal,
  }
}

export function GoalCommand(props: { args: string[] } & LocalJSXCommandOnDone) {
  const $ = _c(2);
  const goal = useAppState(_temp);
  const setAppState = useSetAppState()
  
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = () => {
      const result = goalCommand(props.args, {
        getAppState: () => ({
          goal: goal as Goal,
          currentThreadId: 'default',
          goalRuntime: {},
        } as AppState),
        setAppState: (updater) => {
          setAppState(updater)
        },
      });
      props.onDone(true, result.message);
    };
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  
  t0();
  return null;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/index.ts src/commands/goal/goal.tsx
git commit -m "feat(goal): add goal command"
```

---

## Task 6: Register Command

**Files:**
- Modify: `src/commands.ts`

- [ ] **Step 1: Register goal command**

```typescript
// In src/commands.ts
import goal from './commands/goal/index.js'

// Add to commands array
const commands = [
  // ... existing commands
  goal,
]
```

- [ ] **Step 2: Commit**

```bash
git add src/commands.ts
git commit -m "feat(goal): register goal command"
```

---

## Task 7: Implement Continuation Logic

**Files:**
- Create: `src/utils/goal/goalRuntime.ts`
- Modify: `src/query.ts`

- [ ] **Step 1: Create runtime event dispatcher**

```typescript
// src/utils/goal/goalRuntime.ts
import type { Goal, GoalRuntimeState, TokenUsage } from '../../commands/goal/types.js'
import { ThreadGoalStatus } from '../../commands/goal/types.js'
import { tokenDeltaSinceLastAccounting, timeDeltaSinceLastAccounted, isBudgetExhausted } from './goalAccounting.js'
import { buildContinuationPrompt, buildBudgetLimitPrompt } from './goalSteering.js'

// Goal runtime events (matching Codex pattern)
export type GoalRuntimeEvent = 
  | { type: 'turn_started'; turnId: string; tokenUsage: TokenUsage }
  | { type: 'tool_completed'; toolName: string }
  | { type: 'turn_finished'; turnCompleted: boolean }
  | { type: 'maybe_continue_if_idle' }
  | { type: 'external_set'; goal: Goal }
  | { type: 'thread_resumed' }

// Process goal runtime events
export async function processGoalRuntimeEvent(
  event: GoalRuntimeEvent,
  context: {
    goal: Goal
    runtime: GoalRuntimeState
    injectPrompt: (prompt: string) => Promise<void>
    updateGoal: (goal: Goal) => void
  }
): Promise<{ shouldContinue: boolean; injectedPrompt?: string }> {
  const { goal, runtime } = context
  
  switch (event.type) {
    case 'turn_started': {
      // Initialize turn accounting
      runtime.accounting.turn = {
        turnId: event.turnId,
        lastTokenUsage: event.tokenUsage,
        activeGoalId: goal.id,
      }
      return { shouldContinue: true }
    }
    
    case 'tool_completed': {
      // Don't account for update_goal tool calls
      if (event.toolName === 'update_goal') {
        return { shouldContinue: true }
      }
      
      // Account token usage
      const currentUsage = getCurrentTokenUsage() // Implementation depends on context
      const tokenDelta = tokenDeltaSinceLastAccounting(
        runtime.accounting.turn?.lastTokenUsage || currentUsage,
        currentUsage
      )
      const timeDelta = timeDeltaSinceLastAccounted(
        runtime.accounting.wallClock.lastAccountedAt
      )
      
      // Update goal with usage
      const updatedGoal: Goal = {
        ...goal,
        tokensUsed: goal.tokensUsed + tokenDelta,
        timeUsedSeconds: goal.timeUsedSeconds + timeDelta,
        updatedAt: Date.now(),
      }
      
      // Check budget
      if (isBudgetExhausted(updatedGoal)) {
        updatedGoal.status = ThreadGoalStatus.BudgetLimited
        const budgetPrompt = buildBudgetLimitPrompt(updatedGoal)
        context.updateGoal(updatedGoal)
        return { shouldContinue: true, injectedPrompt: budgetPrompt }
      }
      
      context.updateGoal(updatedGoal)
      runtime.accounting.turn.lastTokenUsage = currentUsage
      runtime.accounting.wallClock.lastAccountedAt = Date.now()
      
      return { shouldContinue: true }
    }
    
    case 'turn_finished': {
      if (!event.turnCompleted) {
        return { shouldContinue: true }
      }
      
      // Clear turn accounting
      runtime.accounting.turn = null
      
      // If goal is still active, inject continuation prompt
      if (goal.status === ThreadGoalStatus.Active) {
        const continuationPrompt = buildContinuationPrompt(goal)
        return { shouldContinue: true, injectedPrompt: continuationPrompt }
      }
      
      return { shouldContinue: false }
    }
    
    case 'maybe_continue_if_idle': {
      // This is triggered when there's no user input pending
      // If goal is active, automatically continue
      if (goal.status === ThreadGoalStatus.Active) {
        const continuationPrompt = buildContinuationPrompt(goal)
        return { shouldContinue: true, injectedPrompt: continuationPrompt }
      }
      return { shouldContinue: false }
    }
    
    case 'external_set': {
      context.updateGoal(event.goal)
      return { shouldContinue: event.goal.status === ThreadGoalStatus.Active }
    }
    
    case 'thread_resumed': {
      // Restore runtime state for resumed thread
      if (goal.status === ThreadGoalStatus.Active) {
        runtime.accounting.wallClock.activeGoalId = goal.id
        runtime.accounting.wallClock.lastAccountedAt = Date.now()
      }
      return { shouldContinue: goal.status === ThreadGoalStatus.Active }
    }
  }
}
```

- [ ] **Step 2: Integrate with query loop**

In `src/query.ts`, after each turn:

```typescript
// After turn completion, check if goal should continue
const appState = getAppState()
if (appState.goal.id && appState.goal.status === ThreadGoalStatus.Active) {
  const result = await processGoalRuntimeEvent(
    { type: 'turn_finished', turnCompleted: true },
    {
      goal: appState.goal,
      runtime: appState.goalRuntime,
      injectPrompt: (prompt) => injectDeveloperMessage(prompt),
      updateGoal: (goal) => setAppState(s => ({ ...s, goal })),
    }
  )
  
  if (result.injectedPrompt) {
    // Continue with injected prompt - autonomous execution
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/goal/goalRuntime.ts src/query.ts
git commit -m "feat(goal): integrate goal continuation with query loop"
```

---

## Task 8: Create UI Component

**Files:**
- Create: `src/components/goal/GoalProgress.tsx`

- [ ] **Step 1: Create progress component**

```typescript
// src/components/goal/GoalProgress.tsx
import * as React from 'react'
import { useAppState } from '../../state/AppState.js'
import type { Goal, ThreadGoalStatus } from '../../commands/goal/types.js'

export function GoalProgress() {
  const goal = useAppState(s => s.goal)
  
  if (!goal.id) {
    return null
  }
  
  const statusEmoji = {
    [ThreadGoalStatus.Active]: '🎯',
    [ThreadGoalStatus.Paused]: '⏸️',
    [ThreadGoalStatus.BudgetLimited]: '⚠️',
    [ThreadGoalStatus.Complete]: '✅',
  }[goal.status]
  
  const progress = goal.tokenBudget 
    ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
    : 0
  
  return (
    <div className="goal-progress">
      <div className="goal-header">
        <span>{statusEmoji}</span>
        <span className="goal-objective">{goal.objective}</span>
        <span className="goal-status">({goal.status})</span>
      </div>
      
      {goal.tokenBudget && (
        <div className="goal-budget">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span>{goal.tokensUsed} / {goal.tokenBudget} tokens</span>
        </div>
      )}
      
      <div className="goal-stats">
        <span>⏱️ {goal.timeUsedSeconds}s</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/goal/GoalProgress.tsx
git commit -m "feat(goal): add goal progress UI component"
```

---

## Task 9: Testing

**Files:**
- Test: Manual testing

- [ ] **Step 1: Build and verify**

```bash
bun run build
```

Expected: Build completes without errors

- [ ] **Step 2: Test goal creation with budget**

```bash
bun run dev
# In REPL:
/goal Migrate Express to Fastify --budget 50000
```

Expected: Goal set with 50k token budget

- [ ] **Step 3: Test goal status**

```bash
/goal
```

Expected: Shows goal, status, tokens used, time

- [ ] **Step 4: Test continuation (autonomous execution)**

After creating a goal, verify that model automatically continues:
- Turn 1: Model does some work
- Turn 2: System injects continuation prompt
- Model continues without user input

- [ ] **Step 5: Test budget limit**

Create goal with small budget, exhaust it, verify budget_limit_prompt is injected

- [ ] **Step 6: Commit**

```bash
git commit -m "test(goal): manual testing"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Goal Types (Codex-aligned) | `types.ts`, `AppStateStore.ts` |
| 2 | Goal Accounting | `goalAccounting.ts` |
| 3 | Steering Prompts | `templates/`, `goalSteering.ts` |
| 4 | update_goal Tool | `UpdateGoalTool/` |
| 5 | Goal Command | `goal.tsx`, `index.ts` |
| 6 | Command Registration | `commands.ts` |
| 7 | Continuation Logic | `goalRuntime.ts`, `query.ts` |
| 8 | UI Component | `GoalProgress.tsx` |
| 9 | Testing | Manual |

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-09-goal-command.md`**

**Two execution options:**

1. **Subagent-Driven (recommended)** - Each task dispatched to fresh subagent, review between tasks
2. **Inline Execution** - Execute tasks in this session with checkpoints

**Which approach?**