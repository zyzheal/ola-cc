import type {
  MessageParam,
  BetaMessage,
  BetaUsage,
  BetaRawMessageStreamEvent,
} from '../utils/anthropic-types';
import type { UUID } from 'crypto';

// -- Forward-referenced types (defined locally for self-containment) --

export type McpServerStatus = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending';
  serverInfo?: { name: string; version: string };
};

export type McpServerConfig = { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; name?: string; instance?: unknown };
export type McpSetServersResult = { added: string[]; removed: string[]; errors: Record<string, string> };
export type SdkMcpToolDefinition<Schema = unknown> = { name: string; description: string; inputSchema: Schema; handler: unknown };
export type CreateSdkMcpServerOptions = { name: string; version?: string; tools?: Array<SdkMcpToolDefinition<any>> };

export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth';
export type SettingSource = 'user' | 'project' | 'local';
export type SdkBeta = 'context-1m-2025-08-07';

export type SlashCommand = { name: string; description: string; argumentHint: string };
export type ModelInfo = { value: string; displayName: string; description: string };
export type AccountInfo = { email?: string; organization?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string; apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle' };
export type AgentInfo = { name: string; description: string; model?: string };

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ToolConfig = { askUserQuestion?: { previewFormat?: 'markdown' | 'html' } };

export type ThinkingAdaptive = { type: 'adaptive' };
export type ThinkingEnabled = { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted' };
export type ThinkingDisabled = { type: 'disabled' };
export type ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled;

export type SandboxNetworkConfig = { allowLocalBinding?: boolean; allowUnixSockets?: string[] };
export type SandboxIgnoreViolations = { filesystem?: boolean; network?: boolean };
export type SandboxSettings = { enabled?: boolean; autoAllowBashIfSandboxed?: boolean; failIfUnavailable?: boolean; network?: SandboxNetworkConfig; ignoreViolations?: SandboxIgnoreViolations };

export type OutputFormat = { type: 'json_schema'; schema: Record<string, unknown> };
export type Settings = { $schema?: string; apiKeyHelper?: string; proxyAuthHelper?: string; model?: string; permissions?: { allow?: string[]; deny?: string[] }; env?: Record<string, string> };

export type SDKControlInitializeResponse = { commands: SlashCommand[]; agents: AgentInfo[]; output_style: string; available_output_styles: string[]; models: ModelInfo[]; account: AccountInfo; fast_mode_state?: unknown };
export type SDKControlGetContextUsageResponse = { categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[]; totalTokens: number; maxTokens: number; rawMaxTokens: number; percentage: number; gridRows: { color: string; isFilled: boolean; categoryName: string; tokens: number; percentage: number; squareFullness: number }[][]; model: string; memoryFiles: { path: string; type: string; tokens: number }[]; mcpTools: { name: string; serverName: string; tokens: number }[] };
export type SDKControlReadFileResponse = { contents: string; absPath: string; truncated?: boolean };
export type SDKControlReloadPluginsResponse = { commands: SlashCommand[]; agents: AgentInfo[]; plugins: { name: string; path: string; source?: string }[]; mcpServers: McpServerStatus[]; error_count: number };

export type SessionStore = { listSubkeys: (opts: { sessionId: string; key: string }) => Promise<string[]>; load: (opts: { sessionId: string; key: string; subkey: string }) => Promise<string>; listSessions?: (projectKey: string) => Promise<Array<{ sessionId: string; summary?: string; lastModified?: number }>> };

export type SDKSessionInfo = { sessionId: string; summary: string; lastModified: number; fileSize?: number };
export type SessionMutationOptions = { dir?: string; sessionStore?: SessionStore };
export type ListSessionsOptions = { dir?: string; limit?: number; offset?: number; includeWorktrees?: boolean; sessionStore?: SessionStore };
export type SessionMessage = { type: 'user' | 'assistant' | 'system'; uuid: string; session_id: string; message: unknown; parent_tool_use_id: null };
export type ForkSessionOptions = SessionMutationOptions & { upToMessageId?: string; title?: string };
export type ForkSessionResult = { sessionId: string };
export type GetSubagentMessagesOptions = { dir?: string; limit?: number; offset?: number; sessionStore?: SessionStore };
export type ListSubagentsOptions = { dir?: string; sessionStore?: SessionStore };
export type ImportSessionToStoreOptions = { dir?: string; includeSubagents?: boolean };

export type AgentDefinition = { description: string; tools?: string[]; disallowedTools?: string[]; prompt: string; model?: string; criticalSystemReminder_EXPERIMENTAL?: string; mcpServers?: Record<string, unknown>; initialPrompt?: string; maxTurns?: number; background?: boolean; memory?: { enabled: boolean; key: string }; effort?: EffortLevel; permissionMode?: unknown; skills?: string[] };

// -- Permission types (self-contained, hooks imports these) --

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
export type PermissionRuleValue = { toolName: string; ruleContent?: string };
export type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination }
  | { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination };
export type PermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject';
export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string; decisionClassification?: PermissionDecisionClassification }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string; decisionClassification?: PermissionDecisionClassification };

// -- Usage types --

export type NonNullableUsage = { [K in keyof BetaUsage]: NonNullable<BetaUsage[K]> };

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
};

// -- Message types --

export type SDKUserMessageContent = {
  type: 'user';
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
};

export type SDKUserMessage = SDKUserMessageContent & { uuid?: UUID; session_id?: string };
export type SDKUserMessageReplay = SDKUserMessageContent & { uuid: UUID; session_id: string; isReplay: true };

export type SDKAssistantMessageError = 'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens';

export type SDKAssistantMessage = {
  type: 'assistant';
  message: BetaMessage;
  parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError;
  uuid: UUID;
  session_id: string;
};

export type SDKPermissionDenial = { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> };

export type SDKResultMessage =
  | { type: 'result'; subtype: 'success'; stop_reason: string | null; duration_ms: number; duration_api_ms: number; is_error: boolean; num_turns: number; result: string; total_cost_usd: number; usage: NonNullableUsage; modelUsage: Record<string, ModelUsage>; permission_denials: SDKPermissionDenial[]; structured_output?: unknown; uuid: UUID; session_id: string }
  | { type: 'result'; subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'; stop_reason: string | null; duration_ms: number; duration_api_ms: number; is_error: boolean; num_turns: number; total_cost_usd: number; usage: NonNullableUsage; modelUsage: Record<string, ModelUsage>; permission_denials: SDKPermissionDenial[]; errors: string[]; uuid: UUID; session_id: string };

export type SDKSystemMessage = {
  type: 'system'; subtype: 'init';
  agents?: string[]; apiKeySource: ApiKeySource; betas?: SdkBeta[];
  claude_code_version: string; cwd: string; tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string; permissionMode: PermissionMode; slash_commands: string[];
  output_style: string; skills: string[];
  plugins: { name: string; path: string }[];
  uuid: UUID; session_id: string;
};

export type SDKPartialAssistantMessage = {
  type: 'stream_event'; event: BetaRawMessageStreamEvent;
  parent_tool_use_id: string | null; uuid: UUID; session_id: string;
};

export type SDKCompactBoundaryMessage = {
  type: 'system'; subtype: 'compact_boundary';
  compact_metadata: { trigger: 'manual' | 'auto'; pre_tokens: number };
  uuid: UUID; session_id: string;
};

export type SDKStatus = 'compacting' | null;
export type SDKStatusMessage = { type: 'system'; subtype: 'status'; status: SDKStatus; uuid: UUID; session_id: string };
export type SDKHookResponseMessage = { type: 'system'; subtype: 'hook_response'; hook_name: string; hook_event: string; stdout: string; stderr: string; exit_code?: number; uuid: UUID; session_id: string };
export type SDKToolProgressMessage = { type: 'tool_progress'; tool_use_id: string; tool_name: string; parent_tool_use_id: string | null; elapsed_time_seconds: number; uuid: UUID; session_id: string };
export type SDKAuthStatusMessage = { type: 'auth_status'; isAuthenticating: boolean; output: string[]; error?: string; uuid: UUID; session_id: string };

// -- Extended SDKMessage subtypes (from official SDK v0.2.116) --

export type SDKAPIRetryMessage = {
  type: 'system'; subtype: 'api_retry';
  attempt: number; max_retries: number; retry_delay_ms: number;
  error_status: number | null; error: SDKAssistantMessageError;
  uuid: UUID; session_id: string;
};

export type SDKLocalCommandOutputMessage = {
  type: 'system'; subtype: 'local_command_output';
  content: string; uuid: UUID; session_id: string;
};

export type SDKHookStartedMessage = {
  type: 'system'; subtype: 'hook_started';
  hook_id: string; hook_name: string; hook_event: string;
  uuid: UUID; session_id: string;
};

export type SDKHookProgressMessage = {
  type: 'system'; subtype: 'hook_progress';
  hook_id: string; hook_name: string; hook_event: string;
  stdout: string; stderr: string; output: string;
  uuid: UUID; session_id: string;
};

export type SDKTaskStartedMessage = {
  type: 'system'; subtype: 'task_started';
  task_id: string; tool_use_id?: string;
  description: string; task_type?: string;
  workflow_name?: string; prompt?: string;
  uuid: UUID; session_id: string;
};

export type SDKTaskProgressMessage = {
  type: 'system'; subtype: 'task_progress';
  task_id: string; tool_use_id?: string;
  description: string;
  usage: { total_tokens: number; tool_uses: number; duration_ms: number };
  last_tool_name?: string; summary?: string;
  uuid: UUID; session_id: string;
};

export type SDKTaskNotificationMessage = {
  type: 'system'; subtype: 'task_notification';
  task_id: string; tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string; summary: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  uuid: UUID; session_id: string;
};

export type SDKSessionStateChangedMessage = {
  type: 'system'; subtype: 'session_state_changed';
  state: 'idle' | 'running' | 'requires_action';
  uuid: UUID; session_id: string;
};

export type SDKFilesPersistedEvent = {
  type: 'system'; subtype: 'files_persisted';
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string; uuid: UUID; session_id: string;
};

export type SDKToolUseSummaryMessage = {
  type: 'tool_use_summary';
  summary: string; preceding_tool_use_ids: string[];
  uuid: UUID; session_id: string;
};

export type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean; surpassedThreshold?: number;
};

export type SDKRateLimitEvent = {
  type: 'rate_limit_event';
  rate_limit_info: SDKRateLimitInfo;
  uuid: UUID; session_id: string;
};

export type SDKElicitationCompleteMessage = {
  type: 'system'; subtype: 'elicitation_complete';
  mcp_server_name: string; elicitation_id: string;
  uuid: UUID; session_id: string;
};

export type SDKPromptSuggestionMessage = {
  type: 'prompt_suggestion';
  suggestion: string;
  uuid: UUID; session_id: string;
};

export type SDKMessage =
  | SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay
  | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage | SDKStatusMessage | SDKHookResponseMessage
  | SDKToolProgressMessage | SDKAuthStatusMessage
  | SDKAPIRetryMessage | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage | SDKHookProgressMessage
  | SDKTaskStartedMessage | SDKTaskProgressMessage | SDKTaskNotificationMessage
  | SDKSessionStateChangedMessage | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage | SDKRateLimitEvent
  | SDKElicitationCompleteMessage | SDKPromptSuggestionMessage;

// -- Query interface --

export interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
  reloadPlugins(): Promise<SDKControlReloadPluginsResponse>;
  seedReadState(path: string, mtime: number): Promise<void>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  applyFlagSettings(settings: Settings): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  readFile(path: string, options?: { maxBytes?: number }): Promise<SDKControlReadFileResponse | null>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  accountInfo(): Promise<AccountInfo>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

// -- V2 API (unstable) --

export type SDKSessionOptions = {
  model: string;
  pathToClaudeCodeExecutable?: string;
  executable?: 'node' | 'bun';
  executableArgs?: string[];
  env?: Record<string, string | undefined>;
};

export interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  receive(): AsyncGenerator<SDKMessage, void>;
  /** Alias for receive() -- matches official SDK name */
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

// -- Transport interface --

export interface Transport {
  enqueueMessage(msg: SDKMessage): Promise<void>;
  dequeueMessages(): AsyncGenerator<SDKMessage, void>;
}

// -- AbortError --

export class AbortError extends Error {
  constructor(message?: string) {
    super(message ?? 'Operation was aborted');
    this.name = 'AbortError';
  }
}

// -- WarmQuery (startup result) --

export interface WarmQuery extends AsyncDisposable {
  /** Initialize the SDK with the given options. Can only be called once per WarmQuery. */
  initialize(): Promise<void>;
  close(): void;
}

/** Dynamic boundary marker for system prompt. */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

/** In-memory implementation of SessionStore for testing and development. */
export class InMemorySessionStore implements SessionStore {
  private data: Map<string, Map<string, Map<string, string>>>;
  private sessionsList: Array<{ sessionId: string; summary?: string; lastModified?: number }>;

  constructor() {
    this.data = new Map();
    this.sessionsList = [];
  }

  async listSubkeys(opts: { sessionId: string; key: string }): Promise<string[]> {
    const sessionData = this.data.get(opts.sessionId);
    if (!sessionData) return [];
    const subMap = sessionData.get(opts.key);
    if (!subMap) return [];
    return Array.from(subMap.keys());
  }

  async load(opts: { sessionId: string; key: string; subkey: string }): Promise<string> {
    const value = this.data.get(opts.sessionId)?.get(opts.key)?.get(opts.subkey);
    if (value === undefined) throw new Error(`Key not found: ${opts.sessionId}/${opts.key}/${opts.subkey}`);
    return value;
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; summary?: string; lastModified?: number }>> {
    return this.sessionsList;
  }

  async save(sessionId: string, key: string, subkey: string, value: string): Promise<void> {
    if (!this.data.has(sessionId)) this.data.set(sessionId, new Map());
    const keyMap = this.data.get(sessionId)!;
    if (!keyMap.has(key)) keyMap.set(key, new Map());
    keyMap.get(key)!.set(subkey, value);
  }
}

