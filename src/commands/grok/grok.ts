// src/commands/grok/grok.ts

import type { LocalCommandModule } from '../../commands.js'
import { grokManager } from '../../tools/GrokTool/GrokManager.js'

export const call: LocalCommandModule['call'] = async (args, context) => {
  const languageMatch = args.match(/--language\s+(\w+)/)
  const scopeMatch = args.match(/--scope\s+(\S+)/)
  const language = languageMatch?.[1] || 'en'
  const scope = scopeMatch?.[1]

  let progressMessage = '┌── Grok 图谱生成 ──────────────────────────────┐\n'

  try {
    const result = await grokManager.runAgentPipeline({
      language,
      scope,
      onProgress: (stage, progress) => {
        progressMessage += `│ ${stage.padEnd(20)} ${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))} ${progress}%\n`
      },
    })

    progressMessage += '└──────────────────────────────────────────────────┘\n'
    progressMessage += `\n✓ 图谱已生成: ${result.filePath}\n`
    progressMessage += `  节点: ${result.nodeCount} | 边: ${result.edgeCount} | 域: ${result.domainCount}\n`
    progressMessage += '\n💡 输入 /gd 查看交互式 Dashboard\n'

    return { type: 'text', value: progressMessage }
  } catch (error) {
    return {
      type: 'text',
      value: `✗ 图谱生成失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
