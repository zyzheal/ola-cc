import type { TokenUsage, Goal } from '../../commands/goal/types.js'

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