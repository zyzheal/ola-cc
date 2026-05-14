/**
 * Multi-Provider API abstraction.
 *
 * Different LLM providers use different API protocols:
 * - Anthropic: /v1/messages with custom headers and SSE events
 * - OpenAI: /chat/completions with OpenAI-compatible format
 * - Anthropic Proxy: Dashscope/other gateways that accept Anthropic format
 */

import type {
  MessageParam,
  Tool,
  TextBlock,
  ToolUseBlock,
  BetaRawMessageStreamEvent,
} from '../utils/anthropic-types';

export type ProviderName = 'anthropic' | 'openai' | 'anthropic-proxy';

export interface ProviderConfig {
  name: ProviderName;
  apiKey: string;
  model: string;
  baseURL: string;
}

/**
 * Unified API request/response types used internally.
 */
export interface ApiRequest {
  model: string;
  messages: MessageParam[];
  system?: string;
  tools?: Tool[];
  maxTokens: number;
}

export interface ApiResponse {
  content: Array<TextBlock | ToolUseBlock>;
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  id: string;
}

export interface StreamEvent {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_complete' | 'stop';
  text?: string;
  toolName?: string;
  toolId?: string;
}

/**
 * Provider interface for different API protocols.
 */
export interface ApiProvider {
  /** Build the request body for the provider's API. */
  buildRequestBody(req: ApiRequest): Record<string, unknown>;

  /** Build HTTP headers for authentication. */
  buildHeaders(): Record<string, string>;

  /** Parse the provider's raw response into our unified format. */
  parseResponse(data: unknown): ApiResponse;

  /** Parse SSE events from the provider's stream into our unified format. */
  parseSSEEvent(type: string, data: unknown): BetaRawMessageStreamEvent | null;

  /** Get the API endpoint path. */
  getEndpoint(): string;
}

/**
 * Anthropic provider (original).
 */
export class AnthropicProvider implements ApiProvider {
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  buildRequestBody(req: ApiRequest): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
    };
    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools;
    }
    return params;
  }

  buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2024-10-22',
    };
  }

  parseResponse(data: unknown): ApiResponse {
    const d = data as {
      id: string;
      model: string;
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number };
    };
    const content = d.content.map((block) => {
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use' as const,
          id: block.id!,
          name: block.name!,
          input: block.input ?? {},
        };
      }
      return { type: 'text' as const, text: block.text ?? '' };
    });
    return {
      content: content as Array<TextBlock | ToolUseBlock>,
      stopReason: d.stop_reason,
      usage: d.usage,
      model: d.model,
      id: d.id,
    };
  }

  parseSSEEvent(type: string, data: unknown): BetaRawMessageStreamEvent | null {
    return data as BetaRawMessageStreamEvent | null;
  }

  getEndpoint(): string {
    return '/v1/messages';
  }
}

/**
 * OpenAI-compatible provider (for Dashscope Qwen, SiliconFlow, etc.).
 */
export class OpenAIProvider implements ApiProvider {
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  buildRequestBody(req: ApiRequest): Record<string, unknown> {
    // Convert Anthropic messages to OpenAI format
    const messages: Array<{ role: string; content: string; name?: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];

    // System message first
    if (req.system) {
      messages.push({ role: 'system', content: req.system });
    }

    for (const msg of req.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Handle mixed content blocks
        const textParts: string[] = [];
        const toolCalls: unknown[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push((block as { text?: string }).text ?? '');
          } else if (block.type === 'tool_use') {
            const tb = block as { id?: string; name?: string; input?: unknown };
            toolCalls.push({
              id: tb.id ?? `call_${Date.now()}`,
              type: 'function',
              function: {
                name: tb.name,
                arguments: JSON.stringify(tb.input ?? {}),
              },
            });
          } else if (block.type === 'tool_result') {
            // Tool result becomes a separate message
            const tb = block as { tool_use_id?: string; content?: unknown };
            const contentText = typeof tb.content === 'string'
              ? tb.content
              : Array.isArray(tb.content)
                ? (tb.content as { text?: string }[]).map(b => b.text ?? '').join('')
                : '';
            messages.push({
              role: 'tool',
              content: contentText,
              tool_call_id: tb.tool_use_id,
            });
            continue;
          }
        }

        if (toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: textParts.length > 0 ? textParts.join('\n') : '',
            tool_calls: toolCalls,
          });
        } else if (textParts.length > 0) {
          messages.push({ role: msg.role, content: textParts.join('\n') });
        }
      }
    }

    // Convert tools to OpenAI function calling format
    const tools = req.tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    return {
      model: this.config.model,
      max_tokens: req.maxTokens,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };
  }

  buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };
  }

  parseResponse(data: unknown): ApiResponse {
    const d = data as {
      id: string;
      model: string;
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string | null;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = d.choices?.[0];
    const message = choice?.message;
    const content: Array<TextBlock | ToolUseBlock> = [];

    if (message?.content) {
      content.push({ type: 'text', text: message.content });
    }

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    const stopReason = choice?.finish_reason === 'tool_calls'
      ? 'tool_use'
      : choice?.finish_reason || 'end_turn';

    return {
      content,
      stopReason,
      usage: {
        input_tokens: d.usage?.prompt_tokens ?? 0,
        output_tokens: d.usage?.completion_tokens ?? 0,
      },
      model: d.model,
      id: d.id || `openai-${Date.now()}`,
    };
  }

  parseSSEEvent(type: string, data: unknown): BetaRawMessageStreamEvent | null {
    // Convert OpenAI SSE events to Anthropic-style events
    if (type === 'chunk') {
      const d = data as {
        id: string;
        model: string;
        choices: Array<{
          delta: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason: string | null;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const choice = d.choices?.[0];
      if (!choice) return null;

      // Text content
      if (choice.delta?.content) {
        return {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: choice.delta.content },
        } as BetaRawMessageStreamEvent;
      }

      // Tool calls
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.id) {
            return {
              type: 'content_block_start',
              index: tc.index,
              content_block: {
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name ?? 'unknown',
                input: {},
              },
            } as BetaRawMessageStreamEvent;
          }
          if (tc.function?.arguments) {
            return {
              type: 'content_block_delta',
              index: tc.index,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            } as BetaRawMessageStreamEvent;
          }
        }
      }

      // Finish
      if (choice.finish_reason) {
        return {
          type: 'message_delta',
          delta: {
            stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
            stop_sequence: null,
          },
          usage: {
            output_tokens: d.usage?.completion_tokens ?? 0,
          },
        } as BetaRawMessageStreamEvent;
      }
    }

    return null;
  }

  getEndpoint(): string {
    return '/chat/completions';
  }
}

/**
 * Factory to create the appropriate provider.
 */
export function createProvider(config: ProviderConfig): ApiProvider {
  switch (config.name) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic-proxy':
      // Dashscope/other proxies that accept Anthropic format — use Anthropic provider
      return new AnthropicProvider(config);
    case 'anthropic':
    default:
      return new AnthropicProvider(config);
  }
}
