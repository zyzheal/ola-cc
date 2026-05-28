// src/commands/grok/index.ts

import type { Command } from '../../commands.js'

const grok: Command = {
  type: 'local',
  name: 'grok',
  description: '生成项目知识图谱（首次约 3-5 分钟）',
  aliases: ['understand'],
  argumentHint: '[--language zh] [--scope <path>]',
  supportsNonInteractive: false,
  load: () => import('./grok.js'),
}

export default grok
