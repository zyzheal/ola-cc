# Goal Mechanism Redesign

> **Date:** 2026-05-15
> **Status:** Draft
> **Scope:** Fix all 12 identified issues with the /goal mechanism
> **Branch:** feature-goal

## Overview

The `/goal` command enables goal-driven autonomous execution. Users set a goal with optional token budget, and the system auto-continues each turn until the goal is marked complete via `update_goal` tool. It integrates with the query loop (`src/query.ts`), compact system (`src/services/compact/`), and TodoWrite.

### Problem Statement

12 issues identified in code review spanning token accounting accuracy, control flow safety, security isolation, and user experience.

### Key Findings

- `tool_completed` event type defined but never fired — dead code path
- GoalProgress component commented out in REPL.tsx — "temporarily disabled for debugging"
- `resetGoalRuntimeAfterCompact` critical — without it, negative tokenDelta after compact
- `maybe_continue_if_idle` fires every idle cycle — creates inescapable auto-continue loop

---

## Architecture

### Current Flow

```
User: /goal <objective>
  → goal command creates Goal + default todos
  → injects continuationPrompt via metaMessages
  → query loop starts

Each turn:
  turn_started event → init accounting
  tool execution → (no tool_completed event fired!)
  turn_finished event → inject next continuationPrompt
  maybe_continue_if_idle → re-inject if idle
```

### Target Flow

```
User: /goal <objective> [--mode simple|standard|complex] [--auto-edit] [--budget N]
  → create Goal with mode, autoEdit flag, budget
  → create GoalTask list (decoupled from sessionId todos)
  → select tier-appropriate continuation prompt
  → inject with meta: true + compact-safe flag

Each turn:
  turn_started → init accounting with API response baseline
  tool execution → isWorkTool() check → auto-progress tasks
  turn_finished → self-review check → inject tier-appropriate prompt
  error detected → increment consecutiveErrors → 3 errors → auto-pause

On compact:
  → reset accounting.turn
  → rebuild continuation prompt with fresh data
  → mark goal message as compact-safe

User: /goal pause|resume|stop|edit|budget
  → update Goal state directly
```

---

## Module 1: Token Accounting Redesign

**Issues:** #3 (inaccurate counting), #4 (wall clock time)

### Problem

Current approach uses cumulative delta from stale `goal.tokensUsed` values. After compact, `accounting.turn` holds pre-compact token values, causing negative deltas. Time delta uses `Date.now()` which includes user thinking time.

### Solution

#### 1.1 Per-Turn API Usage Tracking

Instead of delta-based accounting, track each turn's actual API usage from `response.usage`:

```typescript
// In GoalRuntimeState (types.ts)
interface GoalRuntimeState {
  // ...existing fields
  turnBuffer: TurnRecord[]  // Ring buffer, max 3 entries
  totalApiTokens: number     // Sum of all API response.usage tokens
  totalApiWallMs: number     // Sum of all API wall clock ms
}

interface TurnRecord {
  turnId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  wallStartMs: number   // Timestamp when API call started
  wallEndMs: number     // Timestamp when API response received
}
```

#### 1.2 Ring Buffer for Compact Safety

Maintain a 3-entry ring buffer of turn records. After compact, reconcile:

```typescript
// In compact.ts resetGoalRuntimeAfterCompact
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
      // Append to ring buffer (max 3)
      const buffer = [...(prev.goalRuntime?.turnBuffer ?? [])]
      buffer.push(compactTurn)
      if (buffer.length > 3) buffer.shift()

      return {
        ...prev,
        goalRuntime: {
          ...prev.goalRuntime,
          turnBuffer: buffer,
          accounting: {
            ...prev.goalRuntime?.accounting,
            turn: null, // Reset turn to prevent negative delta
          },
        },
      }
    }
    return prev
  })
}
```

#### 1.3 API Wall Time Tracking

Record wall time at API call boundaries, not at accounting intervals:

```typescript
// In query.ts, wrap the API call:
const apiWallStartMs = Date.now()
const response = await makeApiCall(...)
const apiWallEndMs = Date.now()

// Pass to goal event:
processGoalRuntimeEvent({
  type: 'turn_finished',
  turnCompleted: true,
  wallStartMs: apiWallStartMs,
  wallEndMs: apiWallEndMs,
}, ...)
```

#### 1.4 Data Structures (types.ts changes)

```typescript
// Goal - add new fields
interface Goal {
  // ...existing fields
  totalApiTokens: number      // Authoritative API token spend
  totalApiWallMs: number      // Total API wall time (excludes user time)
  mode: GoalMode              // 'simple' | 'standard' | 'complex'
  autoEdit: boolean           // Auto-approve file edits only (not bash)
}

type GoalMode = 'simple' | 'standard' | 'complex'
```

### Risks

- **Ring buffer overflow:** Capped at 3 entries, oldest dropped. If compact happens 4+ turns without reconciliation, some detail lost but `totalApiTokens` remains accurate.
- **Migration:** Existing goals lack `totalApiTokens`. Initialize to `tokensUsed` on first access.

---

## Module 2: Control Flow Redesign

**Issues:** #1 (no exit), #5 (rigid prompt), #9 (error infinite loop)

### Problem

Goal auto-continues indefinitely. Continuation prompt is same length for all goals. Errors silently continue execution.

### Solution

#### 2.1 New Subcommands (goal.tsx)

```
/goal pause          # Pause auto-continue, preserve goal state
/goal resume         # Resume auto-continue from paused state
/goal stop           # Stop and clear (alias for clear)
/goal edit <text>    # Modify goal objective without restarting
/goal budget <N>     # Dynamically adjust token budget
/goal mode <simple|standard|complex>  # Change prompt tier
```

Implementation in `parseGoalArgs`:

```typescript
function parseGoalArgs(args: string[]): GoalCommandArgs {
  // ...existing parsing
  const modeMatch = args.find(a => ['simple', 'standard', 'complex'].includes(a.toLowerCase()))
  const mode = modeMatch ? modeMatch.toLowerCase() as GoalMode : 'standard'

  const autoEdit = args.includes('--auto-edit')
  const budgetMatch = args.find((a, i) => a === '--budget' && args[i + 1])
  const budget = budgetMatch ? parseInt(args[args.indexOf(budgetMatch) + 1], 10) : undefined

  // ...
}
```

#### 2.2 Tiered Continuation Prompts (goalSteering.ts)

```typescript
type GoalMode = 'simple' | 'standard' | 'complex'

function getContinuationTemplate(mode: GoalMode): string {
  switch (mode) {
    case 'simple':
      return SIMPLE_CONTINUATION_TEMPLATE  // ~50 tokens
    case 'standard':
      return STANDARD_CONTINUATION_TEMPLATE  // ~200 tokens
    case 'complex':
      return COMPLEX_CONTINUATION_TEMPLATE  // ~400+ tokens with auto-review
  }
}
```

- **Simple:** "Continue working toward: {{objective}}. Next action?"
- **Standard:** Current template (autonomy instructions + progress tracking)
- **Complex:** Current template + auto-review cycle + decision synthesis

#### 2.3 Error Counter & Auto-Pause (goalRuntime.ts)

```typescript
interface GoalRuntimeState {
  // ...existing
  consecutiveErrors: number  // New field
}

// In processGoalRuntimeEvent catch block:
catch (error) {
  console.error('[goalRuntime] Error processing event:', error)
  runtime.consecutiveErrors = (runtime.consecutiveErrors ?? 0) + 1

  if (runtime.consecutiveErrors >= 3) {
    const pausedGoal = { ...goal, status: Status.Paused, updatedAt: Date.now() }
    context.updateGoal(pausedGoal)
    return {
      shouldContinue: false,
      injectedPrompt: `[Goal paused due to errors] 3 consecutive errors encountered. Use /goal resume to continue or /goal stop to cancel.`,
    }
  }

  return { shouldContinue: true }  // Continue but increment error counter
}

// On success, reset error counter:
case 'turn_finished':
  runtime.consecutiveErrors = 0  // Reset on successful turn
```

#### 2.4 Maybe Continue If Idle — Respect Paused State

```typescript
case 'maybe_continue_if_idle':
  if (goal.status === Status.Paused) {
    return { shouldContinue: false }  // Don't re-inject for paused goals
  }
  if (goal.status === Status.Active) {
    const continuationPrompt = buildContinuationPrompt(goal)
    return { shouldContinue: true, injectedPrompt: continuationPrompt }
  }
  return { shouldContinue: false }
```

### Risks

- **Backward compatibility:** Existing goals lack `mode` field. Default to `'standard'` on access.
- **User confusion:** `/goal pause` vs `/goal stop` distinction needs clear messaging.

---

## Module 3: Safety & Isolation

**Issues:** #2 (todo coupling), #7 (auto-accept risk), #8 (prompt injection), #10 (hardcoded list), #12 (compact boundary)

### Problem

Goal tied to sessionId-based todos. `--auto-accept` sets full bypassPermissions. Objective not isolated from prompt injection. Hardcoded tool exclusion list.

### Solution

#### 3.1 Decouple Goal from TodoWrite

Instead of binding `goal.todoListId` to `sessionId`, use a dedicated `goalTasks` list:

```typescript
// In types.ts
interface Goal {
  // ...existing
  goalTaskListId?: string  // Dedicated task list ID (not sessionId)
}

// In AppState
interface AppState {
  // ...existing
  goalTasks: Record<string, GoalTask[]>  // key = goalTaskListId
}

interface GoalTask {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  order: number
}
```

Goal creation creates its own task list:

```typescript
// In goal.tsx call handler
const goalTaskListId = `goal_${newGoal.id}`
const defaultGoalTasks = createDefaultGoalTasks(objective)

context.setAppState(s => ({
  ...s,
  goal: { ...newGoal, goalTaskListId },
  goalTasks: {
    ...s.goalTasks,
    [goalTaskListId]: defaultGoalTasks,
  },
}))
```

#### 3.2 Replace bypassPermissions with autoEdit Mode

`--auto-accept` → `--auto-edit` which only auto-approves file edits, not bash commands:

```typescript
// In goal.tsx
const newMode = autoEdit ? 'autoEdit' : s.toolPermissionContext.mode
// autoEdit mode: auto-approve FileEdit, FileWrite, Bash (read-only)
// but still prompt for Bash (write), network, etc.
```

Add `autoEdit` mode to permission context:

```typescript
interface ToolPermissionContext {
  mode: 'default' | 'auto' | 'autoEdit' | 'bypassPermissions'
  // ...
}
```

#### 3.3 Instruction Boundary Isolation

Separate user objective (untrusted data) from system instructions:

```typescript
// In goalSteering.ts
export function buildContinuationPrompt(goal: Goal): string {
  const template = getContinuationTemplate(goal.mode ?? 'standard')
  const instructions = extractInstructions(template)

  return `
<goal_objective>${escapeXml(goal.objective)}</goal_objective>
<system_instructions>
${instructions}
</system_instructions>
<progress>
- Tokens: ${goal.tokensUsed} / ${goal.tokenBudget ?? 'unbounded'}
- Time: ${goal.timeUsedSeconds}s
</progress>
`
}
```

The model is instructed to treat `<goal_objective>` as data, not instructions.

#### 3.4 Replace Hardcoded Tool List with isWorkTool()

```typescript
// In goalRuntime.ts
const WORK_TOOLS = new Set([
  'Bash', 'FileEdit', 'FileWrite', 'FileRead', 'Glob', 'Grep',
  'Agent', 'SkillTool', 'TodoWrite',
])

function isWorkTool(toolName: string): boolean {
  return WORK_TOOLS.has(toolName)
}

// In tool_completed handler:
if (isWorkTool(event.toolName)) {
  autoProgressTasks(todos, context.updateTodos)
}
```

#### 3.5 Compact-Safe Goal Messages

Mark goal continuation prompts with `isMeta: true` and add compact boundary protection:

```typescript
// In goal.tsx
onDone(message, {
  display: 'system',
  metaMessages: [{
    ...continuationPrompt,
    isMeta: true,
    compactSafe: true,  // New flag: exclude from summarization
  }],
  shouldQuery: true,
})
```

In compact system, respect `compactSafe` flag:

```typescript
// In compact.ts
function getMessagesAfterCompactBoundary(messages: Message[]): Message[] {
  // Skip compactSafe messages — they should persist across compacts
  const safeMessages = messages.filter(m => m.message?.compactSafe !== true)
  // ...existing logic on safeMessages
  // Return: summary + safeMessages
}
```

### Risks

- **AppState bloat:** `goalTasks` adds a new record. Keep lightweight — only 4 tasks per goal.
- **autoEdit mode complexity:** New permission mode needs testing across all tool types.
- **compactSafe flag:** Must be consistent across all message types. Add to `Message` type definition.

---

## Module 4: Experience & Visibility

**Issues:** #6 (missing progress UI), #11 (stale data after compact)

### Problem

GoalProgress component disabled. No "what's next" display. After compact, continuation prompt data becomes stale.

### Solution

#### 4.1 Re-enable and Improve GoalProgress

Uncomment in REPL.tsx and add new sections:

```typescript
// In GoalProgress.tsx
export function GoalProgress() {
  // ...existing hooks

  // New: show current action and next step
  const currentTask = goalTasks?.find(t => t.status === 'in_progress')
  const nextTask = goalTasks?.find(t => t.status === 'pending')

  // New: show consecutive errors
  const consecutiveErrors = goalRuntime?.consecutiveErrors ?? 0

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      {/* ...existing: objective, tasks, budget */}

      {/* New: current action */}
      {currentTask && (
        <Box>
          <Text color="cyan">Current: </Text>
          <Text>{currentTask.content}</Text>
        </Box>
      )}

      {/* New: next step */}
      {nextTask && (
        <Box>
          <Text dimColor>Next: </Text>
          <Text dimColor>{nextTask.content}</Text>
        </Box>
      )}

      {/* New: error indicator */}
      {consecutiveErrors > 0 && (
        <Box>
          <Text color="red">⚠️ {consecutiveErrors} error(s) this turn</Text>
        </Box>
      )}
    </Box>
  )
}
```

#### 4.2 Strategy Self-Review in Continuation Prompt

Add to all tier templates:

```
## Self-Review
Before proceeding, briefly assess:
1. Is the current approach working? → If no, switch strategy
2. Am I making progress toward the objective? → If no, reconsider the plan
3. Are there simpler alternatives? → If yes, prefer them
```

#### 4.3 Dead-Turn Detection

Detect when 2+ consecutive turns produce no observable changes:

```typescript
// In goalRuntime.ts turn_finished handler
let turnsWithNoChanges = runtime.turnsWithNoChanges ?? 0

// Check if this turn produced changes (file edits, bash output, etc.)
const hadObservableChanges = checkForObservableChanges(prevMessages, currentMessages)

if (!hadObservableChanges) {
  turnsWithNoChanges++
} else {
  turnsWithNoChanges = 0
}
runtime.turnsWithNoChanges = turnsWithNoChanges

if (turnsWithNoChanges >= 2) {
  return {
    shouldContinue: true,
    injectedPrompt: buildContinuationPrompt(goal) + `\n\n## ⚠️ Strategy Check\nThe last 2 turns produced no observable changes. Consider:\n- Trying a different approach\n- Breaking the problem into smaller steps\n- Using /goal pause to stop and reconsider`,
  }
}
```

#### 4.4 Post-Compact Fresh Data Rebuild

After compact, rebuild continuation prompt with fresh data:

```typescript
// In compact.ts, after compaction completes:
const updatedGoal = appState.goal
if (updatedGoal?.status === ThreadGoalStatus.Active) {
  const freshPrompt = buildContinuationPrompt({
    ...updatedGoal,
    tokensUsed: goalRuntime.totalApiTokens,  // Use authoritative value
    timeUsedSeconds: Math.floor(goalRuntime.totalApiWallMs / 1000),
  })
  // Inject fresh prompt
  injectPrompt(freshPrompt)
}
```

### Risks

- **GoalProgress performance:** Additional hooks could slow render. Use memoization.
- **Dead-turn detection accuracy:** `checkForObservableChanges` needs careful definition. Too strict = false positives; too loose = misses real dead turns.

---

## Migration Plan

### Backward Compatibility

| Field | Default for Existing Goals | Notes |
|-------|---------------------------|-------|
| `mode` | `'standard'` | Auto-selected on first access |
| `autoEdit` | `false` | Existing goals use current permission mode |
| `totalApiTokens` | `goal.tokensUsed` | Seed from existing value |
| `totalApiWallMs` | `goal.timeUsedSeconds * 1000` | Approximate seed |
| `goalTaskListId` | `goal.todoListId` (if exists) | Fall back to existing todos |
| `consecutiveErrors` | `0` | No existing errors |
| `turnsWithNoChanges` | `0` | No existing history |

### Migration Steps

1. Add new fields to `Goal` and `GoalRuntimeState` types with optional/nullable defaults
2. Add migration function in `goalRuntime.ts` that populates defaults on first access
3. Update goal command to accept new flags (`--mode`, `--auto-edit`)
4. Update continuation prompt builder to use new fields
5. Re-enable GoalProgress component
6. Test with existing goals to ensure no data loss

---

## File Changes

| File | Changes |
|------|---------|
| `src/commands/goal/types.ts` | Add GoalMode, autoEdit, totalApiTokens, totalApiWallMs, goalTaskListId, GoalTask |
| `src/commands/goal/goal.tsx` | Add subcommands (edit, budget, mode, stop), autoEdit flag, goalTask creation |
| `src/utils/goal/goalRuntime.ts` | Ring buffer, error counter, isWorkTool(), dead-turn detection, strategy self-review |
| `src/utils/goal/goalSteering.ts` | Tiered templates, instruction boundary isolation |
| `src/utils/goal/goalAccounting.ts` | API wall time tracking, totalApiTokens reconciliation |
| `src/services/compact/compact.ts` | Compact-safe message filtering, post-compact fresh data rebuild |
| `src/query.ts` | API wall time capture, turn_finished event with timing, goalTasks integration |
| `src/tools/UpdateGoalTool/UpdateGoalTool.tsx` | Support autoEdit mode |
| `src/components/goal/GoalProgress.tsx` | Re-enable, add current/next/error display |
| `src/state/AppStateStore.ts` | Add goalTasks to AppState |
| `src/types/message.ts` | Add compactSafe flag to Message |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Ring buffer loses detail | Medium | totalApiTokens remains accurate; detail only needed for debugging |
| autoEdit mode incomplete | High | Test against all tool types before release |
| Dead-turn false positives | Low | Strategy check is advisory, not blocking |
| compactSafe flag inconsistency | Medium | Add type-level enforcement in message.ts |
| Migration data loss | High | Seed all new fields from existing values; test migration thoroughly |

---

## Success Criteria

1. Token counting matches API response.usage within 1%
2. Goal can be paused and resumed without data loss
3. 3 consecutive errors auto-pause goal with user notification
4. GoalProgress visible and accurate in UI
5. --auto-edit does not bypass bash permissions
6. Continuation prompt persists across compact
7. Dead-turn detection triggers after 2+ turns with no changes
8. No negative tokenDelta after compact