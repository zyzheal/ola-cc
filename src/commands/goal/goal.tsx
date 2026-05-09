import { c as _c } from 'react/compiler-runtime'
import * as React from 'react'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { type Goal, ThreadGoalStatus, IDLE_GOAL } from './types.js'

const randomUUID = () => crypto.randomUUID()

interface GoalCommandArgs {
  objective?: string
  action?: 'status' | 'pause' | 'resume' | 'clear'
  tokenBudget?: number
}

function parseGoalArgs(args: string[]): GoalCommandArgs {
  if (args.length === 0) {
    return { action: 'status' }
  }

  const budgetIndex = args.indexOf('--budget')
  let tokenBudget: number | undefined
  if (budgetIndex !== -1 && args[budgetIndex + 1]) {
    tokenBudget = parseInt(args[budgetIndex + 1], 10)
    args = args.slice(0, budgetIndex)
  }

  const firstArg = args[0].toLowerCase()

  if (firstArg === 'status') {
    return { action: 'status' }
  }
  if (firstArg === 'pause') {
    return { action: 'pause' }
  }
  if (firstArg === 'resume') {
    return { action: 'resume' }
  }
  if (firstArg === 'clear') {
    return { action: 'clear' }
  }

  return { objective: args.join(' '), tokenBudget }
}

export function goalCommand(args: string[]): { message: string; goal?: Goal } {
  const goal = useAppState.getState().goal

  const { objective, action, tokenBudget } = parseGoalArgs(args)

  if (action === 'status') {
    if (!goal.id || goal.status === ThreadGoalStatus.Complete) {
      return { message: 'No active goal. Use /goal <objective> [--budget <tokens>] to set one.' }
    }

    const remaining = goal.tokenBudget
      ? `${goal.tokenBudget - goal.tokensUsed} remaining`
      : 'unbounded'

    return {
      message:
        `🎯 Goal: ${goal.objective}\n` +
        `Status: ${goal.status}\n` +
        `Tokens: ${goal.tokensUsed} / ${goal.tokenBudget ?? 'unbounded'} (${remaining})\n` +
        `Time: ${goal.timeUsedSeconds}s`,
    }
  }

  if (action === 'clear') {
    useSetAppState.getState()((s) => ({ ...s, goal: { ...IDLE_GOAL } }))
    return { message: 'Goal cleared.' }
  }

  if (action === 'pause' || action === 'resume') {
    if (!goal.id) {
      return { message: 'No active goal to pause/resume. Use /goal <objective> first.' }
    }

    const newStatus = action === 'pause' ? ThreadGoalStatus.Paused : ThreadGoalStatus.Active

    useSetAppState.getState()((s) => ({
      ...s,
      goal: { ...s.goal, status: newStatus, updatedAt: Date.now() },
    }))

    return { message: `Goal ${action}d.` }
  }

  // Create new goal
  const newGoal: Goal = {
    id: randomUUID(),
    threadId: 'default',
    objective: objective || '',
    status: ThreadGoalStatus.Active,
    tokenBudget: tokenBudget ?? null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  useSetAppState.getState()((s) => ({
    ...s,
    goal: newGoal,
  }))

  return {
    message:
      `🎯 Goal set: ${objective}${tokenBudget ? `\nToken budget: ${tokenBudget}` : ''}\n` +
      `Use /goal to check status, /goal pause to pause, /goal clear to cancel.`,
    goal: newGoal,
  }
}

export function GoalCommand(props: { args: string[] } & LocalJSXCommandOnDone) {
  const $ = _c(2)

  let t0
  if ($[0] === Symbol.for('react.memo_cache_sentinel')) {
    t0 = () => {
      const result = goalCommand(props.args)
      props.onDone(true, result.message)
    }
    $[0] = t0
  } else {
    t0 = $[0]
  }

  t0()
  return null
}