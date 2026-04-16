/**
 * OpenAI-compatible API client adapter.
 *
 * This module provides an OpenAI API client that presents the same interface
 * as the Anthropic SDK's `beta.messages` API. It handles:
 * - Message format conversion (Anthropic <-> OpenAI)
 * - Streaming response conversion
 * - Tool/function calling support
 * - System prompt handling
 *
 * Configuration via environment variables:
 * - OPENAI_API_KEY: Required. Your OpenAI API key
 * - OPENAI_API_BASE or OPENAI_BASE_URL: Optional. Custom API base URL
 *   (for Ollama, vLLM, or other OpenAI-compatible endpoints)
 */
import { randomUUID } from 'crypto'

// Types for the OpenAI-compatible adapter
export interface OpenAICompatibleClientOptions {
  apiKey?: string
  maxRetries?: number
  model?: string
  fetchOverride?: typeof fetch
  source?: string
}

// -- OpenAI API types (minimal subset we need)

interface OpenAIMessage {
  role: string
  content?: string | Array<{ type: string; text?: string; image_url?: object }>
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object
  }
}

interface OpenAIChatCompletionParams {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
  tools?: OpenAITool[]
  tool_choice?: string | { type: 'function'; function: { name: string } }
  [key: string]: unknown
}

interface OpenAIChatCompletionChoice {
  index: number
  message?: {
    role: string
    content: string | null
    tool_calls?: Array<{
      id: string
      type: string
      function: { name: string; arguments: string }
    }>
    refusal?: string | null
  }
  delta?: {
    role?: string
    content?: string | null
    tool_calls?: Array<{
      index: number
      id?: string
      type?: string
      function?: { name?: string; arguments?: string }
    }>
    refusal?: string | null
  }
  finish_reason?: string | null
}

interface OpenAIChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: OpenAIChatCompletionChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  system_fingerprint?: string
}

// -- Anthropic-compatible types (what the rest of the codebase expects)

interface AnthropicContentBlock {
  type: string
  text?: string
  input?: unknown
  name?: string
  id?: string
  usage?: unknown
  thinking?: string
  signature?: string
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface AnthropicMessage {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: AnthropicUsage
}

interface AnthropicStreamEvent {
  type: string
  message?: {
    id: string
    type: string
    role: string
    content: AnthropicContentBlock[]
    model: string
    stop_reason: string | null
    stop_sequence: string | null
    usage: AnthropicUsage
  }
  delta?: {
    type: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string
    stop_sequence?: string
  }
  index?: number
  content_block?: AnthropicContentBlock
}

// -- Helper: Convert Anthropic messages to OpenAI format

/**
 * Convert Anthropic-format messages to OpenAI chat completion format.
 *
 * Anthropic format:
 *   { role: "user", content: [{ type: "text", text: "..." }, ...] }
 *   { role: "assistant", content: [{ type: "text", text: "..." }, { type: "tool_use", ... }] }
 *   { role: "user", content: [{ type: "tool_result", ... }] }
 *
 * OpenAI format:
 *   { role: "user", content: "..." }
 *   { role: "assistant", content: "...", tool_calls: [...] }
 *   { role: "tool", tool_call_id: "...", content: "..." }
 */
function convertAnthropicMessageToOpenAI(
  msg: {
    role: string
    content: unknown[] | string
  },
  index: number,
  allMessages: Array<{ role: string; content: unknown[] | string }>,
): OpenAIMessage[] {
  const role = msg.role

  if (role === 'system') {
    // System messages are handled separately, but include if passed in messages
    return [
      {
        role: 'system',
        content: extractTextContent(msg.content),
      },
    ]
  }

  if (role === 'user') {
    if (typeof msg.content === 'string') {
      return [{ role: 'user', content: msg.content }]
    }

    // Process content blocks
    const textParts: string[] = []
    for (const block of msg.content as Array<{
      type: string
      text?: string
      source?: { data?: string; media_type?: string; type?: string }
      cache_control?: { type: string }
    }>) {
      if (block.type === 'text') {
        textParts.push(block.text ?? '')
      }
      // Note: Image/document blocks would need special handling
      // For now, we extract text and note other types
    }

    return [
      {
        role: 'user',
        content: textParts.join('\n') || '(empty message)',
      },
    ]
  }

  if (role === 'assistant') {
    if (typeof msg.content === 'string') {
      return [{ role: 'assistant', content: msg.content }]
    }

    const textParts: string[] = []
    const toolCalls: Array<{
      id: string
      type: string
      function: { name: string; arguments: string }
    }> = []

    for (const block of msg.content as Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      id?: string
      thinking?: string
      signature?: string
      cache_control?: { type: string }
    }>) {
      if (block.type === 'text') {
        textParts.push(block.text ?? '')
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? `tool_${index}`,
          type: 'function',
          function: {
            name: block.name ?? 'unknown',
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      } else if (block.type === 'thinking') {
        // OpenAI doesn't have thinking blocks, include as text
        if (block.thinking) {
          textParts.push(`[Thinking] ${block.thinking}`)
        }
      }
    }

    const result: OpenAIMessage = {
      role: 'assistant',
      ...(textParts.length > 0 && { content: textParts.join('\n') }),
    }
    if (toolCalls.length > 0) {
      result.tool_calls = toolCalls
    }
    return [result]
  }

  if (role === 'tool' || role === 'tool_result') {
    // Anthropic tool_result blocks are in user messages
    // Convert to OpenAI tool response format
    if (typeof msg.content === 'string') {
      return [
        {
          role: 'tool',
          tool_call_id: `tool_${index}`,
          content: msg.content,
        },
      ]
    }

    const results: OpenAIMessage[] = []
    for (const block of msg.content as Array<{
      type: string
      tool_use_id?: string
      content?: Array<{ type: string; text?: string }> | string
      is_error?: boolean
      cache_control?: { type: string }
    }>) {
      if (block.type === 'tool_result') {
        let contentText = ''
        if (typeof block.content === 'string') {
          contentText = block.content
        } else if (Array.isArray(block.content)) {
          contentText = block.content
            .map((b) => {
              if (b.type === 'text') return b.text ?? ''
              if (b.type === 'image') return '[image]'
              return ''
            })
            .filter(Boolean)
            .join('\n')
        }
        if (block.is_error) {
          contentText = `Error: ${contentText}`
        }
        results.push({
          role: 'tool',
          tool_call_id: block.tool_use_id ?? `tool_${index}`,
          content: contentText || '(empty result)',
        })
      }
    }
    return results.length > 0 ? results : []
  }

  // Fallback for unknown roles
  return [
    {
      role: 'user',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    },
  ]
}

/**
 * Extract plain text from Anthropic content (string or array of blocks).
 */
function extractTextContent(
  content: string | unknown[],
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object' && 'text' in block) {
        return (block as { text?: string }).text ?? ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Convert the full message list from Anthropic format to OpenAI format.
 * Handles system message extraction and message conversion.
 */
function convertMessagesToOpenAI(
  messages: Array<{ role: string; content: unknown[] | string }>,
  systemParam?: string | Array<{ type: string; text: string; cache_control?: { type: string } }>,
): {
  systemMessage: string
  openaiMessages: OpenAIMessage[]
} {
  // Extract system messages
  let systemText = ''
  if (systemParam) {
    systemText = extractTextContent(
      typeof systemParam === 'string'
        ? systemParam
        : (systemParam as Array<{ type: string; text: string }>),
    )
  }

  // Also check for system role messages in the array
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')
  const systemMessages = messages.filter((m) => m.role === 'system')
  if (systemMessages.length > 0) {
    const additionalSystem = systemMessages
      .map((m) => extractTextContent(m.content))
      .filter(Boolean)
      .join('\n')
    if (additionalSystem) {
      systemText = systemText ? `${systemText}\n${additionalSystem}` : additionalSystem
    }
  }

  // Convert remaining messages
  const openaiMessages: OpenAIMessage[] = []
  for (let i = 0; i < nonSystemMessages.length; i++) {
    const msg = nonSystemMessages[i]
    const converted = convertAnthropicMessageToOpenAI(msg, i, nonSystemMessages)
    openaiMessages.push(...converted)
  }

  return { systemMessage: systemText, openaiMessages }
}

/**
 * Convert Anthropic-style tools to OpenAI function calling format.
 */
function convertToolsToOpenAI(
  tools?: Array<{
    name: string
    description: string
    input_schema: { type: string; properties?: object; required?: string[] }
  }>,
): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

/**
 * Convert Anthropic tool_choice to OpenAI tool_choice format.
 */
function convertToolChoice(
  toolChoice?:
    | 'auto'
    | 'any'
    | 'tool'
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'tool'; name: string },
): string | { type: 'function'; function: { name: string } } | undefined {
  if (!toolChoice) return undefined

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto') return 'auto'
    if (toolChoice === 'any') return 'required'
    if (toolChoice === 'tool') return 'required'
    return 'auto'
  }

  if (toolChoice.type === 'auto') return 'auto'
  if (toolChoice.type === 'any') return 'required'
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: { name: toolChoice.name },
    }
  }
  return 'auto'
}

/**
 * Convert OpenAI response to Anthropic message format.
 */
function convertResponseToAnthropic(
  response: OpenAIChatCompletionResponse,
): AnthropicMessage {
  const choice = response.choices[0]
  const message = choice.message
  const content: AnthropicContentBlock[] = []

  if (message) {
    // Text content
    if (message.content && message.content !== 'null') {
      content.push({
        type: 'text',
        text: message.content,
      })
    }

    // Tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        })
      }
    }
  }

  // Ensure there's at least one content block
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  let stopReason: string | null = choice.finish_reason ?? null
  if (stopReason === 'stop') stopReason = 'end_turn'
  else if (stopReason === 'tool_calls') stopReason = 'tool_use'
  else if (stopReason === 'length') stopReason = 'max_tokens'
  else if (stopReason === 'content_filter') stopReason = 'end_turn'

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    content,
    model: response.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  }
}

/**
 * Generate a stream event ID.
 */
function makeEventId(): string {
  return `evt_${randomUUID().slice(0, 12)}`
}

// -- The OpenAI-compatible client class

/**
 * OpenAI-compatible client that presents an Anthropic-like interface.
 *
 * Usage:
 * ```ts
 * const client = createOpenAICompatibleClient({ apiKey: '...', model: 'gpt-4o' })
 * const stream = await client.beta.messages.create({ ...params, stream: true })
 * for await (const event of stream) {
 *   // Anthropic-style stream events
 * }
 * ```
 */
export function createOpenAICompatibleClient(options: OpenAICompatibleClientOptions) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || ''
  const baseURL =
    process.env.OPENAI_API_BASE ||
    process.env.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'

  // Build the beta.messages interface
  const beta = {
    messages: {
      /**
       * Create a chat completion (streaming or non-streaming).
       * Accepts Anthropic-style parameters and converts to OpenAI format.
       */
      create: async (
        params: {
          model: string
          messages: Array<{ role: string; content: unknown[] | string }>
          system?: string | Array<{ type: string; text: string }>
          tools?: Array<{
            name: string
            description: string
            input_schema: { type: string; properties?: object; required?: string[] }
          }>
          tool_choice?: unknown
          max_tokens: number
          temperature?: number
          stream?: boolean
          [key: string]: unknown
        },
        requestOptions?: {
          signal?: AbortSignal
          timeout?: number
          headers?: Record<string, string>
        },
      ) => {
        // Convert parameters
        const { systemMessage, openaiMessages } = convertMessagesToOpenAI(
          params.messages,
          params.system,
        )

        const openaiParams: OpenAIChatCompletionParams = {
          model: params.model,
          messages: openaiMessages,
          max_tokens: params.max_tokens,
          stream: params.stream ?? false,
        }

        // Add system message
        if (systemMessage) {
          // Prepend system message if it's not already in the messages
          if (!openaiMessages.some((m) => m.role === 'system')) {
            openaiParams.messages = [
              { role: 'system', content: systemMessage },
              ...openaiParams.messages,
            ]
          }
        }

        // Add temperature if specified
        if (params.temperature !== undefined) {
          openaiParams.temperature = params.temperature
        }

        // Add tools
        if (params.tools) {
          openaiParams.tools = convertToolsToOpenAI(params.tools)
        }

        // Add tool choice
        if (params.tool_choice) {
          openaiParams.tool_choice = convertToolChoice(
            params.tool_choice as Parameters<typeof convertToolChoice>[0],
          )
        }

        // Pass through any extra parameters (top_p, presence_penalty, etc.)
        const passthroughKeys = [
          'top_p',
          'presence_penalty',
          'frequency_penalty',
          'seed',
          'response_format',
          'stop',
          'logit_bias',
          'parallel_tool_calls',
          'extra_body',
        ]
        for (const key of passthroughKeys) {
          if (key in params && params[key] !== undefined) {
            // @ts-expect-error dynamic key assignment
            openaiParams[key] = params[key]
          }
        }

        const fetchFn = options.fetchOverride ?? globalThis.fetch
        const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(requestOptions?.headers ?? {}),
        }

        // Non-streaming request
        if (!params.stream) {
          const response = await fetchFn(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(openaiParams),
            signal: requestOptions?.signal,
            ...(requestOptions?.timeout
              ? { signal: createTimeoutSignal(requestOptions.timeout, requestOptions?.signal) }
              : {}),
          })

          if (!response.ok) {
            const errorText = await response.text().catch(() => '')
            throw new Error(
              `OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`,
            )
          }

          const data = (await response.json()) as OpenAIChatCompletionResponse
          const anthropicResponse = convertResponseToAnthropic(data)

          // Create a stream-like object that returns the response for non-streaming
          // This matches how the Anthropic SDK works with .withResponse()
          return {
            ...anthropicResponse,
            // Simulate a stream for compatibility - yields just the final message
            [Symbol.asyncIterator]: async function* () {
              // Message start event
              yield {
                type: 'message_start',
                message: {
                  ...anthropicResponse,
                  content: [],
                },
              } as AnthropicStreamEvent

              // Content block start for each block
              for (let i = 0; i < anthropicResponse.content.length; i++) {
                yield {
                  type: 'content_block_start',
                  index: i,
                  content_block: anthropicResponse.content[i],
                } as AnthropicStreamEvent

                // For text blocks, yield deltas
                const block = anthropicResponse.content[i]
                if (block.type === 'text' && block.text) {
                  yield {
                    type: 'content_block_delta',
                    index: i,
                    delta: {
                      type: 'text_delta',
                      text: block.text,
                    },
                  } as AnthropicStreamEvent
                }

                // Content block stop
                yield {
                  type: 'content_block_stop',
                  index: i,
                } as AnthropicStreamEvent
              }

              // Message delta with stop reason
              yield {
                type: 'message_delta',
                delta: {
                  stop_reason: anthropicResponse.stop_reason,
                  stop_sequence: anthropicResponse.stop_sequence,
                },
                usage: { output_tokens: anthropicResponse.usage.output_tokens },
              } as AnthropicStreamEvent

              // Message stop
              yield {
                type: 'message_stop',
              } as AnthropicStreamEvent
            },
          }
        }

        // Streaming request
        const fetchResponse = await fetchFn(url, {
          method: 'POST',
          headers: {
            ...headers,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ ...openaiParams, stream: true }),
          signal: requestOptions?.signal,
        })

        if (!fetchResponse.ok) {
          const errorText = await fetchResponse.text().catch(() => '')
          throw new Error(
            `OpenAI API error ${fetchResponse.status}: ${errorText.slice(0, 500)}`,
          )
        }

        // Create the streaming response object
        const messageId = `msg_${randomUUID().slice(0, 24)}`
        let contentBlockIndex = 0

        // Track tool call state across chunks
        const toolCallState: Map<
          number,
          { id: string; name: string; arguments: string }
        > = new Map()

        return {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          [Symbol.asyncIterator]: async function* () {
            if (!fetchResponse.body) {
              throw new Error('Response body is null for streaming request')
            }

            const reader = fetchResponse.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let hasEmittedMessageStart = false
            let hasEmittedUsage = false

            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break

                buffer += decoder.decode(value, { stream: true })

                // Process complete lines from buffer
                const lines = buffer.split('\n')
                buffer = lines.pop() ?? '' // Keep incomplete line in buffer

                for (const line of lines) {
                  const trimmed = line.trim()
                  if (!trimmed || trimmed.startsWith(':')) continue
                  if (!trimmed.startsWith('data: ')) continue

                  const data = trimmed.slice(6)
                  if (data === '[DONE]') continue

                  let chunk: OpenAIChatCompletionResponse
                  try {
                    chunk = JSON.parse(data)
                  } catch {
                    continue
                  }

                  const choice = chunk.choices?.[0]
                  if (!choice) continue

                  // Emit message_start on first chunk
                  if (!hasEmittedMessageStart) {
                    hasEmittedMessageStart = true
                    yield {
                      type: 'message_start',
                      message: {
                        id: messageId,
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: chunk.model ?? params.model,
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: 0, output_tokens: 0 },
                      },
                    } as AnthropicStreamEvent
                  }

                  const delta = choice.delta

                  // Handle text content
                  if (delta?.content && delta.content !== 'null' && delta.content !== '') {
                    // Ensure we have a content block for text
                    let textBlockIndex = -1
                    for (let i = 0; i < contentBlockIndex; i++) {
                      // Look for existing text block (simplified: just use index 0)
                      if (i === 0) textBlockIndex = 0
                    }
                    if (textBlockIndex === -1 && contentBlockIndex === 0) {
                      // First text content - emit content_block_start
                      yield {
                        type: 'content_block_start',
                        index: 0,
                        content_block: {
                          type: 'text',
                          text: '',
                        },
                      } as AnthropicStreamEvent
                      contentBlockIndex = 1
                      textBlockIndex = 0
                    }

                    yield {
                      type: 'content_block_delta',
                      index: textBlockIndex >= 0 ? textBlockIndex : 0,
                      delta: {
                        type: 'text_delta',
                        text: delta.content,
                      },
                    } as AnthropicStreamEvent
                  }

                  // Handle tool calls
                  if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index ?? 0
                      let state = toolCallState.get(idx)

                      if (!state) {
                        // New tool call
                        state = {
                          id: tc.id ?? `tool_call_${idx}_${randomUUID().slice(0, 8)}`,
                          name: tc.function?.name ?? '',
                          arguments: tc.function?.arguments ?? '',
                        }
                        toolCallState.set(idx, state)

                        // Emit content_block_start for tool_use
                        const toolBlockIdx = contentBlockIndex++
                        yield {
                          type: 'content_block_start',
                          index: toolBlockIdx,
                          content_block: {
                            type: 'tool_use',
                            id: state.id,
                            name: state.name,
                            input: {},
                          },
                        } as AnthropicStreamEvent
                      } else {
                        // Accumulate arguments
                        if (tc.function?.arguments) {
                          state.arguments += tc.function.arguments
                        }
                      }

                      // Emit input_json_delta
                      if (tc.function?.arguments) {
                        const toolBlockIdx = toolCallState.size - 1
                        yield {
                          type: 'content_block_delta',
                          index: toolBlockIdx >= 0 ? toolBlockIdx : contentBlockIndex - 1,
                          delta: {
                            type: 'input_json_delta',
                            partial_json: tc.function.arguments,
                          },
                        } as AnthropicStreamEvent
                      }
                    }
                  }

                  // Handle finish_reason (message_delta + message_stop)
                  if (choice.finish_reason) {
                    // Close any open tool_use blocks
                    for (const [idx, state] of toolCallState) {
                      yield {
                        type: 'content_block_stop',
                        index: idx,
                      } as AnthropicStreamEvent
                    }

                    let stopReason = choice.finish_reason
                    if (stopReason === 'stop') stopReason = 'end_turn'
                    else if (stopReason === 'tool_calls') stopReason = 'tool_use'
                    else if (stopReason === 'length') stopReason = 'max_tokens'
                    else if (stopReason === 'content_filter') stopReason = 'end_turn'

                    // Emit usage
                    if (chunk.usage && !hasEmittedUsage) {
                      hasEmittedUsage = true
                    }

                    yield {
                      type: 'message_delta',
                      delta: {
                        stop_reason: stopReason as string | null,
                        stop_sequence: null,
                      },
                      usage: {
                        output_tokens: chunk.usage?.completion_tokens ?? 0,
                      },
                    } as AnthropicStreamEvent

                    yield {
                      type: 'message_stop',
                    } as AnthropicStreamEvent
                  }
                }
              }
            } finally {
              reader.releaseLock()
            }
          },
        }
      },
    },
  }

  return { beta }
}

/**
 * Create a combined AbortSignal that fires when either the original signal
 * is aborted or the timeout elapses.
 */
function createTimeoutSignal(
  timeoutMs: number,
  originalSignal?: AbortSignal,
): AbortSignal {
  const controller = new AbortController()

  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('Request timeout', 'TimeoutError'))
  }, timeoutMs)

  if (originalSignal) {
    if (originalSignal.aborted) {
      clearTimeout(timeoutId)
      controller.abort(originalSignal.reason)
      return originalSignal
    }
    originalSignal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeoutId)
        controller.abort(originalSignal.reason)
      },
      { once: true },
    )
  }

  return controller.signal
}
