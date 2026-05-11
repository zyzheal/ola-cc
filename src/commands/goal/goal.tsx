import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { type Goal, ThreadGoalStatus, IDLE_GOAL } from './types.js'
import type { TodoItem } from '../../utils/todo/types.js'
import { buildContinuationPrompt } from '../../utils/goal/goalSteering.js'
import { notifyPermissionModeChanged } from '../../utils/sessionState.js'

const randomUUID = () => crypto.randomUUID()

// 默认任务模板：创建 Goal 时自动生成初始任务列表
function createDefaultTodoItems(objective: string): TodoItem[] {
  return [
    { content: `分析目标: ${objective}`, status: 'pending', activeForm: '正在分析目标' },
    { content: '规划执行步骤', status: 'pending', activeForm: '正在规划执行步骤' },
    { content: '执行任务', status: 'pending', activeForm: '正在执行任务' },
    { content: '验证完成结果', status: 'pending', activeForm: '正在验证完成结果' },
  ]
}

interface GoalCommandArgs {
  objective?: string
  action?: 'status' | 'pause' | 'resume' | 'clear'
  tokenBudget?: number
  autoAccept?: boolean
}

function parseGoalArgs(args: string[]): GoalCommandArgs {
  if (args.length === 0) {
    return { action: 'status' }
  }

  // Check for --auto-accept flag
  const autoAcceptIndex = args.indexOf('--auto-accept')
  const autoAccept = autoAcceptIndex !== -1
  if (autoAccept) {
    args = args.filter(a => a !== '--auto-accept')
  }

  const budgetIndex = args.indexOf('--budget')
  let tokenBudget: number | undefined
  if (budgetIndex !== -1 && args[budgetIndex + 1]) {
    tokenBudget = parseInt(args[budgetIndex + 1], 10)
    args = args.slice(0, budgetIndex)
  }

  const firstArg = args[0]?.toLowerCase()

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

  return { objective: args.join(' '), tokenBudget, autoAccept }
}

function formatGoalStatus(goal: Goal | undefined, todos: TodoItem[] | undefined): string {
  if (!goal || !goal.id || !goal.status || goal.status === ThreadGoalStatus.Complete) {
    return 'No active goal. Use /goal <objective> [--budget <tokens>] to set one.'
  }
  const remaining = goal.tokenBudget
    ? `${goal.tokenBudget - goal.tokensUsed} remaining`
    : 'unbounded'

  let statusMessage = `Goal: ${goal.objective}\nStatus: ${goal.status}\nTokens: ${goal.tokensUsed} / ${goal.tokenBudget ?? 'unbounded'} (${remaining})\nTime: ${goal.timeUsedSeconds}s`

  // Add task progress if available
  if (todos && todos.length > 0) {
    const completedCount = todos.filter(t => t.status === 'completed').length
    const inProgress = todos.find(t => t.status === 'in_progress')
    statusMessage += `\nTasks: ${completedCount}/${todos.length} completed`
    if (inProgress) {
      statusMessage += `\nCurrent: ${inProgress.content}`
    }
  }

  return statusMessage
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const argsArray = args ? args.trim().split(/\s+/).filter(Boolean) : []
  const { objective, action, tokenBudget, autoAccept } = parseGoalArgs(argsArray)
  const appState = context.getAppState()
  const goal = appState.goal
  const todos = goal?.todoListId ? appState.todos[goal.todoListId] : undefined

  // status
  if (action === 'status') {
    const message = formatGoalStatus(goal, todos)
    onDone(message, { display: 'system' })
    return null
  }

  // clear
  if (action === 'clear') {
    context.setAppState(s => ({ ...s, goal: { ...IDLE_GOAL } }))
    onDone('Goal cleared.', { display: 'system' })
    return null
  }

  // pause/resume
  if (action === 'pause' || action === 'resume') {
    if (!goal || !goal.id) {
      const message = 'No active goal to pause/resume. Use /goal <objective> first.'
      onDone(message, { display: 'system' })
      return null
    }
    const newStatus = action === 'pause' ? ThreadGoalStatus.Paused : ThreadGoalStatus.Active
    context.setAppState(s => ({
      ...s,
      goal: { ...s.goal, status: newStatus, updatedAt: Date.now() }
    }))
    const message = `Goal ${action}d.`
    onDone(message, { display: 'system' })
    return null
  }

  // Create new goal
  if (!objective) {
    onDone('Error: No objective provided. Use /goal <objective>', { display: 'system' })
    return null
  }

  const sessionId = getSessionId()
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
    todoListId: sessionId,
  }

  const defaultTodos = createDefaultTodoItems(objective || '')
  // Auto-start first task as in_progress
  if (defaultTodos.length > 0) {
    defaultTodos[0] = { ...defaultTodos[0], status: 'in_progress' }
  }
  const continuationPrompt = buildContinuationPrompt(newGoal)

  // Initialize goalRuntime when creating a new goal
  context.setAppState(s => {
    const currentRuntime = s.goalRuntime || {
      accounting: {
        turn: null,
        wallClock: { lastAccountedAt: 0, activeGoalId: null },
      },
      budgetLimitReportedGoalId: null,
      continuationTurnId: null,
    }

    // If autoAccept is true, set permission mode to acceptEdits
    const newToolPermissionContext = autoAccept
      ? { ...s.toolPermissionContext, mode: 'acceptEdits' as const }
      : s.toolPermissionContext

    return {
      ...s,
      goal: newGoal,
      goalRuntime: {
        ...currentRuntime,
        accounting: {
          ...currentRuntime.accounting,
          wallClock: {
            activeGoalId: newGoal.id,
            lastAccountedAt: Date.now(),
          },
        },
        budgetLimitReportedGoalId: null,
      },
      todos: {
        ...s.todos,
        [sessionId]: defaultTodos,
      },
      toolPermissionContext: newToolPermissionContext,
    }
  })

  // Notify permission mode change if autoAccept
  if (autoAccept) {
    notifyPermissionModeChanged('acceptEdits')
  }

  const message = `Goal set: ${objective}${tokenBudget ? `\nToken budget: ${tokenBudget}` : ''}${autoAccept ? `\nAuto-accept: enabled (edits will be accepted automatically)` : ''}\nLinked to TodoWrite: /todos\nUse /goal to check status, /goal pause to pause, /goal clear to cancel.`
  // Trigger auto-execute via metaMessages and shouldQuery
  onDone(message, { display: 'system', metaMessages: [continuationPrompt], shouldQuery: true })
  return null
}