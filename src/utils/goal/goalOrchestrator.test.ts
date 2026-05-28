/**
 * Tests for goalOrchestrator — pure-function decision matrix
 *
 * Run: bun test src/utils/goal/goalOrchestrator.test.ts
 */

import { describe, it, expect } from "bun:test"
import { createOrchestratorDecision, SCENARIO_CIRCUIT_BREAKER } from "./goalOrchestrator.js"

describe("createOrchestratorDecision", () => {
  it("should continue when all checks pass", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: false },
      errorTracker: { shouldPause: false },
      allTasksDone: false,
    })
    expect(decision.action).toBe("continue")
    expect(decision.reason).toBe("continuing")
  })

  it("should pause when error tracker says pause", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: false },
      errorTracker: { shouldPause: true, reason: "3 consecutive errors" },
      allTasksDone: false,
    })
    expect(decision.action).toBe("pause")
    expect(decision.reason).toContain("3 consecutive errors")
    expect(decision.pauseReason).toBeDefined()
  })

  it("should continue with completion prompt when all tasks done", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: false },
      errorTracker: { shouldPause: false },
      allTasksDone: true,
    })
    expect(decision.action).toBe("continue")
    expect(decision.prompt).toContain("complete")
  })

  it("should continue with advance prompt on convergence", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: true, reason: "info_gain_stable" },
      errorTracker: { shouldPause: false },
      allTasksDone: false,
    })
    expect(decision.action).toBe("continue")
    expect(decision.prompt).toContain("converged")
  })

  it("should pause on max_rounds_low_quality", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: true, reason: "max_rounds_low_quality" },
      errorTracker: { shouldPause: false },
      allTasksDone: false,
    })
    expect(decision.action).toBe("pause")
    expect(decision.reason).toContain("low quality")
  })

  it("should not continue when goal is paused", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "paused" },
      convergence: { converged: false },
      errorTracker: { shouldPause: false },
      allTasksDone: false,
    })
    expect(decision.action).toBe("pause")
  })

  it("should skip task when round limit exceeded", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: false },
      errorTracker: { shouldPause: false },
      allTasksDone: false,
      roundExceeded: true,
    })
    expect(decision.action).toBe("skip_task")
  })

  it("should retry when in non-FIX_RETRY recovery layer", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: false },
      errorTracker: { shouldPause: false },
      allTasksDone: false,
      recoveryLayer: "SKILL_RETRY",
    })
    expect(decision.action).toBe("retry")
    expect(decision.prompt).toContain("SKILL_RETRY")
  })

  it("should not retry when in FIX_RETRY layer", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: false },
      errorTracker: { shouldPause: false },
      allTasksDone: false,
      recoveryLayer: "FIX_RETRY",
    })
    expect(decision.action).toBe("continue")
  })

  it("should prioritize error pause over convergence", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: true, reason: "info_gain_stable" },
      errorTracker: { shouldPause: true, reason: "too many errors" },
      allTasksDone: false,
    })
    expect(decision.action).toBe("pause")
  })

  it("should prioritize allTasksDone over convergence", () => {
    const decision = createOrchestratorDecision({
      goal: { status: "active" },
      convergence: { converged: true, reason: "info_gain_stable" },
      errorTracker: { shouldPause: false },
      allTasksDone: true,
    })
    expect(decision.action).toBe("continue")
    expect(decision.prompt).toContain("complete")
  })
})

describe("SCENARIO_CIRCUIT_BREAKER", () => {
  it("should have thresholds for all 5 scenarios", () => {
    expect(SCENARIO_CIRCUIT_BREAKER.code_change.maxPerTask).toBe(5)
    expect(SCENARIO_CIRCUIT_BREAKER.doc_writing.maxPerTask).toBe(3)
    expect(SCENARIO_CIRCUIT_BREAKER.troubleshooting.maxPerTask).toBe(8)
    expect(SCENARIO_CIRCUIT_BREAKER.design_improve.maxPerTask).toBe(5)
    expect(SCENARIO_CIRCUIT_BREAKER.refactoring.maxPerTask).toBe(6)
  })

  it("should have timeout for all scenarios", () => {
    for (const [key, val] of Object.entries(SCENARIO_CIRCUIT_BREAKER)) {
      expect(val.timeoutMs).toBeGreaterThan(0)
    }
  })
})
