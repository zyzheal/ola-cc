import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { type Goal, ThreadGoalStatus, IDLE_GOAL, type GoalMode, type GoalTask, migrateGoal } from './types.js'
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

function createDefaultGoalTasks(objective: string): GoalTask[] {
  return [
    { id: randomUUID(), content: `分析目标: ${objective}`, status: 'pending', order: 0 },
    { id: randomUUID(), content: '规划执行步骤', status: 'pending', order: 1 },
    { id: randomUUID(), content: '执行任务', status: 'pending', order: 2 },
    { id: randomUUID(), content: '验证完成结果', status: 'pending', order: 3 },
  ]
}

interface GoalCommandArgs {
  objective?: string
  action?: 'status' | 'pause' | 'resume' | 'clear' | 'edit' | 'budget' | 'mode'
  tokenBudget?: number
  autoAccept?: boolean
  autoEdit?: boolean
  mode?: GoalMode
  editObjective?: string
  newBudget?: number
  // 新增
  retryInterval?: string  // e.g., "5m", "10m", "30s"
  maxRetryHours?: number
}

function parseGoalArgs(args: string[]): GoalCommandArgs {
  if (args.length === 0) {
    return { action: 'status' }
  }

  const autoAcceptIndex = args.indexOf('--auto-accept')
  const autoAccept = autoAcceptIndex !== -1
  if (autoAccept) {
    args = args.filter(a => a !== '--auto-accept')
  }

  const autoEdit = args.includes('--auto-edit')
  if (autoEdit) {
    args = args.filter(a => a !== '--auto-edit')
  }

  const modeMatch = args.find(a => ['simple', 'standard', 'complex'].includes(a.toLowerCase()))
  const mode = modeMatch ? modeMatch.toLowerCase() as GoalMode : undefined
  if (mode) {
    args = args.filter(a => a.toLowerCase() !== mode)
  }

  // 解析 --retry-interval / -r
  const retryIntervalIndex = args.findIndex(a => a === '--retry-interval' || a === '-r')
  let retryInterval: string | undefined
  if (retryIntervalIndex !== -1 && args[retryIntervalIndex + 1]) {
    retryInterval = args[retryIntervalIndex + 1]
    args = args.filter((_, i) => i !== retryIntervalIndex && i !== retryIntervalIndex + 1)
  }

  // 解析 --max-hours / -t
  const maxHoursIndex = args.findIndex(a => a === '--max-hours' || a === '-t')
  let maxRetryHours: number | undefined
  if (maxHoursIndex !== -1 && args[maxHoursIndex + 1]) {
    maxRetryHours = parseInt(args[maxHoursIndex + 1], 10)
    args = args.filter((_, i) => i !== maxHoursIndex && i !== maxHoursIndex + 1)
  }

  const budgetIndex = args.indexOf('--budget')
  let tokenBudget: number | undefined
  if (budgetIndex !== -1 && args[budgetIndex + 1]) {
    tokenBudget = parseInt(args[budgetIndex + 1], 10)
    args = args.filter((_, i) => i !== budgetIndex && i !== budgetIndex + 1)
  }

  const firstArg = args[0]?.toLowerCase()

  if (firstArg === 'status') return { action: 'status' }
  if (firstArg === 'pause') return { action: 'pause' }
  if (firstArg === 'resume') return { action: 'resume' }
  if (firstArg === 'clear' || firstArg === 'stop') return { action: 'clear' }
  if (firstArg === 'edit') return { action: 'edit', editObjective: args.slice(1).join(' ') }
  if (firstArg === 'budget' && args[1]) return { action: 'budget', newBudget: parseInt(args[1], 10) }
  if (firstArg === 'mode' && mode) return { action: 'mode', mode }

  return { objective: args.join(' '), tokenBudget, autoAccept, autoEdit, mode, retryInterval, maxRetryHours }
}

function formatGoalStatus(goal: Goal | undefined, todos: TodoItem[] | undefined): string {
  if (!goal || !goal.id || !goal.status || goal.status === ThreadGoalStatus.Complete) {
    return '当前未设置活跃目标。使用 /goal <目标描述> [--budget <tokens>] 创建一个。'
  }
  const remaining = goal.tokenBudget
    ? `剩余 ${goal.tokenBudget - goal.tokensUsed} tokens`
    : '无上限'

  let statusMessage = `目标：${goal.objective}\n状态：${goal.status}\nTokens：${goal.tokensUsed} / ${goal.tokenBudget ?? '无上限'} (${remaining})\n用时：${goal.timeUsedSeconds}s`

  // Add task progress if available
  if (todos && todos.length > 0) {
    const completedCount = todos.filter(t => t.status === 'completed').length
    const inProgress = todos.find(t => t.status === 'in_progress')
    statusMessage += `\n任务：${completedCount}/${todos.length} 已完成`
    if (inProgress) {
      statusMessage += `\n当前：${inProgress.content}`
    }
  }

  return statusMessage
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const argsArray = args ? args.trim().split(/\s+/).filter(Boolean) : []
  const { objective, action, tokenBudget, autoAccept, autoEdit, mode, editObjective, newBudget, retryInterval, maxRetryHours } = parseGoalArgs(argsArray)
  const appState = context.getAppState()
  let goal = appState.goal
  // Migrate existing goal if it has old schema
  if (goal && goal.id) {
    goal = migrateGoal(goal)
    context.setAppState(s => ({ ...s, goal }))
  }
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
    onDone('目标已清除。', { display: 'system' })
    return null
  }

  // pause/resume
  if (action === 'pause' || action === 'resume') {
    if (!goal || !goal.id) {
      const message = '当前未设置活跃目标，无法暂停/恢复。请先使用 /goal <目标描述>。'
      onDone(message, { display: 'system' })
      return null
    }
    const newStatus = action === 'pause' ? ThreadGoalStatus.Paused : ThreadGoalStatus.Active
    context.setAppState(s => ({
      ...s,
      goal: { ...s.goal, status: newStatus, updatedAt: Date.now() }
    }))
    const message = `目标已${action === 'pause' ? '暂停' : '恢复'}。`
    onDone(message, { display: 'system' })
    return null
  }

  // edit: modify goal objective
  if (action === 'edit') {
    if (!goal || !goal.id) {
      onDone('当前未设置活跃目标，无法编辑。', { display: 'system' })
      return null
    }
    if (!editObjective) {
      onDone('用法：/goal edit <新目标描述>', { display: 'system' })
      return null
    }
    context.setAppState(s => ({
      ...s,
      goal: { ...s.goal, objective: editObjective, updatedAt: Date.now() },
    }))
    onDone('目标描述已更新。', { display: 'system' })
    return null
  }

  // budget: dynamically adjust token budget
  if (action === 'budget') {
    if (!goal || !goal.id) {
      onDone('当前未设置活跃目标，无法调整预算。', { display: 'system' })
      return null
    }
    if (newBudget == null || isNaN(newBudget)) {
      onDone('用法：/goal budget <token数量>', { display: 'system' })
      return null
    }
    context.setAppState(s => ({
      ...s,
      goal: { ...s.goal, tokenBudget: newBudget, updatedAt: Date.now() },
    }))
    onDone(`目标预算已设为 ${newBudget} tokens。`, { display: 'system' })
    return null
  }

  // mode: change prompt tier
  if (action === 'mode') {
    if (!goal || !goal.id) {
      onDone('当前未设置活跃目标，无法切换模式。', { display: 'system' })
      return null
    }
    context.setAppState(s => ({
      ...s,
      goal: { ...s.goal, mode: mode ?? 'standard', updatedAt: Date.now() },
    }))
    onDone(`目标模式已设为 ${mode ?? 'standard'}。`, { display: 'system' })
    return null
  }

  // Create new goal
  if (!objective) {
    onDone('错误：未提供目标描述。用法：/goal <目标描述>', { display: 'system' })
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

  // Create dedicated goalTask list (decoupled from TodoWrite)
  const goalTaskListId = `goal_${newGoal.id}`
  const defaultGoalTasks: GoalTask[] = createDefaultGoalTasks(objective || '')
  // Auto-start first task as in_progress (matching defaultTodos behavior)
  if (defaultGoalTasks.length > 0) {
    defaultGoalTasks[0] = { ...defaultGoalTasks[0], status: 'in_progress' }
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
      turnBuffer: [],
      totalApiTokens: 0,
      totalApiWallMs: 0,
      consecutiveErrors: 0,
      turnsWithNoChanges: 0,
      _currentTurnWallStartMs: 0,
    }

    // If autoEdit is true, use autoEdit mode (file edits auto-approved, bash still prompts)
    // If autoAccept is true, use bypassPermissions (full bypass)
    const newMode = autoAccept
      ? 'bypassPermissions'
      : autoEdit
        ? 'autoEdit'
        : s.toolPermissionContext.mode

    const newToolPermissionContext = (autoAccept || autoEdit)
      ? {
          ...s.toolPermissionContext,
          mode: newMode as const,
          isBypassPermissionsModeAvailable: true,
        }
      : s.toolPermissionContext

    return {
      ...s,
      goal: {
        ...newGoal,
        goalTaskListId,
        mode: mode ?? 'standard',
        autoEdit: autoEdit ?? false,
      },
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
      goalTasks: {
        ...s.goalTasks,
        [goalTaskListId]: defaultGoalTasks,
      },
      toolPermissionContext: newToolPermissionContext,
    }
  })

  // Notify permission mode change if autoAccept
  if (autoAccept) {
    notifyPermissionModeChanged('bypassPermissions')
  }

  const message = `目标已创建：${objective}${tokenBudget ? `\nToken 预算：${tokenBudget}` : ''}${autoEdit ? `\n自动编辑：已启用（文件修改自动批准）` : ''}${autoAccept ? `\n自动接受：已启用（跳过所有权限提示）` : ''}\n已关联 TodoWrite：/todos\n使用 /goal 查看状态，/goal pause 暂停，/goal clear 清除。`
  // Trigger auto-execute via metaMessages and shouldQuery
  onDone(message, { display: 'system', metaMessages: [continuationPrompt], shouldQuery: true })
  return null
}