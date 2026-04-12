import type { Command } from '../../commands.js'

const remoteControlServer = {
  type: 'prompt',
  name: 'remoteControlServer',
  description: 'Remote control server',
  contentLength: 0,
  isEnabled: () => true,
  load: () =>
    Promise.resolve({
      async getPromptForCommand() {
        return 'Remote control server is not implemented.'
      },
    }),
} satisfies Command

export default remoteControlServer
