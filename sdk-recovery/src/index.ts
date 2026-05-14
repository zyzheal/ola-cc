// SDK API — v1 (CLI subprocess mode)
export { query } from "./query";

// SDK API — v2 (direct API mode)
export {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
} from "./v2-api";

// MCP tool definer
export { tool, createSdkMcpServer } from "./mcp-tools";

// Session utilities
export { startup } from "./utils/session-store";

// Types
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./types";
export { AbortError, InMemorySessionStore } from "./types";
export type * from "./types";

// --- Anthropic SDK compatibility layer ---
export { Anthropic } from "./compat.js";
export { Anthropic as default } from "./compat.js";

// Error module (for @anthropic-ai/sdk/error compatibility)
export * from './error.js';
export type { APIErrorType } from './utils/error.js';
export type { ClientOptions } from './compat.js';

// Resource types
export type {
  MessageParam,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  Tool,
  Usage,
  BetaMessage,
  BetaUsage,
  BetaRawMessageStreamEvent,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  ImageBlockParam,
  Base64ImageSource,
  ContentBlockParam,
  ContentBlock,
  ThinkingBlock,
  ThinkingBlockParam,
  BetaContentBlock,
  BetaToolUseBlock,
  BetaMessageParam,
  BetaTool,
  BetaToolUnion,
  BetaMessageStreamParams,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaMessageDeltaUsage,
  BetaOutputConfig,
  BetaRequestDocumentBlock,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolResultBlockParam,
  BetaWebSearchTool20250305,
  BetaRedactedThinkingBlock,
  BetaThinkingBlock,
  BetaJSONOutputFormat,
  RedactedThinkingBlock,
  RedactedThinkingBlockParam,
  Stream,
} from "./resources/index.js";

// Transitional re-exports
export type { McpbManifest, McpbUserConfigurationOption } from "./mcpb.js";
export type { PermissionMode } from "./claude-agent-sdk.js";
export type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  IgnoreViolationsConfig,
  NetworkHostPattern,
  NetworkRestrictionConfig,
  SandboxAskCallback,
  SandboxDependencyCheck,
  SandboxRuntimeConfig,
  SandboxViolationEvent,
} from "./sandbox-runtime.js";
export {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  SandboxViolationStore,
} from "./sandbox-runtime.js";

// Version
export const VERSION = '0.1.0';
