/**
 * 兼容层: 与 @anthropic-ai/sdk API 兼容
 * 用于平滑替换原始 SDK
 */

import { AnthropicApiClient } from './cli/agent/api-client.js';
import { APIError } from './utils/error.js';
import type { MessageParam, TextBlock, ToolUseBlock, ToolResultBlock, ImageBlock, Tool, Usage, BetaMessage, BetaUsage, BetaRawMessageStreamEvent, BetaContentBlock } from './utils/anthropic-types.js';
import type { StreamEvent, ApiResponse, ApiRequestOptions } from './cli/agent/api-client.js';

export {
  APIError, APIUserAbortError,
  createAPIError, isRetryableError,
  APIRateLimitError,
} from './utils/error.js';
export type { APIErrorType } from './utils/error.js';

/**
 * 消息块类型 (兼容原始 SDK)
 */
export type ContentBlockParam = string | TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

/**
 * 与 @anthropic-ai/sdk 兼容的 ClientOptions
 */
export interface ClientOptions {
  apiKey?: string | null;
  authToken?: string;
  baseURL?: string;
  maxRetries?: number;
  timeout?: number;
  fetch?: typeof fetch;
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  fetchOptions?: Record<string, unknown>;
  defaultHeaders?: Record<string, string>;
  skipAuth?: boolean;
  awsAccessKey?: string;
  awsSecretKey?: string;
  awsSessionToken?: string;
}

/**
 * 消息创建参数
 */
export interface MessageCreateParams {
  model: string;
  messages: MessageParam[];
  system?: string;
  maxTokens?: number;
  tools?: Tool[];
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
}

/**
 * Beta API namespace - provides access to beta endpoints
 */
declare class AnthropicBetaMessages {
  create(
    params: Record<string, unknown> & { model: string; messages: unknown[]; max_tokens: number },
    options?: Record<string, unknown>
  ): Promise<import('./utils/anthropic-types.js').BetaMessage | AsyncIterable<unknown>>;
  countTokens(
    params: Record<string, unknown> & { model: string; messages: unknown[] }
  ): Promise<{ input_tokens: number }>;
}

/**
 * Models API namespace
 */
declare class AnthropicModels {
  list(params?: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
}

/**
 * 兼容 @anthropic-ai/sdk 的 Anthropic 主类
 * 提供与原始 SDK 相同的 API
 */
export class Anthropic {
  private apiKey: string;
  private baseURL: string;
  private maxRetries: number;
  readonly beta: { messages: AnthropicBetaMessages };
  readonly models: AnthropicModels;

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey ?? '';
    this.baseURL = options.baseURL ?? 'https://api.anthropic.com';
    this.maxRetries = options.maxRetries ?? 3;
    this.models = {
      list: async function* (_params?) {
        // Stub - models list not fully implemented
      },
    };
    this.beta = {
      messages: {
        create: async (params, _options?) => {
          // Delegate to the same internal API call path
          const client = new AnthropicApiClient({
            apiKey: this.apiKey,
            model: params.model,
            maxTokens: params.max_tokens ?? 4096,
            baseURL: this.baseURL,
            logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
          });

          if (params.stream) {
            return client.createMessageStream({
              system: typeof params.system === 'string' ? params.system : '',
              messages: params.messages as MessageParam[],
              tools: params.tools as Tool[] | undefined,
            });
          }

          const response = await client.createMessage({
            system: typeof params.system === 'string' ? params.system : '',
            messages: params.messages as MessageParam[],
            tools: params.tools as Tool[] | undefined,
          });

          return {
            id: response.id,
            type: 'message' as const,
            role: 'assistant' as const,
            content: response.content.map(block => {
              if (block.type === 'tool_use') {
                return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
              }
              return { type: 'text' as const, text: (block as any).text ?? '' };
            }),
            model: response.model,
            stop_reason: response.stopReason ?? null,
            stop_sequence: null,
            usage: response.usage,
          } as import('./utils/anthropic-types.js').BetaMessage;
        },
        countTokens: async (_params) => {
          // Stub - countTokens not fully implemented
          return { input_tokens: 0 };
        },
      },
    };
  }

  /**
   * 创建消息 (非流式)
   */
  async createMessage(params: MessageCreateParams): Promise<{
    id: string;
    type: string;
    role: string;
    content: Array<{ type: string; text?: string }>;
    model: string;
    stop_reason: string | null;
    usage: Usage;
  }> {
    const client = new AnthropicApiClient({
      apiKey: this.apiKey,
      model: params.model,
      maxTokens: params.maxTokens ?? 4096,
      baseURL: this.baseURL,
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    });

    const response = await client.createMessage({
      system: params.system ?? '',
      messages: params.messages,
      tools: params.tools,
    });

    return {
      id: response.id,
      type: 'message',
      role: 'assistant',
      content: response.content.map(block => {
        if (block.type === 'tool_use') {
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
        return { type: 'text', text: (block as any).text ?? '' };
      }),
      model: response.model,
      stop_reason: response.stopReason,
      usage: response.usage,
    };
  }

  /**
   * 创建消息 (流式)
   */
  async createMessageStream(params: MessageCreateParams & { stream?: boolean }) {
    const client = new AnthropicApiClient({
      apiKey: this.apiKey,
      model: params.model,
      maxTokens: params.maxTokens ?? 4096,
      baseURL: this.baseURL,
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    });

    return client.createMessageStream({
      system: params.system ?? '',
      messages: params.messages,
      tools: params.tools,
    });
  }
}

// Namespace declaration merging on the class
export declare namespace Anthropic {
  export namespace Beta {
    export namespace Messages {
      export type BetaMessage = import('./utils/anthropic-types.js').BetaMessage;
      export type BetaUsage = import('./utils/anthropic-types.js').BetaUsage;
      export type BetaMessageParam = import('./utils/anthropic-types.js').MessageParam;
      export type BetaMessageStreamParams = import('./resources/index.js').BetaMessageStreamParams;
      export type BetaTool = import('./resources/index.js').BetaTool;
      export type BetaToolUnion = import('./resources/index.js').BetaToolUnion;
      export type BetaToolUseBlock = import('./resources/index.js').BetaToolUseBlock;
      export type BetaToolUseBlockParam = import('./resources/index.js').ToolUseBlockParam;
      export type BetaToolResultBlockParam = import('./resources/index.js').ToolResultBlockParam;
      export type BetaContentBlock = import('./utils/anthropic-types.js').BetaContentBlock;
      export type BetaJSONOutputFormat = import('./resources/index.js').BetaJSONOutputFormat;
      export type BetaThinkingConfigParam = { type: 'enabled' | 'disabled' | 'adaptive'; budget_tokens?: number };
    }
  }
  export type MessageParam = import('./utils/anthropic-types.js').MessageParam;
  export type TextBlockParam = import('./resources/index.js').TextBlockParam;
  export type Tool = import('./utils/anthropic-types.js').Tool;
  export type ToolChoice = { type: 'auto' | 'any' | 'tool'; name?: string };
  export namespace Tool {
    export interface InputSchema {
      type: 'object';
      properties?: unknown | null;
      required?: string[] | readonly string[] | null;
      [k: string]: unknown;
    }
  }
  export type ImageBlockParam = import('./resources/index.js').ImageBlockParam;
  export type ContentBlockParam = import('./resources/index.js').ContentBlockParam;
  export type BetaContentBlockParam = import('./resources/index.js').BetaContentBlockParam;
  export type BetaImageBlockParam = import('./resources/index.js').BetaImageBlockParam;
  export type BetaMessageStreamParams = import('./resources/index.js').BetaMessageStreamParams;
  export type BetaMessageDeltaUsage = import('./resources/index.js').BetaMessageDeltaUsage;
  export type BetaOutputConfig = import('./resources/index.js').BetaOutputConfig;
  export type BetaRequestDocumentBlock = import('./resources/index.js').BetaRequestDocumentBlock;
  export type BetaStopReason = import('./resources/index.js').BetaStopReason;
  export type BetaToolChoiceAuto = import('./resources/index.js').BetaToolChoiceAuto;
  export type BetaToolChoiceTool = import('./resources/index.js').BetaToolChoiceTool;
  export type BetaToolResultBlockParam = import('./resources/index.js').BetaToolResultBlockParam;
  export type BetaWebSearchTool20250305 = import('./resources/index.js').BetaWebSearchTool20250305;
  export type BetaRedactedThinkingBlock = import('./resources/index.js').BetaRedactedThinkingBlock;
  export type BetaThinkingBlock = import('./resources/index.js').BetaThinkingBlock;
  export type RedactedThinkingBlock = import('./resources/index.js').RedactedThinkingBlock;
  export type RedactedThinkingBlockParam = import('./resources/index.js').RedactedThinkingBlockParam;
  export type ThinkingBlock = import('./resources/index.js').ThinkingBlock;
  export type ThinkingBlockParam = import('./resources/index.js').ThinkingBlockParam;
  export type Stream<T = unknown> = import('./resources/index.js').Stream<T>;
  export type ContentBlock = import('./resources/index.js').ContentBlock;
  export type TextBlock = import('./utils/anthropic-types.js').TextBlock;
  export type ToolUseBlock = import('./utils/anthropic-types.js').ToolUseBlock;
  export type ToolResultBlock = import('./utils/anthropic-types.js').ToolResultBlock;
  export type ImageBlock = import('./utils/anthropic-types.js').ImageBlock;
  export type Usage = import('./utils/anthropic-types.js').Usage;
}

// --- 错误类型别名 (与 @anthropic-ai/sdk 兼容) ---

/**
 * API 连接错误
 */
export class APIConnectionError extends APIError {
  readonly name = 'APIConnectionError';
  constructor(message: string = 'Connection error') {
    super(0, message, 'retry_error');
    Object.defineProperty(this, 'name', { value: 'APIConnectionError' });
  }
}

/**
 * API 连接超时错误
 */
export class APIConnectionTimeoutError extends APIError {
  constructor(message: string = 'Connection timeout') {
    super(408, message, 'retry_error');
    Object.defineProperty(this, 'name', { value: 'APIConnectionTimeoutError' });
  }
}

/**
 * 认证错误
 */
export class AuthenticationError extends APIError {
  constructor(message: string = 'Authentication failed') {
    super(401, message, 'authentication_error');
    Object.defineProperty(this, 'name', { value: 'AuthenticationError' });
  }
}

/**
 * 找不到资源错误
 */
export class NotFoundError extends APIError {
  constructor(message: string = 'Resource not found') {
    super(404, message, 'not_found_error');
    Object.defineProperty(this, 'name', { value: 'NotFoundError' });
  }
}

/**
 * 速率限制错误 (APIRateLimitError 的别名，与 @anthropic-ai/sdk 兼容)
 */
export class RateLimitError extends APIError {
  constructor(message: string = 'Rate limit exceeded') {
    super(429, message, 'rate_limit_error');
    Object.defineProperty(this, 'name', { value: 'RateLimitError' });
  }
}

// --- 类型导出 ---

export type { TextBlock, ToolUseBlock, ToolResultBlock, ImageBlock, BetaMessage, BetaUsage, BetaRawMessageStreamEvent, BetaContentBlock };
export type { StreamEvent, ApiResponse, ApiRequestOptions };

// --- 常量 ---

export const API_HOST = 'api.anthropic.com';
export const API_VERSION = '2024-10-22';

// --- Legacy prompt constants (@anthropic-ai/sdk compatibility) ---
export const HUMAN_PROMPT = '\n\nHuman:';
export const AI_PROMPT = '\n\nAssistant:';

// --- Stream type (for @anthropic-ai/sdk/streaming.mjs) ---
export type { Stream } from './resources/index.js';