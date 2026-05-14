import { spawn } from 'node:child_process';
import type { ToolDefinition, ToolContext } from '../agent/tool-registry';
import { checkCommandDanger } from '../security/blacklist';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;

export const BashTool: ToolDefinition = {
  name: 'Bash',
  description: 'Execute a bash command and return its output. Use for running shell commands.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      timeout: { type: 'integer', description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})` },
    },
    required: ['command'],
  },
  async execute(input: Record<string, unknown>, context: ToolContext) {
    const command = input.command as string;
    const timeout = Math.min(
      (input.timeout as number) ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    // Security check: validate command against blacklist
    const dangerCheck = checkCommandDanger(command);
    if (dangerCheck.isDangerous) {
      return {
        content: [{ type: 'text', text: `Command blocked: ${dangerCheck.reason}` }],
        isError: true,
      };
    }

    return new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: context.cwd,
        timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        resolve({
          content: [{ type: 'text', text: `Command error: ${err.message}` }],
          isError: true,
        });
      });

      child.on('exit', (code, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          resolve({
            content: [{ type: 'text', text: `Command timeout after ${timeout}ms` }],
            isError: true,
          });
          return;
        }

        const output = [stdout, stderr].filter(Boolean).join('\n');
        if (code !== 0) {
          resolve({
            content: [{ type: 'text', text: `Exit code ${code}: ${output}` }],
            isError: true,
          });
        } else {
          resolve({
            content: [{ type: 'text', text: output || '(no output)' }],
          });
        }
      });
    });
  },
};
