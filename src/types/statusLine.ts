/**
 * StatusLine command input type.
 * Passed to user-configured statusline commands for rendering dynamic status.
 */

export type StatusLineItem = Record<string, unknown>

/**
 * Memory usage metrics from process.memoryUsage()
 */
export type ProcessMemoryInfo = {
  rss: number
  heap_total: number
  heap_used: number
  external: number
  array_buffers: number
}

/**
 * Process information for statusline display
 */
export type ProcessInfo = {
  pid: number
  memory: ProcessMemoryInfo
}

/**
 * Rate limit utilization info for a single period
 */
export type RateLimitPeriodInfo = {
  used_percentage: number
  resets_at: string
}

/**
 * Rate limits utilization from Anthropic API
 */
export type RateLimitsInfo = {
  five_hour?: RateLimitPeriodInfo
  seven_day?: RateLimitPeriodInfo
}

/**
 * Model information
 */
export type ModelInfo = {
  id: string
  display_name: string
}

/**
 * Workspace information
 */
export type WorkspaceInfo = {
  current_dir: string
  project_dir: string
  added_dirs: string[]
}

/**
 * Version information
 */
export type VersionInfo = string

/**
 * Output style configuration
 */
export type OutputStyleInfo = {
  name: string
}

/**
 * Cost tracking information
 */
export type CostInfo = {
  total_cost_usd: number
  total_duration_ms: number
  total_api_duration_ms: number
  total_lines_added: number
  total_lines_removed: number
}

/**
 * Context window usage information
 */
export type ContextWindowInfo = {
  total_input_tokens: number
  total_output_tokens: number
  context_window_size: number
  current_usage: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  used_percentage: number
  remaining_percentage: number
}

/**
 * Vim mode information
 */
export type VimInfo = {
  mode: 'INSERT' | 'NORMAL' | 'VISUAL' | string
}

/**
 * Agent information
 */
export type AgentInfo = {
  name: string
}

/**
 * Remote session information
 */
export type RemoteInfo = {
  session_id: string
}

/**
 * Worktree session information
 */
export type WorktreeInfo = {
  name: string
  path: string
  branch: string
  original_cwd: string
  original_branch: string
}

/**
 * Base hook input fields (session_id, transcript_path, cwd, etc.)
 */
export type BaseHookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
}

/**
 * Full input passed to statusline commands.
 * Contains all session state for rendering dynamic status displays.
 */
export type StatusLineCommandInput = BaseHookInput & {
  session_name?: string
  process: ProcessInfo
  model: ModelInfo
  workspace: WorkspaceInfo
  version: VersionInfo
  output_style: OutputStyleInfo
  cost: CostInfo
  context_window: ContextWindowInfo
  exceeds_200k_tokens: boolean
  rate_limits?: RateLimitsInfo
  vim?: VimInfo
  agent?: AgentInfo
  remote?: RemoteInfo
  worktree?: WorktreeInfo
}