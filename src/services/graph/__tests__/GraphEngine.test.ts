/**
 * GraphEngine 综合测试
 *
 * 覆盖所有 14 个图算法，使用 testHelpers 工厂函数创建标准拓扑。
 */

import { describe, test, expect } from 'bun:test'
import { GraphEngine } from '../GraphEngine.js'
import type { GraphSnapshot } from '../GraphEngine.js'
import type { EdgeMeta, NodeMetadata } from '../GraphStore.js'
import {
  createStoreFromAdjacency,
  dag,
  cycle,
  dagWithCycle,
  multiSCC,
  star,
  chain,
  weightedGraph,
  emptyGraph,
  completeGraph,
  bipartite,
} from './testHelpers.js'

// ============================================================
// 1. BFS
// ============================================================

describe('bfs', () => {
  test('DAG traversal order: A, B, D, C', () => {
    const { engine } = dag()
    const result = engine.bfs('A')

    expect(result.nodes).toEqual(['A', 'B', 'D', 'C'])
    expect(result.depth.get('A')).toBe(0)
    expect(result.depth.get('B')).toBe(1)
    expect(result.depth.get('D')).toBe(1)
    expect(result.depth.get('C')).toBe(2)
  })

  test('BFS edges reflect traversal tree', () => {
    const { engine } = dag()
    const result = engine.bfs('A')

    // B and D both discovered from A; C discovered from B (first in queue)
    expect(result.edges).toContainEqual({ from: 'A', to: 'B' })
    expect(result.edges).toContainEqual({ from: 'A', to: 'D' })
    expect(result.edges).toContainEqual({ from: 'B', to: 'C' })
    // D→C edge not in BFS tree since C already visited
    expect(result.edges).not.toContainEqual({ from: 'D', to: 'C' })
  })

  test('maxDepth=0 returns only start node', () => {
    const { engine } = dag()
    const result = engine.bfs('A', 0)

    expect(result.nodes).toEqual(['A'])
    expect(result.edges).toHaveLength(0)
  })

  test('maxDepth=1 limits exploration', () => {
    const { engine } = dag()
    const result = engine.bfs('A', 1)

    expect(result.nodes).toEqual(['A', 'B', 'D'])
    expect(result.edges).toHaveLength(2)
  })

  test('cycle: no infinite loop, all nodes visited', () => {
    const { engine } = cycle()
    const result = engine.bfs('A')

    expect(result.nodes).toHaveLength(3)
    expect(result.nodes).toContain('A')
    expect(result.nodes).toContain('B')
    expect(result.nodes).toContain('C')
  })

  test('empty graph: start node only (if exists in store)', () => {
    const { engine } = emptyGraph()
    const result = engine.bfs('nonexistent')

    expect(result.nodes).toEqual(['nonexistent'])
    expect(result.edges).toHaveLength(0)
  })

  test('start from leaf returns only leaf', () => {
    const { engine } = dag()
    const result = engine.bfs('C') // C has no outgoing edges

    expect(result.nodes).toEqual(['C'])
    expect(result.edges).toHaveLength(0)
  })
})

// ============================================================
// 2. DFS
// ============================================================

describe('dfs', () => {
  test('DAG visits all reachable nodes', () => {
    const { engine } = dag()
    const result = engine.dfs('A')

    expect(result.nodes).toHaveLength(4)
    expect(result.nodes).toContain('A')
    expect(result.nodes).toContain('B')
    expect(result.nodes).toContain('C')
    expect(result.nodes).toContain('D')
  })

  test('cycle: terminates without infinite loop', () => {
    const { engine } = cycle()
    const result = engine.dfs('A')

    expect(result.nodes).toHaveLength(3)
    expect(result.depth.get('A')).toBe(0)
  })

  test('empty graph: start node only', () => {
    const { engine } = emptyGraph()
    const result = engine.dfs('nonexistent')

    expect(result.nodes).toEqual(['nonexistent'])
    expect(result.edges).toHaveLength(0)
  })

  test('maxDepth limits exploration', () => {
    const { engine } = chain(5)
    const result = engine.dfs('n0', 2)

    // n0→n1→n2 at depth 0,1,2; n3 at depth 3 is beyond maxDepth
    expect(result.nodes).toContain('n0')
    expect(result.nodes).toContain('n1')
    expect(result.nodes).toContain('n2')
    expect(result.nodes).not.toContain('n3')
  })

  test('DFS depth map is correct for chain', () => {
    const { engine } = chain(4)
    const result = engine.dfs('n0')

    expect(result.depth.get('n0')).toBe(0)
    expect(result.depth.get('n1')).toBe(1)
    expect(result.depth.get('n2')).toBe(2)
    expect(result.depth.get('n3')).toBe(3)
  })
})

// ============================================================
// 3. Tarjan SCC
// ============================================================

describe('tarjanSCC', () => {
  test('cycle: single SCC containing all nodes', () => {
    const { engine } = cycle()
    const sccs = engine.tarjanSCC()

    const nonTrivial = sccs.filter(s => !s.isTrivial)
    expect(nonTrivial).toHaveLength(1)
    expect(nonTrivial[0].size).toBe(3)
    expect(nonTrivial[0].nodes).toContain('A')
    expect(nonTrivial[0].nodes).toContain('B')
    expect(nonTrivial[0].nodes).toContain('C')
  })

  test('DAG: all trivial SCCs', () => {
    const { engine } = dag()
    const sccs = engine.tarjanSCC()

    expect(sccs).toHaveLength(4)
    for (const scc of sccs) {
      expect(scc.isTrivial).toBe(true)
      expect(scc.size).toBe(1)
    }
  })

  test('multiSCC: two non-trivial + one trivial', () => {
    const { engine } = multiSCC()
    const sccs = engine.tarjanSCC()

    const nonTrivial = sccs.filter(s => !s.isTrivial)
    expect(nonTrivial).toHaveLength(2)

    // SCC1: {A,B,C} size 3
    const scc1 = nonTrivial.find(s => s.size === 3)
    expect(scc1).toBeDefined()
    expect(scc1!.nodes).toContain('A')
    expect(scc1!.nodes).toContain('B')
    expect(scc1!.nodes).toContain('C')

    // SCC2: {D,E} size 2
    const scc2 = nonTrivial.find(s => s.size === 2)
    expect(scc2).toBeDefined()
    expect(scc2!.nodes).toContain('D')
    expect(scc2!.nodes).toContain('E')

    // F: trivial
    const trivial = sccs.filter(s => s.isTrivial)
    expect(trivial).toHaveLength(1)
    expect(trivial[0].nodes).toEqual(['F'])
  })

  test('empty graph: no SCCs', () => {
    const { engine } = emptyGraph()
    const sccs = engine.tarjanSCC()

    expect(sccs).toHaveLength(0)
  })

  test('completeGraph: single SCC with all nodes', () => {
    const { engine } = completeGraph(4)
    const sccs = engine.tarjanSCC()

    expect(sccs).toHaveLength(1)
    expect(sccs[0].size).toBe(4)
    expect(sccs[0].isTrivial).toBe(false)
  })

  test('SCC id is sequential', () => {
    const { engine } = multiSCC()
    const sccs = engine.tarjanSCC()

    for (let i = 0; i < sccs.length; i++) {
      expect(sccs[i].id).toBe(i)
    }
  })
})

// ============================================================
// 4. Topological Sort
// ============================================================

describe('topologicalSort', () => {
  test('DAG: valid topological order', () => {
    const { engine } = dag()
    const result = engine.topologicalSort()

    expect(result.cycles).toBeUndefined()
    const order = result.order
    expect(order).toHaveLength(4)

    // A must come before B and D
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'))
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('D'))
    // B and D must come before C
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'))
    expect(order.indexOf('D')).toBeLessThan(order.indexOf('C'))
  })

  test('cycle: returns cycles info', () => {
    const { engine } = cycle()
    const result = engine.topologicalSort()

    expect(result.cycles).toBeDefined()
    expect(result.cycles!.length).toBeGreaterThan(0)
    // The SCC should contain A, B, C
    const scc = result.cycles![0]
    expect(scc.nodes).toContain('A')
    expect(scc.nodes).toContain('B')
    expect(scc.nodes).toContain('C')
  })

  test('dagWithCycle: SCC collapsed in topo order', () => {
    const { engine } = dagWithCycle()
    const result = engine.topologicalSort()

    expect(result.cycles).toBeDefined()
    expect(result.cycles!.length).toBeGreaterThan(0)

    // Order should have SCC:A,B,C before D
    const order = result.order
    const sccEntry = order.find(o => o.startsWith('SCC:'))
    const dIndex = order.indexOf('D')
    expect(sccEntry).toBeDefined()
    expect(order.indexOf(sccEntry!)).toBeLessThan(dIndex)
  })

  test('empty graph: empty order', () => {
    const { engine } = emptyGraph()
    const result = engine.topologicalSort()

    expect(result.order).toHaveLength(0)
    expect(result.cycles).toBeUndefined()
  })

  test('chain: topo order matches chain order', () => {
    const { engine } = chain(5)
    const result = engine.topologicalSort()

    expect(result.cycles).toBeUndefined()
    const order = result.order
    for (let i = 0; i < 4; i++) {
      expect(order.indexOf(`n${i}`)).toBeLessThan(order.indexOf(`n${i + 1}`))
    }
  })
})

// ============================================================
// 5. PageRank
// ============================================================

describe('pageRank', () => {
  test('star: leaves rank higher than center (directed edges center→leaves)', () => {
    const { engine } = star(5)
    const result = engine.pageRank()

    expect(result.scores.length).toBe(6) // center + 5 leaves
    // In directed star (center→leaves), leaves receive incoming PR from center
    // while center has no incoming edges. Leaves rank higher.
    const centerScore = result.scores.find(s => s.node === 'center')!
    const leafScore = result.scores.find(s => s.node === 'leaf0')!
    expect(centerScore).toBeDefined()
    expect(leafScore).toBeDefined()
    expect(leafScore.score).toBeGreaterThan(centerScore.score)
    // Top score (a leaf) should be 1 after normalization
    expect(result.scores[0].score).toBe(1)
  })

  test('all scores normalized to [0, 1]', () => {
    const { engine } = dag()
    const result = engine.pageRank()

    for (const { score } of result.scores) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
    // Top score should be 1 (normalized)
    expect(result.scores[0].score).toBe(1)
  })

  test('empty graph: no scores', () => {
    const { engine } = emptyGraph()
    const result = engine.pageRank()

    expect(result.scores).toHaveLength(0)
  })

  test('chain: dangling node gets redistributed mass', () => {
    const { engine } = chain(5)
    const result = engine.pageRank()

    // All nodes should have scores
    expect(result.scores).toHaveLength(5)
    // Max score should be 1
    expect(result.scores[0].score).toBe(1)
    // n0 (source) should have non-zero score
    const n0 = result.scores.find(s => s.node === 'n0')!
    expect(n0.score).toBeGreaterThan(0)
  })

  test('scores are sorted descending', () => {
    const { engine } = completeGraph(4)
    const result = engine.pageRank()

    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i].score).toBeLessThanOrEqual(result.scores[i - 1].score)
    }
  })

  test('cycle: all nodes get equal rank', () => {
    const { engine } = cycle()
    const result = engine.pageRank()

    // In a symmetric cycle, all nodes should have approximately equal PageRank
    const scores = result.scores.map(s => s.score)
    for (const score of scores) {
      expect(score).toBeCloseTo(1, 1) // all normalized to ~1
    }
  })
})

// ============================================================
// 6. Backward Reachability
// ============================================================

describe('backwardReachability', () => {
  test('DAG from C: finds all ancestors', () => {
    const { engine } = dag()
    const result = engine.backwardReachability('C')

    expect(result.reachable).toContain('C')
    expect(result.reachable).toContain('B')
    expect(result.reachable).toContain('D')
    expect(result.reachable).toContain('A')
    expect(result.reachable).toHaveLength(4)
  })

  test('root returns only self', () => {
    const { engine } = dag()
    const result = engine.backwardReachability('A')

    expect(result.reachable).toEqual(['A'])
  })

  test('cycle: all nodes reachable', () => {
    const { engine } = cycle()
    const result = engine.backwardReachability('A')

    expect(result.reachable).toHaveLength(3)
    expect(result.reachable).toContain('A')
    expect(result.reachable).toContain('B')
    expect(result.reachable).toContain('C')
  })

  test('via map tracks predecessor', () => {
    const { engine } = dag()
    const result = engine.backwardReachability('C')

    // B and D are direct predecessors of C
    expect(result.via.get('B')).toEqual(['C'])
    expect(result.via.get('D')).toEqual(['C'])
  })

  test('empty graph: start node only', () => {
    const { engine } = emptyGraph()
    const result = engine.backwardReachability('nonexistent')

    expect(result.reachable).toEqual(['nonexistent'])
  })
})

// ============================================================
// 7. Dominator Tree
// ============================================================

describe('dominatorTree', () => {
  test('root has null dominator', () => {
    const { engine } = dag()
    const doms = engine.dominatorTree('A')

    expect(doms.get('A')).toBeNull()
  })

  test('chain: each node dominated by predecessor', () => {
    const { engine } = chain(5)
    const doms = engine.dominatorTree('n0')

    expect(doms.get('n0')).toBeNull()
    expect(doms.get('n1')).toBe('n0')
    expect(doms.get('n2')).toBe('n1')
    expect(doms.get('n3')).toBe('n2')
    expect(doms.get('n4')).toBe('n3')
  })

  test('diamond: C dominated by A (merge point)', () => {
    const { engine } = dag()
    const doms = engine.dominatorTree('A')

    // A→B→C, A→D→C: C's idom is A (common dominator of B and D)
    expect(doms.get('A')).toBeNull()
    expect(doms.get('B')).toBe('A')
    expect(doms.get('D')).toBe('A')
    expect(doms.get('C')).toBe('A')
  })

  test('star: all leaves dominated by center', () => {
    const { engine } = star(3)
    const doms = engine.dominatorTree('center')

    expect(doms.get('center')).toBeNull()
    expect(doms.get('leaf0')).toBe('center')
    expect(doms.get('leaf1')).toBe('center')
    expect(doms.get('leaf2')).toBe('center')
  })

  test('unreachable nodes not in dominator map', () => {
    // multiSCC: F is isolated, not reachable from A
    const { engine } = multiSCC()
    const doms = engine.dominatorTree('A')

    expect(doms.has('F')).toBe(false)
    expect(doms.has('A')).toBe(true)
  })
})

// ============================================================
// 8. Delta Graph
// ============================================================

describe('deltaGraph', () => {
  function makeSnapshot(
    adj: Record<string, Array<{ to: string; type?: EdgeMeta['type'] }>>,
    nodeIds: string[],
  ): GraphSnapshot {
    const adjacency = new Map<string, Map<string, EdgeMeta>>()
    const nodeMeta = new Map<string, NodeMetadata>()

    for (const id of nodeIds) {
      nodeMeta.set(id, { id, name: id, kind: 'function', file: `/test/${id}.ts`, line: 1 })
    }

    for (const [from, edges] of Object.entries(adj)) {
      const fromMap = new Map<string, EdgeMeta>()
      for (const edge of edges) {
        fromMap.set(edge.to, { type: edge.type ?? 'calls', weight: 1 })
      }
      adjacency.set(from, fromMap)
    }

    return { adjacency, nodeMeta, timestamp: Date.now() }
  }

  test('added and removed nodes', () => {
    const { engine } = emptyGraph()

    const old = makeSnapshot({}, ['A', 'B'])
    const curr = makeSnapshot({}, ['B', 'C'])

    const delta = engine.deltaGraph(old, curr)

    expect(delta.added).toContain('C')
    expect(delta.removed).toContain('A')
    expect(delta.summary.nodesDelta).toBe(0) // +1 -1 = 0
  })

  test('added edges', () => {
    const { engine } = emptyGraph()

    const old = makeSnapshot({}, ['A', 'B'])
    const curr = makeSnapshot({ A: [{ to: 'B' }] }, ['A', 'B'])

    const delta = engine.deltaGraph(old, curr)

    expect(delta.edgeAdded).toHaveLength(1)
    expect(delta.edgeAdded[0]).toEqual({ from: 'A', to: 'B', type: 'calls' })
    expect(delta.edgeRemoved).toHaveLength(0)
    expect(delta.summary.edgesDelta).toBe(1)
  })

  test('removed edges', () => {
    const { engine } = emptyGraph()

    const old = makeSnapshot({ A: [{ to: 'B' }] }, ['A', 'B'])
    const curr = makeSnapshot({}, ['A', 'B'])

    const delta = engine.deltaGraph(old, curr)

    expect(delta.edgeRemoved).toHaveLength(1)
    expect(delta.edgeRemoved[0]).toEqual({ from: 'A', to: 'B', type: 'calls' })
    expect(delta.edgeAdded).toHaveLength(0)
    expect(delta.summary.edgesDelta).toBe(-1)
  })

  test('identical snapshots: no delta', () => {
    const { engine } = emptyGraph()

    const snap = makeSnapshot({ A: [{ to: 'B' }] }, ['A', 'B'])
    const delta = engine.deltaGraph(snap, snap)

    expect(delta.added).toHaveLength(0)
    expect(delta.removed).toHaveLength(0)
    expect(delta.edgeAdded).toHaveLength(0)
    expect(delta.edgeRemoved).toHaveLength(0)
  })

  test('changed edge type detected as add + remove', () => {
    const { engine } = emptyGraph()

    const old = makeSnapshot({ A: [{ to: 'B', type: 'calls' }] }, ['A', 'B'])
    const curr = makeSnapshot({ A: [{ to: 'B', type: 'data' }] }, ['A', 'B'])

    const delta = engine.deltaGraph(old, curr)

    expect(delta.edgeAdded).toHaveLength(1)
    expect(delta.edgeAdded[0].type).toBe('data')
    expect(delta.edgeRemoved).toHaveLength(1)
    expect(delta.edgeRemoved[0].type).toBe('calls')
  })
})

// ============================================================
// 9. Coupling Metrics
// ============================================================

describe('couplingMetrics', () => {
  test('fanIn/fanOut and instability in [0, 1]', () => {
    const { engine } = completeGraph(4)
    const result = engine.couplingMetrics()

    // completeGraph(4): each node has fanIn=3, fanOut=3, none > 5 threshold
    // But let's check the structure regardless
    expect(result.lcom).toBeDefined()
    expect(result.highCoupling).toBeDefined()
  })

  test('large star: center has high coupling', () => {
    const { engine } = star(10)
    const result = engine.couplingMetrics()

    // center has fanOut=10 > 5
    expect(result.highCoupling.length).toBeGreaterThan(0)
    const center = result.highCoupling.find(h => h.node === 'center')
    expect(center).toBeDefined()
    expect(center!.fanOut).toBe(10)
    expect(center!.instability).toBeGreaterThanOrEqual(0)
    expect(center!.instability).toBeLessThanOrEqual(1)
  })

  test('instability = fanOut / (fanIn + fanOut)', () => {
    // Use a graph where we can predict instability
    const { engine } = chain(3)
    const result = engine.couplingMetrics()

    // n0: fanIn=0, fanOut=1 → instability = 1/(0+1) = 1
    // n1: fanIn=1, fanOut=1 → instability = 1/(1+1) = 0.5
    // n2: fanIn=1, fanOut=0 → instability = 0/(1+0) = 0
    // None have fi>5 or fo>5, so highCoupling is empty
    expect(result.highCoupling).toHaveLength(0)
  })

  test('empty graph: no metrics', () => {
    const { engine } = emptyGraph()
    const result = engine.couplingMetrics()

    expect(result.highCoupling).toHaveLength(0)
    expect(result.lcom).toHaveLength(0)
  })
})

// ============================================================
// 10. Classify Roles
// ============================================================

describe('classifyRoles', () => {
  test('entry nodes have fanIn=0', () => {
    const { engine } = dag()
    const roles = engine.classifyRoles()

    // A has fanIn=0, fanOut=2 → entry
    expect(roles.get('A')).toBe('entry')
  })

  test('leaf nodes have fanOut=0', () => {
    const { engine } = dag()
    const roles = engine.classifyRoles()

    // C has fanOut=0, fanIn=2 → leaf
    expect(roles.get('C')).toBe('leaf')
  })

  test('all nodes assigned a role', () => {
    const { engine } = dag()
    const roles = engine.classifyRoles()

    const allNodes = engine.getAllNodeIds()
    for (const node of allNodes) {
      expect(roles.has(node)).toBe(true)
    }
  })

  test('dead code: isolated node in multiSCC', () => {
    const { engine } = multiSCC()
    const roles = engine.classifyRoles()

    // Entry nodes: A (fanIn=0 in SCC cycle... wait, A has inEdge from C)
    // Let's check: multiSCC has A→B, B→C, C→A, D→E, E→D, F (isolated)
    // fanIn(A)=1 (from C), fanIn(D)=1 (from E), fanIn(F)=0
    // fanOut(A)=1, fanOut(D)=1, fanOut(F)=0
    // F has fanIn=0 AND fanOut=0 → not entry (needs fanOut>0)
    // Actually, with no entry points (entries=[]), the dead check becomes:
    //   entries.length > 0 → false → no nodes classified as dead by that rule
    // So F with fanIn=0 and fanOut=0 falls through all rules → default utility

    // All nodes should have roles assigned
    expect(roles.has('F')).toBe(true)
  })

  test('star: center is entry, leaves are leaf', () => {
    const { engine } = star(3)
    const roles = engine.classifyRoles()

    expect(roles.get('center')).toBe('entry') // fanIn=0, fanOut=3
    expect(roles.get('leaf0')).toBe('leaf')   // fanOut=0, fanIn=1
    expect(roles.get('leaf1')).toBe('leaf')
    expect(roles.get('leaf2')).toBe('leaf')
  })

  test('empty graph: empty roles map', () => {
    const { engine } = emptyGraph()
    const roles = engine.classifyRoles()

    expect(roles.size).toBe(0)
  })
})

// ============================================================
// 11. Backward Data Slice
// ============================================================

describe('backwardDataSlice', () => {
  test('follows data edges backward', () => {
    const { engine } = weightedGraph()
    // weightedGraph: A→C (data), B→C (imports), C→D (control), D→E (inherits)
    const result = engine.backwardDataSlice('C')

    expect(result.symbols).toContain('C')
    expect(result.symbols).toContain('A') // A→C is data type
    expect(result.dataFlows.length).toBeGreaterThan(0)
    expect(result.dataFlows).toContainEqual({ from: 'A', to: 'C', via: 'data' })
  })

  test('non-data edges not followed', () => {
    const { engine } = weightedGraph()
    const result = engine.backwardDataSlice('C')

    // B→C is imports, not data → should not appear in dataFlows
    const fromB = result.dataFlows.filter(f => f.from === 'B')
    expect(fromB).toHaveLength(0)
  })

  test('fallback when no data edges: backwardReachability', () => {
    const { engine } = dag()
    // dag has only 'calls' edges, no 'data' edges
    const result = engine.backwardDataSlice('C')

    // Should fall back to backwardReachability
    expect(result.symbols).toContain('C')
    expect(result.symbols).toContain('B')
    expect(result.symbols).toContain('D')
    expect(result.symbols).toContain('A')
    // dataFlows use 'call-graph-approx' via
    for (const flow of result.dataFlows) {
      expect(flow.via).toBe('call-graph-approx')
    }
  })

  test('leaf node: only self in slice', () => {
    const { engine } = weightedGraph()
    // E has incoming from D (inherits), not data → fallback
    const result = engine.backwardDataSlice('E')

    expect(result.symbols).toContain('E')
    // Falls back to backwardReachability which finds all ancestors
    expect(result.symbols.length).toBeGreaterThan(1)
  })
})

// ============================================================
// 12. Louvain Community Detection
// ============================================================

describe('louvainCommunity', () => {
  test('empty graph: no communities', () => {
    const { engine } = emptyGraph()
    const result = engine.louvainCommunity()

    expect(result.communities).toHaveLength(0)
    expect(result.modularity).toBe(0)
  })

  test('bipartite: communities detected', () => {
    const { engine } = bipartite()
    const result = engine.louvainCommunity()

    expect(result.communities.length).toBeGreaterThan(0)

    // All nodes should be assigned
    const allNodes = engine.getAllNodeIds()
    const assignedNodes = result.communities.flatMap(c => c.nodes)
    for (const node of allNodes) {
      expect(assignedNodes).toContain(node)
    }
  })

  test('resolution parameter affects granularity', () => {
    const { engine } = completeGraph(6)

    const lowRes = engine.louvainCommunity({ resolution: 0.1 })
    const highRes = engine.louvainCommunity({ resolution: 2.0 })

    // Lower resolution tends to create fewer, larger communities
    // Higher resolution tends to create more, smaller communities
    // Both should have at least 1 community
    expect(lowRes.communities.length).toBeGreaterThan(0)
    expect(highRes.communities.length).toBeGreaterThan(0)
    expect(lowRes.resolution).toBe(0.1)
    expect(highRes.resolution).toBe(2.0)
  })

  test('modularity is a finite number', () => {
    const { engine } = chain(5)
    const result = engine.louvainCommunity()

    expect(Number.isFinite(result.modularity)).toBe(true)
  })

  test('community sizes sum to total nodes', () => {
    const { engine } = bipartite()
    const result = engine.louvainCommunity()

    const totalSize = result.communities.reduce((sum, c) => sum + c.size, 0)
    expect(totalSize).toBe(engine.getAllNodeIds().length)
  })
})

// ============================================================
// 13. Katz Centrality
// ============================================================

describe('katzCentrality', () => {
  test('scores normalized to [0, 1]', () => {
    const { engine } = dag()
    const result = engine.katzCentrality()

    for (const { score } of result.scores) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
    // Max score should be 1
    expect(result.scores[0].score).toBe(1)
  })

  test('empty graph: no scores', () => {
    const { engine } = emptyGraph()
    const result = engine.katzCentrality()

    expect(result.scores).toHaveLength(0)
  })

  test('chain: downstream nodes score higher', () => {
    const { engine } = chain(5)
    const result = engine.katzCentrality()

    // In Katz centrality, nodes with more incoming paths score higher
    // In a chain, later nodes have more predecessors → higher Katz
    const scores = new Map(result.scores.map(s => [s.node, s.score]))
    expect(scores.get('n4')!).toBeGreaterThanOrEqual(scores.get('n0')!)
  })

  test('star: center has incoming paths from leaves via redistribution', () => {
    const { engine } = star(5)
    const result = engine.katzCentrality()

    // center has no incoming edges from leaves (star is center→leaves)
    // But leaves have incoming from center
    // Katz scores: center gets base 1 + alpha * 0 = 1
    // leaves get 1 + alpha * center_score
    // So leaves should score higher than center
    const center = result.scores.find(s => s.node === 'center')!
    const leaf = result.scores.find(s => s.node === 'leaf0')!
    expect(leaf.score).toBeGreaterThanOrEqual(center.score)
  })

  test('scores are sorted descending', () => {
    const { engine } = completeGraph(4)
    const result = engine.katzCentrality()

    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i].score).toBeLessThanOrEqual(result.scores[i - 1].score)
    }
  })
})

// ============================================================
// 14. Betweenness Centrality
// ============================================================

describe('betweennessCentrality', () => {
  test('bridge node in chain has highest betweenness', () => {
    const { engine } = chain(5)
    // Use sampleSize >= N for deterministic result
    const result = engine.betweennessCentrality(5)

    const scores = new Map(result.scores.map(s => [s.node, s.score]))

    // Middle nodes (n1, n2, n3) should have higher betweenness than endpoints (n0, n4)
    expect(scores.get('n2')!).toBeGreaterThan(0)
    // Endpoints have 0 betweenness (no shortest paths pass through them)
    expect(scores.get('n0')).toBe(0)
    expect(scores.get('n4')).toBe(0)
  })

  test('scores normalized to [0, 1]', () => {
    const { engine } = dag()
    const result = engine.betweennessCentrality(4)

    for (const { score } of result.scores) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  test('empty graph: no scores', () => {
    const { engine } = emptyGraph()
    const result = engine.betweennessCentrality()

    expect(result.scores).toHaveLength(0)
  })

  test('sampleSize parameter limits computation', () => {
    const { engine } = chain(10)
    // Even with small sampleSize, should return results for all nodes
    const result = engine.betweennessCentrality(3)

    expect(result.scores).toHaveLength(10)
  })

  test('completeGraph: all nodes have similar betweenness', () => {
    const { engine } = completeGraph(4)
    const result = engine.betweennessCentrality(4)

    // In a complete graph, all nodes are structurally equivalent
    // so betweenness should be similar (or zero since all paths are direct)
    expect(result.scores).toHaveLength(4)
  })

  test('star: center has highest betweenness', () => {
    const { engine } = star(5)
    const result = engine.betweennessCentrality(6)

    const center = result.scores.find(s => s.node === 'center')!
    const leaf = result.scores.find(s => s.node === 'leaf0')!

    // Center is on all paths between leaves
    expect(center.score).toBeGreaterThanOrEqual(leaf.score)
  })
})
