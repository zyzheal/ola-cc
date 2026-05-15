import type { TokenUsage, Goal, TurnRecord } from '../../commands/goal/types.js'

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
  analysisFields?: {
    toolCallsSummary?: string[]
    outputSummary?: string
    hadObservableChanges?: boolean
  },
): TurnRecord[] {
  const record: TurnRecord = {
    turnId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedInputTokens,
    wallStartMs,
    wallEndMs,
    ...analysisFields,
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