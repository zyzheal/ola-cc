// src/commands/go/index.ts

import type { Command } from '../../commands.js'

const go: Command = {
  type: 'prompt',
  name: 'go',
  description: 'Grok 新人入职指南',
  aliases: ['grok-onboard'],
  contentLength: 1000,
  progressMessage: '生成入职指南...',
  source: 'builtin',

  async getPromptForCommand() {
    return [{ type: 'text', text: '使用 grok 工具生成新人入职指南' }]
  },
}

export default go
