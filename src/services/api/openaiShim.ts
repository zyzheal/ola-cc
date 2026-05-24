/**
 * Enhanced OpenAI-compatible API shim for ola-cc.
 *
 * Based on openai.ts with additional enhancements:
 * - JSON Schema sanitization (required is superset of properties)
 * - Tool argument normalization
 * - Sensible retry defaults (default 2 retries)
 * - Better error diagnostics
 *
 * Environment variables:
 * - OPENAI_API_KEY: Your API key (optional for local models)
 * - OPENAI_API_BASE or OPENAI_BASE_URL: Custom base URL
 * - OPENAI_MODEL: Default model override
 * - OPENAI_EXTRA_BODY: JSON string of extra params
 */
import { randomUUID } from 'crypto'
import { APIError, APIConnectionError, APIUserAbortError } from '@anthropic-ai/sdk'
import { logForDebugging } from '../../utils/debug.js'
import { sanitizeNestedSchema as sanitizeNestedSchemaBase, sanitizeSchemaForAPI as sanitizeSchemaForAPIBase } from './schemaSanitizer.js'

// Re-exports for local use (keeping original names for minimal diff)
const sanitizeNestedSchema = sanitizeNestedSchemaBase

// Wrapper that adds warning logging for schema issues
function sanitizeSchemaForOpenAI(schema: unknown): Record<string, unknown> {
  const result = sanitizeSchemaForAPIBase(schema)
  // Log warning if schema was missing critical fields (was originally handled inline)
  if (result.required && Array.isArray(result.required)) {
    const props = result.properties as Record<string, unknown>
    for (const key of result.required) {
      if (typeof key === 'string' && !(key in props)) {
        warn(`Schema has required field "${key}" not in properties — added as {type: 'string'}`)
      }
    }
  }
  return result
}

export interface OpenAICompatibleClientOptions {
  apiKey?: string
  maxRetries?: number
  model?: string
  fetchOverride?: typeof fetch
  source?: string
}

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
    prompt_tokens_details?: { cached_tokens?: number }
    cache_tokens?: number
    cached_tokens?: number
  }
  system_fingerprint?: string
}

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

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function safeJsonParse(text: string, fallback: unknown = {}): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function warn(message: string): void {
  console.warn(`[OpenAI Shim Warning] ${message}`)
}

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

// -- JSON Schema sanitizer (delegated to shared module)
// sanitizeNestedSchema and sanitizeSchemaForOpenAI are imported from schemaSanitizer.ts

// -- Message conversion

function convertAnthropicMessageToOpenAI(
  msg: { role: string; content: unknown[] | string },
  index: number,
  allMessages: Array<{ role: string; content: unknown[] | string }>,
): OpenAIMessage[] {
  const role = msg.role

  if (role === 'system') {
    return [{ role: 'system', content: extractTextContent(msg.content) }]
  }

  if (role === 'user') {
    if (typeof msg.content === 'string') {
      return [{ role: 'user', content: msg.content }]
    }

    const textParts: string[] = []
    const imageParts: Array<{ type: string; image_url: { url: string; detail?: string } }> = []
    const toolResults: OpenAIMessage[] = []

    for (const block of msg.content as Array<{
      type: string
      text?: string
      source?: { data?: string; media_type?: string; type?: string; url?: string }
      tool_use_id?: string
      content?: Array<{ type: string; text?: string }> | string
      is_error?: boolean
      cache_control?: { type: string }
    }>) {
      if (block.type === 'text') {
        textParts.push(block.text ?? '')
      } else if (block.type === 'image') {
        if (block.source?.data && block.source?.media_type) {
          imageParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          })
        } else if (block.source?.type === 'url' || block.source?.url) {
          imageParts.push({
            type: 'image_url',
            image_url: { url: block.source.url ?? '' },
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
            content: contentText,
          })
        }
      } else if (block.type === 'document') {
        warn(`Content block type "${block.type}" at user message index ${index} is not fully supported — extracting text only`)
      }
    }

    // Build user message with non-tool_result content
    const userMessages: OpenAIMessage[] = []
    if (imageParts.length > 0) {
      const multimodalContent: Array<{ type: string; text?: string; image_url?: object }> = []
      const joinedText = textParts.join('\n')
      if (joinedText) multimodalContent.push({ type: 'text', text: joinedText })
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
    const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = []

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
        if (block.thinking) {
          textParts.push(`[Thinking] ${block.thinking}`)
        }
      }
    }

    const result: OpenAIMessage = {
      role: 'assistant',
      ...(textParts.length > 0 && { content: textParts.join('\n') }),
    }
    if (toolCalls.length > 0) result.tool_calls = toolCalls
    return [result]
  }

  if (role === 'tool' || role === 'tool_result') {
    // These should have been handled in the user message branch above.
    // If we reach here as a top-level message, it's an edge case.
    if (typeof msg.content === 'string') {
      return [{ role: 'tool', tool_call_id: `tool_${index}`, content: msg.content }]
    }
    // Not expected in normal flow — tool_results are converted inside user messages
    return []
  }

  return [{
    role: 'user',
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  }]
}

function convertMessagesToOpenAI(
  messages: Array<{ role: string; content: unknown[] | string }>,
  systemParam?: string | Array<{ type: string; text: string }>,
): { systemMessage: string; openaiMessages: OpenAIMessage[] } {
  let systemText = ''
  if (systemParam) {
    systemText = extractTextContent(
      typeof systemParam === 'string' ? systemParam : (systemParam as Array<{ type: string; text: string }>),
    )
  }

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

  const openaiMessages: OpenAIMessage[] = []
  for (let i = 0; i < nonSystemMessages.length; i++) {
    const msg = nonSystemMessages[i]
    const converted = convertAnthropicMessageToOpenAI(msg, i, nonSystemMessages)
    openaiMessages.push(...converted)
  }

  return { systemMessage: systemText, openaiMessages }
}

// -- Tool conversion

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
      parameters: sanitizeSchemaForOpenAI(tool.input_schema),
    },
  }))
}

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
    if (toolChoice === 'any' || toolChoice === 'tool') return 'required'
    return 'auto'
  }

  if (toolChoice.type === 'auto') return 'auto'
  if (toolChoice.type === 'any') return 'required'
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } }
  }
  return 'auto'
}

// -- Retry with exponential backoff

function isRetriableError(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600) || status === 0
}

function calculateBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const base = Math.min(baseMs * Math.pow(2, attempt), maxMs)
  const jitter = base * 0.25 * Math.random()
  return base + jitter
}

class OpenAIHttpError extends APIError {
  constructor(status: number, message: string) {
    super(status, undefined, message, undefined)
    this.name = 'OpenAIHttpError'
  }
}

async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  maxRetries: number,
  signal?: AbortSignal,
): Promise<Response> {
  const baseDelay = 1000
  const maxDelay = 30000

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn(url, { ...init, signal })

      if (response.ok) return response

      if (!isRetriableError(response.status)) {
        const errorText = await response.text().catch(() => '')
        throw new OpenAIHttpError(
          response.status,
          `OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`,
        )
      }

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
      if (signal?.aborted) throw signal.reason

      if (err instanceof OpenAIHttpError && !isRetriableError(err.status)) throw err

      // Timeout → retriable connection error; user abort → propagate as abort
      if (err instanceof Error && err.name === 'TimeoutError') {
        lastError = new APIConnectionError({ message: err.message, cause: err })
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
        continue
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new APIUserAbortError({ message: err.message })
      }

      lastError = err instanceof OpenAIHttpError ? err : new OpenAIHttpError(0, err instanceof Error ? err.message : String(err))

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

  throw lastError || new OpenAIHttpError(0, 'Request failed after retries')
}

// -- Response conversion

function convertResponseToAnthropic(
  response: OpenAIChatCompletionResponse,
): AnthropicMessage {
  const choice = response.choices[0]
  const message = choice.message
  const content: AnthropicContentBlock[] = []

  if (message) {
    if (message.content && message.content !== 'null') {
      content.push({ type: 'text', text: message.content })
    }
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

  if (content.length === 0) content.push({ type: 'text', text: '' })

  let stopReason: string | null = choice.finish_reason ?? null
  if (stopReason === 'stop') stopReason = 'end_turn'
  else if (stopReason === 'tool_calls') stopReason = 'tool_use'
  else if (stopReason === 'length') stopReason = 'max_tokens'
  else if (stopReason === 'content_filter') stopReason = 'end_turn'

  // Extract cache-related fields from OpenAI response
  const { cacheReadInputTokens, cacheCreationInputTokens } = extractCacheTokens(response.usage)

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
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
    },
  }
}

// -- Cache token extraction

interface CacheTokenResult {
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/**
 * Extracts cache token counts from an OpenAI-compatible API usage object.
 *
 * Checks formats in priority order:
 * 1. Anthropic-style: cache_read_input_tokens / cache_creation_input_tokens (some proxies pass through)
 * 2. OpenAI: prompt_tokens_details.cached_tokens
 * 3. Top-level: cached_tokens
 * 4. Fallback: cache_tokens (some providers use this)
 *
 * Note: cacheCreationInputTokens is only extracted from Priority 1 because OpenAI's
 * native format does not expose cache creation tokens — creation is server-managed
 * and invisible to the client. If a provider returns Anthropic-style fields, those
 * take precedence.
 */
function extractCacheTokens(usage: unknown): CacheTokenResult {
  if (!usage || typeof usage !== 'object') {
    return { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  }

  let cacheReadInputTokens = 0
  let cacheCreationInputTokens = 0

  // Priority 1: Anthropic-style fields (some proxies pass through)
  if ('cache_read_input_tokens' in usage) {
    cacheReadInputTokens = (usage as Record<string, unknown>).cache_read_input_tokens as number ?? 0
  }
  if ('cache_creation_input_tokens' in usage) {
    cacheCreationInputTokens = (usage as Record<string, unknown>).cache_creation_input_tokens as number ?? 0
  }

  // Priority 2: OpenAI prompt_tokens_details.cached_tokens
  if (cacheReadInputTokens === 0 && 'prompt_tokens_details' in usage && usage.prompt_tokens_details) {
    const details = usage.prompt_tokens_details as { cached_tokens?: number }
    cacheReadInputTokens = details.cached_tokens ?? 0
  }

  // Priority 3: Top-level cached_tokens
  if (cacheReadInputTokens === 0 && 'cached_tokens' in usage) {
    cacheReadInputTokens = (usage as Record<string, unknown>).cached_tokens as number ?? 0
  }

  // Priority 4: cache_tokens (fallback for some providers)
  if (cacheReadInputTokens === 0 && 'cache_tokens' in usage) {
    cacheReadInputTokens = (usage as Record<string, unknown>).cache_tokens as number ?? 0
  }

  return { cacheReadInputTokens, cacheCreationInputTokens }
}

// -- Extra body parsing

function parseExtraBodyEnv(): Record<string, unknown> {
  const envValue = process.env.OPENAI_EXTRA_BODY
  if (!envValue) return {}
  try {
    const parsed = JSON.parse(envValue)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {
    warn(`Failed to parse OPENAI_EXTRA_BODY: invalid JSON`)
  }
  return {}
}

function logCacheUsage(response: OpenAIChatCompletionResponse): void {
  const usage = response.usage
  if (!usage) return

  const cacheDetails: string[] = []
  if ('prompt_tokens_details' in usage && usage.prompt_tokens_details) {
    const details = usage.prompt_tokens_details as { cached_tokens?: number }
    if (details.cached_tokens) cacheDetails.push(`cached=${details.cached_tokens}`)
  }
  if ('cache_tokens' in usage) cacheDetails.push(`cache_tokens=${usage.cache_tokens}`)
  if ('cached_tokens' in usage) cacheDetails.push(`cached_tokens=${usage.cached_tokens}`)

  if (cacheDetails.length > 0) {
    logForDebugging(
      `[OpenAI Shim Cache] prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, ${cacheDetails.join(', ')}`,
    )
  }
}

/**
 * Handle streaming response from a fetch response.
 * Extracted into a helper so both the initial stream and the retry path can use it.
 */
function doStreaming(
  fetchResponse: Response,
  resolvedModel: string,
  messageId: string,
): {
  id: string
  type: string
  role: string
  model: string
  content: unknown[]
  stop_reason: string | null
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number }
  [Symbol.asyncIterator]: () => AsyncGenerator<AnthropicStreamEvent>
} {
  let contentBlockIndex = 0
  const toolCallState: Map<number, { id: string; name: string; arguments: string; blockIdx: number }> = new Map()
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
      if (!fetchResponse.body) throw new OpenAIHttpError(500, 'Response body is null for streaming request')

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
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data: ')) continue

            const data = trimmed.slice(6)
            if (data === '[DONE]') continue

            let chunk: OpenAIChatCompletionResponse
            try { chunk = JSON.parse(data) } catch { continue }

            const choice = chunk.choices?.[0]
            if (!choice) continue

            if (!hasEmittedMessageStart) {
              hasEmittedMessageStart = true
              const { cacheReadInputTokens: chunkCacheRead } = extractCacheTokens(chunk.usage)
              yield { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', content: [], model: chunk.model ?? resolvedModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: chunkCacheRead, cache_creation_input_tokens: 0 } } } as AnthropicStreamEvent
            }

            const delta = choice.delta

            if (delta?.content && delta.content !== 'null' && delta.content !== '') {
              let textBlockIndex = -1
              if (contentBlockIndex > 0) textBlockIndex = 0
              if (textBlockIndex === -1 && contentBlockIndex === 0) {
                const blockIdx = contentBlockIndex
                yield { type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } } as AnthropicStreamEvent
                openedContentBlockIndices.add(blockIdx)
                contentBlockIndex = 1
                textBlockIndex = 0
              }
              yield { type: 'content_block_delta', index: textBlockIndex >= 0 ? textBlockIndex : 0, delta: { type: 'text_delta', text: delta.content } } as AnthropicStreamEvent
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                let state = toolCallState.get(idx)
                if (!state) {
                  const toolBlockIdx = contentBlockIndex++
                  state = { id: tc.id ?? `tool_call_${idx}_${randomUUID().slice(0, 8)}`, name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '', blockIdx: toolBlockIdx }
                  toolCallState.set(idx, state)
                  openedContentBlockIndices.add(toolBlockIdx)
                  yield { type: 'content_block_start', index: toolBlockIdx, content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} } } as AnthropicStreamEvent
                } else {
                  if (tc.function?.arguments) state.arguments += tc.function.arguments
                }
                if (tc.function?.arguments) {
                  yield { type: 'content_block_delta', index: state.blockIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } } as AnthropicStreamEvent
                }
              }
            }

            if (choice.finish_reason) {
              for (const blockIdx of openedContentBlockIndices) {
                yield { type: 'content_block_stop', index: blockIdx } as AnthropicStreamEvent
              }
              let stopReason = choice.finish_reason
              if (stopReason === 'stop') stopReason = 'end_turn'
              else if (stopReason === 'tool_calls') stopReason = 'tool_use'
              else if (stopReason === 'length') stopReason = 'max_tokens'
              else if (stopReason === 'content_filter') stopReason = 'end_turn'

              if (toolCallState.size > 0) {
                stopReason = 'tool_use'
              }

              if (chunk.usage && !hasEmittedUsage) {
                hasEmittedUsage = true
                logCacheUsage(chunk)
                const { cacheReadInputTokens, cacheCreationInputTokens } = extractCacheTokens(chunk.usage)
                yield { type: 'message_delta', delta: { stop_reason: stopReason as string | null, stop_sequence: null }, usage: { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0, cache_read_input_tokens: cacheReadInputTokens, cache_creation_input_tokens: cacheCreationInputTokens } } as AnthropicStreamEvent
              } else {
                yield { type: 'message_delta', delta: { stop_reason: stopReason as string | null, stop_sequence: null }, usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 } } as AnthropicStreamEvent
              }
              yield { type: 'message_stop' } as AnthropicStreamEvent
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
    },
  }
}

function makeEventId(): string {
  return `evt_${randomUUID().slice(0, 12)}`
}

// -- Helper: Estimate input tokens and clamp max_tokens

/**
 * Roughly estimate the number of input tokens from the message list.
 * Uses bytes-per-token heuristic. This is not exact but enough to
 * detect when we're close to the context window limit.
 */
function estimateInputTokens(messages: OpenAIMessage[]): number {
  let totalBytes = 0
  for (const msg of messages) {
    // Role overhead: each message role (~4 tokens = 16 bytes) adds formatting cost
    totalBytes += 16
    if (typeof msg.content === 'string') {
      totalBytes += new TextEncoder().encode(msg.content).length
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          totalBytes += new TextEncoder().encode(part.text).length
        }
      }
    }
  }
  return Math.ceil(totalBytes / 4)
}

/**
 * Check if an error is a max_tokens too large error and extract
 * the model's context limit and actual input token count.
 */
function parseMaxTokensError(errorText: string): {
  contextLimit: number
  inputTokens: number
} | null {
  // Primary pattern: OpenAI/DashScope format
  // "maximum context length is 135000 tokens... you requested 137500 tokens"
  // "maximum context length is X tokens and your request has Y input tokens"
  const contextMatch = errorText.match(/maximum\s+context\s+length\s+is\s+(\d+)/i)
  const inputMatch = errorText.match(/(?:has\s+|requested\s+)(\d+)\s+(?:input\s+)?tokens/i)
  if (contextMatch && inputMatch) {
    return {
      contextLimit: parseInt(contextMatch[1], 10),
      inputTokens: parseInt(inputMatch[1], 10),
    }
  }

  // Fallback: generic "X tokens > Y maximum" pattern (used by our own errors)
  const genericMatch = errorText.match(/(\d+)\s*tokens\s*>\s*(\d+)\s*maximum/i)
  if (genericMatch) {
    return {
      contextLimit: parseInt(genericMatch[2], 10),
      inputTokens: parseInt(genericMatch[1], 10),
    }
  }

  return null
}

/**
 * Build a stream-like response object from a non-streaming API response.
 */
function buildNonStreamingResponse(anthropicResponse: AnthropicMessage) {
  return {
    ...anthropicResponse,
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'message_start', message: { ...anthropicResponse, content: [] } } as AnthropicStreamEvent
      for (let i = 0; i < anthropicResponse.content.length; i++) {
        yield { type: 'content_block_start', index: i, content_block: anthropicResponse.content[i] } as AnthropicStreamEvent
        const block = anthropicResponse.content[i]
        if (block.type === 'text' && block.text) {
          yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } } as AnthropicStreamEvent
        }
        yield { type: 'content_block_stop', index: i } as AnthropicStreamEvent
      }
      yield { type: 'message_delta', delta: { stop_reason: anthropicResponse.stop_reason, stop_sequence: null }, usage: { input_tokens: anthropicResponse.usage.input_tokens, output_tokens: anthropicResponse.usage.output_tokens, cache_read_input_tokens: anthropicResponse.usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: anthropicResponse.usage.cache_creation_input_tokens ?? 0 } } as AnthropicStreamEvent
      yield { type: 'message_stop' } as AnthropicStreamEvent
    },
  }
}

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
      () => { clearTimeout(timeoutId); controller.abort(originalSignal.reason) },
      { once: true },
    )
  }

  return controller.signal
}

// -- Client entry point

export function createOpenAICompatibleShimClient(options: OpenAICompatibleClientOptions) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || ''
  const baseURL =
    process.env.OPENAI_API_BASE ||
    process.env.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'

  if (!apiKey || apiKey.trim() === '') {
    console.error(
      'Error: OpenAI API key is not set. Please set the OPENAI_API_KEY environment variable ' +
      'or configure it in your settings file.',
    )
    process.exit(1)
  }

  const maxRetries = options.maxRetries ?? 2
  const STREAMING_TIMEOUT_MS = 300_000
  const parsedExtraBody = parseExtraBodyEnv()

  const beta = {
    messages: {
      /**
       * OpenAI-compatible backends don't support Anthropic's countTokens API.
       * Return null so callers fall back to rough estimation instead of hitting
       * a 404 endpoint.
       */
      countTokens: async (params: {
        model: string
        messages: Array<{ role: string; content: unknown[] | string }>
        tools?: unknown[]
        betas?: string[]
        thinking?: { type: string; budget_tokens: number }
      }): Promise<{ input_tokens: number } | null> => {
        // OpenAI-compatible providers have no countTokens endpoint.
        // Return null so callers fall back to rough estimation instead
        // of treating an estimate as a precise count.
        return null
      },

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
        const { systemMessage, openaiMessages } = convertMessagesToOpenAI(
          params.messages,
          params.system,
        )

        const resolvedModel = resolveModelName(params.model)

        const openaiParams: OpenAIChatCompletionParams = {
          model: resolvedModel,
          messages: openaiMessages,
          max_tokens: params.max_tokens,
          stream: params.stream ?? false,
        }

        if (systemMessage) {
          if (!openaiMessages.some((m) => m.role === 'system')) {
            openaiParams.messages = [
              { role: 'system', content: systemMessage },
              ...openaiParams.messages,
            ]
          }
        }

        if (params.temperature !== undefined) openaiParams.temperature = params.temperature
        if (params.tools) openaiParams.tools = convertToolsToOpenAI(params.tools)
        if (params.tool_choice) {
          openaiParams.tool_choice = convertToolChoice(
            params.tool_choice as Parameters<typeof convertToolChoice>[0],
          )
        }

        for (const key of ['top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'response_format', 'stop', 'logit_bias', 'parallel_tool_calls']) {
          if (key in params && params[key] !== undefined) {
            // @ts-expect-error dynamic key
            openaiParams[key] = params[key]
          }
        }

        if (Object.keys(parsedExtraBody).length > 0) {
          const existingExtra = openaiParams.extra_body as Record<string, unknown> | undefined
          openaiParams.extra_body = { ...parsedExtraBody, ...existingExtra }
        }

        if ('stop_sequences' in params && params.stop_sequences !== undefined && !('stop' in params)) {
          // @ts-expect-error dynamic key
          openaiParams.stop = params.stop_sequences
        }

        const fetchFn = options.fetchOverride ?? globalThis.fetch
        const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(requestOptions?.headers ?? {}),
        }

        const effectiveSignal = requestOptions?.timeout
          ? createTimeoutSignal(requestOptions.timeout, requestOptions?.signal)
          : requestOptions?.signal

        async function doCreate() {
          // Estimate input tokens and clamp max_tokens to avoid context window overflow
          const estimatedInput = estimateInputTokens(openaiParams.messages)
          // Allow override via env var for providers with smaller context windows.
          // Falls back to 128K; will be corrected by API error if wrong.
          const rawLimit = process.env.OPENAI_CONTEXT_LIMIT
          const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : NaN
          const contextLimit = !rawLimit || isNaN(parsedLimit) || parsedLimit < 1000
            ? 128_000
            : parsedLimit
          let effectiveMaxTokens = openaiParams.max_tokens
          const available = contextLimit - estimatedInput
          if (effectiveMaxTokens > available && available > 0) {
            effectiveMaxTokens = Math.floor(available * 0.95) // 5% headroom
            logForDebugging?.(`[OpenAI Shim] Clamped max_tokens from ${openaiParams.max_tokens} to ${effectiveMaxTokens} (estimated input: ${estimatedInput})`)
          }

          const paramsToSend = { ...openaiParams, max_tokens: effectiveMaxTokens }

          if (!params.stream) {
            const response = await fetchWithRetry(
              fetchFn,
              url,
              { method: 'POST', headers, body: JSON.stringify(paramsToSend) },
              maxRetries,
              effectiveSignal,
            )

            if (!response.ok) {
              const errorText = await response.text().catch(() => '')
              // If max_tokens error, parse actual limits and retry once with corrected value
              const parsed = parseMaxTokensError(errorText)
              if (parsed && response.status === 400) {
                const retryMaxTokens = Math.floor((parsed.contextLimit - parsed.inputTokens) * 0.95)
                if (retryMaxTokens > 0) {
                  logForDebugging?.(`[OpenAI Shim] Retrying with corrected max_tokens: ${retryMaxTokens} (context: ${parsed.contextLimit}, input: ${parsed.inputTokens})`)
                  const retryResponse = await fetchWithRetry(
                    fetchFn,
                    url,
                    { method: 'POST', headers, body: JSON.stringify({ ...paramsToSend, max_tokens: retryMaxTokens }) },
                    1,
                    effectiveSignal,
                  )
                  if (retryResponse.ok) {
                    const data = (await retryResponse.json()) as OpenAIChatCompletionResponse
                    const anthropicResponse = convertResponseToAnthropic(data)
                    logCacheUsage(data)
                    return buildNonStreamingResponse(anthropicResponse)
                  }
                  const retryErrorText = await retryResponse.text().catch(() => '')
                  // If the retry also fails with a max_tokens error, return prompt-too-long
                  const retryParsed = parseMaxTokensError(retryErrorText)
                  if (retryParsed && retryResponse.status === 400) {
                    const overflow = retryParsed.inputTokens - retryParsed.contextLimit
                    throw new OpenAIHttpError(retryResponse.status, `Prompt is too long: ${retryParsed.inputTokens} tokens > ${retryParsed.contextLimit} maximum (${overflow > 0 ? overflow : 'unknown'} tokens over limit)`)
                  }
                  throw new OpenAIHttpError(retryResponse.status, `OpenAI API error ${retryResponse.status}: ${retryErrorText.slice(0, 500)}`)
                }
                // Input tokens exceed context limit — no room for any output.
                // Return a prompt-too-long error so the upper-layer compact
                // system recognizes this and triggers summarization.
                const overflow = parsed.inputTokens - parsed.contextLimit
                throw new OpenAIHttpError(response.status, `Prompt is too long: ${parsed.inputTokens} tokens > ${parsed.contextLimit} maximum (${overflow} tokens over limit)`)
              }
              throw new OpenAIHttpError(response.status, `OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`)
            }

            const data = (await response.json()) as OpenAIChatCompletionResponse
            const anthropicResponse = convertResponseToAnthropic(data)
            logCacheUsage(data)

            return buildNonStreamingResponse(anthropicResponse)
          }

          // Streaming mode - also uses adjusted max_tokens
          const streamingSignal = createTimeoutSignal(STREAMING_TIMEOUT_MS, requestOptions?.signal)
          const fetchResponse = await fetchWithRetry(
            fetchFn,
            url,
            { method: 'POST', headers: { ...headers, Accept: 'text/event-stream' }, body: JSON.stringify({ ...paramsToSend, stream: true }) },
            maxRetries,
            streamingSignal,
          )

          if (!fetchResponse.ok) {
            const errorText = await fetchResponse.text().catch(() => '')
            // If max_tokens error in streaming mode, retry with corrected value
            const parsed = parseMaxTokensError(errorText)
            if (parsed && fetchResponse.status === 400) {
              const retryMaxTokens = Math.floor((parsed.contextLimit - parsed.inputTokens) * 0.95)
              if (retryMaxTokens > 0) {
                logForDebugging?.(`[OpenAI Shim] Streaming retry with max_tokens: ${retryMaxTokens}`)
                const retryResponse = await fetchWithRetry(
                  fetchFn,
                  url,
                  { method: 'POST', headers: { ...headers, Accept: 'text/event-stream' }, body: JSON.stringify({ ...paramsToSend, max_tokens: retryMaxTokens, stream: true }) },
                  1,
                  streamingSignal,
                )
                if (retryResponse.ok) {
                  // Re-enter the streaming path with the corrected response
                  return doStreaming(retryResponse, resolvedModel, messageId)
                }
                const retryErrorText = await retryResponse.text().catch(() => '')
                // If the retry also fails with a max_tokens error, return prompt-too-long
                const retryParsed = parseMaxTokensError(retryErrorText)
                if (retryParsed && retryResponse.status === 400) {
                  const overflow = retryParsed.inputTokens - retryParsed.contextLimit
                  throw new OpenAIHttpError(retryResponse.status, `Prompt is too long: ${retryParsed.inputTokens} tokens > ${retryParsed.contextLimit} maximum (${overflow > 0 ? overflow : 'unknown'} tokens over limit)`)
                }
                throw new OpenAIHttpError(retryResponse.status, `OpenAI API error ${retryResponse.status}: ${retryErrorText.slice(0, 500)}`)
              }
              // Input tokens exceed context limit
              const overflow = parsed.inputTokens - parsed.contextLimit
              throw new OpenAIHttpError(fetchResponse.status, `Prompt is too long: ${parsed.inputTokens} tokens > ${parsed.contextLimit} maximum (${overflow} tokens over limit)`)
            }
            throw new OpenAIHttpError(fetchResponse.status, `OpenAI API error ${fetchResponse.status}: ${errorText.slice(0, 500)}`)
          }

          const messageId = `msg_${randomUUID().slice(0, 24)}`
          return doStreaming(fetchResponse, resolvedModel, messageId)
        }

        const promise = doCreate()
        return {
          then: (onfulfilled: any, onrejected: any) => promise.then(onfulfilled, onrejected),
          catch: (onrejected: any) => promise.catch(onrejected),
          finally: (onfinally: any) => promise.finally?.(onfinally),
          withResponse: async () => {
            const data = await promise
            return { data, response: new Response(), request_id: null }
          },
        }
      },
    },
  }

  return { beta }
}
