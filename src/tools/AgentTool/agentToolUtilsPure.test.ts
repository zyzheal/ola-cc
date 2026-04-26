import { describe, it, expect } from 'bun:test'

// ─── Pure function tests (inlined to avoid circular dependency with AgentTool.tsx) ──

// extractPartialResult — inline copy to avoid importing agentToolUtils
function extractPartialResult(messages: Array<{
  type: string
  message: { content: Array<{ type: string; text?: string; thinking?: string }> }
}>): string {
  const lastAssistant = messages.filter(m => m.type === 'assistant').pop()
  if (!lastAssistant?.message?.content) return ''
  const textBlock = lastAssistant.message.content.find(b => b.type === 'text')
  if (textBlock?.text) return textBlock.text
  const thinkingBlock = lastAssistant.message.content.find(b => b.type === 'thinking')
  if (thinkingBlock?.thinking) return thinkingBlock.thinking
  return ''
}

// getLastToolUseName — inline copy
function getLastToolUseName(msg: {
  type: string
  message: { content: Array<{ type: string; name?: string }> }
}): string | undefined {
  if (msg.type !== 'assistant') return undefined
  const toolUses = msg.message?.content?.filter(b => b.type === 'tool_use') ?? []
  return toolUses.at(-1)?.name
}

// ─── extractPartialResult ───────────────────────────────────────────────────

describe('extractPartialResult', () => {
  it('returns empty string for no messages', () => {
    const result = extractPartialResult([])
    expect(result).toBe('')
  })

  it('returns empty string for messages without assistant text', () => {
    const messages = [
      {
        type: 'user' as const,
        message: {
          content: [{ type: 'text' as const, text: 'hello' }],
        },
      },
    ]
    const result = extractPartialResult(messages as any)
    expect(result).toBe('')
  })

  it('extracts text content from last assistant message', () => {
    const messages = [
      {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text' as const, text: 'Final result' }],
        },
      },
    ]
    const result = extractPartialResult(messages as any)
    expect(result).toBe('Final result')
  })

  it('extracts thinking content when no text', () => {
    const messages = [
      {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'thinking' as const, thinking: 'Deep thought' }],
        },
      },
    ]
    const result = extractPartialResult(messages as any)
    expect(result).toBe('Deep thought')
  })

  it('handles mixed content blocks', () => {
    const messages = [
      {
        type: 'assistant' as const,
        message: {
          content: [
            { type: 'tool_use' as const, name: 'Read', input: {}, id: '1' },
            { type: 'text' as const, text: 'Done reading' },
          ],
        },
      },
    ]
    const result = extractPartialResult(messages as any)
    expect(result).toBe('Done reading')
  })
})

// ─── getLastToolUseName ─────────────────────────────────────────────────────

describe('getLastToolUseName', () => {
  it('returns undefined for non-assistant messages', () => {
    const msg = {
      type: 'user' as const,
      message: { content: [{ type: 'text' as const, text: 'hello' }] },
    }
    const result = getLastToolUseName(msg as any)
    expect(result).toBeUndefined()
  })

  it('returns undefined for assistant message without tool_use', () => {
    const msg = {
      type: 'assistant' as const,
      message: { content: [{ type: 'text' as const, text: 'hello' }] },
    }
    const result = getLastToolUseName(msg as any)
    expect(result).toBeUndefined()
  })

  it('returns name of last tool_use block', () => {
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [
          { type: 'text' as const, text: 'thinking' },
          { type: 'tool_use' as const, name: 'Read', input: {}, id: '1' },
          { type: 'tool_use' as const, name: 'Bash', input: {}, id: '2' },
        ],
      },
    }
    const result = getLastToolUseName(msg as any)
    expect(result).toBe('Bash')
  })
})
