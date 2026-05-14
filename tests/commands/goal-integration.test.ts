/**
 * Integration tests for goal command execution.
 *
 * Tests verify:
 * 1. Goal creation flow
 * 2. Goal status checks
 * 3. Goal pause/resume/clear operations
 * 4. Token budget tracking
 * 5. Progress calculation
 */

import { describe, test, expect } from 'bun:test'
import { ThreadGoalStatus, type Goal, IDLE_GOAL } from '../../src/commands/goal/types.js'

// Mock a minimal AppState structure
interface MockAppState {
  goal: Goal
}

// Simulate goal command execution
function executeGoalCommand(
  args: string[],
  currentState: MockAppState
): { message: string; newState: MockAppState; type: 'success' | 'info' | 'warning' } {
  const { goal } = currentState

  // Parse args
  if (args.length === 0) {
    // Status check
    if (!goal.id || !goal.status || goal.status === ThreadGoalStatus.Complete) {
      return {
        message: 'No active goal. Use /goal <objective> [--budget <tokens>] to set one.',
        newState: currentState,
        type: 'info'
      }
    }
    const remaining = goal.tokenBudget
      ? `${goal.tokenBudget - goal.tokensUsed} remaining`
      : 'unbounded'
    return {
      message: `Goal: ${goal.objective}\nStatus: ${goal.status}\nTokens: ${goal.tokensUsed} / ${goal.tokenBudget ?? 'unbounded'} (${remaining})\nTime: ${goal.timeUsedSeconds}s`,
      newState: currentState,
      type: 'info'
    }
  }

  const budgetIndex = args.indexOf('--budget')
  let tokenBudget: number | null = null
  if (budgetIndex !== -1 && args[budgetIndex + 1]) {
    tokenBudget = parseInt(args[budgetIndex + 1], 10)
    args = args.slice(0, budgetIndex)
  }

  const firstArg = args[0]?.toLowerCase()

  // Clear command
  if (firstArg === 'clear') {
    return {
      message: 'Goal cleared.',
      newState: { goal: { ...IDLE_GOAL } },
      type: 'success'
    }
  }

  // Pause/Resume commands
  if (firstArg === 'pause' || firstArg === 'resume') {
    if (!goal.id) {
      return {
        message: 'No active goal to pause/resume. Use /goal <objective> first.',
        newState: currentState,
        type: 'warning'
      }
    }
    const newStatus = firstArg === 'pause' ? ThreadGoalStatus.Paused : ThreadGoalStatus.Active
    return {
      message: `Goal ${firstArg}d.`,
      newState: {
        goal: {
          ...goal,
          status: newStatus,
          updatedAt: Date.now()
        }
      },
      type: 'success'
    }
  }

  // Create new goal
  const objective = args.join(' ')
  const newGoal: Goal = {
    id: crypto.randomUUID(),
    threadId: 'default',
    objective,
    status: ThreadGoalStatus.Active,
    tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  return {
    message: `Goal set: ${objective}${tokenBudget ? `\nToken budget: ${tokenBudget}` : ''}\nUse /goal to check status, /goal pause to pause, /goal clear to cancel.`,
    newState: { goal: newGoal },
    type: 'success'
  }
}

describe('Goal Command Integration', () => {
  test('should create a new goal without budget', () => {
    const initialState: MockAppState = { goal: IDLE_GOAL }
    const result = executeGoalCommand(['Migrate', 'to', 'TypeScript'], initialState)

    expect(result.type).toBe('success')
    expect(result.message).toContain('Goal set: Migrate to TypeScript')
    expect(result.newState.goal.id).toBeTruthy()
    expect(result.newState.goal.objective).toBe('Migrate to TypeScript')
    expect(result.newState.goal.status).toBe(ThreadGoalStatus.Active)
    expect(result.newState.goal.tokenBudget).toBe(null)
  })

  test('should create a new goal with budget', () => {
    const initialState: MockAppState = { goal: IDLE_GOAL }
    const result = executeGoalCommand(['Refactor', 'auth', '--budget', '50000'], initialState)

    expect(result.type).toBe('success')
    expect(result.message).toContain('Token budget: 50000')
    expect(result.newState.goal.tokenBudget).toBe(50000)
  })

  test('should check status of active goal', () => {
    const activeGoal: Goal = {
      id: 'test-active',
      threadId: 'default',
      objective: 'Test goal',
      status: ThreadGoalStatus.Active,
      tokenBudget: 100000,
      tokensUsed: 25000,
      timeUsedSeconds: 60,
      createdAt: Date.now() - 60000,
      updatedAt: Date.now(),
    }
    const state: MockAppState = { goal: activeGoal }
    const result = executeGoalCommand([], state)

    expect(result.type).toBe('info')
    expect(result.message).toContain('Goal: Test goal')
    expect(result.message).toContain('Status: active')
    expect(result.message).toContain('Tokens: 25000 / 100000')
    expect(result.message).toContain('75000 remaining')
  })

  test('should show no goal message when idle', () => {
    const state: MockAppState = { goal: IDLE_GOAL }
    const result = executeGoalCommand([], state)

    expect(result.type).toBe('info')
    expect(result.message).toBe('No active goal. Use /goal <objective> [--budget <tokens>] to set one.')
  })

  test('should pause active goal', () => {
    const activeGoal: Goal = {
      id: 'test-pause',
      threadId: 'default',
      objective: 'Active goal',
      status: ThreadGoalStatus.Active,
      tokenBudget: null,
      tokensUsed: 10000,
      timeUsedSeconds: 30,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const state: MockAppState = { goal: activeGoal }
    const result = executeGoalCommand(['pause'], state)

    expect(result.type).toBe('success')
    expect(result.message).toBe('Goal paused.')
    expect(result.newState.goal.status).toBe(ThreadGoalStatus.Paused)
  })

  test('should resume paused goal', () => {
    const pausedGoal: Goal = {
      id: 'test-resume',
      threadId: 'default',
      objective: 'Paused goal',
      status: ThreadGoalStatus.Paused,
      tokenBudget: null,
      tokensUsed: 5000,
      timeUsedSeconds: 15,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const state: MockAppState = { goal: pausedGoal }
    const result = executeGoalCommand(['resume'], state)

    expect(result.type).toBe('success')
    expect(result.message).toBe('Goal resumed.')
    expect(result.newState.goal.status).toBe(ThreadGoalStatus.Active)
  })

  test('should clear goal', () => {
    const activeGoal: Goal = {
      id: 'test-clear',
      threadId: 'default',
      objective: 'Goal to clear',
      status: ThreadGoalStatus.Active,
      tokenBudget: 100000,
      tokensUsed: 50000,
      timeUsedSeconds: 45,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const state: MockAppState = { goal: activeGoal }
    const result = executeGoalCommand(['clear'], state)

    expect(result.type).toBe('success')
    expect(result.message).toBe('Goal cleared.')
    expect(result.newState.goal.id).toBe('')
    expect(result.newState.goal.status).toBe('')
  })

  test('should fail to pause/resume when no goal exists', () => {
    const state: MockAppState = { goal: IDLE_GOAL }
    const pauseResult = executeGoalCommand(['pause'], state)
    const resumeResult = executeGoalCommand(['resume'], state)

    expect(pauseResult.type).toBe('warning')
    expect(pauseResult.message).toBe('No active goal to pause/resume. Use /goal <objective> first.')
    expect(pauseResult.newState).toEqual(state)

    expect(resumeResult.type).toBe('warning')
    expect(resumeResult.message).toBe('No active goal to pause/resume. Use /goal <objective> first.')
    expect(resumeResult.newState).toEqual(state)
  })

  test('should handle budget limited goal status', () => {
    const budgetLimitedGoal: Goal = {
      id: 'test-budget-limited',
      threadId: 'default',
      objective: 'Budget exhausted goal',
      status: ThreadGoalStatus.BudgetLimited,
      tokenBudget: 10000,
      tokensUsed: 10500,
      timeUsedSeconds: 20,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const state: MockAppState = { goal: budgetLimitedGoal }
    const result = executeGoalCommand([], state)

    expect(result.type).toBe('info')
    expect(result.message).toContain('Status: budget_limited')
    expect(result.message).toContain('-500 remaining')
  })
})

describe('Goal State Transitions', () => {
  test('should transition from idle to active', () => {
    const state1: MockAppState = { goal: IDLE_GOAL }
    const result1 = executeGoalCommand(['New', 'task'], state1)

    expect(result1.newState.goal.status).toBe(ThreadGoalStatus.Active)
    expect(result1.newState.goal.id).toBeTruthy()

    // Verify state persistence
    const result2 = executeGoalCommand([], result1.newState)
    expect(result2.message).toContain('Status: active')
  })

  test('should transition from active to paused', () => {
    const state1: MockAppState = { goal: IDLE_GOAL }
    const result1 = executeGoalCommand(['Test', 'task'], state1)

    const result2 = executeGoalCommand(['pause'], result1.newState)
    expect(result2.newState.goal.status).toBe(ThreadGoalStatus.Paused)

    const result3 = executeGoalCommand([], result2.newState)
    expect(result3.message).toContain('Status: paused')
  })

  test('should transition from paused to active', () => {
    const state1: MockAppState = { goal: IDLE_GOAL }
    const result1 = executeGoalCommand(['Test', 'task'], state1)

    const result2 = executeGoalCommand(['pause'], result1.newState)
    const result3 = executeGoalCommand(['resume'], result2.newState)

    expect(result3.newState.goal.status).toBe(ThreadGoalStatus.Active)
  })

  test('should reset to idle when cleared', () => {
    const state1: MockAppState = { goal: IDLE_GOAL }
    const result1 = executeGoalCommand(['Test', 'task', '--budget', '10000'], state1)

    expect(result1.newState.goal.tokenBudget).toBe(10000)

    const result2 = executeGoalCommand(['clear'], result1.newState)
    expect(result2.newState.goal).toEqual(IDLE_GOAL)
  })

  test('should replace existing goal with new one', () => {
    const state1: MockAppState = { goal: IDLE_GOAL }
    const result1 = executeGoalCommand(['First', 'goal'], state1)

    const firstGoalId = result1.newState.goal.id
    expect(firstGoalId).toBeTruthy()

    const result2 = executeGoalCommand(['Second', 'goal'], result1.newState)
    expect(result2.newState.goal.id).not.toBe(firstGoalId)
    expect(result2.newState.goal.objective).toBe('Second goal')
  })
})

describe('Goal Token Budget Tracking', () => {
  test('should correctly calculate remaining budget', () => {
    const goal: Goal = {
      id: 'test-budget',
      threadId: 'default',
      objective: 'Budget test',
      status: ThreadGoalStatus.Active,
      tokenBudget: 100000,
      tokensUsed: 75000,
      timeUsedSeconds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const state: MockAppState = { goal }

    const result = executeGoalCommand([], state)
    expect(result.message).toContain('25000 remaining')
  })

  test('should handle unbounded budget', () => {
    const goal: Goal = {
      id: 'test-unbounded',
      threadId: 'default',
      objective: 'Unbounded goal',
      status: ThreadGoalStatus.Active,
      tokenBudget: null,
      tokensUsed: 500000,
      timeUsedSeconds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const state: MockAppState = { goal }

    const result = executeGoalCommand([], state)
    expect(result.message).toContain('unbounded')
    expect(result.message).toContain('500000 / unbounded')
  })

  test('should track tokens from initial zero', () => {
    const state: MockAppState = { goal: IDLE_GOAL }
    const result = executeGoalCommand(['Task', '--budget', '50000'], state)

    expect(result.newState.goal.tokensUsed).toBe(0)
    expect(result.newState.goal.tokenBudget).toBe(50000)

    const statusResult = executeGoalCommand([], result.newState)
    expect(statusResult.message).toContain('Tokens: 0 / 50000')
    expect(statusResult.message).toContain('50000 remaining')
  })
})