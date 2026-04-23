import * as vscode from 'vscode';
import { HTTPTransport } from './HTTPTransport';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class MCPClientManager {
  private transports: HTTPTransport[] = [];
  private tools: Map<string, { tool: MCPTool; transport: HTTPTransport }> = new Map();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const config = vscode.workspace.getConfiguration('claude');
    const servers = config.get<Record<string, { url: string; apiKey?: string }>>('mcpServers', {});

    for (const [name, serverConfig] of Object.entries(servers)) {
      try {
        const transport = new HTTPTransport(serverConfig.url, serverConfig.apiKey);
        await transport.connect();
        const tools = await transport.listTools();
        this.transports.push(transport);
        for (const tool of tools) {
          this.tools.set(tool.name, { tool, transport });
        }
      } catch (e) {
        console.error(`Failed to connect to MCP server "${name}":`, e);
      }
    }

    this.initialized = true;
  }

  getTools(): MCPTool[] {
    return Array.from(this.tools.values()).map(({ tool }) => tool);
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Unknown MCP tool: ${name}`);
    return entry.transport.callTool(name, input);
  }

  dispose(): void {
    for (const transport of this.transports) {
      transport.disconnect();
    }
    this.transports = [];
    this.tools.clear();
    this.initialized = false;
  }
}
