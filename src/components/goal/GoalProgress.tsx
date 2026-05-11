import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { ThreadGoalStatus } from '../../commands/goal/types.js'
import type { TodoItem } from '../../utils/todo/types.js'

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
  // 使用安全的 selector，确保返回的对象结构正确
  const goalId = useAppState(s => s.goal?.id ?? '')
  const goalStatus = useAppState(s => s.goal?.status ?? '')
  const goalObjective = useAppState(s => s.goal?.objective ?? '')
  const goalTokenBudget = useAppState(s => s.goal?.tokenBudget ?? null)
  const goalTokensUsed = useAppState(s => s.goal?.tokensUsed ?? 0)
  const goalTimeUsedSeconds = useAppState(s => s.goal?.timeUsedSeconds ?? 0)
  const goalTodoListId = useAppState(s => s.goal?.todoListId ?? undefined)

  const todos = useAppState(s => {
    // 使用可选链安全访问 todos
    const todoListId = s.goal?.todoListId
    if (!todoListId) return null
    return s.todos?.[todoListId] ?? null
  })

  // 防御性检查：如果 goal 未定义或无 id/status，返回 null
  // 检查在 hooks 调用之后，符合 React 规则
  if (!goalId || !goalStatus || goalStatus === '') {
    return null
  }

  // 安全访问 STATUS_EMOJI 和 STATUS_COLORS，使用 hasOwnProperty 检查
  const statusKey = goalStatus as ThreadGoalStatus
  const emoji = Object.prototype.hasOwnProperty.call(STATUS_EMOJI, statusKey)
    ? STATUS_EMOJI[statusKey]
    : '📌'
  const color = Object.prototype.hasOwnProperty.call(STATUS_COLORS, statusKey)
    ? STATUS_COLORS[statusKey]
    : 'gray'

  // 方案 C: 从关联的 TodoWrite 列表计算任务进度
  const todoItems = todos ?? []
  const completedTasks = todoItems.filter((t: TodoItem) => t.status === 'completed').length
  const totalTasks = todoItems.length
  const taskProgress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  // 预算进度（仅在有预算时显示）
  const budgetProgress = goalTokenBudget != null
    ? Math.min(100, (goalTokensUsed / goalTokenBudget) * 100)
    : 0

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Box>
        <Text color={color}>{emoji} </Text>
        <Text bold color={color}>{goalObjective}</Text>
        <Text dimColor> ({goalStatus})</Text>
      </Box>

      {/* 方案 C: 显示关联的 TodoWrite 列表 */}
      {todoItems.length > 0 && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>📋 Linked Todo List:</Text>
          </Box>
          <Box flexDirection="column" marginLeft={2}>
            {todoItems.slice(0, 5).map((todo: TodoItem, index: number) => (
              <Box key={index}>
                <Text dimColor>
                  {todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '🔄' : '⏳'} {todo.content}
                </Text>
              </Box>
            ))}
            {todoItems.length > 5 && (
              <Box>
                <Text dimColor>   ... and {todoItems.length - 5} more</Text>
              </Box>
            )}
          </Box>
          <Box>
            <Text dimColor>Progress: {completedTasks}/{totalTasks} completed ({taskProgress}%)</Text>
          </Box>
          <Box>
            <Text dimColor>[{renderProgressBar(taskProgress)}]</Text>
          </Box>
          <Box>
            <Text dimColor>ℹ️  View full list: /todos</Text>
          </Box>
        </Box>
      )}

      {/* 预算信息 */}
      {goalTokenBudget != null ? (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>💾 Budget: </Text>
            <Text>{goalTokensUsed.toLocaleString()}</Text>
            <Text dimColor> / </Text>
            <Text>{goalTokenBudget.toLocaleString()}</Text>
            <Text dimColor> ({Math.round(budgetProgress)}% used)</Text>
          </Box>
          <Box>
            <Text dimColor>Remaining: {(goalTokenBudget - goalTokensUsed).toLocaleString()} tokens</Text>
          </Box>
        </Box>
      ) : (
        <Box>
          <Text dimColor>📊 Tokens Consumed: </Text>
          <Text>{goalTokensUsed.toLocaleString()}</Text>
          <Text dimColor> (unbounded budget)</Text>
        </Box>
      )}

      <Box>
        <Text dimColor>⏱️ Time: </Text>
        <Text>{formatDuration(goalTimeUsedSeconds)}</Text>
      </Box>
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