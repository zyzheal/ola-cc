# Goal Mechanism Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 12 identified issues with the /goal mechanism — token accounting accuracy, control flow safety, security isolation, and UX improvements.

**Architecture:** 4-module incremental redesign. Each module is independently testable. Module 1 (types + accounting) must land first as all other modules depend on the new types. Modules 2–4 can land sequentially after Module 1.

**Tech Stack:** TypeScript, React (Ink), Redux-style AppState, Goal runtime events

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/commands/goal/types.ts` | New types: GoalMode, GoalTask, TurnRecord, expanded Goal/GoalRuntimeState |
| `src/state/AppStateStore.ts` | Add goalTasks to AppState, new Goal defaults |
| `src/utils/goal/goalAccounting.ts` | Per-turn API tracking, new accounting functions |
| `src/utils/goal/goalRuntime.ts` | Ring buffer, error counter, isWorkTool(), dead-turn, strategy self-review |
| `src/utils/goal/goalSteering.ts` | Tiered templates, instruction boundary isolation |
| `src/commands/goal/goal.tsx` | New subcommands, --auto-edit, goalTask creation |
| `src/services/compact/compact.ts` | Extend resetGoalRuntimeAfterCompact for ring buffer |
| `src/components/goal/GoalProgress.tsx` | Re-enable, add current/next/error display, use goalTasks |
| `src/screens/REPL.tsx` | Uncomment GoalProgressWithBoundary |
| `src/types/message.ts` | Add compactSafe flag |

---

### Task 1: Type Definitions & AppState

**Files:**
- Modify: `src/commands/goal/types.ts`
- Modify: `src/state/AppStateStore.ts`

- [ ] **Step 1: Add new types to types.ts**

Add these types to `src/commands/goal/types.ts`:

```typescript
// GoalMode: tiered prompt complexity
export type GoalMode = 'simple' | 'standard' | 'complex'

// TurnRecord: per-turn API usage for ring buffer
export interface TurnRecord {
  turnId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  wallStartMs: number
  wallEndMs: number
}

// GoalTask: dedicated task (decoupled from TodoWrite)
export interface GoalTask {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  order: number
}
```

- [ ] **Step 2: Extend Goal interface**

In `src/commands/goal/types.ts`, add new fields to the `Goal` interface:

```typescript
export interface Goal {
  // ...existing fields
  totalApiTokens: number          // Authoritative API token sum
  totalApiWallMs: number          // Total API wall time ms
  mode: GoalMode                  // Prompt tier
  autoEdit: boolean               // Auto-approve file edits only
  goalTaskListId?: string         // Dedicated task list ID
  consecutiveErrors?: number      // Error counter for auto-pause
  turnsWithNoChanges?: number     // Dead-turn detection
}
```

- [ ] **Step 3: Extend GoalRuntimeState interface**

In `src/commands/goal/types.ts`, add to `GoalRuntimeState`:

```typescript
export interface GoalRuntimeState {
  // ...existing fields
  turnBuffer: TurnRecord[]        // Ring buffer, max 3
  totalApiTokens: number           // Sum of API response tokens
  totalApiWallMs: number           // Sum of API wall time
  consecutiveErrors: number        // Consecutive error counter
  turnsWithNoChanges: number       // Turns with no observable changes
}
```

- [ ] **Step 4: Add goalTasks to AppState**

In `src/state/AppStateStore.ts`, add to the AppState type (in the `DeepImmutable<{...}> & {...}` section, add after `goalRuntime`):

```typescript
goalTasks: { [listId: string]: GoalTask[] }
```

And in `getDefaultAppState()`, add default:

```typescript
goalTasks: {},
```

Also update the existing `goal` default in `getDefaultAppState()` to include new fields:

```typescript
goal: {
  id: '',
  threadId: '',
  objective: '',
  status: '',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 0,
  updatedAt: 0,
  todoListId: undefined,
  // New fields
  totalApiTokens: 0,
  totalApiWallMs: 0,
  mode: 'standard' as GoalMode,
  autoEdit: false,
  consecutiveErrors: 0,
  turnsWithNoChanges: 0,
},
goalRuntime: {
  accounting: {
    turn: null,
    wallClock: { lastAccountedAt: 0, activeGoalId: null },
  },
  budgetLimitReportedGoalId: null,
  continuationTurnId: null,
  // New fields
  turnBuffer: [],
  totalApiTokens: 0,
  totalApiWallMs: 0,
  consecutiveErrors: 0,
  turnsWithNoChanges: 0,
},
```

- [ ] **Step 5: Add imports in AppStateStore.ts**

At the top of `src/state/AppStateStore.ts`, add:

```typescript
import type { GoalMode, GoalTask } from '../commands/goal/types.js'
```

- [ ] **Step 6: Verify type consistency**

Run `bun run build:dev` to check for type errors. Fix any import or type mismatches.

- [ ] **Step 7: Commit**

```bash
git add src/commands/goal/types.ts src/state/AppStateStore.ts
git commit -m "feat(goal): add GoalMode, GoalTask, TurnRecord types and AppState goalTasks"
```

---

### Task 2: Token Accounting — Ring Buffer & API Wall Time

**Files:**
- Modify: `src/utils/goal/goalAccounting.ts`
- Modify: `src/utils/goal/goalRuntime.ts`
- Modify: `src/services/compact/compact.ts`

- [ ] **Step 1: Add new accounting functions**

In `src/utils/goal/goalAccounting.ts`, add:

```typescript
import type { TokenUsage, Goal, TurnRecord } from '../../commands/goal/types.js'

// ...existing exports...

/**
 * Record a turn's API usage into the ring buffer and accumulate totals.
 * Returns the updated ring buffer (max 3 entries).
 */
export function recordTurnApiUsage(
  turnBuffer: TurnRecord[],
  turnId: string,
  usage: TokenUsage,
  wallStartMs: number,
  wallEndMs: number,
): TurnRecord[] {
  const record: TurnRecord = {
    turnId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedInputTokens,
    wallStartMs,
    wallEndMs,
  }
  const buffer = [...turnBuffer]
  buffer.push(record)
  if (buffer.length > 3) buffer.shift()
  return buffer
}

/**
 * Calculate total tokens from the ring buffer.
 * Used after compact to reconcile totals.
 */
export function totalTokensFromBuffer(turnBuffer: TurnRecord[]): number {
  return turnBuffer.reduce((sum, r) => {
    const nonCachedInput = r.inputTokens - r.cacheReadTokens
    const output = Math.max(r.outputTokens, 0)
    return sum + nonCachedInput + output
  }, 0)
}

/**
 * Calculate total wall time from the ring buffer.
 */
export function totalWallTimeFromBuffer(turnBuffer: TurnRecord[]): number {
  return turnBuffer.reduce((sum, r) => sum + (r.wallEndMs - r.wallStartMs), 0)
}
```

- [ ] **Step 2: Update goalRuntime.ts — imports and ring buffer init**

At the top of `src/utils/goal/goalRuntime.ts`, add imports:

```typescript
import {
  recordTurnApiUsage,
  totalTokensFromBuffer,
  totalWallTimeFromBuffer,
} from './goalAccounting.js'
```

- [ ] **Step 3: Add isWorkTool() helper**

In `src/utils/goal/goalRuntime.ts`, add:

```typescript
/**
 * Work tools that should auto-progress tasks.
 * Replaces hardcoded exclusion list with explicit inclusion.
 */
const WORK_TOOLS = new Set([
  'Bash', 'FileEdit', 'FileWrite', 'FileRead', 'Glob', 'Grep',
  'Agent', 'SkillTool', 'TodoWrite', 'Edit', 'Write', 'Read',
])

function isWorkTool(toolName: string): boolean {
  return WORK_TOOLS.has(toolName)
}
```

- [ ] **Step 4: Add WORK_TOOLS constant and isWorkTool function**

Replace the existing hardcoded exclusion in `tool_completed` handler (line ~178) that uses `!['TodoWrite', 'Sleep', 'AskUserQuestion'].includes(event.toolName)` with `isWorkTool(event.toolName)`:

```typescript
// In 'tool_completed' case, replace:
//   if (inProgressTask && !['TodoWrite', 'Sleep', 'AskUserQuestion'].includes(event.toolName))
// With:
if (inProgressTask && isWorkTool(event.toolName)) {
  autoProgressTasks(todos, context.updateTodos)
}
```

- [ ] **Step 5: Add error counter & auto-pause**

In `src/utils/goal/goalRuntime.ts`, add at the top of the `processGoalRuntimeEvent` try block (right after `const { goal, runtime } = context`):

```typescript
// Reset error counter on any successful event processing
runtime.consecutiveErrors = 0
```

In the catch block at the end of `processGoalRuntimeEvent`, replace:

```typescript
} catch (error) {
  console.error('[goalRuntime] Error processing event:', error)
  return { shouldContinue: true }
}
```

With:

```typescript
} catch (error) {
  console.error('[goalRuntime] Error processing event:', error)
  const { goal, runtime } = context
  if (goal && runtime) {
    runtime.consecutiveErrors = (runtime.consecutiveErrors ?? 0) + 1

    if (runtime.consecutiveErrors >= 3) {
      const pausedGoal = { ...goal, status: Status.Paused, updatedAt: Date.now() }
      context.updateGoal(pausedGoal)
      return {
        shouldContinue: false,
        injectedPrompt: `[Goal paused due to errors] 3 consecutive errors encountered. Use /goal resume to continue or /goal stop to cancel.`,
      }
    }
  }
  return { shouldContinue: true }
}
```

- [ ] **Step 6: Add dead-turn detection**

In the `turn_finished` case in `processGoalRuntimeEvent`, after the existing token accounting logic and before `context.updateGoal(updatedGoal)`, add:

```typescript
// Dead-turn detection: 2+ turns with no observable changes
let turnsWithNoChanges = runtime.turnsWithNoChanges ?? 0

// Check if this turn produced observable changes
// We consider a turn as having changes if:
// - A file was written (FileEdit, FileWrite, Edit, Write)
// - A bash command was executed
// - An agent was spawned
const hadObservableChanges = lastTurn && context.currentTokenUsage &&
  (context.currentTokenUsage.outputTokens > 0 ||
   context.currentTokenUsage.totalTokens > (lastTurn.lastTokenUsage?.totalTokens ?? 0))

if (!hadObservableChanges) {
  turnsWithNoChanges++
} else {
  turnsWithNoChanges = 0
}
runtime.turnsWithNoChanges = turnsWithNoChanges

// If 2+ dead turns, inject strategy check into continuation prompt
let strategyCheck = ''
if (turnsWithNoChanges >= 2) {
  strategyCheck = `\n\n## Strategy Check\nThe last ${turnsWithNoChanges} turns produced no observable changes. Consider:\n- Trying a different approach\n- Breaking the problem into smaller steps\n- Using /goal pause to stop and reconsider`
}
```

Then append `strategyCheck` to the continuation prompt in the `turn_finished` case where `buildContinuationPrompt` is called:

```typescript
const continuationPrompt = buildContinuationPrompt(effectiveGoal) + strategyCheck
```

- [ ] **Step 7: Update turn_started to record API wall time**

In the `turn_started` case in `processGoalRuntimeEvent`, add wall time tracking:

```typescript
case 'turn_started': {
  // Initialize turn accounting
  runtime.accounting.turn = {
    turnId: event.turnId,
    lastTokenUsage: event.tokenUsage,
    activeGoalId: goal.id,
  }

  // Record wall time start
  runtime._currentTurnWallStartMs = Date.now()

  // ...existing auto-start first task logic...
}
```

Also add `_currentTurnWallStartMs` to `GoalRuntimeState` in types.ts:

```typescript
export interface GoalRuntimeState {
  // ...existing fields
  _currentTurnWallStartMs: number  // Internal: track current turn API start
}
```

- [ ] **Step 8: Update turn_finished to record turn in ring buffer**

In the `turn_finished` case, after token accounting, add ring buffer recording:

```typescript
// Record turn in ring buffer
const wallEndMs = Date.now()
const wallStartMs = runtime._currentTurnWallStartMs ?? wallEndMs
runtime.turnBuffer = recordTurnApiUsage(
  runtime.turnBuffer ?? [],
  lastTurn?.turnId ?? 'unknown',
  context.currentTokenUsage,
  wallStartMs,
  wallEndMs,
)

// Update authoritative totals
runtime.totalApiTokens = totalTokensFromBuffer(runtime.turnBuffer)
runtime.totalApiWallMs = totalWallTimeFromBuffer(runtime.turnBuffer)
```

- [ ] **Step 9: Update resetGoalRuntimeAfterCompact in compact.ts**

In `src/services/compact/compact.ts`, find `resetGoalRuntimeAfterCompact` and extend it:

```typescript
export function resetGoalRuntimeAfterCompact(
  setAppState: SetAppStateFn,
  compactionUsage?: { input_tokens: number; output_tokens: number },
): void {
  setAppState(prev => {
    if (!prev.goal?.id) return prev
    const status = prev.goal.status
    if (status !== ThreadGoalStatus.Active && status !== ThreadGoalStatus.BudgetLimited) return prev

    // Record compact tokens in ring buffer
    if (compactionUsage) {
      const compactTurn: TurnRecord = {
        turnId: prev.goalRuntime?.accounting.turn?.turnId ?? 'compact',
        inputTokens: compactionUsage.input_tokens,
        outputTokens: compactionUsage.output_tokens,
        cacheReadTokens: 0,
        wallStartMs: Date.now(),
        wallEndMs: Date.now(),
      }
      const buffer = [...(prev.goalRuntime?.turnBuffer ?? [])]
      buffer.push(compactTurn)
      if (buffer.length > 3) buffer.shift()

      const totalApiTokens = totalTokensFromBuffer(buffer)
      const totalApiWallMs = totalWallTimeFromBuffer(buffer)

      return {
        ...prev,
        goal: {
          ...prev.goal,
          totalApiTokens,
          totalApiWallMs,
        },
        goalRuntime: {
          ...prev.goalRuntime,
          turnBuffer: buffer,
          totalApiTokens,
          totalApiWallMs,
          accounting: {
            ...prev.goalRuntime?.accounting,
            turn: null,
          },
        },
      }
    }
    return prev
  })
}
```

Add the `TurnRecord` import at the top of compact.ts:

```typescript
import type { TurnRecord } from '../../commands/goal/types.js'
import { totalTokensFromBuffer, totalWallTimeFromBuffer } from '../../utils/goal/goalAccounting.js'
```

- [ ] **Step 10: Verify build**

Run `bun run build:dev` to check for type errors.

- [ ] **Step 11: Commit**

```bash
git add src/utils/goal/goalAccounting.ts src/utils/goal/goalRuntime.ts src/services/compact/compact.ts
git commit -m "feat(goal): ring buffer token accounting, error counter, dead-turn detection"
```

---

### Task 3: Tiered Continuation Prompts & Safety Isolation

**Files:**
- Modify: `src/utils/goal/goalSteering.ts`
- Modify: `src/commands/goal/goal.tsx`

- [ ] **Step 1: Add tiered templates to goalSteering.ts**

In `src/utils/goal/goalSteering.ts`, add:

```typescript
const SIMPLE_CONTINUATION_TEMPLATE = `Continue working toward: {{objective}}. Next action?`

const STANDARD_CONTINUATION_TEMPLATE = CONTINUATION_TEMPLATE  // existing template

const COMPLEX_CONTUATION_TEMPLATE = CONTINUATION_TEMPLATE + `

## Self-Review
Before proceeding, briefly assess:
1. Is the current approach working? If no, switch strategy.
2. Am I making progress toward the objective? If no, reconsider the plan.
3. Are there simpler alternatives? If yes, prefer them.`
```

- [ ] **Step 2: Add getContinuationTemplate function**

```typescript
function getContinuationTemplate(mode: GoalMode): string {
  switch (mode) {
    case 'simple':
      return SIMPLE_CONTINUATION_TEMPLATE
    case 'standard':
      return STANDARD_CONTINUATION_TEMPLATE
    case 'complex':
      return COMPLEX_CONTINUATION_TEMPLATE
  }
}
```

- [ ] **Step 3: Update buildContinuationPrompt to use tiered template**

Replace the existing `buildContinuationPrompt` body:

```typescript
export function buildContinuationPrompt(goal: Goal): string {
  const template = getContinuationTemplate(goal.mode ?? 'standard')
  const tokenBudget = goal.tokenBudget?.toString() ?? 'unbounded'
  const remainingVal = getRemainingBudget(goal)
  const remaining = remainingVal === 'unbounded' ? 'unbounded' : remainingVal.toString()

  return renderTemplate(template, {
    objective: escapeXml(goal.objective),
    tokens_used: (goal.totalApiTokens || goal.tokensUsed).toString(),
    time_used_seconds: Math.floor((goal.totalApiWallMs || goal.timeUsedSeconds * 1000) / 1000).toString(),
    token_budget: tokenBudget,
    remaining_tokens: remaining,
  })
}
```

- [ ] **Step 4: Update buildBudgetLimitPrompt similarly**

```typescript
export function buildBudgetLimitPrompt(goal: Goal): string {
  const tokenBudget = goal.tokenBudget?.toString() ?? 'none'

  return renderTemplate(BUDGET_LIMIT_TEMPLATE, {
    objective: escapeXml(goal.objective),
    tokens_used: (goal.totalApiTokens || goal.tokensUsed).toString(),
    time_used_seconds: Math.floor((goal.totalApiWallMs || goal.timeUsedSeconds * 1000) / 1000).toString(),
    token_budget: tokenBudget,
  })
}
```

- [ ] **Step 5: Add GoalMode import to goalSteering.ts**

At the top of `src/utils/goal/goalSteering.ts`, add:

```typescript
import type { Goal, GoalMode } from '../../commands/goal/types.js'
```

- [ ] **Step 6: Update goal.tsx — parse --auto-edit and --mode**

In `src/commands/goal/goal.tsx`, update `GoalCommandArgs`:

```typescript
interface GoalCommandArgs {
  objective?: string
  action?: 'status' | 'pause' | 'resume' | 'clear' | 'edit' | 'budget' | 'mode'
  tokenBudget?: number
  autoAccept?: boolean
  autoEdit?: boolean
  mode?: GoalMode
  editObjective?: string
  newBudget?: number
}
```

Update `parseGoalArgs`:

```typescript
function parseGoalArgs(args: string[]): GoalCommandArgs {
  if (args.length === 0) {
    return { action: 'status' }
  }

  const autoAcceptIndex = args.indexOf('--auto-accept')
  const autoAccept = autoAcceptIndex !== -1
  if (autoAccept) {
    args = args.filter(a => a !== '--auto-accept')
  }

  const autoEdit = args.includes('--auto-edit')
  if (autoEdit) {
    args = args.filter(a => a !== '--auto-edit')
  }

  const modeMatch = args.find(a => ['simple', 'standard', 'complex'].includes(a.toLowerCase()))
  const mode = modeMatch ? modeMatch.toLowerCase() as GoalMode : undefined
  if (mode) {
    args = args.filter(a => a.toLowerCase() !== mode)
  }

  const budgetIndex = args.indexOf('--budget')
  let tokenBudget: number | undefined
  if (budgetIndex !== -1 && args[budgetIndex + 1]) {
    tokenBudget = parseInt(args[budgetIndex + 1], 10)
    args = args.filter((_, i) => i !== budgetIndex && i !== budgetIndex + 1)
  }

  const firstArg = args[0]?.toLowerCase()

  if (firstArg === 'status') return { action: 'status' }
  if (firstArg === 'pause') return { action: 'pause' }
  if (firstArg === 'resume') return { action: 'resume' }
  if (firstArg === 'clear' || firstArg === 'stop') return { action: 'clear' }
  if (firstArg === 'edit') return { action: 'edit', editObjective: args.slice(1).join(' ') }
  if (firstArg === 'budget' && args[1]) return { action: 'budget', newBudget: parseInt(args[1], 10) }
  if (firstArg === 'mode' && mode) return { action: 'mode', mode }

  return { objective: args.join(' '), tokenBudget, autoAccept, autoEdit, mode }
}
```

- [ ] **Step 7: Add autoEdit permission mode in goal.tsx call handler**

Replace the existing autoAccept permission logic:

```typescript
// If autoEdit is true, use autoEdit mode (file edits auto-approved, bash still prompts)
// If autoAccept is true, use bypassPermissions (full bypass)
const newMode = autoAccept
  ? 'bypassPermissions'
  : autoEdit
    ? 'autoEdit'
    : s.toolPermissionContext.mode

const newToolPermissionContext = (autoAccept || autoEdit)
  ? {
      ...s.toolPermissionContext,
      mode: newMode as const,
      isBypassPermissionsModeAvailable: true,
    }
  : s.toolPermissionContext
```

- [ ] **Step 8: Add goalTask creation**

In the goal creation section of `goal.tsx` call handler, after `const defaultTodos = createDefaultTodoItems(...)`:

```typescript
// Create dedicated goalTask list (decoupled from TodoWrite)
const goalTaskListId = `goal_${newGoal.id}`
const defaultGoalTasks: GoalTask[] = createDefaultGoalTasks(objective || '')
```

Add the `createDefaultGoalTasks` function at the top of the file:

```typescript
function createDefaultGoalTasks(objective: string): GoalTask[] {
  return [
    { id: randomUUID(), content: `分析目标: ${objective}`, status: 'pending', order: 0 },
    { id: randomUUID(), content: '规划执行步骤', status: 'pending', order: 1 },
    { id: randomUUID(), content: '执行任务', status: 'pending', order: 2 },
    { id: randomUUID(), content: '验证完成结果', status: 'pending', order: 3 },
  ]
}
```

And add `goalTasks` to the AppState update:

```typescript
context.setAppState(s => ({
  ...s,
  goal: {
    ...newGoal,
    goalTaskListId,
    mode: mode ?? 'standard',
    autoEdit: autoEdit ?? false,
  },
  goalRuntime: { ... },
  todos: { ... },
  goalTasks: {
    ...s.goalTasks,
    [goalTaskListId]: defaultGoalTasks,
  },
  toolPermissionContext: newToolPermissionContext,
}))
```

- [ ] **Step 9: Add edit, budget, mode subcommands**

After the pause/resume block in `goal.tsx`, add:

```typescript
// edit: modify goal objective
if (action === 'edit') {
  if (!goal || !goal.id) {
    onDone('No active goal to edit.', { display: 'system' })
    return null
  }
  if (!editObjective) {
    onDone('Usage: /goal edit <new objective>', { display: 'system' })
    return null
  }
  context.setAppState(s => ({
    ...s,
    goal: { ...s.goal, objective: editObjective, updatedAt: Date.now() },
  }))
  onDone(`Goal objective updated.`, { display: 'system' })
  return null
}

// budget: dynamically adjust token budget
if (action === 'budget') {
  if (!goal || !goal.id) {
    onDone('No active goal to adjust budget.', { display: 'system' })
    return null
  }
  if (newBudget == null || isNaN(newBudget)) {
    onDone('Usage: /goal budget <tokens>', { display: 'system' })
    return null
  }
  context.setAppState(s => ({
    ...s,
    goal: { ...s.goal, tokenBudget: newBudget, updatedAt: Date.now() },
  }))
  onDone(`Goal budget set to ${newBudget} tokens.`, { display: 'system' })
  return null
}

// mode: change prompt tier
if (action === 'mode') {
  if (!goal || !goal.id) {
    onDone('No active goal to change mode.', { display: 'system' })
    return null
  }
  context.setAppState(s => ({
    ...s,
    goal: { ...s.goal, mode: mode ?? 'standard', updatedAt: Date.now() },
  }))
  onDone(`Goal mode set to ${mode ?? 'standard'}.`, { display: 'system' })
  return null
}
```

- [ ] **Step 10: Add GoalMode and GoalTask imports**

At the top of `goal.tsx`:

```typescript
import type { Goal, GoalRuntimeState, GoalMode, GoalTask } from './types.js'
```

- [ ] **Step 11: Update maybe_continue_if_idle to respect Paused state**

In `goalRuntime.ts`, update the `maybe_continue_if_idle` case:

```typescript
case 'maybe_continue_if_idle': {
  // Don't re-inject for paused goals
  if (goal.status === Status.Paused) {
    return { shouldContinue: false }
  }
  if (goal.status === Status.Active) {
    const continuationPrompt = buildContinuationPrompt(goal)
    return { shouldContinue: true, injectedPrompt: continuationPrompt }
  }
  return { shouldContinue: false }
}
```

- [ ] **Step 12: Verify build**

Run `bun run build:dev` to check for type errors.

- [ ] **Step 13: Commit**

```bash
git add src/utils/goal/goalSteering.ts src/commands/goal/goal.tsx src/utils/goal/goalRuntime.ts
git commit -m "feat(goal): tiered prompts, autoEdit mode, new subcommands, paused state respect"
```

---

### Task 4: GoalProgress UI Re-enable & Enhancements

**Files:**
- Modify: `src/components/goal/GoalProgress.tsx`
- Modify: `src/screens/REPL.tsx`
- Modify: `src/types/message.ts`

- [ ] **Step 1: Add compactSafe to Message type**

In `src/types/message.ts`, find the existing `isMeta?: boolean` line and add after it:

```typescript
compactSafe?: boolean
```

- [ ] **Step 2: Update GoalProgress.tsx to use goalTasks**

Replace the `GoalProgress` function body. Key changes:

1. Add `goalTasks` selector
2. Show current action, next step, consecutive errors
3. Use `totalApiTokens` if available

```typescript
export function GoalProgress() {
  const goalId = useAppState(s => s.goal?.id ?? '')
  const goalStatus = useAppState(s => s.goal?.status ?? '')
  const goalObjective = useAppState(s => s.goal?.objective ?? '')
  const goalTokenBudget = useAppState(s => s.goal?.tokenBudget ?? null)
  const goalTokensUsed = useAppState(s => s.goal?.tokensUsed ?? 0)
  const goalTimeUsedSeconds = useAppState(s => s.goal?.timeUsedSeconds ?? 0)
  const goalTotalApiTokens = useAppState(s => s.goal?.totalApiTokens ?? 0)
  const goalMode = useAppState(s => s.goal?.mode ?? 'standard')
  const goalAutoEdit = useAppState(s => s.goal?.autoEdit ?? false)
  const goalTaskListId = useAppState(s => s.goal?.goalTaskListId ?? undefined)
  const goalConsecutiveErrors = useAppState(s => s.goalRuntime?.consecutiveErrors ?? 0)

  const goalTasks = useAppState(s => {
    const taskListId = s.goal?.goalTaskListId
    if (!taskListId) return null
    return s.goalTasks?.[taskListId] ?? null
  })

  // Fallback to todoListId for backward compatibility
  const todoListId = useAppState(s => s.goal?.todoListId ?? undefined)
  const todos = useAppState(s => {
    if (!todoListId) return null
    return s.todos?.[todoListId] ?? null
  })

  if (!goalId || !goalStatus || goalStatus === '') {
    return null
  }

  const statusKey = goalStatus as ThreadGoalStatus
  const emoji = Object.prototype.hasOwnProperty.call(STATUS_EMOJI, statusKey)
    ? STATUS_EMOJI[statusKey]
    : '📌'
  const color = Object.prototype.hasOwnProperty.call(STATUS_COLORS, statusKey)
    ? STATUS_COLORS[statusKey]
    : 'gray'

  // Use goalTasks if available, fall back to todos
  const taskItems = goalTasks ?? (todos ?? [])
  const currentTask = taskItems.find((t: any) => t.status === 'in_progress')
  const nextTask = taskItems.find((t: any) => t.status === 'pending')
  const completedTasks = taskItems.filter((t: any) => t.status === 'completed').length
  const totalTasks = taskItems.length
  const taskProgress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  const budgetProgress = goalTokenBudget != null
    ? Math.min(100, (goalTokensUsed / goalTokenBudget) * 100)
    : 0

  const displayTokens = goalTotalApiTokens > 0 ? goalTotalApiTokens : goalTokensUsed

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Box>
        <Text color={color}>{emoji} </Text>
        <Text bold color={color}>{goalObjective}</Text>
        <Text dimColor> ({goalStatus})</Text>
      </Box>

      {/* Mode indicator */}
      <Box>
        <Text dimColor>Mode: {goalMode}{goalAutoEdit ? ' (auto-edit)' : ''}</Text>
      </Box>

      {/* Current action */}
      {currentTask && (
        <Box>
          <Text color="cyan">Current: </Text>
          <Text>{typeof currentTask === 'object' && 'content' in currentTask ? currentTask.content : currentTask}</Text>
        </Box>
      )}

      {/* Next step */}
      {nextTask && (
        <Box>
          <Text dimColor>Next: </Text>
          <Text dimColor>{typeof nextTask === 'object' && 'content' in nextTask ? nextTask.content : nextTask}</Text>
        </Box>
      )}

      {/* Task progress */}
      {totalTasks > 0 && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Progress: {completedTasks}/{totalTasks} completed ({taskProgress}%)</Text>
          </Box>
          <Box>
            <Text dimColor>[{renderProgressBar(taskProgress)}]</Text>
          </Box>
        </Box>
      )}

      {/* Budget info */}
      {goalTokenBudget != null ? (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Budget: </Text>
            <Text>{displayTokens.toLocaleString()} / {goalTokenBudget.toLocaleString()}</Text>
            <Text dimColor> ({Math.round(budgetProgress)}% used)</Text>
          </Box>
          <Box>
            <Text dimColor>Remaining: {(goalTokenBudget - displayTokens).toLocaleString()} tokens</Text>
          </Box>
        </Box>
      ) : (
        <Box>
          <Text dimColor>Tokens: </Text>
          <Text>{displayTokens.toLocaleString()} (unbounded)</Text>
        </Box>
      )}

      <Box>
        <Text dimColor>Time: </Text>
        <Text>{formatDuration(goalTimeUsedSeconds)}</Text>
      </Box>

      {/* Error indicator */}
      {goalConsecutiveErrors > 0 && (
        <Box>
          <Text color="red">Errors: {goalConsecutiveErrors}/3 before auto-pause</Text>
        </Box>
      )}
    </Box>
  )
}
```

- [ ] **Step 3: Uncomment GoalProgress in REPL.tsx**

In `src/screens/REPL.tsx` around line 4783-4786, replace:

```tsx
{/* Goal progress temporarily disabled for debugging */}
{/* {goal?.id && goal?.status && <Box width="100%" flexDirection="column">
      <GoalProgressWithBoundary />
    </Box>} */}
```

With:

```tsx
{goal?.id && goal?.status && <Box width="100%" flexDirection="column">
      <GoalProgressWithBoundary />
    </Box>}
```

- [ ] **Step 4: Verify build**

Run `bun run build:dev` to check for type errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/goal/GoalProgress.tsx src/screens/REPL.tsx src/types/message.ts
git commit -m "feat(goal): re-enable GoalProgress with goalTasks, error indicator, mode display"
```

---

### Task 5: Migration & Backward Compatibility

**Files:**
- Modify: `src/commands/goal/goal.tsx`
- Modify: `src/commands/goal/types.ts`

- [ ] **Step 1: Add migration function to types.ts**

Add to `src/commands/goal/types.ts`:

```typescript
/**
 * Migrate an existing Goal to the new schema with all fields populated.
 * Called on first access to a goal that may lack new fields.
 */
export function migrateGoal(goal: Goal): Goal {
  return {
    ...goal,
    totalApiTokens: goal.totalApiTokens ?? goal.tokensUsed ?? 0,
    totalApiWallMs: goal.totalApiWallMs ?? (goal.timeUsedSeconds ?? 0) * 1000,
    mode: goal.mode ?? 'standard',
    autoEdit: goal.autoEdit ?? false,
    consecutiveErrors: goal.consecutiveErrors ?? 0,
    turnsWithNoChanges: goal.turnsWithNoChanges ?? 0,
  }
}
```

- [ ] **Step 2: Apply migration in goal.tsx**

At the start of the `call` handler in `goal.tsx`, after getting the goal from AppState, apply migration:

```typescript
const appState = context.getAppState()
let goal = appState.goal
// Migrate existing goal if it has old schema
if (goal && goal.id) {
  goal = migrateGoal(goal)
  context.setAppState(s => ({ ...s, goal }))
}
```

- [ ] **Step 3: Apply migration in goalRuntime.ts**

At the start of `processGoalRuntimeEvent`, after getting goal from context:

```typescript
// Migrate goal if needed (handles goals loaded from old schema)
if (goal && goal.id) {
  const migratedGoal = migrateGoal(goal)
  if (migratedGoal !== goal) {
    context.updateGoal(migratedGoal)
    goal = migratedGoal
  }
}
```

Add the import:

```typescript
import { migrateGoal } from '../../commands/goal/types.js'
```

- [ ] **Step 4: Verify build**

Run `bun run build:dev`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/goal/types.ts src/commands/goal/goal.tsx src/utils/goal/goalRuntime.ts
git commit -m "feat(goal): backward compatibility migration for new fields"
```

---

### Task 6: Final Verification

- [ ] **Step 1: Full build check**

Run `bun run build:dev` and fix any remaining type errors.

- [ ] **Step 2: Verify all success criteria**

Check against spec success criteria:
1. Token counting uses per-turn API response.usage — done (ring buffer + totalApiTokens)
2. Goal can be paused/resumed — done (paused state respected in maybe_continue_if_idle)
3. 3 consecutive errors auto-pause — done (error counter in catch block)
4. GoalProgress visible in UI — done (uncommented + enhanced)
5. --auto-edit does not bypass bash — done (autoEdit mode, not bypassPermissions)
6. Continuation prompt persists across compact — done (ring buffer + resetGoalRuntimeAfterCompact)
7. Dead-turn detection triggers — done (turnsWithNoChanges >= 2)
8. No negative tokenDelta after compact — done (ring buffer reconciliation)

- [ ] **Step 3: Commit all**

```bash
git status
git log --oneline -5
```
