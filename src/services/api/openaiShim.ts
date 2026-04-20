/**
 * Enhanced OpenAI-compatible API shim for Claude Code.
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

// -- Model name mapping

const ANTHROPIC_TO_OPENAI_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': 'gpt-4o',
  'claude-opus-4-20250514': 'gpt-4o',
  'claude-opus-4-1-20250805': 'gpt-4o',
  'claude-sonnet-4-0-20250514': 'gpt-4o',
  'claude-3-5-sonnet-20241022': 'gpt-4o',
  'claude-3-5-sonnet-20240620': 'gpt-4o',
  'claude-3-5-haiku-20241022': 'gpt-4o-mini',
  'claude-3-opus-20240229': 'gpt-4o',
  'claude-3-sonnet-20240229': 'gpt-4o',
  'claude-3-haiku-20240307': 'gpt-4o-mini',
  'claude-2.1': 'gpt-4o',
  'claude-2.0': 'gpt-4o',
  'claude-instant-1.2': 'gpt-4o-mini',
}

function resolveModelName(anthropicModel: string): string {
  const mapped = ANTHROPIC_TO_OPENAI_MODEL_MAP[anthropicModel]
  if (mapped) return mapped

  if (anthropicModel.startsWith('claude-')) {
    const fallback = process.env.OPENAI_MODEL
    if (fallback) return fallback
    return 'gpt-4o'
  }

  return anthropicModel
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

// -- JSON Schema sanitizer

/**
 * Sanitize a JSON Schema to ensure it's compatible with OpenAI's API.
 * OpenAI requires that:
 * 1. All properties in `required` must exist in `properties`
 * 2. `properties` must be an object
 * 3. Tool schemas must have type: 'object'
 *
 * This function:
 * - Removes required fields that don't have matching properties
 * - Adds missing properties as {type: 'string'} for required fields
 * - Normalizes nested schemas recursively
 */
function sanitizeSchemaForOpenAI(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }

  const obj = schema as Record<string, unknown>
  const result = { ...obj }

  // Ensure type is object
  if (result.type !== 'object') {
    result.type = 'object'
  }

  // Ensure properties exists and is an object
  if (!result.properties || typeof result.properties !== 'object') {
    result.properties = {}
  }

  const properties = result.properties as Record<string, unknown>
  const required = result.required

  if (Array.isArray(required)) {
    // Ensure all required fields have properties
    for (const key of required) {
      if (typeof key === 'string' && !(key in properties)) {
        properties[key] = { type: 'string' }
      }
    }
    // Remove required fields that aren't strings
    result.required = required.filter((k) => typeof k === 'string')
  }

  // Recursively sanitize nested properties
  for (const [key, value] of Object.entries(properties)) {
    if (value && typeof value === 'object') {
      const prop = value as Record<string, unknown>
      if (prop.type === 'object' || prop.properties) {
        properties[key] = sanitizeSchemaForOpenAI(prop)
      }
      // Handle array items
      if (prop.type === 'array' && prop.items) {
        prop.items = sanitizeSchemaForOpenAI(prop.items)
      }
    }
  }

  return result
}

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
    for (const block of msg.content as Array<{
      type: string
      text?: string
      source?: { data?: string; media_type?: string; type?: string; url?: string }
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
      } else if (block.type === 'document' || block.type === 'tool_result') {
        warn(`Content block type "${block.type}" at user message index ${index} is not fully supported — extracting text only`)
      }
    }

    if (imageParts.length > 0) {
      const multimodalContent: Array<{ type: string; text?: string; image_url?: object }> = []
      const joinedText = textParts.join('\n')
      if (joinedText) multimodalContent.push({ type: 'text', text: joinedText })
      multimodalContent.push(...imageParts)
      return [{ role: 'user', content: multimodalContent }]
    }

    return [{ role: 'user', content: textParts.join('\n') || '(empty message)' }]
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
    if (typeof msg.content === 'string') {
      return [{ role: 'tool', tool_call_id: `tool_${index}`, content: msg.content }]
    }

    const results: OpenAIMessage[] = []
    for (const block of msg.content as Array<{
      type: string
      tool_use_id?: string
      content?: Array<{ type: string; text?: string }> | string
      is_error?: boolean
    }>) {
      if (block.type === 'tool_result') {
        let contentText = ''
        if (typeof block.content === 'string') {
          contentText = block.content
        } else if (Array.isArray(block.content)) {
          contentText = block.content
            .map((b) => (b.type === 'text' ? b.text ?? '' : b.type === 'image' ? '[image]' : ''))
            .filter(Boolean)
            .join('\n')
        }
        if (block.is_error) contentText = `Error: ${contentText}`
        results.push({
          role: 'tool',
          tool_call_id: block.tool_use_id ?? `tool_${index}`,
          content: contentText || '(empty result)',
        })
      }
    }
    return results.length > 0 ? results : []
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

class OpenAIHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'OpenAIHttpError'
    this.status = status
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
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err

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
  if ('cache_tokens' in usage) cacheDetails.push(`cache_tokens=${(usage as any).cache_tokens}`)
  if ('cached_tokens' in usage) cacheDetails.push(`cached_tokens=${(usage as any).cached_tokens}`)

  if (cacheDetails.length > 0) {
    console.error(
      `[OpenAI Shim Cache] prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, ${cacheDetails.join(', ')}`,
    )
  }
}

function makeEventId(): string {
  return `evt_${randomUUID().slice(0, 12)}`
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
