/**
 * SDK 统一导出层
 *
 * 将所有 @anthropic-ai/sdk 的导入集中到此文件，避免子路径导入问题。
 * Bun compile 时只需要处理这一个导入点，不会出现 /$bunfs/root/ 路径解析失败。
 */

// ─── 客户端类 ─────────────────────────────────────────────────
export { default as Anthropic, Anthropic as AnthropicClient } from '@anthropic-ai/sdk'

// ─── 错误类 ─────────────────────────────────────────────────
export {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AnthropicError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  BadRequestError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk/error'

// ─── 资源类型 (运行时) ────────────────────────────────────────
export type {
  ContentBlock,
  ContentBlockParam,
  ImageBlockParam,
  Message,
  MessageCreateParams,
  MessageParam,
  MessageStreamEvent,
  TextBlock,
  TextBlockParam,
  Tool,
  ToolUseBlock,
  Usage,
} from '@anthropic-ai/sdk/resources/index.mjs'

export type {
  MessageStreamEvent as MessagesMessageStreamEvent,
  MessagesContentBlock,
} from '@anthropic-ai/sdk/resources/messages.mjs'

export type {
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources'

// ─── Beta 资源类型 ────────────────────────────────────────────
export type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaRawMessageStreamEvent,
  BetaRequestDocumentBlock,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaUsage,
  BetaMessageParam as BetaMessageParamType,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

// ─── 类型定义 (编译时擦除，无运行时依赖) ──────────────────────
export type { ClientOptions } from '@anthropic-ai/sdk'
export type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
