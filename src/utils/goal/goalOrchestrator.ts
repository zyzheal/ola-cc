/**
 * Goal Orchestrator — pure-function decision matrix.
 * Integrates scenario, convergence, error tracking into OrchestratorDecision.
 * Does NOT modify GoalRuntimeState directly (single writer principle).
 */

import type { Goal, GoalRuntimeState, TurnRecord } from "../../commands/goal/types.js"
import type { ScenarioConfig, ScenarioType } from "./goalScenario.js"
import { resolveScenario, getScenarioConfig } from "./goalScenario.js"
import { observeTurn } from "./goalReActObserver.js"
import { checkConvergence, updateConvergenceState } from "./goalConvergence.js"
import {
  createTracker,
  recordError,
  resetOnProgress,
  shouldPause as trackerShouldPause,
} from "./goalErrorTracker.js"
import { handleVerifyFailure, resetRecovery } from "./goalErrorRecovery.js"
import type { TodoItem } from "../todo/types.js"

export interface OrchestratorDecision {
  action: "continue" | "pause" | "skip_task" | "retry"
  prompt?: string
  reason: string
  pauseReason?: string
}

export interface TurnAnalysisContext {
  goal: Goal
  runtime: Readonly<GoalRuntimeState>
  currentTurn: TurnRecord | undefined
  previousTurn: TurnRecord | undefined
  todos: TodoItem[]
  currentTask: string | undefined
  observation: ReturnType<typeof observeTurn>
  scenarioConfig: ScenarioConfig
}

/** Scenario-specific circuit breaker thresholds */
export const SCENARIO_CIRCUIT_BREAKER: Record<
  string,
  { maxPerTask: number; timeoutMs: number }
> = {
  code_change: { maxPerTask: 5, timeoutMs: 20 * 60 * 1000 },
  doc_writing: { maxPerTask: 3, timeoutMs: 15 * 60 * 1000 },
  troubleshooting: { maxPerTask: 8, timeoutMs: 45 * 60 * 1000 },
  design_improve: { maxPerTask: 5, timeoutMs: 25 * 60 * 1000 },
  refactoring: { maxPerTask: 6, timeoutMs: 30 * 60 * 1000 },
}

/**
 * Initialize orchestrator state on goal_created.
 * Called from goalRuntime.ts when a new goal is created.
 */
export function initOrchestratorState(
  runtime: GoalRuntimeState,
  objective: string,
): void {
  const config = resolveScenario(objective)
  runtime.currentScenario = config.type
  runtime.convergenceState = {
    informationGains: [],
    qualityScores: [],
    changeMagnitudes: [],
    round: 0,
  }
  runtime.errorTracker = createTracker()
}

/**
 * Process a turn through the orchestrator.
 * Returns an OrchestratorDecision that goalRuntime uses to update state.
 *
 * Pure function contract: does NOT modify GoalRuntimeState directly.
 * goalRuntime is responsible for applying the decision.
 */
export function processTurn(ctx: TurnAnalysisContext): OrchestratorDecision {
  const {
    goal,
    runtime,
    currentTurn,
    previousTurn,
    todos,
    observation,
    scenarioConfig,
  } = ctx

  // Guard: goal not active
  if (goal.status !== "active") {
    return { action: "pause", reason: `Goal status is ${goal.status}` }
  }

  // Update convergence state
  if (runtime.convergenceState && currentTurn) {
    updateConvergenceState(
      runtime.convergenceState,
      currentTurn,
      previousTurn,
      scenarioConfig.type as ScenarioType,
      scenarioConfig.maxRoundsPerTask,
    )
  }

  // Check convergence
  const convergenceResult = runtime.convergenceState
    ? checkConvergence(runtime.convergenceState, scenarioConfig.maxRoundsPerTask)
    : { converged: false }

  // Check error tracker
  const tracker = runtime.errorTracker
  const errorPause = tracker ? trackerShouldPause(tracker) : false

  // Check task completion
  const allTasksDone =
    todos.length > 0 && todos.every((t) => t.status === "completed")

  // Check circuit breaker
  const breaker = SCENARIO_CIRCUIT_BREAKER[scenarioConfig.type]
  const roundExceeded =
    runtime.convergenceState &&
    breaker &&
    runtime.convergenceState.round >= breaker.maxPerTask

  return createOrchestratorDecision({
    goal: { status: goal.status },
    convergence: convergenceResult,
    errorTracker: errorPause
      ? { shouldPause: true, reason: "Error threshold exceeded" }
      : { shouldPause: false },
    allTasksDone,
    recoveryLayer: tracker?.recoveryLayer,
    roundExceeded: !!roundExceeded,
  })
}

/**
 * Decision matrix — pure function, easy to test.
 */
export function createOrchestratorDecision(input: {
  goal: { status: string }
  convergence: { converged: boolean; reason?: string }
  errorTracker: { shouldPause: boolean; reason?: string }
  allTasksDone: boolean
  recoveryLayer?: string
  roundExceeded?: boolean
}): OrchestratorDecision {
  // Priority 1: Goal not active
  if (input.goal.status !== "active") {
    return { action: "pause", reason: `Goal status is ${input.goal.status}` }
  }

  // Priority 2: Error tracker says pause
  if (input.errorTracker.shouldPause) {
    return {
      action: "pause",
      reason: input.errorTracker.reason ?? "Error threshold exceeded",
      pauseReason: `[Goal auto-paused] ${input.errorTracker.reason ?? "Consecutive errors"}. Use /goal resume to continue.`,
    }
  }

  // Priority 3: All tasks done
  if (input.allTasksDone) {
    return {
      action: "continue",
      prompt:
        'All tasks are completed. Call update_goal(status: "complete", summary: "...") to finish the goal.',
      reason: "all_tasks_completed",
    }
  }

  // Priority 4: Circuit breaker — round limit exceeded
  if (input.roundExceeded) {
    return {
      action: "skip_task",
      reason: "Circuit breaker: max rounds exceeded for this scenario",
    }
  }

  // Priority 5: Convergence reached
  if (input.convergence.converged) {
    if (input.convergence.reason === "max_rounds_low_quality") {
      return {
        action: "pause",
        reason:
          "Reached max rounds with low quality — pausing for reassessment",
        pauseReason:
          "[Goal auto-paused] Max rounds reached but quality is below threshold. Consider simplifying the task or breaking it into smaller sub-tasks.",
      }
    }
    // High quality convergence → advance to next task
    return {
      action: "continue",
      prompt:
        "Current task converged successfully. Mark it completed via TodoWrite and start the next pending task.",
      reason: `converged: ${input.convergence.reason}`,
    }
  }

  // Priority 6: Recovery escalation
  if (input.recoveryLayer && input.recoveryLayer !== "FIX_RETRY") {
    return {
      action: "retry",
      reason: `Recovery layer: ${input.recoveryLayer}`,
      prompt: `[${input.recoveryLayer}] Try a different approach for the current task.`,
    }
  }

  // Default: continue with standard prompt
  return {
    action: "continue",
    prompt: undefined, // goalRuntime will use buildContinuationPrompt
    reason: "continuing",
  }
}
