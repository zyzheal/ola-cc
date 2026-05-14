// sdk-recovery/src/cli/tools/glob-tool.ts
import fastGlob from 'fast-glob';
import type { ToolDefinition, ToolContext } from '../agent/tool-registry';

export const GlobTool: ToolDefinition = {
  name: 'Glob',
  description: 'Find files matching a glob pattern using fast-glob syntax.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts")' },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
    },
    required: ['pattern'],
  },
  async execute(input: Record<string, unknown>, context: ToolContext) {
    const pattern = input.pattern as string;
    const cwd = (input.path as string) ?? context.cwd;

    try {
      const matches = await fastGlob(pattern, { cwd, absolute: false, dot: false });
      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `No files matched "${pattern}"` }] };
      }
      return {
        content: [{ type: 'text', text: matches.slice(0, 100).join('\n') + (matches.length > 100 ? `\n... and ${matches.length - 100} more` : '') }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Glob error: ${message}` }], isError: true };
    }
  },
};
