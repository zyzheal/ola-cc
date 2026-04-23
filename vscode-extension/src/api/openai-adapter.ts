/**
 * OpenAI-compatible API adapter for ClaudeClient.
 * Builds HTTP requests and parses SSE responses in OpenAI format.
 */

export interface OpenAIRequestOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
}

export interface SSEEvent {
  type: 'chunk' | 'done' | 'ignore';
  text?: string;
}

export function buildOpenAIRequest(
  messages: Array<{ role: string; content: string }>,
  opts: OpenAIRequestOptions
): { url: string; init: RequestInit } {
  const systemMessages = messages.filter(m => m.role === 'system');
  const systemPrompt = opts.systemPrompt || systemMessages.map(m => m.content).join('\n\n');
  const apiMessages = messages.filter(m => m.role !== 'system');

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...apiMessages.map(m => ({ role: m.role, content: m.content })),
    ],
    stream: true,
  };

  return {
    url: `${opts.baseUrl}/v1/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
    },
  };
}

export function parseOpenAISSE(line: string): SSEEvent {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return { type: 'ignore' };
  if (!trimmed.startsWith('data: ')) return { type: 'ignore' };

  const data = trimmed.slice(6);
  if (data === '[DONE]') return { type: 'done' };

  try {
    const parsed = JSON.parse(data);
    const content = parsed.choices?.[0]?.delta?.content;
    if (content) return { type: 'chunk', text: content };
    if (parsed.choices?.[0]?.finish_reason) return { type: 'done' };
    return { type: 'ignore' };
  } catch {
    return { type: 'ignore' };
  }
}
