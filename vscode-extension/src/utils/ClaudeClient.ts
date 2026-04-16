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

/** Streaming completion callbacks */
interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

/** Message format for the API */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

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

  constructor() {
    const config = vscode.workspace.getConfiguration('claude');
    this.apiKey = config.get<string>('apiKey') || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    this.model = config.get<string>('model', 'claude-sonnet-4-20250514');
    this.maxTokens = config.get<number>('maxTokens', 8192);
    this.temperature = config.get<number>('temperature', 0);
    this.baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  }

  /**
   * Handle configuration changes (reload settings).
   */
  onConfigChanged(): void {
    const config = vscode.workspace.getConfiguration('claude');
    this.apiKey = config.get<string>('apiKey') || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    this.model = config.get<string>('model', 'claude-sonnet-4-20250514');
    this.maxTokens = config.get<number>('maxTokens', 8192);
    this.temperature = config.get<number>('temperature', 0);
  }

  /**
   * Check if the client is properly configured.
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Stream a completion from the Claude API.
   *
   * @param messages - Array of messages to send
   * @param callbacks - Streaming callbacks
   */
  async streamCompletion(messages: ApiMessage[], callbacks: StreamCallbacks): Promise<void> {
    if (!this.isConfigured()) {
      callbacks.onError(new Error(
        'API key not configured. Set "claude.apiKey" in VSCode settings or ANTHROPIC_API_KEY environment variable.'
      ));
      return;
    }

    // Separate system prompt from messages
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemPrompt = systemMessages.map(m => m.content).join('\n\n');
    const apiMessages = messages.filter(m => m.role !== 'system');

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey!,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'message-batches-2024-09-24',
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
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`API error ${response.status}: ${errorBody}`);
      }

      if (!response.body) {
        throw new Error('No response body from API');
      }

      // Process the streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

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
              callbacks.onComplete();
              return;
            }

            try {
              const parsed = JSON.parse(data);
              this.handleStreamEvent(parsed, callbacks);
            } catch (e) {
              // Skip malformed JSON
            }
          }
        }
      }

      callbacks.onComplete();
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Handle a single stream event from the SSE response.
   */
  private handleStreamEvent(event: Record<string, unknown>, callbacks: StreamCallbacks): void {
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
        callbacks.onComplete();
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
   * Clean up resources.
   */
  dispose(): void {
    // Nothing to clean up currently
  }
}
