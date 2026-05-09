import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UpdateGoalInput, UpdateGoalTool } from './UpdateGoalTool.js'

export function renderToolUseMessage(
  tool: typeof UpdateGoalTool,
  input: UpdateGoalInput,
): ToolResultBlockParam {
  return {
    type: 'tool_use',
    id: tool.name,
    name: tool.name,
    input,
  }
}

export function renderToolResultMessage(
  tool: typeof UpdateGoalTool,
  result: { message: string },
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: tool.name,
    content: result.message,
  }
}

export function renderToolUseRejectedMessage(
  tool: typeof UpdateGoalTool,
  input: UpdateGoalInput,
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: tool.name,
    content: `Permission denied to update goal status.`,
    is_error: true,
  }
}