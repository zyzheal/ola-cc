import type { Command } from '../../commands.js'

const sessions = {
  type: 'local-jsx',
  name: 'sessions',
  description: 'View background session status',
  load: () => import('./sessions.js'),
} satisfies Command

export default sessions
