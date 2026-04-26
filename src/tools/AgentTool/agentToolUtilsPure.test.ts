/**
 * Tests for pure utility functions from agentToolUtils.ts.
 *
 * WHY INLINE? agentToolUtils.ts imports AgentTool.tsx which has a circular
 * dependency at module load time (agentToolResultSchema references
 * agentToolResultSchema in a lazySchema). Importing from agentToolUtils.ts
 * triggers this and causes "Cannot access before initialization".
 *
 * MAINTENANCE: If the source implementations changes, update the inline
 * copies below and verify they still produce the same output for these test
 * cases. Consider adding a CI assertion if this becomes error-prone.
 */
import { describe, it, expect } from 'bun:test'

// ─── Inline copies from agentToolUtils.ts (see note above) ──────────────────

// extractTextContent — from src/utils/messages.ts
function extractTextContent(blocks: Array<{ type: string; text?: string }>, separator = ''): string {
  return blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join(separator)
}

// extractPartialResult — from agentToolUtils.ts:513
function extractPartialResult(messages: Array<{
  type: string
  message?: { content: Array<{ type: string; text?: string }> }
}>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    if (!m.message || !Array.isArray(m.message.content)) continue
    const text = extractTextContent(m.message.content, '\n')
    if (text) {
      return text
    }
  }
  return undefined
}

// getLastToolUseName — from agentToolUtils.ts:386
function getLastToolUseName(message: {
  type: string
  message?: { content: Array<{ type: string; name?: string }> }
}): string | undefined {
  if (message.type !== 'assistant') return undefined
  if (!message.message || !Array.isArray(message.message.content)) return undefined
  const block = message.message.content.findLast(b => b.type === 'tool_use')
  return block?.type === 'tool_use' ? block.name : undefined
}

// ─── extractPartialResult ───────────────────────────────────────────────────

describe('extractPartialResult', () => {
  it('returns undefined for no messages', () => {
    const result = extractPartialResult([])
    expect(result).toBeUndefined()
  })

  it('returns undefined for messages without assistant text', () => {
    const messages = [
      {
        type: 'user' as const,
        message: {
          content: [{ type: 'text' as const, text: 'hello' }],
        },
      },
    ]
    const result = extractPartialResult(messages as any)
    expect(result).toBeUndefined()
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

  it('returns undefined for assistant with only tool_use blocks', () => {
    const messages = [
      {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'tool_use' as const, name: 'Read', input: {}, id: '1' }],
        },
      },
    ]
    const result = extractPartialResult(messages as any)
    // No text blocks → extractTextContent returns '' → falsy → undefined
    expect(result).toBeUndefined()
  })

  it('handles mixed content blocks — extracts text only', () => {
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

  it('handles undefined message property', () => {
    const messages = [
      { type: 'assistant' as const, message: undefined },
    ]
    const result = extractPartialResult(messages as any)
    expect(result).toBeUndefined()
  })

  it('finds last assistant with text, skipping earlier ones', () => {
    const messages = [
      {
        type: 'assistant' as const,
        message: { content: [{ type: 'text' as const, text: 'First' }] },
      },
      { type: 'user' as const, message: { content: [{ type: 'text' as const, text: 'ok' }] } },
      {
        type: 'assistant' as const,
        message: { content: [{ type: 'text' as const, text: 'Second' }] },
      },
    ]
    const result = extractPartialResult(messages as any)
    expect(result).toBe('Second')
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

  it('returns undefined for undefined message property', () => {
    const msg = { type: 'assistant' as const, message: undefined }
    const result = getLastToolUseName(msg as any)
    expect(result).toBeUndefined()
  })

  it('handles undefined content array', () => {
    const msg = { type: 'assistant' as const, message: {} }
    const result = getLastToolUseName(msg as any)
    expect(result).toBeUndefined()
  })
})
