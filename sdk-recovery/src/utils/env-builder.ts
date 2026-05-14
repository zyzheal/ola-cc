import type { Options } from '../types';

/**
 * Build environment variables for the CLI process.
 */
export async function buildProcessEnv(
  options: Pick<Options, 'env'>,
): Promise<NodeJS.ProcessEnv> {
  const base = { ...process.env } as NodeJS.ProcessEnv;

  // Merge caller-provided env (overrides base)
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) {
        delete base[key];
      } else {
        base[key] = value;
      }
    }
  }

  // CCR (Claude Code Router) detection: only set default if not provided by caller
  if (!base.ANTHROPIC_BASE_URL && !options.env?.ANTHROPIC_BASE_URL) {
    // No CCR — use default Anthropic API
    base.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
  }

  // API provider: auto-detect or explicit override
  // If no API_PROVIDER set, it will be auto-detected from baseURL in api-client.ts
  if (options.env?.API_PROVIDER) {
    base.API_PROVIDER = options.env.API_PROVIDER;
  }

  // Ensure Node.js module resolution works
  if (!base.NODE_PATH) {
    base.NODE_PATH = process.env.NODE_PATH ?? '';
  }

  return base;
}

/**
 * Serialize all Options properties to environment variables.
 * Used by ProcessTransport.buildProcessEnv() to pass configuration
 * to the CLI subprocess.
 */
export function serializeOptionsToEnv(options: Options): Record<string, string> {
  const env: Record<string, string> = {};

  // Core settings
  if (options.cwd) env.CWD = options.cwd;
  if (options.model) env.ANTHROPIC_MODEL = options.model;
  if (options.permissionMode) env.PERMISSION_MODE = options.permissionMode;
  if (options.maxThinkingTokens !== undefined) env.MAX_THINKING_TOKENS = String(options.maxThinkingTokens);
  if (options.maxTurns !== undefined) env.MAX_TURNS = String(options.maxTurns);
  if (options.maxBudgetUsd !== undefined) env.MAX_BUDGET_USD = String(options.maxBudgetUsd);

  // API settings
  if (options.pathToClaudeCodeExecutable) env.CLAUDE_CODE_PATH = options.pathToClaudeCodeExecutable;
  if (options.apiProvider) env.API_PROVIDER = options.apiProvider;

  // Beta features
  if (options.betas && options.betas.length > 0) {
    env.SDK_BETAS = options.betas.join(',');
  }

  // Feature flags
  if (options.enableFileCheckpointing) env.ENABLE_FILE_CHECKPOINTING = 'true';
  if (options.persistSession === false) env.PERSIST_SESSION = 'false';
  if (options.includePartialMessages) env.INCLUDE_PARTIAL_MESSAGES = 'true';
  if (options.includeHookEvents) env.INCLUDE_HOOK_EVENTS = 'true';
  if (options.strictMcpConfig) env.STRICT_MCP_CONFIG = 'true';
  if (options.allowDangerouslySkipPermissions) env.ALLOW_DANGEROUSLY_SKIP_PERMISSIONS = 'true';
  if (options.forkSession) env.FORK_SESSION = 'true';
  if (options.continue) env.CONTINUE_SESSION = 'true';

  // Resume settings
  if (options.resume) env.RESUME_SESSION_ID = options.resume;
  if (options.resumeSessionAt) env.RESUME_SESSION_AT = options.resumeSessionAt;
  if (options.sessionId) env.SDK_SESSION_ID = options.sessionId;

  // Thinking config
  if (options.thinking) {
    env.THINKING_CONFIG = JSON.stringify(options.thinking);
  }

  // Effort level
  if (options.effort) env.EFFORT_LEVEL = options.effort;

  // Agent settings
  if (options.agent) env.AGENT_NAME = options.agent;
  if (options.agents) env.AGENTS = JSON.stringify(options.agents);

  // Tool settings
  if (options.allowedTools && options.allowedTools.length > 0) {
    env.ALLOWED_TOOLS = options.allowedTools.join(',');
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    env.DISALLOWED_TOOLS = options.disallowedTools.join(',');
  }
  if (options.tools) {
    env.TOOLS_PRESET = Array.isArray(options.tools)
      ? options.tools.join(',')
      : options.tools.preset;
  }
  if (options.permissionPromptToolName) env.PERMISSION_PROMPT_TOOL_NAME = options.permissionPromptToolName;
  if (options.toolConfig) env.TOOL_CONFIG = JSON.stringify(options.toolConfig);

  // MCP servers
  if (options.mcpServers) env.MCP_SERVERS = JSON.stringify(options.mcpServers);

  // Additional directories
  if (options.additionalDirectories && options.additionalDirectories.length > 0) {
    env.ADDITIONAL_DIRECTORIES = options.additionalDirectories.join(',');
  }

  // Extra args
  if (options.extraArgs) env.EXTRA_ARGS = JSON.stringify(options.extraArgs);

  // Executable
  if (options.executable) env.EXECUTABLE = options.executable;
  if (options.executableArgs && options.executableArgs.length > 0) {
    env.EXECUTABLE_ARGS = options.executableArgs.join(',');
  }

  // Sandbox
  if (options.sandbox) env.SANDBOX_CONFIG = JSON.stringify(options.sandbox);

  // Settings
  if (typeof options.settings === 'string') {
    env.SETTINGS_PATH = options.settings;
  } else if (options.settings) {
    env.SETTINGS = JSON.stringify(options.settings);
  }

  // Setting sources
  if (options.settingSources && options.settingSources.length > 0) {
    env.SETTING_SOURCES = options.settingSources.join(',');
  }

  // System prompt
  if (typeof options.systemPrompt === 'string') {
    env.CUSTOM_PROMPT = options.systemPrompt;
  } else if (options.systemPrompt && 'append' in options.systemPrompt) {
    env.SYSTEM_PROMPT_PRESET = 'true';
    if (options.systemPrompt.append) env.SYSTEM_PROMPT_APPEND = options.systemPrompt.append;
  }

  // Title
  if (options.title) env.SESSION_TITLE = options.title;

  // Task budget
  if (options.taskBudget) env.TASK_BUDGET = JSON.stringify(options.taskBudget);

  // Prompt suggestions
  if (options.promptSuggestions) env.PROMPT_SUGGESTIONS = 'true';

  // Agent progress summaries
  if (options.agentProgressSummaries) env.AGENT_PROGRESS_SUMMARIES = 'true';

  // Load timeout
  if (options.loadTimeoutMs) env.LOAD_TIMEOUT_MS = String(options.loadTimeoutMs);

  // Hooks
  if (options.hooks) {
    const registeredEvents = Object.keys(options.hooks).filter(
      (k) => (options.hooks as Record<string, unknown[]>)[k]?.length > 0,
    );
    if (registeredEvents.length > 0) {
      env.SDK_HOOKS_REGISTERED = 'true';
      env.SDK_HOOK_EVENTS = registeredEvents.join(',');
    }
  }

  // Missing options added here
  if (options.outputFormat) env.OUTPUT_FORMAT = JSON.stringify(options.outputFormat);
  if (options.plugins && options.plugins.length > 0) {
    env.SDK_PLUGINS = JSON.stringify(options.plugins);
  }
  if (options.fallbackModel) env.FALLBACK_MODEL = options.fallbackModel;
  if (options.debug) env.DEBUG = 'true';
  if (options.debugFile) env.DEBUG_FILE = options.debugFile;

  // Safety check: total env size must fit within OS limits (~128KB on most systems)
  const totalSize = Object.entries(env).reduce((sum, [k, v]) => sum + k.length + v.length + 2, 0);
  if (totalSize > 100_000) {
    throw new Error(`Serialized options exceed environment variable size limit (${totalSize} bytes > 100KB). Consider reducing agents/MCP servers config.`);
  }

  return env;
}
