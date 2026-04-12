import type { Command } from '../../commands.js'

const subscribePr = {
  type: 'prompt',
  name: 'subscribe-pr',
  description: 'Subscribe to GitHub PR activity',
  contentLength: 0,
  isEnabled: () => true,
  load: () =>
    Promise.resolve({
      async getPromptForCommand() {
        return 'PR subscription is not implemented.'
      },
    }),
} satisfies Command

export default subscribePr
