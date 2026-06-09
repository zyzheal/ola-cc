import type { Command } from '../../commands.js'

const command = {
  name: 'tui',
  description: 'Toggle fullscreen TUI mode (bypass env/tmux restrictions)',
  supportsNonInteractive: true,
  type: 'local',
  load: () => import('./tui.js'),
} satisfies Command

export default command
