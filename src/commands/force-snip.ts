import type { Command } from '../commands.js'

const forceSnip = {
  type: 'prompt',
  name: 'force-snip',
  description: 'Force snip history',
  contentLength: 0,
  isEnabled: () => true,
  load: () =>
    Promise.resolve({
      async getPromptForCommand() {
        return 'Force snip history is not implemented.'
      },
    }),
} satisfies Command

export default forceSnip
