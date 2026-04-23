/**
 * Unit tests for OpenAI-compatible Shim API adapter streaming tool call handling.
 *
 * Tests verify the same fixes as openaiStreaming.test.ts but for the Shim variant:
 * 1. Block index consistency
 * 2. Multiple tool calls streaming
 * 3. stop_reason override
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createOpenAICompatibleShimClient } from '../../src/services/api/openaiShim.ts'
import type { AnthropicStreamEvent } from '../../src/services/api/openaiShim.ts'

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
  client: ReturnType<typeof createOpenAICompatibleShimClient>,
  messages: any[],
): Promise<AnthropicStreamEvent[]> {
  const events: AnthropicStreamEvent[] = []

  const requestParams = {
    model: 'test-model',
    max_tokens: 1024,
    messages,
    stream: true,
  }

  const response = await client.beta.messages.create(requestParams as any)

  for await (const event of response as AsyncIterable<AnthropicStreamEvent>) {
    events.push(event)
  }

  return events
}

describe('OpenAI Shim Adapter Streaming Tool Calls', () => {
  let originalFetch: typeof fetch
  let mockFetchCalls: { url: string; options: RequestInit }[] = []

  beforeEach(() => {
    originalFetch = global.fetch
    mockFetchCalls = []
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  test('single tool call streaming maintains consistent block index', async () => {
    const chunks = [
      {
        id: 'chatcmpl-shim1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_shim_test',
                  function: { name: 'bash', arguments: '{"com' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-shim1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'mand":"pwd"}' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-shim1',
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

    const client = createOpenAICompatibleShimClient({
      apiKey: 'test-key',
      baseURL: 'http://test.local/v1',
    })

    const events = await collectStreamEvents(client, [
      { role: 'user', content: 'test message' },
    ])

    const toolBlockStart = events.find(
      e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use',
    )
    expect(toolBlockStart).toBeDefined()

    const inputJsonDeltas = events.filter(
      e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta',
    )
    expect(inputJsonDeltas.length).toBeGreaterThan(0)

    // CRITICAL: All indices must match
    const expectedBlockIdx = toolBlockStart!.index
    for (const deltaEvent of inputJsonDeltas) {
      expect(deltaEvent.index).toBe(expectedBlockIdx)
    }

    // Verify stop_reason override
    const messageDelta = events.find(e => e.type === 'message_delta')
    expect((messageDelta as any)?.delta?.stop_reason).toBe('tool_use')
  })

  test('multiple tool calls streaming maintains correct indices', async () => {
    const chunks = [
      {
        id: 'chatcmpl-shim2',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_shim_1',
                  function: { name: 'read', arguments: '{"file":"test.ts"}' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-shim2',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: 'call_shim_2',
                  function: { name: 'bash', arguments: '{"command":"ls"}' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-shim2',
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

    const client = createOpenAICompatibleShimClient({
      apiKey: 'test-key',
      baseURL: 'http://test.local/v1',
    })

    const events = await collectStreamEvents(client, [
      { role: 'user', content: 'test' },
    ])

    const toolBlockStarts = events.filter(
      e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use',
    )
    expect(toolBlockStarts.length).toBe(2)

    const idx0 = toolBlockStarts.find(
      e => (e as any).content_block?.id === 'call_shim_1',
    )?.index
    const idx1 = toolBlockStarts.find(
      e => (e as any).content_block?.id === 'call_shim_2',
    )?.index

    expect(idx0).toBeDefined()
    expect(idx1).toBeDefined()
    expect(idx0).not.toBe(idx1)

    const inputJsonDeltas = events.filter(
      e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta',
    )

    const deltas0 = inputJsonDeltas.filter(e => e.index === idx0)
    const deltas1 = inputJsonDeltas.filter(e => e.index === idx1)
    expect(deltas0.length).toBe(1)
    expect(deltas1.length).toBe(1)
  })

  test('stop_reason override when tool_calls present', async () => {
    const chunks = [
      {
        id: 'chatcmpl-shim3',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_override',
                  function: { name: 'bash', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl-shim3',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            finish_reason: 'stop', // Should be overridden
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

    const client = createOpenAICompatibleShimClient({
      apiKey: 'test-key',
      baseURL: 'http://test.local/v1',
    })

    const events = await collectStreamEvents(client, [
      { role: 'user', content: 'test' },
    ])

    const messageDelta = events.find(e => e.type === 'message_delta')
    const stopReason = (messageDelta as any)?.delta?.stop_reason
    expect(stopReason).toBe('tool_use')
    expect(stopReason).not.toBe('end_turn')
  })
})