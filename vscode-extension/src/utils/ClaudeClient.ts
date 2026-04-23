/**
 * ClaudeClient - Handles communication with the Anthropic API.
 *
 * This client wraps the Anthropic Messages API, providing streaming
 * completions and message history management for the VSCode extension.
 *
 * It reads API configuration from VSCode settings and falls back to
 * environment variables.
 */
import * as vscode from 'vscode';
import { Semaphore } from './Semaphore';

/** Streaming completion callbacks */
interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

/** ContentBlock for tool use format */
export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

/** Message format for the API */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** Agent loop callbacks */
interface AgentCallbacks {
  onChunk: (text: string) => void;
  onToolStart: (toolUse: ContentBlock) => void;
  onToolComplete: (toolUse: ContentBlock, result: unknown) => void;
  onToolError: (toolUse: ContentBlock, error: string) => void;
  onToolConfirmation: (toolUse: ContentBlock) => Promise<boolean>;
  onIteration: (current: number, max: number) => void;
  onComplete: (stopReason: string) => void;
  onError: (error: Error) => void;
}

/** Retry configuration for transient failures */
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;

/**
 * ClaudeClient manages the connection to the Anthropic API.
 * It handles authentication, request formatting, and streaming.
 */
export class ClaudeClient {
  private apiKey: string | undefined;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private baseUrl: string;
  private abortController: AbortController | null = null;
  private provider: 'anthropic' | 'openai';
  private openaiBaseUrl: string;
  private openaiApiKey: string;
  private openaiModel: string;

  private mcpManagerInstance: any = null;

  constructor(apiKey?: string) {
    const config = vscode.workspace.getConfiguration('claude');
    this.apiKey = apiKey || config.get<string>('apiKey') || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    this.model = config.get<string>('model', 'claude-sonnet-4-20250514');
    this.maxTokens = config.get<number>('maxTokens', 8192);
    this.temperature = config.get<number>('temperature', 0);
    this.baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    this.provider = config.get<'anthropic' | 'openai'>('provider', 'anthropic');
    this.openaiApiKey = config.get<string>('openaiApiKey', '');
    this.openaiBaseUrl = config.get<string>('openaiBaseUrl', 'http://localhost:11434');
    this.openaiModel = config.get<string>('openaiModel', '');
  }

  /**
   * Handle configuration changes (reload settings).
   * Note: apiKey is NOT reloaded here - it's managed separately via SecretStorage.
   */
  onConfigChanged(): void {
    const config = vscode.workspace.getConfiguration('claude');
    this.model = config.get<string>('model', 'claude-sonnet-4-20250514');
    this.maxTokens = config.get<number>('maxTokens', 8192);
    this.temperature = config.get<number>('temperature', 0);
    this.provider = config.get<'anthropic' | 'openai'>('provider', 'anthropic');
    this.openaiApiKey = config.get<string>('openaiApiKey', '');
    this.openaiBaseUrl = config.get<string>('openaiBaseUrl', 'http://localhost:11434');
    this.openaiModel = config.get<string>('openaiModel', '');
  }

  /**
   * Set API key from SecretStorage (called after setApiKey command).
   */
  async loadApiKeyFromSecretStorage(context: vscode.ExtensionContext): Promise<void> {
    const fromSecret = await context.secrets.get('claude-api-key');
    if (fromSecret) {
      this.apiKey = fromSecret;
    } else {
      const config = vscode.workspace.getConfiguration('claude');
      this.apiKey = config.get<string>('apiKey') || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    }
  }

  /**
   * Check if the client is properly configured.
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Stream a completion from the Claude API with retry logic.
   * Dispatches to the appropriate provider based on configuration.
   *
   * @param messages - Array of messages to send
   * @param callbacks - Streaming callbacks
   */
  async streamCompletion(messages: ApiMessage[], callbacks: StreamCallbacks): Promise<void> {
    if (!this.isConfigured() && this.provider === 'anthropic') {
      callbacks.onError(new Error(
        'API key not configured. Set "claude.apiKey" in VSCode settings or ANTHROPIC_API_KEY environment variable.'
      ));
      return;
    }
    if (this.provider === 'openai') {
      return this.streamOpenAI(messages, callbacks);
    }
    return this.streamAnthropic(messages, callbacks);
  }

  /**
   * Stream from the Anthropic API with retry logic.
   */
  private async streamAnthropic(messages: ApiMessage[], callbacks: StreamCallbacks): Promise<void> {

    // Separate system prompt from messages
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemPrompt = systemMessages.map(m => m.content).join('\n\n');
    const apiMessages = messages.filter(m => m.role !== 'system');

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Abort any in-flight request before starting a new one
      this.abortController?.abort();
      this.abortController = new AbortController();
      const { signal } = this.abortController;

      try {
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey!,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            system: systemPrompt,
            messages: apiMessages.map(m => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })),
            stream: true,
          }),
          signal,
        });

        // Retry on transient errors: 429 (rate limit) and 5xx (server errors)
        if (!response.ok && (response.status === 429 || response.status >= 500)) {
          const retryAfter = this.getRetryAfter(response, attempt);
          lastError = new Error(`API error ${response.status}: ${await response.text()}`);
          if (attempt < MAX_RETRIES) {
            await this.delay(retryAfter);
            continue;
          }
          callbacks.onError(new Error(`Failed after ${MAX_RETRIES} retries: ${lastError.message}`));
          return;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          callbacks.onError(new Error(`API error ${response.status}: ${errorBody}`));
          return;
        }

        if (!response.body) {
          callbacks.onError(new Error('No response body from API'));
          return;
        }

        // Process the streaming response with a guard to prevent double onComplete
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let completed = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process SSE frames from the buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;

            if (trimmed.startsWith('data: ')) {
              const data = trimmed.slice(6);
              if (data === '[DONE]') {
                if (!completed) {
                  completed = true;
                  callbacks.onComplete();
                }
                return;
              }

              try {
                const parsed = JSON.parse(data);
                this.handleStreamEvent(parsed, callbacks, () => {
                  if (!completed) {
                    completed = true;
                    callbacks.onComplete();
                  }
                });
              } catch (e) {
                // Skip malformed JSON
              }
            }
          }
        }

        // Final onComplete guard for normal stream end without [DONE]
        if (!completed) {
          completed = true;
          callbacks.onComplete();
        }
        return;
      } catch (error) {
        // AbortError means the request was cancelled (e.g. dispose or retry)
        if (error instanceof Error && error.name === 'AbortError') {
          continue;
        }

        // Network errors are retriable
        if (attempt < MAX_RETRIES) {
          const delayMs = this.getRetryDelay(attempt);
          lastError = error instanceof Error ? error : new Error(String(error));
          await this.delay(delayMs);
          continue;
        }

        const finalError = error instanceof Error ? error : new Error(String(error));
        callbacks.onError(new Error(`Failed after ${MAX_RETRIES} retries: ${finalError.message}`));
        return;
      }
    }

    // Exhausted all retries
    if (lastError) {
      callbacks.onError(new Error(`Failed after ${MAX_RETRIES} retries: ${lastError.message}`));
    }
  }

  /**
   * Stream from an OpenAI-compatible API with retry logic.
   */
  private async streamOpenAI(messages: ApiMessage[], callbacks: StreamCallbacks): Promise<void> {
    const { buildOpenAIRequest, parseOpenAISSE } = await import('../api/openai-adapter');

    const systemMessages = messages.filter(m => m.role === 'system');
    const systemPrompt = systemMessages.map(m => m.content).join('\n\n');

    const { url, init } = buildOpenAIRequest(
      messages.map(m => ({ role: m.role, content: m.content })),
      {
        baseUrl: this.openaiBaseUrl,
        apiKey: this.openaiApiKey || this.apiKey || '',
        model: this.openaiModel || this.model,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
        systemPrompt,
      }
    );

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.abortController?.abort();
      this.abortController = new AbortController();
      const { signal } = this.abortController;

      try {
        const response = await fetch(url, { ...init, signal });
        if (!response.ok && (response.status === 429 || response.status >= 500)) {
          const retryAfter = this.getRetryAfter(response, attempt);
          lastError = new Error(`API error ${response.status}: ${await response.text()}`);
          if (attempt < MAX_RETRIES) {
            await this.delay(retryAfter);
            continue;
          }
          callbacks.onError(new Error(`Failed after ${MAX_RETRIES} retries: ${lastError.message}`));
          return;
        }
        if (!response.ok) {
          callbacks.onError(new Error(`API error ${response.status}: ${await response.text()}`));
          return;
        }
        if (!response.body) {
          callbacks.onError(new Error('No response body from API'));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let completed = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (!trimmed.startsWith('data: ')) continue;

            const event = parseOpenAISSE(trimmed);
            if (event.type === 'chunk') {
              callbacks.onChunk(event.text!);
            }
            if (event.type === 'done') {
              if (!completed) {
                completed = true;
                callbacks.onComplete();
              }
              return;
            }
          }
        }

        if (!completed) {
          completed = true;
          callbacks.onComplete();
        }
        return;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          continue;
        }
        if (attempt < MAX_RETRIES) {
          await this.delay(this.getRetryDelay(attempt));
          continue;
        }
        callbacks.onError(new Error(`Failed after ${MAX_RETRIES} retries: ${error}`));
        return;
      }
    }

    if (lastError) {
      callbacks.onError(new Error(`Failed after ${MAX_RETRIES} retries: ${lastError.message}`));
    }
  }

  /**
   * Cancel any in-flight streaming request.
   */
  cancel(): void {
    this.abortController?.abort();
  }

  /**
   * Handle a single stream event from the SSE response.
   */
  private handleStreamEvent(
    event: Record<string, unknown>,
    callbacks: StreamCallbacks,
    onComplete: () => void
  ): void {
    const eventType = event.type as string | undefined;

    switch (eventType) {
      case 'content_block_start':
        // Start of a new content block
        break;

      case 'content_block_delta': {
        const delta = event.delta as Record<string, string> | undefined;
        if (delta?.type === 'text_delta') {
          callbacks.onChunk(delta.text);
        }
        break;
      }

      case 'content_block_stop':
        // End of a content block
        break;

      case 'message_start':
        // Message started
        break;

      case 'message_delta':
        // Message delta (for stop_reason, etc.)
        break;

      case 'message_stop':
        onComplete();
        break;

      case 'ping':
        // Keepalive, ignore
        break;

      case 'error': {
        const error = event.error as Record<string, string> | undefined;
        callbacks.onError(new Error(error?.message || 'Stream error'));
        break;
      }
    }
  }

  /**
   * Determine retry delay based on response headers (Retry-After) or exponential backoff.
   */
  private getRetryAfter(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
      }
    }
    return this.getRetryDelay(attempt);
  }

  /**
   * Calculate exponential backoff delay with jitter.
   */
  private getRetryDelay(attempt: number): number {
    const baseDelay = Math.min(
      INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt),
      MAX_RETRY_DELAY_MS
    );
    // Add jitter (+/- 25%)
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.round(baseDelay + jitter);
  }

  /**
   * Helper to delay execution.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Non-streaming API call for the agent loop.
   * Returns the full response with content blocks.
   */
  private async callAPI(messages: ApiMessage[]): Promise<{ content: ContentBlock[]; stopReason?: string }> {
    if (!this.apiKey) throw new Error('API key not configured');

    const systemMessages = messages.filter(m => m.role === 'system');
    const systemPrompt = systemMessages.map(m => m.content).join('\n\n');
    const apiMessages = messages.filter(m => m.role !== 'system');

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: systemPrompt,
        messages: apiMessages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`API error ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  /**
   * Agent loop with tool use cycling.
   * Executes tools iteratively until the model stops requesting them.
   */
  async agentLoop(messages: ApiMessage[], callbacks: AgentCallbacks): Promise<void> {
    let iteration = 0;
    const maxIterations = vscode.workspace.getConfiguration('claude').get<number>('maxAgentIterations', 25);

    while (iteration < maxIterations) {
      iteration++;
      callbacks.onIteration(iteration, maxIterations);

      const response = await this.callAPI(messages);

      const textBlocks = response.content.filter((b: ContentBlock) => b.type === 'text');
      const toolUses = response.content.filter((b: ContentBlock) => b.type === 'tool_use');

      for (const textBlock of textBlocks) {
        callbacks.onChunk(textBlock.text || '');
      }

      if (toolUses.length === 0) {
        callbacks.onComplete(response.stopReason || 'end_turn');
        break;
      }

      messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Concurrent tool execution with semaphore
      const maxConcurrent = vscode.workspace.getConfiguration('claude').get<number>('maxConcurrentTools', 3);
      const semaphore = new Semaphore(maxConcurrent);

      const toolResults = await Promise.allSettled(
        toolUses.map(async (toolUse: ContentBlock) => {
          await semaphore.acquire();
          try {
            callbacks.onToolStart(toolUse);

            if (this.requiresConfirmation(toolUse.name!)) {
              const approved = await callbacks.onToolConfirmation(toolUse);
              if (!approved) {
                return {
                  type: 'tool_result' as const,
                  tool_use_id: toolUse.id!,
                  content: 'User denied',
                  is_error: true,
                };
              }
            }

            const result = await this.executeTool(toolUse);
            callbacks.onToolComplete(toolUse, result);
            return {
              type: 'tool_result' as const,
              tool_use_id: toolUse.id!,
              content: JSON.stringify(result),
            };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            callbacks.onToolError(toolUse, errorMsg);
            return {
              type: 'tool_result' as const,
              tool_use_id: toolUse.id!,
              content: `Error: ${errorMsg}`,
              is_error: true,
            };
          } finally {
            semaphore.release();
          }
        })
      );

      messages.push({
        role: 'user',
        content: toolResults.map((r, i) => {
          if (r.status === 'fulfilled') return r.value;
          return {
            type: 'tool_result' as const,
            tool_use_id: toolUses[i].id!,
            content: `Error: ${r.reason}`,
            is_error: true,
          };
        }),
      });
    }
  }

  /**
   * Check if a tool requires user confirmation.
   */
  private requiresConfirmation(toolName: string): boolean {
    const dangerousTools = ['Bash', 'Write', 'Edit'];
    return dangerousTools.includes(toolName);
  }

  /**
   * Execute a tool via MCP or built-in handlers.
   */
  private async executeTool(toolUse: ContentBlock): Promise<unknown> {
    const name = toolUse.name;
    const input = toolUse.input || {};

    const mcpManager = await this.getMCPManager();
    if (mcpManager) {
      try {
        return await mcpManager.callTool(name, input);
      } catch {
        // Fall through to error
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Get or create the MCP manager singleton.
   */
  async getMCPManager(): Promise<any> {
    if (!this.mcpManagerInstance) {
      try {
        const { MCPClientManager } = await import('../mcp/MCPClientManager');
        this.mcpManagerInstance = new MCPClientManager();
        await this.mcpManagerInstance.initialize();
      } catch {
        return null;
      }
    }
    return this.mcpManagerInstance;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.cancel();
  }
}
