/**
 * Tests for goalErrorRecovery — 3-layer recovery state machine
 *
 * Run: bun test src/utils/goal/goalErrorRecovery.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { handleVerifyFailure, handleReviewRejection, resetRecovery } from "./goalErrorRecovery.js"
import { createTracker, recordError } from "./goalErrorTracker.js"
import type { UnifiedErrorTracker } from "./goalErrorTracker.js"

describe("goalErrorRecovery", () => {
  let tracker: UnifiedErrorTracker

  beforeEach(() => {
    tracker = createTracker()
  })

  describe("handleVerifyFailure", () => {
    it("should retry at FIX_RETRY level", () => {
      const decision = handleVerifyFailure(tracker, "build failed")
      expect(decision.action).toBe("retry")
      expect(decision.layer).toBe("FIX_RETRY")
      expect(decision.recoveryPrompt).toBeDefined()
    })

    it("should escalate to SKILL_RETRY after 3 FIX_RETRY failures", () => {
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      const decision = handleVerifyFailure(tracker, "build failed")
      expect(decision.action).toBe("escalate")
      expect(decision.layer).toBe("SKILL_RETRY")
    })

    it("should escalate to FULL_RESTART after 3 SKILL_RETRY failures", () => {
      tracker.recoveryLayer = "SKILL_RETRY"
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      const decision = handleVerifyFailure(tracker, "build failed")
      expect(decision.action).toBe("escalate")
      expect(decision.layer).toBe("FULL_RESTART")
    })

    it("should pause after FULL_RESTART exhausted", () => {
      tracker.recoveryLayer = "FULL_RESTART"
      tracker.fullRestartUsed = true
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      const decision = handleVerifyFailure(tracker, "build failed")
      expect(decision.action).toBe("pause")
    })

    it("should retry at FULL_RESTART first time", () => {
      tracker.recoveryLayer = "FULL_RESTART"
      tracker.fullRestartUsed = false
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      const decision = handleVerifyFailure(tracker, "build failed")
      expect(decision.action).toBe("retry")
      expect(decision.layer).toBe("FULL_RESTART")
      expect(tracker.fullRestartUsed).toBe(true)
    })

    it("should include error detail in prompt", () => {
      const decision = handleVerifyFailure(tracker, "syntax error on line 42")
      expect(decision.recoveryPrompt).toContain("syntax error on line 42")
    })

    it("should reset runtime_exception count on escalation", () => {
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      handleVerifyFailure(tracker, "error")
      expect(tracker.categories.runtime_exception.count).toBe(0)
    })
  })

  describe("handleReviewRejection", () => {
    it("should retry with review feedback", () => {
      const decision = handleReviewRejection(tracker, "architecture concern")
      expect(decision.action).toBe("retry")
      expect(decision.recoveryPrompt).toContain("architecture concern")
    })

    it("should use current recovery layer", () => {
      tracker.recoveryLayer = "SKILL_RETRY"
      const decision = handleReviewRejection(tracker, "issue")
      expect(decision.layer).toBe("SKILL_RETRY")
    })
  })

  describe("resetRecovery", () => {
    it("should reset layer to FIX_RETRY", () => {
      tracker.recoveryLayer = "SKILL_RETRY"
      resetRecovery(tracker)
      expect(tracker.recoveryLayer).toBe("FIX_RETRY")
    })

    it("should reset runtime_exception count", () => {
      recordError(tracker, "runtime_exception")
      resetRecovery(tracker)
      expect(tracker.categories.runtime_exception.count).toBe(0)
    })

    it("should reset dead_turn count", () => {
      recordError(tracker, "dead_turn")
      recordError(tracker, "dead_turn")
      resetRecovery(tracker)
      expect(tracker.categories.dead_turn.count).toBe(0)
    })
  })
})
