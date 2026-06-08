/**
 * Tool ranker for progressive disclosure.
 *
 * Implements BM25-style keyword ranking to select a relevant subset of tools
 * for each API call, rather than sending all tools every time. This saves
 * tokens on long conversations where the full tool list can be 10K-30K tokens.
 *
 * Strategy:
 * 1. Extract search terms from recent conversation context
 * 2. Score tools by keyword match against name, searchHint, and full description
 * 3. Return top-K tools, always including core tools (Read, Edit, Bash, etc.)
 *
 * This is simpler than OpenSpace's 3-stage pipeline (BM25 → embedding → LLM)
 * because:
 * - BM25 alone is sufficient for tool name/description matching
 * - No embedding model needed (avoids extra API calls and latency)
 * - No LLM ranking needed (avoids extra LLM call)
 */

import memoize from 'lodash-es/memoize.js'
import { type Tool, type Tools, type ToolPermissionContext, toolMatchesName } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { escapeRegExp } from '../../utils/stringUtils.js'
import { getCacheStrategy } from '../../utils/model/providers.js'
import { getSessionId } from '../../bootstrap/state.js'

// -- Configuration

/** Minimum number of tools to always include (core tools floor) */
const MIN_TOOL_COUNT = 15

/** Maximum number of tools to send to the API */
const MAX_TOOL_COUNT = 25

/** Phase 1: number of candidates for second-phase detailed scoring */
const PHASE1_MAX_CANDIDATES = 30

/** Tools that are always included regardless of ranking score */
const ALWAYS_INCLUDE_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'codegraph',
  'grok',
]

// -- Tokenization

/**
 * Split a query into terms, handling CamelCase and underscores.
 */
function extractTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2') // CamelCase → spaces
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(term => term.length > 1) // Skip single-char terms
}

// -- Tool description caching

type RankOptions = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
}

/**
 * Get tool description with memoized caching.
 * Reuses ToolSearchTool's pattern: memoize by tool name to avoid
 * re-computing descriptions on subsequent ranking calls.
 *
 * LRU-style bounded cache to prevent unbounded growth during
 * long-lived sessions (inc-4120: OOM after ~3h).
 */
const MAX_MEMOIZED_DESC = 200
const getToolDescriptionMemoized = memoize(
  async (cacheKey: string, toolName: string, tools: Tools, opts: RankOptions): Promise<string> => {
    void cacheKey // Used for cache uniqueness only
    const tool = tools.find(t => toolMatchesName(t, toolName))
    if (!tool) return ''
    try {
      return await tool.prompt({
        getToolPermissionContext: opts.getToolPermissionContext,
        tools,
        agents: opts.agents,
        allowedAgentTypes: opts.allowedAgentTypes,
      })
    } catch {
      return `${tool.name} ${tool.searchHint ?? ''}`
    }
  },
  (cacheKey: string) => cacheKey,
)

/**
 * Evict oldest entries when cache grows beyond limit.
 * Called periodically from rankTools to keep memory bounded.
 */
function pruneMemoizedCache(): void {
  const cache = getToolDescriptionMemoized.cache
  const keys = Object.keys(cache)
  if (keys.length > MAX_MEMOIZED_DESC) {
    // lodash memoize cache is a plain object — delete excess entries
    const excess = keys.length - MAX_MEMOIZED_DESC
    for (let i = 0; i < excess; i++) {
      delete cache[keys[i]]
    }
  }
}

function getDescriptionCache(): { clear: () => void } {
  return getToolDescriptionMemoized.cache
}

// -- Scoring

interface ToolScore {
  tool: Tool
  score: number
}

/**
 * Score a single tool against the query terms.
 *
 * Scoring weights (tuned for tool discovery):
 * - Exact name match: 100 (highest priority)
 * - Name part match: 20 per term
 * - searchHint match: 15 per term (curated capability phrase)
 * - Description match: 8 per term (full prompt text, high signal)
 */
function scoreTool(
  tool: Tool,
  queryTerms: string[],
  termPatterns: Map<string, RegExp>,
  descriptionLower: string,
): number {
  let score = 0

  // Tool name matching
  const toolName = tool.name
  const toolNameLower = toolName.toLowerCase()
  const toolNameParts = extractTerms(toolName)

  for (const term of queryTerms) {
    // Exact name match (case-insensitive)
    if (toolNameLower === term) {
      score += 100
      continue
    }

    // Name part match
    if (toolNameParts.includes(term)) {
      score += 20
    } else if (toolNameParts.some(part => part.includes(term))) {
      score += 10
    }

    // Full name substring fallback
    if (toolNameLower.includes(term) && score === 0) {
      score += 5
    }

    // searchHint match — curated capability phrase
    if (tool.searchHint) {
      const hintLower = tool.searchHint.toLowerCase()
      const pattern = termPatterns.get(term)!
      if (pattern.test(hintLower)) {
        score += 15
      }
    }

    // Description match — use word boundary to reduce false positives
    const pattern = termPatterns.get(term)!
    if (pattern.test(descriptionLower)) {
      score += 8
    }
  }

  return score
}

// -- Session-level tool order freeze (prefix caching optimization)

/** Session-level cache for prefix caching providers (DeepSeek). */
const frozenToolOrder = new Map<string, { tools: Tools; hash: number }>()

/** Compute a hash of tool names to detect tool set changes (MCP connect/disconnect). */
function hashTools(tools: Tools): number {
  let h = 0
  for (const t of tools) h = ((h << 5) - h + t.name.length) | 0
  return h
}

function getToolsForPrefixCache(tools: Tools): Tools {
  const key = getSessionId()
  const frozen = frozenToolOrder.get(key)
  if (frozen && frozen.tools.length === tools.length && frozen.hash === hashTools(tools)) {
    return frozen.tools
  }
  // First call this session: sort core tools first, keep rest stable
  const alwaysSet = new Set(ALWAYS_INCLUDE_TOOLS)
  const sorted: Tools = [
    ...tools.filter(t => alwaysSet.has(t.name)),
    ...tools.filter(t => !alwaysSet.has(t.name)),
  ]
  frozenToolOrder.set(key, { tools: sorted, hash: hashTools(tools) })
  return sorted
}

// -- Main ranking function

/**
 * Rank tools by relevance to the query, returning top-K.
 *
 * Always includes:
 * 1. Tools in ALWAYS_INCLUDE_TOOLS
 * 2. Top-scoring tools up to MAX_TOOL_COUNT
 *
 * @param tools Full list of available tools
 * @param query Search query extracted from conversation context
 * @param opts Optional context for fetching full tool descriptions
 * @returns Ranked subset of tools
 */
export async function rankTools(
  tools: Tools,
  query: string,
  opts?: RankOptions,
): Promise<Tools> {
  // Prefix caching providers (DeepSeek): freeze tool order per-session
  if (getCacheStrategy() === 'prefix') {
    return getToolsForPrefixCache(tools).slice(0, MAX_TOOL_COUNT)
  }
  if (tools.length <= MIN_TOOL_COUNT) {
    // If we have fewer tools than the minimum, send them all
    return tools
  }

  const queryTerms = extractTerms(query)
  if (queryTerms.length === 0) {
    // Empty or meaningless query — send all tools (better than dropping relevant ones)
    return tools.slice(0, MAX_TOOL_COUNT)
  }

  // Pre-compile regex patterns (once per query, not per-tool)
  const termPatterns = new Map<string, RegExp>()
  for (const term of queryTerms) {
    termPatterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
  }

  // Prune memoized cache to prevent unbounded growth (inc-4120: OOM after ~3h)
  pruneMemoizedCache()

  // Pre-compute descriptions for all tools (uses memoized cache)
  const toolDescriptions = new Map<string, string>()
  // Cache key: tool descriptions depend on the current tools list and agents,
  // so invalidate when those change. This prevents stale cached descriptions
  // when MCP tools connect/disconnect between turns.
  const cacheKey = `tools:${tools.length}:agents:${opts?.agents.length ?? 0}`
  for (const tool of tools) {
    let desc: string
    if (opts) {
      desc = await getToolDescriptionMemoized(cacheKey, tool.name, tools, opts)
    } else {
      // Fallback: name + searchHint only (fast, no async context needed)
      desc = `${tool.name} ${tool.searchHint ?? ''}`
    }
    toolDescriptions.set(tool.name, desc.toLowerCase())
  }

  // Score all tools
  const scored: ToolScore[] = tools.map(tool => ({
    tool,
    score: scoreTool(
      tool,
      queryTerms,
      termPatterns,
      toolDescriptions.get(tool.name) ?? '',
    ),
  }))

  // Always-include tools
  const alwaysInclude = new Set<string>(ALWAYS_INCLUDE_TOOLS)
  const coreTools: ToolScore[] = []
  const rankedTools: ToolScore[] = []

  for (const s of scored) {
    if (alwaysInclude.has(s.tool.name)) {
      coreTools.push(s)
    } else {
      rankedTools.push(s)
    }
  }

  // Sort ranked tools by score descending
  rankedTools.sort((a, b) => b.score - a.score)

  // Take top tools up to MAX_TOOL_COUNT (including core tools)
  const remainingSlots = Math.max(0, MAX_TOOL_COUNT - coreTools.length)
  const topRanked = rankedTools.slice(0, remainingSlots)

  // Combine and deduplicate
  const combined = [...coreTools, ...topRanked]
  const seen = new Set<string>()
  const result: Tools = combined
    .filter(s => {
      if (seen.has(s.tool.name)) return false
      seen.add(s.tool.name)
      return true
    })
    .map(s => s.tool)

  return result
}

/**
 * Two-phase tool ranking for better performance:
 * - Phase 1: Lightweight scoring using only name + searchHint (no async)
 * - Phase 2: Full description scoring for top-K candidates
 *
 * This reduces latency by avoiding async tool.prompt() calls for tools
 * that won't make it to the final selection anyway.
 */
export async function rankToolsTwoPhase(
  tools: Tools,
  query: string,
  opts?: RankOptions,
): Promise<Tools> {
  if (tools.length <= MIN_TOOL_COUNT) {
    return tools
  }

  const queryTerms = extractTerms(query)
  if (queryTerms.length === 0) {
    return tools.slice(0, MAX_TOOL_COUNT)
  }

  // Pre-compile regex patterns
  const termPatterns = new Map<string, RegExp>()
  for (const term of queryTerms) {
    termPatterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
  }

  // Prune memoized cache to prevent unbounded growth (inc-4120: OOM after ~3h)
  pruneMemoizedCache()

  // === PHASE 1: Lightweight scoring (name + searchHint only) ===
  const alwaysInclude = new Set<string>(ALWAYS_INCLUDE_TOOLS)
  const phase1Scores: ToolScore[] = []

  for (const tool of tools) {
    // Core tools always included
    if (alwaysInclude.has(tool.name)) {
      phase1Scores.push({ tool, score: 1000 }) // High score to ensure inclusion
      continue
    }

    // Lightweight scoring: name + searchHint (no async call)
    let score = 0
    const toolNameLower = tool.name.toLowerCase()
    const toolNameParts = extractTerms(tool.name)

    for (const term of queryTerms) {
      // Exact name match
      if (toolNameLower === term) {
        score += 100
        continue
      }
      // Name part match
      if (toolNameParts.includes(term)) {
        score += 20
      } else if (toolNameParts.some(part => part.includes(term))) {
        score += 10
      }
      // searchHint match
      if (tool.searchHint) {
        const hintLower = tool.searchHint.toLowerCase()
        if (hintLower.includes(term)) {
          score += 15
        }
      }
    }

    phase1Scores.push({ tool, score })
  }

  // Sort by phase1 score and take top candidates
  phase1Scores.sort((a, b) => b.score - a.score)
  const phase1Top = phase1Scores
    .filter(s => !alwaysInclude.has(s.tool.name))
    .slice(0, PHASE1_MAX_CANDIDATES)
    .map(s => s.tool)

  // === PHASE 2: Full description scoring for candidates ===
  // If no opts, skip phase 2 and return phase1 results
  if (!opts) {
    const combined = [
      ...tools.filter(t => alwaysInclude.has(t.name)),
      ...phase1Top.slice(0, MAX_TOOL_COUNT - ALWAYS_INCLUDE_TOOLS.length),
    ]
    return combined.slice(0, MAX_TOOL_COUNT)
  }

  // Phase 2: Get full descriptions for candidates
  const cacheKey = `tools:${tools.length}:agents:${opts.agents.length ?? 0}`
  const candidateDescriptions = new Map<string, string>()

  for (const tool of phase1Top) {
    const desc = await getToolDescriptionMemoized(cacheKey, tool.name, tools, opts)
    candidateDescriptions.set(tool.name, desc.toLowerCase())
  }

  // Score with full descriptions
  const phase2Scores: ToolScore[] = []

  for (const tool of tools) {
    if (alwaysInclude.has(tool.name)) {
      phase2Scores.push({ tool, score: 1000 })
      continue
    }

    const descLower = candidateDescriptions.get(tool.name) ?? ''
    const score = scoreTool(tool, queryTerms, termPatterns, descLower)
    phase2Scores.push({ tool, score })
  }

  // Final sort and selection
  phase2Scores.sort((a, b) => b.score - a.score)

  const finalCore = phase2Scores.filter(s => alwaysInclude.has(s.tool.name))
  const finalRanked = phase2Scores.filter(s => !alwaysInclude.has(s.tool.name))

  const remainingSlots = Math.max(0, MAX_TOOL_COUNT - finalCore.length)
  const finalResult = [
    ...finalCore,
    ...finalRanked.slice(0, remainingSlots),
  ].slice(0, MAX_TOOL_COUNT).map(s => s.tool)

  return finalResult
}

/**
 * Invalidate the description cache (e.g., when tools change).
 * Also clears the frozen tool order cache for prefix caching providers.
 */
export function invalidateDescriptionCache(): void {
  getDescriptionCache().clear()
  frozenToolOrder.clear()
}

/**
 * Extract a search query from recent conversation messages.
 *
 * Looks at the last user message and extracts meaningful terms.
 * This is used as the ranking query for tool selection.
 */
export function extractQueryFromMessages(
  messages: Array<{
    type?: string
    role?: string
    message?: { content?: unknown }
    content?: unknown
  }>,
): string {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type === 'user' || msg.role === 'user') {
      // UserMessage has nested message.content
      const content = msg.message?.content ?? msg.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(b => typeof b === 'object' && b !== null && 'type' in b && (b as { type: string }).type === 'text')
              .map(b => (b as { text?: string }).text ?? '')
              .join(' ')
          : ''
      // Take first 500 chars as query (enough for term extraction)
      return text.slice(0, 500)
    }
  }
  return ''
}
