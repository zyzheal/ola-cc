import { MCPTool } from './MCPClientManager';

export class HTTPTransport {
  private url: string;
  private apiKey?: string;
  private controller: AbortController | null = null;

  constructor(url: string, apiKey?: string) {
    this.url = url;
    this.apiKey = apiKey;
  }

  async connect(): Promise<void> {
    this.controller = new AbortController();
  }

  async listTools(): Promise<MCPTool[]> {
    const response = await fetch(`${this.url}/tools`, {
      headers: this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {},
      signal: this.controller?.signal,
    });
    if (!response.ok) throw new Error(`Failed to list tools: ${response.statusText}`);
    const data = await response.json();
    return data.tools || [];
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.url}/tools/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ input }),
      signal: this.controller?.signal,
    });
    if (!response.ok) throw new Error(`Tool call failed: ${response.statusText}`);
    return response.json();
  }

  disconnect(): void {
    this.controller?.abort();
    this.controller = null;
  }
}
