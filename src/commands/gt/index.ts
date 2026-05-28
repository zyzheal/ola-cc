// src/commands/gt/index.ts

import type { Command } from '../../commands.js'

const gt: Command = {
  type: 'prompt',
  name: 'gt',
  description: 'Grok 引导式学习路径',
  aliases: ['grok-tour'],
  argumentHint: '[topic]',
  contentLength: 1000,
  progressMessage: '生成学习路径...',
  source: 'builtin',

  async getPromptForCommand(args) {
    const topic = args.trim()
    return [{
      type: 'text',
      text: topic
        ? `使用 grok 工具生成 "${topic}" 的学习路径`
        : '使用 grok 工具生成项目学习路径',
    }]
  },
}

export default gt
