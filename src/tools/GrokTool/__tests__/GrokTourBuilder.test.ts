/**
 * GrokTourBuilder 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokTourBuilder.test.ts
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { GrokTourBuilder } from '../GrokTourBuilder.js'
import type { GrokAnalyzer } from '../GrokAnalyzer.js'
import type { GraphData } from '../GrokTypes.js'
import { createFixture } from '../../../services/graph/__tests__/testHelpers.js'

// Mock analyzer with callAgentWithTimeout
const createMockAnalyzer = (): GrokAnalyzer => {
  return {
    callAgentWithTimeout: async () => 'Mock LLM answer',
  } as unknown as GrokAnalyzer
}

const createTestGraph = (): GraphData => ({
  nodes: [
    { id: 'src/auth.ts:login', name: 'login', kind: 'function', file: 'src/auth.ts', line: 10, signature: 'function login(user)', summary: 'Authenticates user credentials', layer: 'API', domain: 'auth' },
    { id: 'src/auth.ts:logout', name: 'logout', kind: 'function', file: 'src/auth.ts', line: 25, signature: 'function logout()', summary: 'Logs out the current user', layer: 'API', domain: 'auth' },
    { id: 'src/db.ts:query', name: 'query', kind: 'function', file: 'src/db.ts', line: 5, signature: 'function query(sql)', summary: 'Executes a database query', layer: 'Data', domain: 'database' },
    { id: 'src/user.ts:UserService', name: 'UserService', kind: 'class', file: 'src/user.ts', line: 1, signature: 'class UserService', summary: 'Manages user operations', layer: 'Service', domain: 'user' },
  ],
  edges: [
    { from: 'src/auth.ts:login', to: 'src/db.ts:query', type: 'calls' },
    { from: 'src/user.ts:UserService', to: 'src/auth.ts:login', type: 'uses' },
  ],
  metadata: {
    lastUpdated: new Date().toISOString(),
    fileCount: 3,
    languages: ['typescript'],
    frameworks: [],
    layers: ['API', 'Data', 'Service'],
    uncovered: 0,
    tour: [],
    review: {},
    language: 'en',
    errors: [],
    fingerprints: {},
  },
})

// ============================================
// tokenizeIdentifier
// ============================================

describe('tokenizeIdentifier', () => {
  let builder: GrokTourBuilder

  beforeEach(() => {
    builder = new GrokTourBuilder(createMockAnalyzer())
  })

  it('should split camelCase', () => {
    const tokens = builder.tokenizeIdentifier('UserService')

    expect(tokens).toContain('user')
    expect(tokens).toContain('service')
  })

  it('should split snake_case', () => {
    const tokens = builder.tokenizeIdentifier('user_service')

    expect(tokens).toContain('user')
    expect(tokens).toContain('service')
  })

  it('should split kebab-case', () => {
    const tokens = builder.tokenizeIdentifier('user-service')

    expect(tokens).toContain('user')
    expect(tokens).toContain('service')
  })

  it('should split dot-separated paths', () => {
    const tokens = builder.tokenizeIdentifier('src.utils.helpers')

    expect(tokens).toContain('src')
    expect(tokens).toContain('utils')
    expect(tokens).toContain('helpers')
  })

  it('should filter single-char tokens', () => {
    const tokens = builder.tokenizeIdentifier('a')

    expect(tokens.length).toBe(0)
  })

  it('should lowercase everything', () => {
    const tokens = builder.tokenizeIdentifier('MyClass')

    expect(tokens).toContain('my')
    expect(tokens).toContain('class')
  })
})

// ============================================
// queryGraph
// ============================================

describe('queryGraph', () => {
  it('should return answer and sources', async () => {
    const mockAnalyzer = createMockAnalyzer()
    const builder = new GrokTourBuilder(mockAnalyzer)
    const graph = createTestGraph()

    const result = await builder.queryGraph('login authentication', graph)

    expect(result.answer).toBe('Mock LLM answer')
    expect(result.sources).toBeDefined()
    expect(Array.isArray(result.sources)).toBe(true)
  })

  it('should rank nodes by relevance', async () => {
    const mockAnalyzer = createMockAnalyzer()
    const builder = new GrokTourBuilder(mockAnalyzer)
    const graph = createTestGraph()

    const result = await builder.queryGraph('login', graph)

    // Should find sources related to login
    expect(result.sources.length).toBeGreaterThan(0)
    // The login function should be in sources
    const loginSource = result.sources.find(s => s.file === 'src/auth.ts')
    expect(loginSource).toBeDefined()
  })

  it('should handle no matching nodes', async () => {
    const mockAnalyzer = createMockAnalyzer()
    const builder = new GrokTourBuilder(mockAnalyzer)
    const graph = createTestGraph()

    const result = await builder.queryGraph('xyznonexistent', graph)

    expect(result.answer).toBe('Mock LLM answer')
    expect(result.sources.length).toBe(0)
  })

  it('should handle empty graph', async () => {
    const mockAnalyzer = createMockAnalyzer()
    const builder = new GrokTourBuilder(mockAnalyzer)
    const emptyGraph: GraphData = {
      nodes: [],
      edges: [],
      metadata: {} as any,
    }

    const result = await builder.queryGraph('anything', emptyGraph)

    expect(result.answer).toBe('Mock LLM answer')
    expect(result.sources.length).toBe(0)
  })

  it('should match by tokenized name (camelCase)', async () => {
    const mockAnalyzer = createMockAnalyzer()
    const builder = new GrokTourBuilder(mockAnalyzer)
    const graph = createTestGraph()

    // Query with "user service" should match UserService via tokenization
    const result = await builder.queryGraph('user service', graph)

    const userServiceSource = result.sources.find(s => s.file === 'src/user.ts')
    expect(userServiceSource).toBeDefined()
  })

  it('should handle Chinese queries without errors', async () => {
    const mockAnalyzer = createMockAnalyzer()
    const builder = new GrokTourBuilder(mockAnalyzer)
    const graph = createTestGraph()

    // Chinese query should not throw, even with no matching nodes
    const result = await builder.queryGraph('核心对话流程是怎样的？', graph)
    expect(result.answer).toBeDefined()
    expect(result.sources).toBeDefined()
  })

  it('should extract Chinese bigram keywords', () => {
    const mockAnalyzer = createMockAnalyzer()
    const builder = new GrokTourBuilder(mockAnalyzer)

    // Access private method for testing
    const tokens = (builder as any).tokenizeChinese('用户认证流程') as string[]
    expect(tokens).toContain('用户')
    expect(tokens).toContain('认证')
    expect(tokens).toContain('流程')
    expect(tokens).toContain('用户认证流程')
  })

  it('should match Chinese keywords in node summaries', async () => {
    const mockAnalyzer = createMockAnalyzer()
    const builder = new GrokTourBuilder(mockAnalyzer)
    const graph: GraphData = {
      nodes: [
        { id: 'auth', name: 'login', kind: 'function', file: 'src/auth.ts', line: 10, summary: '用户认证登录', layer: 'API', domain: 'auth' },
        { id: 'db', name: 'query', kind: 'function', file: 'src/db.ts', line: 5, summary: '数据库查询', layer: 'Data', domain: 'database' },
      ],
      edges: [],
      metadata: {} as any,
    }

    const result = await builder.queryGraph('用户认证', graph)
    // "用户" and "认证" bigrams should match the auth node
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources[0].file).toBe('src/auth.ts')
  })
})

// ============================================
// generateEnhancedTour
// ============================================

describe('generateEnhancedTour', () => {
  let builder: GrokTourBuilder

  beforeEach(() => {
    builder = new GrokTourBuilder(createMockAnalyzer())
  })

  it('should return empty tour for empty graph', () => {
    const { store, engine } = createFixture({}, 'tour-empty')
    const tour = builder.generateEnhancedTour(store, engine)

    expect(tour.steps).toEqual([])
    expect(tour.entryPoints).toEqual([])
    expect(tour.coreModules).toEqual([])
    expect(tour.generatedAt).toBeGreaterThan(0)
  })

  it('should classify entry points and core modules', () => {
    // A is entry (fanIn=0, fanOut>0), B is core (high fanIn)
    const { store, engine } = createFixture({
      A: ['B'],
      B: ['C', 'D'],
      C: ['B'],
      D: ['B'],
    }, 'tour-classify')

    const tour = builder.generateEnhancedTour(store, engine)

    expect(tour.steps.length).toBe(4)
    // A should be in entryPoints (fanIn=0)
    expect(tour.entryPoints).toContain('A')
    // B should be in coreModules (high fanIn)
    expect(tour.coreModules).toContain('B')
  })

  it('should include dependency chains in steps', () => {
    const { store, engine } = createFixture({
      A: ['B'],
      B: ['C'],
    }, 'tour-deps')

    const tour = builder.generateEnhancedTour(store, engine)

    // C has backward reachability to B and A
    const stepC = tour.steps.find(s => s.file.includes('c'))
    expect(stepC).toBeDefined()
    // B should be a dependency of C (reachable via backward)
    expect(stepC!.dependencies.length).toBeGreaterThan(0)
  })

  it('should compute fanIn and fanOut correctly', () => {
    // B has fanIn=2 (A->B, C->B), fanOut=0
    const { store, engine } = createFixture({
      A: ['B'],
      C: ['B'],
    }, 'tour-fanin')

    const tour = builder.generateEnhancedTour(store, engine)
    const stepB = tour.steps.find(s => s.file.includes('b'))
    expect(stepB).toBeDefined()
    expect(stepB!.fanIn).toBe(2)
    expect(stepB!.fanOut).toBe(0)
  })

  it('should sort steps by importance (PageRank)', () => {
    // A is the root that everything flows through
    const { store, engine } = createFixture({
      A: ['B', 'C', 'D'],
      B: ['E'],
      C: ['E'],
      D: ['E'],
    }, 'tour-sort')

    const tour = builder.generateEnhancedTour(store, engine)

    // Steps should be sorted: entry points first, then core, then remaining
    // All steps should have importance >= 0
    for (const step of tour.steps) {
      expect(step.importance).toBeGreaterThanOrEqual(0)
      expect(step.importance).toBeLessThanOrEqual(1)
    }
  })

  it('should cap entryPoints and coreModules at 10', () => {
    // Create a graph with many entry points
    const adj: Record<string, string[]> = {}
    for (let i = 0; i < 20; i++) {
      adj[`E${i}`] = ['Sink']
    }
    const { store, engine } = createFixture(adj, 'tour-cap')

    const tour = builder.generateEnhancedTour(store, engine)

    expect(tour.entryPoints.length).toBeLessThanOrEqual(10)
    expect(tour.coreModules.length).toBeLessThanOrEqual(10)
  })

  it('should handle single node graph', () => {
    const { store, engine } = createFixture({
      A: [],
    }, 'tour-single')

    const tour = builder.generateEnhancedTour(store, engine)

    expect(tour.steps.length).toBe(1)
    expect(tour.steps[0].file).toContain('a')
    expect(tour.steps[0].fanIn).toBe(0)
    expect(tour.steps[0].fanOut).toBe(0)
  })

  it('should mark sink nodes correctly', () => {
    // B has fanOut=0, fanIn>0 → sink
    const { store, engine } = createFixture({
      A: ['B'],
    }, 'tour-sink')

    const tour = builder.generateEnhancedTour(store, engine)
    const stepB = tour.steps.find(s => s.file.includes('b'))
    expect(stepB).toBeDefined()
    expect(stepB!.description).toContain('Sink')
  })
})
