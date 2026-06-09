/**
 * GraphEngine — 核心图算法引擎
 *
 * 零外部依赖的 TS 图算法库，基于 GraphStore 的加权邻接表。
 *
 * 设计文档: docs/superpowers/specs/2026-06-05-codegraph-grok-enhancement-design.md §2.4
 */

import type { GraphStore, EdgeMeta, NodeMetadata } from './GraphStore.js'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ============================================================
// Return types (design doc §2.4)
// ============================================================

export interface TraversalResult {
  nodes: string[]
  edges: Array<{ from: string; to: string }>
  depth: Map<string, number>
}

export interface ReachabilityResult {
  reachable: string[]
  via: Map<string, string[]>
}

export interface SCCResult {
  id: number
  nodes: string[]
  size: number
  isTrivial: boolean
}

export interface TopoResult {
  order: string[]
  cycles?: SCCResult[]
}

export interface CentralityResult {
  scores: Array<{ node: string; score: number }>
}

export interface DeltaResult {
  added: string[]
  removed: string[]
  edgeAdded: Array<{ from: string; to: string; type: string }>
  edgeRemoved: Array<{ from: string; to: string; type: string }>
  summary: { nodesDelta: number; edgesDelta: number }
}

export interface SliceResult {
  symbols: string[]
  dataFlows: Array<{ from: string; to: string; via: string }>
}

export interface MetricsResult {
  highCoupling: Array<{ node: string; fanIn: number; fanOut: number; instability: number }>
  lcom: Array<{ class: string; lcom: number; methods: number; fields: number }>
}

export interface CommunityResult {
  communities: Array<{ id: number; nodes: string[]; size: number; label?: string }>
  modularity: number
  resolution: number
}

export interface CouplingResult {
  pairs: Array<{ a: string; b: string; score: number; coChanges: number }>
  window: { since: string; until: string }
}

export interface GraphSnapshot {
  adjacency: Map<string, Map<string, EdgeMeta[]>>
  nodeMeta: Map<string, NodeMetadata>
  timestamp: number
}

export type RoleType = 'entry' | 'core' | 'utility' | 'adaptor' | 'dead' | 'leaf'

export interface RoleOpts {
  corePercentile?: number
  utilityFanInPercentile?: number
  adaptorCrossModuleRatio?: number
  /** Maximum wall-clock time in ms before returning partial results (default: 15000) */
  timeoutMs?: number
  /** Skip expensive PageRank computation; nodes that would be 'core' fall through to other categories */
  skipPageRank?: boolean
}

export interface KatzOpts {
  alpha?: number
  epsilon?: number
  maxIter?: number
}

export interface LouvainOpts {
  resolution?: number
  epsilon?: number
  maxLevels?: number
  maxPasses?: number
  /** Maximum wall-clock time in ms before returning partial results (default: 30000) */
  timeoutMs?: number
}

export interface TemporalOpts {
  since?: string
  limit?: number
  minCoChanges?: number
  maxCommits?: number
}

export interface CompletenessReport {
  overall: number           // 0-100 weighted average
  dimensions: {
    fileCoverage: number    // 0-100: (total - uncovered) / total * 100
    nodeQuality: number     // 0-100: based on nodes with file+name+kind
    edgeIntegrity: number   // 0-100: edges with valid endpoints / total edges * 100
    layerAssignment: number // 0-100: nodes with non-empty layer / total * 100
    structuralHealth: number // 0-100: (1 - deadRatio) * modularity * 100
  }
  stats: {
    totalNodes: number
    totalEdges: number
    totalFiles: number
    deadNodes: number
    orphanNodes: number     // nodes with 0 edges (in+out)
    uncoveredFiles: number
    nonTrivialSCCs: number
  }
  missing: string[]
  recommendations: string[]
}

export interface FeatureChain {
  entry: string                // entry node ID
  entryFile: string            // entry file path
  path: string[]               // node IDs along the chain
  pathFiles: string[]          // file paths along the chain
  roles: string[]              // role of each node in path
  reachesDataLayer: boolean    // does chain reach DB/file/network?
  dataLayerNode?: string       // the data layer node ID
  brokenAt?: number            // index where chain breaks (if incomplete)
  depth: number                // chain length
}

export interface ChainTraceResult {
  chains: FeatureChain[]
  stats: {
    totalEntries: number
    completeChains: number    // reaches data layer
    brokenChains: number      // breaks before data layer
    unreachableEntries: number // entry → nothing
  }
  brokenLinks: Array<{ from: string; to: string; fromRole: string }>
  /** true if processing stopped early due to timeout */
  timedOut?: boolean
}

// ============================================================
// Deterministic PRNG (mulberry32, seed=0xc0de)
// ============================================================

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// ============================================================
// GraphEngine
// ============================================================

// ============================================================
// Edge Participation Matrix (F-68)
// ============================================================

/**
 * Which edge types participate in each algorithm.
 * Excludes 'contains' (structural, not semantic) for most algorithms.
 * 'cross_domain' excluded from PageRank/Louvain to avoid noise from cross-module bridges.
 */
export const EDGE_PARTICIPATION = {
  pageRank: ['calls', 'imports', 'inherits', 'implements', 'data', 'exports',
    'type_of', 'returns', 'instantiates', 'overrides', 'subscribes', 'middleware',
    'flow_step', 'cross_domain'],
  louvain: ['calls', 'imports', 'inherits', 'implements', 'data', 'exports',
    'type_of', 'returns', 'instantiates', 'overrides', 'subscribes', 'middleware',
    'flow_step', 'cross_domain'],
  katz: ['calls', 'imports', 'inherits', 'implements', 'data', 'exports',
    'type_of', 'returns', 'instantiates', 'overrides', 'subscribes', 'middleware',
    'flow_step', 'cross_domain'],
  betweenness: ['calls', 'imports', 'inherits', 'implements', 'data', 'exports',
    'type_of', 'returns', 'instantiates', 'overrides', 'subscribes', 'middleware',
    'flow_step', 'cross_domain'],
  // Data flow algorithms: only data-relevant edges
  dataSlice: ['data', 'type_of', 'returns', 'reads', 'writes', 'transforms',
    'serializes', 'deserializes', 'encrypts', 'decrypts', 'compresses'],
  // All semantic edges (excludes 'contains')
  all: ['calls', 'imports', 'inherits', 'implements', 'data', 'exports',
    'type_of', 'returns', 'instantiates', 'overrides', 'decorates',
    'subscribes', 'publishes', 'middleware', 'flow_step', 'cross_domain',
    'reads', 'writes', 'tests', 'configures', 'deploys', 'monitors',
    'validates', 'transforms', 'caches', 'queues', 'notifies',
    'serializes', 'deserializes', 'encrypts', 'decrypts', 'compresses',
    'logs', 'metrics', 'traces', 'authenticates', 'authorizes', 'rate_limits'],
} as const

/** Directory-based role hints — matched against file paths before heuristic classification */
const DIRECTORY_ROLE_PATTERNS: Array<{ pattern: RegExp; hint: RoleType }> = [
  // Entry points
  { pattern: /\/(main|index|app|server|cli|entry|bootstrap)\.[^.]+$/, hint: 'entry' },
  { pattern: /\/(routes?|router|handlers?)\//i, hint: 'entry' },
  { pattern: /\/(controllers?|routes?|handlers?)\//i, hint: 'entry' },

  // Adaptors / bridges
  { pattern: /\/(middleware|interceptor|adapter|bridge|proxy|gateway)\//i, hint: 'adaptor' },
  { pattern: /\/(hooks?|plugins?|extensions?)\//i, hint: 'adaptor' },

  // Leaf / models / utils
  { pattern: /\/(models?|entities?|schemas?|types?|interfaces?)\//i, hint: 'leaf' },
  { pattern: /\/(utils?|helpers?|lib|common|shared)\//i, hint: 'utility' },
  { pattern: /\/(constants?|config|configs?)\//i, hint: 'utility' },

  // Core / services
  { pattern: /\/(services?|core|engine|processor|manager)\//i, hint: 'core' },

  // Tests / fixtures — leaf nodes (consume production code, nothing depends on them)
  { pattern: /\/(tests?|__tests__|spec|__mocks__|fixtures?)\//i, hint: 'leaf' },
]

export class GraphEngine {
  private _rolesCache: Map<string, RoleType> | null = null
  private _rolesCacheKey: string | null = null

  constructor(private store: GraphStore) {}

  // ── 基础遍历 ──

  /**
   * BFS 广度优先遍历
   */
  bfs(start: string, maxDepth = Infinity): TraversalResult {
    const nodes: string[] = []
    const edges: Array<{ from: string; to: string }> = []
    const depth = new Map<string, number>()
    const visited = new Set<string>()

    const queue: Array<{ node: string; d: number }> = [{ node: start, d: 0 }]
    let head = 0
    visited.add(start)
    depth.set(start, 0)

    while (head < queue.length) {
      const { node, d } = queue[head++]!
      nodes.push(node)

      if (d >= maxDepth) continue

      const outEdges = this.store.getOutEdges(node)
      for (const [target] of outEdges) {
        if (!visited.has(target)) {
          visited.add(target)
          depth.set(target, d + 1)
          edges.push({ from: node, to: target })
          queue.push({ node: target, d: d + 1 })
        }
      }
    }

    return { nodes, edges, depth }
  }

  /**
   * DFS 深度优先遍历（显式栈，无递归）
   */
  dfs(start: string, maxDepth = Infinity): TraversalResult {
    const nodes: string[] = []
    const edges: Array<{ from: string; to: string }> = []
    const depth = new Map<string, number>()
    const visited = new Set<string>()

    const stack: Array<{ node: string; d: number }> = [{ node: start, d: 0 }]
    depth.set(start, 0)

    while (stack.length > 0) {
      const { node, d } = stack.pop()!
      if (visited.has(node)) continue
      visited.add(node)
      nodes.push(node)

      if (d >= maxDepth) continue

      const outEdges = this.store.getOutEdges(node)
      for (const [target] of outEdges) {
        if (!visited.has(target)) {
          depth.set(target, d + 1)
          edges.push({ from: node, to: target })
          stack.push({ node: target, d: d + 1 })
        }
      }
    }

    return { nodes, edges, depth }
  }

  // ── Phase 3a: 低复杂度 + 高价值 ──

  /**
   * 反向可达性：从 nodeId 出发，沿反向边 BFS
   * 用于 backwardSlice 和 dead code 检测
   */
  backwardReachability(nodeId: string): ReachabilityResult {
    const reachable: string[] = []
    const via = new Map<string, string[]>()
    const visited = new Set<string>()
    const queue = [nodeId]
    let head = 0
    visited.add(nodeId)

    while (head < queue.length) {
      const current = queue[head++]!
      reachable.push(current)

      const inEdges = this.store.getInEdges(current)
      for (const [source] of inEdges) {
        if (!visited.has(source)) {
          visited.add(source)
          via.set(source, [current])
          queue.push(source)
        }
      }
    }

    return { reachable, via }
  }

  /**
   * Tarjan SCC — 显式栈迭代版（避免递归栈溢出）
   *
   * 三个关键不变量:
   * 1. index[v] 严格单调递增（分配后不变）
   * 2. onStack 精确等于当前 DFS 路径上的节点
   * 3. lowlink[v] <= index[v]，回溯时取 min
   */
  tarjanSCC(): SCCResult[] {
    const allNodes = this.getAllNodeIds()
    let index = 0
    const nodeIndex = new Map<string, number>()
    const nodeLowlink = new Map<string, number>()
    const onStack = new Set<string>()
    const stack: string[] = []
    const result: SCCResult[] = []

    // 显式调用栈帧
    interface Frame {
      nodeId: string
      neighbors: string[]
      neighborIdx: number
    }
    const callStack: Frame[] = []

    for (const v of allNodes) {
      if (nodeIndex.has(v)) continue

      // 首次访问 v
      stack.push(v)
      onStack.add(v)
      nodeIndex.set(v, index)
      nodeLowlink.set(v, index)
      index++

      const neighbors = this.getOutNeighborIds(v)
      callStack.push({ nodeId: v, neighbors, neighborIdx: 0 })

      while (callStack.length > 0) {
        const frame = callStack[callStack.length - 1]!

        if (frame.neighborIdx < frame.neighbors.length) {
          const w = frame.neighbors[frame.neighborIdx++]

          if (!nodeIndex.has(w)) {
            // 新发现：压入 SCC 栈
            stack.push(w)
            onStack.add(w)
            nodeIndex.set(w, index)
            nodeLowlink.set(w, index)
            index++

            const wNeighbors = this.getOutNeighborIds(w)
            callStack.push({ nodeId: w, neighbors: wNeighbors, neighborIdx: 0 })
          } else if (onStack.has(w)) {
            // 回边
            const currentLow = nodeLowlink.get(frame.nodeId)!
            nodeLowlink.set(frame.nodeId, Math.min(currentLow, nodeIndex.get(w)!))
          }
        } else {
          // 所有邻居处理完毕 — 回溯
          const nodeId = frame.nodeId
          const lowlink = nodeLowlink.get(nodeId)!

          if (lowlink === nodeIndex.get(nodeId)) {
            // 找到一个 SCC
            const scc: string[] = []
            let w: string
            do {
              w = stack.pop()!
              onStack.delete(w)
              scc.push(w)
            } while (w !== nodeId)

            result.push({
              id: result.length,
              nodes: scc,
              size: scc.length,
              isTrivial: scc.length === 1,
            })
          }

          callStack.pop()

          // 更新 parent 的 lowlink
          if (callStack.length > 0) {
            const parent = callStack[callStack.length - 1]!
            const parentLow = nodeLowlink.get(parent.nodeId)!
            nodeLowlink.set(parent.nodeId, Math.min(parentLow, lowlink))
          }
        }
      }
    }

    return result
  }

  /**
   * 拓扑排序 — SCC 缩点后排序
   * 有环时返回 SCC 信息
   */
  topologicalSort(): TopoResult {
    const sccs = this.tarjanSCC()
    const hasCycle = sccs.some(s => !s.isTrivial)

    if (!hasCycle) {
      // 无环：直接 Kahn 算法
      const order = this.kahnSort()
      return { order }
    }

    // 有环：SCC 缩点后拓扑排序
    const nodeToScc = new Map<string, number>()
    for (const scc of sccs) {
      for (const node of scc.nodes) {
        nodeToScc.set(node, scc.id)
      }
    }

    // 构建 SCC 间的 DAG
    const sccInDegree = new Map<number, number>()
    const sccAdj = new Map<number, Set<number>>()
    for (const scc of sccs) {
      sccInDegree.set(scc.id, 0)
      sccAdj.set(scc.id, new Set())
    }

    for (const [from, outMap] of this.store.adjacency) {
      const fromScc = nodeToScc.get(from)!
      for (const [to] of outMap) {
        const toScc = nodeToScc.get(to)
        if (toScc !== undefined && fromScc !== toScc && !sccAdj.get(fromScc)!.has(toScc)) {
          sccAdj.get(fromScc)!.add(toScc)
          sccInDegree.set(toScc, sccInDegree.get(toScc)! + 1)
        }
      }
    }

    // Kahn 排序 SCC
    const queue: number[] = []
    for (const [id, deg] of sccInDegree) {
      if (deg === 0) queue.push(id)
    }

    const sccMap = new Map(sccs.map(s => [s.id, s]))
    let head = 0
    const order: string[] = []
    while (head < queue.length) {
      const sccId = queue[head++]!
      const scc = sccMap.get(sccId)!
      if (scc.size === 1) {
        order.push(scc.nodes[0])
      } else {
        order.push(`SCC:${scc.nodes.join(',')}`)
      }

      for (const next of sccAdj.get(sccId) ?? []) {
        const deg = sccInDegree.get(next)! - 1
        sccInDegree.set(next, deg)
        if (deg === 0) queue.push(next)
      }
    }

    return {
      order,
      cycles: sccs.filter(s => !s.isTrivial),
    }
  }

  /**
   * PageRank — 幂迭代
   *
   * 悬挂节点（出度=0）: 概率质量均匀分配给所有节点
   * 公式: PR_new[v] = (1-d)/N + d * (Σ PR[u]/outDeg(u) + danglingSum/N)
   * 收敛度量: L1 范数，epsilon=1e-6
   */
  pageRank(damping = 0.85, maxIter = 100, timeoutMs = 10000): CentralityResult {
    const nodes = this.getAllNodeIds()
    const N = nodes.length

    if (N === 0) return { scores: [] }

    const deadline = Date.now() + timeoutMs

    const pr = new Map<string, number>()
    const outDeg = new Map<string, number>()

    // 初始化 — 使用加权出度（边权重之和，排除 contains 类型）
    for (const node of nodes) {
      pr.set(node, 1 / N)
      const weightedDeg = this.store.getWeightedOutDegree(node, ['contains'])
      outDeg.set(node, weightedDeg)
    }

    for (let iter = 0; iter < maxIter; iter++) {
      if (Date.now() > deadline) break
      const newPr = new Map<string, number>()
      let danglingSum = 0
      let danglingCount = 0

      // 计算悬挂节点的概率质量（每 5000 节点检查 timeout）
      for (const node of nodes) {
        if (++danglingCount % 5000 === 0 && Date.now() > deadline) break
        if (outDeg.get(node) === 0) {
          danglingSum += pr.get(node)!
        }
      }
      if (Date.now() > deadline) break

      let l1Norm = 0
      let vCount = 0

      for (const v of nodes) {
        // 每 5000 节点检查 timeout，避免单次 pass 长时间阻塞 CPU
      // Compute modularity before Phase 1
      const prevQ = this.computeModularity(currentNodes, currentCommunity, currentAdjMap, totalWeight, resolution)

      // Phase 1: Inner iteration — move nodes to best community
      const { moved } = this.louvainInnerIteration(
        currentNodes, currentCommunity, totalWeight, currentDegree, currentAdjMap, resolution, maxPasses, deadline,
      )

      if (!moved) break

      // Compute modularity after Phase 1
      const newQ = this.computeModularity(currentNodes, currentCommunity, currentAdjMap, totalWeight, resolution)
      if (newQ - prevQ < epsilon) break

      level++

      // Phase 2: Aggregation — build coarse graph
      const { coarseNodes, coarseAdjMap, coarseDegree, coarseMapping } =
        this.louvainAggregate(currentNodes, currentCommunity, currentAdjMap)

      // Update nodeMapping: coarse node → original nodes
      const updatedMapping = new Map<string, string[]>()
      for (const [coarseNode, intermediateNodes] of coarseMapping) {
        const originals: string[] = []
        for (const inter of intermediateNodes) {
          originals.push(...(nodeMapping.get(inter) ?? [inter]))
        }
        updatedMapping.set(coarseNode, originals)
      }
      nodeMapping = updatedMapping

      currentNodes = coarseNodes
      currentAdjMap = coarseAdjMap
      currentDegree = coarseDegree
      currentCommunity = new Map<string, number>()
      coarseNodes.forEach((node, i) => currentCommunity.set(node, i))
    }

    // Map back to original node IDs
    const finalCommunity = new Map<string, number>()
    for (const [node, c] of currentCommunity) {
      for (const orig of nodeMapping.get(node) ?? [node]) {
        finalCommunity.set(orig, c)
      }
    }

    // Assemble result
    const commNodes = new Map<number, string[]>()
    for (const [node, c] of finalCommunity) {
      if (!commNodes.has(c)) commNodes.set(c, [])
      commNodes.get(c)!.push(node)
    }

    const communities = [...commNodes.entries()].map(([id, nodes]) => ({
      id,
      nodes,
      size: nodes.length,
    }))

    // Compute final modularity on original graph
    const Q = this.computeModularity(nodes, finalCommunity, adjMap, totalWeight, resolution)

    return { communities, modularity: Math.round(Q * 1000) / 1000, resolution }
  }

  /**
   * 时间耦合 — git log 解析 + 共变统计
   * @param projectRoot — 项目根目录（用于 git 命令 cwd）
   * @param opts — 时间窗口、限制等选项
   */
  temporalCoupling(projectRoot: string, opts?: TemporalOpts): CouplingResult {
    const sinceValue = opts?.since ?? '30 days'
    const limit = opts?.limit ?? 30
    const maxCommits = opts?.maxCommits ?? 1000

    // execFileSync avoids shell injection
    const gitLog = execFileSync(
      'git', ['log', '--name-only', `--max-count=${maxCommits}`, '--pretty=format:COMMIT:%H', `--since=${sinceValue}`],
      { cwd: projectRoot, encoding: 'utf-8', timeout: 30000 }
    )

    // Parse commits and their changed files
    const commits = gitLog.split(/^COMMIT:/m).filter(Boolean)
    const coChangeMap = new Map<string, number>()
    for (const commit of commits) {
      const lines = commit.trim().split('\n').filter(l => l && !l.startsWith('COMMIT:'))
      // Count co-changes for every pair
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const key = [lines[i], lines[j]].sort().join('↔')
          coChangeMap.set(key, (coChangeMap.get(key) ?? 0) + 1)
        }
      }
    }

    // Sort by co-change count, apply minCoChanges filter
    const minCoChanges = opts?.minCoChanges ?? 1
    const pairs = [...coChangeMap.entries()]
      .map(([key, count]) => {
        const [a, b] = key.split('↔')
        return { a, b, score: count, coChanges: count }
      })
      .filter(p => p.coChanges >= minCoChanges)
      .sort((a, b) => b.coChanges - a.coChanges)
      .slice(0, limit)

    return {
      pairs,
      window: { since: sinceValue, until: 'now' },
    }
  }

  /**
   * 统一完整性报告 — 聚合所有诊断指标
   */
  computeCompleteness(opts?: { totalSourceFiles?: number; skipStructural?: boolean; timeoutMs?: number }): CompletenessReport {
    const timeoutMs = opts?.timeoutMs ?? 50000
    const deadline = Date.now() + timeoutMs
    const nodes = this.getAllNodeIds()
    const totalNodes = nodes.length
    const nodeSet = new Set(nodes)

    // Count edges
    let totalEdges = 0
    let invalidEdges = 0
    for (const node of nodes) {
      const out = this.store.getOutEdges(node)
      for (const [target] of out) {
        totalEdges++
        if (!nodeSet.has(target)) invalidEdges++
      }
    }

    // File coverage
    const files = new Set<string>()
    let nodesWithFile = 0
    let nodesWithLayer = 0
    let orphanNodes = 0
    for (const node of nodes) {
      const meta = this.store.getNode(node)
      if (meta?.file) { files.add(meta.file); nodesWithFile++ }
      if (meta?.layer) nodesWithLayer++
      const inE = this.store.getInEdges(node)
      const outE = this.store.getOutEdges(node)
      if (inE.size === 0 && outE.size === 0) orphanNodes++
    }

    // Structural health via existing algorithms (skippable for performance).
    // When skipStructural=true, structuralHealth defaults to:
    //   modularity=0.5 (neutral assumption), deadNodes=0 → score = (1-0) * 0.5 * 100 = 50
    let deadNodes = 0
    let modularity = totalNodes === 0 ? 1.0 : 0.5
    let nonTrivialSCCs = 0

    if (!opts?.skipStructural) {
      const remainingForRoles = Math.max(1000, deadline - Date.now())
      const roles = this.classifyRoles({ timeoutMs: remainingForRoles })
      for (const [, role] of roles) {
        if (role === 'dead') deadNodes++
      }

      if (totalNodes >= 4 && Date.now() < deadline) {
        try {
          const remainingForLouvain = Math.max(1000, deadline - Date.now())
          const community = this.louvainCommunity({ timeoutMs: remainingForLouvain })
          modularity = community.modularity
        } catch { /* small graph fallback / timeout */ }
      }

      if (Date.now() < deadline) {
        const scc = this.tarjanSCC()
        nonTrivialSCCs = scc.filter(s => !s.isTrivial).length
      }
    }

    // Dimension scores
    const totalSourceFiles = opts?.totalSourceFiles ?? files.size
    const fileCoverage = totalSourceFiles > 0
      ? (files.size / totalSourceFiles) * 100
      : 100

    const nodeQuality = totalNodes > 0 ? (nodesWithFile / totalNodes) * 100 : 100
    const edgeIntegrity = totalEdges > 0 ? ((totalEdges - invalidEdges) / totalEdges) * 100 : 100
    const layerAssignment = totalNodes > 0 ? (nodesWithLayer / totalNodes) * 100 : 100
    const deadRatio = totalNodes > 0 ? deadNodes / totalNodes : 0
    const structuralHealth = (1 - deadRatio) * Math.max(0, modularity) * 100

    // Weighted overall
    const overall = Math.round(
      fileCoverage * 0.25 +
      nodeQuality * 0.20 +
      edgeIntegrity * 0.15 +
      layerAssignment * 0.15 +
      structuralHealth * 0.25,
    )

    // Missing items
    const missing: string[] = []
    const uncoveredCount = totalSourceFiles - files.size
    if (uncoveredCount > 0) missing.push(`${uncoveredCount} source files not covered by any node`)
    if (totalNodes - nodesWithLayer > 0) missing.push(`${totalNodes - nodesWithLayer} nodes without layer assignment`)
    if (deadNodes > 0) missing.push(`${deadNodes} dead nodes (unreachable from entry points)`)
    if (orphanNodes > 0) missing.push(`${orphanNodes} orphan nodes (no edges)`)
    if (nonTrivialSCCs > 0) missing.push(`${nonTrivialSCCs} circular dependencies detected`)

    // Recommendations
    const recommendations: string[] = []
    if (fileCoverage < 80) recommendations.push('Run codegraph_sync to index uncovered files')
    if (deadRatio > 0.1) recommendations.push('Review dead nodes — may indicate missing entry points or unused code')
    if (modularity < 0.3 && totalNodes > 20) recommendations.push('Low modularity — code may be tightly coupled')
    if (edgeIntegrity < 95) recommendations.push('Some edges reference non-existent nodes — consider rebuilding graph')

    return {
      overall,
      dimensions: { fileCoverage, nodeQuality, edgeIntegrity, layerAssignment, structuralHealth },
      stats: { totalNodes, totalEdges, totalFiles: files.size, deadNodes, orphanNodes, uncoveredFiles: uncoveredCount, nonTrivialSCCs },
      missing,
      recommendations,
    }
  }

  // ── Louvain helpers ──

  /**
   * Build undirected graph from store adjacency.
   * Undirected weight: w(u,v) = max(w(u→v), w(v→u))
   */
  private buildUndirectedGraph(): {
    totalWeight: number
    degree: Map<string, number>
    adjMap: Map<string, Map<string, number>>
  } {
    const nodes = this.getAllNodeIds()
    const adjMap = new Map<string, Map<string, number>>()

    for (const [from, outMap] of this.store.adjacency) {
      if (!adjMap.has(from)) adjMap.set(from, new Map())
      for (const [to, edges] of outMap) {
        let w = 0
        for (const edge of edges) {
          if (edge.type === 'contains') continue // Skip structural containment edges
          w += edge.weight
        }
        if (w > 0) {
          adjMap.get(from)!.set(to, w)
          if (!adjMap.has(to)) adjMap.set(to, new Map())
          const reverseW = adjMap.get(to)!.get(from) ?? 0
          const combined = Math.max(w, reverseW)
          adjMap.get(from)!.set(to, combined)
          adjMap.get(to)!.set(from, combined)
        }
      }
    }

    let totalWeight = 0
    const degree = new Map<string, number>()
    for (const node of nodes) {
      let deg = 0
      const neighbors = adjMap.get(node)
      if (neighbors) {
        for (const w of neighbors.values()) deg += w
      }
      degree.set(node, deg)
      totalWeight += deg
    }
    if (totalWeight === 0) totalWeight = 1

    return { totalWeight, degree, adjMap }
  }

  /**
   * Phase 1: Inner iteration — move nodes to community with best modularity gain.
   * Returns whether any node moved during the iteration.
   */
  private louvainInnerIteration(
    nodes: string[],
    community: Map<string, number>,
    totalWeight: number,
    degree: Map<string, number>,
    adjMap: Map<string, Map<string, number>>,
    resolution: number,
    maxPasses: number,
    deadline: number = Infinity,
  ): { moved: boolean } {
    const communityDegreeSum = new Map<number, number>()
    for (const node of nodes) {
      const c = community.get(node)!
      communityDegreeSum.set(c, (communityDegreeSum.get(c) ?? 0) + (degree.get(node) ?? 0))
    }

    let anyMoved = false

    for (let pass = 0; pass < maxPasses; pass++) {
      if (Date.now() > deadline) break

      let moved = false
      let nodeCount = 0

      for (const node of nodes) {
        // 每 1000 节点检查 timeout，避免单次 pass 长时间阻塞 CPU
        if (++nodeCount % 1000 === 0 && Date.now() > deadline) break
        const currentCommunity = community.get(node)!
        const nodeDeg = degree.get(node) ?? 0

        const neighborCommunities = new Map<number, number>()
        const neighbors = adjMap.get(node)
        if (neighbors) {
          for (const [neighbor, w] of neighbors) {
            const nc = community.get(neighbor)
            if (nc !== undefined) {
              neighborCommunities.set(nc, (neighborCommunities.get(nc) ?? 0) + w)
            }
          }
        }

        // Compute gain of staying in current community (after virtual removal)
        const currentEdgeWeightToSelf = neighborCommunities.get(currentCommunity) ?? 0
        const currentSigmaTot = (communityDegreeSum.get(currentCommunity) ?? 0) - nodeDeg
        const currentGain = currentSigmaTot > 0
          ? resolution * (2 * currentEdgeWeightToSelf / totalWeight - (nodeDeg * currentSigmaTot) / (totalWeight * totalWeight))
          : 0

        let bestCommunity = currentCommunity
        let bestGain = currentGain

        for (const [candidateComm, edgeWeightToComm] of neighborCommunities) {
          if (candidateComm === currentCommunity) continue

          const sigmaIn = edgeWeightToComm
          const sigmaTot = communityDegreeSum.get(candidateComm) ?? 0
          // Standard Louvain ΔQ = 2*(Σ_in/2m) - k_i*Σ_tot/(2m)^2; factor of 2 on sigmaIn term
          const gain = resolution * (2 * sigmaIn / totalWeight - (nodeDeg * sigmaTot) / (totalWeight * totalWeight))

          if (gain > bestGain) {
            bestGain = gain
            bestCommunity = candidateComm
          }
        }

        if (bestCommunity !== currentCommunity) {
          community.set(node, bestCommunity)
          communityDegreeSum.set(currentCommunity, (communityDegreeSum.get(currentCommunity) ?? 0) - nodeDeg)
          communityDegreeSum.set(bestCommunity, (communityDegreeSum.get(bestCommunity) ?? 0) + nodeDeg)
          moved = true
          anyMoved = true
        }
      }

      if (!moved) break
    }

    return { moved: anyMoved }
  }

  /**
   * Phase 2: Aggregation — build coarse graph from community structure.
   * Each community becomes a super-node. Inter-community edges are summed.
   */
  private louvainAggregate(
    nodes: string[],
    community: Map<string, number>,
    adjMap: Map<string, Map<string, number>>,
  ): {
    coarseNodes: string[]
    coarseAdjMap: Map<string, Map<string, number>>
    coarseDegree: Map<string, number>
    coarseMapping: Map<string, string[]>
  } {
    const commToNodes = new Map<number, string[]>()
    for (const node of nodes) {
      const c = community.get(node)!
      if (!commToNodes.has(c)) commToNodes.set(c, [])
      commToNodes.get(c)!.push(node)
    }

    const coarseNodes: string[] = []
    const coarseMapping = new Map<string, string[]>()
    const commToCoarseId = new Map<number, string>()
    for (const [c, members] of commToNodes) {
      const coarseId = `C${c}`
      coarseNodes.push(coarseId)
      coarseMapping.set(coarseId, members)
      commToCoarseId.set(c, coarseId)
    }

    const coarseAdjMap = new Map<string, Map<string, number>>()
    const coarseDegree = new Map<string, number>()

    for (const coarseId of coarseNodes) {
      coarseAdjMap.set(coarseId, new Map())
      coarseDegree.set(coarseId, 0)
    }

    for (const node of nodes) {
      const nodeComm = community.get(node)!
      const nodeCoarseId = commToCoarseId.get(nodeComm)!
      const neighbors = adjMap.get(node)
      if (!neighbors) continue

      for (const [neighbor, w] of neighbors) {
        const neighborComm = community.get(neighbor)!
        const neighborCoarseId = commToCoarseId.get(neighborComm)!

        const coarseNeighbors = coarseAdjMap.get(nodeCoarseId)!
        coarseNeighbors.set(neighborCoarseId, (coarseNeighbors.get(neighborCoarseId) ?? 0) + w)
      }

      let deg = 0
      for (const w of neighbors.values()) deg += w
      coarseDegree.set(nodeCoarseId, (coarseDegree.get(nodeCoarseId) ?? 0) + deg)
    }

    return { coarseNodes, coarseAdjMap, coarseDegree, coarseMapping }
  }

  /**
   * Compute modularity Q for a given partition.
   * Q = Σ_c [ (Σ_in / 2m) - resolution * (k_c / 2m)^2 ]
   */
  private computeModularity(
    nodes: string[],
    community: Map<string, number>,
    adjMap: Map<string, Map<string, number>>,
    totalWeight: number,
    resolution: number,
  ): number {
    const commNodes = new Map<number, string[]>()
    for (const node of nodes) {
      const c = community.get(node)!
      if (!commNodes.has(c)) commNodes.set(c, [])
      commNodes.get(c)!.push(node)
    }

    let Q = 0
    for (const [, members] of commNodes) {
      let internalWeight = 0
      let commDegree = 0
      for (const node of members) {
        const neighbors = adjMap.get(node)
        if (neighbors) {
          for (const [target, w] of neighbors) {
            commDegree += w
            if (community.get(target) === community.get(node)) {
              internalWeight += w
            }
          }
        }
      }
      Q += (internalWeight / totalWeight) - resolution * Math.pow(commDegree / totalWeight, 2)
    }

    return Q
  }

  // ── Helpers ──

  getAllNodeIds(): string[] {
    return [...this.store.nodeMeta.keys()]
  }

  private getOutNeighborIds(nodeId: string): string[] {
    const outEdges = this.store.getOutEdges(nodeId)
    return [...outEdges.keys()]
  }

  private intersectDominators(a: string, b: string, dominated: Map<string, string | null>, maxSteps = 10000): string | null {
    const visited = new Set<string>()
    let cur: string | null = a
    let steps = 0
    while (cur !== null && steps++ < maxSteps) {
      visited.add(cur)
      cur = dominated.get(cur) ?? null
    }

    cur = b
    steps = 0
    while (cur !== null && steps++ < maxSteps) {
      if (visited.has(cur)) return cur
      cur = dominated.get(cur) ?? null
    }

    return null
  }

  private kahnSort(): string[] {
    const nodes = this.getAllNodeIds()
    const inDegree = new Map<string, number>()
    for (const node of nodes) inDegree.set(node, 0)

    for (const [, outMap] of this.store.adjacency) {
      for (const [target] of outMap) {
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1)
      }
    }

    const queue = nodes.filter(n => inDegree.get(n) === 0)
    let head = 0
    const order: string[] = []

    while (head < queue.length) {
      const node = queue[head++]!
      order.push(node)

      const outEdges = this.store.getOutEdges(node)
      for (const [target] of outEdges) {
        const deg = inDegree.get(target)! - 1
        inDegree.set(target, deg)
        if (deg === 0) queue.push(target)
      }
    }

    return order
  }

  private snapshotToEdgeSet(snapshot: GraphSnapshot): Map<string, { from: string; to: string; type: string }> {
    const edges = new Map<string, { from: string; to: string; type: string }>()
    for (const [from, outMap] of snapshot.adjacency) {
      for (const [to, edgeArray] of outMap) {
        for (const edge of edgeArray) {
          const key = `${from}→${to}:${edge.type}`
          edges.set(key, { from, to, type: edge.type })
        }
      }
    }
    return edges
  }

  private sampleNodes(nodes: string[], count: number): string[] {
    if (count >= nodes.length) return [...nodes]
    const shuffled = [...nodes]
    const rand = mulberry32(0xc0de)
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled.slice(0, count)
  }

  private getMethodFields(methodId: string): string[] {
    const fields: string[] = []
    for (const [target, edges] of this.store.getOutEdges(methodId)) {
      for (const edge of edges) {
        if (edge.type === 'data') {
          fields.push(target)
          break
        }
      }
    }
    for (const [source, edges] of this.store.getInEdges(methodId)) {
      for (const edge of edges) {
        if (edge.type === 'data') {
          fields.push(source)
          break
        }
      }
    }
    return fields
  }
}
