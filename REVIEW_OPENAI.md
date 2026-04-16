# OpenAI Protocol Implementation Review

**Branch:** feature-openai
**Commit:** 59951ff8 "Implement OpenAI protocol support for API communication"
**Files changed:** 5 files, +1026 lines
**Reviewed:** 2026-04-16

---

## 1. Implemented

### 1.1 Core Architecture
- **File:** `src/services/api/openai.ts` (972 lines, new file)
- **File:** `src/services/api/client.ts` (lines 301-314, integration in `getAnthropicClient`)
- **File:** `src/utils/model/providers.ts` (lines 4, 13-14, added `'openai'` to `APIProvider` union and env detection)

The implementation creates an adapter layer that exposes the Anthropic SDK's `beta.messages` interface on top of OpenAI's `/chat/completions` endpoint. It uses native `fetch` (no OpenAI SDK dependency).

### 1.2 Message Format Conversion (Anthropic -> OpenAI)
- System message extraction from both `system` param and `role: "system"` messages (lines 357-396, `convertMessagesToOpenAI`)
- User message conversion: text blocks extracted, content array joined (lines 197-223)
- Assistant message conversion: text + tool_use blocks mapped to `content` + `tool_calls` (lines 225-273)
- Tool result conversion: `tool_result` blocks mapped to OpenAI `role: "tool"` messages with `tool_call_id` (lines 276-321)
- Thinking blocks converted to `[Thinking] ...` text prefix (lines 258-263)

### 1.3 Response Conversion (OpenAI -> Anthropic)
- Text content mapped to `{ type: "text", text }` blocks (lines 463-469)
- Tool calls mapped to `{ type: "tool_use", id, name, input }` blocks with `JSON.parse` (lines 472-480)
- Finish reason mapping: `stop` -> `end_turn`, `tool_calls` -> `tool_use`, `length` -> `max_tokens`, `content_filter` -> `end_turn` (lines 489-493)
- Token usage mapping: `prompt_tokens` -> `input_tokens`, `completion_tokens` -> `output_tokens` (lines 503-505)

### 1.4 Streaming (SSE)
- SSE line-based parser with buffer management for incomplete lines (lines 771-783)
- Emits Anthropic-style stream events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- Tool call state tracking across streaming chunks via `Map` (lines 742-745)
- `input_json_delta` emission for streaming tool arguments (lines 883-893)
- Non-streaming mode simulates the same event sequence for API compatibility (lines 663-716)

### 1.5 Tool / Function Calling
- `convertToolsToOpenAI`: Anthropic `input_schema` -> OpenAI `function.parameters` (lines 401-418)
- `convertToolChoice`: Anthropic `auto/any/tool` -> OpenAI `auto/required` (lines 423-449)
- Streaming tool argument accumulation (lines 849-894)

### 1.6 Passthrough Parameters
- `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `response_format`, `stop`, `logit_bias`, `parallel_tool_calls`, `extra_body` (lines 609-625)

### 1.7 Timeout Support (non-streaming only)
- `createTimeoutSignal` combines AbortSignal with timeout (lines 951-978)

---

## 2. Missing / Issues

### 2.1 CRITICAL: `maxRetries` accepted but never implemented -- FIXED

**Location:** `src/services/api/openai.ts`, lines 27-28 (`OpenAICompatibleClientOptions`)

**Fix:** Added `fetchWithRetry()` function (lines ~252-320) that implements exponential backoff with jitter for transient failures (429, 5xx, network errors). The `maxRetries` option is now honored for both streaming and non-streaming requests. Backoff uses the formula `min(base * 2^attempt + jitter, maxDelay)` with 1s base and 30s cap.

### 2.2 CRITICAL: Streaming request has no timeout -- FIXED

**Location:** `src/services/api/openai.ts`, lines 720-728

**Fix:** Streaming requests now use `createTimeoutSignal(STREAMING_TIMEOUT_MS, requestOptions?.signal)` with a 5-minute default timeout. Combined with `fetchWithRetry()`, the streaming path now has the same protection as the non-streaming path.

### 2.3 CRITICAL: No model name mapping -- FIXED

**Location:** `src/services/api/openai.ts`, line 574 (`model: params.model`)

**Fix:** Added `resolveModelName()` function with a mapping table (`ANTHROPIC_TO_OPENAI_MODEL_MAP`) that converts common Anthropic model names to OpenAI equivalents (e.g., `claude-sonnet-4-20250514` -> `gpt-4o`). Unknown `claude-*` models fall back to `OPENAI_MODEL` env var or default to `gpt-4o`. Non-Anthropic model names pass through verbatim.

### 2.4 HIGH: API key silently defaults to empty string -- FIXED

**Location:** `src/services/api/openai.ts`, line 532

**Fix:** Added explicit validation in `createOpenAICompatibleClient()` that throws a descriptive error if the API key is empty or whitespace before making any API calls.

### 2.5 HIGH: Image/multimodal content silently dropped -- FIXED

**Location:** `src/services/api/openai.ts`, lines 204-215

**Fix:** User message conversion now handles `type: "image"` content blocks by converting them to OpenAI's `image_url` format (base64 data URIs or external URLs). If images are present, the content is sent as a multimodal array. Unknown content types produce a warning via `console.warn` instead of silently dropping.

### 2.6 HIGH: `JSON.parse` on tool arguments can crash -- FIXED

**Location:** `src/services/api/openai.ts`, line 478

**Fix:** Replaced bare `JSON.parse` with `safeJsonParse()` wrapper that returns a configurable fallback (default `{}`) on parse failure. This prevents uncaught exceptions from malformed JSON in tool call arguments.

### 2.7 MEDIUM: Text block index logic is dead code

(Not fixed in this pass - low impact, works correctly despite misleading code)

### 2.8 MEDIUM: Tool block index calculation bug

(Not fixed in this pass - requires refactoring tool call state tracking)

### 2.9 MEDIUM: `stop_sequences` parameter not converted -- FIXED

**Fix:** Added mapping from Anthropic's `stop_sequences` to OpenAI's `stop` parameter when `stop` is not already set.

### 2.10 MEDIUM: `cache_control` silently dropped -- FIXED

**Fix:** Added `console.warn` when `cache_control` is present on content blocks, informing callers that this Anthropic-specific feature is not supported by OpenAI.

### 2.11 MEDIUM: OpenAI `strict` mode for structured outputs dropped

(Not fixed in this pass - low impact, callers can use extra_body)

### 2.12 LOW: No request ID / correlation tracking

(Not fixed in this pass)

### 2.13 LOW: No User-Agent header

(Not fixed in this pass)

### 2.14 LOW: Generic Error types

(Not fixed in this pass - added `OpenAIHttpError` class for internal retry logic)

### 2.15 LOW: `convertAnthropicMessageToOpenAI` has unused parameter

(Not fixed in this pass)

### 2.16 LOW: `makeEventId` function is defined but never called

(Not fixed in this pass)

### 2.17 LOW: Non-streaming simulated stream leaks full response

(Not fixed in this pass)

### 2.7 MEDIUM: Text block index logic is dead code

**Location:** `src/services/api/openai.ts`, lines 819-836

```ts
let textBlockIndex = -1
for (let i = 0; i < contentBlockIndex; i++) {
  if (i === 0) textBlockIndex = 0  // Always sets to 0 on first iteration
}
```

This loop always sets `textBlockIndex = 0` on the first iteration (if `contentBlockIndex > 0`). It does not actually search for an existing text block. This works only because there's at most one text block, but the code is misleading.

### 2.8 MEDIUM: Tool block index calculation bug

**Location:** `src/services/api/openai.ts`, line 884

```ts
const toolBlockIdx = toolCallState.size - 1
```

This assumes tool calls are always emitted in sequential order (index 0, 1, 2...). However, OpenAI streaming can emit tool calls out of order or with non-sequential indices. The correct approach is to track the content block index alongside the tool call state in the Map.

### 2.9 MEDIUM: `stop_sequences` parameter not converted

Anthropic's API uses `stop_sequences` (plural) while OpenAI uses `stop`. The passthrough list at line 615 includes `stop`, but if callers pass Anthropic-style `stop_sequences`, it will not be forwarded. The Anthropic SDK `messages.create` accepts `stop_sequences`.

### 2.10 MEDIUM: `cache_control` silently dropped

Anthropic's prompt caching via `cache_control` on content blocks (lines 208, 245, 295) is silently ignored. OpenAI has no equivalent, but callers may expect caching to work. At minimum, a warning should be logged.

### 2.11 MEDIUM: OpenAI `strict` mode for structured outputs dropped

**Location:** `src/services/api/openai.ts`, lines 401-418 (`convertToolsToOpenAI`)

OpenAI supports `"strict": true` on function definitions for structured output enforcement. The converter does not preserve or set this field.

### 2.12 LOW: No request ID / correlation tracking

The standard Anthropic client at `src/services/api/client.ts` (lines 336-356, `buildFetch`) injects `x-client-request-id` headers and logs `[API REQUEST]` entries for correlation. The OpenAI client has no equivalent request tracking, making debugging harder.

### 2.13 LOW: No User-Agent header

The Anthropic client sets `'User-Agent': getUserAgent()` and `'x-app': 'cli'` headers (line 109-110 of client.ts). The OpenAI client only sets `Content-Type` and `Authorization` (lines 630-634). Missing standard headers may cause analytics gaps.

### 2.14 LOW: Generic Error types

**Location:** `src/services/api/openai.ts`, lines 650-652, 732-734

```ts
throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`)
```

Throws plain `Error` objects. The Anthropic SDK throws typed errors (`APIError`, `RateLimitError`, etc.) that callers may pattern-match on. No rate-limit-specific error type (429) is distinguished.

### 2.15 LOW: `convertAnthropicMessageToOpenAI` has unused parameter

**Location:** `src/services/api/openai.ts`, line 183

`allMessages` parameter is declared but never used in the function body.

### 2.16 LOW: `makeEventId` function is defined but never called

**Location:** `src/services/api/openai.ts`, lines 513-515

Dead code.

### 2.17 LOW: Non-streaming simulated stream leaks full response

**Location:** `src/services/api/openai.ts`, lines 660-716

The non-streaming return uses spread `{...anthropicResponse}` which includes the full `content` array. If callers also iterate the async iterator, they may double-process content. The Anthropic SDK's non-streaming return does not include an async iterator.

---

## 3. Optimization

### 3.1 Use the official OpenAI SDK instead of raw fetch

The current implementation manually handles SSE parsing, retry logic (missing), type definitions, and error handling. The `openai` npm package provides all of this out of the box, just as this codebase uses `@anthropic-ai/sdk` for Anthropic. This would reduce the 972-line file to ~200 lines of adapter code and provide built-in retry, proper error types, and automatic updates for API changes.

### 3.2 Add model name configuration

Add a required `OPENAI_MODEL` environment variable or a model mapping function. Without it, the caller must know to pass an OpenAI-compatible model name, which breaks the abstraction.

### 3.3 Extract conversion functions to separate module

At 972 lines, this file mixes type definitions, conversion logic, SSE parsing, and client construction. Splitting into:
- `openai/types.ts` - interface definitions
- `openai/converter.ts` - Anthropic <-> OpenAI conversion
- `openai/stream.ts` - SSE parsing and event emission
- `openai/client.ts` - client factory

### 3.4 Add unit tests

Zero tests exist for the conversion functions. The `convertAnthropicMessageToOpenAI`, `convertResponseToAnthropic`, and `convertToolsToOpenAI` functions are pure and easily testable. Critical edge cases to cover:
- Empty content arrays
- Malformed JSON in tool arguments
- Tool results with mixed content types
- Streaming with multiple tool calls

### 3.5 Add connection keep-alive for streaming

The streaming SSE connection should configure appropriate timeout/keepalive settings to prevent premature connection drops by intermediate proxies.

---

## 4. Verdict

### Summary Table

| Area | Status | Severity |
|------|--------|----------|
| Chat completions (basic) | Implemented | - |
| Streaming SSE | Implemented with bugs | Medium |
| Function/tool calling | Implemented with gaps | Medium |
| Retry logic | **Fixed** (exponential backoff) | ~~Critical~~ |
| Streaming timeout | **Fixed** (5min default) | ~~Critical~~ |
| Model name mapping | **Fixed** (mapping table + env var) | ~~Critical~~ |
| API key validation | **Fixed** (throws if empty) | ~~High~~ |
| Image/multimodal | **Fixed** (image_url conversion) | ~~High~~ |
| Error handling | Partial (generic Error only) | Medium |
| Rate limiting | Partial (retry handles 429) | Medium |
| Structured outputs (strict) | Missing | Low |
| Prompt caching | Warned (not silently dropped) | ~~Low~~ |
| Request correlation/logging | Missing | Low |
| stop_sequences passthrough | **Fixed** (mapped to stop) | ~~Medium~~ |

### Overall Assessment

The implementation provides a **functional minimum viable adapter** for basic text chat completions with streaming and tool calling. The architecture of wrapping OpenAI's `/chat/completions` behind an Anthropic-compatible interface is sound and follows the same pattern as the existing Bedrock/Vertex/Foundry adapters.

**All three critical issues have been resolved:**

1. **Retry logic** -- Implemented via `fetchWithRetry()` with exponential backoff and jitter for 429, 5xx, and network errors. Honors the `maxRetries` option.

2. **Model name mapping** -- Implemented via `resolveModelName()` with a comprehensive mapping table and `OPENAI_MODEL` env var fallback. Non-Anthropic model names pass through verbatim.

3. **Streaming timeout** -- Implemented via `createTimeoutSignal()` with a 5-minute default applied to all streaming requests.

**All high-severity issues have been resolved:**

4. **API key validation** -- Throws descriptive error at client creation time if key is empty.

5. **JSON.parse safety** -- Wrapped in `safeJsonParse()` with fallback to empty object.

6. **Multimodal content** -- Image blocks converted to OpenAI `image_url` format; unknown types produce warnings.

### Recommendation

**Ready for merge pending review of remaining medium/low items.** The critical and high severity gaps identified in the original review have been addressed.
