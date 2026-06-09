/**
 * Tool call budget utilities for limiting tool calls per agent execution.
 *
 * Extracted from agentToolUtils.ts to avoid circular dependency issues
 * (agentToolUtils → AgentTool → agentToolResultSchema cycle).
 */

import type { AgentClass } from './agentClassifications.js'

/** Default tool call budget when not specified */
const DEFAULT_TOOL_CALL_BUDGET = 40

/**
 * Adaptive budget multipliers by agent class.
 * Review/research agents read many files and need higher budgets.
 */
const CLASS_BUDGET_MULTIPLIERS: Record<AgentClass, number> = {
  review: 2.0,       // 80 — reads many files, grep, cross-references
  research: 2.0,     // 80 — exploratory reads across large codebases
  implementation: 1.0, // 40 — focused writes, fewer reads needed
  planning: 1.25,    // 50 — moderate reads for architecture analysis
  general: 1.0,      // 40 — default
}

/**
 * Progressive warning thresholds (fraction of maxToolCalls).
 * Injects efficiency hints at each tier to prevent context waste.
 */
export const BUDGET_WARNING_THRESHOLDS = [0.5, 0.7, 0.9] as const

/**
 * Get the maximum tool calls allowed for an agent execution.
 * Priority: OLA_CC_TOOL_CALL_BUDGET env var > agentBudget > adaptive default
 * Set env var to 0 or -1 to disable the budget.
 *
 * @param agentBudget - Explicit budget from caller (highest after env var)
 * @param agentClass - Agent classification for adaptive default scaling
 */
export function getMaxToolCalls(agentBudget?: number, agentClass?: AgentClass): number | undefined {
  const envVar = process.env.OLA_CC_TOOL_CALL_BUDGET
  if (envVar !== undefined && envVar !== '') {
    const parsed = parseInt(envVar, 10)
    if (isNaN(parsed)) return agentBudget ?? getAdaptiveBudget(agentClass)
    if (parsed <= 0) return undefined
    return parsed
  }
  return agentBudget ?? getAdaptiveBudget(agentClass)
}

/**
 * Compute adaptive budget based on agent class.
 * Falls back to DEFAULT_TOOL_CALL_BUDGET for unknown classes.
 */
function getAdaptiveBudget(agentClass?: AgentClass): number {
  const multiplier = (agentClass && agentClass in CLASS_BUDGET_MULTIPLIERS)
    ? CLASS_BUDGET_MULTIPLIERS[agentClass]
    : 1.0
  return Math.round(DEFAULT_TOOL_CALL_BUDGET * multiplier)
}

/**
 * Build a progressive budget warning message for the given threshold tier.
 *
 * @param totalToolCalls - Current tool call count
 * @param maxToolCalls - Maximum allowed tool calls
 * @param threshold - The threshold tier that was crossed (0.5/0.7/0.9)
 */
export function buildBudgetWarning(
  totalToolCalls: number,
  maxToolCalls: number,
  threshold: number,
): string {
  const remaining = maxToolCalls - totalToolCalls
  const usedPct = Math.round((totalToolCalls / maxToolCalls) * 100)
  if (threshold >= 0.9) {
    return `[Budget Critical] ${remaining} tool calls remaining (${usedPct}% used). Stop reading new files. Use only the information already gathered to complete your analysis.`
  }
  if (threshold >= 0.7) {
    return `[Budget Warning] ${remaining} tool calls remaining (${usedPct}% used). Prioritize: use grep/glob over full file reads. Combine related searches into single calls.`
  }
  return `[Budget Notice] ${remaining} tool calls remaining (${usedPct}% used). Plan your remaining reads carefully — prefer targeted grep over broad exploration.`
}
