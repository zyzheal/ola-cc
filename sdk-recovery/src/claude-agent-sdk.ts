/**
 * Self-developed claude-agent-sdk types.
 * Replaces @anthropic-ai/claude-agent-sdk shim.
 */

/**
 * Permission mode for controlling how tool executions are handled.
 * - 'default' — Standard behavior, prompts for dangerous operations
 * - 'acceptEdits' — Auto-accept file edit operations
 * - 'bypassPermissions' — Bypass all permission checks
 * - 'plan' — Planning mode, no actual tool execution
 * - 'dontAsk' — Don't prompt for permissions, deny if not pre-approved
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
