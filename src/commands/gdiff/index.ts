// src/commands/gdiff/index.ts

import type { Command } from '../../commands.js'

const gdiff: Command = {
  type: 'prompt',
  name: 'gdiff',
  description: 'Grok 变更影响分析',
  aliases: ['grok-diff'],
  contentLength: 1000,
  progressMessage: '分析变更影响...',
  source: 'builtin',

  async getPromptForCommand() {
    return [{ type: 'text', text: '使用 grok 工具分析当前变更的影响' }]
  },
}

export default gdiff
