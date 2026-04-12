import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'

export const TungstenTool = buildTool({
  name: 'tungsten',
  userFacingName() {
    return 'Tungsten'
  },
  async description() {
    return 'Unavailable in restored development build.'
  },
  async prompt() {
    return 'Unavailable in restored development build.'
  },
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({}).passthrough(),
  isEnabled() {
    return false
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async call() {
    return { data: { ok: false } }
  },
})
