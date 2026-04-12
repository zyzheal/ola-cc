import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const SUBSCRIBE_PR_TOOL_NAME = 'SubscribePR'

export const DESCRIPTION = 'Subscribe to a GitHub Pull Request for notifications'

const inputSchema = lazySchema(() =>
  z.strictObject({
    pr_number: z.number().describe('The Pull Request number'),
    repo: z
      .string()
      .optional()
      .describe('Repository in format owner/repo (defaults to current repo)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the subscription was successful'),
    message: z.string().describe('Status message'),
    pr_number: z.number().describe('The PR number subscribed to'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const SubscribePRTool: ToolDef<InputSchema, OutputSchema> = buildTool({
  name: SUBSCRIBE_PR_TOOL_NAME,
  searchHint: 'subscribe to a pull request',
  maxResultSizeChars: 10_000,
  userFacingName: () => 'Subscribe to PR',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: false,
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
    // Stub implementation
    return {
      success: true,
      message: `Subscribed to PR #${input.pr_number}`,
      pr_number: input.pr_number,
    }
  },
})
