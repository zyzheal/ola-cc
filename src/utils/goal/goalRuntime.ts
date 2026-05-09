import type { Goal, GoalRuntimeState, TokenUsage } from '../../commands/goal/types.js'
import { ThreadGoalStatus as Status } from '../../commands/goal/types.js'
import { tokenDeltaSinceLastAccounting, timeDeltaSinceLastAccounted, isBudgetExhausted } from './goalAccounting.js'
import { buildContinuationPrompt, buildBudgetLimitPrompt } from './goalSteering.js'

// Goal runtime events (matching Codex pattern)
export type GoalRuntimeEvent = 
  | { type: 'turn_started'; turnId: string; tokenUsage: TokenUsage }
  | { type: 'tool_completed'; toolName: string }
  | { type: 'turn_finished'; turnCompleted: boolean }
  | { type: 'maybe_continue_if_idle' }
  | { type: 'external_set'; goal: Goal }
  | { type: 'thread_resumed' }

// Context passed to runtime event processor
export interface GoalRuntimeContext {
  goal: Goal
  runtime: GoalRuntimeState
  currentTokenUsage: TokenUsage  // Pass current token usage from caller
  injectPrompt: (prompt: string) => Promise<void>
  updateGoal: (goal: Goal) => void
}

// Result of processing a runtime event
export interface GoalRuntimeResult {
  shouldContinue: boolean
  injectedPrompt?: string
}

// Process goal runtime events
export function processGoalRuntimeEvent(
  event: GoalRuntimeEvent,
  context: GoalRuntimeContext
): GoalRuntimeResult {
  const { goal, runtime } = context
  
  switch (event.type) {
    case 'turn_started': {
      // Initialize turn accounting
      runtime.accounting.turn = {
        turnId: event.turnId,
        lastTokenUsage: event.tokenUsage,
        activeGoalId: goal.id,
      }
      return { shouldContinue: true }
    }
    
    case 'tool_completed': {
      // Don't account for update_goal tool calls
      if (event.toolName === 'update_goal') {
        return { shouldContinue: true }
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
      runtime.accounting.turn.lastTokenUsage = usage
      runtime.accounting.wallClock.lastAccountedAt = Date.now()
      
      return { shouldContinue: true }
    }
    
    case 'turn_finished': {
      if (!event.turnCompleted) {
        return { shouldContinue: true }
      }

      // Clear turn accounting
      const lastTurn = runtime.accounting.turn
      runtime.accounting.turn = null

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

        // Check budget exhaustion
        if (isBudgetExhausted(updatedGoal) && runtime.budgetLimitReportedGoalId !== goal.id) {
          updatedGoal = {
            ...updatedGoal,
            status: Status.BudgetLimited,
          }
          runtime.budgetLimitReportedGoalId = goal.id
          context.updateGoal(updatedGoal)
          const budgetPrompt = buildBudgetLimitPrompt(updatedGoal)
          return { shouldContinue: true, injectedPrompt: budgetPrompt }
        }

        context.updateGoal(updatedGoal)
      }

      // If goal is still active, inject continuation prompt
      if (goal.status === Status.Active) {
        const continuationPrompt = buildContinuationPrompt(goal)
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
  }
}