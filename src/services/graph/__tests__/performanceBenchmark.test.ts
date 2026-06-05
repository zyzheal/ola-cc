/**
 * Performance Benchmark Tests (F-59)
 *
 * Uses synthetic graphs (no real codegraph.db) to verify algorithm
 * performance targets from the design doc:
 * - PageRank on 1000 nodes: < 1s
 * - Tarjan SCC on 1000 nodes: < 100ms
 * - Louvain on 1000 nodes: < 5s
 * - BFS/DFS on 1000 nodes: < 10ms
 * - FTS5 search: < 5ms
 * - RRF fusion search: < 20ms
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createStoreFromAdjacency, type GraphFixture } from './testHelpers.js'
import { GraphEngine } from '../GraphEngine.js'
import { FtsSearch } from '../FtsSearch.js'
import { RrfSearch } from '../RrfSearch.js'
import type { GraphStore, NodeMetadata } from '../GraphStore.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'

// ============================================================
// Synthetic graph generators
// ============================================================

/**
 * Generate a DAG with N nodes arranged in a chain with cross-edges.
 * Each node has ~2-3 outgoing edges for realistic connectivity.
 */
function generateDag(n: number): Record<string, Array<{ to: string; type?: string; weight?: number }>> {
  const adj: Record<string, Array<{ to: string; type?: string; weight?: number }>> = {}

  for (let i = 0; i < n; i++) {
    const id = `n${i}`
    const edges: Array<{ to: string; type?: string; weight?: number }> = []

    // Chain edge: i → i+1
    if (i < n - 1) {
      edges.push({ to: `n${i + 1}`, type: 'calls', weight: 1 })
    }
    // Cross edge: i → min(i + 10, n-1)
    if (i + 10 < n) {
      edges.push({ to: `n${i + 10}`, type: 'imports', weight: 1 })
    }
    // Some random edges for connectivity
    if (i + 50 < n && i % 3 === 0) {
      edges.push({ to: `n${i + 50}`, type: 'data', weight: 1 })
    }

    adj[id] = edges
  }

  return adj
}

/**
 * Generate rich node metadata for FTS indexing.
 */
function enrichStoreWithMeta(store: GraphStore, n: number): void {
  const kinds = ['function', 'class', 'method', 'interface', 'type', 'variable']
  for (let i = 0; i < n; i++) {
    const id = `n${i}`
    const meta = store.nodeMeta.get(id)
    if (meta) {
      meta.kind = kinds[i % kinds.length]
      meta.name = `node_${i}`
      meta.file = `src/module${Math.floor(i / 50)}.ts`
      meta.line = (i % 50) * 10 + 1
      meta.signature = `function node_${i}(arg: string): void`
      meta.qualified_name = `module${Math.floor(i / 50)}.node_${i}`
      meta.docstring = `Documentation for node ${i} in module ${Math.floor(i / 50)}`
    }
  }
}

// ============================================================
// Tests
// ============================================================

describe('performance benchmarks (synthetic 1000 nodes)', () => {
  const N = 1000
  let fixture: GraphFixture

  beforeAll(() => {
    const adj = generateDag(N)
    fixture = { store: createStoreFromAdjacency(adj, `perf-${Date.now()}`), engine: null as any }
    enrichStoreWithMeta(fixture.store, N)
    fixture.engine = new GraphEngine(fixture.store)
  })

  test(`PageRank on ${N} nodes < 1s`, () => {
    const start = performance.now()
    const result = fixture.engine.pageRank()
    const elapsed = performance.now() - start

    console.log(`PageRank (${N} nodes): ${elapsed.toFixed(1)}ms, ${result.scores.length} nodes scored`)
    expect(result.scores.length).toBe(N)
    expect(elapsed).toBeLessThan(1000)
  })

  test(`Tarjan SCC on ${N} nodes < 100ms`, () => {
    const start = performance.now()
    const result = fixture.engine.tarjanSCC()
    const elapsed = performance.now() - start

    console.log(`Tarjan SCC (${N} nodes): ${elapsed.toFixed(1)}ms, ${result.length} SCCs`)
    expect(result.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(100)
  })

  test(`Louvain on ${N} nodes < 5s`, () => {
    const start = performance.now()
    const result = fixture.engine.louvainCommunity()
    const elapsed = performance.now() - start

    console.log(`Louvain (${N} nodes): ${elapsed.toFixed(1)}ms, ${result.communities.length} communities, Q=${result.modularity.toFixed(4)}`)
    expect(result.communities.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(5000)
  })

  test(`BFS on ${N} nodes < 10ms`, () => {
    const start = performance.now()
    const result = fixture.engine.bfs('n0')
    const elapsed = performance.now() - start

    console.log(`BFS (${N} nodes): ${elapsed.toFixed(1)}ms, ${result.nodes.length} visited`)
    expect(result.nodes.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(10)
  })

  test(`DFS on ${N} nodes < 10ms`, () => {
    const start = performance.now()
    const result = fixture.engine.dfs('n0')
    const elapsed = performance.now() - start

    console.log(`DFS (${N} nodes): ${elapsed.toFixed(1)}ms, ${result.nodes.length} visited`)
    expect(result.nodes.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(10)
  })

  test(`topologicalSort on ${N} nodes < 1s`, () => {
    const start = performance.now()
    const result = fixture.engine.topologicalSort()
    const elapsed = performance.now() - start

    console.log(`topologicalSort (${N} nodes): ${elapsed.toFixed(1)}ms, ${result.order.length} nodes`)
    expect(result.order.length).toBe(N)
    expect(elapsed).toBeLessThan(1000)
  })

  test(`classifyRoles on ${N} nodes < 2s`, () => {
    const start = performance.now()
    const result = fixture.engine.classifyRoles()
    const elapsed = performance.now() - start

    console.log(`classifyRoles (${N} nodes): ${elapsed.toFixed(1)}ms, ${result.size} classified`)
    expect(result.size).toBe(N)
    expect(elapsed).toBeLessThan(2000)
  })

  test(`betweennessCentrality (sampling) on ${N} nodes < 3s`, () => {
    const start = performance.now()
    const result = fixture.engine.betweennessCentrality(50)
    const elapsed = performance.now() - start

    console.log(`betweennessCentrality(50) (${N} nodes): ${elapsed.toFixed(1)}ms, ${result.scores.length} scored`)
    expect(result.scores.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(3000)
  })

  test(`katzCentrality on ${N} nodes < 2s`, () => {
    const start = performance.now()
    const result = fixture.engine.katzCentrality({ maxIter: 20 })
    const elapsed = performance.now() - start

    console.log(`katzCentrality (${N} nodes): ${elapsed.toFixed(1)}ms, ${result.scores.length} scored`)
    expect(result.scores.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('FTS5 search benchmarks', () => {
  const N = 1000
  let fts: FtsSearch
  let rrf: RrfSearch
  let store: GraphStore
  let dbPath: string

  beforeAll(() => {
    dbPath = join(tmpdir(), `fts-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
    fts = new FtsSearch(dbPath)
    fts.createIndex()

    const adj = generateDag(N)
    store = createStoreFromAdjacency(adj, `fts-bench-${Date.now()}`)
    enrichStoreWithMeta(store, N)
    fts.indexNodes(store)

    rrf = new RrfSearch(fts, store)
  })

  afterAll(() => {
    fts.close()
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix
      if (existsSync(p)) unlinkSync(p)
    }
  })

  test(`FTS5 search on ${N} nodes < 5ms`, () => {
    const start = performance.now()
    const results = fts.search('node_500')
    const elapsed = performance.now() - start

    console.log(`FTS5 search (${N} nodes): ${elapsed.toFixed(2)}ms, ${results.length} results`)
    expect(results.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(5)
  })

  test(`FTS5 BM25 search on ${N} nodes < 5ms`, () => {
    const start = performance.now()
    const results = fts.searchWithBM25('node_100')
    const elapsed = performance.now() - start

    console.log(`FTS5 BM25 search (${N} nodes): ${elapsed.toFixed(2)}ms, ${results.length} results`)
    expect(results.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(5)
  })

  test(`RRF fusion search on ${N} nodes < 20ms`, () => {
    const start = performance.now()
    const results = rrf.search('node')
    const elapsed = performance.now() - start

    console.log(`RRF fusion search (${N} nodes): ${elapsed.toFixed(2)}ms, ${results.length} results`)
    expect(results.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(20)
  })

  test(`FTS5 searchByKind on ${N} nodes < 5ms`, () => {
    const start = performance.now()
    const results = fts.searchByKind('node', 'function')
    const elapsed = performance.now() - start

    console.log(`FTS5 searchByKind (${N} nodes): ${elapsed.toFixed(2)}ms, ${results.length} results`)
    expect(results.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(5)
  })
})
