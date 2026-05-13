import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'auth',
  description: 'Manage API provider profiles (API URL, key, multiple models). Use add/list/use/delete/edit',
  argumentHint: '[add|list|use|delete|test] [args...]',
  load: () => import('./auth.js'),
} satisfies Command
