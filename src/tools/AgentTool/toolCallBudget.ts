/**
 * Tool call budget utilities for limiting tool calls per agent execution.
 *
 * Extracted from agentToolUtils.ts to avoid circular dependency issues
 * (agentToolUtils → AgentTool → agentToolResultSchema cycle).
 */

/** Default tool call budget when not specified */
const DEFAULT_TOOL_CALL_BUDGET = 40

/**
 * Get the maximum tool calls allowed for an agent execution.
 * Priority: OLA_CC_TOOL_CALL_BUDGET env var > agentBudget > default (40)
 * Set env var to 0 or -1 to disable the budget.
 */
export function getMaxToolCalls(agentBudget?: number): number | undefined {
  const envVar = process.env.OLA_CC_TOOL_CALL_BUDGET
  if (envVar !== undefined && envVar !== '') {
    const parsed = parseInt(envVar, 10)
    if (isNaN(parsed)) return agentBudget ?? DEFAULT_TOOL_CALL_BUDGET
    if (parsed <= 0) return undefined
    return parsed
  }
  return agentBudget ?? DEFAULT_TOOL_CALL_BUDGET
}
