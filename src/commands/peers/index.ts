import type { Command } from '../../commands.js'

const peers = {
  type: 'prompt',
  name: 'peers',
  description: 'Peer communication',
  contentLength: 0,
  isEnabled: () => true,
  load: () =>
    Promise.resolve({
      async getPromptForCommand() {
        return 'Peers feature is not implemented.'
      },
    }),
} satisfies Command

export default peers
