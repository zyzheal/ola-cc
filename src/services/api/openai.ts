/**
 * OpenAI-compatible API client adapter.
 *
 * This module provides an OpenAI API client that presents the same interface
 * as the Anthropic SDK's `beta.messages` API. It handles:
 * - Message format conversion (Anthropic <-> OpenAI)
 * - Streaming response conversion
 * - Tool/function calling support
 * - System prompt handling
 * - Retry with exponential backoff for transient failures
 * - Model name mapping from Anthropic to OpenAI equivalents
 *
 * Configuration via environment variables:
 * - OPENAI_API_KEY: Required. Your OpenAI API key
 * - OPENAI_API_BASE or OPENAI_BASE_URL: Optional. Custom API base URL
 *   (for Ollama, vLLM, or other OpenAI-compatible endpoints)
 * - OPENAI_MODEL: Optional. Default OpenAI model name to use when an
 *   Anthropic model name is passed (e.g., "gpt-4o").
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

// -- Model name mapping: Anthropic -> OpenAI

/**
 * Default model mapping from Anthropic model names to OpenAI equivalents.
 * Users can override this by setting OPENAI_MODEL env var or passing
 * a model name directly that is already OpenAI-compatible.
 */
const ANTHROPIC_TO_OPENAI_MODEL_MAP: Record<string, string> = {
  // Claude 4 family
  'claude-sonnet-4-20250514': 'gpt-4o',
  'claude-opus-4-20250514': 'gpt-4o',
  'claude-opus-4-1-20250805': 'gpt-4o',
  // Claude 3.5 family
  'claude-sonnet-4-0-20250514': 'gpt-4o',
  'claude-3-5-sonnet-20241022': 'gpt-4o',
  'claude-3-5-sonnet-20240620': 'gpt-4o',
  'claude-3-5-haiku-20241022': 'gpt-4o-mini',
  // Claude 3 family
  'claude-3-opus-20240229': 'gpt-4o',
  'claude-3-sonnet-20240229': 'gpt-4o',
  'claude-3-haiku-20240307': 'gpt-4o-mini',
  // Legacy
  'claude-2.1': 'gpt-4o',
  'claude-2.0': 'gpt-4o',
  'claude-instant-1.2': 'gpt-4o-mini',
}

/**
 * Convert an Anthropic model name to its OpenAI equivalent.
 * If the model name is not recognized as an Anthropic model,
 * it is passed through verbatim (allowing users to specify
 * their own OpenAI model names directly).
 * Falls back to OPENAI_MODEL env var if set, otherwise returns as-is.
 */
function resolveModelName(anthropicModel: string): string {
  // Direct mapping lookup
  const mapped = ANTHROPIC_TO_OPENAI_MODEL_MAP[anthropicModel]
  if (mapped) return mapped

  // Prefix-based matching for models not in the exact map
  if (anthropicModel.startsWith('claude-')) {
    const fallback = process.env.OPENAI_MODEL
    if (fallback) return fallback
    // Default to gpt-4o for unknown Claude models
    return 'gpt-4o'
  }

  // Not an Anthropic model name — pass through verbatim
  return anthropicModel
}

// -- Retry logic with exponential backoff

/**
 * Check if an HTTP status code represents a retriable error.
 * Retries on: 429 (rate limit), 5xx (server errors), and 0 (network errors).
 */
function isRetriableError(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600) || status === 0
}

/**
 * Calculate delay for exponential backoff with jitter.
 * Uses the formula: min(base * 2^attempt + random_jitter, maxDelay)
 */
function calculateBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const base = Math.min(baseMs * Math.pow(2, attempt), maxMs)
  // Add random jitter (up to 25% of base) to avoid thundering herd
  const jitter = base * 0.25 * Math.random()
  return base + jitter
}

/**
 * HTTP error that carries the response status for retry decision making.
 */
class OpenAIHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'OpenAIHttpError'
    this.status = status
  }
}

/**
 * Execute a fetch call with retry and exponential backoff.
 * Honors the maxRetries option from the client configuration.
 * Retries on 429, 5xx, and network errors only.
 */
async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  maxRetries: number,
  signal?: AbortSignal,
): Promise<Response> {
  const baseDelay = 1000 // 1 second base
  const maxDelay = 30000 // 30 seconds cap

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn(url, init)

      if (response.ok) {
        return response
      }

      // For non-retriable errors (4xx except 429), fail immediately
      if (!isRetriableError(response.status)) {
        const errorText = await response.text().catch(() => '')
        throw new OpenAIHttpError(
          response.status,
          `OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`,
        )
      }

      // For retriable errors, buffer the error text for the last attempt
      const errorText = await response.text().catch(() => '')
      lastError = new OpenAIHttpError(
        response.status,
        `OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`,
      )

      if (attempt < maxRetries) {
        const delay = calculateBackoff(attempt, baseDelay, maxDelay)
        // Wait with abort signal support
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(resolve, delay)
          signal?.addEventListener('abort', () => {
            clearTimeout(timeoutId)
            reject(signal.reason)
          }, { once: true })
        })
      }
    } catch (err) {
      // Network errors (fetch throws) are retriable
      if (err instanceof OpenAIHttpError && !isRetriableError(err.status)) {
        throw err
      }

      lastError = err instanceof Error ? err : new Error(String(err))

      if (attempt < maxRetries) {
        const delay = calculateBackoff(attempt, baseDelay, maxDelay)
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(resolve, delay)
          signal?.addEventListener('abort', () => {
            clearTimeout(timeoutId)
            reject(signal.reason)
          }, { once: true })
        })
      }
    }
  }

  throw lastError || new Error('Request failed after retries')
}

// -- Helper: Safely parse JSON with fallback
function safeJsonParse(text: string, fallback: unknown = {}): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

// -- Helper: Log warnings (console.warn, safe if no logger available)
function warn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[OpenAI Client Warning] ${message}`)
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
    const imageParts: Array<{ type: string; image_url: { url: string; detail?: string } }> = []
    for (const block of msg.content as Array<{
      type: string
      text?: string
      source?: { data?: string; media_type?: string; type?: string }
      cache_control?: { type: string }
    }>) {
      // Warn about cache_control being dropped (OpenAI has no equivalent)
      if (block.cache_control) {
        warn(`cache_control on content block is not supported by OpenAI and will be ignored`)
      }
      if (block.type === 'text') {
        textParts.push(block.text ?? '')
      } else if (block.type === 'image') {
        // Handle image blocks — OpenAI supports image_url format
        if (block.source?.data && block.source?.media_type) {
          imageParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          })
        } else if (block.source?.type === 'url') {
          // External URL reference
          imageParts.push({
            type: 'image_url',
            image_url: { url: (block.source as { url?: string }).url ?? '' },
          })
        } else {
          warn(`Image block at user message index ${index} has no usable source — skipping`)
        }
      } else if (block.type === 'document' || block.type === 'tool_result') {
        // Documents and tool_results in user messages are noted but not converted
        warn(`Content block type "${block.type}" at user message index ${index} is not fully supported — extracting text only`)
      }
    }

    // Build content: if there are images, use multimodal array; otherwise use string
    if (imageParts.length > 0) {
      const multimodalContent: Array<{ type: string; text?: string; image_url?: object }> = []
      const joinedText = textParts.join('\n')
      if (joinedText) {
        multimodalContent.push({ type: 'text', text: joinedText })
      }
      multimodalContent.push(...imageParts)
      return [{ role: 'user', content: multimodalContent }]
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
          input: safeJsonParse(tc.function.arguments || '{}', {}) as Record<string, unknown>,
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

  // Validate API key upfront — fail fast rather than sending empty Authorization header
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'OpenAI API key is not set. Please set the OPENAI_API_KEY environment variable ' +
      'or provide apiKey in the client options.',
    )
  }

  // Resolve maxRetries (default to 0 for backward compatibility)
  const maxRetries = options.maxRetries ?? 0

  // Streaming timeout in milliseconds (default 5 minutes)
  const STREAMING_TIMEOUT_MS = 300_000

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

        // Map the model name from Anthropic to OpenAI format
        const resolvedModel = resolveModelName(params.model)

        const openaiParams: OpenAIChatCompletionParams = {
          model: resolvedModel,
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

        // Map Anthropic's stop_sequences to OpenAI's stop parameter
        if ('stop_sequences' in params && params.stop_sequences !== undefined && !('stop' in params)) {
          // @ts-expect-error dynamic key assignment
          openaiParams.stop = params.stop_sequences
        }

        const fetchFn = options.fetchOverride ?? globalThis.fetch
        const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(requestOptions?.headers ?? {}),
        }

        // Build the effective signal for this request
        const effectiveSignal = requestOptions?.timeout
          ? createTimeoutSignal(requestOptions.timeout, requestOptions?.signal)
          : requestOptions?.signal

        // Non-streaming request — use retry with exponential backoff
        if (!params.stream) {
          const response = await fetchWithRetry(
            fetchFn,
            url,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(openaiParams),
            },
            maxRetries,
            effectiveSignal,
          )

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

        // Streaming request — also uses retry for the initial fetch,
        // and adds a timeout to prevent SSE connections from hanging
        const streamingSignal = createTimeoutSignal(
          STREAMING_TIMEOUT_MS,
          requestOptions?.signal,
        )

        const fetchResponse = await fetchWithRetry(
          fetchFn,
          url,
          {
            method: 'POST',
            headers: {
              ...headers,
              Accept: 'text/event-stream',
            },
            body: JSON.stringify({ ...openaiParams, stream: true }),
          },
          maxRetries,
          streamingSignal,
        )

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
          model: resolvedModel,
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
                        model: chunk.model ?? resolvedModel,
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
