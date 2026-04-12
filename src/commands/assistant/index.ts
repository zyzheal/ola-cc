import type { Command } from '../../commands.js'
import { getKairosActive, setKairosActive } from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'

const assistant = {
  type: 'local-jsx',
  name: 'assistant',
  description: 'Toggle assistant (KAIROS) mode',
  isEnabled: () => true,
  immediate: true,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<null> {
        const current = getKairosActive()
        const newState = !current

        setKairosActive(newState)

        logEvent('tengu_assistant_toggled', {
          enabled: newState,
        })

        onDone(newState ? 'Assistant mode enabled' : 'Assistant mode disabled', {
          display: 'system',
        })
        return null
      },
    }),
} satisfies Command

export default assistant
