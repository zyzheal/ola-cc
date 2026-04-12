import type { Command } from '../../commands.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolUseContext } from '../../Tool.js'

const workflows = {
  type: 'prompt',
  name: 'workflows',
  description: 'Workflow scripts',
  contentLength: 0,
  source: 'builtin' as const,
  isEnabled: () => true,
  progressMessage: 'loading workflows',
  async getPromptForCommand(): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: 'Workflows is not implemented.' }]
  },
} satisfies Command

export default workflows
