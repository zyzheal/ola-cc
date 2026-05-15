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