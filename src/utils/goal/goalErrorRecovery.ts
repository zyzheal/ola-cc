/**
 * Three-layer error recovery state machine.
 * Returns recovery decisions with prompts.
 * NOTE: Directly modifies tracker state (recoveryLayer, category resets, fullRestartUsed)
 * as a side effect. Caller should NOT additionally modify tracker after calling these functions.
 */

import type { UnifiedErrorTracker, RecoveryLayer } from "./goalErrorTracker.js"
import { resetCategory, resetOnProgress } from "./goalErrorTracker.js"

export interface RecoveryDecision {
  action: "retry" | "escalate" | "pause" | "continue"
  layer: RecoveryLayer
  recoveryPrompt?: string
}

export function handleVerifyFailure(tracker: UnifiedErrorTracker, detail: string): RecoveryDecision {
  const runtimeCount = tracker.categories.runtime_exception.count
  const threshold = tracker.categories.runtime_exception.threshold

  if (runtimeCount >= threshold) {
    if (tracker.recoveryLayer === "FIX_RETRY") {
      tracker.recoveryLayer = "SKILL_RETRY"
      resetCategory(tracker, "runtime_exception")
      return {
        action: "escalate",
        layer: "SKILL_RETRY",
        recoveryPrompt: `FIX_RETRY exhausted (3 failures). Escalating to SKILL_RETRY. Last error: ${detail}. Try invoking a different skill for this task.`,
      }
    }
    if (tracker.recoveryLayer === "SKILL_RETRY") {
      tracker.recoveryLayer = "FULL_RESTART"
      resetCategory(tracker, "runtime_exception")
      return {
        action: "escalate",
        layer: "FULL_RESTART",
        recoveryPrompt: `SKILL_RETRY exhausted. Escalating to FULL_RESTART. Last error: ${detail}. Re-analyze from scratch with a different approach.`,
      }
    }
    if (tracker.recoveryLayer === "FULL_RESTART") {
      if (tracker.fullRestartUsed) {
        return {
          action: "pause",
          layer: "FULL_RESTART",
          recoveryPrompt: `All recovery layers exhausted. Pausing goal. Last error: ${detail}`,
        }
      }
      tracker.fullRestartUsed = true
      resetCategory(tracker, "runtime_exception")
      return {
        action: "retry",
        layer: "FULL_RESTART",
        recoveryPrompt: `FULL_RESTART: Starting fresh. Last error: ${detail}. Re-read all relevant files and reconsider the approach.`,
      }
    }
  }

  return {
    action: "retry",
    layer: tracker.recoveryLayer,
    recoveryPrompt: `[${tracker.recoveryLayer}] Verification failed: ${detail}. Fix the specific issue and retry.`,
  }
}

export function handleReviewRejection(tracker: UnifiedErrorTracker, reason: string): RecoveryDecision {
  return {
    action: "retry",
    layer: tracker.recoveryLayer,
    recoveryPrompt: `[${tracker.recoveryLayer}] Review flagged: ${reason}. Address the concern before proceeding.`,
  }
}

export function resetRecovery(tracker: UnifiedErrorTracker): void {
  tracker.recoveryLayer = "FIX_RETRY"
  resetCategory(tracker, "runtime_exception")
  resetOnProgress(tracker)
}
