/**
 * Cached microcompact — cache-editing based tool result compaction.
 *
 * Uses the Anthropic API's `cache_edits` block type to delete tool results
 * from the server-side cache *without* invalidating the cached prompt prefix.
 *
 * Architecture (see microCompact.ts for the orchestration layer):
 *
 *   microCompact.ts        → collects tool results, decides what to delete
 *   cachedMicrocompact.ts  → tracks cache state, produces cache_edits blocks
 *   claude.ts              → inserts cache_edits + cache_reference into API params
 *
 * State model:
 *   - registeredTools: Set of tool_use_ids we've seen across user messages
 *   - toolOrder:       ordered list of tool_use_ids (encounter order)
 *   - messageGroups:   arrays of tool_use_ids grouped by user message
 *   - deletedRefs:     cache_references already deleted (no double-delete)
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'

// ─── Config ────────────────────────────────────────────────────────────────

const CACHED_MC_CONFIG_KEY = 'tengu_cached_mc_config_v2'
const CACHED_MC_REFRESH_MS = 5 * 60 * 1000

export interface CachedMCConfig {
  /** Minimum number of compactable tool results before we trigger a deletion. */
  triggerThreshold: number
  /** Number of most-recent tool results to keep (not delete). */
  keepRecent: number
  /** Models that support the cache_editing beta. */
  supportedModels: string[]
  /** GrowthBook feature value for enabled gate. */
  enabled: boolean
}

const DEFAULT_CACHED_MC_CONFIG: CachedMCConfig = {
  triggerThreshold: 3,
  keepRecent: 2,
  supportedModels: [
    'claude-sonnet-4-20250514',
    'claude-sonnet-4-20250515',
    'claude-sonnet-4-20250620',
    'claude-opus-4-0-20250414',
    'claude-opus-4-20250414',
    'claude-3-5-sonnet',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20240620',
  ],
  enabled: true,
}

function fetchConfig(): CachedMCConfig {
  const raw = getDynamicConfig_CACHED_MAY_BE_STALE<Partial<CachedMCConfig>>(
    CACHED_MC_CONFIG_KEY,
    {},
  )
  return {
    ...DEFAULT_CACHED_MC_CONFIG,
    ...raw,
  }
}

/**
 * Get the current cached microcompact configuration.
 * Refreshes from GrowthBook on a 5-minute interval.
 */
export function getCachedMCConfig(): CachedMCConfig {
  return fetchConfig()
}

// ─── Model support detection ───────────────────────────────────────────────

/**
 * Check whether a model supports the cache_editing beta.
 *
 * Models that support cache_editing can accept `cache_edits` blocks in the
 * request and will honour `cache_reference` markers on tool results.
 */
export function isModelSupportedForCacheEditing(model: string): boolean {
  const config = getCachedMCConfig()
  // Substring match to handle version suffixes like -20250514
  return config.supportedModels.some(
    (supported) =>
      model === supported || model.includes(supported.replace(/-\d{8}$/, '')),
  )
}

// ─── State ─────────────────────────────────────────────────────────────────

/**
 * Runtime state for tracking which tool results have been registered and
 * which should be deleted.
 */
export interface CachedMCState {
  /** Opaque identifier for this state instance. */
  id: string
  /** All tool_use_ids we have registered (not yet deleted). */
  registeredTools: Set<string>
  /** Ordered list of tool_use_ids in encounter order. */
  toolOrder: string[]
  /** Groups of tool_use_ids, one array per user message that contained them. */
  messageGroups: string[][]
  /** Cache references that have already been deleted (prevent double-delete). */
  deletedRefs: Set<string>
  /** Previously-pinned cache_edits blocks for re-insertion on subsequent calls. */
  pinnedEdits: import('./cachedMicrocompact.js').PinnedCacheEdits[]
}

/**
 * A cache_edits block to be inserted into the API request.
 * Tells the server to delete specific cache references from the cached prefix.
 */
export interface CacheEditsBlock {
  type: 'cache_edits'
  edits: Array<{
    type: 'delete'
    cache_reference: string
  }>
}

/**
 * A previously-pinned cache_edits block that must be re-sent at its original
 * position in subsequent API calls (cache hits require the same edits).
 */
export interface PinnedCacheEdits {
  userMessageIndex: number
  block: CacheEditsBlock
}

/**
 * Create and initialise a new CachedMCState instance.
 */
export function createCachedMCState(): CachedMCState {
  return {
    id: 'cached-mc-state-' + Math.random().toString(36).slice(2),
    registeredTools: new Set(),
    toolOrder: [],
    messageGroups: [],
    deletedRefs: new Set(),
    pinnedEdits: [],
  }
}

// ─── Tool result registration ──────────────────────────────────────────────

/**
 * Register a single tool result. Called for each compactable tool_use_id
 * found within a user message's tool_result blocks.
 *
 * Skips if the tool was already deleted (from a prior turn's cache_edits).
 */
export function registerToolResult(
  state: CachedMCState,
  toolUseId: string,
): void {
  if (state.deletedRefs.has(toolUseId)) {
    return
  }
  if (!state.registeredTools.has(toolUseId)) {
    state.registeredTools.add(toolUseId)
    state.toolOrder.push(toolUseId)
  }
}

/**
 * Register a message boundary. Called after processing all tool_results in
 * a single user message. Groups the currently accumulated tool IDs together
 * so we can reason about message-level deletion semantics.
 */
export function registerToolMessage(
  state: CachedMCState,
  toolUseIds: string[],
): void {
  if (toolUseIds.length > 0) {
    state.messageGroups.push([...toolUseIds])
  }
}

// ─── Deletion logic ────────────────────────────────────────────────────────

/**
 * Determine which registered tool results should be deleted.
 *
 * Strategy: keep the most recent `keepRecent` tool results, delete the rest.
 * This preserves the model's immediate working context while freeing older
 * cached entries.
 *
 * Returns an array of tool_use_ids that should be sent in a cache_edits block.
 */
export function getToolResultsToDelete(
  state: CachedMCState,
  config?: { keepRecent?: number; triggerThreshold?: number },
): string[] {
  const keepRecent = config?.keepRecent ?? getCachedMCConfig().keepRecent
  const triggerThreshold =
    config?.triggerThreshold ?? getCachedMCConfig().triggerThreshold

  const activeCount = state.toolOrder.length - state.deletedRefs.size

  // Don't trigger until we have enough tool results to justify a deletion.
  if (activeCount <= triggerThreshold + keepRecent) {
    return []
  }

  // Determine which tools to delete: oldest first, skipping the most recent N.
  const keepSet = new Set(state.toolOrder.slice(-Math.max(1, keepRecent)))
  const toDelete: string[] = []

  for (const id of state.toolOrder) {
    if (state.deletedRefs.has(id)) continue
    if (keepSet.has(id)) continue
    toDelete.push(id)
  }

  return toDelete
}

// ─── Cache edits block creation ────────────────────────────────────────────

/**
 * Build a `cache_edits` block for the API request.
 *
 * Each deleted tool result becomes a `{ type: 'delete', cache_reference: toolUseId }`
 * entry. The cache_reference is the tool_use_id because that's what the
 * addCacheBreakpoints function uses as the cache key for tool_result blocks.
 */
export function createCacheEditsBlock(
  state: CachedMCState,
  toolIds: string[],
): CacheEditsBlock | null {
  if (toolIds.length === 0) return null

  const edits = toolIds.map((id) => ({
    type: 'delete' as const,
    cache_reference: id,
  }))

  // Mark these tools as deleted so they're not double-deleted on the next turn.
  for (const id of toolIds) {
    state.deletedRefs.add(id)
    state.registeredTools.delete(id)
  }

  // Clean up toolOrder to remove deleted entries (keeps the list bounded).
  state.toolOrder = state.toolOrder.filter(
    (id) => !state.deletedRefs.has(id),
  )

  // Clean up messageGroups to remove deleted tool IDs.
  state.messageGroups = state.messageGroups
    .map((group) => group.filter((id) => !state.deletedRefs.has(id)))
    .filter((group) => group.length > 0)

  return { type: 'cache_edits', edits }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Mark all currently-registered tools as having been sent to the API.
 * Called after a successful API response so state stays in sync.
 */
export function markToolsSentToAPI(_state: CachedMCState): void {
  // In the current design, the API consumption is handled by
  // consumePendingCacheEdits() in microCompact.ts. This function exists
  // for future extensibility (e.g., tracking which tools were actually
  // acknowledged by the server).
}

/**
 * Reset all cached MC state. Called when the time-based microcompact fires
 * (which content-clears and invalidates the server cache, making our
 * cache_edits tracking stale).
 */
export function resetCachedMCState(state: CachedMCState): void {
  state.registeredTools.clear()
  state.toolOrder.length = 0
  state.messageGroups.length = 0
  state.deletedRefs.clear()
  state.pinnedEdits.length = 0
}

// ─── Enable gate ───────────────────────────────────────────────────────────

/**
 * Check whether cached microcompact is enabled.
 * Reads the GrowthBook feature flag `tengu_cached_mc_enabled`.
 */
export function isCachedMicrocompactEnabled(): boolean {
  const config = getCachedMCConfig()
  return config.enabled
}

// ─── Full microcompact integration (the createCachedMicrocompact factory) ───

/**
 * Create a cached microcompact instance. Returns the state object that
 * microCompact.ts will use to track and manage cache edits.
 *
 * This is the main factory function called from microCompact.ts when
 * `feature('CACHED_MICROCOMPACT')` is enabled.
 */
export function createCachedMicrocompact(): CachedMCState | null {
  if (!isCachedMicrocompactEnabled()) {
    return null
  }
  return createCachedMCState()
}
