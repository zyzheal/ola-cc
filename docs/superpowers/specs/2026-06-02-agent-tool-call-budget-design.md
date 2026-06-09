# Agent Tool Call Budget & Virtual Progress Design

## Problem

When an Agent executes a task with 40-50 tool calls, the TUI freezes and CPU reaches 100%.

**Root cause**: React reconciler commit phase (Yoga layout + terminal rendering) takes 164ms per commit. At 5-9 commits/s, this saturates the CPU. The commit cost is proportional to fiber tree node count — 15 transcript messages create ~600-750 fiber nodes.

**Why other projects don't have this issue**: They use simpler agents (5-10 tool calls per task). The same architectural flaw exists but isn't triggered at smaller scale.

**Why ola-cc hasn't solved it**: Previous optimizations targeted the scheduling layer (tick frequency, throttle, FrameCoalescer), but the root cause is fiber tree size. Scheduling optimization has a ceiling: when commit time > minimum tick interval, no amount of throttling helps.

## Design Decisions

### What we build

1. **ToolCallBudget** — hard limit on tool calls per agent execution, stopping the source of fiber node growth
2. **VirtualProgressRenderer** — reduce MAX_TRANSCRIPT_MESSAGES to limit fiber nodes
3. **Spinner throttling** — reduce animation frame rate during agent execution

### What we don't build

- ~~TaskComplexityEstimator~~ — keyword-based complexity prediction has 40-50% misclassification rate. Unreliable as a control gate.
- ~~TaskSplitter~~ — automatic task splitting requires semantic understanding that code logic cannot provide. LLM-based splitting adds cost and latency. Existing `forkSubagent` already handles explicit decomposition.
- ~~Pause-Continue mechanism~~ — too complex for v1. Budget exhaustion is treated as normal termination (like `max_turns_reached`).

## Architecture

```
User Request → Agent Execution → ToolCallBudget Check → Exceeded?
                                                        ↓ Yes
                                              yield attachment + return
                                                        ↓ No
                                              Continue execution
                                                        ↓
                              VirtualProgress: fixed window + summary fold
```

Three orthogonal defense layers:
- **ToolCallBudget**: reduces commit **count** (source control)
- **VirtualProgressRenderer**: reduces per-commit **cost** (fiber node reduction)
- **Spinner throttling**: reduces unrelated commit **frequency** (animation dedup)

## P0: Immediate Implementation

### Step 1: SpinnerAnimationRow Throttling

**File**: `src/components/Spinner/SpinnerAnimationRow.tsx`

**Change**: When an agent is actively executing, increase animation interval from 200ms to 500ms.

**Trigger condition**: Check `AppState.tasks` for any task with `status === 'running'`. If any running task exists, use 500ms; otherwise use 200ms.

**CPU impact**: Direct contribution ~1% (Spinner commits are lightweight at ~3ms). Main value is reducing commit overlap spikes with agent progress updates.

### Step 2: MAX_TRANSCRIPT_MESSAGES Reduction

**File**: `src/tools/AgentTool/UI.tsx:35`

**Change**: `MAX_TRANSCRIPT_MESSAGES: 15 → 10`

**Rationale**: 10 preserves sufficient debugging information while significantly reducing fiber nodes.

**Fiber node estimation** (with `processProgressMessages` folding at ~35-40% rate):

| Config | Raw messages | After folding | Nodes/msg | Total nodes |
|--------|-------------|---------------|-----------|-------------|
| 15 (current) | 15 | ~10-12 | 40-50 | 400-600 |
| 10 (proposed) | 10 | ~6-8 | 40-50 | 240-400 |

**Hidden count display**: `+{hiddenCount} more tool uses (ctrl+o to expand)`

### Step 3: ToolCallBudget in query.ts

**File**: `src/query.ts`

**State extension**:
```typescript
type State = {
  // ... existing fields
  totalToolCalls: number  // cumulative tool call count
}
```

**QueryParams extension**:
```typescript
type QueryParams = {
  // ... existing fields
  maxToolCalls?: number  // optional tool call budget
}
```

**Check point**: After all tools in the current turn have completed execution, before the next API call. This ensures:
- Tools are never interrupted mid-execution
- Batch tool calls (multiple `tool_use` blocks in one turn) complete atomically
- The check is symmetric with `maxTurns` check pattern

**Implementation**:
```typescript
// After tool execution completes, before next API call
state.totalToolCalls = (state.totalToolCalls ?? 0) + toolUseBlocks.length
if (params.maxToolCalls && state.totalToolCalls >= params.maxToolCalls) {
  yield createAttachmentMessage({
    type: 'max_tool_calls_reached',
    totalToolCalls: state.totalToolCalls,
    maxToolCalls: params.maxToolCalls
  })
  return { reason: 'max_tool_calls', totalToolCalls: state.totalToolCalls }
}
```

**Default value**: 40 (covers 100% of observed agent tasks: 19, 24, 35 tool calls)

**Environment variable override**: `OLA_CC_TOOL_CALL_BUDGET` — set to 0 or -1 to disable, set to any positive number to override default.

**Per-agent classification defaults** (via P1 `AgentDefinition.toolCallBudget`):

| Agent classification | Default budget |
|---------------------|---------------|
| research (Explore, code-explorer) | 50 |
| planning (Plan, code-architect) | 40 |
| review (verification, code-reviewer) | 30 |
| implementation (general-purpose, coder) | 40 |
| default | 40 |

**Scope**: `totalToolCalls` only counts tool calls from the current `query()` invocation. Sub-agent tool calls (via nested AgentTool) are NOT counted — they have their own independent query and State.

**Error path** (complete propagation chain):

```
query.ts: yield { type: 'max_tool_calls_reached', totalToolCalls, maxToolCalls }
  → runAgent.ts: detect attachment, construct termination message
    → AgentTool.tsx: normal return (not abort)
      → UI.tsx: display completion status with tool call count
```

Budget exhaustion is **normal termination**, not an error. Do not call `abortController.abort()`. The `runAgent()` `finally` block handles all cleanup.

**Relationship with maxTurns**: Both are independent limits checked at different points. `maxTurns` limits API turn count; `maxToolCalls` limits cumulative tool call count. Either limit being reached triggers termination. In practice, `maxToolCalls` will trigger first for tool-heavy agents (5+ tools/turn), while `maxTurns` triggers first for conversation-heavy agents (1-2 tools/turn).

## P1: Follow-up Implementation

### ResourceQuotaManager Extension

**File**: `src/utils/quota/ResourceQuotaManager.ts`

Add `maxToolCalls` dimension to `AgentQuota`:
```typescript
export type AgentQuota = {
  maxBudgetUsd: number
  maxTokens: number
  timeoutMs: number
  maxToolCalls?: number  // new
}
```

Add `toolCalls` to `AgentConsumption`:
```typescript
export type AgentConsumption = {
  costUsd: number
  outputTokens: number
  elapsedMs: number
  toolCalls?: number  // new
}
```

### AgentDefinition Extension

**File**: `src/tools/AgentTool/loadAgentsDir.ts`

Add optional `toolCallBudget` field to `BaseAgentDefinition`:
```typescript
export type BaseAgentDefinition = {
  // ... existing fields
  toolCallBudget?: number  // max tool calls for this agent type
}
```

Add corresponding zod schema in `AgentJsonSchema`.

### AgentTool.tsx Integration

**File**: `src/tools/AgentTool/AgentTool.tsx`

Pass `maxToolCalls` to `query()`:
- Priority: `OLA_CC_TOOL_CALL_BUDGET` env var > `agentDefinition.toolCallBudget` > classification default
- Pass as `params.maxToolCalls` to the `query()` call

## P2: Optional Enhancement

### PromptGuidance

**File**: agent definitions (frontmatter)

Add optional `guidance` field:
```yaml
name: general-purpose
guidance: "Plan before executing. Reduce unnecessary exploration — locate key files directly."
```

This is a soft hint injected into the agent's system prompt. It does not change execution logic. Agent authors opt in by adding the field.

## Performance Prediction

### CPU Model

```
CPU% = commit_time / (commit_time + frame_interval) × 100
```

| Scenario | Commit time | Frame interval | FPS | CPU% |
|----------|------------|----------------|-----|------|
| Current (minimal) | 164ms | 100ms | 3.8 | 62% |
| P0 typical (minimal) | ~100ms | 100ms | 5.0 | 50% |
| P0 high-fold (minimal) | ~87ms | 100ms | 5.3 | 47% |
| P0 + FrameScheduler adaptive | ~100ms | 33ms (degraded) | 7.5 | 25% |

**Key insight**: FrameScheduler's adaptive logic creates positive feedback — lower CPU → higher frame rate → but commit time is fixed → CPU stays low. The actual equilibrium is ~20-25% in typical scenarios.

### Worst Case

ToolCallBudget disabled + low folding rate (agent uses non-search tools like Bash/Edit) + transcript mode:
- 10 messages with minimal folding → ~300-400 fiber nodes
- Commit ~120-146ms
- CPU in minimal: 146/(146+100) = 59%
- **Requires P1 to guarantee <50%** in worst case

### ToolCallBudget=40 Coverage

Based on observed data (35/24/19 tool calls per agent):
- All three cases covered (35 < 40, 24 < 40, 19 < 40)
- Coverage: 100%
- For extreme cases (80+ tool calls), budget prevents fiber tree explosion

## Deployment Strategy

Deploy P0 in three steps, 1-2 days between each:

1. **Step 1**: SpinnerAnimationRow 200→500ms — lowest risk, easiest rollback
2. **Step 2**: MAX_TRANSCRIPT_MESSAGES 15→10 — low risk, UI-only change
3. **Step 3**: ToolCallBudget — highest risk (core loop change), deploy after Steps 1-2 stabilize

## Rollback

| Change | Rollback method | Time |
|--------|----------------|------|
| Spinner throttling | Revert constant to 200ms | 1 min |
| MAX_TRANSCRIPT_MESSAGES | Revert constant to 15 | 1 min |
| ToolCallBudget | Set `OLA_CC_TOOL_CALL_BUDGET=0` | instant |

## Testing

### Unit Tests

- `query.ts`: Test `totalToolCalls` accumulation and `max_tool_calls_reached` termination
- `ResourceQuotaManager`: Test `maxToolCalls` dimension in `checkQuota()`
- `UI.tsx`: Update existing test assertions for `MAX_TRANSCRIPT_MESSAGES=10`

### Integration Tests

- Agent with 40+ tool calls terminates at budget with correct attachment
- Budget exhaustion propagates correctly through query → runAgent → AgentTool → UI
- Sub-agent tool calls are NOT counted in parent budget
- `maxToolCalls` and `maxTurns` interact correctly (independent, first-to-trigger)

### CPU Regression Tests

- Run agent with 40+ tool calls, verify CPU < 50% with P0 changes
- Compare commit time before/after MAX_TRANSCRIPT_MESSAGES reduction
- Verify Spinner throttling reduces commit overlap spikes

## Future Extensions

| Extension | Compatible? | Notes |
|-----------|------------|-------|
| Per-tool-type budget | Yes | Change `totalToolCalls: number` to `toolCallCounts: Map<string, number>` internally |
| Dynamic budget | Yes | `maxToolCalls` as function instead of number, computed at runtime |
| Cross-agent budget | Yes | Pass remaining budget from parent to child in `forkSubagent` |
| `inheritFromParent` option | Yes | P1 `AgentDefinition.toolCallBudget` can support `inheritFromParent: boolean` |
