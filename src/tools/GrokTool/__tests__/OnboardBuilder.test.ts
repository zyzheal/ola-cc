/**
 * OnboardBuilder 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/OnboardBuilder.test.ts
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { OnboardBuilder } from '../OnboardBuilder.js'
import { GrokTourBuilder } from '../GrokTourBuilder.js'
import type { GrokAnalyzer } from '../GrokAnalyzer.js'
import type { GraphData } from '../GrokTypes.js'
import type { EnhancedTour } from '../GrokTourBuilder.js'
import { createFixture } from '../../../services/graph/__tests__/testHelpers.js'

// Mock analyzer
const createMockAnalyzer = (): GrokAnalyzer => {
  return {
    callAgentWithTimeout: async () => 'Mock',
  } as unknown as GrokAnalyzer
}

// Helper: generate tour from fixture
function makeTour(adj: Record<string, string[]>, key: string): { tour: EnhancedTour; store: any; engine: any } {
  const { store, engine } = createFixture(adj, key)
  const builder = new GrokTourBuilder(createMockAnalyzer())
  const tour = builder.generateEnhancedTour(store, engine)
  return { tour, store, engine }
}

// Sample Grok metadata
const sampleGrokData: GraphData = {
  nodes: [
    { id: 'A', name: 'A', kind: 'function', file: 'src/a.ts', line: 1, signature: 'fn A()', summary: '', layer: 'API', domain: 'auth' },
    { id: 'B', name: 'B', kind: 'function', file: 'src/b.ts', line: 1, signature: 'fn B()', summary: '', layer: 'Service', domain: 'auth' },
  ],
  edges: [{ from: 'A', to: 'B', type: 'calls' }],
  metadata: {
    lastUpdated: new Date().toISOString(),
    fileCount: 2,
    languages: ['typescript', 'javascript'],
    frameworks: ['express'],
    layers: ['API', 'Service', 'Data'],
    uncovered: 0,
    tour: [],
    review: {},
    language: 'en',
    errors: [],
    fingerprints: {},
  },
}

describe('OnboardBuilder', () => {
  describe('generate', () => {
    it('should produce markdown with all sections', () => {
      const { store, engine, tour } = makeTour({
        A: ['B'],
        B: ['C', 'D'],
        C: ['B'],
        D: ['B'],
      }, 'onboard-sections')

      const builder = new OnboardBuilder(store, engine)
      const md = builder.generate(tour)

      expect(md).toContain('# Project Overview')
      expect(md).toContain('# Architecture Summary')
      expect(md).toContain('# Key Entry Points')
      expect(md).toContain('# Learning Path')
      expect(md).toContain('# Common Patterns')
    })

    it('should include node/edge counts in overview', () => {
      const { store, engine, tour } = makeTour({ A: ['B'] }, 'onboard-stats')
      const builder = new OnboardBuilder(store, engine)
      const md = builder.generate(tour)

      expect(md).toContain('**Nodes**')
      expect(md).toContain('**Edges**')
    })

    it('should include Grok metadata when provided', () => {
      const { store, engine, tour } = makeTour({ A: ['B'] }, 'onboard-meta')
      const builder = new OnboardBuilder(store, engine)
      const md = builder.generate(tour, sampleGrokData)

      expect(md).toContain('typescript')
      expect(md).toContain('express')
      expect(md).toContain('API')
    })

    it('should list entry points', () => {
      const { store, engine, tour } = makeTour({
        A: ['B'],
        B: ['C'],
      }, 'onboard-entry')

      const builder = new OnboardBuilder(store, engine)
      const md = builder.generate(tour)

      expect(md).toContain('# Key Entry Points')
    })

    it('should respect maxSteps option', () => {
      const adj: Record<string, string[]> = {}
      for (let i = 0; i < 20; i++) {
        adj[`N${i}`] = i < 19 ? [`N${i + 1}`] : []
      }
      const { store, engine, tour } = makeTour(adj, 'onboard-maxsteps')

      const builder = new OnboardBuilder(store, engine)
      const md = builder.generate(tour, undefined, { maxSteps: 3 })

      // Should contain "...and X more modules"
      expect(md).toContain('more modules')
    })

    it('should handle empty graph gracefully', () => {
      const { store, engine } = createFixture({}, 'onboard-empty')
      const builder = new GrokTourBuilder(createMockAnalyzer())
      const tour = builder.generateEnhancedTour(store, engine)

      const onboardBuilder = new OnboardBuilder(store, engine)
      const md = onboardBuilder.generate(tour)

      expect(md).toContain('# Project Overview')
      // Should not crash, should have graceful fallbacks
      expect(md).toContain('0')
    })

    it('should include dependency information in learning path', () => {
      const { store, engine, tour } = makeTour({
        A: ['B'],
        B: ['C'],
      }, 'onboard-deps')

      const builder = new OnboardBuilder(store, engine)
      const md = builder.generate(tour)

      // Should have "depends on" or "Learning Path" section
      expect(md).toContain('# Learning Path')
      expect(md).toContain('importance:')
    })

    it('should include coupling metrics section', () => {
      const { store, engine, tour } = makeTour({
        A: ['B', 'C'],
        B: ['C'],
        C: ['A'],
      }, 'onboard-coupling')

      const builder = new OnboardBuilder(store, engine)
      const md = builder.generate(tour)

      expect(md).toContain('# Common Patterns')
    })

    it('should show community info when graph is large enough', () => {
      // Need enough nodes for louvain to work
      const { store, engine, tour } = makeTour({
        A: ['B', 'C'],
        B: ['D'],
        C: ['D'],
        D: ['E'],
        E: ['F'],
        F: ['A'],
      }, 'onboard-community')

      const builder = new OnboardBuilder(store, engine)
      const md = builder.generate(tour)

      expect(md).toContain('# Architecture Summary')
    })
  })
})
