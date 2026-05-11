import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set and manage persistent goals for multi-turn work',
  argumentHint: '[<objective>|status|pause|resume|clear] [--budget <tokens>]',
  supportsNonInteractive: true,
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./goal.js'),
} satisfies Command