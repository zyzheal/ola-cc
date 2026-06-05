/**
 * Dashboard tests (F-96)
 */

import { describe, test, expect } from 'bun:test'
import { Dashboard } from '../Dashboard.js'
import { createStoreFromAdjacency } from '../../../services/graph/__tests__/testHelpers.js'
import { GraphEngine } from '../../../services/graph/GraphEngine.js'

function createTestDashboard() {
  const store = createStoreFromAdjacency({
    A: ['B', 'C', 'D'],
    B: ['C', 'E'],
    C: ['E'],
    D: ['E'],
    E: [],
  })

  // Set some metadata for richer output
  const metaA = store.nodeMeta.get('A')!
  metaA.kind = 'class'
  metaA.name = 'AppController'

  const metaB = store.nodeMeta.get('B')!
  metaB.kind = 'function'
  metaB.name = 'handleRoute'

  const metaC = store.nodeMeta.get('C')!
  metaC.kind = 'function'
  metaC.name = 'validateInput'

  const metaD = store.nodeMeta.get('D')!
  metaD.kind = 'type'
  metaD.name = 'AppState'

  const metaE = store.nodeMeta.get('E')!
  metaE.kind = 'const'
  metaE.name = 'config'

  const engine = new GraphEngine(store)
  const dashboard = new Dashboard(store, engine)
  return { store, engine, dashboard }
}

describe('Dashboard', () => {
  describe('render', () => {
    test('produces non-empty string output', () => {
      const { dashboard } = createTestDashboard()
      const output = dashboard.render()

      expect(typeof output).toBe('string')
      expect(output.length).toBeGreaterThan(0)
    })

    test('contains header with node/edge counts', () => {
      const { dashboard } = createTestDashboard()
      const output = dashboard.render()

      expect(output).toContain('Graph Dashboard')
      expect(output).toContain('Nodes:')
      expect(output).toContain('Edges:')
    })

    test('contains PageRank section', () => {
      const { dashboard } = createTestDashboard()
      const output = dashboard.render()

      expect(output).toContain('Top Nodes by PageRank')
    })

    test('contains Betweenness section', () => {
      const { dashboard } = createTestDashboard()
      const output = dashboard.render()

      expect(output).toContain('Betweenness Centrality')
    })

    test('contains Community Distribution section', () => {
      const { dashboard } = createTestDashboard()
      const output = dashboard.render()

      expect(output).toContain('Community Distribution')
    })

    test('contains Cluster View section', () => {
      const { dashboard } = createTestDashboard()
      const output = dashboard.render()

      expect(output).toContain('Cluster View')
    })

    test('contains Kind Distribution section', () => {
      const { dashboard } = createTestDashboard()
      const output = dashboard.render()

      expect(output).toContain('Kind Distribution')
    })

    test('respects width option', () => {
      const { dashboard } = createTestDashboard()
      const output = dashboard.render({ width: 40 })

      // Header separator should match width
      const lines = output.split('\n')
      const separatorLine = lines.find(l => /^=+$/.test(l))
      expect(separatorLine).toBeDefined()
      expect(separatorLine!.length).toBe(40)
    })

    test('respects maxNodes option', () => {
      const { dashboard } = createTestDashboard()
      const outputFew = dashboard.render({ maxNodes: 2 })
      const outputMore = dashboard.render({ maxNodes: 10 })

      // Fewer maxNodes should produce shorter output
      expect(outputFew.length).toBeLessThanOrEqual(outputMore.length)
    })

    test('filter option limits displayed nodes', () => {
      const { dashboard } = createTestDashboard()
      const output = dashboard.render({ filter: 'App' })

      // Should contain AppController
      expect(output).toContain('AppController')
    })

    test('handles empty graph', () => {
      const store = createStoreFromAdjacency({})
      const engine = new GraphEngine(store)
      const dashboard = new Dashboard(store, engine)
      const output = dashboard.render()

      expect(output).toContain('Nodes: 0')
      expect(output).toContain('Edges: 0')
    })
  })

  describe('getStats', () => {
    test('returns correct node/edge counts', () => {
      const { dashboard } = createTestDashboard()
      const stats = dashboard.getStats()

      expect(stats.nodes).toBe(5)
      expect(stats.edges).toBeGreaterThan(0)
    })

    test('returns topPageRank array', () => {
      const { dashboard } = createTestDashboard()
      const stats = dashboard.getStats()

      expect(stats.topPageRank.length).toBeGreaterThan(0)
      expect(stats.topPageRank.length).toBeLessThanOrEqual(10)
      expect(stats.topPageRank[0]).toHaveProperty('node')
      expect(stats.topPageRank[0]).toHaveProperty('score')
    })

    test('returns topBetweenness array', () => {
      const { dashboard } = createTestDashboard()
      const stats = dashboard.getStats()

      expect(stats.topBetweenness.length).toBeGreaterThan(0)
      expect(stats.topBetweenness.length).toBeLessThanOrEqual(10)
    })

    test('PageRank scores are normalized 0-1', () => {
      const { dashboard } = createTestDashboard()
      const stats = dashboard.getStats()

      for (const entry of stats.topPageRank) {
        expect(entry.score).toBeGreaterThanOrEqual(0)
        expect(entry.score).toBeLessThanOrEqual(1)
      }
    })

    test('communities count is positive for non-empty graph', () => {
      const { dashboard } = createTestDashboard()
      const stats = dashboard.getStats()

      expect(stats.communities).toBeGreaterThan(0)
    })
  })

  describe('formatTable', () => {
    test('formats data with columns', () => {
      const { dashboard } = createTestDashboard()
      const table = dashboard.formatTable(
        [
          { Name: 'Alice', Age: 30 },
          { Name: 'Bob', Age: 25 },
        ],
        ['Name', 'Age'],
      )

      expect(table).toContain('Alice')
      expect(table).toContain('Bob')
      expect(table).toContain('Name')
      expect(table).toContain('Age')
    })

    test('returns "(no data)" for empty array', () => {
      const { dashboard } = createTestDashboard()
      const table = dashboard.formatTable([], ['Name'])

      expect(table).toBe('(no data)')
    })

    test('handles missing values gracefully', () => {
      const { dashboard } = createTestDashboard()
      const table = dashboard.formatTable(
        [{ Name: 'Test' } as Record<string, unknown>],
        ['Name', 'Missing'],
      )

      expect(table).toContain('Test')
    })
  })
})
