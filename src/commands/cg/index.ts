// src/commands/cg/index.ts

import type { Command } from '../../commands.js'

const cg: Command = {
  type: 'prompt',
  name: 'cg',
  description: 'CodeGraph 代码查询 — 符号搜索、调用链、影响分析',
  aliases: ['codegraph'],
  argumentHint: '[query | s <query> | i <symbol> | tr <from> <to> | c <symbol> | e <symbol> | init | st]',
  contentLength: 2000,
  progressMessage: '查询 CodeGraph...',
  source: 'builtin',

  async getPromptForCommand(args) {
    // 动态导入 Skill 层
    const { parseCgCommand } = await import('../../tools/CodegraphTool/CodegraphSkill.js')
    const parsed = parseCgCommand(args)

    // 构造 prompt 让模型调用 codegraph Tool
    let prompt = ''

    switch (parsed.operation) {
      case 'codegraph_search':
        prompt = `使用 codegraph 工具搜索符号 "${parsed.query}"。返回匹配的符号列表，包含文件位置和签名。`
        break
      case 'codegraph_impact':
        prompt = `使用 codegraph 工具分析 "${parsed.symbol}" 的影响范围。返回所有受影响的文件和调用链。`
        break
      case 'codegraph_trace':
        prompt = `使用 codegraph 工具追踪调用路径: ${parsed.query}。找到从起点到终点的连接节点。`
        break
      case 'codegraph_callers':
        prompt = `使用 codegraph 工具查找 "${parsed.symbol}" 的调用者。返回所有调用该符号的文件和位置。`
        break
      case 'codegraph_callees':
        prompt = `使用 codegraph 工具查找 "${parsed.symbol}" 调用的函数。返回该符号调用的所有函数。`
        break
      case 'codegraph_init':
        prompt = `使用 codegraph 工具初始化当前项目的代码索引。这会下载必要的依赖并创建符号数据库。`
        break
      case 'codegraph_status':
        prompt = `使用 codegraph 工具检查当前项目的索引状态。返回节点数、文件数等统计信息。`
        break
      case 'codegraph_context':
      default:
        prompt = `使用 codegraph 工具理解 "${parsed.query}" 的代码上下文。返回相关的符号、文件和关系。`
        break
    }

    return [
      {
        type: 'text' as const,
        text: prompt,
      },
    ]
  },
}

export default cg
