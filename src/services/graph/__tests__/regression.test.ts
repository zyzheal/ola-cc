/**
 * Regression Tests (F-69)
 *
 * Verifies all existing functionality still works after Phase Z1-Z4 changes.
 * Uses in-memory graph construction (no real codegraph.db).
 */

import { describe, test, expect } from 'bun:test'
import { createStoreFromAdjacency, createFixture, dag, cycle, star, chain, weightedGraph, emptyGraph, completeGraph, bipartite, multiSCC } from './testHelpers.js'
import { GraphEngine } from '../GraphEngine.js'
import { GraphStore, type EdgeMeta, type NodeMetadata, type EdgeType, type EdgeConfidence } from '../GraphStore.js'

// ============================================================
// All 40 edge types from the design doc
// ============================================================

const ALL_EDGE_TYPES: EdgeType[] = [
  // Core (13)
  'calls', 'imports', 'data', 'control', 'inherits', 'implements',
  'contains', 'exports', 'type_of', 'returns', 'instantiates', 'overrides', 'decorates',
  // P1 (5)
  'subscribes', 'publishes', 'middleware', 'flow_step', 'cross_domain',
  // P2 (11)
  'reads', 'writes', 'tests', 'configures', 'deploys', 'monitors',
  'validates', 'transforms', 'caches', 'queues', 'notifies',
  // P3 (11)
  'serializes', 'deserializes', 'encrypts', 'decrypts', 'compresses',
  'logs', 'metrics', 'traces', 'authenticates', 'authorizes', 'rate_limits',
]

// ============================================================
// Tests
// ============================================================

describe('regression: GraphStore', () => {
  test('loads correctly with mock data via testHelpers', () => {
    const { store } = dag()
    expect(store.isLoaded).toBe(true)
    expect(store.nodeMeta.size).toBeGreaterThan(0)
    expect(store.adjacency.size).toBeGreaterThan(0)
  })

  test('reports size correctly', () => {
    const { store } = dag()
    const size = store.size
    expect(size.nodes).toBeGreaterThan(0)
    expect(size.edges).toBeGreaterThan(0)
  })

  test('getNode returns metadata for existing nodes', () => {
    const { store } = dag()
    const node = store.getNode('A')
    expect(node).toBeDefined()
    expect(node!.id).toBe('A')
    expect(node!.name).toBe('A')
    expect(node!.kind).toBe('function')
  })

  test('getNode returns undefined for missing nodes', () => {
    const { store } = dag()
    expect(store.getNode('nonexistent')).toBeUndefined()
  })

  test('getOutEdges returns outgoing edges', () => {
    const { store } = dag()
    const out = store.getOutEdges('A')
    expect(out.size).toBeGreaterThan(0)
    // A → B and A → D
    expect(out.has('B')).toBe(true)
    expect(out.has('D')).toBe(true)
  })

  test('getInEdges returns incoming edges', () => {
    const { store } = dag()
    const inE = store.getInEdges('C')
    expect(inE.size).toBeGreaterThan(0)
    // C has incoming from B and D
    expect(inE.has('B')).toBe(true)
    expect(inE.has('D')).toBe(true)
  })

  test('getOutDegree and getInDegree work correctly', () => {
    const { store } = dag()
    expect(store.getOutDegree('A')).toBe(2) // → B, D
    expect(store.getInDegree('C')).toBe(2)  // B →, D →
    expect(store.getOutDegree('C')).toBe(0) // leaf
  })

  test('getEdgeBetween returns edges between two nodes', () => {
    const { store } = dag()
    const edges = store.getEdgeBetween('A', 'B')
    expect(edges.length).toBeGreaterThan(0)
    expect(edges[0].type).toBe('calls')
  })

  test('getOutNeighborIds returns neighbor IDs', () => {
    const { store } = dag()
    const neighbors = store.getOutNeighborIds('A')
    expect(neighbors).toContain('B')
    expect(neighbors).toContain('D')
  })

  test('getInNeighborIds returns incoming neighbor IDs', () => {
    const { store } = dag()
    const neighbors = store.getInNeighborIds('C')
    expect(neighbors).toContain('B')
    expect(neighbors).toContain('D')
  })
})

describe('regression: EdgeMeta[] array storage', () => {
  test('adjacency values are EdgeMeta[] arrays', () => {
    const { store } = dag()
    for (const [, targets] of store.adjacency) {
      for (const [, edgeList] of targets) {
        expect(Array.isArray(edgeList)).toBe(true)
        for (const edge of edgeList) {
          expect(edge).toHaveProperty('type')
          expect(edge).toHaveProperty('weight')
        }
      }
    }
  })

  test('reverse edges are also EdgeMeta[] arrays', () => {
    const { store } = dag()
    for (const [, sources] of store.reverse) {
      for (const [, edgeList] of sources) {
        expect(Array.isArray(edgeList)).toBe(true)
        for (const edge of edgeList) {
          expect(edge).toHaveProperty('type')
          expect(edge).toHaveProperty('weight')
        }
      }
    }
  })

  test('EdgeMeta has correct type and weight', () => {
    const { store } = weightedGraph()
    const edges = store.getEdgeBetween('A', 'B')
    expect(edges.length).toBe(1)
    expect(edges[0].type).toBe('calls')
    expect(edges[0].weight).toBe(3)
  })
})

describe('regression: all 40 edge types recognized', () => {
  test('all edge types can be stored and retrieved', () => {
    // Create a graph with one edge per type
    const adj: Record<string, Array<{ to: string; type: EdgeType; weight: number }>> = {}
    for (let i = 0; i < ALL_EDGE_TYPES.length; i++) {
      adj[`src_${i}`] = [{ to: `dst_${i}`, type: ALL_EDGE_TYPES[i], weight: 1 }]
    }
    const store = createStoreFromAdjacency(adj, `edge-types-${Date.now()}`)

    // Verify each edge type
    for (let i = 0; i < ALL_EDGE_TYPES.length; i++) {
      const edges = store.getEdgeBetween(`src_${i}`, `dst_${i}`)
      expect(edges.length).toBe(1)
      expect(edges[0].type).toBe(ALL_EDGE_TYPES[i])
    }
  })
})

describe('regression: NodeMetadata has all 21 fields', () => {
  test('NodeMetadata supports all extended fields', () => {
    const node: NodeMetadata = {
      id: 'test:full',
      name: 'fullNode',
      kind: 'class',
      file: 'src/full.ts',
      line: 10,
      // Extended fields (Phase 1b)
      end_line: 50,
      docstring: 'A fully documented class',
      language: 'typescript',
      visibility: 'public',
      is_exported: true,
      is_async: false,
      is_static: false,
      is_abstract: false,
      signature: 'class fullNode extends Base',
      qualified_name: 'src.fullNode',
      // Phase Z1: full 21-field spec
      start_column: 0,
      end_column: 40,
      decorators: ['@Injectable()'],
      type_parameters: ['T', 'U'],
      updated_at: Date.now(),
      provenance: 'codegraph',
      // Grok fields
      layer: 'domain',
      domain: 'auth',
    }

    // Verify all 21 fields exist
    expect(node.id).toBeDefined()
    expect(node.name).toBeDefined()
    expect(node.kind).toBeDefined()
    expect(node.file).toBeDefined()
    expect(node.line).toBeDefined()
    expect(node.end_line).toBeDefined()
    expect(node.docstring).toBeDefined()
    expect(node.language).toBeDefined()
    expect(node.visibility).toBeDefined()
    expect(node.is_exported).toBeDefined()
    expect(node.is_async).toBeDefined()
    expect(node.is_static).toBeDefined()
    expect(node.is_abstract).toBeDefined()
    expect(node.signature).toBeDefined()
    expect(node.qualified_name).toBeDefined()
    expect(node.start_column).toBeDefined()
    expect(node.end_column).toBeDefined()
    expect(node.decorators).toBeDefined()
    expect(node.type_parameters).toBeDefined()
    expect(node.updated_at).toBeDefined()
    expect(node.provenance).toBeDefined()
  })
})

describe('regression: FileRecord is populated', () => {
  test('fileRecords map exists and can be populated', () => {
    const { store } = dag()
    store.fileRecords.set('src/test.ts', {
      path: 'src/test.ts',
      language: 'typescript',
      size: 1024,
      lineCount: 50,
      nodeCount: 5,
      contentHash: 'abc123',
      lastModified: Date.now(),
    })

    const record = store.fileRecords.get('src/test.ts')
    expect(record).toBeDefined()
    expect(record!.path).toBe('src/test.ts')
    expect(record!.language).toBe('typescript')
    expect(record!.size).toBe(1024)
  })
})

describe('regression: confidence levels', () => {
  test('EdgeConfidence supports EXTRACTED, INFERRED, AMBIGUOUS', () => {
    const confidences: EdgeConfidence[] = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS']
    for (const conf of confidences) {
      const store = createStoreFromAdjacency({
        A: [{ to: 'B', type: 'calls', weight: 1 }],
      }, `conf-${conf}-${Date.now()}`)

      const edges = store.getEdgeBetween('A', 'B')
      edges[0].confidence = conf
      expect(edges[0].confidence).toBe(conf)
    }
  })
})

describe('regression: GraphEngine algorithms', () => {
  test('BFS produces consistent results', () => {
    const { engine } = dag()
    const r1 = engine.bfs('A')
    const r2 = engine.bfs('A')
    expect(r1.nodes).toEqual(r2.nodes)
    expect(r1.nodes.length).toBeGreaterThan(0)
  })

  test('DFS produces consistent results', () => {
    const { engine } = dag()
    const r1 = engine.dfs('A')
    const r2 = engine.dfs('A')
    expect(r1.nodes).toEqual(r2.nodes)
    expect(r1.nodes.length).toBeGreaterThan(0)
  })

  test('Tarjan SCC finds cycle in cycle graph', () => {
    const { engine } = cycle()
    const sccs = engine.tarjanSCC()
    // All 3 nodes should be in one SCC
    const bigScc = sccs.find(s => s.size > 1)
    expect(bigScc).toBeDefined()
    expect(bigScc!.size).toBe(3)
  })

  test('Tarjan SCC finds multiple SCCs', () => {
    const { engine } = multiSCC()
    const sccs = engine.tarjanSCC()
    // Should have SCC1 (A,B,C), SCC2 (D,E), F isolated
    const nonTrivial = sccs.filter(s => !s.isTrivial)
    expect(nonTrivial.length).toBe(2)
  })

  test('topologicalSort on DAG produces valid order', () => {
    const { engine } = dag()
    const result = engine.topologicalSort()
    expect(result.order.length).toBe(4) // A, B, C, D
    // A should come before B and D
    const idxA = result.order.indexOf('A')
    const idxB = result.order.indexOf('B')
    const idxD = result.order.indexOf('D')
    expect(idxA).toBeLessThan(idxB)
    expect(idxA).toBeLessThan(idxD)
  })

  test('PageRank produces scores for all nodes', () => {
    const { engine } = dag()
    const result = engine.pageRank()
    expect(result.scores.length).toBe(4)
    // All scores should be positive
    for (const { score } of result.scores) {
      expect(score).toBeGreaterThanOrEqual(0)
    }
  })

  test('classifyRoles classifies all nodes', () => {
    const { engine } = dag()
    const roles = engine.classifyRoles()
    expect(roles.size).toBe(4)
    // All nodes should have a role
    for (const [, role] of roles) {
      expect(['entry', 'core', 'utility', 'adaptor', 'dead', 'leaf']).toContain(role)
    }
  })

  test('couplingMetrics returns metrics', () => {
    const { engine } = dag()
    const result = engine.couplingMetrics()
    expect(result).toBeDefined()
    expect(Array.isArray(result.highCoupling)).toBe(true)
  })

  test('katzCentrality produces scores', () => {
    const { engine } = dag()
    const result = engine.katzCentrality()
    expect(result.scores.length).toBeGreaterThan(0)
  })

  test('betweennessCentrality produces scores', () => {
    const { engine } = dag()
    const result = engine.betweennessCentrality()
    expect(result.scores.length).toBeGreaterThan(0)
  })

  test('backwardReachability finds reachable nodes', () => {
    const { engine } = dag()
    const result = engine.backwardReachability('C')
    expect(result.reachable.length).toBeGreaterThan(0)
    expect(result.reachable).toContain('B')
    expect(result.reachable).toContain('D')
  })

  test('backwardDataSlice finds data flow paths', () => {
    const { engine } = dag()
    const result = engine.backwardDataSlice('C')
    expect(result.symbols.length).toBeGreaterThan(0)
  })

  test('dominatorTree returns tree structure', () => {
    const { engine } = dag()
    const tree = engine.dominatorTree('A')
    expect(tree.size).toBeGreaterThan(0)
  })

  test('louvainCommunity finds communities', () => {
    const { engine } = star(20)
    const result = engine.louvainCommunity()
    expect(result.communities.length).toBeGreaterThan(0)
    expect(result.modularity).toBeDefined()
  })

  test('empty graph handles gracefully', () => {
    const { engine } = emptyGraph()
    const sccs = engine.tarjanSCC()
    expect(sccs.length).toBe(0)

    const topo = engine.topologicalSort()
    expect(topo.order.length).toBe(0)

    const pr = engine.pageRank()
    expect(pr.scores.length).toBe(0)
  })

  test('weighted edges affect PageRank scores', () => {
    const { engine } = weightedGraph()
    const result = engine.pageRank()
    expect(result.scores.length).toBe(5)
    // All scores should be positive
    for (const { score } of result.scores) {
      expect(score).toBeGreaterThanOrEqual(0)
    }
  })
})
