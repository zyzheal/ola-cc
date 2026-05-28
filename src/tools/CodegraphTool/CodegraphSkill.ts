// src/tools/CodegraphTool/CodegraphSkill.ts

import * as CodegraphManager from './CodegraphManager.js'

// --- Interfaces ---

interface CodegraphNode {
  name: string
  kind?: string
  file: string
  line: number
  signature?: string
  depth?: number
}

interface CodegraphTraceResult {
  from: string
  to: string
  connectingNodes?: CodegraphNode[]
  error?: string
}

interface CodegraphStatusResult {
  initialized: boolean
  nodeCount?: number
  fileCount?: number
}

interface CodegraphInitResult {
  message?: string
}

// --- Type literals ---

type CodegraphOperation =
  | 'codegraph_search'
  | 'codegraph_impact'
  | 'codegraph_trace'
  | 'codegraph_callers'
  | 'codegraph_callees'
  | 'codegraph_init'
  | 'codegraph_status'
  | 'codegraph_context'

// --- Constants ---

const MAX_SEARCH_RESULTS_DISPLAY = 10
const MAX_IMPACT_RESULTS_DISPLAY = 15

// --- Exported types ---

export interface CodegraphSkillResult {
  formatted: string  // 终端友好的格式化输出
  raw: unknown       // 原始 JSON 数据
}

/**
 * 解析 /cg 子命令
 * 支持格式：
 *   /cg <query>           → 自然语言查询（智能路由）
 *   /cg s <query>         → 符号搜索
 *   /cg i <symbol>        → 影响分析
 *   /cg tr <from> <to>    → 路径追踪
 *   /cg c <symbol>        → 调用者
 *   /cg e <symbol>        → 被调用
 *   /cg init              → 初始化
 *   /cg st                → 状态
 */
export function parseCgCommand(args: string): {
  operation: CodegraphOperation
  query?: string
  symbol?: string
} {
  const trimmed = args.trim()

  if (!trimmed) {
    return { operation: 'codegraph_status' }
  }

  // 子命令映射
  const subcommands: Record<string, CodegraphOperation> = {
    's': 'codegraph_search',
    'search': 'codegraph_search',
    'i': 'codegraph_impact',
    'impact': 'codegraph_impact',
    'tr': 'codegraph_trace',
    'trace': 'codegraph_trace',
    'c': 'codegraph_callers',
    'callers': 'codegraph_callers',
    'e': 'codegraph_callees',
    'callees': 'codegraph_callees',
    'init': 'codegraph_init',
    'st': 'codegraph_status',
    'status': 'codegraph_status',
  }

  const parts = trimmed.split(/\s+/)
  const first = parts[0].toLowerCase()

  if (subcommands[first]) {
    const rest = parts.slice(1).join(' ')

    if (first === 'tr' || first === 'trace') {
      return {
        operation: 'codegraph_trace',
        query: rest,
      }
    }

    if (['i', 'impact', 'c', 'callers', 'e', 'callees'].includes(first)) {
      return {
        operation: subcommands[first],
        symbol: rest,
      }
    }

    return {
      operation: subcommands[first],
      query: rest || undefined,
    }
  }

  // 默认：自然语言查询
  return {
    operation: 'codegraph_context',
    query: trimmed,
  }
}

/**
 * 格式化 CodeGraph 结果为终端友好输出
 */
export function formatCodegraphResult(
  operation: CodegraphOperation,
  result: unknown,
): CodegraphSkillResult {
  let formatted = ''

  switch (operation) {
    case 'codegraph_search': {
      const nodes: CodegraphNode[] = Array.isArray(result) ? result as CodegraphNode[] : []
      if (nodes.length === 0) {
        formatted = '未找到匹配的符号'
      } else {
        formatted = `找到 ${nodes.length} 个符号：\n\n`
        for (const n of nodes.slice(0, MAX_SEARCH_RESULTS_DISPLAY)) {
          if (typeof n !== 'object' || n === null) continue
          formatted += `  ${n.name}${n.kind ? ` (${n.kind})` : ''}\n`
          formatted += `    文件: ${n.file}:${n.line}\n`
          if (n.signature) {
            formatted += `    签名: ${n.signature}\n`
          }
          formatted += '\n'
        }
        if (nodes.length > MAX_SEARCH_RESULTS_DISPLAY) {
          formatted += `  ... 还有 ${nodes.length - MAX_SEARCH_RESULTS_DISPLAY} 个结果\n`
        }
      }
      break
    }

    case 'codegraph_callers':
    case 'codegraph_callees': {
      const nodes: CodegraphNode[] = Array.isArray(result) ? result as CodegraphNode[] : []
      const label = operation === 'codegraph_callers' ? '调用者' : '被调用'
      if (nodes.length === 0) {
        formatted = `未找到${label}关系`
      } else {
        formatted = `找到 ${nodes.length} 个${label}：\n\n`
        for (const n of nodes.slice(0, MAX_SEARCH_RESULTS_DISPLAY)) {
          if (typeof n !== 'object' || n === null) continue
          formatted += `  ${n.name}\n`
          formatted += `    文件: ${n.file}:${n.line}\n\n`
        }
      }
      break
    }

    case 'codegraph_impact': {
      const nodes: CodegraphNode[] = Array.isArray(result) ? result as CodegraphNode[] : []
      if (nodes.length === 0) {
        formatted = '未找到影响范围'
      } else {
        formatted = `影响分析（${nodes.length} 个文件）：\n\n`
        for (const n of nodes.slice(0, MAX_IMPACT_RESULTS_DISPLAY)) {
          if (typeof n !== 'object' || n === null) continue
          formatted += `  ${n.name}\n`
          formatted += `    文件: ${n.file}\n`
          if (n.depth !== undefined) {
            formatted += `    深度: ${n.depth}\n`
          }
          formatted += '\n'
        }
        if (nodes.length > MAX_IMPACT_RESULTS_DISPLAY) {
          formatted += `  ... 还有 ${nodes.length - MAX_IMPACT_RESULTS_DISPLAY} 个文件\n`
        }
      }
      break
    }

    case 'codegraph_trace': {
      const data = result as CodegraphTraceResult
      if (typeof data !== 'object' || data === null) {
        formatted = '错误: 无效的追踪结果'
        break
      }
      if (data.error) {
        formatted = `错误: ${data.error}`
      } else {
        formatted = `路径追踪: ${data.from} → ${data.to}\n\n`
        if (data.connectingNodes && data.connectingNodes.length > 0) {
          formatted += `连接节点（${data.connectingNodes.length} 个）：\n`
          for (const node of data.connectingNodes) {
            formatted += `  ${node.name}\n`
          }
        } else {
          formatted += '未找到直接连接路径'
        }
      }
      break
    }

    case 'codegraph_status': {
      const data = result as CodegraphStatusResult
      if (typeof data !== 'object' || data === null) {
        formatted = '错误: 无效的状态结果'
        break
      }
      formatted = `CodeGraph 状态：\n\n`
      formatted += `  已初始化: ${data.initialized ? '是' : '否'}\n`
      if (data.nodeCount !== undefined) {
        formatted += `  节点数: ${data.nodeCount}\n`
      }
      if (data.fileCount !== undefined) {
        formatted += `  文件数: ${data.fileCount}\n`
      }
      break
    }

    case 'codegraph_init': {
      const data = result as CodegraphInitResult
      if (typeof data !== 'object' || data === null) {
        formatted = '错误: 无效的初始化结果'
        break
      }
      formatted = data.message || '初始化完成'
      break
    }

    default: {
      formatted = JSON.stringify(result, null, 2)
    }
  }

  return { formatted, raw: result }
}
