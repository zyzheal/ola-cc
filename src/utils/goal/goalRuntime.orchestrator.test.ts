/**
 * Tests for goalRuntime orchestrator integration
 *
 * Run: bun test src/utils/goal/goalRuntime.orchestrator.test.ts
 */

import { describe, it, expect } from "bun:test"
import { processGoalRuntimeEvent } from "./goalRuntime.js"
import type { Goal, GoalRuntimeState } from "../../commands/goal/types.js"
import { ThreadGoalStatus } from "../../commands/goal/types.js"

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "test-1",
    threadId: "t-1",
    objective: "fix the crash",
    status: ThreadGoalStatus.Active,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalApiTokens: 0,
    totalApiWallMs: 0,
    mode: "standard",
    autoEdit: false,
    ...overrides,
  }
}

function makeRuntime(): GoalRuntimeState {
  return {
    accounting: {
      turn: null,
      wallClock: { lastAccountedAt: 0, activeGoalId: null },
    },
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
  }
}

const zeroUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
}

describe("goalRuntime orchestrator integration", () => {
  it("should initialize orchestrator state on goal_created", () => {
    const runtime = makeRuntime()
    const goal = makeGoal()
    const updatedGoals: Goal[] = []

    processGoalRuntimeEvent(
      { type: "goal_created", goal },
      {
        goal,
        runtime,
        currentTokenUsage: zeroUsage,
        injectPrompt: async () => {},
        updateGoal: (g) => updatedGoals.push(g),
      },
    )

    expect(runtime.currentScenario).toBeDefined()
    expect(runtime.convergenceState).toBeDefined()
    expect(runtime.errorTracker).toBeDefined()
  })

  it("should identify scenario as troubleshooting for crash objective", () => {
    const runtime = makeRuntime()
    const goal = makeGoal({ objective: "fix the crash in auth module" })

    processGoalRuntimeEvent(
      { type: "goal_created", goal },
      {
        goal,
        runtime,
        currentTokenUsage: zeroUsage,
        injectPrompt: async () => {},
        updateGoal: () => {},
      },
    )

    expect(runtime.currentScenario).toBe("troubleshooting")
  })

  it("should identify scenario as code_change for implement objective", () => {
    const runtime = makeRuntime()
    const goal = makeGoal({ objective: "implement user login feature" })

    processGoalRuntimeEvent(
      { type: "goal_created", goal },
      {
        goal,
        runtime,
        currentTokenUsage: zeroUsage,
        injectPrompt: async () => {},
        updateGoal: () => {},
      },
    )

    expect(runtime.currentScenario).toBe("code_change")
  })

  it("should inject continuation prompt on goal_created", () => {
    const runtime = makeRuntime()
    const goal = makeGoal()

    const result = processGoalRuntimeEvent(
      { type: "goal_created", goal },
      {
        goal,
        runtime,
        currentTokenUsage: zeroUsage,
        injectPrompt: async () => {},
        updateGoal: () => {},
      },
    )

    expect(result.shouldContinue).toBe(true)
    expect(result.injectedPrompt).toBeDefined()
    expect(result.injectedPrompt).toContain("ReAct")
  })

  it("should not crash when turn_finished with orchestrator fields set", () => {
    const runtime = makeRuntime()
    const goal = makeGoal()

    // Initialize orchestrator
    processGoalRuntimeEvent(
      { type: "goal_created", goal },
      {
        goal,
        runtime,
        currentTokenUsage: zeroUsage,
        injectPrompt: async () => {},
        updateGoal: () => {},
      },
    )

    // Now simulate a turn_finished
    runtime.accounting.turn = {
      turnId: "turn-1",
      lastTokenUsage: zeroUsage,
      activeGoalId: goal.id,
    }
    runtime._currentTurnWallStartMs = Date.now() - 1000
    runtime._toolCallsThisTurn = ["Read", "Edit"]

    const result = processGoalRuntimeEvent(
      { type: "turn_finished", turnCompleted: true },
      {
        goal,
        runtime,
        currentTokenUsage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 50,
          reasoningOutputTokens: 0,
          totalTokens: 150,
        },
        outputSummary: "Read the file and edited the auth module",
        injectPrompt: async () => {},
        updateGoal: () => {},
      },
    )

    expect(result.shouldContinue).toBe(true)
    // lastObservation should be set
    expect(runtime.lastObservation).toBeDefined()
  })
})
