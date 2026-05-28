// src/commands/gc/index.ts

import type { Command } from '../../commands.js'

const gc: Command = {
  type: 'prompt',
  name: 'gc',
  description: 'Grok 自然语言问答',
  aliases: ['grok-chat'],
  argumentHint: '<question>',
  contentLength: 1000,
  progressMessage: '查询知识图谱...',
  source: 'builtin',

  async getPromptForCommand(args) {
    if (!args.trim()) {
      return [{ type: 'text', text: '请输入问题，例如: /gc 支付流程是怎么工作的？' }]
    }

    return [
      {
        type: 'text',
        text: `使用 grok 工具回答问题: ${args.trim()}`,
      },
    ]
  },
}

export default gc
