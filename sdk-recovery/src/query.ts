import { randomUUID } from 'node:crypto';
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
  ModelInfo,
  McpServerStatus,
  AccountInfo,
  AgentInfo,
  SDKControlInitializeResponse,
  SDKControlGetContextUsageResponse,
  SDKControlReadFileResponse,
  SDKControlReloadPluginsResponse,
  McpSetServersResult,
  McpServerConfig,
  Settings,
} from './types';
import { ProcessTransport } from './transport/processTransport';
import { getLogger } from './utils/logger';

const logger = getLogger();

export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query {
  const logger = getLogger();
  const options = params.options ?? {};

  // Pass canUseTool, onElicitation, and hooks to transport constructor
  const transport = new ProcessTransport(logger, {
    canUseTool: options.canUseTool,
    onElicitation: options.onElicitation,
    hooks: options.hooks,
    settings: options.settings,
  });

  // Start transport (non-blocking — messages arrive asynchronously)
  const startPromise = transport.start({
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    executableArgs: options.executableArgs,
    stderr: options.stderr,
    // Pass full options for serialization to env vars
    options,
    // Pass through extended options
    spawnFn: options.spawnClaudeCodeProcess,
    settings: options.settings,
  });

  // Send the initial prompt if it's a string
  const promptToSend = typeof params.prompt === 'string' ? params.prompt : null;
  const initAndSend = startPromise.then(async () => {
    if (promptToSend) {
      await transport.sendMessage(promptToSend);
    }
  });

  // AbortController wiring
  if (options.abortController) {
    options.abortController.signal.addEventListener('abort', () => {
      transport.interrupt();
    });
  }

  // Single generator instance — shared across all iteration methods
  const msgGen = transport.receiveMessages();

  // Build the Query object
  const queryObj: Query = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: async () => {
      await initAndSend;
      return msgGen.next();
    },
    return: async () => {
      await initAndSend;
      transport.cleanup();
      return { done: true, value: undefined };
    },
    throw: async (err) => {
      await initAndSend;
      transport.cleanup();
      throw err;
    },
    // Existing control methods
    interrupt: () => transport.interrupt(),
    setPermissionMode: (mode) => transport.setPermissionMode(mode),
    setModel: (model) => transport.setModel(model ?? null),
    setMaxThinkingTokens: (value) => transport.setMaxThinkingTokens(value),

    // Data accessors (cached from init message)
    supportedCommands: async (): Promise<SlashCommand[]> => transport.getSlashCommands(),
    supportedModels: async (): Promise<ModelInfo[]> => transport.getSupportedModels(),
    supportedAgents: async (): Promise<AgentInfo[]> => transport.getSupportedAgents(),
    initializationResult: async (): Promise<SDKControlInitializeResponse> => transport.getInitResult(),
    accountInfo: async (): Promise<AccountInfo> => transport.getAccountInfo(),

    // Control request methods (new 12)
    getContextUsage: async (): Promise<SDKControlGetContextUsageResponse> => {
      const resp = await transport.sendControlRequest('get_context_usage');
      return resp as SDKControlGetContextUsageResponse;
    },
    reloadPlugins: async (): Promise<SDKControlReloadPluginsResponse> => {
      const resp = await transport.sendControlRequest('reload_plugins');
      return resp as SDKControlReloadPluginsResponse;
    },
    seedReadState: async (path: string, mtime: number): Promise<void> => {
      await transport.sendControlRequest('seed_read_state', { path, mtime });
    },
    reconnectMcpServer: async (serverName: string): Promise<void> => {
      await transport.sendControlRequest('reconnect_mcp_server', { name: serverName });
    },
    toggleMcpServer: async (serverName: string, enabled: boolean): Promise<void> => {
      await transport.sendControlRequest('toggle_mcp_server', { name: serverName, enabled });
    },
    stopTask: async (taskId: string): Promise<void> => {
      await transport.sendControlRequest('stop_task', { taskId });
    },
    applyFlagSettings: async (settings: Settings): Promise<void> => {
      await transport.sendControlRequest('apply_flag_settings', { settings });
    },
    setMcpServers: async (servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> => {
      const resp = await transport.sendControlRequest('set_mcp_servers', { servers });
      return resp as McpSetServersResult;
    },
    readFile: async (path: string, opts?: { maxBytes?: number }): Promise<SDKControlReadFileResponse | null> => {
      try {
        const resp = await transport.sendControlRequest('read_file', { path, maxBytes: opts?.maxBytes });
        return resp as SDKControlReadFileResponse;
      } catch (err) {
        logger.warn('readFile failed', { path, error: (err as Error).message });
        return null;
      }
    },

    // Existing methods
    mcpServerStatus: async (): Promise<McpServerStatus[]> => {
      const resp = await transport.sendControlRequest('mcp_status');
      return (resp as { servers: McpServerStatus[] })?.servers ?? [];
    },
    rewindFiles: async (_userMessageId: string, opts?: { dryRun?: boolean }): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }> => {
      try {
        const resp = await transport.sendControlRequest('rewind_files', {
          userMessageId: _userMessageId,
          dryRun: opts?.dryRun ?? false,
        });
        const data = resp as { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number };
        return data ?? { canRewind: false, error: 'No response from CLI' };
      } catch {
        return { canRewind: false, error: 'Checkpointing not available' };
      }
    },
    streamInput: async (stream: AsyncIterable<SDKUserMessage>): Promise<void> => {
      for await (const msg of stream) {
        await transport.sendMessageObj({
          type: msg.type,
          message: msg.message,
          parent_tool_use_id: msg.parent_tool_use_id ?? null,
          is_synthetic: msg.isSynthetic,
          session_id: msg.session_id,
          uuid: msg.uuid ?? randomUUID(),
        });
      }
    },
    close: () => transport.cleanup(),
    [Symbol.asyncDispose]: async () => {
      transport.cleanup();
    },
  };

  return queryObj;
}
