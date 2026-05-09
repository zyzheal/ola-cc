import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { ThreadGoalStatus } from '../../commands/goal/types.js'
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
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call(input: InputSchema, context): Promise<{ data: Output }> {
    const { getAppState, setAppState } = context as {
      getAppState: () => AppState
      setAppState: SetAppState
    }

    const appState = getAppState()
    const currentGoal = appState.goal

    if (!currentGoal.id) {
      return {
        data: { message: 'No active goal to update.' },
      }
    }

    const newStatus = input.status as ThreadGoalStatus

    setAppState((prev) => ({
      ...prev,
      goal: {
        ...prev.goal,
        status: newStatus,
        updatedAt: Date.now(),
      },
    }))

    let response = `Goal status updated to "${input.status}".`
    if (input.summary) {
      response += ` Progress: ${input.summary}`
    }

    return {
      data: { message: response },
    }
  },
})

export { UPDATE_GOAL_TOOL_NAME }
export type { InputSchema as UpdateGoalInput }