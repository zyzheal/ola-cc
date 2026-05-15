import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { ThreadGoalStatus } from '../../commands/goal/types.js'
import type { GoalTask } from '../../commands/goal/types.js'

// 错误边界组件 - 更全面的错误处理
class GoalProgressErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: string }
> {
  state = { hasError: false, error: undefined }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // 只记录错误，不崩溃 REPL
    console.error('[GoalProgress Error]', error.message)
    this.setState({ hasError: true, error: error.message.slice(0, 100) })
  }

  render() {
    if (this.state.hasError) {
      // 返回空而不是显示错误，避免干扰用户
      return null
    }
    return this.props.children
  }
}

const STATUS_EMOJI: Record<ThreadGoalStatus, string> = {
  [ThreadGoalStatus.Active]: '🎯',
  [ThreadGoalStatus.Paused]: '⏸️',
  [ThreadGoalStatus.BudgetLimited]: '⚠️',
  [ThreadGoalStatus.Complete]: '✅',
}

const STATUS_COLORS: Record<ThreadGoalStatus, string> = {
  [ThreadGoalStatus.Active]: 'cyan',
  [ThreadGoalStatus.Paused]: 'yellow',
  [ThreadGoalStatus.BudgetLimited]: 'red',
  [ThreadGoalStatus.Complete]: 'green',
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs}s`
}

function renderProgressBar(progress: number, width: number = 20): string {
  const clampedProgress = Math.max(0, Math.min(100, progress))
  const filled = Math.round((clampedProgress / 100) * width)
  const empty = width - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}

export function GoalProgress() {
  const goalId = useAppState(s => s.goal?.id ?? '')
  const goalStatus = useAppState(s => s.goal?.status ?? '')
  const goalObjective = useAppState(s => s.goal?.objective ?? '')
  const goalTokenBudget = useAppState(s => s.goal?.tokenBudget ?? null)
  const goalTokensUsed = useAppState(s => s.goal?.tokensUsed ?? 0)
  const goalTimeUsedSeconds = useAppState(s => s.goal?.timeUsedSeconds ?? 0)
  const goalTotalApiTokens = useAppState(s => s.goal?.totalApiTokens ?? 0)
  const goalMode = useAppState(s => s.goal?.mode ?? 'standard')
  const goalAutoEdit = useAppState(s => s.goal?.autoEdit ?? false)
  const goalTaskListId = useAppState(s => s.goal?.goalTaskListId ?? undefined)
  const goalConsecutiveErrors = useAppState(s => s.goalRuntime?.consecutiveErrors ?? 0)

  const goalTasks = useAppState(s => {
    const taskListId = s.goal?.goalTaskListId
    if (!taskListId) return null
    return s.goalTasks?.[taskListId] ?? null
  })

  // Fallback to todoListId for backward compatibility
  const todoListId = useAppState(s => s.goal?.todoListId ?? undefined)
  const todos = useAppState(s => {
    if (!todoListId) return null
    return s.todos?.[todoListId] ?? null
  })

  if (!goalId || !goalStatus || goalStatus === '') {
    return null
  }

  const statusKey = goalStatus as ThreadGoalStatus
  const emoji = Object.prototype.hasOwnProperty.call(STATUS_EMOJI, statusKey)
    ? STATUS_EMOJI[statusKey]
    : '📌'
  const color = Object.prototype.hasOwnProperty.call(STATUS_COLORS, statusKey)
    ? STATUS_COLORS[statusKey]
    : 'gray'

  // Use goalTasks if available, fall back to todos
  type TaskItem = { status?: string; content?: string }
  const taskItems: TaskItem[] = (goalTasks ?? (todos ?? [])) as TaskItem[]
  const currentTask = taskItems.find(t => t.status === 'in_progress')
  const nextTask = taskItems.find(t => t.status === 'pending')
  const completedTasks = taskItems.filter(t => t.status === 'completed').length
  const totalTasks = taskItems.length
  const taskProgress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  const budgetProgress = goalTokenBudget != null
    ? Math.min(100, (goalTokensUsed / goalTokenBudget) * 100)
    : 0

  const displayTokens = goalTotalApiTokens > 0 ? goalTotalApiTokens : goalTokensUsed

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Box>
        <Text color={color}>{emoji} </Text>
        <Text bold color={color}>{goalObjective}</Text>
        <Text dimColor> ({goalStatus})</Text>
      </Box>

      {/* Mode indicator */}
      <Box>
        <Text dimColor>Mode: {goalMode}{goalAutoEdit ? ' (auto-edit)' : ''}</Text>
      </Box>

      {/* Current action */}
      {currentTask && (
        <Box>
          <Text color="cyan">Current: </Text>
          <Text>{typeof currentTask === 'object' && 'content' in currentTask ? currentTask.content : String(currentTask)}</Text>
        </Box>
      )}

      {/* Next step */}
      {nextTask && (
        <Box>
          <Text dimColor>Next: </Text>
          <Text dimColor>{typeof nextTask === 'object' && 'content' in nextTask ? nextTask.content : String(nextTask)}</Text>
        </Box>
      )}

      {/* Task progress */}
      {totalTasks > 0 && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Progress: {completedTasks}/{totalTasks} completed ({taskProgress}%)</Text>
          </Box>
          <Box>
            <Text dimColor>[{renderProgressBar(taskProgress)}]</Text>
          </Box>
        </Box>
      )}

      {/* Budget info */}
      {goalTokenBudget != null ? (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Budget: </Text>
            <Text>{displayTokens.toLocaleString()} / {goalTokenBudget.toLocaleString()}</Text>
            <Text dimColor> ({Math.round(budgetProgress)}% used)</Text>
          </Box>
          <Box>
            <Text dimColor>Remaining: {(goalTokenBudget - displayTokens).toLocaleString()} tokens</Text>
          </Box>
        </Box>
      ) : (
        <Box>
          <Text dimColor>Tokens: </Text>
          <Text>{displayTokens.toLocaleString()} (unbounded)</Text>
        </Box>
      )}

      <Box>
        <Text dimColor>Time: </Text>
        <Text>{formatDuration(goalTimeUsedSeconds)}</Text>
      </Box>

      {/* Error indicator */}
      {goalConsecutiveErrors > 0 && (
        <Box>
          <Text color="red">Errors: {goalConsecutiveErrors}/3 before auto-pause</Text>
        </Box>
      )}
    </Box>
  )
}

// 包装导出，带错误边界
export function GoalProgressWithBoundary() {
  return (
    <GoalProgressErrorBoundary>
      <GoalProgress />
    </GoalProgressErrorBoundary>
  )
}