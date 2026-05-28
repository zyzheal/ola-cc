// src/tools/GrokTool/GrokSkill.ts

import { GrokError } from './GrokManager.js'

export interface GrokSkillResult {
  formatted: string
  raw: unknown
}

/**
 * 格式化 Grok 错误为用户友好的消息
 */
export function formatGrokError(error: unknown): string {
  if (error instanceof GrokError) {
    let msg = `✗ Grok 错误 [${error.code}]: ${error.message}`
    if (error.recoverable) {
      msg += `\n  💡 此错误可恢复，请稍后重试`
    }
    if (error.suggestion) {
      msg += `\n  建议: ${error.suggestion}`
    }
    return msg
  }

  if (error instanceof Error) {
    return `✗ Grok 错误: ${error.message}`
  }

  return `✗ 未知错误: ${String(error)}`
}

/**
 * 格式化 Grok 结果为终端友好输出
 */
export function formatGrokResult(operation: string, result: unknown): GrokSkillResult {
  let formatted = ''

  switch (operation) {
    case 'grok_status': {
      const data = result as { exists: boolean; nodeCount?: number; edgeCount?: number; lastUpdated?: string; stale?: boolean }
      formatted = `Grok 图谱状态：\n\n`
      formatted += `  存在: ${data.exists ? '是' : '否'}\n`
      if (data.nodeCount !== undefined) {
        formatted += `  节点数: ${data.nodeCount}\n`
      }
      if (data.edgeCount !== undefined) {
        formatted += `  边数: ${data.edgeCount}\n`
      }
      if (data.lastUpdated) {
        formatted += `  最后更新: ${data.lastUpdated}\n`
      }
      if (data.stale) {
        formatted += `\n⚠️ 图谱已过期，建议执行 /grok --full 重新生成\n`
      }
      break
    }

    case 'grok_chat': {
      const data = result as { answer: string; sources?: { file: string; line: number }[] }
      formatted = `┌── Grok 问答 ──────────────────────────────────┐\n`
      formatted += `│ A: ${data.answer}\n`
      if (data.sources && data.sources.length > 0) {
        formatted += `│\n│ 相关文件:\n`
        for (const source of data.sources.slice(0, 5)) {
          formatted += `│   • ${source.file}:${source.line}\n`
        }
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_explain': {
      const data = result as { summary: string; relationships?: { file: string; line: number }[] }
      formatted = `┌── Grok 解释 ──────────────────────────────────┐\n`
      formatted += `│ 摘要:\n│   ${data.summary}\n`
      if (data.relationships && data.relationships.length > 0) {
        formatted += `│\n│ 关系:\n`
        for (const rel of data.relationships.slice(0, 5)) {
          formatted += `│   • ${rel.file}:${rel.line}\n`
        }
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_domain': {
      const data = result as { domains: string }
      formatted = `┌── Grok 业务域 ────────────────────────────────┐\n`
      if (typeof data.domains === 'string') {
        formatted += `│ ${data.domains}\n`
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_tour': {
      const data = result as { tours: string }
      formatted = `┌── Grok 学习路径 ──────────────────────────────┐\n`
      if (typeof data.tours === 'string') {
        formatted += `│ ${data.tours}\n`
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_diff': {
      const data = result as { impacted: string }
      formatted = `┌── Grok 变更影响 ──────────────────────────────┐\n`
      if (typeof data.impacted === 'string') {
        formatted += `│ ${data.impacted}\n`
      }
      formatted += `└──────────────────────────────────────────────────┘\n`
      break
    }

    case 'grok_dashboard': {
      const data = result as { url: string }
      formatted = `✓ Dashboard 已启动: ${data.url}\n`
      formatted += `（浏览器自动打开）\n`
      break
    }

    case 'grok_generate': {
      const data = result as { filePath: string; nodeCount: number; edgeCount: number; domainCount: number }
      formatted = `✓ 图谱已生成: ${data.filePath}\n`
      formatted += `  节点: ${data.nodeCount} | 边: ${data.edgeCount} | 域: ${data.domainCount}\n`
      formatted += `\n💡 输入 /gd 查看交互式 Dashboard\n`
      break
    }

    default:
      formatted = JSON.stringify(result, null, 2)
  }

  return { formatted, raw: result }
}
