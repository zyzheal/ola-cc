import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SEND_USER_FILE_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('Path to the file to send'),
    reason: z.string().optional().describe('Optional reason for sending this file'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the file was sent successfully'),
    message: z.string().describe('Status message'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const SendUserFileTool: ToolDef<InputSchema, OutputSchema> = buildTool({
  name: SEND_USER_FILE_TOOL_NAME,
  searchHint: 'send a file to the user',
  maxResultSizeChars: 10_000,
  userFacingName: () => 'Send User File',
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
    return 'Send a file to the user for review or download'
  },
  async prompt() {
    return 'Send a file to the user. Use this when the user requests a file or when you need to share results.'
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }
  },
  async execute(input, context) {
    // Stub implementation - in a real implementation this would send the file
    return {
      success: true,
      message: `File ${input.file_path} sent to user`,
    }
  },
})
