// sdk-recovery/src/cli/tools/grep-tool.ts
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition, ToolContext } from '../agent/tool-registry';

const execAsync = promisify(exec);

export const GrepTool: ToolDefinition = {
  name: 'Grep',
  description: 'Search for a pattern in files using ripgrep (rg) or grep. Returns matching lines.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (regex supported)' },
      path: { type: 'string', description: 'File or directory to search in (default: cwd)' },
      glob: { type: 'string', description: 'File glob filter (e.g., "*.ts")' },
      case_sensitive: { type: 'boolean', description: 'Case sensitive search (default: false)' },
    },
    required: ['pattern'],
  },
  async execute(input: Record<string, unknown>, context: ToolContext) {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) ?? context.cwd;
    const glob = input.glob as string | undefined;
    const caseSensitive = input.case_sensitive as boolean | undefined;

    const grepCmd = await findGrepCmd();
    const flags = [caseSensitive ? '' : '-i', glob ? `--glob "${glob}"` : ''].filter(Boolean).join(' ');
    const cmd = `${grepCmd} ${flags} -n "${pattern}" "${searchPath}" 2>&1 | head -100`;

    try {
      const { stdout } = await execAsync(cmd, { timeout: 10000 });
      if (!stdout.trim()) {
        return { content: [{ type: 'text', text: `No matches found for "${pattern}"` }] };
      }
      return { content: [{ type: 'text', text: stdout.trim() }] };
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as any).code === 1) {
        return { content: [{ type: 'text', text: `No matches found for "${pattern}"` }] };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Grep error: ${message}` }], isError: true };
    }
  },
};

async function findGrepCmd(): Promise<string> {
  try {
    await execAsync('rg --version');
    return 'rg';
  } catch {
    return 'grep -r';
  }
}
