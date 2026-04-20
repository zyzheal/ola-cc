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
