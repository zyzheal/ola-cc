import type { TurnRecord } from '../../commands/goal/types.js'

// Error patterns that indicate actual failures (not normal descriptions)
// Each pattern is a multi-word phrase to reduce false positives
const WARNING_PATTERNS = [
  // Clear capability/capability failures
  'i cannot', 'i can\'t', 'i am unable',
  // Permission/capability denials (tightened to reduce false positives)
  'permission denied', 'access denied',
  'not allowed', 'not permitted',
  'i do not have access to',  // only with 'to' = actual access refusal
  // Error context with specific framing (not "error handling" or "as expected")
  'error occurred', 'error:', 'got an error', 'encountered an error',
  // Action failures
  'failed to', 'has failed', 'will fail',
  // Timeout/network
  'connection refused', 'connection timed out', 'network error',
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

  // Decision tree (order matters: most specific first)
  if (hasError && !hasChanges) {
    return { status: 'critical', reason: 'Errors with no progress' }
  }
  if (hasError && hasToolCalls) {
    return { status: 'warning', reason: 'Error detected in output despite tool calls' }
  }
  if (!hasToolCalls && !hasChanges) {
    return { status: 'warning', reason: 'No tool calls or changes this turn' }
  }
  if (hasToolCalls && !hasChanges) {
    return { status: 'warning', reason: 'Tool calls produced no observable changes' }
  }
  if (isStalled && !hasChanges) {
    return { status: 'warning', reason: 'Stalled for multiple turns' }
  }

  return { status: 'ok' }
}