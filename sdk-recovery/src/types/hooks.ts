import type { PermissionUpdate, PermissionUpdateDestination, PermissionResult } from './sdk-messages';

export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PermissionRequest',
  'ConfigChange', 'CwdChanged', 'Elicitation', 'ElicitationResult',
  'FileChanged', 'InstructionsLoaded', 'PermissionDenied', 'Setup',
  'StopFailure', 'TaskCompleted', 'TaskCreated', 'TeammateIdle',
  'UserPromptExpansion', 'WorktreeCreate', 'WorktreeRemove',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

export type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
};

export type PreToolUseHookInput = BaseHookInput & { hook_event_name: 'PreToolUse'; tool_name: string; tool_input: unknown; tool_use_id: string };
export type PermissionRequestHookInput = BaseHookInput & { hook_event_name: 'PermissionRequest'; tool_name: string; tool_input: unknown; permission_suggestions?: PermissionUpdate[] };
export type PostToolUseHookInput = BaseHookInput & { hook_event_name: 'PostToolUse'; tool_name: string; tool_input: unknown; tool_response: unknown; tool_use_id: string };
export type PostToolUseFailureHookInput = BaseHookInput & { hook_event_name: 'PostToolUseFailure'; tool_name: string; tool_input: unknown; tool_use_id: string; error: string; is_interrupt?: boolean };
export type NotificationHookInput = BaseHookInput & { hook_event_name: 'Notification'; message: string; title?: string; notification_type: string };
export type UserPromptSubmitHookInput = BaseHookInput & { hook_event_name: 'UserPromptSubmit'; prompt: string };
export type SessionStartHookInput = BaseHookInput & { hook_event_name: 'SessionStart'; source: 'startup' | 'resume' | 'clear' | 'compact' };
export type StopHookInput = BaseHookInput & { hook_event_name: 'Stop'; stop_hook_active: boolean };
export type SubagentStartHookInput = BaseHookInput & { hook_event_name: 'SubagentStart'; agent_id: string; agent_type: string };
export type SubagentStopHookInput = BaseHookInput & { hook_event_name: 'SubagentStop'; stop_hook_active: boolean; agent_id: string; agent_transcript_path: string };
export type PreCompactHookInput = BaseHookInput & { hook_event_name: 'PreCompact'; trigger: 'manual' | 'auto'; custom_instructions: string | null };
export type PostCompactHookInput = BaseHookInput & { hook_event_name: 'PostCompact'; trigger: 'manual' | 'auto' };
export type ConfigChangeHookInput = BaseHookInput & { hook_event_name: 'ConfigChange'; source: string; file_path?: string };
export type CwdChangedHookInput = BaseHookInput & { hook_event_name: 'CwdChanged'; old_cwd: string; new_cwd: string };
export type ElicitationHookInput = BaseHookInput & { hook_event_name: 'Elicitation'; mcp_server_name: string; message: string; mode?: 'form' | 'url'; url?: string };
export type ElicitationResultHookInput = BaseHookInput & { hook_event_name: 'ElicitationResult'; action: 'accept' | 'reject' };
export type FileChangedHookInput = BaseHookInput & { hook_event_name: 'FileChanged'; file_path: string; change_type: 'created' | 'modified' | 'deleted' };
export type InstructionsLoadedHookInput = BaseHookInput & { hook_event_name: 'InstructionsLoaded'; source: string };
export type PermissionDeniedHookInput = BaseHookInput & { hook_event_name: 'PermissionDenied'; tool_name: string; tool_use_id: string };
export type SetupHookInput = BaseHookInput & { hook_event_name: 'Setup' };
export type StopFailureHookInput = BaseHookInput & { hook_event_name: 'StopFailure'; error: string };
export type TaskCompletedHookInput = BaseHookInput & { hook_event_name: 'TaskCompleted'; task_id: string; status: string };
export type TaskCreatedHookInput = BaseHookInput & { hook_event_name: 'TaskCreated'; task_id: string; description: string };
export type TeammateIdleHookInput = BaseHookInput & { hook_event_name: 'TeammateIdle'; agent_id: string; agent_type: string };
export type UserPromptExpansionHookInput = BaseHookInput & { hook_event_name: 'UserPromptExpansion'; original_prompt: string; expanded_prompt: string };
export type WorktreeCreateHookInput = BaseHookInput & { hook_event_name: 'WorktreeCreate'; worktree_path: string; branch: string };
export type WorktreeRemoveHookInput = BaseHookInput & { hook_event_name: 'WorktreeRemove'; worktree_path: string };
export type SessionEndHookInput = BaseHookInput & { hook_event_name: 'SessionEnd'; reason: ExitReason };

export type HookInput =
  | PreToolUseHookInput | PostToolUseHookInput | PostToolUseFailureHookInput
  | NotificationHookInput | UserPromptSubmitHookInput | SessionStartHookInput
  | SessionEndHookInput | StopHookInput | SubagentStartHookInput
  | SubagentStopHookInput | PreCompactHookInput | PostCompactHookInput | PermissionRequestHookInput
  | ConfigChangeHookInput | CwdChangedHookInput | ElicitationHookInput
  | ElicitationResultHookInput | FileChangedHookInput | InstructionsLoadedHookInput
  | PermissionDeniedHookInput | SetupHookInput | StopFailureHookInput
  | TaskCompletedHookInput | TaskCreatedHookInput | TeammateIdleHookInput
  | UserPromptExpansionHookInput | WorktreeCreateHookInput | WorktreeRemoveHookInput;

export const EXIT_REASONS = [
  'clear', 'resume', 'logout', 'prompt_input_exit', 'other', 'bypass_permissions_disabled',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    | { hookEventName: 'SubagentStart'; additionalContext?: string }
    | { hookEventName: 'PostToolUse'; additionalContext?: string; updatedMCPToolOutput?: unknown }
    | { hookEventName: 'PostToolUseFailure'; additionalContext?: string }
    | { hookEventName: 'PermissionRequest'; decision: { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] } | { behavior: 'deny'; message?: string; interrupt?: boolean } };
};

export type AsyncHookJSONOutput = { async: true; asyncTimeout?: number };
export type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;
