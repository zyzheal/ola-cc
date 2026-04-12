import type { Command } from '../../commands.js'

const torch = {
  type: 'prompt',
  name: 'torch',
  description: 'Torch feature',
  contentLength: 0,
  isEnabled: () => true,
  load: () =>
    Promise.resolve({
      async getPromptForCommand() {
        return 'Torch is not implemented.'
      },
    }),
} satisfies Command

export default torch
