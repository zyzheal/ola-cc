import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const SUGGEST_BACKGROUND_PR_TOOL_NAME = 'SuggestBackgroundPR'

export const DESCRIPTION = 'Suggest a Pull Request to work on in the background'

const inputSchema = lazySchema(() =>
  z.strictObject({
    pr_number: z.number().describe('The Pull Request number to suggest'),
    repo: z
      .string()
      .optional()
      .describe('Repository in format owner/repo (defaults to current repo)'),
    reason: z.string().describe('Reason why this PR should be worked on'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    accepted: z.boolean().describe('Whether the suggestion was accepted'),
    message: z.string().describe('Status message'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const SuggestBackgroundPRTool: ToolDef<InputSchema, OutputSchema> =
  buildTool({
    name: SUGGEST_BACKGROUND_PR_TOOL_NAME,
    searchHint: 'suggest a PR for background work',
    maxResultSizeChars: 10_000,
    userFacingName: () => 'Suggest Background PR',
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
        accepted: true,
        message: `Suggested PR #${input.pr_number} for background work: ${input.reason}`,
      }
    },
  })
