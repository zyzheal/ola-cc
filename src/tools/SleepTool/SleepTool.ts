import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { DESCRIPTION, SLEEP_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    duration: z
      .number()
      .optional()
      .describe('Duration to sleep in seconds (default: 60)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Status message about the sleep operation'),
    duration: z.number().describe('The actual duration slept in seconds'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const SleepTool: ToolDef<InputSchema, OutputSchema> = buildTool({
  name: SLEEP_TOOL_NAME,
  searchHint: 'wait for a specified duration',
  maxResultSizeChars: 10_000,
  userFacingName: () => 'Sleep',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }
  },
  async execute(input, context) {
    const duration = input.duration ?? 60
    const actualDuration = Math.min(duration, 300) // Cap at 5 minutes
    
    await new Promise(resolve => setTimeout(resolve, actualDuration * 1000))
    
    return {
      message: `Slept for ${actualDuration} seconds`,
      duration: actualDuration,
    }
  },
})
