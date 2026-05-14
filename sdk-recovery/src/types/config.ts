import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  PermissionMode, PermissionResult, PermissionUpdate,
  OutputFormat, SandboxSettings, EffortLevel, ThinkingConfig,
  Settings, SdkBeta, SettingSource, ToolConfig,
  SessionStore, AgentDefinition, McpServerConfig,
} from './sdk-messages';
import type { HookCallbackMatcher, HookEvent } from './hooks';

// -- MCP types (specific to config, not redefined in sdk-messages) --

export type McpStdioServerConfig = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };
export type McpSSEServerConfig = { type: 'sse'; url: string; headers?: Record<string, string> };
export type McpHttpServerConfig = { type: 'http'; url: string; headers?: Record<string, string> };
export type McpSdkServerConfig = { type: 'sdk'; name: string };
export type McpSdkServerConfigWithInstance = McpSdkServerConfig & { instance: McpServer };
export type McpServerConfigForProcessTransport = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfig;

// -- Elicitation --

export type OnElicitation = (request: {
  mode: 'form' | 'url';
  message?: string;
  fields?: Array<{ name: string; description?: string; required?: boolean }>;
  url?: string;
}) => Promise<{ action: 'accept'; content?: Record<string, string> } | { action: 'reject' }>;

// -- CanUseTool --

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
    title?: string;
    displayName?: string;
    description?: string;
  },
) => Promise<PermissionResult>;

// -- Options --

export type Options = {
  apiProvider?: 'anthropic' | 'openai' | 'anthropic-proxy';
  abortController?: AbortController;
  additionalDirectories?: string[];
  agent?: string;
  agents?: Record<string, AgentDefinition>;
  allowedTools?: string[];
  canUseTool?: CanUseTool;
  continue?: boolean;
  cwd?: string;
  debug?: boolean;
  debugFile?: string;
  disallowedTools?: string[];
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  env?: Record<string, string | undefined>;
  effort?: EffortLevel;
  enableFileCheckpointing?: boolean;
  executable?: 'bun' | 'deno' | 'node';
  executableArgs?: string[];
  extraArgs?: Record<string, string | null>;
  fallbackModel?: string;
  forkSession?: boolean;
  betas?: SdkBeta[];
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  includeHookEvents?: boolean;
  includePartialMessages?: boolean;
  loadTimeoutMs?: number;
  maxThinkingTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  onElicitation?: OnElicitation;
  outputFormat?: OutputFormat;
  pathToClaudeCodeExecutable?: string;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  permissionPromptToolName?: string;
  persistSession?: boolean;
  plugins?: Array<{ type: 'local'; path: string }>;
  promptSuggestions?: boolean;
  agentProgressSummaries?: boolean;
  resume?: string;
  resumeSessionAt?: string;
  sandbox?: SandboxSettings;
  sessionId?: string;
  settings?: string | Settings;
  settingSources?: SettingSource[];
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  stderr?: (data: string) => void;
  strictMcpConfig?: boolean;
  systemPrompt?: string | string[] | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: string[] };
  taskBudget?: { total: number };
  thinking?: ThinkingConfig;
  title?: string;
  toolConfig?: ToolConfig;
};

// -- Process transport types --

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface SpawnedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: string): boolean;
  pid?: number;
}

/** Re-export from sdk-messages.ts */
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, InMemorySessionStore } from './sdk-messages';
