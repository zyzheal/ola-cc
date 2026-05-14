/**
 * Types for process transport.
 */

/**
 * A child process with guaranteed pipe streams.
 * Unlike bare ChildProcess, stdin/stdout/stderr are always non-null
 * because we always spawn with stdio: ['pipe', 'pipe', 'pipe'].
 */
export interface SpawnedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: string): boolean;
  pid?: number;
}
