// src/commands/gdomain/index.ts

import type { Command } from '../../commands.js'

const gdomain: Command = {
  type: 'prompt',
  name: 'gdomain',
  description: 'Grok 业务域分析',
  aliases: ['grok-domain'],
  contentLength: 1000,
  progressMessage: '分析业务域...',
  source: 'builtin',

  async getPromptForCommand() {
    return [{ type: 'text', text: '使用 grok 工具分析业务域' }]
  },
}

export default gdomain
