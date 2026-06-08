/**
 * DomainAnalyzer — Three-layer business domain model
 *
 * Analyzes the code graph to discover:
 *   1. Domain (业务域): Business domains via community detection
 *   2. Flow (流程): Key execution paths within each domain
 *   3. Step (步骤): Individual operations within flows
 *
 * Design: docs/superpowers/plans/codegraph-grok-unified/02-graphengine-algorithms.md §Phase 3c
 * Design: docs/superpowers/plans/codegraph-grok-unified/08-ua-deep-analysis.md §2.4
 */

import type { GraphStore, NodeMetadata } from './GraphStore.js'
import type { GraphEngine } from './GraphEngine.js'

// ============================================================
// Types
// ============================================================

export interface DomainStep {
  id: string
  name: string
  file: string
  line: number
  kind: string
  order: number       // monotonic increasing within flow (0-1 range)
}

export interface DomainFlow {
  id: string
  name: string
  steps: DomainFlowStep[]
  entryNode: string   // dominator root
  nodeCount: number
}

export interface DomainFlowStep {
  nodeId: string
  name: string
  file: string
  kind: string
  order: number       // weight encoding step sequence
}

export interface BusinessDomain {
  id: string
  name: string
  flows: DomainFlow[]
  nodeCount: number
  communityId: number
  label?: string
}

export interface DomainAnalysisResult {
  domains: BusinessDomain[]
  crossDomainEdges: Array<{ from: string; to: string; weight: number }>
  totalNodes: number
  totalDomains: number
  totalFlows: number
  totalSteps: number
  modularity: number
  resolution: number
  durationMs: number
}

// ============================================================
// DomainAnalyzer
// ============================================================

export class DomainAnalyzer {
  constructor(
    private store: GraphStore,
    private engine: GraphEngine,
  ) {}

  /**
   * Run full three-layer domain analysis.
   */
  analyze(options?: { resolution?: number; minCommunitySize?: number }): DomainAnalysisResult {
    const start = Date.now()
    const resolution = options?.resolution ?? 1.0
    const minSize = options?.minCommunitySize ?? 3

    // Step 1: Community detection → domains
    const community = this.engine.louvainCommunity({ resolution })
    const roles = this.engine.classifyRoles()

    // Step 2: Build domain→nodes mapping
    const communityNodes = new Map<number, string[]>()
    for (const comm of community.communities) {
      if (comm.size >= minSize) {
        communityNodes.set(comm.id, comm.nodes)
      }
    }

    // Step 3: For each community, identify flows via dominator tree
    const domains: BusinessDomain[] = []
    let totalFlows = 0
    let totalSteps = 0

    for (const [commId, nodes] of communityNodes) {
      const comm = community.communities.find(c => c.id === commId)
      const domainName = comm?.label ?? this.inferDomainName(nodes)

      // Find entry points (nodes with few incoming edges from outside domain)
      const entryPoints = this.findDomainEntryPoints(nodes)

      // Build flows from each entry point using dominator tree
      const flows: DomainFlow[] = []
      for (const entry of entryPoints.slice(0, 5)) {
        const flow = this.buildFlow(entry, nodes, roles)
        if (flow.steps.length > 0) {
          flows.push(flow)
          totalSteps += flow.steps.length
        }
      }

      // If no flows found from entry points, create a single flow from the highest PageRank node
      if (flows.length === 0 && nodes.length > 0) {
        const pr = this.engine.pageRank()
        const ranked = pr.scores.filter(s => nodes.includes(s.node))
        if (ranked.length > 0) {
          const flow = this.buildFlow(ranked[0].node, nodes, roles)
          if (flow.steps.length > 0) {
            flows.push(flow)
            totalSteps += flow.steps.length
          }
        }
      }

      totalFlows += flows.length

      domains.push({
        id: `domain-${commId}`,
        name: domainName,
        flows,
        nodeCount: nodes.length,
        communityId: commId,
        label: comm?.label,
      })
    }

    // Step 4: Detect cross-domain edges
    const crossDomainEdges = this.findCrossDomainEdges(communityNodes)

    return {
      domains,
      crossDomainEdges,
      totalNodes: this.store.nodeMeta.size,
      totalDomains: domains.length,
      totalFlows,
      totalSteps,
      modularity: community.modularity,
      resolution: community.resolution,
      durationMs: Date.now() - start,
    }
  }

  // ── Internal helpers ──

  /**
   * Find entry point nodes for a domain — nodes with few incoming edges from outside.
   */
  private findDomainEntryPoints(domainNodes: string[]): string[] {
    const nodeSet = new Set(domainNodes)
    const scores: Array<{ node: string; externalIn: number }> = []

    for (const nodeId of domainNodes) {
      const inEdges = this.store.getInEdges(nodeId)
      let externalIn = 0
      for (const [source, edges] of inEdges) {
        if (!nodeSet.has(source)) {
          externalIn += edges.length
        }
      }
      // Prefer nodes with low external fan-in (true entry points)
      scores.push({ node: nodeId, externalIn })
    }

    scores.sort((a, b) => a.externalIn - b.externalIn)
    return scores.slice(0, 5).map(s => s.node)
  }

  /**
   * Build a flow from an entry node using dominator tree + backward reachability.
   */
  private buildFlow(
    entryNode: string,
    domainNodes: string[],
    roles: Map<string, string>,
  ): DomainFlow {
    const nodeSet = new Set(domainNodes)
    const meta = this.store.getNode(entryNode)

    // Use backward reachability from entry to find the flow's scope
    const backward = this.engine.backwardReachability(entryNode)
    const flowNodes = backward.reachable.filter(n => nodeSet.has(n))

    // Order steps by topological order within the flow
    const steps = this.orderFlowSteps(flowNodes, entryNode)

    return {
      id: `flow-${entryNode}`,
      name: meta?.name ?? entryNode,
      steps: steps.map((nodeId, i) => {
        const m = this.store.getNode(nodeId)
        return {
          nodeId,
          name: m?.name ?? nodeId,
          file: m?.file ?? '',
          kind: m?.kind ?? 'unknown',
          order: (i + 1) / Math.max(steps.length, 1), // monotonic 0-1 range
        }
      }),
      entryNode,
      nodeCount: flowNodes.length,
    }
  }

  /**
   * Order flow steps using topological sort within the subgraph.
   * Falls back to PageRank ordering if topo sort fails.
   */
  private orderFlowSteps(nodes: string[], entryNode: string): string[] {
    if (nodes.length <= 1) return nodes

    try {
      // Build subgraph adjacency for topo sort
      const nodeSet = new Set(nodes)
      const inDegree = new Map<string, number>()
      const adjacency = new Map<string, string[]>()

      for (const node of nodes) {
        inDegree.set(node, 0)
        adjacency.set(node, [])
      }

      for (const node of nodes) {
        const outEdges = this.store.getOutEdges(node)
        for (const [target, edges] of outEdges) {
          if (nodeSet.has(target) && edges.some(e => e.type === 'calls' || e.type === 'imports' || e.type === 'flow_step')) {
            adjacency.get(node)!.push(target)
            inDegree.set(target, (inDegree.get(target) ?? 0) + 1)
          }
        }
      }

      // Kahn's algorithm
      const queue: string[] = []
      for (const [node, deg] of inDegree) {
        if (deg === 0) queue.push(node)
      }

      const sorted: string[] = []
      while (queue.length > 0) {
        const node = queue.shift()!
        sorted.push(node)
        for (const neighbor of adjacency.get(node) ?? []) {
          const newDeg = (inDegree.get(neighbor) ?? 1) - 1
          inDegree.set(neighbor, newDeg)
          if (newDeg === 0) queue.push(neighbor)
        }
      }

      // If topo sort didn't cover all nodes, append remaining by PageRank
      if (sorted.length < nodes.length) {
        const remaining = nodes.filter(n => !sorted.includes(n))
        const pr = this.engine.pageRank()
        const prMap = new Map(pr.scores.map(s => [s.node, s.score]))
        remaining.sort((a, b) => (prMap.get(b) ?? 0) - (prMap.get(a) ?? 0))
        sorted.push(...remaining)
      }

      return sorted
    } catch {
      // Fallback: PageRank ordering
      const pr = this.engine.pageRank()
      const prMap = new Map(pr.scores.map(s => [s.node, s.score]))
      return [...nodes].sort((a, b) => (prMap.get(b) ?? 0) - (prMap.get(a) ?? 0))
    }
  }

  /**
   * Infer a human-readable domain name from the most common file paths.
   */
  private inferDomainName(nodes: string[]): string {
    // Find most common directory prefix
    const dirCounts = new Map<string, number>()
    for (const nodeId of nodes) {
      const meta = this.store.getNode(nodeId)
      if (!meta?.file) continue
      const parts = meta.file.split('/')
      // Use first 2-3 path segments as domain hint
      const dir = parts.length > 2 ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/')
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
    }

    if (dirCounts.size === 0) return `Domain (size: ${nodes.length})`

    const topDir = [...dirCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const lastSegment = topDir.split('/').pop() ?? topDir
    return lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1)
  }

  /**
   * Find edges that cross domain boundaries (cross_domain type).
   */
  private findCrossDomainEdges(
    communityNodes: Map<number, string[]>,
  ): Array<{ from: string; to: string; weight: number }> {
    // Build node→communityId mapping
    const nodeToComm = new Map<string, number>()
    for (const [commId, nodes] of communityNodes) {
      for (const node of nodes) {
        nodeToComm.set(node, commId)
      }
    }

    const crossEdges: Array<{ from: string; to: string; weight: number }> = []
    const seen = new Set<string>()

    for (const [nodeId, commId] of nodeToComm) {
      const outEdges = this.store.getOutEdges(nodeId)
      for (const [target, edges] of outEdges) {
        const targetComm = nodeToComm.get(target)
        if (targetComm !== undefined && targetComm !== commId) {
          const key = `${commId}->${targetComm}`
          if (!seen.has(key)) {
            seen.add(key)
            const fromMeta = this.store.getNode(nodeId)
            const toMeta = this.store.getNode(target)
            crossEdges.push({
              from: fromMeta?.name ?? nodeId,
              to: toMeta?.name ?? target,
              weight: edges.length,
            })
          }
        }
      }
    }

    return crossEdges.sort((a, b) => b.weight - a.weight).slice(0, 50)
  }
}
