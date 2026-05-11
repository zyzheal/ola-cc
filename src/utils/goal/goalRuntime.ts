import type { Goal, GoalRuntimeState, TokenUsage } from '../../commands/goal/types.js'
import { ThreadGoalStatus as Status } from '../../commands/goal/types.js'
import { tokenDeltaSinceLastAccounting, timeDeltaSinceLastAccounted, isBudgetExhausted } from './goalAccounting.js'
import { buildContinuationPrompt, buildBudgetLimitPrompt } from './goalSteering.js'
import type { TodoItem } from '../todo/types.js'

// Goal runtime events (matching Codex pattern)
export type GoalRuntimeEvent =
  | { type: 'turn_started'; turnId: string; tokenUsage: TokenUsage }
  | { type: 'tool_completed'; toolName: string }
  | { type: 'tool_completed_goal' }  // Codex-style: goal completion event
  | { type: 'turn_finished'; turnCompleted: boolean }
  | { type: 'maybe_continue_if_idle' }
  | { type: 'external_set'; goal: Goal }
  | { type: 'thread_resumed' }
  | { type: 'goal_created'; goal: Goal }

// Context passed to runtime event processor
export interface GoalRuntimeContext {
  goal: Goal
  runtime: GoalRuntimeState
  currentTokenUsage: TokenUsage  // Pass current token usage from caller
  injectPrompt: (prompt: string) => Promise<void>
  updateGoal: (goal: Goal) => void
  updateTodos?: (todos: TodoItem[]) => void  // Optional: update task list
  getTodos?: () => TodoItem[] | undefined    // Optional: get current task list
}

// Result of processing a runtime event
export interface GoalRuntimeResult {
  shouldContinue: boolean
  injectedPrompt?: string
}

// Helper: Auto-progress task status
function autoProgressTasks(todos: TodoItem[] | undefined, updateTodos: ((todos: TodoItem[]) => void) | undefined): void {
  if (!todos || !updateTodos || todos.length === 0) return

  // Find current in_progress task
  const inProgressIndex = todos.findIndex(t => t.status === 'in_progress')

  // If no task in progress, start the first pending task
  if (inProgressIndex === -1) {
    const firstPendingIndex = todos.findIndex(t => t.status === 'pending')
    if (firstPendingIndex !== -1) {
      const updatedTodos = [...todos]
      updatedTodos[firstPendingIndex] = { ...updatedTodos[firstPendingIndex], status: 'in_progress' }
      updateTodos(updatedTodos)
    }
    return
  }

  // Mark current task as completed and start next
  const updatedTodos = [...todos]
  updatedTodos[inProgressIndex] = { ...updatedTodos[inProgressIndex], status: 'completed' }

  const nextPendingIndex = todos.findIndex((t, i) => i > inProgressIndex && t.status === 'pending')
  if (nextPendingIndex !== -1) {
    updatedTodos[nextPendingIndex] = { ...updatedTodos[nextPendingIndex], status: 'in_progress' }
  }

  updateTodos(updatedTodos)
}

// Helper: Mark all tasks as completed
function markAllTasksCompleted(todos: TodoItem[] | undefined, updateTodos: ((todos: TodoItem[]) => void) | undefined): void {
  if (!todos || !updateTodos || todos.length === 0) return
  const updatedTodos = todos.map(t => ({ ...t, status: 'completed' }))
  updateTodos(updatedTodos)
}

// Process goal runtime events with error handling
export function processGoalRuntimeEvent(
  event: GoalRuntimeEvent,
  context: GoalRuntimeContext
): GoalRuntimeResult {
  try {
    const { goal, runtime } = context

    // Safety checks
    if (!goal || !goal.id) {
      return { shouldContinue: false }
    }
    if (!runtime) {
      return { shouldContinue: true }
    }

    switch (event.type) {
      case 'turn_started': {
        // Initialize turn accounting
        runtime.accounting.turn = {
          turnId: event.turnId,
          lastTokenUsage: event.tokenUsage,
          activeGoalId: goal.id,
        }
        // Auto-start first task if none is in progress
        const todos = context.getTodos?.()
        if (todos && todos.length > 0 && !todos.some(t => t.status === 'in_progress')) {
          const firstPendingIndex = todos.findIndex(t => t.status === 'pending')
          if (firstPendingIndex !== -1) {
            const updatedTodos = [...todos]
            updatedTodos[firstPendingIndex] = { ...updatedTodos[firstPendingIndex], status: 'in_progress' }
            context.updateTodos?.(updatedTodos)
          }
        }
        return { shouldContinue: true }
      }
    
    case 'tool_completed': {
      // Don't account for update_goal tool calls
      if (event.toolName === 'update_goal') {
        return { shouldContinue: true }
      }

      // Auto-progress task after significant tool completion
      const todos = context.getTodos?.()
      const inProgressTask = todos?.find(t => t.status === 'in_progress')
      // Only progress if there's an in-progress task and this is a work-related tool
      if (inProgressTask && !['TodoWrite', 'Sleep', 'AskUserQuestion'].includes(event.toolName)) {
        autoProgressTasks(todos, context.updateTodos)
      }

      // Account token usage - get from context
      const usage = context.currentTokenUsage
      const lastUsage = runtime.accounting.turn?.lastTokenUsage || usage
      const tokenDelta = tokenDeltaSinceLastAccounting(lastUsage, usage)
      const timeDelta = timeDeltaSinceLastAccounted(
        runtime.accounting.wallClock.lastAccountedAt
      )

      // Update goal with usage
      let updatedGoal: Goal = {
        ...goal,
        tokensUsed: goal.tokensUsed + tokenDelta,
        timeUsedSeconds: goal.timeUsedSeconds + timeDelta,
        updatedAt: Date.now(),
      }

      // Check budget
      if (isBudgetExhausted(updatedGoal)) {
        updatedGoal = {
          ...updatedGoal,
          status: Status.BudgetLimited,
        }
        const budgetPrompt = buildBudgetLimitPrompt(updatedGoal)
        context.updateGoal(updatedGoal)
        return { shouldContinue: true, injectedPrompt: budgetPrompt }
      }

      context.updateGoal(updatedGoal)
      // Only update turn accounting if turn exists
      if (runtime.accounting.turn) {
        runtime.accounting.turn.lastTokenUsage = usage
      }
      runtime.accounting.wallClock.lastAccountedAt = Date.now()

      return { shouldContinue: true }
    }

    case 'tool_completed_goal': {
      // Codex-style: Goal completion via update_goal tool
      // Finalize accounting and mark goal complete
      const lastTurn = runtime.accounting.turn
      if (lastTurn && lastTurn.lastTokenUsage) {
        const usage = context.currentTokenUsage
        const tokenDelta = tokenDeltaSinceLastAccounting(lastTurn.lastTokenUsage, usage)
        const timeDelta = timeDeltaSinceLastAccounted(
          runtime.accounting.wallClock.lastAccountedAt
        )

        const completedGoal: Goal = {
          ...goal,
          status: Status.Complete,
          tokensUsed: goal.tokensUsed + tokenDelta,
          timeUsedSeconds: goal.timeUsedSeconds + timeDelta,
          updatedAt: Date.now(),
        }

        context.updateGoal(completedGoal)
        runtime.accounting.turn = null
      } else {
        // No turn accounting, just mark complete
        const completedGoal: Goal = {
          ...goal,
          status: Status.Complete,
          updatedAt: Date.now(),
        }
        context.updateGoal(completedGoal)
      }

      // Mark all tasks as completed
      const todos = context.getTodos?.()
      markAllTasksCompleted(todos, context.updateTodos)

      // Goal complete - no continuation needed
      return { shouldContinue: false }
    }
    
    case 'turn_finished': {
      if (!event.turnCompleted) {
        return { shouldContinue: true }
      }

      // Clear turn accounting
      const lastTurn = runtime.accounting.turn
      runtime.accounting.turn = null

      // Track if goal was updated this turn
      let goalWasUpdated = false
      let updatedGoalRef: Goal = goal

      // Accumulate token usage for this turn
      if (lastTurn && goal.status === Status.Active) {
        const usage = context.currentTokenUsage
        const tokenDelta = tokenDeltaSinceLastAccounting(lastTurn.lastTokenUsage, usage)
        const timeDelta = timeDeltaSinceLastAccounted(
          runtime.accounting.wallClock.lastAccountedAt
        )

        let updatedGoal: Goal = {
          ...goal,
          tokensUsed: goal.tokensUsed + tokenDelta,
          timeUsedSeconds: goal.timeUsedSeconds + timeDelta,
          updatedAt: Date.now(),
        }
        updatedGoalRef = updatedGoal

        // Auto-progress tasks after each turn
        const todos = context.getTodos?.()
        autoProgressTasks(todos, context.updateTodos)

        // Check budget exhaustion
        if (isBudgetExhausted(updatedGoal) && runtime.budgetLimitReportedGoalId !== goal.id) {
          updatedGoal = {
            ...updatedGoal,
            status: Status.BudgetLimited,
          }
          updatedGoalRef = updatedGoal
          runtime.budgetLimitReportedGoalId = goal.id
          context.updateGoal(updatedGoal)
          const budgetPrompt = buildBudgetLimitPrompt(updatedGoal)
          return { shouldContinue: true, injectedPrompt: budgetPrompt }
        }

        context.updateGoal(updatedGoal)
        goalWasUpdated = true
      }

      // Use updated goal status for continuation check
      const effectiveGoal = goalWasUpdated ? updatedGoalRef : goal
      if (effectiveGoal.status === Status.Active) {
        const continuationPrompt = buildContinuationPrompt(effectiveGoal)
        return { shouldContinue: true, injectedPrompt: continuationPrompt }
      }

      return { shouldContinue: false }
    }
    
    case 'maybe_continue_if_idle': {
      // This is triggered when there's no user input pending
      // If goal is active, automatically continue
      if (goal.status === Status.Active) {
        const continuationPrompt = buildContinuationPrompt(goal)
        return { shouldContinue: true, injectedPrompt: continuationPrompt }
      }
      return { shouldContinue: false }
    }
    
    case 'external_set': {
      context.updateGoal(event.goal)
      return { shouldContinue: event.goal.status === Status.Active }
    }
    
    case 'thread_resumed': {
      // Restore runtime state for resumed thread
      if (goal.status === Status.Active) {
        runtime.accounting.wallClock.activeGoalId = goal.id
        runtime.accounting.wallClock.lastAccountedAt = Date.now()
      }
      return { shouldContinue: goal.status === Status.Active }
    }

    case 'goal_created': {
      // 新 Goal 创建时，初始化 runtime 并注入启动 prompt
      context.updateGoal(event.goal)
      runtime.accounting.wallClock.activeGoalId = event.goal.id
      runtime.accounting.wallClock.lastAccountedAt = Date.now()

      // Start first task as in_progress
      const todos = context.getTodos?.()
      if (todos && todos.length > 0) {
        const firstPendingIndex = todos.findIndex(t => t.status === 'pending')
        if (firstPendingIndex !== -1) {
          const updatedTodos = [...todos]
          updatedTodos[firstPendingIndex] = { ...updatedTodos[firstPendingIndex], status: 'in_progress' }
          context.updateTodos?.(updatedTodos)
        }
      }

      // 注入启动 prompt，让模型开始执行目标
      const continuationPrompt = buildContinuationPrompt(event.goal)
      return { shouldContinue: true, injectedPrompt: continuationPrompt }
    }

    default: {
      // Unknown event type - should not happen
      return { shouldContinue: true }
    }
  }
  } catch (error) {
    // Graceful error handling - don't crash the REPL
    console.error('[goalRuntime] Error processing event:', error)
    return { shouldContinue: true }
  }
}