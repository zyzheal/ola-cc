/**
 * CodegraphHandlers — operation logic extracted from CodegraphTool.call()
 *
 * Each handler receives a HandlerContext and typed input, returns result data.
 * The tool layer (CodegraphTool.ts) handles schema validation, auto-init,
 * input sanitization, progress rendering, error wrapping, usage tracking,
 * and freshness notes.
 */

import { GraphStore } from '../../services/graph/GraphStore.js'
import { GraphEngine } from '../../services/graph/GraphEngine.js'
import type { GraphSnapshot } from '../../services/graph/GraphEngine.js'
import { FtsSearch } from '../../services/graph/FtsSearch.js'
import { RrfSearch } from '../../services/graph/RrfSearch.js'
import { UnresolvedRefManager } from '../../services/graph/UnresolvedRefManager.js'
import { normalizeKind, VALID_KINDS, getKindAliases } from '../../services/graph/NodeKindNormalizer.js'
import * as CodegraphManager from './CodegraphManager.js'
import { resolve } from 'path'

// ============================================================
// Types
// ============================================================

export interface HandlerContext {
  projectRoot: string
  sendProgress: (stage: string, message?: string, progress?: number) => void
  onStderrProgress: (line: string) => void
}

/**
 * Thrown by handlers for validation errors (missing required params).
 * The tool layer catches this and returns an error response.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

// ============================================================
// Shared utility
// ============================================================

export function parseJsonOrError(r: { ok: boolean; stdout: string; stderr: string }): unknown {
  if (!r.ok) {
    throw new Error(r.stderr || 'command failed')
  }
  try {
    return JSON.parse(r.stdout)
  } catch {
    // Non-JSON output from CLI — return as string but log warning for debugging
    const trimmed = r.stdout.trim().slice(0, 2000)
    if (trimmed.length > 0) {
      return trimmed
    }
    throw new Error('CodeGraph CLI returned empty output')
  }
}

// ============================================================
// CLI handlers (just call CodegraphManager)
// ============================================================

export async function handleContext(ctx: HandlerContext, input: { query?: string; maxNodes?: number; format?: string }): Promise<unknown> {
  if (!input.query) throw new ValidationError('codegraph_context 需要 query 参数')
  ctx.sendProgress('context', `Querying: ${input.query.slice(0, 60)}…`)
  const r = await CodegraphManager.getContext(ctx.projectRoot, input.query, {
    maxNodes: input.maxNodes ?? 20,
    format: input.format ?? 'json',
  })
  return parseJsonOrError(r)
}

export async function handleSearch(ctx: HandlerContext, input: { query?: string; maxNodes?: number }): Promise<unknown> {
  if (!input.query) throw new ValidationError('codegraph_search 需要 query 参数')
  ctx.sendProgress('search', `Searching: ${input.query.slice(0, 60)}…`)
  try {
    // F-63: Use FTS5 + RRF fusion for search
    const store = GraphStore.getInstance(ctx.projectRoot)
    await store.load()
    const ftsDbPath = resolve(ctx.projectRoot, '.codegraph', 'fts-search.db')
    const fts = new FtsSearch(ftsDbPath)
    try {
      fts.createIndex()
      fts.indexNodes(store)
      const rrf = new RrfSearch(fts, store)
      const results = rrf.search(input.query, input.maxNodes ?? 20)
      return { results, total: results.length }
    } finally {
      fts.close()
    }
  } catch {
    // Fallback to CLI if FTS5 fails
    const r = await CodegraphManager.searchNodes(ctx.projectRoot, input.query, {
      limit: input.maxNodes ?? 20,
    })
    return parseJsonOrError(r)
  }
}

export async function handleCallers(ctx: HandlerContext, input: { symbol?: string; maxNodes?: number }): Promise<unknown> {
  if (!input.symbol) throw new ValidationError('codegraph_callers 需要 symbol 参数')
  ctx.sendProgress('callers', `Finding callers of ${input.symbol}…`)
  const r = await CodegraphManager.getCallers(ctx.projectRoot, input.symbol, {
    limit: input.maxNodes ?? 20,
  })
  return parseJsonOrError(r)
}

export async function handleCallees(ctx: HandlerContext, input: { symbol?: string; maxNodes?: number }): Promise<unknown> {
  if (!input.symbol) throw new ValidationError('codegraph_callees 需要 symbol 参数')
  ctx.sendProgress('callees', `Finding callees of ${input.symbol}…`)
  const r = await CodegraphManager.getCallees(ctx.projectRoot, input.symbol, {
    limit: input.maxNodes ?? 20,
  })
  return parseJsonOrError(r)
}

export async function handleStatus(ctx: HandlerContext, _input: Record<string, unknown>): Promise<unknown> {
  const r = await CodegraphManager.getStatus(ctx.projectRoot)
  return parseJsonOrError(r)
}

export async function handleFiles(ctx: HandlerContext, _input: Record<string, unknown>): Promise<unknown> {
  ctx.sendProgress('files', 'Listing indexed files…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const files = [...store.fileRecords.values()]
  return { files, total: files.length }
}

export async function handleInit(ctx: HandlerContext, input: Record<string, unknown>, onStderrProgress: (line: string) => void): Promise<unknown> {
  if (CodegraphManager.isCodegraphInitialized(ctx.projectRoot)) {
    return { message: 'CodeGraph 索引已存在，无需重复初始化', initialized: true }
  }
  ctx.sendProgress('init', 'Creating CodeGraph index…')
  const r = await CodegraphManager.initProject(ctx.projectRoot, onStderrProgress)
  if (!r.ok) throw new Error(r.stderr || '初始化失败')
  return { message: 'CodeGraph 索引已创建', initialized: true }
}

export async function handleSync(ctx: HandlerContext, _input: Record<string, unknown>): Promise<unknown> {
  ctx.sendProgress('sync', 'Syncing CodeGraph index…')
  const r = await CodegraphManager.sync(ctx.projectRoot, ctx.onStderrProgress)
  if (!r.ok) throw new Error(r.stderr || '同步失败')
  return parseJsonOrError(r)
}

// ============================================================
// Graph algorithm handlers (need store + engine)
// ============================================================

export async function handleImpact(ctx: HandlerContext, input: { symbol?: string; depth?: number; maxNodes?: number }): Promise<unknown> {
  if (!input.symbol) throw new ValidationError('codegraph_impact 需要 symbol 参数')
  const impactDepth = input.depth ?? 2
  if (impactDepth > 2) {
    // Deep impact analysis using GraphEngine (BFS + backward reachability + role classification)
    ctx.sendProgress('impact', `Deep impact analysis of ${input.symbol}…`)
    const store = GraphStore.getInstance(ctx.projectRoot)
    await store.load()
    const engine = new GraphEngine(store)
    const forward = engine.bfs(input.symbol, impactDepth)
    const backward = engine.backwardReachability(input.symbol)
    const roles = engine.classifyRoles()
    const impacted = forward.nodes.map(n => ({
      node: n,
      depth: forward.depth.get(n) ?? 0,
      role: roles.get(n) ?? 'utility',
      meta: store.getNode(n),
    }))
    const dependents = backward.reachable.map(n => ({
      node: n,
      role: roles.get(n) ?? 'utility',
      meta: store.getNode(n),
    }))
    return {
      symbol: input.symbol,
      forwardImpact: impacted.slice(0, input.maxNodes ?? 30),
      backwardDependents: dependents.slice(0, input.maxNodes ?? 30),
      forwardCount: forward.nodes.length,
      backwardCount: backward.reachable.length,
    }
  } else {
    // Basic impact analysis using CLI
    ctx.sendProgress('impact', `Analyzing impact of ${input.symbol}…`)
    const r = await CodegraphManager.getImpact(ctx.projectRoot, input.symbol, impactDepth)
    return parseJsonOrError(r)
  }
}

export async function handleScc(ctx: HandlerContext, input: { maxNodes?: number }): Promise<unknown> {
  ctx.sendProgress('scc', 'Computing strongly connected components…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  const sccs = engine.tarjanSCC()
  const nonTrivial = sccs.filter(s => !s.isTrivial)
  return {
    totalComponents: sccs.length,
    nonTrivialComponents: nonTrivial.length,
    components: sccs.slice(0, input.maxNodes ?? 20),
  }
}

export async function handleToposort(ctx: HandlerContext, input: { maxNodes?: number }): Promise<unknown> {
  ctx.sendProgress('toposort', 'Computing topological order…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  const topo = engine.topologicalSort()
  return {
    order: topo.order.slice(0, input.maxNodes ?? 50),
    totalNodes: topo.order.length,
    hasCycles: !!topo.cycles && topo.cycles.length > 0,
    cycles: topo.cycles?.slice(0, 10),
  }
}

export async function handleDelta(ctx: HandlerContext, input: { maxNodes?: number }): Promise<unknown> {
  ctx.sendProgress('delta', 'Computing graph delta…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  // Build current snapshot
  const curr: GraphSnapshot = {
    adjacency: new Map(store.adjacency),
    nodeMeta: new Map(store.nodeMeta),
    timestamp: Date.now(),
  }
  // For old snapshot: reload from disk (represents previous state)
  const oldStore = GraphStore.getInstance(ctx.projectRoot)
  await oldStore.reload()
  const old: GraphSnapshot = {
    adjacency: new Map(oldStore.adjacency),
    nodeMeta: new Map(oldStore.nodeMeta),
    timestamp: Date.now() - 1000,
  }
  const delta = engine.deltaGraph(old, curr)
  return {
    added: delta.added.slice(0, input.maxNodes ?? 50),
    removed: delta.removed.slice(0, input.maxNodes ?? 50),
    edgeAdded: delta.edgeAdded.slice(0, input.maxNodes ?? 50),
    edgeRemoved: delta.edgeRemoved.slice(0, input.maxNodes ?? 50),
    summary: delta.summary,
  }
}

export async function handlePagerank(ctx: HandlerContext, input: { damping?: number; maxNodes?: number }): Promise<unknown> {
  ctx.sendProgress('pagerank', 'Computing PageRank scores…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  const pr = engine.pageRank(input.damping ?? 0.85)
  const topN = input.maxNodes ?? 20
  return {
    topNodes: pr.scores.slice(0, topN).map(s => ({
      node: s.node,
      score: Math.round(s.score * 10000) / 10000,
      meta: store.getNode(s.node),
    })),
    totalScored: pr.scores.length,
  }
}

export async function handleRoles(ctx: HandlerContext, input: { maxNodes?: number }): Promise<unknown> {
  ctx.sendProgress('roles', 'Classifying node roles…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  const roles = engine.classifyRoles()
  // Group by role
  const grouped: Record<string, Array<{ node: string; meta?: unknown }>> = {}
  for (const [node, role] of roles) {
    if (!grouped[role]) grouped[role] = []
    grouped[role].push({ node, meta: store.getNode(node) })
  }
  // Limit per group
  const limit = input.maxNodes ?? 20
  for (const role of Object.keys(grouped)) {
    grouped[role] = grouped[role].slice(0, limit)
  }
  return {
    distribution: Object.fromEntries(
      Object.entries(grouped).map(([r, nodes]) => [r, { count: nodes.length, sample: nodes.slice(0, 5) }])
    ),
    totalNodes: roles.size,
  }
}

export async function handleSlice(ctx: HandlerContext, input: { symbol?: string; maxNodes?: number }): Promise<unknown> {
  if (!input.symbol) throw new ValidationError('codegraph_slice 需要 symbol 参数')
  ctx.sendProgress('slice', `Computing data slice for ${input.symbol}…`)
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  const slice = engine.backwardDataSlice(input.symbol)
  return {
    symbol: input.symbol,
    symbols: slice.symbols.slice(0, input.maxNodes ?? 30),
    dataFlows: slice.dataFlows.slice(0, input.maxNodes ?? 30),
    totalSymbols: slice.symbols.length,
  }
}

export async function handleCoupling(ctx: HandlerContext, input: { maxNodes?: number }): Promise<unknown> {
  ctx.sendProgress('coupling', 'Computing coupling metrics…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  const metrics = engine.couplingMetrics()
  return {
    highCoupling: metrics.highCoupling.slice(0, input.maxNodes ?? 20),
    lcom: metrics.lcom.slice(0, input.maxNodes ?? 20),
    totalHighCoupling: metrics.highCoupling.length,
    totalClasses: metrics.lcom.length,
  }
}

export async function handleCommunity(ctx: HandlerContext, input: { resolution?: number; maxNodes?: number }): Promise<unknown> {
  ctx.sendProgress('community', 'Running Louvain community detection…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  const community = engine.louvainCommunity({ resolution: input.resolution ?? 1.0 })
  const limit = input.maxNodes ?? 20
  return {
    communities: community.communities
      .sort((a, b) => b.size - a.size)
      .slice(0, limit)
      .map(c => ({
        id: c.id,
        size: c.size,
        sample: c.nodes.slice(0, 5),
      })),
    modularity: community.modularity,
    resolution: community.resolution,
    totalCommunities: community.communities.length,
  }
}

export async function handleCentrality(ctx: HandlerContext, input: { method?: string; maxNodes?: number; sampleSize?: number }): Promise<unknown> {
  const method = input.method ?? 'both'
  ctx.sendProgress('centrality', `Computing ${method} centrality…`)
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  const topN = input.maxNodes ?? 20
  const result: Record<string, unknown> = {}
  if (method === 'katz' || method === 'both') {
    const katz = engine.katzCentrality()
    result.katz = katz.scores.slice(0, topN).map(s => ({
      node: s.node,
      score: Math.round(s.score * 10000) / 10000,
      meta: store.getNode(s.node),
    }))
  }
  if (method === 'betweenness' || method === 'both') {
    const bc = engine.betweennessCentrality(input.sampleSize ?? 200)
    result.betweenness = bc.scores.slice(0, topN).map(s => ({
      node: s.node,
      score: Math.round(s.score * 10000) / 10000,
      meta: store.getNode(s.node),
    }))
  }
  return result
}

export async function handleTemporal(ctx: HandlerContext, input: { since?: string; maxNodes?: number }): Promise<unknown> {
  ctx.sendProgress('temporal', 'Analyzing temporal coupling…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const engine = new GraphEngine(store)
  const temporal = engine.temporalCoupling(ctx.projectRoot, {
    since: input.since || '30 days',
  })
  return {
    pairs: temporal.pairs.slice(0, input.maxNodes ?? 20),
    totalPairs: temporal.pairs.length,
    timeRange: input.since || '30 days',
  }
}

// ============================================================
// Complex handlers
// ============================================================

export async function handleTrace(ctx: HandlerContext, input: { query?: string; depth?: number }): Promise<unknown> {
  if (!input.query) throw new ValidationError('codegraph_trace 需要 query 参数（格式: "从X到Y"）')
  ctx.sendProgress('trace', `Tracing: ${input.query.slice(0, 60)}…`)
  const parts = input.query.split(/\s*(?:到|to|→|->)\s*/).filter(Boolean)
  if (parts.length < 2) {
    throw new ValidationError('需要 "X 到 Y" 格式')
  } else if (parts.length > 2) {
    throw new ValidationError('只支持两个符号之间的追踪，请使用 "X 到 Y" 格式')
  } else {
    // Find from and to symbols
    ctx.sendProgress('trace', `Searching symbols…`)
    const fromNodes = await CodegraphManager.searchNodes(ctx.projectRoot, parts[0], { limit: 1 })
    const toNodes = await CodegraphManager.searchNodes(ctx.projectRoot, parts[1], { limit: 1 })
    let fromParsed: unknown, toParsed: unknown
    try {
      fromParsed = parseJsonOrError(fromNodes)
    } catch (e) {
      throw new Error(`Symbol lookup failed for "${parts[0]}": ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      toParsed = parseJsonOrError(toNodes)
    } catch (e) {
      throw new Error(`Symbol lookup failed for "${parts[1]}": ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!Array.isArray(fromParsed)) {
      throw new Error(`Symbol search for "${parts[0]}" returned unexpected format (${typeof fromParsed})`)
    }
    if (!Array.isArray(toParsed)) {
      throw new Error(`Symbol search for "${parts[1]}" returned unexpected format (${typeof toParsed})`)
    }
    const fromName = fromParsed.length > 0 ? (fromParsed[0].name || fromParsed[0].symbol) : null
    const toName = toParsed.length > 0 ? (toParsed[0].name || toParsed[0].symbol) : null
    if (fromName && toName) {
      // Bidirectional impact analysis to find connecting nodes
      const [fromImpact, toImpact] = await Promise.all([
        CodegraphManager.getImpact(ctx.projectRoot, fromName, input.depth ?? 3),
        CodegraphManager.getImpact(ctx.projectRoot, toName, input.depth ?? 3),
      ])
      let fromGraph: unknown, toGraph: unknown
      try {
        fromGraph = parseJsonOrError(fromImpact)
      } catch (e) {
        throw new Error(`Impact query failed for "${fromName}": ${e instanceof Error ? e.message : String(e)}`)
      }
      try {
        toGraph = parseJsonOrError(toImpact)
      } catch (e) {
        throw new Error(`Impact query failed for "${toName}": ${e instanceof Error ? e.message : String(e)}`)
      }
      if (!Array.isArray(fromGraph)) {
        throw new Error(`Impact result for "${fromName}" is not structured data (got ${typeof fromGraph})`)
      }
      if (!Array.isArray(toGraph)) {
        throw new Error(`Impact result for "${toName}" is not structured data (got ${typeof toGraph})`)
      }
      // Find intersection: nodes in both from's downstream and to's upstream
      const fromSet = new Set(fromGraph.map((n: Record<string, unknown>) => n.name))
      const pathNodes = toGraph.filter((n: Record<string, unknown>) => fromSet.has(n.name))
      return {
        from: fromName,
        to: toName,
        connectingNodes: pathNodes.slice(0, 10),
        message: pathNodes.length > 0
          ? `找到 ${pathNodes.length} 个连接节点`
          : '未找到直接连接路径，可能需要增加 depth 参数',
      }
    } else {
      const missingSymbol = !fromName ? parts[0] : parts[1]
      throw new ValidationError(`未找到符号: ${missingSymbol}`)
    }
  }
}

export async function handleUnresolved(ctx: HandlerContext, input: { maxNodes?: number }): Promise<unknown> {
  ctx.sendProgress('unresolved', 'Scanning for unresolved references…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const manager = new UnresolvedRefManager(store)
  manager.loadFromEdges()
  const unresolved = manager.getUnresolved()
  const resolvedCount = manager.resolve()
  return {
    unresolved: unresolved.slice(0, input.maxNodes ?? 30),
    total: unresolved.length,
    resolved: resolvedCount,
  }
}

export async function handleKindMap(ctx: HandlerContext, _input: Record<string, unknown>): Promise<unknown> {
  ctx.sendProgress('kind_map', 'Building kind/edge mapping diagnostics…')
  const store = GraphStore.getInstance(ctx.projectRoot)
  await store.load()
  const edgeMap: Record<string, string> = {
    calls: 'calls', imports: 'imports', contains: 'contains',
    references: 'data', extends: 'inherits', implements: 'implements',
    exports: 'exports', type_of: 'type_of', returns: 'returns',
    instantiates: 'instantiates', overrides: 'overrides', decorates: 'decorates',
    subscribes: 'subscribes', publishes: 'publishes', middleware: 'middleware',
    flow_step: 'flow_step', cross_domain: 'cross_domain',
    reads: 'reads', writes: 'writes', tests: 'tests',
    configures: 'configures', deploys: 'deploys', monitors: 'monitors',
    validates: 'validates', transforms: 'transforms', caches: 'caches',
    queues: 'queues', notifies: 'notifies',
    serializes: 'serializes', deserializes: 'deserializes',
    encrypts: 'encrypts', decrypts: 'decrypts', compresses: 'compresses',
    logs: 'logs', metrics: 'metrics', traces_edge: 'traces',
    authenticates: 'authenticates', authorizes: 'authorizes',
    rate_limits: 'rate_limits',
  }
  // Count edge types in graph
  const edgeTypeCounts: Record<string, number> = {}
  for (const outMap of store.adjacency.values()) {
    for (const edges of outMap.values()) {
      for (const edge of edges) {
        edgeTypeCounts[edge.type] = (edgeTypeCounts[edge.type] ?? 0) + 1
      }
    }
  }
  // Count node kinds in graph
  const nodeKindCounts: Record<string, number> = {}
  for (const node of store.nodeMeta.values()) {
    nodeKindCounts[node.kind] = (nodeKindCounts[node.kind] ?? 0) + 1
  }
  return {
    edgeKindMapping: edgeMap,
    nodeKindAliases: getKindAliases(),
    validNodeKinds: [...VALID_KINDS],
    graphStats: {
      nodeKinds: nodeKindCounts,
      edgeTypes: edgeTypeCounts,
      totalNodes: store.nodeMeta.size,
    },
    normalizeKindExamples: {
      fn: normalizeKind('fn'),
      cls: normalizeKind('cls'),
      struct: normalizeKind('struct'),
      trait: normalizeKind('trait'),
      proc: normalizeKind('proc'),
      iface: normalizeKind('iface'),
    },
  }
}
