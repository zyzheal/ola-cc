import type {
  MessageParam,
  Tool as AnthropicTool,
  ToolUseBlock,
  TextBlock,
  BetaRawMessageStreamEvent,
  BetaContentBlock,
} from '../../utils/anthropic-types';
import type { Logger } from '../../utils/logger';
import type { ProviderName, ApiProvider } from '../../utils/protocol';
import { createProvider } from '../../utils/protocol';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const API_BASE = 'https://api.anthropic.com';
const API_VERSION = '2024-10-22';

export interface ApiClientOptions {
  apiKey?: string;
  model: string;
  maxTokens: number;
  maxThinkingTokens?: number;
  baseURL?: string;
  logger: Logger;
  /** API provider name. Auto-detected from baseURL if not specified. */
  provider?: ProviderName;
}

export interface ApiRequestOptions {
  system: string;
  messages: MessageParam[];
  tools?: AnthropicTool[];
  signal?: AbortSignal;
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

export class AnthropicApiClient {
  private options: ApiClientOptions;
  private logger: Logger;
  private baseUrl: string;
  private provider: ApiProvider;
  private providerName: ProviderName;

  constructor(options: ApiClientOptions) {
    this.options = options;
    this.logger = options.logger;
    this.baseUrl = options.baseURL || process.env.ANTHROPIC_BASE_URL || API_BASE;
    this.providerName = options.provider || this.detectProvider(this.baseUrl);
    this.provider = createProvider({
      name: this.providerName,
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY || '',
      model: options.model,
      baseURL: this.baseUrl,
    });
  }

  /**
   * Auto-detect provider from baseURL patterns.
   */
  private detectProvider(baseURL: string): ProviderName {
    const url = baseURL.toLowerCase();
    // Dashscope direct API (OpenAI-compatible): dashscope.aliyuncs.com
    if (url.includes('dashscope') && !url.includes('anthropic')) {
      return 'openai';
    }
    // SiliconFlow, OpenRouter, etc. — all OpenAI-compatible
    if (url.includes('siliconflow') || url.includes('openrouter')) {
      return 'openai';
    }
    // Anthropic proxy (Dashscope Anthropic endpoint, etc.) — accepts Anthropic format
    if (url.includes('dashscope') && url.includes('anthropic')) {
      return 'anthropic-proxy';
    }
    // Default: official Anthropic API
    return 'anthropic';
  }

  async createMessage(opts: ApiRequestOptions): Promise<ApiResponse> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.doCreateMessage(opts);
      } catch (err) {
        lastError = err as Error;
        if (attempt < MAX_RETRIES && this.isRetryable(err)) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random());
          this.logger.warn(`API request failed, retrying in ${delay}ms`, {
            attempt,
            error: (err as Error).message,
          });
          await this.sleep(delay, opts.signal);
        }
      }
    }

    throw lastError || new Error('API request failed after retries');
  }

  async *createMessageStream(
    opts: ApiRequestOptions,
  ): AsyncGenerator<StreamEvent, ApiResponse, unknown> {
    const params = this.buildParams(opts);
    const contentBlocks: Array<TextBlock | ToolUseBlock> = [];
    let currentToolUse: Partial<ToolUseBlock> | null = null;
    let textBuffer = '';
    let toolJsonAccumulator = ''; // Per-stream local variable
    let stopReason: string | null = null;
    let usage = { input_tokens: 0, output_tokens: 0 };
    let model = this.options.model;
    let id = '';

    const stream = this.fetchSSE(params, opts.signal);

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const msg = event.message;
            if (msg) {
              id = msg.id;
              model = msg.model;
              usage = {
                input_tokens: msg.usage?.input_tokens ?? 0,
                output_tokens: msg.usage?.output_tokens ?? 0,
              };
            }
            break;
          }
          case 'content_block_start': {
            const block = event.content_block;
            if (block?.type === 'text') {
              textBuffer = '';
            } else if (block?.type === 'tool_use') {
              currentToolUse = {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: {},
              };
              yield { type: 'tool_use_start', toolName: block.name, toolId: block.id };
            }
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta;
            if (delta?.type === 'text_delta') {
              textBuffer += delta.text;
              yield { type: 'text_delta', text: delta.text };
            } else if (delta?.type === 'input_json_delta' && currentToolUse) {
              if (delta.partial_json) {
                toolJsonAccumulator += delta.partial_json;
              }
            }
            break;
          }
          case 'content_block_stop': {
            if (textBuffer) {
              contentBlocks.push({ type: 'text', text: textBuffer });
              textBuffer = '';
            }
            if (currentToolUse) {
              if (toolJsonAccumulator) {
                try {
                  currentToolUse.input = JSON.parse(toolJsonAccumulator);
                } catch {
                  currentToolUse.input = {};
                }
              }
              contentBlocks.push(currentToolUse as ToolUseBlock);
              currentToolUse = null;
              toolJsonAccumulator = '';
            }
            break;
          }
          case 'message_delta': {
            stopReason = event.delta?.stop_reason ?? null;
            if (event.usage) {
              usage = {
                input_tokens: usage.input_tokens,
                output_tokens: event.usage.output_tokens ?? usage.output_tokens,
              };
            }
            break;
          }
          case 'message_stop':
            break;
        }
      }
    } catch (err) {
      this.logger.warn('Stream interrupted', { error: (err as Error).message });
    }

    yield { type: 'stop' };

    return {
      content: contentBlocks,
      stopReason,
      usage,
      model,
      id,
    };
  }

  private async doCreateMessage(opts: ApiRequestOptions): Promise<ApiResponse> {
    const body = this.provider.buildRequestBody({
      model: this.options.model,
      messages: opts.messages,
      system: opts.system,
      tools: opts.tools,
      maxTokens: this.options.maxTokens,
    });
    const response = await fetch(`${this.baseUrl}${this.provider.getEndpoint()}`, {
      method: 'POST',
      headers: this.provider.buildHeaders(),
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    return this.provider.parseResponse(data);
  }

  private buildParams(opts: ApiRequestOptions): Record<string, unknown> {
    const params = this.provider.buildRequestBody({
      model: this.options.model,
      messages: opts.messages,
      system: opts.system,
      tools: opts.tools,
      maxTokens: this.options.maxTokens,
    });

    // Anthropic-specific: thinking budget (OpenAI provider ignores this)
    if (this.options.maxThinkingTokens) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: this.options.maxThinkingTokens,
      };
    }

    return params;
  }

  private buildHeaders(): Record<string, string> {
    return this.provider.buildHeaders();
  }

  private async *fetchSSE(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<BetaRawMessageStreamEvent, void> {
    const response = await fetch(`${this.baseUrl}${this.provider.getEndpoint()}`, {
      method: 'POST',
      headers: {
        ...this.provider.buildHeaders(),
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...params, stream: true }),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`API error ${response.status}: ${errorBody}`);
    }

    const body = response.body;
    if (!body) {
      throw new Error('Response body is null');
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.startsWith('data: ')
              ? trimmed.slice(6)
              : trimmed.slice(5);
            try {
              const raw = JSON.parse(dataStr);
              // For OpenAI provider, convert SSE events to Anthropic format
              if (this.providerName === 'openai') {
                // OpenAI SSE: data: { id, object: 'chat.completion.chunk', choices: [...] }
                const converted = this.provider.parseSSEEvent('chunk', raw);
                if (converted) yield converted;
              } else {
                // Anthropic SSE: direct BetaRawMessageStreamEvent
                const parsed = raw as BetaRawMessageStreamEvent;
                yield parsed;
              }
            } catch {
              this.logger.debug('SSE parse error', { data: dataStr.slice(0, 100) });
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private isRetryable(err: unknown): boolean {
    const msg = (err as Error).message.toLowerCase();
    const status = (err as any).status;
    return (
      msg.includes('rate_limit') ||
      msg.includes('overloaded') ||
      msg.includes('timeout') ||
      (typeof status === 'number' && status >= 500)
    );
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      }, { once: true });
    });
  }
}
