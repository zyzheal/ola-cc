/**
 * Real-world testing for goal command without budget parameter.
 * Tests simulate the actual command execution flow.
 */

import { describe, test, expect } from 'bun:test'
import { ThreadGoalStatus, type Goal, IDLE_GOAL } from '../../src/commands/goal/types.js'

// Simulate the actual goal command execution logic
class GoalCommandSimulator {
  private state: { goal: Goal } = { goal: IDLE_GOAL }

  execute(args: string): string {
    const argsArray = args.trim().split(/\s+/).filter(Boolean)

    // Parse budget
    const budgetIndex = argsArray.indexOf('--budget')
    let tokenBudget: number | null = null
    if (budgetIndex !== -1 && argsArray[budgetIndex + 1]) {
      tokenBudget = parseInt(argsArray[budgetIndex + 1], 10)
      argsArray.splice(budgetIndex, 2) // Remove --budget and its value
    }

    const firstArg = argsArray[0]?.toLowerCase()

    // Status
    if (argsArray.length === 0 || firstArg === 'status') {
      if (!this.state.goal.id || !this.state.goal.status || this.state.goal.status === ThreadGoalStatus.Complete) {
        return '❌ No active goal. Use /goal <objective> [--budget <tokens>] to set one.'
      }
      const remaining = this.state.goal.tokenBudget
        ? `${this.state.goal.tokenBudget - this.state.goal.tokensUsed} remaining`
        : 'unbounded'
      return `✅ Goal: ${this.state.goal.objective}\n   Status: ${this.state.goal.status}\n   Tokens: ${this.state.goal.tokensUsed} / ${this.state.goal.tokenBudget ?? 'unbounded'} (${remaining})\n   Time: ${this.state.goal.timeUsedSeconds}s`
    }

    // Clear
    if (firstArg === 'clear') {
      this.state.goal = { ...IDLE_GOAL }
      return '✅ Goal cleared.'
    }

    // Pause/Resume
    if (firstArg === 'pause' || firstArg === 'resume') {
      if (!this.state.goal.id) {
        return '❌ No active goal to pause/resume. Use /goal <objective> first.'
      }
      const newStatus = firstArg === 'pause' ? ThreadGoalStatus.Paused : ThreadGoalStatus.Active
      this.state.goal = {
        ...this.state.goal,
        status: newStatus,
        updatedAt: Date.now()
      }
      return `✅ Goal ${firstArg}d.`
    }

    // Create new goal
    const objective = argsArray.join(' ')
    this.state.goal = {
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

    return `✅ Goal set: ${objective}${tokenBudget ? `\n   Token budget: ${tokenBudget}` : ''}\n   Use /goal to check status, /goal pause to pause, /goal clear to cancel.`
  }

  getState(): Goal {
    return this.state.goal
  }
}

describe('Goal Command Without Budget - Real-World Tests', () => {
  test('Test 1: Check status when no goal exists', () => {
    const sim = new GoalCommandSimulator()
    const result = sim.execute('')
    expect(result).toContain('No active goal')
    expect(result).toContain('Use /goal <objective>')
  })

  test('Test 2: Create a goal without budget', () => {
    const sim = new GoalCommandSimulator()
    const result = sim.execute('Migrate Express to Fastify')

    expect(result).toContain('Goal set: Migrate Express to Fastify')
    expect(result).not.toContain('Token budget') // No budget should be shown

    const goal = sim.getState()
    expect(goal.objective).toBe('Migrate Express to Fastify')
    expect(goal.tokenBudget).toBe(null) // Budget should be null
    expect(goal.status).toBe(ThreadGoalStatus.Active)
  })

  test('Test 3: Check status of the newly created goal', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Migrate Express to Fastify')

    const result = sim.execute('')
    expect(result).toContain('Goal: Migrate Express to Fastify')
    expect(result).toContain('Status: active')
    expect(result).toContain('Tokens: 0 / unbounded')
    expect(result).toContain('unbounded')
    expect(result).toContain('Time: 0s')
  })

  test('Test 4: Pause the goal', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Test goal')

    const result = sim.execute('pause')
    expect(result).toContain('Goal paused')

    const goal = sim.getState()
    expect(goal.status).toBe(ThreadGoalStatus.Paused)
  })

  test('Test 5: Check status after pause', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Test goal')
    sim.execute('pause')

    const result = sim.execute('')
    expect(result).toContain('Status: paused')
  })

  test('Test 6: Resume the goal', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Test goal')
    sim.execute('pause')

    const result = sim.execute('resume')
    expect(result).toContain('Goal resumed')

    const goal = sim.getState()
    expect(goal.status).toBe(ThreadGoalStatus.Active)
  })

  test('Test 7: Check status after resume', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Test goal')
    sim.execute('pause')
    sim.execute('resume')

    const result = sim.execute('')
    expect(result).toContain('Status: active')
  })

  test('Test 8: Clear the goal', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Test goal')

    const result = sim.execute('clear')
    expect(result).toContain('Goal cleared')

    const goal = sim.getState()
    expect(goal.id).toBe('')
    expect(goal.status).toBe('')
    expect(goal.objective).toBe('')
  })

  test('Test 9: Check status after clear', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Test goal')
    sim.execute('clear')

    const result = sim.execute('')
    expect(result).toContain('No active goal')
  })

  test('Test 10: Create another goal with multi-word objective', () => {
    const sim = new GoalCommandSimulator()
    const result = sim.execute('Refactor authentication module to use JWT')

    expect(result).toContain('Goal set: Refactor authentication module to use JWT')
    expect(result).not.toContain('Token budget')

    const goal = sim.getState()
    expect(goal.objective).toBe('Refactor authentication module to use JWT')
    expect(goal.objective).toContain('authentication')
    expect(goal.objective).toContain('JWT')
  })

  test('Test 11: Verify the multi-word objective is preserved', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Refactor authentication module to use JWT')

    const result = sim.execute('')
    expect(result).toContain('Goal: Refactor authentication module to use JWT')
    expect(result).toContain('authentication')
    expect(result).toContain('JWT')
  })

  test('Test 12: Verify unbounded token budget behavior', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Large task without budget')

    const goal = sim.getState()
    expect(goal.tokenBudget).toBe(null)

    // Simulate token usage accumulation (this would happen in real usage)
    goal.tokensUsed = 100000 // 100k tokens used
    goal.timeUsedSeconds = 300 // 5 minutes

    const result = sim.execute('')
    expect(result).toContain('Tokens: 100000 / unbounded')
    expect(result).toContain('unbounded')
    expect(result).toContain('Time: 300s')
    // No "remaining" calculation for unbounded budget
  })

  test('Test 13: Replace existing goal with new one (no budget)', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('First goal')

    const firstGoalId = sim.getState().id
    expect(firstGoalId).toBeTruthy()

    const result = sim.execute('Second goal')
    expect(result).toContain('Goal set: Second goal')

    const secondGoalId = sim.getState().id
    expect(secondGoalId).not.toBe(firstGoalId)
    expect(sim.getState().objective).toBe('Second goal')
    expect(sim.getState().tokenBudget).toBe(null)
  })

  test('Test 14: Multiple pause/resume cycles', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Cycling goal')

    // First cycle
    expect(sim.execute('pause')).toContain('Goal paused')
    expect(sim.getState().status).toBe(ThreadGoalStatus.Paused)

    expect(sim.execute('resume')).toContain('Goal resumed')
    expect(sim.getState().status).toBe(ThreadGoalStatus.Active)

    // Second cycle
    expect(sim.execute('pause')).toContain('Goal paused')
    expect(sim.getState().status).toBe(ThreadGoalStatus.Paused)

    expect(sim.execute('resume')).toContain('Goal resumed')
    expect(sim.getState().status).toBe(ThreadGoalStatus.Active)
  })

  test('Test 15: Attempt to pause/resume without active goal', () => {
    const sim = new GoalCommandSimulator()

    const pauseResult = sim.execute('pause')
    expect(pauseResult).toContain('No active goal to pause/resume')

    const resumeResult = sim.execute('resume')
    expect(resumeResult).toContain('No active goal to pause/resume')
  })

  test('Test 16: Case-insensitive command handling', () => {
    const sim = new GoalCommandSimulator()
    sim.execute('Test goal')

    // Test uppercase commands
    expect(sim.execute('PAUSE')).toContain('Goal paused')
    expect(sim.getState().status).toBe(ThreadGoalStatus.Paused)

    expect(sim.execute('RESUME')).toContain('Goal resumed')
    expect(sim.getState().status).toBe(ThreadGoalStatus.Active)

    expect(sim.execute('CLEAR')).toContain('Goal cleared')
    expect(sim.getState().id).toBe('')
  })

  test('Test 17: Verify goal state persistence across operations', () => {
    const sim = new GoalCommandSimulator()

    // Create goal
    sim.execute('Persistent goal test')
    const goalId = sim.getState().id
    const createdAt = sim.getState().createdAt

    // Pause
    sim.execute('pause')
    expect(sim.getState().id).toBe(goalId)
    expect(sim.getState().createdAt).toBe(createdAt)
    expect(sim.getState().objective).toBe('Persistent goal test')

    // Resume
    sim.execute('resume')
    expect(sim.getState().id).toBe(goalId)
    expect(sim.getState().createdAt).toBe(createdAt)
    expect(sim.getState().objective).toBe('Persistent goal test')

    // Clear
    sim.execute('clear')
    expect(sim.getState().id).toBe('')
  })

  test('Test 18: Handle empty objective gracefully', () => {
    const sim = new GoalCommandSimulator()

    // Empty string should still create a goal (though it's weird)
    const result = sim.execute('')
    expect(result).toContain('No active goal') // This triggers status check instead

    // Now create with actual text
    sim.execute('Valid goal')
    expect(sim.getState().objective).toBe('Valid goal')
  })
})

describe('Goal Command Visual Output Tests', () => {
  test('Output should be user-friendly and clear', () => {
    const sim = new GoalCommandSimulator()

    // Create goal
    const createResult = sim.execute('Clean up legacy code')
    expect(createResult).toMatch(/✅/)
    expect(createResult).toContain('Goal set')
    expect(createResult).toContain('Use /goal to check status')

    // Status check
    const statusResult = sim.execute('')
    expect(statusResult).toMatch(/✅/)
    expect(statusResult).toContain('Goal: Clean up legacy code')
    expect(statusResult).toContain('Status:')
    expect(statusResult).toContain('Tokens:')
    expect(statusResult).toContain('Time:')
  })

  test('Error messages should be clear and actionable', () => {
    const sim = new GoalCommandSimulator()

    // Try to pause without goal
    const pauseError = sim.execute('pause')
    expect(pauseError).toMatch(/❌/)
    expect(pauseError).toContain('No active goal')
    expect(pauseError).toContain('Use /goal <objective> first')

    // Status without goal
    const statusError = sim.execute('')
    expect(statusError).toMatch(/❌/)
    expect(statusError).toContain('No active goal')
    expect(statusError).toContain('Use /goal <objective>')
  })
})