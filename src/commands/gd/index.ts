// src/commands/gd/index.ts

import type { Command } from '../../commands.js'

const gd: Command = {
  type: 'local',
  name: 'gd',
  description: '打开浏览器 Dashboard',
  aliases: ['grok-dashboard'],
  supportsNonInteractive: false,
  load: () => import('./gd.js'),
}

export default gd
