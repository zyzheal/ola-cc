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

export function GoalCommand(props: { args: string[] } & LocalJSXCommandOnDone) {
  const $ = _c(3)
  const goal = useAppState(s => s.goal)
  const setAppState = useSetAppState()

  let t0
  if ($[0] === Symbol.for('react.memo_cache_sentinel')) {
    t0 = () => {
      const { objective, action, tokenBudget } = parseGoalArgs(props.args)

      // status
      if (action === 'status') {
        if (!goal.id || !goal.status || goal.status === ThreadGoalStatus.Complete) {
          props.onDone(true, 'No active goal. Use /goal <objective> [--budget <tokens>] to set one.')
          return
        }
        const remaining = goal.tokenBudget
          ? `${goal.tokenBudget - goal.tokensUsed} remaining`
          : 'unbounded'
        props.onDone(true,
          `🎯 Goal: ${goal.objective}\nStatus: ${goal.status}\nTokens: ${goal.tokensUsed} / ${goal.tokenBudget ?? 'unbounded'} (${remaining})\nTime: ${goal.timeUsedSeconds}s`
        )
        return
      }

      // clear
      if (action === 'clear') {
        setAppState(s => ({ ...s, goal: { ...IDLE_GOAL } }))
        props.onDone(true, 'Goal cleared.')
        return
      }

      // pause/resume
      if (action === 'pause' || action === 'resume') {
        if (!goal.id) {
          props.onDone(true, 'No active goal to pause/resume. Use /goal <objective> first.')
          return
        }
        const newStatus = action === 'pause' ? ThreadGoalStatus.Paused : ThreadGoalStatus.Active
        setAppState(s => ({
          ...s,
          goal: { ...s.goal, status: newStatus, updatedAt: Date.now() }
        }))
        props.onDone(true, `Goal ${action}d.`)
        return
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

      setAppState(s => ({ ...s, goal: newGoal }))

      props.onDone(true,
        `🎯 Goal set: ${objective}${tokenBudget ? `\nToken budget: ${tokenBudget}` : ''}\nUse /goal to check status, /goal pause to pause, /goal clear to cancel.`
      )
    }
    $[0] = t0
  } else {
    t0 = $[0]
  }

  t0()
  return null
}