# Goal Intelligent Analysis - Design Spec

> **Date:** 2026-05-15
> **Status:** Completed
> **Parent Spec:** 2026-05-15-goal-mechanism-redesign.md
> **Feature:** Intelligent Next-Step Recommendation for Goals

---

## Overview

Add intelligent execution analysis to the Goal system. After each turn, perform lightweight analysis to detect issues, and spawn a dedicated Analysis Agent when problems are detected. This creates a two-layer保障 (rule-based detection + AI-powered depth analysis).

---

## Architecture

### Data Flow

```
turn_finished
    ↓
goalAnalysis.analyzeTurnLightweight()  ← 每 turn 轻量检查 (规则)
    ↓
{ ok / warning / critical }
    ↓
warning/critical: runtime.pendingAnalysis = { reason, severity, triggerTurnId }
    ↓
next turn start (query.ts)
    ↓
检查 pendingAnalysis → 注入分析上下文到 prompt
    ↓
Agent 执行分析 → 产出结构化建议
    ↓
建议注入 continuation prompt 或 自动修正
```

### New/Modified Files

| File | Change | Description |
|------|--------|-------------|
| `src/commands/goal/types.ts` | Extend | Add new fields to `TurnRecord` and `GoalRuntimeState` |
| `src/utils/goal/goalAnalysis.ts` | **New** | Lightweight analysis logic |
| `src/utils/goal/goalRuntime.ts` | Extend | Hook lightweight analysis in `turn_finished` |
| `src/tools/AgentTool/built-in/goalAnalysisAgent.ts` | **New** | Built-in Analysis Agent |
| `src/utils/goal/goalSteering.ts` | Extend | Analysis result injection |
| `src/query.ts` | Extend | Check `pendingAnalysis` before turn |

---

## Data Structures

### TurnRecord Extension

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

### GoalRuntimeState Extension

```typescript
export interface GoalRuntimeState {
  // ... existing fields ...
  
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

---

## Lightweight Analysis Rules

### Implementation (`goalAnalysis.ts`)

```typescript
const WARNING_PATTERNS = [
  'i cannot', 'blocked', 'permission denied',
  'error', 'failed', 'unable to', 'not allowed'
]

export interface AnalysisResult {
  status: 'ok' | 'warning' | 'critical'
  issues: string[]
  recommendation: string
}

export function analyzeTurnLightweight(
  turnRecord: TurnRecord,
  previousTurnsWithNoChanges: number
): { status: 'ok' | 'warning' | 'critical'; reason?: string } {
  
  // 1. Error pattern detection
  const outputLower = turnRecord.outputSummary?.toLowerCase() ?? ''
  const hasError = WARNING_PATTERNS.some(p => outputLower.includes(p))
  
  // 2. Tool call presence
  const hasToolCalls = (turnRecord.toolCallsSummary?.length ?? 0) > 0
  
  // 3. Observable changes (reuse existing logic)
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

### Trigger Conditions

| Status | Condition | Action |
|--------|-----------|--------|
| `ok` | All checks pass | Continue normally |
| `warning` | Non-critical issues detected | Mark `pendingAnalysis` for next turn |
| `critical` | Errors + no progress | Mark `pendingAnalysis` + suggest pause |

---

## Analysis Agent

### Agent Definition (`built-in/goalAnalysisAgent.ts`)

```typescript
export const goalAnalysisAgentDefinition: BuiltInAgentDefinition = {
  agentType: 'goal-analysis',
  whenToUse: 'When goal execution has stalled or produced errors',
  disallowedTools: ['FileEdit', 'FileWrite', 'Bash', 'Edit', 'Write'],
  model: 'haiku',  // Lightweight, cost-effective
  getSystemPrompt(context: GoalAnalysisContext): string {
    return `You are analyzing execution trace for an AI agent working toward a goal.

<goal_objective>${context.objective}</goal_objective>
<recent_execution>${context.turnRecords}</recent_execution>
<current_tasks>${context.taskStatus}</current_tasks>

Analyze:
1. Progress: Is the agent making measurable progress?
2. Pattern: Any recurring issues (errors, empty outputs)?
3. Direction: Is current approach effective?

Output format:
- If progressing: "CONTINUE: [brief encouragement]"
- If adjust needed: "ADJUST: [specific next-step recommendation]"
- If pause needed: "PAUSE: [reason] + /goal pause suggestion"
`
  }
}
```

### Execution Context

The Analysis Agent receives:
- Current goal objective
- Last 3 turn records (from ring buffer)
- Current task list status
- Any pending analysis reason

### Output

The agent outputs one of three directives:
- `CONTINUE` — All good, proceed with current plan
- `ADJUST` — Specific strategy change recommended
- `PAUSE` — Root cause analysis + suggestion to pause

---

## query.ts Integration

### Hook Point

```typescript
// query.ts - Before each turn execution
async function preTurnHook(context: ToolUseContext) {
  const appState = context.getAppState()
  const runtime = appState.goalRuntime
  
  if (runtime?.pendingAnalysis && appState.goal?.status === 'active') {
    // Inject analysis context
    const analysisPrompt = buildAnalysisPrompt(runtime.pendingAnalysis, appState)
    
    // Prepend to messages as system context
    yield { type: 'system', content: analysisPrompt, isMeta: true }
    
    // Clear pending analysis after injection
    context.setAppState(s => ({
      ...s,
      goalRuntime: {
        ...s.goalRuntime,
        pendingAnalysis: undefined,
        lastAnalysisResult: runtime.pendingAnalysis.reason
      }
    }))
  }
}

function buildAnalysisPrompt(pending: PendingAnalysis, appState: AppState): string {
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

---

## Compact Compatibility

- `pendingAnalysis` is stored in `GoalRuntimeState`, which survives compact via appState
- Turn records remain in ring buffer (max 3, compact-safe)
- `lastAnalysisResult` persists for user visibility

---

## Token Cost Estimate

| Operation | Token Cost |
|-----------|------------|
| Lightweight analysis (rules) | ~0 (inline) |
| Analysis Agent spawn (haiku) | ~2K-5K per analysis |
| Trigger frequency | ~10-20% of turns (warning/critical only) |

**Estimated average additional cost:** 200-500 tokens per turn

---

## Migration

- New fields are optional with sensible defaults
- Existing goals continue to work without analysis
- Analysis only triggers on NEW goals (or when feature detects issues)

---

## Testing

1. Unit test `analyzeTurnLightweight()` with mock TurnRecords
2. Integration test: goal creates → executes → triggers analysis → gets recommendation
3. Edge cases: compact during pending analysis, multiple rapid turns

---

## Success Metrics

1. **Detection rate:** X% of actual stalls are caught by lightweight analysis
2. **False positive rate:** Y% of warnings were false alarms
3. **User satisfaction:** Do analysis recommendations feel useful?
4. **Token overhead:** Additional tokens per goal turn within budget