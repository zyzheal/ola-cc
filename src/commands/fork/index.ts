import type { Command } from '../../commands.js'

const fork = {
  type: 'prompt',
  name: 'fork',
  description: 'Fork subagent',
  contentLength: 0,
  isEnabled: () => true,
  load: () =>
    Promise.resolve({
      async getPromptForCommand() {
        return 'Fork is not implemented.'
      },
    }),
} satisfies Command

export default fork
