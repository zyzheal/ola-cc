import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { ToolDefinition, ToolContext } from '../agent/tool-registry';

export const EditTool: ToolDefinition = {
  name: 'Edit',
  description: 'Replace text in a file using exact string matching. Use old_string to find the text to replace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
      old_string: { type: 'string', description: 'Exact text to find and replace' },
      new_string: { type: 'string', description: 'Text to replace old_string with' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input: Record<string, unknown>, context: ToolContext) {
    const path = input.path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;

    // Security: resolve and validate path is within cwd
    const resolvedCwd = resolve(context.cwd);
    const fullPath = resolve(resolvedCwd, path);
    if (!fullPath.startsWith(resolvedCwd)) {
      return { content: [{ type: 'text', text: `Access denied: path escapes cwd (${path})` }], isError: true };
    }

    try {
      const content = await readFile(fullPath, 'utf-8');
      if (!content.includes(oldString)) {
        return {
          content: [{ type: 'text', text: `Could not find "${oldString.slice(0, 50)}..." in ${path}` }],
          isError: true,
        };
      }
      const newContent = content.replace(oldString, newString);
      await writeFile(fullPath, newContent, 'utf-8');
      const diffLines = newContent.split('\n').length - content.split('\n').length;
      const sign = diffLines >= 0 ? '+' : '';
      return {
        content: [{ type: 'text', text: `Successfully edited ${path} (${sign}${diffLines} lines)` }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error editing ${path}: ${message}` }], isError: true };
    }
  },
};
