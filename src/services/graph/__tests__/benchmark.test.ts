import { describe, test, expect } from 'bun:test'
import { GraphStore } from '../GraphStore.js'
import { GraphEngine } from '../GraphEngine.js'

describe('performance benchmarks', () => {
  let engine: GraphEngine
  let store: GraphStore

  test('load codegraph.db < 1s', async () => {
    // Use process.cwd() as project root (where codegraph.db lives)
    // reload() forces a fresh load, bypassing any cached singleton
    store = GraphStore.getInstance(process.cwd())
    const start = Date.now()
    await store.reload()
    const elapsed = Date.now() - start

    engine = new GraphEngine(store)
    console.log(`GraphStore.load(): ${elapsed}ms, ${store.size.nodes} nodes, ${store.size.edges} edges`)
    expect(elapsed).toBeLessThan(1000)
  })

  test('PageRank < 5s', () => {
    const start = Date.now()
    const result = engine.pageRank()
    const elapsed = Date.now() - start
    console.log(`pageRank(): ${elapsed}ms, ${result.scores.length} nodes scored`)
    expect(elapsed).toBeLessThan(5000)
  })

  test('Tarjan SCC < 100ms', () => {
    const start = Date.now()
    const result = engine.tarjanSCC()
    const elapsed = Date.now() - start
    console.log(`tarjanSCC(): ${elapsed}ms, ${result.length} SCCs`)
    expect(elapsed).toBeLessThan(100)
  })

  test('Louvain Community < 15s', () => {
    const start = Date.now()
    const result = engine.louvainCommunity()
    const elapsed = Date.now() - start
    console.log(`louvainCommunity(): ${elapsed}ms, ${result.communities.length} communities, Q=${result.modularity.toFixed(4)}`)
    expect(elapsed).toBeLessThan(15000)
  }, 20000)

  test('topologicalSort < 5s', () => {
    const start = Date.now()
    const result = engine.topologicalSort()
    const elapsed = Date.now() - start
    console.log(`topologicalSort(): ${elapsed}ms, ${result.order.length} nodes`)
    expect(elapsed).toBeLessThan(5000)
  })

  test('classifyRoles < 5s', () => {
    const start = Date.now()
    const result = engine.classifyRoles()
    const elapsed = Date.now() - start
    console.log(`classifyRoles(): ${elapsed}ms, ${result.size} nodes classified`)
    expect(elapsed).toBeLessThan(5000)
  }, 10000)

  test('betweennessCentrality (sampling) < 5s', () => {
    const start = Date.now()
    const result = engine.betweennessCentrality(50)
    const elapsed = Date.now() - start
    console.log(`betweennessCentrality(50): ${elapsed}ms, ${result.scores.length} nodes`)
    expect(elapsed).toBeLessThan(5000)
  })

  test('couplingMetrics < 2s', () => {
    const start = Date.now()
    const result = engine.couplingMetrics()
    const elapsed = Date.now() - start
    console.log(`couplingMetrics(): ${elapsed}ms, ${result.highCoupling.length} high-coupling nodes, ${result.lcom.length} LCOM entries`)
    expect(elapsed).toBeLessThan(2000)
  })
})
