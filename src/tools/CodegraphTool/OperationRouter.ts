/**
 * OperationRouter — 智能路由 CLI vs GraphEngine
 *
 * 根据操作类型和数据源可用性，决定使用 CLI、GraphEngine 或混合路径。
 * 设计文档: docs/superpowers/specs/2026-06-05-codegraph-grok-enhancement-design.md
 */

// ============================================================
// Types
// ============================================================

export type OperationTarget = 'cli' | 'engine' | 'hybrid'

export interface RoutingDecision {
  target: OperationTarget
  reason: string
  fallback?: OperationTarget
}

// ============================================================
// Routing rules (static map)
// ============================================================

/** CLI-only operations: data lives in codegraph.db, CLI has native query support */
const CLI_OPERATIONS = new Set([
  'codegraph_search',
  'codegraph_context',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_files',
  'codegraph_status',
  'codegraph_init',
  'codegraph_sync',
])

/** Engine-only operations: require graph algorithms not available in CLI */
const ENGINE_OPERATIONS = new Set([
  'codegraph_scc',
  'codegraph_toposort',
  'codegraph_pagerank',
  'codegraph_roles',
  'codegraph_community',
  'codegraph_centrality',
  'codegraph_slice',
  'codegraph_coupling',
  'codegraph_temporal',
])

/** Operations that require both CLI and engine */
const HYBRID_OPERATIONS = new Set([
  'codegraph_delta',
  'codegraph_trace',
])

// ============================================================
// OperationRouter
// ============================================================

export class OperationRouter {
  /**
   * Decide where to route an operation.
   *
   * @param operation - The operation name (e.g. 'codegraph_search')
   * @param hasGraphEngine - Whether GraphStore + GraphEngine are available
   * @param hasCli - Whether codegraph CLI is installed and initialized
   * @param opts - Additional routing parameters (e.g. depth for impact)
   */
  static route(
    operation: string,
    hasGraphEngine: boolean,
    hasCli: boolean,
    opts?: { depth?: number },
  ): RoutingDecision {
    // ── Hybrid operations ──
    if (HYBRID_OPERATIONS.has(operation)) {
      if (operation === 'codegraph_delta') {
        // delta requires GraphEngine for diff computation + IncrementalSync
        if (hasGraphEngine) {
          return { target: 'hybrid', reason: 'Delta comparison requires GraphEngine snapshots + IncrementalSync' }
        }
        return { target: 'cli', reason: 'GraphEngine unavailable, falling back to CLI', fallback: undefined }
      }
      if (operation === 'codegraph_trace') {
        // trace: CLI for symbol search + GraphEngine for path finding
        if (hasGraphEngine && hasCli) {
          return { target: 'hybrid', reason: 'Trace uses CLI symbol lookup + GraphEngine path analysis' }
        }
        if (hasCli) {
          return { target: 'cli', reason: 'GraphEngine unavailable, using CLI bidirectional impact only' }
        }
        return { target: 'engine', reason: 'CLI unavailable, using GraphEngine BFS path finding', fallback: undefined }
      }
    }

    // ── Special case: codegraph_impact depends on depth ──
    if (operation === 'codegraph_impact') {
      const depth = opts?.depth ?? 2
      if (depth > 2 && hasGraphEngine) {
        return {
          target: 'engine',
          reason: `Deep impact (depth=${depth}) requires GraphEngine BFS + backward reachability`,
        }
      }
      if (hasCli) {
        return {
          target: 'cli',
          reason: `Shallow impact (depth=${depth}) uses CLI direct query`,
          fallback: hasGraphEngine ? 'engine' : undefined,
        }
      }
      if (hasGraphEngine) {
        return {
          target: 'engine',
          reason: 'CLI unavailable, using GraphEngine for impact analysis',
        }
      }
      return { target: 'cli', reason: 'No data source available, will trigger auto-init' }
    }

    // ── Engine-only operations ──
    if (ENGINE_OPERATIONS.has(operation)) {
      if (hasGraphEngine) {
        return { target: 'engine', reason: `${operation} requires graph algorithm engine` }
      }
      return {
        target: 'cli',
        reason: 'GraphEngine unavailable, will attempt CLI fallback (may fail)',
        fallback: undefined,
      }
    }

    // ── CLI-only operations ──
    if (CLI_OPERATIONS.has(operation)) {
      if (hasCli) {
        return { target: 'cli', reason: `${operation} uses codegraph CLI query` }
      }
      return {
        target: 'cli',
        reason: 'CLI not initialized, will trigger auto-init',
        fallback: undefined,
      }
    }

    // ── Unknown operation ──
    return {
      target: 'cli',
      reason: `Unknown operation "${operation}", defaulting to CLI`,
    }
  }

  /**
   * Get recommended operations for current data source availability.
   *
   * @param hasCodegraph - Whether codegraph.db exists
   * @param hasGrok - Whether knowledge-graph.json exists
   * @param hasGraphEngine - Whether GraphEngine can be used (either data source works)
   * @returns Array of available operation names
   */
  static getAvailable(
    hasCodegraph: boolean,
    hasGrok: boolean,
    hasGraphEngine: boolean,
  ): string[] {
    const available: string[] = []

    // CLI operations need codegraph
    if (hasCodegraph) {
      for (const op of CLI_OPERATIONS) {
        available.push(op)
      }
    }

    // Engine operations need GraphEngine (either data source)
    if (hasGraphEngine) {
      for (const op of ENGINE_OPERATIONS) {
        available.push(op)
      }
    }

    // Impact is available if either source exists
    if (hasCodegraph || hasGraphEngine) {
      available.push('codegraph_impact')
    }

    // Hybrid operations: best with both, but degraded with one
    if (hasCodegraph || hasGraphEngine) {
      available.push('codegraph_trace')
    }
    if (hasGraphEngine) {
      available.push('codegraph_delta')
    }

    // Status is always available
    if (!available.includes('codegraph_status')) {
      available.push('codegraph_status')
    }

    return [...new Set(available)].sort()
  }
}
