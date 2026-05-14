import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  SdkMcpToolDefinition,
  CreateSdkMcpServerOptions,
  McpSdkServerConfigWithInstance,
} from './types';
import { z } from 'zod/v4';
import type { ZodRawShape, ZodObject } from 'zod/v4';

export function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (
    args: z.infer<ZodObject<Schema>>,
    extra: unknown,
  ) => Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>,
): SdkMcpToolDefinition<Schema> {
  return {
    name,
    description,
    inputSchema,
    handler,
  };
}

export async function createSdkMcpServer(
  options: CreateSdkMcpServerOptions,
): Promise<McpSdkServerConfigWithInstance> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

  const instance = new McpServer({
    name: options.name,
    version: options.version || '0.1.0',
  });

  for (const toolDef of options.tools ?? []) {
    const zodSchema = z.object(toolDef.inputSchema) as ZodObject<ZodRawShape>;

    instance.tool(
      toolDef.name,
      toolDef.description,
      toolDef.inputSchema,
      async (args: Record<string, unknown>) => {
        return toolDef.handler(args, {});
      },
    );
  }

  return {
    type: 'sdk',
    name: options.name,
    instance,
  };
}
