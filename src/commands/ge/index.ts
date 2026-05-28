// src/commands/ge/index.ts

import type { Command } from '../../commands.js'

const ge: Command = {
  type: 'prompt',
  name: 'ge',
  description: 'Grok 深入解释文件/函数',
  aliases: ['grok-explain'],
  argumentHint: '<file>',
  contentLength: 1000,
  progressMessage: '分析文件...',
  source: 'builtin',

  async getPromptForCommand(args) {
    if (!args.trim()) {
      return [{ type: 'text', text: '请指定文件，例如: /ge src/QueryEngine.ts' }]
    }
    return [{ type: 'text', text: `使用 grok 工具解释: ${args.trim()}` }]
  },
}

export default ge
