/**
 * Tests for GoalRuntimeState orchestrator fields + GoalTask skipped status
 *
 * Run: bun test src/commands/goal/types.test.ts
 */

import { describe, it, expect } from "bun:test"
import type { GoalRuntimeState, GoalTask } from "./types.js"

describe("GoalRuntimeState orchestrator fields", () => {
  it("should accept optional currentScenario", () => {
    const state = {} as GoalRuntimeState
    expect(state.currentScenario).toBeUndefined()
  })

  it("should accept optional convergenceState", () => {
    const state = {} as GoalRuntimeState
    expect(state.convergenceState).toBeUndefined()
  })

  it("should accept optional errorTracker", () => {
    const state = {} as GoalRuntimeState
    expect(state.errorTracker).toBeUndefined()
  })

  it("should accept optional lastObservation", () => {
    const state = {} as GoalRuntimeState
    expect(state.lastObservation).toBeUndefined()
  })

  it("should allow setting currentScenario", () => {
    const state: GoalRuntimeState = {
      accounting: { turn: null, wallClock: { lastAccountedAt: 0, activeGoalId: null } },
      budgetLimitReportedGoalId: null,
      continuationTurnId: null,
      turnBuffer: [],
      totalApiTokens: 0,
      totalApiWallMs: 0,
      consecutiveErrors: 0,
      turnsWithNoChanges: 0,
      _currentTurnWallStartMs: 0,
      _toolCallsThisTurn: [],
      consecutiveCritical: 0,
      currentScenario: "troubleshooting",
    }
    expect(state.currentScenario).toBe("troubleshooting")
  })

  it("should allow setting convergenceState", () => {
    const state: GoalRuntimeState = {
      accounting: { turn: null, wallClock: { lastAccountedAt: 0, activeGoalId: null } },
      budgetLimitReportedGoalId: null,
      continuationTurnId: null,
      turnBuffer: [],
      totalApiTokens: 0,
      totalApiWallMs: 0,
      consecutiveErrors: 0,
      turnsWithNoChanges: 0,
      _currentTurnWallStartMs: 0,
      _toolCallsThisTurn: [],
      consecutiveCritical: 0,
      convergenceState: {
        informationGains: [0.5, 0.3],
        qualityScores: [80, 85],
        changeMagnitudes: [10, 5],
        round: 2,
      },
    }
    expect(state.convergenceState?.round).toBe(2)
  })

  it("should allow setting errorTracker with Record (not Map)", () => {
    const state: GoalRuntimeState = {
      accounting: { turn: null, wallClock: { lastAccountedAt: 0, activeGoalId: null } },
      budgetLimitReportedGoalId: null,
      continuationTurnId: null,
      turnBuffer: [],
      totalApiTokens: 0,
      totalApiWallMs: 0,
      consecutiveErrors: 0,
      turnsWithNoChanges: 0,
      _currentTurnWallStartMs: 0,
      _toolCallsThisTurn: [],
      consecutiveCritical: 0,
      errorTracker: {
        categories: {
          runtime_exception: { count: 1, threshold: 3 },
          dead_turn: { count: 0, threshold: 5 },
          critical_analysis: { count: 0, threshold: 3 },
        },
        recoveryLayer: "FIX_RETRY",
        fullRestartUsed: false,
      },
    }
    expect(state.errorTracker?.recoveryLayer).toBe("FIX_RETRY")
    // Verify JSON-serializable (Record, not Map)
    const json = JSON.stringify(state.errorTracker)
    expect(json).toContain("runtime_exception")
  })

  it("should allow setting lastObservation", () => {
    const state: GoalRuntimeState = {
      accounting: { turn: null, wallClock: { lastAccountedAt: 0, activeGoalId: null } },
      budgetLimitReportedGoalId: null,
      continuationTurnId: null,
      turnBuffer: [],
      totalApiTokens: 0,
      totalApiWallMs: 0,
      consecutiveErrors: 0,
      turnsWithNoChanges: 0,
      _currentTurnWallStartMs: 0,
      _toolCallsThisTurn: [],
      consecutiveCritical: 0,
      lastObservation: {
        mainPhase: "FIX",
        phases: ["ANALYZE", "FIX"],
        qualitySignals: { hasErrors: false, hasSuccess: true, hasProgress: true },
      },
    }
    expect(state.lastObservation?.mainPhase).toBe("FIX")
  })
})

describe("GoalTask skipped status", () => {
  it("should accept 'skipped' status", () => {
    const task: GoalTask = {
      id: "task-1",
      content: "Skipped task",
      status: "skipped",
      order: 1,
    }
    expect(task.status).toBe("skipped")
  })

  it("should accept all valid statuses", () => {
    const statuses: GoalTask["status"][] = ["pending", "in_progress", "completed", "skipped"]
    for (const status of statuses) {
      const task: GoalTask = { id: "t", content: "", status, order: 0 }
      expect(task.status).toBe(status)
    }
  })
})
