/**
 * GrokTool — Understand-Anything 知识图谱集成
 *
 * 离线知识图谱生成 + Dashboard 可视化 + 业务域分析 + 引导式学习。
 * 与 CodeGraph 互补：CodeGraph 做实时查询，Grok 做深度语义分析。
 */

import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { grokManager } from './GrokManager.js'

// ============================================================
// Schema
// ============================================================

const operationEnum = z.enum([
  'grok_generate',
  'grok_chat',
  'grok_explain',
  'grok_domain',
  'grok_tour',
  'grok_diff',
  'grok_status',
  'grok_dashboard',
])

const inputSchema = z.object({
  operation: operationEnum.describe('Grok 操作类型'),
  question: z.string().optional().describe('问题（用于 grok_chat）'),
  target: z.string().optional().describe('目标文件/函数（用于 grok_explain）'),
  topic: z.string().optional().describe('主题（用于 grok_tour）'),
  files: z.array(z.string()).optional().describe('变更文件列表（用于 grok_diff）'),
  path: z.string().optional().describe('扫描路径（用于 grok_generate）'),
  language: z.string().optional().describe('输出语言（用于 grok_generate）'),
  scope: z.string().optional().describe('子目录范围（用于 grok_generate）'),
  incremental: z.boolean().optional().describe('增量更新（用于 grok_generate）'),
  port: z.number().optional().describe('端口号（用于 grok_dashboard）'),
})

// ============================================================
// Tool
// ============================================================

export const grokTool = buildTool({
  name: 'grok',
  description:
    'Grok 代码理解 — 知识图谱生成、自然语言问答、业务域分析、引导式学习。' +
    '首次使用需要生成知识图谱（约 3-5 分钟），之后查询秒级响应。',

  inputSchema,

  async call(input: z.infer<typeof inputSchema>) {
    try {
      await grokManager.ensureGrokSource()

      let result: unknown

      switch (input.operation) {
        case 'grok_generate': {
          const genResult = await grokManager.runAgentPipeline({
            path: input.path || getCwd(),
            language: input.language,
            scope: input.scope,
            incremental: input.incremental ?? true,
          })
          result = genResult
          break
        }

        case 'grok_chat': {
          if (!input.question) {
            return errorResult('grok_chat 需要 question 参数')
          }
          const chatResult = await grokManager.queryGraph(input.question)
          result = chatResult
          break
        }

        case 'grok_explain': {
          if (!input.target) {
            return errorResult('grok_explain 需要 target 参数')
          }
          const explainResult = await grokManager.queryGraph(
            `Explain ${input.target}: what it does, its relationships, which layer and domain it belongs to`
          )
          result = {
            summary: explainResult.answer,
            relationships: explainResult.sources,
          }
          break
        }

        case 'grok_domain': {
          const domainResult = await grokManager.queryGraph(
            'Analyze the business domains in this codebase. List each domain with its flows and files.'
          )
          result = { domains: domainResult.answer }
          break
        }

        case 'grok_tour': {
          const tourResult = await grokManager.queryGraph(
            input.topic
              ? `Create a guided learning tour for: ${input.topic}`
              : 'Create guided learning tours for this codebase'
          )
          result = { tours: tourResult.answer }
          break
        }

        case 'grok_diff': {
          if (!input.files || input.files.length === 0) {
            return errorResult('grok_diff 需要 files 参数')
          }
          const diffResult = await grokManager.queryGraph(
            `Analyze the impact of changes to these files: ${input.files.join(', ')}`
          )
          result = { impacted: diffResult.answer }
          break
        }

        case 'grok_status': {
          const status = await grokManager.getGraphStatus()
          result = status
          break
        }

        case 'grok_dashboard': {
          const dashResult = await grokManager.startDashboard(input.port)
          result = dashResult
          break
        }

        default:
          return errorResult(`未知操作: ${input.operation}`)
      }

      return successResult(input.operation, result)
    } catch (error) {
      logForDebugging(`[grok] error: ${error}`)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: true,
            operation: input.operation,
            message: error instanceof Error ? error.message : String(error),
          }, null, 2),
        }],
      }
    }
  },

  async prompt(input) {
    const op = input?.operation ?? ''
    const question = input?.question ?? ''
    const target = input?.target ?? ''

    switch (op) {
      case 'grok_generate': return '生成项目知识图谱'
      case 'grok_chat': return `回答问题: ${question}`
      case 'grok_explain': return `解释 ${target}`
      case 'grok_domain': return '分析业务域'
      case 'grok_tour': return '生成学习路径'
      case 'grok_diff': return '分析变更影响'
      case 'grok_status': return '检查图谱状态'
      case 'grok_dashboard': return '启动 Dashboard'
      default: return `Grok ${op}`
    }
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
  isReadOnly: (input) => {
    const op = typeof input === 'object' && input !== null && 'operation' in input
      ? (input as { operation?: string }).operation ?? ''
      : ''
    return op !== 'grok_generate'
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output, null, 2),
    }
  },
})

// ============================================================
// Helpers
// ============================================================

function successResult(operation: string, data: unknown) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: true, operation, result: data }, null, 2),
    }],
  }
}

function errorResult(message: string) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: true, message }, null, 2),
    }],
  }
}
