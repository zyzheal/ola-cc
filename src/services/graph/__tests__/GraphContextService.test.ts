/**
 * GraphContextService 综合测试
 *
 * 覆盖: singleton 模式、getPreToolContext 结构、缓存 TTL、
 *       优雅降级、getRecommendations、延迟 < 50ms
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { GraphContextService } from '../GraphContextService.js'
import { GraphStore } from '../GraphStore.js'
import { createStoreFromAdjacency } from './testHelpers.js'

// ============================================================
// Helpers
// ============================================================

const TEST_ROOT = '/test-graph-context-service'

function createTestStore(): GraphStore {
  // Create a store with some nodes that have names matching what getRelatedNodes will search for
  const store = createStoreFromAdjacency(
    {
      A: ['B', 'C'],
      B: ['D'],
      C: ['D'],
      D: [],
      E: ['A'],
    },
    TEST_ROOT,
  )
  // Override names for search tests
  store.nodeMeta.get('A')!.name = 'UserService'
  store.nodeMeta.get('B')!.name = 'AuthHelper'
  store.nodeMeta.get('C')!.name = 'DatabaseConnector'
  store.nodeMeta.get('D')!.name = 'Logger'
  store.nodeMeta.get('E')!.name = 'MainEntry'

  // Build name index by re-triggering the private method via a cast
  const anyStore = store as any
  anyStore.nameIndex.clear()
  anyStore.ambiguousNames.clear()
  // Rebuild: same logic as GraphStore.buildNameIndex()
  const nameToIds = new Map<string, string[]>()
  for (const [nodeId, meta] of store.nodeMeta) {
    if (meta.name) {
      const ids = nameToIds.get(meta.name)
      if (ids) ids.push(nodeId)
      else nameToIds.set(meta.name, [nodeId])
    }
  }
  for (const [name, ids] of nameToIds) {
    if (ids.length > 1) {
      anyStore.ambiguousNames.add(name)
      anyStore.nameIndex.set(name, ids)
    } else {
      anyStore.nameIndex.set(name, ids[0])
    }
  }
  for (const [nodeId, meta] of store.nodeMeta) {
    if (meta.qualified_name && !anyStore.nameIndex.has(meta.qualified_name)) {
      anyStore.nameIndex.set(meta.qualified_name, nodeId)
    }
  }

  return store
}

// ============================================================
// Tests
// ============================================================

describe('GraphContextService', () => {
  beforeEach(() => {
    GraphStore.deleteInstance(TEST_ROOT)
    GraphContextService.deleteInstance(TEST_ROOT)
  })

  // --------------------------------------------------------
  // Singleton pattern
  // --------------------------------------------------------

  describe('singleton pattern', () => {
    test('getInstance returns same instance for same projectRoot', () => {
      const s1 = GraphContextService.getInstance(TEST_ROOT)
      const s2 = GraphContextService.getInstance(TEST_ROOT)
      expect(s1).toBe(s2)
    })

    test('getInstance returns different instance for different projectRoot', () => {
      const s1 = GraphContextService.getInstance('/root-a')
      const s2 = GraphContextService.getInstance('/root-b')
      expect(s1).not.toBe(s2)
      // Cleanup
      GraphContextService.deleteInstance('/root-a')
      GraphContextService.deleteInstance('/root-b')
    })

    test('deleteInstance removes singleton', () => {
      const s1 = GraphContextService.getInstance(TEST_ROOT)
      GraphContextService.deleteInstance(TEST_ROOT)
      const s2 = GraphContextService.getInstance(TEST_ROOT)
      expect(s1).not.toBe(s2)
    })
  })

  // --------------------------------------------------------
  // getPreToolContext — structure
  // --------------------------------------------------------

  describe('getPreToolContext', () => {
    test('returns correct structure with loaded store', () => {
      createTestStore() // register in GraphStore singleton
      const svc = GraphContextService.getInstance(TEST_ROOT)

      const ctx = svc.getPreToolContext('codegraph_search', { query: 'UserService' })

      expect(ctx).toHaveProperty('hotspots')
      expect(ctx).toHaveProperty('communityCount')
      expect(ctx).toHaveProperty('relatedNodes')
      expect(ctx).toHaveProperty('suggestedOperations')

      expect(Array.isArray(ctx.hotspots)).toBe(true)
      expect(typeof ctx.communityCount).toBe('number')
      expect(Array.isArray(ctx.relatedNodes)).toBe(true)
      expect(Array.isArray(ctx.suggestedOperations)).toBe(true)
    })

    test('hotspots contains top 5 PageRank nodes with correct shape', () => {
      createTestStore()
      const svc = GraphContextService.getInstance(TEST_ROOT)

      const ctx = svc.getPreToolContext('codegraph_search', { query: 'test' })

      // Our test graph has 5 nodes, so hotspots <= 5
      expect(ctx.hotspots.length).toBeLessThanOrEqual(5)

      for (const hs of ctx.hotspots) {
        expect(hs).toHaveProperty('id')
        expect(hs).toHaveProperty('name')
        expect(hs).toHaveProperty('score')
        expect(typeof hs.id).toBe('string')
        expect(typeof hs.name).toBe('string')
        expect(typeof hs.score).toBe('number')
      }
    })

    test('relatedNodes returns nodes related to query', () => {
      createTestStore()
      const svc = GraphContextService.getInstance(TEST_ROOT)

      const ctx = svc.getPreToolContext('codegraph_search', { query: 'UserService' })

      // UserService (A) has outgoing edges to B and C
      expect(ctx.relatedNodes.length).toBeGreaterThan(0)
      expect(ctx.relatedNodes.length).toBeLessThanOrEqual(5)

      const names = ctx.relatedNodes.map(r => r.name)
      expect(names).toContain('AuthHelper')
      expect(names).toContain('DatabaseConnector')
    })

    test('relatedNodes returns empty when query not found', () => {
      createTestStore()
      const svc = GraphContextService.getInstance(TEST_ROOT)

      const ctx = svc.getPreToolContext('codegraph_search', { query: 'NonExistentFunction' })

      expect(ctx.relatedNodes).toEqual([])
    })

    test('relatedNodes extracts query from various input fields', () => {
      createTestStore()
      const svc = GraphContextService.getInstance(TEST_ROOT)

      // 'symbol' field
      const ctx1 = svc.getPreToolContext('codegraph_search', { symbol: 'UserService' })
      expect(ctx1.relatedNodes.length).toBeGreaterThan(0)

      // 'name' field
      const ctx2 = svc.getPreToolContext('codegraph_search', { name: 'UserService' })
      expect(ctx2.relatedNodes.length).toBeGreaterThan(0)
    })

    test('suggestedOperations maps tool names correctly', () => {
      createTestStore()
      const svc = GraphContextService.getInstance(TEST_ROOT)

      expect(svc.getPreToolContext('codegraph_search', {}).suggestedOperations)
        .toEqual(['codegraph_callers', 'codegraph_callees', 'codegraph_context'])

      expect(svc.getPreToolContext('codegraph_callers', {}).suggestedOperations)
        .toEqual(['codegraph_callees', 'codegraph_impact', 'codegraph_context'])

      expect(svc.getPreToolContext('codegraph_pagerank', {}).suggestedOperations)
        .toEqual(['codegraph_community', 'codegraph_roles', 'codegraph_centrality'])

      expect(svc.getPreToolContext('grok_generate', {}).suggestedOperations)
        .toEqual(['grok_architecture', 'grok_hotspots', 'grok_tour'])

      expect(svc.getPreToolContext('grok_architecture', {}).suggestedOperations)
        .toEqual(['grok_hotspots', 'grok_domain', 'grok_tour'])

      // default
      expect(svc.getPreToolContext('unknown_tool', {}).suggestedOperations)
        .toEqual(['codegraph_search', 'grok_architecture'])
    })
  })

  // --------------------------------------------------------
  // Cache TTL
  // --------------------------------------------------------

  describe('cache TTL', () => {
    test('second call within 60s returns cached hotspots (same reference)', () => {
      createTestStore()
      const svc = GraphContextService.getInstance(TEST_ROOT)

      const ctx1 = svc.getPreToolContext('codegraph_search', { query: 'test' })
      const ctx2 = svc.getPreToolContext('codegraph_search', { query: 'test' })

      // Same array reference = cache hit (no recomputation)
      expect(ctx1.hotspots).toBe(ctx2.hotspots)
      expect(ctx1.communityCount).toBe(ctx2.communityCount)
    })
  })

  // --------------------------------------------------------
  // Graceful degradation
  // --------------------------------------------------------

  describe('graceful degradation', () => {
    test('returns empty context when store not loaded', () => {
      // Create a store but don't load it (no data)
      GraphStore.getInstance(TEST_ROOT) // creates empty store, not loaded
      const svc = GraphContextService.getInstance(TEST_ROOT)

      const ctx = svc.getPreToolContext('codegraph_search', { query: 'test' })

      expect(ctx.hotspots).toEqual([])
      expect(ctx.communityCount).toBe(0)
      expect(ctx.relatedNodes).toEqual([])
      expect(ctx.suggestedOperations).toEqual(['codegraph_callers', 'codegraph_callees', 'codegraph_context'])
    })

    test('returns empty context when no store exists at all (no error thrown)', () => {
      // Don't create any store — getInstance will create an empty one
      const svc = GraphContextService.getInstance(TEST_ROOT)

      expect(() => {
        const ctx = svc.getPreToolContext('codegraph_search', { query: 'test' })
        expect(ctx.hotspots).toEqual([])
        expect(ctx.communityCount).toBe(0)
      }).not.toThrow()
    })
  })

  // --------------------------------------------------------
  // getRecommendations
  // --------------------------------------------------------

  describe('getRecommendations', () => {
    test('returns operations for keyword matches', () => {
      const svc = GraphContextService.getInstance(TEST_ROOT)

      expect(svc.getRecommendations('find important nodes')).toEqual(
        ['codegraph_pagerank', 'codegraph_community', 'codegraph_roles'],
      )

      expect(svc.getRecommendations('who calls this function')).toEqual(
        ['codegraph_callers', 'codegraph_impact', 'codegraph_context'],
      )

      expect(svc.getRecommendations('show the architecture')).toEqual(
        ['grok_architecture', 'grok_hotspots', 'grok_tour'],
      )

      expect(svc.getRecommendations('search for UserService')).toEqual(
        ['codegraph_search', 'codegraph_callers', 'codegraph_context'],
      )

      expect(svc.getRecommendations('what is the impact of this change')).toEqual(
        ['codegraph_impact', 'codegraph_callers', 'codegraph_callees'],
      )

      expect(svc.getRecommendations('find dead code')).toEqual(
        ['codegraph_roles', 'codegraph_centrality', 'codegraph_pagerank'],
      )

      expect(svc.getRecommendations('show community clusters')).toEqual(
        ['codegraph_community', 'codegraph_roles', 'grok_domain'],
      )
    })

    test('returns defaults for unmatched queries', () => {
      const svc = GraphContextService.getInstance(TEST_ROOT)

      expect(svc.getRecommendations('hello world')).toEqual(
        ['codegraph_search', 'grok_architecture'],
      )
    })
  })

  // --------------------------------------------------------
  // Latency
  // --------------------------------------------------------

  describe('latency', () => {
    test('cache hit completes under 50ms', () => {
      createTestStore()
      const svc = GraphContextService.getInstance(TEST_ROOT)

      // Warm up cache
      svc.getPreToolContext('codegraph_search', { query: 'test' })

      // Measure cache hit latency
      const start = performance.now()
      svc.getPreToolContext('codegraph_search', { query: 'test' })
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
    })
  })
})
