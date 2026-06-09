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
        if (++vCount % 5000 === 0 && Date.now() > deadline) break
        let incomingSum = 0
        const inEdges = this.store.getInEdges(v)
        for (const [u, edges] of inEdges) {
          let edgeWeight = 0
          for (const e of edges) {
            if (e.type !== 'contains') edgeWeight += e.weight
          }
          if (edgeWeight > 0) {
            const uDeg = outDeg.get(u) ?? 1
            incomingSum += (pr.get(u) ?? 0) * edgeWeight / uDeg
          }
        }

        const newVal = (1 - damping) / N + damping * (incomingSum + danglingSum / N)
        l1Norm += Math.abs(newVal - (pr.get(v) ?? 0))
        newPr.set(v, newVal)
      }

      // 更新
      for (const node of nodes) {
        pr.set(node, newPr.get(node)!)
      }

      // L1 收敛检查
      if (l1Norm < 1e-6) break
    }

    // 归一化到 0-1
    const maxPr = Math.max(...pr.values())
    const scores = nodes
      .map(node => ({ node, score: maxPr > 0 ? pr.get(node)! / maxPr : 0 }))
      .sort((a, b) => b.score - a.score)

    return { scores }
  }

  /**
   * 支配树 — 迭代收敛算法
   * 注意：非标准 Lengauer-Tarjan 实现，最坏情况 O(V²·E)
   * 适用于中小规模图，大规模图建议使用 Lengauer-Tarjan
   */
  dominatorTree(root: string): Map<string, string | null> {
    const dominated = new Map<string, string | null>()
    const reachable = this.bfs(root)
    const reachableSet = new Set(reachable.nodes)

    // 从 root 开始，计算每个节点的直接支配者
    dominated.set(root, null)

    // 迭代收敛：对每个可达节点，找其所有前驱的支配者的交集
    let changed = true
    let iterations = 0
    const maxIterations = reachable.nodes.length * 2

    while (changed && iterations < maxIterations) {
      iterations++
      changed = false

      for (const node of reachable.nodes) {
        if (node === root) continue

        const inEdges = this.store.getInEdges(node)
        const preds = [...inEdges.keys()].filter(p => reachableSet.has(p))

        if (preds.length === 0) continue

        // 找最近公共支配者
        let idom: string | null = null
        for (const pred of preds) {
          if (!dominated.has(pred)) continue

          if (idom === null) {
            idom = pred
          } else {
            // 找 idom 和 pred 的公共支配者
            idom = this.intersectDominators(idom, pred, dominated)
          }
        }

        if (idom !== null && dominated.get(node) !== idom) {
          dominated.set(node, idom)
          changed = true
        }
      }
    }

    return dominated
  }

  /**
   * 差分图 — 比较两个快照的节点/边增删
   */
  deltaGraph(old: GraphSnapshot, curr: GraphSnapshot): DeltaResult {
    const oldNodes = new Set(old.nodeMeta.keys())
    const currNodes = new Set(curr.nodeMeta.keys())

    const added = [...currNodes].filter(n => !oldNodes.has(n))
    const removed = [...oldNodes].filter(n => !currNodes.has(n))

    const edgeAdded: DeltaResult['edgeAdded'] = []
    const edgeRemoved: DeltaResult['edgeRemoved'] = []

    // 比较边
    const oldEdges = this.snapshotToEdgeSet(old)
    const currEdges = this.snapshotToEdgeSet(curr)

    for (const [key, edge] of currEdges) {
      if (!oldEdges.has(key)) {
        edgeAdded.push({ from: edge.from, to: edge.to, type: edge.type })
      }
    }

    for (const [key, edge] of oldEdges) {
      if (!currEdges.has(key)) {
        edgeRemoved.push({ from: edge.from, to: edge.to, type: edge.type })
      }
    }

    return {
      added,
      removed,
      edgeAdded,
      edgeRemoved,
      summary: {
        nodesDelta: added.length - removed.length,
        edgesDelta: edgeAdded.length - edgeRemoved.length,
      },
    }
  }

  // ── Phase 3b: 中复杂度核心场景 ──

  /**
   * 角色分类 — 按优先级排序，先匹配者胜
   *
   * 1. dead:   从所有 entry 点反向 BFS 不可达
   * 2. entry:  fanIn = 0 且 fanOut > 0
   * 3. leaf:   fanOut = 0 且 fanIn > 0
   * 4. adaptor: 跨模块边占比 > 50%
   * 5. core:   PageRank 排名前 20% 且 fanIn > median
   * 6. utility: fanIn > P75 且 fanOut < P25
   */
  classifyRoles(opts?: RoleOpts): Map<string, RoleType> {
    // Cache check: return cached result if options match (avoids redundant PageRank ~2.8s)
    const cacheKey = JSON.stringify(opts ?? {})
    if (this._rolesCache && this._rolesCacheKey === cacheKey) {
      return new Map(this._rolesCache)
    }

    const corePercentile = opts?.corePercentile ?? 0.8
    const utilityFanInPercentile = opts?.utilityFanInPercentile ?? 0.75
    const adaptorCrossModuleRatio = opts?.adaptorCrossModuleRatio ?? 0.5
    const timeoutMs = opts?.timeoutMs ?? 15000
    const deadline = Date.now() + timeoutMs
    const skipPageRank = opts?.skipPageRank ?? false

    const nodes = this.getAllNodeIds()
    const roles = new Map<string, RoleType>()

    // 计算 fanIn/fanOut
    const fanIn = new Map<string, number>()
    const fanOut = new Map<string, number>()
    const crossModuleRatio = new Map<string, number>()

    for (const node of nodes) {
      const inEdges = this.store.getInEdges(node)
      const outEdges = this.store.getOutEdges(node)
      fanIn.set(node, [...inEdges.keys()].length)
      fanOut.set(node, [...outEdges.keys()].length)

      // 跨模块边比例
      let cross = 0
      let total = 0
      const nodeFile = this.store.getNode(node)?.file ?? ''
      const nodeModule = nodeFile.split('/').slice(0, -1).join('/')
      for (const [target] of outEdges) {
        total++
        const targetFile = this.store.getNode(target)?.file ?? ''
        const targetModule = targetFile.split('/').slice(0, -1).join('/')
        if (nodeModule !== targetModule) cross++
      }
      crossModuleRatio.set(node, total > 0 ? cross / total : 0)
    }

    // Step 1: 找 entry 点
    const entries = nodes.filter(n => fanIn.get(n) === 0 && fanOut.get(n)! > 0)

    // Step 2: 找 dead 节点（从 entry 不可达）
    const reachableFromEntries = new Set<string>()
    for (const entry of entries) {
      if (Date.now() > deadline) break
      const result = this.bfs(entry)
      for (const n of result.nodes) reachableFromEntries.add(n)
    }

    // 计算 PageRank 用于 core 分类
    let prMap = new Map<string, number>()
    let prThreshold = 0
    if (!skipPageRank) {
      const remainingMs = Math.max(1000, deadline - Date.now())
      const pr = this.pageRank(0.85, 100, remainingMs)
      prMap = new Map(pr.scores.map(s => [s.node, s.score]))
      const prSorted = [...prMap.values()].sort((a, b) => a - b)
      prThreshold = prSorted[Math.floor(prSorted.length * corePercentile)] ?? 0
    }

    // 计算 fanIn 百分位
    const fanInSorted = [...fanIn.values()].sort((a, b) => a - b)
    const fanInP75 = fanInSorted[Math.floor(fanInSorted.length * utilityFanInPercentile)] ?? 0
    const fanOutSorted = [...fanOut.values()].sort((a, b) => a - b)
    const fanOutP25 = fanOutSorted[Math.floor(fanOutSorted.length * 0.25)] ?? 0
    const fanInMedian = fanInSorted[Math.floor(fanInSorted.length * 0.5)] ?? 0

    // Directory pattern hints (before priority classification)
    const dirHints = new Map<string, RoleType>()
    for (const node of nodes) {
      const meta = this.store.getNode(node)
      const filePath = meta?.file ?? ''
      for (const { pattern, hint } of DIRECTORY_ROLE_PATTERNS) {
        if (pattern.test(filePath)) {
          dirHints.set(node, hint)
          break
        }
      }
    }

    // 按优先级分类
    for (const node of nodes) {
      const fi = fanIn.get(node) ?? 0
      const fo = fanOut.get(node) ?? 0
      const cmr = crossModuleRatio.get(node) ?? 0
      const prScore = prMap.get(node) ?? 0
      const meta = this.store.getNode(node)
      const isExported = meta?.is_exported === true
      const isPrivate = meta?.visibility === 'private'

      // 1. dead
      if (!reachableFromEntries.has(node) && entries.length > 0) {
        roles.set(node, 'dead')
        continue
      }

      // 2. entry — F-66: exported symbols with fanIn=0 get boosted to entry
      if (fi === 0 && fo > 0) {
        roles.set(node, 'entry')
        continue
      }
      if (isExported && fi === 0) {
        roles.set(node, 'entry')
        continue
      }

      // 3. leaf
      if (fo === 0 && fi > 0) {
        roles.set(node, 'leaf')
        continue
      }

      // 4. adaptor — F-66: exported symbols with high fan-in → API boundary adaptor
      if (isExported && fi > fanInMedian) {
        roles.set(node, 'adaptor')
        continue
      }
      if (cmr > adaptorCrossModuleRatio) {
        roles.set(node, 'adaptor')
        continue
      }

      // 4.5. Directory pattern hint (fallback between adaptor and core)
      const dirHint = dirHints.get(node)
      if (dirHint) {
        roles.set(node, dirHint)
        continue
      }

      // 5. core — F-66: private visibility demotes from core
      if (!skipPageRank && prScore >= prThreshold && fi > fanInMedian) {
        if (isPrivate) {
          // Demote private nodes from core to utility
          roles.set(node, 'utility')
          continue
        }
        roles.set(node, 'core')
        continue
      }

      // 6. utility
      if (fi > fanInP75 && fo < fanOutP25) {
        roles.set(node, 'utility')
        continue
      }

      // 默认 utility
      roles.set(node, 'utility')
    }

    // Cache result for subsequent calls with same options
    this._rolesCache = new Map(roles)
    this._rolesCacheKey = JSON.stringify(opts ?? {})

    return roles
  }

  /**
   * 功能链路追踪 — 从 entry 点 BFS 追踪调用链，检测是否端到端连通
   *
   * 识别 entry → ... → data layer 的完整路径，标记断裂点。
   * 数据层检测基于文件路径模式和节点 kind。
   */
  traceFeatureChains(opts?: { maxDepth?: number; maxChains?: number; roles?: Map<string, RoleType>; timeoutMs?: number }): ChainTraceResult {
    const maxDepth = opts?.maxDepth ?? 10
    const maxChains = opts?.maxChains ?? 50
    const timeoutMs = opts?.timeoutMs ?? 30000
    const startTime = Date.now()
    let timedOut = false

    const roles = opts?.roles ?? this.classifyRoles()
    const nodes = this.getAllNodeIds()
    const brokenLinks: Array<{ from: string; to: string; fromRole: string }> = []

    // Data layer detection patterns
    const DATA_LAYER_PATTERNS: RegExp[] = [
      /\/(database|db|dao|repository|repos?)\//i,
      /\/(prisma|drizzle|typeorm|sequelize|knex|mongoose)\//i,
      /\/(redis|memcache|cache)\//i,
      /\/(storage|filesystem|s3|blob)\//i,
      /\/(queue|kafka|rabbit|nats|pubsub)\//i,
      /\/(grpc|fetch|axios)\//i,  // external HTTP clients (not /api/ — that's usually routes)
      /\/(socket|websocket|ws)\//i,
    ]
    const DATA_LAYER_KINDS = new Set(['database', 'repository', 'dao', 'model', 'schema', 'entity'])

    function isDataLayer(nodeId: string, store: GraphStore): boolean {
      const meta = store.getNode(nodeId)
      if (!meta) return false
      // Check kind — model/entity/schema are also data layer even if they're leaf nodes
      if (DATA_LAYER_KINDS.has(meta.kind)) return true
      // Check file path
      const filePath = meta.file ?? ''
      return DATA_LAYER_PATTERNS.some(p => p.test(filePath))
    }

    // Collect entry points
    const entries = nodes.filter(n => roles.get(n) === 'entry')

    const chains: FeatureChain[] = []
    let completeChains = 0
    let brokenChains = 0
    let unreachableEntries = 0

    for (const entry of entries) {
      if (chains.length >= maxChains) break
      if (Date.now() - startTime > timeoutMs) { timedOut = true; break }

      const entryMeta = this.store.getNode(entry)
      const entryFile = entryMeta?.file ?? ''

      // BFS from this entry — track deepest node inline to avoid O(n^2) post-scan
      const visited = new Set<string>()
      const parent = new Map<string, string>() // child → parent
      const queue: Array<{ node: string; depth: number }> = [{ node: entry, depth: 0 }]
      let head = 0
      visited.add(entry)

      let dataLayerNode: string | undefined
      let dataLayerDepth = Infinity
      let deepestNode = entry
      let maxBfsDepth = 0

      while (head < queue.length) {
        const { node, depth } = queue[head++]!

        // Track deepest node during BFS traversal
        if (depth > maxBfsDepth) {
          maxBfsDepth = depth
          deepestNode = node
        }

        // Check if this node is a data layer node
        if (depth > 0 && isDataLayer(node, this.store)) {
          if (depth < dataLayerDepth) {
            dataLayerNode = node
            dataLayerDepth = depth
          }
        }

        if (depth >= maxDepth) continue

        const outEdges = this.store.getOutEdges(node)
        for (const [target, edges] of outEdges) {
          // Only follow semantic edges, skip structural 'contains' edges
          if (edges.every(e => e.type === 'contains')) continue
          if (!visited.has(target)) {
            visited.add(target)
            parent.set(target, node)
            queue.push({ node: target, depth: depth + 1 })
          }
        }
      }

      // No reachable nodes from this entry
      if (visited.size <= 1) {
        unreachableEntries++
        continue
      }

      // Reconstruct path to data layer (or deepest reachable)
      const terminalNode = dataLayerNode ?? deepestNode
      const path: string[] = []
      let current: string | undefined = terminalNode
      while (current !== undefined) {
        path.unshift(current)
        current = parent.get(current)
      }

      const pathFiles = path.map(id => this.store.getNode(id)?.file ?? '')
      const pathRoles = path.map(id => roles.get(id) ?? 'unknown')

      // Check for semantic gaps: role transitions that indicate missing layers
      // e.g., entry → leaf (skipping service/core), entry → data (skipping business logic)
      let brokenAt: number | undefined
      // Valid role transitions — missing entries mean "terminal" (no further transitions expected):
      //   'utility': not a key — utility nodes are terminal sinks (no downstream expectations)
      //   'leaf':    not a key — leaf nodes are terminal sinks (fanOut=0)
      //   'dead':    not a key — dead nodes are unreachable, never appear in valid chains
      const EXPECTED_TRANSITIONS: Record<string, Set<string>> = {
        'entry': new Set(['adaptor', 'core', 'utility', 'leaf']),  // direct route to model layer is valid
        'adaptor': new Set(['core', 'utility', 'leaf']),
        'core': new Set(['core', 'utility', 'leaf']),
      }
      for (let i = 0; i < pathRoles.length - 1; i++) {
        const currentRole = pathRoles[i]
        const nextRole = pathRoles[i + 1]
        const expected = EXPECTED_TRANSITIONS[currentRole]
        if (expected && !expected.has(nextRole) && nextRole !== 'entry') {
          brokenAt = i
          brokenLinks.push({ from: path[i], to: path[i + 1], fromRole: currentRole })
          break
        }
      }

      if (dataLayerNode) {
        completeChains++
      } else {
        brokenChains++
      }

      chains.push({
        entry,
        entryFile,
        path,
        pathFiles,
        roles: pathRoles,
        reachesDataLayer: !!dataLayerNode,
        dataLayerNode,
        brokenAt,
        depth: path.length - 1,
      })
    }

    return {
      chains,
      stats: {
        totalEntries: entries.length,
        completeChains,
        brokenChains,
        unreachableEntries,
      },
      brokenLinks,
      timedOut,
    }
  }

  /**
   * 数据依赖切片 — 沿 data 边反向追踪
   * DDG 来源: codegraph.db 的 references 边（映射为 data）
   * 降级策略: 若无 data 边，退化为 backwardReachability
   */
  backwardDataSlice(nodeId: string): SliceResult {
    const symbols: string[] = []
    const dataFlows: Array<{ from: string; to: string; via: string }> = []
    const visited = new Set<string>()
    const queue = [nodeId]
    let head = 0
    visited.add(nodeId)

    // F-67: Follow data, type_of, returns, and P2/P3 data-flow edges
    const DATA_SLICE_EDGE_TYPES = new Set([
      'data', 'type_of', 'returns',
      'reads', 'writes', 'transforms',
      'serializes', 'deserializes', 'encrypts', 'decrypts', 'compresses',
    ])

    let hasDataEdges = false

    while (head < queue.length) {
      const current = queue[head++]!
      symbols.push(current)

      const inEdges = this.store.getInEdges(current)
      for (const [source, edges] of inEdges) {
        for (const edge of edges) {
          if (DATA_SLICE_EDGE_TYPES.has(edge.type)) {
            hasDataEdges = true
            dataFlows.push({ from: source, to: current, via: edge.type })
            if (!visited.has(source)) {
              visited.add(source)
              queue.push(source)
            }
            break // 找到一个 data/type_of/returns 边就够了
          }
        }
      }
    }

    // 降级：若无 data 边，退化为 backwardReachability
    if (!hasDataEdges) {
      const fallback = this.backwardReachability(nodeId)
      return {
        symbols: fallback.reachable,
        dataFlows: fallback.reachable.slice(1).map(n => ({ from: n, to: nodeId, via: 'call-graph-approx' })),
      }
    }

    return { symbols, dataFlows }
  }

  /**
   * 耦合度量 — 扇入扇出 + Henderson-Sellers LCOM
   */
  couplingMetrics(opts?: { timeoutMs?: number }): MetricsResult {
    const timeoutMs = opts?.timeoutMs ?? 15000
    const deadline = Date.now() + timeoutMs
    const nodes = this.getAllNodeIds()
    const highCoupling: MetricsResult['highCoupling'] = []

    // 扇入扇出 + 不稳定度
    for (const node of nodes) {
      const fi = [...this.store.getInEdges(node).keys()].length
      const fo = [...this.store.getOutEdges(node).keys()].length
      const instability = fi + fo > 0 ? fo / (fi + fo) : 0

      if (fi > 5 || fo > 5) {
        highCoupling.push({ node, fanIn: fi, fanOut: fo, instability })
      }
    }

    highCoupling.sort((a, b) => (b.fanIn + b.fanOut) - (a.fanIn + a.fanOut))

    // LCOM (Henderson-Sellers) — 对 class 节点计算
    const lcom: MetricsResult['lcom'] = []
    const classNodes = nodes.filter(n => {
      const meta = this.store.getNode(n)
      return meta?.kind === 'class' || meta?.kind === 'interface'
    })

    for (const cls of classNodes) {
      if (Date.now() > deadline) break

      const meta = this.store.getNode(cls)!
      const outEdges = this.store.getOutEdges(cls)
      const methods: string[] = []
      const fields: string[] = []

      for (const [target, edges] of outEdges) {
        if (edges.some(e => e.type === 'contains')) {
          const targetMeta = this.store.getNode(target)
          if (targetMeta?.kind === 'method') methods.push(target)
          else if (targetMeta?.kind === 'property') fields.push(target)
        }
      }

      if (methods.length === 0 || fields.length === 0) continue
      // Skip classes with too many methods to avoid O(m²) blowup
      if (methods.length > 200) continue

      // 计算方法间共享字段数
      let sharedPairs = 0
      let unsharedPairs = 0
      for (let i = 0; i < methods.length; i++) {
        for (let j = i + 1; j < methods.length; j++) {
          const m1Fields = this.getMethodFields(methods[i])
          const m2Fields = this.getMethodFields(methods[j])
          const intersection = m1Fields.filter(f => m2Fields.includes(f))
          if (intersection.length > 0) sharedPairs++
          else unsharedPairs++
        }
      }

      // LCOM* = max(0, (unshared - shared)) / (pairs)
      const totalPairs = sharedPairs + unsharedPairs
      const lcomValue = totalPairs > 0 ? Math.max(0, unsharedPairs - sharedPairs) / totalPairs : 0

      lcom.push({
        class: meta.name,
        lcom: Math.round(lcomValue * 100) / 100,
        methods: methods.length,
        fields: fields.length,
      })
    }

    return { highCoupling, lcom }
  }

  // ── Phase 3c: 高复杂度 + 增值功能 ──

  /**
   * Katz 中心性 — 幂迭代
   * α < 1/λ_max 保证收敛
   */
  katzCentrality(opts?: KatzOpts): CentralityResult {
    const epsilon = opts?.epsilon ?? 1e-6
    const maxIter = opts?.maxIter ?? 100

    const nodes = this.getAllNodeIds()
    const N = nodes.length
    if (N === 0) return { scores: [] }

    // Auto-compute alpha from max in-degree if not specified
    let maxInDeg = 0
    if (opts?.alpha === undefined) {
      for (const node of nodes) {
        let deg = 0
        for (const [, edges] of this.store.getInEdges(node)) {
          for (const _ of edges) deg++
        }
        if (deg > maxInDeg) maxInDeg = deg
      }
    }
    // Auto-alpha: 0.9/sqrt(maxInDeg) is a conservative heuristic for α < 1/ρ(A).
    // For directed graphs ρ(A) ≤ sqrt(maxInDeg * maxOutDeg), so this is safe when
    // maxInDeg ≈ maxOutDeg. For highly asymmetric graphs (e.g., many sinks with no
    // out-edges), the true spectral radius may be smaller, making this slightly
    // over-conservative. Pass an explicit `alpha` to override if convergence is too slow.
    // Convergence requires alpha < 1/rho(A); use 0.9/maxInDeg as conservative estimate
    const alpha = opts?.alpha ?? (maxInDeg > 0 ? 0.9 / maxInDeg : 0.1)

    const x = new Map<string, number>()
    for (const node of nodes) x.set(node, 1)

    for (let iter = 0; iter < maxIter; iter++) {
      const newX = new Map<string, number>()
      let l1Norm = 0

      for (const v of nodes) {
        let sum = 0
        const inEdges = this.store.getInEdges(v)
        for (const [u] of inEdges) {
          sum += x.get(u) ?? 0
        }
        const val = 1 + alpha * sum
        l1Norm += Math.abs(val - (x.get(v) ?? 0))
        newX.set(v, val)
      }

      for (const node of nodes) x.set(node, newX.get(node)!)

      if (l1Norm < epsilon) break
    }

    // 归一化
    const maxVal = Math.max(...x.values())
    const scores = nodes
      .map(node => ({ node, score: maxVal > 0 ? x.get(node)! / maxVal : 0 }))
      .sort((a, b) => b.score - a.score)

    return { scores }
  }

  /**
   * Betweenness Centrality — 采样近似 (Brandes)
   * sampleSize 控制采样节点数
   */
  betweennessCentrality(sampleSize = 200): CentralityResult {
    const nodes = this.getAllNodeIds()
    const N = nodes.length
    if (N === 0) return { scores: [] }

    const bc = new Map<string, number>()
    for (const node of nodes) bc.set(node, 0)

    // 采样
    const sampled = this.sampleNodes(nodes, Math.min(sampleSize, N))

    for (const s of sampled) {
      const stack: string[] = []
      const predecessors = new Map<string, string[]>()
      const sigma = new Map<string, number>()
      const delta = new Map<string, number>()
      const dist = new Map<string, number>()

      for (const node of nodes) {
        predecessors.set(node, [])
        sigma.set(node, 0)
        delta.set(node, 0)
        dist.set(node, -1)
      }

      sigma.set(s, 1)
      dist.set(s, 0)

      const queue: string[] = [s]
      let head = 0

      while (head < queue.length) {
        const v = queue[head++]!
        stack.push(v)

        const outEdges = this.store.getOutEdges(v)
        for (const [w] of outEdges) {
          if (dist.get(w)! < 0) {
            queue.push(w)
            dist.set(w, dist.get(v)! + 1)
          }

          if (dist.get(w)! === dist.get(v)! + 1) {
            sigma.set(w, sigma.get(w)! + sigma.get(v)!)
            predecessors.get(w)!.push(v)
          }
        }
      }

      while (stack.length > 0) {
        const w = stack.pop()!
        for (const v of predecessors.get(w) ?? []) {
          delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!))
        }
        if (w !== s) {
          bc.set(w, bc.get(w)! + delta.get(w)!)
        }
      }
    }

    // 归一化
    const maxBc = Math.max(...bc.values())
    const scores = nodes
      .map(node => ({ node, score: maxBc > 0 ? bc.get(node)! / maxBc : 0 }))
      .sort((a, b) => b.score - a.score)

    return { scores }
  }

  /**
   * Louvain 社区检测 — 多级聚合 (Phase 1 + Phase 2)
   *
   * 外层循环:
   *   1. Phase 1: 内层迭代，将节点移至最佳社区
   *   2. 计算 modularity 增益，若 < epsilon 则停止
   *   3. Phase 2: 将社区聚合为超节点，构建粗化图
   *   4. 在粗化图上重复，直到收敛或达到 maxLevels
   */
  louvainCommunity(opts?: LouvainOpts): CommunityResult {
    const resolution = opts?.resolution ?? 1.0
    const epsilon = opts?.epsilon ?? 1e-6
    const maxPasses = opts?.maxPasses ?? 100
    const maxLevels = opts?.maxLevels ?? 10
    const timeoutMs = opts?.timeoutMs ?? 30000
    const deadline = Date.now() + timeoutMs

    const nodes = this.getAllNodeIds()
    const N = nodes.length
    if (N === 0) return { communities: [], modularity: 0, resolution }

    // Build initial undirected graph
    const { totalWeight, degree, adjMap } = this.buildUndirectedGraph()

    // Track mapping from current nodes back to original nodes
    let nodeMapping = new Map<string, string[]>()
    for (const node of nodes) {
      nodeMapping.set(node, [node])
    }

    // Initialize: each node its own community
    let currentNodes = [...nodes]
    let currentAdjMap = adjMap
    let currentDegree = degree
    let currentCommunity = new Map<string, number>()
    currentNodes.forEach((node, i) => currentCommunity.set(node, i))

    let level = 0
    while (level < maxLevels) {
      if (Date.now() > deadline) break
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
  async temporalCoupling(projectRoot: string, opts?: TemporalOpts): Promise<CouplingResult> {
    const sinceValue = opts?.since ?? '30 days'
    const limit = opts?.limit ?? 30
    const maxCommits = opts?.maxCommits ?? 1000

    const { stdout: gitLog } = await execFileAsync(
      'git', ['log', '--name-only', `--max-count=${maxCommits}`, '--pretty=format:COMMIT:%H', `--since=${sinceValue}`],
      { cwd: projectRoot, timeout: 30000 }
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
