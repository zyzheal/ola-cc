import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { REPL_TOOL_NAME, isReplModeEnabled } from './constants.js'
import { getReplPrimitiveTools } from './primitiveTools.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    commands: z
      .array(z.string())
      .describe('Array of shell commands to execute in sequence'),
    working_directory: z
      .string()
      .optional()
      .describe('Working directory for command execution'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    results: z
      .array(
        z.object({
          command: z.string(),
          exit_code: z.number().nullable(),
          stdout: z.string(),
          stderr: z.string(),
        }),
      )
      .describe('Results from each command execution'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const REPLTool: ToolDef<InputSchema, OutputSchema> = buildTool({
  name: REPL_TOOL_NAME,
  searchHint: 'execute multiple commands in a REPL environment',
  maxResultSizeChars: 1_000_000,
  userFacingName: () => 'REPL',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: false,
  isConcurrencySafe() {
    return false
  },
  isAvailable() {
    return isReplModeEnabled()
  },
  async description() {
    return 'Execute multiple commands in a Read-Eval-Print Loop (REPL) environment'
  },
  async prompt() {
    return 'Execute multiple commands in sequence. Results are returned after all commands complete.'
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output.results, null, 2),
    }
  },
  async execute(input, context) {
    // Stub implementation - returns mock results
    const results = input.commands.map(cmd => ({
      command: cmd,
      exit_code: 0,
      stdout: `Output of: ${cmd}`,
      stderr: '',
    }))
    
    return {
      results,
    }
  },
})

// Re-export for use in other modules
export { isReplModeEnabled, getReplPrimitiveTools }
