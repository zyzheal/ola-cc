/**
 * GraphContextService — PreToolUse hook context provider
 *
 * Provides graph context for codegraph/grok tool calls:
 * - hotspots: top PageRank nodes (cached, TTL 60s)
 * - communityCount: number of Louvain communities (cached, TTL 60s)
 * - relatedNodes: nodes related to the query/symbol in input
 * - suggestedOperations: recommended next graph operations
 *
 * All graph computations cached with 60s TTL. Must complete under 50ms on cache hit.
 * Graceful degradation: if GraphStore not loaded, returns empty context.
 */

import { GraphStore } from './GraphStore.js'
import { GraphEngine } from './GraphEngine.js'

// ============================================================
// Types
// ============================================================

export interface PreToolContext {
  hotspots: Array<{ id: string; name: string; score: number }>
  communityCount: number
  relatedNodes: Array<{ id: string; name: string; kind: string }>
  suggestedOperations: string[]
}

// ============================================================
// Operation suggestion map
// ============================================================

const OPERATION_SUGGESTIONS: Record<string, string[]> = {
  codegraph_search: ['codegraph_callers', 'codegraph_callees', 'codegraph_context'],
  codegraph_callers: ['codegraph_callees', 'codegraph_impact', 'codegraph_context'],
  codegraph_pagerank: ['codegraph_community', 'codegraph_roles', 'codegraph_centrality'],
  grok_generate: ['grok_architecture', 'grok_hotspots', 'grok_tour'],
  grok_architecture: ['grok_hotspots', 'grok_domain', 'grok_tour'],
}

const DEFAULT_SUGGESTIONS = ['codegraph_search', 'grok_architecture']

// ============================================================
// Cache entry
// ============================================================

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

const CACHE_TTL_MS = 60_000

// ============================================================
// GraphContextService
// ============================================================

export class GraphContextService {
  private static instances = new Map<string, GraphContextService>()

  private hotspotsCache: CacheEntry<Array<{ id: string; name: string; score: number }>> | null = null
  private communityCountCache: CacheEntry<number> | null = null

  private constructor(private readonly projectRoot: string) {}

  /**
   * Get singleton instance keyed by projectRoot.
   */
  static getInstance(projectRoot: string): GraphContextService {
    let instance = GraphContextService.instances.get(projectRoot)
    if (!instance) {
      instance = new GraphContextService(projectRoot)
      GraphContextService.instances.set(projectRoot, instance)
    }
    return instance
  }

  /**
   * Delete singleton instance (for testing cleanup).
   */
  static deleteInstance(projectRoot: string): void {
    GraphContextService.instances.delete(projectRoot)
  }

  /**
   * Get pre-tool context for a codegraph/grok tool call.
   * Synchronous — uses cached computations. Returns empty context if store not loaded.
   */
  getPreToolContext(toolName: string, input: Record<string, unknown>): PreToolContext {
    const store = GraphStore.getInstance(this.projectRoot)

    // Graceful degradation: if store not loaded, return empty context
    if (!store.isLoaded) {
      return {
        hotspots: [],
        communityCount: 0,
        relatedNodes: [],
        suggestedOperations: this.getSuggestedOperations(toolName),
      }
    }

    return {
      hotspots: this.getHotspots(store),
      communityCount: this.getCommunityCount(store),
      relatedNodes: this.getRelatedNodes(store, toolName, input),
      suggestedOperations: this.getSuggestedOperations(toolName),
    }
  }

  /**
   * Get recommended graph operations based on query keywords.
   * Synchronous, no cache needed (simple string matching).
   */
  getRecommendations(query: string): string[] {
    const lower = query.toLowerCase()

    // Match keywords to operations (more specific keywords first to avoid false matches)
    if (lower.includes('dead') || lower.includes('unused')) {
      return ['codegraph_roles', 'codegraph_centrality', 'codegraph_pagerank']
    }
    if (lower.includes('pagerank') || lower.includes('important') || lower.includes('hotspot')) {
      return ['codegraph_pagerank', 'codegraph_community', 'codegraph_roles']
    }
    if (lower.includes('caller') || lower.includes('who calls')) {
      return ['codegraph_callers', 'codegraph_impact', 'codegraph_context']
    }
    if (lower.includes('callee') || lower.includes('calls to')) {
      return ['codegraph_callees', 'codegraph_search', 'codegraph_context']
    }
    if (lower.includes('community') || lower.includes('cluster') || lower.includes('module')) {
      return ['codegraph_community', 'codegraph_roles', 'grok_domain']
    }
    if (lower.includes('architecture') || lower.includes('structure') || lower.includes('overview')) {
      return ['grok_architecture', 'grok_hotspots', 'grok_tour']
    }
    if (lower.includes('impact') || lower.includes('affect') || lower.includes('change')) {
      return ['codegraph_impact', 'codegraph_callers', 'codegraph_callees']
    }
    if (lower.includes('search') || lower.includes('find') || lower.includes('where')) {
      return ['codegraph_search', 'codegraph_callers', 'codegraph_context']
    }

    return DEFAULT_SUGGESTIONS
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /**
   * Get top 5 PageRank nodes (cached with 60s TTL).
   */
  private getHotspots(store: GraphStore): Array<{ id: string; name: string; score: number }> {
    if (this.hotspotsCache && Date.now() < this.hotspotsCache.expiresAt) {
      return this.hotspotsCache.value
    }

    const engine = new GraphEngine(store)
    const pr = engine.pageRank()
    const top5 = pr.scores.slice(0, 5).map(s => {
      const meta = store.getNode(s.node)
      return {
        id: s.node,
        name: meta?.name ?? s.node,
        score: Math.round(s.score * 1000) / 1000,
      }
    })

    this.hotspotsCache = { value: top5, expiresAt: Date.now() + CACHE_TTL_MS }
    return top5
  }

  /**
   * Get number of unique Louvain communities (cached with 60s TTL).
   */
  private getCommunityCount(store: GraphStore): number {
    if (this.communityCountCache && Date.now() < this.communityCountCache.expiresAt) {
      return this.communityCountCache.value
    }

    const engine = new GraphEngine(store)
    const result = engine.louvainCommunity()
    const count = result.communities.length

    this.communityCountCache = { value: count, expiresAt: Date.now() + CACHE_TTL_MS }
    return count
  }

  /**
   * Get nodes related to the query/symbol in the tool input (up to 5).
   */
  private getRelatedNodes(
    store: GraphStore,
    toolName: string,
    input: Record<string, unknown>,
  ): Array<{ id: string; name: string; kind: string }> {
    // Extract query/symbol from input
    const query = this.extractQuery(toolName, input)
    if (!query) return []

    // Try to find matching nodes
    const nodeIds = store.findAllByName(query)
    if (nodeIds.length === 0) {
      // Try single find (non-ambiguous)
      const singleId = store.findByName(query)
      if (singleId) nodeIds.push(singleId)
    }

    if (nodeIds.length === 0) return []

    // Collect related nodes from outgoing neighbors (up to 5 total)
    const related: Array<{ id: string; name: string; kind: string }> = []
    const seen = new Set<string>()

    for (const nodeId of nodeIds) {
      const neighbors = store.getOutNeighborIds(nodeId)
      for (const neighborId of neighbors) {
        if (related.length >= 5) break
        if (seen.has(neighborId)) continue
        seen.add(neighborId)

        const meta = store.getNode(neighborId)
        if (meta) {
          related.push({ id: neighborId, name: meta.name, kind: meta.kind })
        }
      }
      if (related.length >= 5) break
    }

    return related
  }

  /**
   * Extract the query/symbol string from tool input.
   */
  private extractQuery(toolName: string, input: Record<string, unknown>): string | null {
    // Common input fields that contain a query
    const candidates = ['query', 'symbol', 'name', 'nodeId', 'term', 'pattern']
    for (const key of candidates) {
      const val = input[key]
      if (typeof val === 'string' && val.length > 0) {
        return val
      }
    }
    return null
  }

  /**
   * Get suggested next operations based on the current tool name.
   */
  private getSuggestedOperations(toolName: string): string[] {
    return OPERATION_SUGGESTIONS[toolName] ?? DEFAULT_SUGGESTIONS
  }
}
