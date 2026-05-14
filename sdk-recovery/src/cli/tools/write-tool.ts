import { writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import type { ToolDefinition, ToolContext } from '../agent/tool-registry';

export const WriteTool: ToolDefinition = {
  name: 'Write',
  description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(input: Record<string, unknown>, context: ToolContext) {
    const path = input.path as string;
    const content = input.content as string;

    // Security: resolve and validate path is within cwd
    const resolvedCwd = resolve(context.cwd);
    const fullPath = resolve(resolvedCwd, path);
    if (!fullPath.startsWith(resolvedCwd)) {
      return { content: [{ type: 'text', text: `Access denied: path escapes cwd (${path})` }], isError: true };
    }

    try {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
      const lines = content.split('\n').length;
      return {
        content: [{ type: 'text', text: `Successfully wrote ${lines} lines to ${path}` }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error writing ${path}: ${message}` }], isError: true };
    }
  },
};
