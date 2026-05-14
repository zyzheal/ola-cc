import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { ToolDefinition, ToolResult, ToolContext } from '../agent/tool-registry';

const DEFAULT_LIMIT = 2000;

export const ReadTool: ToolDefinition = {
  name: 'Read',
  description: 'Read the contents of a file. Supports offset/limit for large files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
      offset: { type: 'integer', description: 'Start reading from this line (0-based, default: 0)' },
      limit: { type: 'integer', description: `Max lines to read (default: ${DEFAULT_LIMIT})` },
    },
    required: ['path'],
  },
  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const path = input.path as string;
    const offset = (input.offset as number) ?? 0;
    const limit = (input.limit as number) ?? DEFAULT_LIMIT;

    // Security: resolve and validate path is within cwd
    const resolvedCwd = resolve(context.cwd);
    const fullPath = resolve(resolvedCwd, path);
    if (!fullPath.startsWith(resolvedCwd)) {
      return { content: [{ type: 'text', text: `Access denied: path escapes cwd (${path})` }], isError: true };
    }

    try {
      const content = await readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const slice = lines.slice(offset, offset + limit);
      const truncated = lines.length > offset + limit;
      const lineNumbers = slice.map((line, i) => `${offset + i + 1}: ${line}`).join('\n');
      const suffix = truncated ? `\n... (${lines.length - offset - limit} more lines)` : '';
      return {
        content: [{ type: 'text', text: `${lineNumbers}${suffix}` }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error reading ${path}: ${message}` }], isError: true };
    }
  },
};
