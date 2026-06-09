import { describe, test, expect } from 'bun:test'
import type { Message as MessageType, AssistantMessage } from '../../../types/message.js'
import { countToolUses, buildToolUseSummary, resolveTerminationReason } from '../agentToolUtilsPure.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeAssistantMessage(content: unknown[]): AssistantMessage {
  return {
    type: 'assistant',
    message: {
      content,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    },
  } as unknown as AssistantMessage
}

function makeAttachmentMessage(type: string): MessageType {
  return {
    type: 'attachment',
    attachment: { type },
  } as unknown as MessageType
}

// ── countToolUses tests ──────────────────────────────────────────────

describe('countToolUses', () => {
  test('counts tool_use blocks across multiple messages', () => {
    const messages: MessageType[] = [
      makeAssistantMessage([
        { type: 'tool_use', name: 'a', input: {} },
        { type: 'tool_use', name: 'b', input: {} },
      ]),
      makeAssistantMessage([
        { type: 'text', text: 'thinking...' },
        { type: 'tool_use', name: 'c', input: {} },
      ]),
    ]
    expect(countToolUses(messages)).toBe(3)
  })

  test('returns 0 for messages with no tool_use blocks', () => {
    const messages: MessageType[] = [
      makeAssistantMessage([{ type: 'text', text: 'hello' }]),
    ]
    expect(countToolUses(messages)).toBe(0)
  })

  test('skips messages with undefined message property', () => {
    const messages: MessageType[] = [
      { type: 'assistant', message: undefined } as unknown as MessageType,
      makeAssistantMessage([{ type: 'tool_use', name: 'a', input: {} }]),
    ]
    expect(countToolUses(messages)).toBe(1)
  })

  test('skips messages with non-array content', () => {
    const messages: MessageType[] = [
      {
        type: 'assistant',
        message: { content: 'not-an-array' },
      } as unknown as MessageType,
      makeAssistantMessage([{ type: 'tool_use', name: 'a', input: {} }]),
    ]
    expect(countToolUses(messages)).toBe(1)
  })

  test('skips non-assistant messages', () => {
    const messages: MessageType[] = [
      { type: 'user', message: { content: [] } } as unknown as MessageType,
      makeAssistantMessage([{ type: 'tool_use', name: 'a', input: {} }]),
    ]
    expect(countToolUses(messages)).toBe(1)
  })

  test('returns 0 for empty messages array', () => {
    expect(countToolUses([])).toBe(0)
  })
})

// ── buildToolUseSummary tests ────────────────────────────────────────

describe('buildToolUseSummary', () => {
  test('returns null when no assistant messages with tool_use exist', () => {
    const messages: MessageType[] = [
      makeAssistantMessage([{ type: 'text', text: 'hello' }]),
    ]
    expect(buildToolUseSummary(messages)).toBeNull()
  })

  test('returns null for empty messages', () => {
    expect(buildToolUseSummary([])).toBeNull()
  })

  test('builds summary with tool names and input keys', () => {
    const messages: MessageType[] = [
      makeAssistantMessage([
        {
          type: 'tool_use',
          name: 'edit_file',
          input: { path: '/src/foo.ts', old_string: 'a', new_string: 'b' },
        },
      ]),
    ]
    const result = buildToolUseSummary(messages)
    expect(result).toContain('Tool call trace')
    expect(result).toContain('edit_file(path, old_string, new_string)')
    expect(result).toContain('Total: 1 tool calls executed.')
  })

  test('handles tool_use with null input', () => {
    const messages: MessageType[] = [
      makeAssistantMessage([
        { type: 'tool_use', name: 'some_tool', input: null },
      ]),
    ]
    const result = buildToolUseSummary(messages)
    expect(result).toContain('some_tool')
    expect(result).not.toContain('(')
  })

  test('handles tool_use with undefined input', () => {
    const messages: MessageType[] = [
      makeAssistantMessage([
        { type: 'tool_use', name: 'another_tool' },
      ]),
    ]
    const result = buildToolUseSummary(messages)
    expect(result).toContain('another_tool')
    expect(result).not.toContain('(')
  })

  test('limits input keys to 5', () => {
    const messages: MessageType[] = [
      makeAssistantMessage([
        {
          type: 'tool_use',
          name: 'tool',
          input: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 },
        },
      ]),
    ]
    const result = buildToolUseSummary(messages)
    expect(result).toContain('tool(a, b, c, d, e)')
    expect(result).not.toContain('f')
  })

  test('numbers multiple tool calls', () => {
    const messages: MessageType[] = [
      makeAssistantMessage([
        { type: 'tool_use', name: 'read_file', input: { path: '/a.ts' } },
      ]),
      makeAssistantMessage([
        { type: 'tool_use', name: 'bash', input: { command: 'test' } },
      ]),
    ]
    const result = buildToolUseSummary(messages)
    expect(result).toContain('1. read_file')
    expect(result).toContain('2. bash')
    expect(result).toContain('Total: 2 tool calls executed.')
  })

  test('skips non-assistant messages', () => {
    const messages: MessageType[] = [
      { type: 'user', message: { content: [] } } as unknown as MessageType,
      makeAssistantMessage([
        { type: 'tool_use', name: 'a', input: {} },
      ]),
    ]
    const result = buildToolUseSummary(messages)
    expect(result).toContain('Total: 1 tool calls executed.')
  })
})

// ── resolveTerminationReason tests ───────────────────────────────────

describe('resolveTerminationReason', () => {
  test('explicit terminationReason takes priority', () => {
    const messages = [makeAttachmentMessage('max_tool_calls_reached')]
    expect(resolveTerminationReason(messages, true, 'timeout')).toBe('timeout')
  })

  test('hasBudgetAttachment → budget_exhausted even without fallback', () => {
    const messages = [makeAttachmentMessage('max_tool_calls_reached')]
    expect(resolveTerminationReason(messages, false)).toBe('budget_exhausted')
  })

  test('hasBudgetAttachment → budget_exhausted even with fallback', () => {
    const messages = [makeAttachmentMessage('max_tool_calls_reached')]
    expect(resolveTerminationReason(messages, true)).toBe('budget_exhausted')
  })

  test('usedFallback → cancelled when no budget attachment (aborted mid-turn)', () => {
    const messages: MessageType[] = []
    expect(resolveTerminationReason(messages, true)).toBe('cancelled')
  })

  test('default → completed when no signals', () => {
    const messages: MessageType[] = []
    expect(resolveTerminationReason(messages, false)).toBe('completed')
  })

  test('ignores non-max_tool_calls_reached attachments', () => {
    const messages = [makeAttachmentMessage('some_other_type')]
    expect(resolveTerminationReason(messages, false)).toBe('completed')
  })

  test('detects budget attachment among multiple messages', () => {
    const messages: MessageType[] = [
      makeAttachmentMessage('other'),
      makeAttachmentMessage('max_tool_calls_reached'),
      makeAssistantMessage([{ type: 'text', text: 'done' }]),
    ]
    expect(resolveTerminationReason(messages, false)).toBe('budget_exhausted')
  })
})
