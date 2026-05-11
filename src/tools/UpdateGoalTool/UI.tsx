import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { UpdateGoalInput } from './UpdateGoalTool.js'

// Safely render tool use message with error handling
// Returns a string (will be wrapped in <Text> by caller)
export function renderToolUseMessage(
  _tool: unknown,
  input: UpdateGoalInput | null | undefined,
): React.ReactNode {
  try {
    if (!input) return null
    const status = input.status ?? 'unknown'
    const summary = input.summary ? `, summary: ${String(input.summary).slice(0, 50)}...` : ''
    return `status=${status}${summary}`
  } catch {
    return 'update_goal'
  }
}

// Safely render tool result message with error handling - Returns ReactNode (directly rendered)
export function renderToolResultMessage(
  _tool: unknown,
  result: { message: string } | null | undefined,
): React.ReactNode {
  try {
    if (!result) return null
    return (
      <Box flexDirection="column">
        <Text color="green">{String(result.message ?? 'Goal updated')}</Text>
      </Box>
    )
  } catch {
    return <Text color="green">Goal updated</Text>
  }
}

// Safely render tool use rejected message with error handling - Returns ReactNode (directly rendered)
export function renderToolUseRejectedMessage(): React.ReactNode {
  return <Text color="red">Permission denied to update goal status.</Text>
}