/**
 * Unit tests for OpenAI-compatible API adapter streaming tool call handling.
 *
 * Tests verify:
 * 1. Block index consistency (content_block_start and input_json_delta use same index)
 * 2. Multiple tool calls streaming (each tool call gets correct blockIdx)
 * 3. stop_reason override (finish_reason='stop' with tool_calls -> stop_reason='tool_use')
 * 4. Empty arguments edge case
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createOpenAICompatibleClient } from '../../src/services/api/openai.ts'
import type { AnthropicStreamEvent } from '../../src/services/api/openai.ts'

// Helper to create SSE-formatted response body
function createSSEBody(chunks: object[]): string {
  const lines = chunks.map(chunk => `data: ${JSON.stringify(chunk)}`)
  lines.push('data: [DONE]')
  return lines.join('\n')
}

// Helper to create mock fetch response
function createMockResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  })
}

// Helper to collect all streaming events
async function collectStreamEvents(
  client: ReturnType<typeof createOpenAICompatibleClient>,
  messages: any[],
): Promise<AnthropicStreamEvent[]> {
  const events: AnthropicStreamEvent[] = []

  // Create minimal request params
  const requestParams = {
    model: 'test-model',
    max_tokens: 1024,
    messages,
    stream: true,
  }

  // Get the stream iterator from the client
  // The client returns an object with beta.messages.create method
  const response = await client.beta.messages.create(requestParams as any)

  // Iterate through the async iterator
  for await (const event of response as AsyncIterable<AnthropicStreamEvent>) {
    events.push(event)
  }

  return events
}

describe('OpenAI Adapter Streaming Tool Calls', () => {
  let originalFetch: typeof fetch
  let mockFetchCalls: { url: string; options: RequestInit }[] = []

  beforeEach(() => {
    originalFetch = global.fetch
    mockFetchCalls = []
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  /**
   * Test 1: Single tool call streaming - verify block index consistency
   *
   * OpenAI sends tool_calls in deltas, we need to ensure:
   * - content_block_start.index matches input_json_delta.index
   */
  test('single tool call streaming maintains consistent block index', async () => {
    // Simulate OpenAI streaming response with tool call
    const chunks = [
      // Initial delta with tool call start
      {
        id: 'chatcmpl-test1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc123',
                  function: { name: 'bash', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      // Argument chunks
      {
        id: 'chatcmpl-test1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"com' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-test1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'mand":"ls"}' },
                },
              ],
            },
          },
        ],
      },
      // Final chunk with finish_reason (note: 'stop' not 'tool_calls')
      {
        id: 'chatcmpl-test1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            delta: {},
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    ]

    global.fetch = async (url: string, options: RequestInit) => {
      mockFetchCalls.push({ url, options: options })
      return createMockResponse(createSSEBody(chunks))
    }

    const client = createOpenAICompatibleClient({
      apiKey: 'test-key',
      baseURL: 'http://test.local/v1',
    })

    const events = await collectStreamEvents(client, [
      { role: 'user', content: 'test message' },
    ])

    // Find content_block_start for tool_use
    const toolBlockStart = events.find(
      e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use',
    )
    expect(toolBlockStart).toBeDefined()

    // Find all input_json_delta events
    const inputJsonDeltas = events.filter(
      e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta',
    )
    expect(inputJsonDeltas.length).toBeGreaterThan(0)

    // CRITICAL: All input_json_delta.index must match content_block_start.index
    const expectedBlockIdx = toolBlockStart!.index
    for (const deltaEvent of inputJsonDeltas) {
      expect(deltaEvent.index).toBe(expectedBlockIdx)
    }

    // Verify stop_reason is 'tool_use' (not 'end_turn')
    const messageDelta = events.find(e => e.type === 'message_delta')
    expect(messageDelta).toBeDefined()
    expect((messageDelta as any)?.delta?.stop_reason).toBe('tool_use')
  })

  /**
   * Test 2: Multiple tool calls streaming - verify each gets correct blockIdx
   */
  test('multiple tool calls streaming maintains correct indices for each', async () => {
    const chunks = [
      // First tool call (index 0)
      {
        id: 'chatcmpl-test2',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_tool1',
                  function: { name: 'read', arguments: '{"file":"a.ts"}' },
                },
              ],
            },
          },
        ],
      },
      // Second tool call (index 1)
      {
        id: 'chatcmpl-test2',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: 'call_tool2',
                  function: { name: 'bash', arguments: '{"command":"ls"}' },
                },
              ],
            },
          },
        ],
      },
      // Finish with stop (not tool_calls)
      {
        id: 'chatcmpl-test2',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            delta: {},
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    ]

    global.fetch = async (url: string, options: RequestInit) => {
      mockFetchCalls.push({ url, options: options })
      return createMockResponse(createSSEBody(chunks))
    }

    const client = createOpenAICompatibleClient({
      apiKey: 'test-key',
      baseURL: 'http://test.local/v1',
    })

    const events = await collectStreamEvents(client, [
      { role: 'user', content: 'test message' },
    ])

    // Find all tool_use content_block_start events
    const toolBlockStarts = events.filter(
      e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use',
    )
    expect(toolBlockStarts.length).toBe(2)

    // Get indices for each tool call
    const tool0StartIdx = toolBlockStarts.find(
      e => (e as any).content_block?.id === 'call_tool1',
    )?.index
    const tool1StartIdx = toolBlockStarts.find(
      e => (e as any).content_block?.id === 'call_tool2',
    )?.index

    expect(tool0StartIdx).toBeDefined()
    expect(tool1StartIdx).toBeDefined()
    expect(tool0StartIdx).not.toBe(tool1StartIdx) // Different indices

    // Find input_json_delta events for each tool
    const inputJsonDeltas = events.filter(
      e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta',
    )
    expect(inputJsonDeltas.length).toBe(2)

    // Verify each delta's index matches its corresponding content_block_start
    const tool0Deltas = inputJsonDeltas.filter(e => e.index === tool0StartIdx)
    const tool1Deltas = inputJsonDeltas.filter(e => e.index === tool1StartIdx)

    expect(tool0Deltas.length).toBe(1)
    expect(tool1Deltas.length).toBe(1)
  })

  /**
   * Test 3: stop_reason override - finish_reason='stop' with tool_calls
   */
  test('stop_reason override when tool_calls present', async () => {
    const chunks = [
      {
        id: 'chatcmpl-test3',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_test',
                  function: { name: 'bash', arguments: '{"command":"pwd"}' },
                },
              ],
            },
          },
        ],
      },
      // finish_reason is 'stop' but we have tool_calls
      {
        id: 'chatcmpl-test3',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            finish_reason: 'stop', // Should be overridden to 'tool_use'
            delta: {},
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    ]

    global.fetch = async (url: string, options: RequestInit) => {
      mockFetchCalls.push({ url, options: options })
      return createMockResponse(createSSEBody(chunks))
    }

    const client = createOpenAICompatibleClient({
      apiKey: 'test-key',
      baseURL: 'http://test.local/v1',
    })

    const events = await collectStreamEvents(client, [
      { role: 'user', content: 'test message' },
    ])

    const messageDelta = events.find(e => e.type === 'message_delta')
    expect(messageDelta).toBeDefined()

    // CRITICAL: stop_reason must be 'tool_use' not 'end_turn'
    const stopReason = (messageDelta as any)?.delta?.stop_reason
    expect(stopReason).toBe('tool_use')
    expect(stopReason).not.toBe('end_turn')
  })

  /**
   * Test 4: Empty arguments edge case
   */
  test('tool call with empty arguments handled correctly', async () => {
    const chunks = [
      {
        id: 'chatcmpl-test4',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_empty',
                  function: { name: 'noop', arguments: '' }, // Empty arguments
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-test4',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            delta: {},
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    ]

    global.fetch = async (url: string, options: RequestInit) => {
      mockFetchCalls.push({ url, options: options })
      return createMockResponse(createSSEBody(chunks))
    }

    const client = createOpenAICompatibleClient({
      apiKey: 'test-key',
      baseURL: 'http://test.local/v1',
    })

    const events = await collectStreamEvents(client, [
      { role: 'user', content: 'test message' },
    ])

    // Should have content_block_start for tool_use
    const toolBlockStart = events.find(
      e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use',
    )
    expect(toolBlockStart).toBeDefined()

    // Should have content_block_stop for the tool block
    const toolBlockStop = events.find(
      e => e.type === 'content_block_stop' && e.index === toolBlockStart?.index,
    )
    expect(toolBlockStop).toBeDefined()

    // Should not have input_json_delta events (empty arguments)
    const inputJsonDeltas = events.filter(
      e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta',
    )
    expect(inputJsonDeltas.length).toBe(0)

    // stop_reason should still be 'tool_use'
    const messageDelta = events.find(e => e.type === 'message_delta')
    expect((messageDelta as any)?.delta?.stop_reason).toBe('tool_use')
  })

  /**
   * Test 5: Text + tool_calls combination
   */
  test('text followed by tool calls maintains correct indices', async () => {
    const chunks = [
      // Text delta
      {
        id: 'chatcmpl-test5',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { content: 'Let me help you.' },
          },
        ],
      },
      // Tool call after text
      {
        id: 'chatcmpl-test5',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_after_text',
                  function: { name: 'bash', arguments: '{"command":"echo"}' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-test5',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            delta: {},
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    ]

    global.fetch = async (url: string, options: RequestInit) => {
      mockFetchCalls.push({ url, options: options })
      return createMockResponse(createSSEBody(chunks))
    }

    const client = createOpenAICompatibleClient({
      apiKey: 'test-key',
      baseURL: 'http://test.local/v1',
    })

    const events = await collectStreamEvents(client, [
      { role: 'user', content: 'test message' },
    ])

    // Find text block start (should be index 0)
    const textBlockStart = events.find(
      e => e.type === 'content_block_start' && e.content_block?.type === 'text',
    )
    expect(textBlockStart).toBeDefined()
    expect(textBlockStart?.index).toBe(0)

    // Find tool block start (should be index 1)
    const toolBlockStart = events.find(
      e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use',
    )
    expect(toolBlockStart).toBeDefined()
    expect(toolBlockStart?.index).toBe(1) // After text block

    // Verify input_json_delta uses correct index (1, not 0)
    const inputJsonDeltas = events.filter(
      e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta',
    )
    for (const delta of inputJsonDeltas) {
      expect(delta.index).toBe(1)
    }
  })

  /**
   * Test 6: finish_reason='tool_calls' (normal case, should not be overridden)
   */
  test('finish_reason=tool_calls mapped correctly without override', async () => {
    const chunks = [
      {
        id: 'chatcmpl-test6',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_normal',
                  function: { name: 'bash', arguments: '{"command":"ls"}' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-test6',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls', // Normal case
            delta: {},
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    ]

    global.fetch = async (url: string, options: RequestInit) => {
      mockFetchCalls.push({ url, options: options })
      return createMockResponse(createSSEBody(chunks))
    }

    const client = createOpenAICompatibleClient({
      apiKey: 'test-key',
      baseURL: 'http://test.local/v1',
    })

    const events = await collectStreamEvents(client, [
      { role: 'user', content: 'test message' },
    ])

    const messageDelta = events.find(e => e.type === 'message_delta')
    expect((messageDelta as any)?.delta?.stop_reason).toBe('tool_use')
  })
})