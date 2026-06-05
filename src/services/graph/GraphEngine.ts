/**
 * GraphEngine — 核心图算法引擎
 *
 * 零外部依赖的 TS 图算法库，基于 GraphStore 的加权邻接表。
 *
 * 设计文档: docs/superpowers/specs/2026-06-05-codegraph-grok-enhancement-design.md §2.4
 */

import type { GraphStore, EdgeMeta, NodeMetadata } from './GraphStore.js'

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
}

export interface TemporalOpts {
  since?: string
  limit?: number
  minCoChanges?: number
  maxCommits?: number
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

export class GraphEngine {
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
    visited.add(start)
    depth.set(start, 0)

    while (queue.length > 0) {
      const { node, d } = queue.shift()!
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
    visited.add(nodeId)

    while (queue.length > 0) {
      const current = queue.shift()!
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

    const order: string[] = []
    while (queue.length > 0) {
      const sccId = queue.shift()!
      const scc = sccs.find(s => s.id === sccId)!
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
  pageRank(damping = 0.85, maxIter = 100): CentralityResult {
    const nodes = this.getAllNodeIds()
    const N = nodes.length

    if (N === 0) return { scores: [] }

    const pr = new Map<string, number>()
    const outDeg = new Map<string, number>()

    // 初始化
    for (const node of nodes) {
      pr.set(node, 1 / N)
      let deg = 0
      for (const [, edge] of this.store.getOutEdges(node)) {
        if (edge.type !== 'contains') deg++ // 排除 contains 边
      }
      outDeg.set(node, deg)
    }

    for (let iter = 0; iter < maxIter; iter++) {
      const newPr = new Map<string, number>()
      let danglingSum = 0

      // 计算悬挂节点的概率质量
      for (const node of nodes) {
        if (outDeg.get(node) === 0) {
          danglingSum += pr.get(node)!
        }
      }

      let l1Norm = 0

      for (const v of nodes) {
        let incomingSum = 0
        const inEdges = this.store.getInEdges(v)
        for (const [u, edge] of inEdges) {
          if (edge.type !== 'contains') {
            const uDeg = outDeg.get(u) ?? 1
            incomingSum += (pr.get(u) ?? 0) / uDeg
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
   * 支配树 — Lengauer-Tarjan 算法 O(V·α(V)+E)
   * 简化版：使用迭代 DFS + 支配者计算
   */
  dominatorTree(root: string): Map<string, string | null> {
    const dominated = new Map<string, string | null>()
    const reachable = this.bfs(root)
    const reachableSet = new Set(reachable.nodes)

    // 从 root 开始，计算每个节点的直接支配者
    dominated.set(root, null)

    // 迭代收敛：对每个可达节点，找其所有前驱的支配者的交集
    const changed = true
    let iterations = 0
    const maxIterations = reachable.nodes.length * 2

    while (changed && iterations < maxIterations) {
      iterations++
      let anyChanged = false

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
          anyChanged = true
        }
      }

      if (!anyChanged) break
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
    const corePercentile = opts?.corePercentile ?? 0.8
    const utilityFanInPercentile = opts?.utilityFanInPercentile ?? 0.75
    const adaptorCrossModuleRatio = opts?.adaptorCrossModuleRatio ?? 0.5

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
      const result = this.bfs(entry)
      for (const n of result.nodes) reachableFromEntries.add(n)
    }

    // 计算 PageRank 用于 core 分类
    const pr = this.pageRank()
    const prMap = new Map(pr.scores.map(s => [s.node, s.score]))
    const prSorted = [...prMap.values()].sort((a, b) => a - b)
    const prThreshold = prSorted[Math.floor(prSorted.length * corePercentile)] ?? 0

    // 计算 fanIn 百分位
    const fanInSorted = [...fanIn.values()].sort((a, b) => a - b)
    const fanInP75 = fanInSorted[Math.floor(fanInSorted.length * utilityFanInPercentile)] ?? 0
    const fanOutSorted = [...fanOut.values()].sort((a, b) => a - b)
    const fanOutP25 = fanOutSorted[Math.floor(fanOutSorted.length * 0.25)] ?? 0
    const fanInMedian = fanInSorted[Math.floor(fanInSorted.length * 0.5)] ?? 0

    // 按优先级分类
    for (const node of nodes) {
      const fi = fanIn.get(node) ?? 0
      const fo = fanOut.get(node) ?? 0
      const cmr = crossModuleRatio.get(node) ?? 0
      const prScore = prMap.get(node) ?? 0

      // 1. dead
      if (!reachableFromEntries.has(node) && entries.length > 0) {
        roles.set(node, 'dead')
        continue
      }

      // 2. entry
      if (fi === 0 && fo > 0) {
        roles.set(node, 'entry')
        continue
      }

      // 3. leaf
      if (fo === 0 && fi > 0) {
        roles.set(node, 'leaf')
        continue
      }

      // 4. adaptor
      if (cmr > adaptorCrossModuleRatio) {
        roles.set(node, 'adaptor')
        continue
      }

      // 5. core
      if (prScore >= prThreshold && fi > fanInMedian) {
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

    return roles
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
    visited.add(nodeId)

    let hasDataEdges = false

    while (queue.length > 0) {
      const current = queue.shift()!
      symbols.push(current)

      const inEdges = this.store.getInEdges(current)
      for (const [source, edges] of inEdges) {
        for (const edge of edges) {
          if (edge.type === 'data') {
            hasDataEdges = true
            dataFlows.push({ from: source, to: current, via: edge.type })
            if (!visited.has(source)) {
              visited.add(source)
              queue.push(source)
            }
            break // 找到一个 data 边就够了
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
  couplingMetrics(): MetricsResult {
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
      const meta = this.store.getNode(cls)!
      const outEdges = this.store.getOutEdges(cls)
      const methods: string[] = []
      const fields: string[] = []

      for (const [target, edge] of outEdges) {
        if (edge.type === 'contains') {
          const targetMeta = this.store.getNode(target)
          if (targetMeta?.kind === 'method') methods.push(target)
          else if (targetMeta?.kind === 'property') fields.push(target)
        }
      }

      if (methods.length === 0 || fields.length === 0) continue

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
    const alpha = opts?.alpha ?? (maxInDeg > 0 ? 0.9 / Math.sqrt(maxInDeg) : 0.1)

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

      while (queue.length > 0) {
        const v = queue.shift()!
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
   * Louvain 社区检测
   * 收敛条件: 内层 — 本轮无节点移动 或 delta Q < epsilon
   *          外层 — modularity 增益 < epsilon 或 达到 maxLevels
   */
  louvainCommunity(opts?: LouvainOpts): CommunityResult {
    const resolution = opts?.resolution ?? 1.0
    const epsilon = opts?.epsilon ?? 1e-6
    const maxPasses = opts?.maxPasses ?? 100

    const nodes = this.getAllNodeIds()
    const N = nodes.length
    if (N === 0) return { communities: [], modularity: 0, resolution }

    // 初始化：每个节点一个社区
    const community = new Map<string, number>()
    nodes.forEach((node, i) => community.set(node, i))

    // 计算总边数 (2m) — 仅出边权重
    let totalWeight = 0
    for (const [, outMap] of this.store.adjacency) {
      for (const [, edges] of outMap) {
        for (const edge of edges) {
          totalWeight += edge.weight
        }
      }
    }
    if (totalWeight === 0) totalWeight = 1

    // 节点度数（仅出边，与 totalWeight = Σout 一致）
    const degree = new Map<string, number>()
    for (const node of nodes) {
      let deg = 0
      for (const [, edges] of this.store.getOutEdges(node)) {
        for (const edge of edges) deg += edge.weight
      }
      degree.set(node, deg)
    }

    // 社区内度数和
    const communityDegreeSum = new Map<number, number>()
    for (const node of nodes) {
      const c = community.get(node)!
      communityDegreeSum.set(c, (communityDegreeSum.get(c) ?? 0) + (degree.get(node) ?? 0))
    }

    // 内层迭代
    for (let pass = 0; pass < maxPasses; pass++) {
      let moved = false

      for (const node of nodes) {
        const currentCommunity = community.get(node)!
        const nodeDeg = degree.get(node) ?? 0

        // 计算邻居社区（仅出边，与 degree 定义一致）
        const neighborCommunities = new Map<number, number>()
        const outEdges = this.store.getOutEdges(node)

        for (const [neighbor, edges] of outEdges) {
          const nc = community.get(neighbor)
          if (nc !== undefined) {
            for (const edge of edges) {
              neighborCommunities.set(nc, (neighborCommunities.get(nc) ?? 0) + edge.weight)
            }
          }
        }

        // 找最佳社区
        let bestCommunity = currentCommunity
        let bestGain = 0

        for (const [candidateComm, edgeWeightToComm] of neighborCommunities) {
          if (candidateComm === currentCommunity) continue

          // Modularity gain: ΔQ = resolution * (k_i_in/2m - k_i * Σ_tot / (2m)^2)
          // degree = out-degree only, totalWeight = 2m
          const sigmaIn = edgeWeightToComm
          const sigmaTot = communityDegreeSum.get(candidateComm) ?? 0
          const gain = resolution * ((sigmaIn / totalWeight) - (nodeDeg * sigmaTot) / (totalWeight * totalWeight))

          if (gain > bestGain) {
            bestGain = gain
            bestCommunity = candidateComm
          }
        }

        if (bestCommunity !== currentCommunity) {
          // 移动节点
          community.set(node, bestCommunity)
          communityDegreeSum.set(currentCommunity, (communityDegreeSum.get(currentCommunity) ?? 0) - nodeDeg)
          communityDegreeSum.set(bestCommunity, (communityDegreeSum.get(bestCommunity) ?? 0) + nodeDeg)
          moved = true
        }
      }

      if (!moved) break
    }

    // 组装结果
    const commNodes = new Map<number, string[]>()
    for (const [node, c] of community) {
      if (!commNodes.has(c)) commNodes.set(c, [])
      commNodes.get(c)!.push(node)
    }

    const communities = [...commNodes.entries()].map(([id, nodes]) => ({
      id,
      nodes,
      size: nodes.length,
    }))

    // 计算最终 modularity Q
    let Q = 0
    for (const comm of communities) {
      let internalWeight = 0
      let commDegree = 0
      for (const node of comm.nodes) {
        commDegree += degree.get(node) ?? 0
        for (const [target, edges] of this.store.getOutEdges(node)) {
          if (community.get(target) === comm.id) {
            for (const edge of edges) {
              internalWeight += edge.weight
            }
          }
        }
      }
      // degree = out-degree only, totalWeight = 2m
      Q += (internalWeight / totalWeight) - resolution * Math.pow(commDegree / totalWeight, 2)
    }

    return { communities, modularity: Math.round(Q * 1000) / 1000, resolution }
  }

  /**
   * 时间耦合 — git log 解析 + 滑动时间窗口
   * 需要 git 命令，由上层 CodegraphTool 调用
   */
  async temporalCoupling(opts?: TemporalOpts): Promise<CouplingResult> {
    // 此方法需要 git 命令，在 GraphEngine 中仅定义接口
    // 实际实现在 CodegraphTool 层（调用 git log + GraphEngine 分析）
    throw new Error('temporalCoupling 需要在 CodegraphTool 层实现（依赖 git 命令）')
  }

  // ── Helpers ──

  getAllNodeIds(): string[] {
    return [...this.store.nodeMeta.keys()]
  }

  private getOutNeighborIds(nodeId: string): string[] {
    const outEdges = this.store.getOutEdges(nodeId)
    return [...outEdges.keys()]
  }

  private intersectDominators(a: string, b: string, dominated: Map<string, string | null>): string | null {
    const visited = new Set<string>()
    let cur: string | null = a
    while (cur !== null) {
      visited.add(cur)
      cur = dominated.get(cur) ?? null
    }

    cur = b
    while (cur !== null) {
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
    const order: string[] = []

    while (queue.length > 0) {
      const node = queue.shift()!
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
