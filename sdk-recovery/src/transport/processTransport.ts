import { spawn } from 'node:child_process';
import type {
  Options,
  SDKMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKControlInitializeResponse,
  SlashCommand,
  ModelInfo,
  AgentInfo,
  AccountInfo,
  SDKControlGetContextUsageResponse,
  SDKControlReadFileResponse,
  SDKControlReloadPluginsResponse,
  McpSetServersResult,
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  SpawnedProcess,
  SpawnOptions,
  OnElicitation,
  HookInput,
  HookJSONOutput,
  SyncHookJSONOutput,
} from '../types';
import { NdjsonParser } from './ndjson';
import type { SpawnedProcess as SpawnedProcessType } from './processTransportTypes';
import type { Logger } from '../utils/logger';
import { MessageNormalizer } from '../utils/message-normalizer';
import { randomUUID } from 'node:crypto';

/** Pending control request awaiting CLI response */
type PendingControlRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type ProcessTransportOptions = Pick<Options, 'cwd' | 'env' | 'executableArgs' | 'stderr'> & {
  envFile?: string;
  /** Full options object for serialization to environment variables */
  options?: Options;
  /** Custom spawn function for running CLI in VMs/containers */
  spawnFn?: (options: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) => SpawnedProcessType;
  /** Permission handler called before each tool execution */
  canUseTool?: CanUseTool;
  /** Elicitation handler for user confirmation dialogs */
  onElicitation?: OnElicitation;
  /** Hook registrations for various events */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Settings to pass to CLI */
  settings?: string | object;
};

export type StartOptions = ProcessTransportOptions;

export class ProcessTransport {
  private process: SpawnedProcessType | null = null;
  private parser = new NdjsonParser();
  private messageQueue: SDKMessage[] = [];
  private closed = false;
  private sessionId: string | null = null;
  private logger: Logger;
  private turnCount = 0;

  // -- heartbeat / keepalive --
  private lastStdoutAt: number = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutMs = 60_000;

  // -- initResult caching --
  private cachedInitResult: SDKControlInitializeResponse | null = null;
  private slashCommands: SlashCommand[] = [];
  private supportedModelsList: ModelInfo[] = [];
  private supportedAgentsList: AgentInfo[] = [];
  private accountInfoData: AccountInfo = { apiKeySource: 'user' };

  // -- control request/response routing --
  private pendingControlRequests = new Map<string, PendingControlRequest>();

  // -- options --
  private canUseTool?: CanUseTool;
  private onElicitation?: OnElicitation;
  private hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  private settings?: string | object;

  constructor(logger: Logger, options?: { canUseTool?: CanUseTool; onElicitation?: OnElicitation; hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>; settings?: string | object }) {
    this.logger = logger;
    this.canUseTool = options?.canUseTool;
    this.onElicitation = options?.onElicitation;
    this.hooks = options?.hooks;
    this.settings = options?.settings;
  }

  async start(opts: StartOptions): Promise<void> {
    const env = await this.buildEnv(opts);
    const cliPath = this.resolveCliPath(opts);

    this.logger.info('Spawning CLI process', { cliPath, cwd: opts.cwd });

    // Use custom spawnFn if provided, otherwise use default spawn
    if (opts.spawnFn) {
      this.process = opts.spawnFn({
        command: cliPath,
        args: opts.executableArgs ?? [],
        cwd: opts.cwd ?? process.cwd(),
        env,
      });
    } else {
      this.process = spawn(cliPath, opts.executableArgs ?? [], {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as SpawnedProcessType;
    }

    this.lastStdoutAt = Date.now();
    this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr.on('data', (chunk: Buffer) => this.handleStderr(chunk, opts));
    this.process.on('exit', (code, signal) => this.handleExit(code, signal));
    this.process.on('error', (err) => this.handleError(err));

    // Start heartbeat to detect hung CLI processes
    this.startHeartbeat();
  }

  async sendMessage(prompt: string): Promise<void> {
    if (!this.process?.stdin) throw new Error('Transport not started');

    const message = {
      content: [{ type: 'text', text: prompt }],
      session_id: this.sessionId ?? 'unknown',
      uuid: randomUUID(),
    };

    this.logger.debug('Sending message to CLI', { promptLength: prompt.length });
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  async sendMessageObj(msg: Record<string, unknown>): Promise<void> {
    if (!this.process?.stdin) throw new Error('Transport not started');
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Send a fire-and-forget control command (existing 4 commands).
   */
  async sendControl(action: string, params: Record<string, unknown>): Promise<void> {
    if (!this.process?.stdin) throw new Error('Transport not started');

    const cmd: Record<string, unknown> = { type: 'control', action, ...params };
    this.process.stdin.write(JSON.stringify(cmd) + '\n');
    this.logger.debug('Sent control command', { action, params });
  }

  /**
   * Send a control command with request_id-based Promise routing.
   * Returns a promise that resolves when the CLI responds.
   */
  async sendControlRequest(subtype: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin) throw new Error('Transport not started');
    if (this.closed || this.process?.pid === undefined) {
      throw new Error(`Cannot send control request '${subtype}': CLI process is not running`);
    }

    const requestId = randomUUID();
    const cmd: Record<string, unknown> = {
      type: 'control',
      action: subtype,
      request_id: requestId,
      ...params,
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingControlRequests.delete(requestId);
        reject(new Error(`Control request '${subtype}' timed out (request_id: ${requestId})`));
      }, 30000);

      this.pendingControlRequests.set(requestId, { resolve, reject, timeout });
    });

    const json = JSON.stringify(cmd) + '\n';
    const wrote = this.process.stdin.write(json);
    if (!wrote) {
      const pending = this.pendingControlRequests.get(requestId);
      if (pending) clearTimeout(pending.timeout);
      this.pendingControlRequests.delete(requestId);
      throw new Error(`Failed to write control request '${subtype}' to stdin`);
    }

    this.logger.debug('Sent control request', { subtype, requestId });
    return promise;
  }

  // -- initResult accessors --

  getInitResult(): SDKControlInitializeResponse {
    if (!this.cachedInitResult) {
      throw new Error('initResult not yet received from CLI');
    }
    return this.cachedInitResult;
  }

  getSlashCommands(): SlashCommand[] {
    return this.slashCommands;
  }

  getSupportedModels(): ModelInfo[] {
    return this.supportedModelsList;
  }

  getSupportedAgents(): AgentInfo[] {
    return this.supportedAgentsList;
  }

  getAccountInfo(): AccountInfo {
    return this.accountInfoData;
  }

  async *receiveMessages(): AsyncGenerator<SDKMessage, void> {
    while (!this.closed) {
      if (this.messageQueue.length > 0) {
        yield this.messageQueue.shift()!;
        continue;
      }

      // Poll with setImmediate to avoid race between queue push and promise resolve
      yield await new Promise<SDKMessage>((resolve) => {
        const check = () => {
          if (this.messageQueue.length > 0) {
            resolve(this.messageQueue.shift()!);
          } else if (this.closed) {
            resolve(undefined as unknown as SDKMessage); // sentinel for done
          } else {
            setImmediate(check);
          }
        };
        setImmediate(check);
      });
    }
  }

  interrupt(): Promise<void> {
    return this.sendControl('interrupt', {});
  }

  setPermissionMode(mode: string): Promise<void> {
    return this.sendControl('set_permission_mode', { mode });
  }

  setModel(model: string | null): Promise<void> {
    return this.sendControl('set_model', { model });
  }

  setMaxThinkingTokens(value: number | null): Promise<void> {
    return this.sendControl('set_max_thinking_tokens', { value });
  }

  cleanup(): void {
    // Reject all pending control requests
    for (const [requestId, pending] of this.pendingControlRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport closed'));
    }
    this.pendingControlRequests.clear();

    this.stopHeartbeat();

    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.closed = true;
  }

  // -- Heartbeat / keepalive --

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.closed) return;

      const elapsed = Date.now() - this.lastStdoutAt;
      if (elapsed > this.heartbeatTimeoutMs) {
        this.logger.warn('Heartbeat timeout — no stdout from CLI', {
          elapsedMs: elapsed,
          timeoutMs: this.heartbeatTimeoutMs,
        });
      }
    }, this.heartbeatTimeoutMs / 2);
    this.heartbeatInterval.unref(); // Don't block process exit
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // -- Private --

  private async buildEnv(opts: StartOptions): Promise<NodeJS.ProcessEnv> {
    const { buildProcessEnv, serializeOptionsToEnv } = await import('../utils/env-builder');
    const base = await buildProcessEnv({ env: opts.env });
    const serialized = serializeOptionsToEnv(opts.options ?? {});
    return { ...base, ...serialized };
  }

  private resolveCliPath(opts: StartOptions): string {
    // Default: use node as the executable, args contain the script path
    return process.execPath;
  }

  private handleStdout(chunk: Buffer): void {
    this.lastStdoutAt = Date.now();
    const text = chunk.toString();
    const results = this.parser.push(text);

    for (const result of results) {
      if (result.parse_error) {
        this.logger.warn('NDJSON parse error', { error: result.parse_error });
        continue;
      }

      const data = result.data as Record<string, unknown> | undefined;
      if (!data) continue;

      // Track session ID from init message
      if (data.type === 'system' && (data as SDKSystemMessage).subtype === 'init') {
        this.sessionId = (data as SDKSystemMessage).session_id ?? null;
        this.extractInitResult(data as SDKSystemMessage);
      }

      // Handle control_response messages (resolve pending promises)
      if (data.type === 'control_response') {
        this.handleControlResponse(data);
        continue; // Don't push control_response to message queue
      }

      // Handle tool_use messages with canUseTool callback
      if (data.type === 'tool_use' && this.canUseTool) {
        this.handleToolUseWithCallback(data);
        continue;
      }

      // Handle elicitation control_request messages
      if (data.type === 'control_request' && data.action === 'elicitation' && this.onElicitation) {
        this.handleElicitation(data);
        continue;
      }

      // Handle hook_trigger messages from CLI — call SDK callbacks, respond via stdin
      if (data.type === 'hook_trigger') {
        this.handleHookTrigger(data);
        continue; // Don't push hook_trigger to message queue
      }

      if (data.type === 'result') {
        this.turnCount = (data as SDKResultMessage).num_turns ?? this.turnCount;
      }

      const msg = data as SDKMessage;
      this.messageQueue.push(msg);
    }
  }

  /**
   * Extract and cache data from the system/init message.
   */
  private extractInitResult(initMsg: SDKSystemMessage): void {
    // Build a full initialization result
    const initResult: SDKControlInitializeResponse = {
      commands: this.extractCommands(initMsg),
      agents: this.extractAgents(initMsg),
      output_style: initMsg.output_style ?? 'text',
      available_output_styles: ['text', 'json'],
      models: this.extractModels(initMsg),
      account: this.extractAccountInfo(initMsg),
    };

    this.cachedInitResult = initResult;
    this.slashCommands = initResult.commands;
    this.supportedModelsList = initResult.models;
    this.supportedAgentsList = initResult.agents;
    this.accountInfoData = initResult.account;

    this.logger.debug('Cached init result', {
      commands: initResult.commands.length,
      models: initResult.models.length,
      agents: initResult.agents.length,
    });
  }

  private extractCommands(initMsg: SDKSystemMessage): SlashCommand[] {
    // If the init message includes slash_commands as strings, convert to SlashCommand[]
    const cmds = (initMsg as any).slash_commands;
    if (Array.isArray(cmds)) {
      return cmds.map((c: string | { name: string; description: string; argumentHint: string }) =>
        typeof c === 'string' ? { name: c, description: '', argumentHint: '' } : c,
      );
    }
    return [];
  }

  private extractAgents(initMsg: SDKSystemMessage): AgentInfo[] {
    const agents = (initMsg as any).agents;
    if (Array.isArray(agents)) {
      return agents.map((a: string | AgentInfo) =>
        typeof a === 'string' ? { name: a, description: '' } : a,
      );
    }
    return [];
  }

  private extractModels(initMsg: SDKSystemMessage): ModelInfo[] {
    // If model is a string, create a single ModelInfo entry
    const model = initMsg.model;
    if (typeof model === 'string') {
      return [{ value: model, displayName: model, description: '' }];
    }
    return [];
  }

  private extractAccountInfo(initMsg: SDKSystemMessage): AccountInfo {
    return {
      apiKeySource: initMsg.apiKeySource,
    };
  }

  /**
   * Handle control_response messages and resolve pending promises.
   */
  private handleControlResponse(data: Record<string, unknown>): void {
    const requestId = data.request_id as string | undefined;
    if (!requestId) return;

    const pending = this.pendingControlRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingControlRequests.delete(requestId);

    const subtype = data.subtype as string | undefined;
    if (subtype === 'success') {
      pending.resolve(data.response ?? data);
    } else if (subtype === 'error') {
      pending.reject(new Error((data as any).error ?? 'Control request failed'));
    } else {
      // Generic response
      pending.resolve(data);
    }
  }

  /**
   * Handle tool_use messages with canUseTool callback integration.
   */
  private async handleToolUseWithCallback(data: Record<string, unknown>): Promise<void> {
    const toolName = data.tool_name as string | undefined;
    const toolInput = (data.input as Record<string, unknown>) ?? {};
    const toolUseId = data.tool_use_id as string | undefined;

    if (!toolName || !toolUseId || !this.canUseTool) {
      // No callback or missing data — push as normal
      this.messageQueue.push(data as SDKMessage);
      return;
    }

    try {
      const abortController = new AbortController();
      const result = await this.canUseTool(toolName, toolInput, {
        signal: abortController.signal,
        toolUseID: toolUseId,
      });

      if (result.behavior === 'allow') {
        // Allow: push original message to queue
        this.messageQueue.push(data as SDKMessage);
      } else {
        // Deny: construct a tool_result denial message using MessageNormalizer
        const normalizer = new MessageNormalizer();
        const denialAssistantMsg = normalizer.createDenialMessage(
          { type: 'tool_use', id: toolUseId, name: toolName, input: toolInput },
          result.message,
        );

        const denialMsg: SDKMessage = {
          type: 'assistant',
          message: {
            id: `msg-denial-${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: denialAssistantMsg.content,
            model: 'unknown',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          parent_tool_use_id: (data as any).parent_tool_use_id ?? null,
          session_id: this.sessionId ?? 'unknown',
          uuid: randomUUID(),
        } as SDKAssistantMessage;
        this.messageQueue.push(denialMsg);
      }
    } catch (err) {
      // If callback fails, push original message
      this.logger.warn('canUseTool callback failed, passing through', { toolName, error: String(err) });
      this.messageQueue.push(data as SDKMessage);
    }
  }

  /**
   * Handle elicitation control_request messages with onElicitation callback integration.
   */
  private async handleElicitation(data: Record<string, unknown>): Promise<void> {
    const requestId = data.request_id as string | undefined;
    const mode = (data.mode as 'form' | 'url') ?? 'form';
    const message = data.message as string | undefined;
    const fields = data.fields as Array<{ name: string; description?: string; required?: boolean }> | undefined;
    const url = data.url as string | undefined;

    if (!this.onElicitation) {
      // No callback — send a default reject response
      if (requestId) {
        this.process?.stdin.write(JSON.stringify({
          type: 'elicitation_response',
          request_id: requestId,
          action: 'reject',
        }) + '\n');
      }
      return;
    }

    try {
      const result = await this.onElicitation({ mode, message, fields, url });

      // Send response back to CLI via stdin
      if (requestId) {
        this.process?.stdin.write(JSON.stringify({
          type: 'elicitation_response',
          request_id: requestId,
          ...result,
        }) + '\n');
      }
    } catch (err) {
      this.logger.warn('onElicitation callback failed, sending reject', { error: String(err) });
      if (requestId) {
        this.process?.stdin.write(JSON.stringify({
          type: 'elicitation_response',
          request_id: requestId,
          action: 'reject',
        }) + '\n');
      }
    }
  }

  /**
   * Handle hook_trigger messages from CLI.
   * Calls the registered SDK callback(s) for the event and sends the result back via stdin.
   */
  private async handleHookTrigger(data: Record<string, unknown>): Promise<void> {
    const requestId = data.request_id as string | undefined;
    const event = data.event as HookEvent | undefined;
    const input = data.input as HookInput | undefined;

    if (!requestId || !event) {
      this.logger.warn('Invalid hook_trigger message', { requestId, event });
      return;
    }

    const matchers = this.hooks?.[event];
    if (!matchers || matchers.length === 0) {
      // No SDK callbacks for this event — send default response
      this.sendHookResponse(requestId, event, { continue: true });
      return;
    }

    // Execute all registered callbacks for this event sequentially
    let finalOutput: HookJSONOutput = { continue: true } as HookJSONOutput;

    for (const matcher of matchers) {
      if ('continue' in finalOutput && finalOutput.continue === false) {
        break; // Hook chain broken
      }

      for (const callback of matcher.hooks) {
        if ('continue' in finalOutput && (finalOutput as SyncHookJSONOutput).continue === false) {
          break;
        }

        try {
          const timeoutMs = matcher.timeout ?? 5000;
          const abortController = new AbortController();
          const timeout = setTimeout(() => {
            abortController.abort();
          }, timeoutMs);

          const result = await callback(
            input as HookInput,
            (input as any)?.tool_use_id,
            { signal: abortController.signal },
          );

          clearTimeout(timeout);
          finalOutput = { ...finalOutput, ...result };
        } catch (err) {
          this.logger.warn('Hook callback failed', { event, error: String(err) });
          // Continue with next callback on error
        }
      }
    }

    this.sendHookResponse(requestId, event, finalOutput);
  }

  /**
   * Send hook response back to CLI via stdin.
   */
  private sendHookResponse(requestId: string, event: HookEvent, output: HookJSONOutput): void {
    const response = {
      type: 'hook_response' as const,
      request_id: requestId,
      event,
      output,
      session_id: this.sessionId ?? 'unknown',
    };

    if (this.process?.stdin) {
      this.process.stdin.write(JSON.stringify(response) + '\n');
      this.logger.debug('Sent hook_response', { requestId, event, output });
    }
  }

  private handleStderr(chunk: Buffer, opts: StartOptions): void {
    const text = chunk.toString();
    if (opts.stderr) {
      opts.stderr(text);
    } else {
      this.logger.debug('CLI stderr', { stderr: text.trim() });
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.logger.info('CLI process exited', { code, signal });
    this.closed = true;
  }

  private handleError(err: Error): void {
    this.logger.error('CLI process error', { error: err.message });
    this.closed = true;
  }
}
