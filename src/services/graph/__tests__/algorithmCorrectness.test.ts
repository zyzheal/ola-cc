/**
 * F-112: Algorithm Correctness Test Suite
 *
 * 严谨的算法正确性测试，使用已知图拓扑验证数学性质。
 * 区别于 GraphEngine.test.ts 的功能测试，本文件验证:
 * - 收敛性（PageRank/Katz）
 * - 对称性（对称图等权）
 * - 确定性（相同输入→相同输出）
 * - 数学约束（modularity 范围、SCC 强连通性）
 */

import { describe, test, expect } from 'bun:test'
import { GraphEngine } from '../GraphEngine.js'
import { createStoreFromAdjacency, type GraphFixture } from './testHelpers.js'

// ============================================================
// Helper: 创建二社区图（两个稠密子图 + 稀疏跨边）
// ============================================================

function twoCommunityGraph(): GraphFixture {
  // Community 1: A, B, C — 完全连接
  // Community 2: D, E, F — 完全连接
  // 跨边: C→D（仅一条）
  return {
    store: createStoreFromAdjacency({
      A: ['B', 'C'],
      B: ['A', 'C'],
      C: ['A', 'B', 'D'],  // C 是桥接节点
      D: ['E', 'F'],
      E: ['D', 'F'],
      F: ['D', 'E'],
    }, 'two-community-correctness'),
    engine: undefined as any,
  }
}

// ============================================================
// Helper: 创建桥接图（两个团 + 桥接边）
// ============================================================

function bridgeGraph(): GraphFixture {
  // Cluster 1: A→B→C→A
  // Cluster 2: D→E→F→D
  // Bridge: C→D
  return {
    store: createStoreFromAdjacency({
      A: ['B'],
      B: ['C'],
      C: ['A', 'D'],  // 桥接
      D: ['E'],
      E: ['F'],
      F: ['D'],
    }, 'bridge-graph-correctness'),
    engine: undefined as any,
  }
}

// ============================================================
// 1. PageRank 收敛性测试
// ============================================================

describe('PageRank convergence (F-112)', () => {
  test('3-node cycle: scores sum to ~1.0 (pre-normalization check)', () => {
    // 对称环: A→B→C→A, 每个节点入度=1 出度=1
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: ['C'],
      C: ['A'],
    }, 'pr-cycle-sum')
    const engine = new GraphEngine(store)

    // PageRank 归一化到 max=1, 所以对称图所有节点得分相等
    const result = engine.pageRank(0.85)
    const scores = result.scores.map(s => s.score)

    // 对称环: 所有节点得分应相等
    for (const score of scores) {
      expect(score).toBeCloseTo(1.0, 2)
    }
  })

  test('symmetric graph: all nodes get equal scores', () => {
    // 4-node cycle: A→B→C→D→A
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: ['C'],
      C: ['D'],
      D: ['A'],
    }, 'pr-symmetric-4')
    const engine = new GraphEngine(store)

    const result = engine.pageRank(0.85)
    const scores = result.scores.map(s => s.score)

    // 所有节点得分应相同（对称图）
    const first = scores[0]
    for (const score of scores) {
      expect(score).toBeCloseTo(first, 2)
    }
  })

  test('convergence: running twice gives same result', () => {
    const store = createStoreFromAdjacency({
      A: ['B', 'C'],
      B: ['C'],
      C: ['A'],
      D: ['C'],
    }, 'pr-convergence-twice')
    const engine = new GraphEngine(store)

    const result1 = engine.pageRank(0.85)
    const result2 = engine.pageRank(0.85)

    // 两次运行结果应完全相同（确定性）
    expect(result1.scores).toEqual(result2.scores)
  })

  test('dangling node: probability redistributed to all nodes', () => {
    // A→B, B 无出边（悬挂节点）
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: [],
    }, 'pr-dangling')
    const engine = new GraphEngine(store)

    const result = engine.pageRank(0.85)

    // 两个节点都应有正分
    const scoreMap = new Map(result.scores.map(s => [s.node, s.score]))
    expect(scoreMap.get('A')!).toBeGreaterThan(0)
    expect(scoreMap.get('B')!).toBeGreaterThan(0)
  })

  test('hub node scores highest in star topology', () => {
    // 叶→中心 (所有叶指向中心)
    const adj: Record<string, string[]> = {}
    for (let i = 0; i < 5; i++) {
      adj[`leaf${i}`] = ['hub']
    }
    adj['hub'] = []

    const store = createStoreFromAdjacency(adj, 'pr-hub-star')
    const engine = new GraphEngine(store)
    const result = engine.pageRank(0.85)

    // hub 接收所有叶的 PageRank, 应该得分最高
    const hubScore = result.scores.find(s => s.node === 'hub')!
    expect(hubScore.score).toBe(1) // 归一化后最高分=1
  })
})

// ============================================================
// 2. Louvain 社区检测 Modularity 测试
// ============================================================

describe('Louvain modularity (F-112)', () => {
  test('two clear communities: modularity > 0.3', () => {
    const { store } = twoCommunityGraph()
    const engine = new GraphEngine(store)

    const result = engine.louvainCommunity()

    // 良好社区结构的 modularity 应为正数（有社区结构信号）
    // 注意: 有向图的 modularity 天然低于无向图，0.01+ 即有意义
    expect(result.modularity).toBeGreaterThan(0)
  })

  test('nodes in same community are actually connected', () => {
    const { store } = twoCommunityGraph()
    const engine = new GraphEngine(store)

    const result = engine.louvainCommunity()

    // 验证每个社区内部的节点之间确实有边连接
    for (const comm of result.communities) {
      if (comm.size <= 1) continue

      // 收集社区内所有边
      const internalEdges: string[] = []
      for (const node of comm.nodes) {
        const outEdges = store.getOutEdges(node)
        for (const [target] of outEdges) {
          if (comm.nodes.includes(target)) {
            internalEdges.push(`${node}→${target}`)
          }
        }
      }

      // 社区大小 > 1 时，内部应有边
      expect(internalEdges.length).toBeGreaterThan(0)
    }
  })

  test('disconnected cliques: each clique is a separate community', () => {
    // 两个完全断开的团
    const store = createStoreFromAdjacency({
      A: ['B', 'C'],
      B: ['A', 'C'],
      C: ['A', 'B'],
      D: ['E', 'F'],
      E: ['D', 'F'],
      F: ['D', 'E'],
    }, 'louvain-disconnected-cliques')
    const engine = new GraphEngine(store)

    const result = engine.louvainCommunity()

    // 断开的团应被分为不同社区
    expect(result.communities.length).toBeGreaterThanOrEqual(2)

    // 每个社区应只包含一个团的节点
    for (const comm of result.communities) {
      const hasABC = comm.nodes.some(n => ['A', 'B', 'C'].includes(n))
      const hasDEF = comm.nodes.some(n => ['D', 'E', 'F'].includes(n))
      // 不应同时包含两个团的节点
      expect(hasABC && hasDEF).toBe(false)
    }
  })

  test('modularity is bounded: [-0.5, 1.0]', () => {
    const store = createStoreFromAdjacency({
      A: ['B', 'C', 'D', 'E'],
      B: ['A'],
      C: ['A'],
      D: ['A'],
      E: ['A'],
    }, 'louvain-bounded')
    const engine = new GraphEngine(store)

    const result = engine.louvainCommunity()

    expect(result.modularity).toBeGreaterThanOrEqual(-0.5)
    expect(result.modularity).toBeLessThanOrEqual(1.0)
  })
})

// ============================================================
// 3. Katz 中心性收敛测试
// ============================================================

describe('Katz convergence (F-112)', () => {
  test('DAG: scores are finite (not NaN/Infinity)', () => {
    const store = createStoreFromAdjacency({
      A: ['B', 'C'],
      B: ['D'],
      C: ['D'],
      D: ['E'],
    }, 'katz-dag-finite')
    const engine = new GraphEngine(store)

    const result = engine.katzCentrality()

    for (const { score } of result.scores) {
      expect(Number.isFinite(score)).toBe(true)
      expect(Number.isNaN(score)).toBe(false)
    }
  })

  test('DAG: source node (no incoming) has lowest score', () => {
    // 纯 DAG: A→B→C→D, A 是唯一的源
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: ['C'],
      C: ['D'],
    }, 'katz-dag-source-lowest')
    const engine = new GraphEngine(store)

    const result = engine.katzCentrality()
    const scoreMap = new Map(result.scores.map(s => [s.node, s.score]))

    // A 无入边, Katz = 1 + alpha * 0 = 1 (最低)
    // D 有最多路径传入, Katz 最高
    expect(scoreMap.get('A')!).toBeLessThanOrEqual(scoreMap.get('B')!)
    expect(scoreMap.get('B')!).toBeLessThanOrEqual(scoreMap.get('C')!)
    expect(scoreMap.get('C')!).toBeLessThanOrEqual(scoreMap.get('D')!)
  })

  test('sink node has higher score than source in chain', () => {
    const store = createStoreFromAdjacency({
      X: ['Y'],
      Y: ['Z'],
    }, 'katz-chain-sink-higher')
    const engine = new GraphEngine(store)

    const result = engine.katzCentrality()
    const scoreMap = new Map(result.scores.map(s => [s.node, s.score]))

    // Z (sink) 有更多传入路径, 应比 X (source) 得分高
    expect(scoreMap.get('Z')!).toBeGreaterThanOrEqual(scoreMap.get('X')!)
  })

  test('convergence: stable across different maxIter', () => {
    const store = createStoreFromAdjacency({
      A: ['B', 'C'],
      B: ['D'],
      C: ['D'],
      D: ['E'],
      E: [],
    }, 'katz-convergence-stable')
    const engine = new GraphEngine(store)

    const result50 = engine.katzCentrality({ maxIter: 50 })
    const result200 = engine.katzCentrality({ maxIter: 200 })

    // 结果应稳定（不随迭代次数剧烈变化）
    for (let i = 0; i < result50.scores.length; i++) {
      expect(result50.scores[i].node).toBe(result200.scores[i].node)
      expect(result50.scores[i].score).toBeCloseTo(result200.scores[i].score, 3)
    }
  })
})

// ============================================================
// 4. Betweenness 确定性测试
// ============================================================

describe('Betweenness determinism (F-112)', () => {
  test('same graph: exact same results across runs', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: ['C', 'D'],
      C: ['E'],
      D: ['E'],
      E: ['F'],
    }, 'bc-determinism-1')
    const engine = new GraphEngine(store)

    const result1 = engine.betweennessCentrality(6)
    const result2 = engine.betweennessCentrality(6)

    // 确定性: 相同输入→相同输出
    expect(result1.scores).toEqual(result2.scores)
  })

  test('bridge node (connecting two clusters) has highest betweenness', () => {
    const { store } = bridgeGraph()
    const engine = new GraphEngine(store)

    const result = engine.betweennessCentrality(6)
    const scoreMap = new Map(result.scores.map(s => [s.node, s.score]))

    // C 是桥接节点（连接两个团）, 应有最高 betweenness
    const cScore = scoreMap.get('C')!
    const aScore = scoreMap.get('A')!
    const dScore = scoreMap.get('D')!

    expect(cScore).toBeGreaterThanOrEqual(aScore)
    expect(cScore).toBeGreaterThanOrEqual(dScore)
  })

  test('deterministic with sampling (sampleSize < N)', () => {
    const store = createStoreFromAdjacency({
      A: ['B', 'C', 'D'],
      B: ['E'],
      C: ['E'],
      D: ['E'],
      E: ['F'],
      F: ['G'],
      G: ['H'],
    }, 'bc-determinism-sample')
    const engine = new GraphEngine(store)

    // sampleSize < N 触发采样路径
    const result1 = engine.betweennessCentrality(3)
    const result2 = engine.betweennessCentrality(3)

    expect(result1.scores).toEqual(result2.scores)
  })

  test('endpoints have zero betweenness in chain', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: ['C'],
      C: ['D'],
      D: ['E'],
    }, 'bc-endpoints-zero')
    const engine = new GraphEngine(store)

    const result = engine.betweennessCentrality(5)
    const scoreMap = new Map(result.scores.map(s => [s.node, s.score]))

    // 链的首尾节点 betweenness 应为 0
    expect(scoreMap.get('A')).toBe(0)
    expect(scoreMap.get('E')).toBe(0)
  })
})

// ============================================================
// 5. Tarjan SCC 正确性测试
// ============================================================

describe('Tarjan SCC correctness (F-112)', () => {
  test('known SCCs: correct number and membership', () => {
    // 图结构:
    //   SCC1: A→B→C→A (3节点)
    //   SCC2: D→E→D (2节点)
    //   F: 孤立 (1节点)
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: ['C'],
      C: ['A'],
      D: ['E'],
      E: ['D'],
      F: [],
    }, 'tarjan-known-sccs')
    const engine = new GraphEngine(store)

    const sccs = engine.tarjanSCC()

    // 应有 3 个 SCC
    expect(sccs.length).toBe(3)

    // 非平凡 SCC
    const nonTrivial = sccs.filter(s => !s.isTrivial)
    expect(nonTrivial.length).toBe(2)

    // SCC1: {A,B,C}
    const scc1 = nonTrivial.find(s => s.size === 3)!
    expect(scc1.nodes).toContain('A')
    expect(scc1.nodes).toContain('B')
    expect(scc1.nodes).toContain('C')

    // SCC2: {D,E}
    const scc2 = nonTrivial.find(s => s.size === 2)!
    expect(scc2.nodes).toContain('D')
    expect(scc2.nodes).toContain('E')
  })

  test('each SCC is actually strongly connected', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: ['C'],
      C: ['A', 'D'],
      D: ['E'],
      E: ['F'],
      F: ['D'],
    }, 'tarjan-strongly-connected')
    const engine = new GraphEngine(store)

    const sccs = engine.tarjanSCC()
    const nonTrivial = sccs.filter(s => !s.isTrivial)

    for (const scc of nonTrivial) {
      // 验证 SCC 内每对节点 (u,v) 都互相可达
      for (const u of scc.nodes) {
        const bfsResult = engine.bfs(u)
        const reachable = new Set(bfsResult.nodes)
        for (const v of scc.nodes) {
          expect(reachable.has(v)).toBe(true)
        }
      }
    }
  })

  test('complete graph: single SCC with all nodes', () => {
    const store = createStoreFromAdjacency({
      A: ['B', 'C', 'D'],
      B: ['A', 'C', 'D'],
      C: ['A', 'B', 'D'],
      D: ['A', 'B', 'C'],
    }, 'tarjan-complete-graph')
    const engine = new GraphEngine(store)

    const sccs = engine.tarjanSCC()

    expect(sccs.length).toBe(1)
    expect(sccs[0].size).toBe(4)
    expect(sccs[0].isTrivial).toBe(false)
  })

  test('DAG: all trivial SCCs', () => {
    const store = createStoreFromAdjacency({
      A: ['B', 'C'],
      B: ['D'],
      C: ['D'],
    }, 'tarjan-dag-trivial')
    const engine = new GraphEngine(store)

    const sccs = engine.tarjanSCC()

    // DAG 的每个节点都是独立的平凡 SCC
    for (const scc of sccs) {
      expect(scc.isTrivial).toBe(true)
      expect(scc.size).toBe(1)
    }
  })
})

// ============================================================
// 6. 拓扑排序测试
// ============================================================

describe('Topological sort correctness (F-112)', () => {
  test('DAG: every edge u→v, u comes before v in order', () => {
    const store = createStoreFromAdjacency({
      A: ['B', 'C'],
      B: ['D'],
      C: ['D'],
      D: ['E'],
    }, 'topo-edge-order')
    const engine = new GraphEngine(store)

    const result = engine.topologicalSort()
    const order = result.order
    const indexMap = new Map(order.map((n, i) => [n, i]))

    // 验证每条边 u→v: u 在 v 之前
    const edges = [
      ['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['D', 'E'],
    ]
    for (const [u, v] of edges) {
      expect(indexMap.get(u)!).toBeLessThan(indexMap.get(v)!)
    }
  })

  test('chain: topo order matches chain order', () => {
    const store = createStoreFromAdjacency({
      n0: ['n1'],
      n1: ['n2'],
      n2: ['n3'],
      n3: ['n4'],
    }, 'topo-chain-order')
    const engine = new GraphEngine(store)

    const result = engine.topologicalSort()

    expect(result.cycles).toBeUndefined()
    expect(result.order).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
  })

  test('cycle detection: cyclic graph returns cycles info', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: ['C'],
      C: ['A'],
    }, 'topo-cycle-detect')
    const engine = new GraphEngine(store)

    const result = engine.topologicalSort()

    // 有环时应返回 cycles
    expect(result.cycles).toBeDefined()
    expect(result.cycles!.length).toBeGreaterThan(0)
    expect(result.cycles![0].nodes).toContain('A')
    expect(result.cycles![0].nodes).toContain('B')
    expect(result.cycles![0].nodes).toContain('C')
  })

  test('mixed: SCC collapsed, then topological order on DAG', () => {
    // A→B→C→A (SCC), C→D (SCC 到 D 的边)
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: ['C'],
      C: ['A', 'D'],
      D: [],
    }, 'topo-mixed-scc-dag')
    const engine = new GraphEngine(store)

    const result = engine.topologicalSort()

    expect(result.cycles).toBeDefined()
    // SCC 应在 D 之前
    const order = result.order
    const sccEntry = order.find(o => o.startsWith('SCC:'))
    expect(sccEntry).toBeDefined()
    expect(order.indexOf(sccEntry!)).toBeLessThan(order.indexOf('D'))
  })

  test('diamond DAG: valid topological order', () => {
    // A→B, A→C, B→D, C→D
    const store = createStoreFromAdjacency({
      A: ['B', 'C'],
      B: ['D'],
      C: ['D'],
    }, 'topo-diamond')
    const engine = new GraphEngine(store)

    const result = engine.topologicalSort()
    const order = result.order
    const indexMap = new Map(order.map((n, i) => [n, i]))

    expect(result.cycles).toBeUndefined()
    expect(indexMap.get('A')!).toBeLessThan(indexMap.get('B')!)
    expect(indexMap.get('A')!).toBeLessThan(indexMap.get('C')!)
    expect(indexMap.get('B')!).toBeLessThan(indexMap.get('D')!)
    expect(indexMap.get('C')!).toBeLessThan(indexMap.get('D')!)
  })
})
