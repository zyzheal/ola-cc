import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { ThreadGoalStatus, Goal, TokenUsage } from '../../commands/goal/types.js'
import { processGoalRuntimeEvent } from '../../utils/goal/goalRuntime.js'
import {
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

const UPDATE_GOAL_TOOL_NAME = 'update_goal'

const inputSchema = lazySchema(() =>
  z.strictObject({
    status: z
      .enum(['active', 'paused', 'complete'])
      .describe('The new status for the goal'),
    summary: z.string().optional().describe('Optional summary of progress made'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Confirmation message'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type SetAppState = (updater: (prev: AppState) => AppState) => void

export const UpdateGoalTool: ToolDef<InputSchema, Output> = buildTool({
  name: UPDATE_GOAL_TOOL_NAME,
  searchHint: 'update goal status',
  maxResultSizeChars: 1000,
  async description() {
    return 'Update the current goal status. Call this when you complete a goal or need to pause.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Update Goal'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  async checkPermissions(input: InputSchema) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async prompt() {
    return 'Update the current goal status. Call this when you complete a goal or need to pause. Use status="complete" to mark the goal as achieved.'
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call(input: InputSchema, context): Promise<{ data: Output }> {
    // Safely access context functions
    const getAppState = context?.getAppState
    const setAppState = context?.setAppState

    if (!getAppState || !setAppState) {
      return {
        data: { message: 'Error: Context functions not available.' },
      }
    }

    const appState = getAppState()
    const currentGoal = appState?.goal

    if (!currentGoal?.id) {
      return {
        data: { message: 'No active goal to update.' },
      }
    }

    // Codex-style restriction: update_goal can only mark complete
    // pause/resume are controlled by user via /goal pause|resume commands
    if (input.status !== 'complete') {
      return {
        data: {
          message: 'update_goal can only mark goals complete. Use /goal pause or /goal resume commands for status changes.',
        },
      }
    }

    // Trigger goal runtime event for completion (Codex-style)
    const currentTokenUsage: TokenUsage = {
      inputTokens: currentGoal.tokensUsed,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: currentGoal.tokensUsed,
    }

    processGoalRuntimeEvent(
      { type: 'tool_completed_goal' },
      {
        goal: currentGoal,
        runtime: appState.goalRuntime,
        currentTokenUsage,
        injectPrompt: async () => {},
        updateGoal: (updatedGoal: Goal) => {
          setAppState(prev => ({
            ...prev,
            goal: updatedGoal,
          }))
        },
      }
    )

    // Generate completion report (matching Codex behavior)
    const updatedGoal = getAppState().goal
    let response = `Goal completed: "${updatedGoal.objective}"\n`
    response += `Time elapsed: ${updatedGoal.timeUsedSeconds}s\n`
    if (updatedGoal.tokenBudget) {
      response += `Token budget used: ${updatedGoal.tokensUsed} / ${updatedGoal.tokenBudget}\n`
    } else {
      response += `Tokens consumed: ${updatedGoal.tokensUsed}\n`
    }
    if (input.summary) {
      response += `\nSummary: ${input.summary}`
    }

    return {
      data: { message: response },
    }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: data.message,
    }
  },
})

export { UPDATE_GOAL_TOOL_NAME }
export type { InputSchema as UpdateGoalInput }