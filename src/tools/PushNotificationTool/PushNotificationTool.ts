import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'

export const DESCRIPTION = 'Send a push notification to the user'

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z.string().describe('Notification title'),
    body: z.string().describe('Notification body text'),
    priority: z
      .enum(['low', 'normal', 'high'])
      .optional()
      .describe('Notification priority (default: normal)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the notification was sent'),
    message: z.string().describe('Status message'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const PushNotificationTool: ToolDef<InputSchema, OutputSchema> =
  buildTool({
    name: PUSH_NOTIFICATION_TOOL_NAME,
    searchHint: 'send a push notification',
    maxResultSizeChars: 10_000,
    userFacingName: () => 'Push Notification',
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
        message: `Push notification sent: ${input.title}`,
      }
    },
  })
