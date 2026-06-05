/**
 * GrokTourBuilder 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokTourBuilder.test.ts
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { GrokTourBuilder } from '../GrokTourBuilder.js'
import type { GrokAnalyzer } from '../GrokAnalyzer.js'
import type { GraphData } from '../GrokManager.js'

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
})
