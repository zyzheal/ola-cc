import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  analyze,
  formatDiagnosticResult,
  getOrCreateCache,
} from '../../services/process-diagnostic/index.js'
import { DiagnosticError, AmbiguousError } from '../../services/process-diagnostic/types.js'
import { renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    target_type: z.enum(['port', 'name', 'pid', 'file', 'container'])
      .describe('Query type'),
    target_value: z.string()
      .describe('Query value (port number, process name, PID, file path, container name/ID)'),
    verbose: z.boolean().optional()
      .describe('Include children and extended info. WARNING: may expose sensitive env vars (auto-redacted)'),
    exact: z.boolean().optional()
      .describe('Exact match for name queries'),
    output: z.enum(['json', 'text']).optional()
      .describe('Output format, default json'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    data: z.string().optional(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
    pids: z.array(z.number()).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

const DESCRIPTION = [
  'Diagnose who is using a port, what process is running, where it came from (ancestry chain),',
  'and container status. Use when the user asks about port conflicts, zombie processes,',
  'high CPU usage, container health, or "what is running on port X".',
].join(' ')

export const ProcessDiagnosticTool = buildTool({
  name: 'process_diagnostic',
  searchHint: 'diagnose port process container socket ancestry lsof netstat ss',
  maxResultSizeChars: 32_768,

  async description() {
    return DESCRIPTION
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  isReadOnly(_input: Input) {
    return true
  },
  isConcurrencySafe(_input: Input) {
    return true
  },
  renderToolUseMessage,

  // S1: 摘要和活动描述
  getToolUseSummary(input: Input) {
    return `${input.target_type}:${input.target_value}`
  },
  getActivityDescription(input: Input) {
    return `Diagnosing ${input.target_type}: ${input.target_value}`
  },

  async checkPermissions(input: Input) {
    if (input.verbose) {
      return {
        behavior: 'ask' as const,
        message: 'verbose 模式会读取进程环境变量（自动脱敏），是否继续？',
      }
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },

  async prompt() {
    return [
      'This tool diagnoses process/port/container issues by building a causal chain (PID → ancestry → source).',
      'It returns structured JSON with process info, ancestry chain, source detection, and warnings.',
      'For port queries, it identifies the listening process and traces back to its origin (systemd, SSH, container, etc.).',
    ].join('\n')
  },

  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    if (content.success) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: content.data ?? '',
      }
    }
    const parts = [`Error [${content.errorCode ?? 'UNKNOWN'}]: ${content.error}`]
    if (content.pids?.length) {
      parts.push(`Candidate PIDs: ${content.pids.join(', ')}`)
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: parts.join('\n'),
    }
  },

  async call(input: Input, context): Promise<{ data: Output }> {
    const cache = getOrCreateCache(context)
    try {
      const result = await analyze({
        target: { type: input.target_type, value: input.target_value },
        verbose: input.verbose,
        exact: input.exact,
        cache,
      })
      const formatted = formatDiagnosticResult(result, input.output || 'json')
      return {
        data: {
          success: true,
          data: formatted,
        },
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const errorCode = err instanceof DiagnosticError ? err.code : 'UNKNOWN'
      const pids = err instanceof AmbiguousError ? err.pids : undefined
      return {
        data: {
          success: false,
          error: message,
          errorCode,
          pids,
        },
      }
    }
  },
})
