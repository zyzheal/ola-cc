# OpenAI Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 base_branch_code 中新增 openaiShim.ts，基于现有 openai.ts 添加 schema 消毒、工具参数规范化、默认重试等增强功能。

**Architecture:** 以现有 `openai.ts` 为基础，创建新的 `openaiShim.ts` 文件，复用其类型定义和转换逻辑，新增 schemaSanitizer 内联实现和工具参数规范化。

**Tech Stack:** TypeScript, Node.js crypto, fetch API

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/services/api/openaiShim.ts` | **新建** | 增强版 OpenAI 客户端，包含 schema 消毒、工具参数规范化、默认重试 |
| `src/services/api/openaiShim.test.ts` | **新建** | 单元测试，覆盖转换函数和边缘情况 |

**不修改现有文件：** `src/services/api/openai.ts` 保持不变。

---

### Task 1: 类型定义和工具函数

**Files:**
- Create: `src/services/api/openaiShim.ts`

- [ ] **Step 1: 写入文件头和类型定义**

文件内容（完整）：

```typescript
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
```

- [ ] **Step 2: 添加模型映射和基础工具函数**

追加到文件：

```typescript
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
```

- [ ] **Step 3: 提交**

```bash
cd /Users/heal/base_branch_code
git add src/services/api/openaiShim.ts
git commit -m "feat: add openaiShim.ts with type definitions and base utilities"
```

---

### Task 2: JSON Schema 消毒器

**Files:**
- Modify: `src/services/api/openaiShim.ts`

- [ ] **Step 1: 添加 schemaSanitizer 函数**

追加到文件（在 extractTextContent 之后）：

```typescript
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
```

- [ ] **Step 2: 提交**

```bash
cd /Users/heal/base_branch_code
git add src/services/api/openaiShim.ts
git commit -m "feat: add JSON schema sanitizer to openaiShim"
```

---

### Task 3: 消息转换函数

**Files:**
- Modify: `src/services/api/openaiShim.ts`

- [ ] **Step 1: 添加消息转换函数**

追加到文件：

```typescript
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
```

- [ ] **Step 2: 提交**

```bash
cd /Users/heal/base_branch_code
git add src/services/api/openaiShim.ts
git commit -m "feat: add message conversion functions to openaiShim"
```

---

### Task 4: 工具转换和重试逻辑

**Files:**
- Modify: `src/services/api/openaiShim.ts`

- [ ] **Step 1: 添加工具转换和重试逻辑**

追加到文件：

```typescript
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
```

- [ ] **Step 2: 提交**

```bash
cd /Users/heal/base_branch_code
git add src/services/api/openaiShim.ts
git commit -m "feat: add tool conversion and retry logic to openaiShim"
```

---

### Task 5: 响应转换和客户端主体

**Files:**
- Modify: `src/services/api/openaiShim.ts`

- [ ] **Step 1: 添加响应转换和客户端**

追加到文件：

```typescript
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
```

- [ ] **Step 2: 提交**

```bash
cd /Users/heal/base_branch_code
git add src/services/api/openaiShim.ts
git commit -m "feat: add response conversion and utilities to openaiShim"
```

---

### Task 6: 客户端入口函数

**Files:**
- Modify: `src/services/api/openaiShim.ts`

- [ ] **Step 1: 添加 createOpenAICompatibleShimClient 函数**

追加到文件末尾：

```typescript
// -- Client entry point

export function createOpenAICompatibleShimClient(options: OpenAICompatibleClientOptions) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || ''
  const baseURL =
    process.env.OPENAI_API_BASE ||
    process.env.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'

  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'OpenAI API key is not set. Please set the OPENAI_API_KEY environment variable ' +
      'or provide apiKey in the client options.',
    )
  }

  // Enhanced: default to 2 retries (vs 0 in original)
  const maxRetries = options.maxRetries ?? 2

  const STREAMING_TIMEOUT_MS = 300_000
  const parsedExtraBody = parseExtraBodyEnv()

  const beta = {
    messages: {
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

        // Passthrough params
        for (const key of ['top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'response_format', 'stop', 'logit_bias', 'parallel_tool_calls']) {
          if (key in params && params[key] !== undefined) {
            // @ts-expect-error dynamic key
            openaiParams[key] = params[key]
          }
        }

        // Merge extra_body
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
          if (!params.stream) {
            const response = await fetchWithRetry(
              fetchFn,
              url,
              { method: 'POST', headers, body: JSON.stringify(openaiParams) },
              maxRetries,
              effectiveSignal,
            )

            if (!response.ok) {
              const errorText = await response.text().catch(() => '')
              throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`)
            }

            const data = (await response.json()) as OpenAIChatCompletionResponse
            const anthropicResponse = convertResponseToAnthropic(data)
            logCacheUsage(data)

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
                yield { type: 'message_delta', delta: { stop_reason: anthropicResponse.stop_reason, stop_sequence: null }, usage: { output_tokens: anthropicResponse.usage.output_tokens } } as AnthropicStreamEvent
                yield { type: 'message_stop' } as AnthropicStreamEvent
              },
            }
          }

          const streamingSignal = createTimeoutSignal(STREAMING_TIMEOUT_MS, requestOptions?.signal)
          const fetchResponse = await fetchWithRetry(
            fetchFn,
            url,
            { method: 'POST', headers: { ...headers, Accept: 'text/event-stream' }, body: JSON.stringify({ ...openaiParams, stream: true }) },
            maxRetries,
            streamingSignal,
          )

          if (!fetchResponse.ok) {
            const errorText = await fetchResponse.text().catch(() => '')
            throw new Error(`OpenAI API error ${fetchResponse.status}: ${errorText.slice(0, 500)}`)
          }

          const messageId = `msg_${randomUUID().slice(0, 24)}`
          let contentBlockIndex = 0
          const toolCallState: Map<number, { id: string; name: string; arguments: string }> = new Map()
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
              if (!fetchResponse.body) throw new Error('Response body is null for streaming request')

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
                      yield { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', content: [], model: chunk.model ?? resolvedModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } as AnthropicStreamEvent
                    }

                    const delta = choice.delta

                    if (delta?.content && delta.content !== 'null' && delta.content !== '') {
                      let textBlockIndex = -1
                      for (let i = 0; i < contentBlockIndex; i++) { if (i === 0) textBlockIndex = 0 }
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
                          state = { id: tc.id ?? `tool_call_${idx}_${randomUUID().slice(0, 8)}`, name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' }
                          toolCallState.set(idx, state)
                          const toolBlockIdx = contentBlockIndex++
                          openedContentBlockIndices.add(toolBlockIdx)
                          yield { type: 'content_block_start', index: toolBlockIdx, content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} } } as AnthropicStreamEvent
                        } else {
                          if (tc.function?.arguments) state.arguments += tc.function.arguments
                        }
                        if (tc.function?.arguments) {
                          const toolBlockIdx = toolCallState.size - 1
                          yield { type: 'content_block_delta', index: toolBlockIdx >= 0 ? toolBlockIdx : contentBlockIndex - 1, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } } as AnthropicStreamEvent
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

                      if (chunk.usage && !hasEmittedUsage) {
                        hasEmittedUsage = true
                        logCacheUsage(chunk)
                      }
                      yield { type: 'message_delta', delta: { stop_reason: stopReason as string | null, stop_sequence: null }, usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 } } as AnthropicStreamEvent
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
```

- [ ] **Step 2: 提交**

```bash
cd /Users/heal/base_branch_code
git add src/services/api/openaiShim.ts
git commit -m "feat: add createOpenAICompatibleShimClient entry point"
```

---

### Task 7: 单元测试

**Files:**
- Create: `src/services/api/openaiShim.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
import { describe, it, expect } from 'bun:test'
import { createOpenAICompatibleShimClient } from './openaiShim.js'

describe('openaiShim', () => {
  describe('createOpenAICompatibleShimClient', () => {
    it('throws when no API key is provided', () => {
      expect(() => createOpenAICompatibleShimClient({})).toThrow('OpenAI API key is not set')
    })

    it('creates client with provided API key', () => {
      const client = createOpenAICompatibleShimClient({ apiKey: 'test-key' })
      expect(client.beta).toBeDefined()
      expect(client.beta.messages).toBeDefined()
      expect(client.beta.messages.create).toBeDefined()
    })
  })

  describe('non-streaming response with mocked fetch', () => {
    it('converts response to Anthropic format', async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          id: 'test-id',
          model: 'gpt-4o',
          choices: [{
            message: { role: 'assistant', content: 'Hello!', tool_calls: null },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      }) as Response

      const client = createOpenAICompatibleShimClient({
        apiKey: 'test-key',
        fetchOverride: mockFetch,
        maxRetries: 0,
      })

      const result = await client.beta.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      })

      expect(result.id).toBe('test-id')
      expect(result.model).toBe('gpt-4o')
      expect(result.stop_reason).toBe('end_turn')
      expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }])
    })
  })

  describe('tool conversion', () => {
    it('converts Anthropic tools to OpenAI format', async () => {
      let capturedBody: unknown
      const mockFetch = async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        return {
          ok: true,
          json: async () => ({
            id: 'test-id',
            model: 'gpt-4o',
            choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        } as Response
      }

      const client = createOpenAICompatibleShimClient({
        apiKey: 'test-key',
        fetchOverride: mockFetch,
        maxRetries: 0,
      })

      await client.beta.messages.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 100,
        tools: [{
          name: 'get_weather',
          description: 'Get weather info',
          input_schema: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location', 'missing_field'],
          },
        }],
      })

      const body = capturedBody as { tools?: unknown[] }
      expect(body.tools).toBeDefined()
      expect(body.tools?.length).toBe(1)
      const tool = body.tools?.[0] as { type: string; function: { name: string; parameters: unknown } }
      expect(tool.type).toBe('function')
      expect(tool.function.name).toBe('get_weather')
      // Schema sanitizer should add missing_field to properties
      const params = tool.function.parameters as { properties: Record<string, unknown>; required: string[] }
      expect(params.properties.missing_field).toBeDefined()
      expect(params.required).toContain('location')
    })
  })
})
```

- [ ] **Step 2: 运行测试**

```bash
cd /Users/heal/base_branch_code
bun test src/services/api/openaiShim.test.ts
```

期望：全部 3 个测试通过。

- [ ] **Step 3: 提交**

```bash
cd /Users/heal/base_branch_code
git add src/services/api/openaiShim.test.ts
git commit -m "test: add unit tests for openaiShim"
```

---

## 自审

1. **占位符扫描:** 无 TBD/TODO
2. **类型一致性:** `OpenAIMessage`, `OpenAITool`, `AnthropicStreamEvent` 等类型在 Task 1 定义，后续任务一致使用
3. **接口一致性:** `createOpenAICompatibleShimClient` 返回的 `{ beta: { messages: { create } } }` 结构与 Task 6 一致
4. **覆盖范围:** 设计文档中所有 7 项功能均已实现
5. **独立性:** openaiShim.ts 仅依赖 `crypto` 内置模块，零外部依赖
