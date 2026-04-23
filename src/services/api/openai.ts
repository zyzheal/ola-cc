/**
 * OpenAI-compatible API client adapter.
 *
 * This module provides an OpenAI API client that presents the same interface
 * as the Anthropic SDK's `beta.messages` API. It handles:
 * - Message format conversion (Anthropic <-> OpenAI)
 * - Streaming response conversion
 * - Tool/function calling support
 * - System prompt handling (merged for optimal prefix caching)
 * - Retry with exponential backoff for transient failures
 * - Model name mapping from Anthropic to OpenAI equivalents
 * - Cache usage reporting for debugging
 *
 * Configuration via environment variables:
 * - OPENAI_API_KEY: Required. Your OpenAI API key
 * - OPENAI_API_BASE or OPENAI_BASE_URL: Optional. Custom API base URL
 *   (for Ollama, vLLM, or other OpenAI-compatible endpoints)
 * - OPENAI_MODEL: Optional. Default OpenAI model name to use when an
 *   Anthropic model name is passed (e.g., "gpt-4o").
 * - OPENAI_EXTRA_BODY: Optional. JSON string of extra params to merge into
 *   the request body. Used for backend-specific features like vLLM prefix
 *   caching configuration.
 *
 * Prompt caching:
 * OpenAI-compatible backends use automatic prefix caching (not Anthropic's
 * explicit cache_control). To maximize cache hit rates:
 * 1. All system prompt blocks are merged into a single system message,
 *    forming a stable prefix that backends can cache reliably.
 * 2. Message order is preserved across requests.
 * 3. For vLLM, set `enable_prefix_caching: true` in your server config
 *    and consider passing `extra_body` via OPENAI_EXTRA_BODY env var.
 * 4. Cache usage is logged to stderr when available in the response.
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

// -- Model name resolution

/**
 * Resolve the model name for OpenAI-compatible API calls.
 *
 * For OpenAI-compatible providers (DashScope, vLLM, Ollama, etc.),
 * the model string is passed through verbatim — no Anthropic-to-OpenAI
 * mapping is applied. The actual model is determined by:
 * 1. The session model from settings.json (e.g., "qwen3.6-plus")
 * 2. OPENAI_MODEL env var as override
 * 3. The model string as-is if neither applies
 */
function resolveModelName(model: string): string {
  // Prefer explicit OPENAI_MODEL override
  if (process.env.OPENAI_MODEL) return process.env.OPENAI_MODEL
  // Pass through verbatim for custom model names
  return model
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
      const response = await fetchFn(url, { ...init, signal })

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
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(resolve, delay)
          signal?.addEventListener('abort', () => {
            clearTimeout(timeoutId)
            reject(signal.reason)
          }, { once: true })
        })
      }
    } catch (err) {
      // If the signal was aborted, do NOT retry — propagate immediately
      if (signal?.aborted) {
        throw signal.reason
      }

      // Network errors (fetch throws) are retriable
      if (err instanceof OpenAIHttpError && !isRetriableError(err.status)) {
        throw err
      }

      // Check if this is an abort error (including timeout)
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
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
    const toolResults: OpenAIMessage[] = []
    for (const block of msg.content as Array<{
      type: string
      text?: string
      source?: { data?: string; media_type?: string; type?: string }
      tool_use_id?: string
      content?: Array<{ type: string; text?: string }> | string
      is_error?: boolean
      cache_control?: { type: string }
    }>) {
      // cache_control is intentionally dropped — OpenAI auto-caches based on
      // prefix matching, no explicit cache marker needed
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
      } else if (block.type === 'tool_result') {
        // Convert Anthropic tool_result to OpenAI tool response format
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
        if (contentText) {
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id ?? `tool_${index}`,
            content: contentText || '(empty result)',
          })
        }
      } else if (block.type === 'document') {
        // Documents in user messages are noted but not converted
        warn(`Content block type "${block.type}" at user message index ${index} is not fully supported — extracting text only`)
      }
    }

    // Build user message with non-tool_result content
    const userMessages: OpenAIMessage[] = []
    if (imageParts.length > 0) {
      const multimodalContent: Array<{ type: string; text?: string; image_url?: object }> = []
      const joinedText = textParts.join('\n')
      if (joinedText) {
        multimodalContent.push({ type: 'text', text: joinedText })
      }
      multimodalContent.push(...imageParts)
      userMessages.push({ role: 'user', content: multimodalContent })
    } else if (textParts.length > 0) {
      userMessages.push({ role: 'user', content: textParts.join('\n') })
    }

    // Return tool results first (OpenAI requires tool responses before next assistant message)
    // then the user message (if any non-tool content exists)
    return [...toolResults, ...userMessages]
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
 *
 * For optimal prefix caching on OpenAI-compatible backends, all system prompt
 * blocks are merged into a single consolidated system message. This ensures
 * the system prompt forms a stable, consistent prefix that backend caches
 * can reliably match across requests.
 */
function convertMessagesToOpenAI(
  messages: Array<{ role: string; content: unknown[] | string }>,
  systemParam?: string | Array<{ type: string; text: string; cache_control?: { type: string } }>,
): {
  systemMessage: string
  openaiMessages: OpenAIMessage[]
} {
  // Extract system messages — merge ALL system blocks into a single string
  // to maximize prefix cache hit rate. Multiple system messages fragment
  // the cache key, reducing the chance of cache hits.
  let systemText = ''
  if (systemParam) {
    systemText = extractTextContent(
      typeof systemParam === 'string'
        ? systemParam
        : (systemParam as Array<{ type: string; text: string }>),
    )
  }

  // Also check for system role messages in the array and merge them
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

  // Convert remaining messages (non-system)
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

// -- Helper: Parse extra body params from environment

/**
 * Parse OPENAI_EXTRA_BODY environment variable into an object.
 * Supports both JSON and JSON-like strings.
 * Used to pass backend-specific caching configuration (e.g., vLLM prefix caching).
 */
function parseExtraBodyEnv(): Record<string, unknown> {
  const envValue = process.env.OPENAI_EXTRA_BODY
  if (!envValue) return {}
  try {
    const parsed = JSON.parse(envValue)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
  } catch {
    warn(`Failed to parse OPENAI_EXTRA_BODY: invalid JSON`)
  }
  return {}
}

// -- Helper: Log cache usage from response (debug only)

/**
 * Log cache token usage from API response for debugging.
 * OpenAI-compatible backends may return cache_usage info in usage field.
 */
function logCacheUsage(response: OpenAIChatCompletionResponse): void {
  const usage = response.usage
  if (!usage) return

  const cacheDetails: string[] = []
  // OpenAI API returns these fields for prompt caching
  if ('prompt_tokens_details' in usage && usage.prompt_tokens_details) {
    const details = usage.prompt_tokens_details as { cached_tokens?: number }
    if (details.cached_tokens) {
      cacheDetails.push(`cached=${details.cached_tokens}`)
    }
  }
  // vLLM and other backends may use custom fields
  if ('cache_tokens' in usage) {
    cacheDetails.push(`cache_tokens=${(usage as any).cache_tokens}`)
  }
  if ('cached_tokens' in usage) {
    cacheDetails.push(`cached_tokens=${(usage as any).cached_tokens}`)
  }

  if (cacheDetails.length > 0) {
    console.error(
      `[OpenAI Cache] prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, ${cacheDetails.join(', ')}`,
    )
  }
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
 *
 * Prompt caching for OpenAI-compatible backends:
 * Unlike Anthropic's explicit cache_control, OpenAI-compatible backends use
 * automatic prefix caching. To maximize cache hit rates:
 * 1. System prompt is merged into a single stable prefix message
 * 2. OPENAI_EXTRA_BODY env var can pass backend-specific cache config
 *    (e.g., vLLM's prefix caching params)
 * 3. Message order is preserved for consistent cache keys
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

  // Parse extra body params from env for backend-specific caching config
  const parsedExtraBody = parseExtraBodyEnv()

  // Build the beta.messages interface
  const beta = {
    messages: {
      /**
       * Create a chat completion (streaming or non-streaming).
       * Accepts Anthropic-style parameters and converts to OpenAI format.
       *
       * Returns a Promise-like object with a .withResponse() method for
       * compatibility with the Anthropic SDK's APIPromise.
       */
      create: (
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

        // Merge env-level extra_body for backend-specific caching config
        // e.g., vLLM prefix caching params, custom model routing
        if (Object.keys(parsedExtraBody).length > 0) {
          const existingExtra = openaiParams.extra_body as Record<string, unknown> | undefined
          openaiParams.extra_body = { ...parsedExtraBody, ...existingExtra }
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

        // Internal async function that performs the actual request
        async function doCreate() {
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

            // Log cache usage for debugging (stderr only)
            logCacheUsage(data)

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
            { id: string; name: string; arguments: string; blockIdx: number }
          > = new Map()

          // Track all content block indices that were opened (text + tool_use)
          // so we can emit content_block_stop for each one at stream end
          const openedContentBlockIndices: Set<number> = new Set()

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
                        const blockIdx = contentBlockIndex
                        yield {
                          type: 'content_block_start',
                          index: blockIdx,
                          content_block: {
                            type: 'text',
                            text: '',
                          },
                        } as AnthropicStreamEvent
                        openedContentBlockIndices.add(blockIdx)
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
                      // DIAGNOSTIC: Log tool_calls received in delta
                      if (process.env.DEBUG_OPENAI_STREAM) {
                        console.error(`[OpenAI Stream] Received tool_calls delta:`, JSON.stringify(delta.tool_calls))
                      }
                      for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0
                        let state = toolCallState.get(idx)

                        if (!state) {
                          // New tool call
                          const toolBlockIdx = contentBlockIndex++
                          state = {
                            id: tc.id ?? `tool_call_${idx}_${randomUUID().slice(0, 8)}`,
                            name: tc.function?.name ?? '',
                            arguments: tc.function?.arguments ?? '',
                            blockIdx: toolBlockIdx,
                          }
                          toolCallState.set(idx, state)

                          // Emit content_block_start for tool_use
                          openedContentBlockIndices.add(toolBlockIdx)
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

                        // Emit input_json_delta with correct block index
                        if (tc.function?.arguments) {
                          yield {
                            type: 'content_block_delta',
                            index: state.blockIdx,
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
                      // DIAGNOSTIC: Log finish_reason and toolCallState
                      if (process.env.DEBUG_OPENAI_STREAM) {
                        console.error(`[OpenAI Stream] finish_reason: ${choice.finish_reason}, toolCallState size: ${toolCallState.size}`)
                      }
                      // Close all open content blocks (text + tool_use)
                      for (const blockIdx of openedContentBlockIndices) {
                        yield {
                          type: 'content_block_stop',
                          index: blockIdx,
                        } as AnthropicStreamEvent
                      }

                      let stopReason = choice.finish_reason
                      if (stopReason === 'stop') stopReason = 'end_turn'
                      else if (stopReason === 'tool_calls') stopReason = 'tool_use'
                      else if (stopReason === 'length') stopReason = 'max_tokens'
                      else if (stopReason === 'content_filter') stopReason = 'end_turn'

                      // CRITICAL FIX: If we received tool_calls in the stream,
                      // the stop_reason should be 'tool_use' regardless of finish_reason.
                      // Some OpenAI-compatible APIs may return finish_reason='stop' even
                      // when tool_calls were emitted in the deltas.
                      if (toolCallState.size > 0) {
                        stopReason = 'tool_use'
                        if (process.env.DEBUG_OPENAI_STREAM) {
                          console.error(`[OpenAI Stream] Override stop_reason to 'tool_use' due to ${toolCallState.size} tool_calls`)
                        }
                      }

                      // Emit usage
                      if (chunk.usage && !hasEmittedUsage) {
                        hasEmittedUsage = true
                        // Log cache usage for debugging (stderr only)
                        logCacheUsage(chunk)
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
        }

        // Return a Promise-like object that is both thenable and has .withResponse()
        // This matches the Anthropic SDK's APIPromise behavior
        const promise = doCreate()
        const promiseWithResponse = {
          then: (onfulfilled: any, onrejected: any) => promise.then(onfulfilled, onrejected),
          catch: (onrejected: any) => promise.catch(onrejected),
          finally: (onfinally: any) => promise.finally?.(onfinally),
          withResponse: async () => {
            const data = await promise
            return {
              data,
              response: new Response(),
              request_id: null,
            }
          },
        }
        return promiseWithResponse
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
