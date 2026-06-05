/**
 * GrokTool — grok_architecture & grok_hotspots 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/grok-graph-ops.test.ts
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

// ============================================================
// Mock data
// ============================================================

const mockNodes = new Map([
  ['AuthService', { id: 'AuthService', name: 'AuthService', kind: 'class', file: 'src/auth.ts', line: 1 }],
  ['Database', { id: 'Database', name: 'Database', kind: 'class', file: 'src/db.ts', line: 1 }],
  ['UserController', { id: 'UserController', name: 'UserController', kind: 'class', file: 'src/users.ts', line: 1 }],
  ['Logger', { id: 'Logger', name: 'Logger', kind: 'class', file: 'src/logger.ts', line: 1 }],
])

const mockCommunityResult = {
  communities: [
    { id: 0, nodes: ['AuthService', 'UserController'], size: 2 },
    { id: 1, nodes: ['Database', 'Logger'], size: 2 },
  ],
  modularity: 0.42,
  resolution: 1.0,
}

const mockRoles = new Map([
  ['AuthService', 'core' as const],
  ['Database', 'utility' as const],
  ['UserController', 'entry' as const],
  ['Logger', 'utility' as const],
])

const mockPageRankResult = {
  scores: [
    { node: 'AuthService', score: 1.0 },
    { node: 'Database', score: 0.8 },
    { node: 'UserController', score: 0.6 },
    { node: 'Logger', score: 0.4 },
  ],
}

// Module-level spy references so tests can assert on calls
const mockLouvainCommunity = mock(() => mockCommunityResult)
const mockClassifyRoles = mock(() => mockRoles)
const mockPageRank = mock(() => mockPageRankResult)

const mockStore = {
  load: mock(() => Promise.resolve()),
  getNode: mock((id: string) => mockNodes.get(id)),
  getOutEdges: mock(() => new Map()),
  getInEdges: mock(() => new Map()),
  adjacency: new Map(),
  nodeMeta: mockNodes,
}

// ============================================================
// Mutable references for tests to override
// ============================================================

let queryGraphResult = { answer: 'LLM summary of architecture', sources: [] as any[] }
let queryGraphThrows = false
let gitOutput = 'COMMIT:abc123\nsrc/auth.ts\nsrc/db.ts\n\nCOMMIT:def456\nsrc/users.ts\nsrc/auth.ts\nsrc/logger.ts\n'
let gitThrows = false

// ============================================================
// Mocks (must be before import of GrokTool)
// ============================================================

mock.module('../../../services/graph/GraphStore.js', () => ({
  GraphStore: {
    getInstance: mock(() => mockStore),
  },
}))

mock.module('../../../services/graph/GraphEngine.js', () => ({
  GraphEngine: class MockGraphEngine {
    louvainCommunity = mockLouvainCommunity
    classifyRoles = mockClassifyRoles
    pageRank = mockPageRank
  },
}))

mock.module('child_process', () => ({
  execSync: mock((..._args: any[]) => {
    if (gitThrows) throw new Error('no git')
    return gitOutput
  }),
}))

mock.module('../GrokManager.js', () => ({
  grokManager: {
    ensureGrokSource: mock(() => Promise.resolve('/tmp/grok-source')),
    queryGraph: mock((..._args: any[]) => {
      if (queryGraphThrows) return Promise.reject(new Error('LLM down'))
      return Promise.resolve(queryGraphResult)
    }),
    getGraphStatus: mock(() => Promise.resolve({ exists: true, stale: false })),
  },
  GrokError: class GrokError extends Error {
    code: string
    recoverable: boolean
    suggestion?: string
    constructor(code: string, msg?: string) {
      super(msg)
      this.code = code
      this.recoverable = false
    }
  },
  ERROR_SUGGESTIONS: {},
}))

mock.module('../../../utils/cwd.js', () => ({
  getCwd: mock(() => '/tmp/test-project'),
}))

mock.module('../../../utils/debug.js', () => ({
  logForDebugging: mock(() => {}),
}))

// ============================================================
// Import after mocks
// ============================================================

import { grokTool } from '../GrokTool.js'

// ============================================================
// Tests
// ============================================================

describe('grok_architecture', () => {
  beforeEach(() => {
    mockLouvainCommunity.mockClear()
    mockClassifyRoles.mockClear()
    queryGraphThrows = false
    queryGraphResult = { answer: 'LLM summary of architecture', sources: [] }
  })

  it('should return communities, roles, and llmSummary', async () => {
    const result = await grokTool.call(
      { operation: 'grok_architecture' } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    expect(result.data.ok).toBe(true)
    expect(result.data.operation).toBe('grok_architecture')

    const r = result.data.result as any
    expect(r.communities).toBeDefined()
    expect(Array.isArray(r.communities)).toBe(true)
    expect(r.communities.length).toBe(2)
    expect(r.communities[0]).toHaveProperty('id')
    expect(r.communities[0]).toHaveProperty('size')
    expect(r.communities[0]).toHaveProperty('sample')

    expect(r.modularity).toBe(0.42)
    expect(r.resolution).toBe(1.0)
    expect(r.totalCommunities).toBe(2)

    expect(r.roles).toBeDefined()
    expect(r.roles.distribution).toBeDefined()
    expect(r.roles.distribution.core).toBe(1)
    expect(r.roles.distribution.utility).toBe(2)
    expect(r.roles.distribution.entry).toBe(1)
    expect(r.roles.totalNodes).toBe(4)

    expect(r.llmSummary).toBe('LLM summary of architecture')
  })

  it('should pass resolution parameter', async () => {
    await grokTool.call(
      { operation: 'grok_architecture', resolution: 2.0 } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    expect(mockLouvainCommunity).toHaveBeenCalledWith({ resolution: 2.0 })
  })

  it('should respect maxNodes parameter', async () => {
    const result = await grokTool.call(
      { operation: 'grok_architecture', maxNodes: 1 } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    const r = result.data.result as any
    expect(r.communities.length).toBe(1)
  })

  it('should handle LLM failure gracefully', async () => {
    queryGraphThrows = true

    const result = await grokTool.call(
      { operation: 'grok_architecture' } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    const r = result.data.result as any
    expect(r.llmSummary).toBe('(LLM enrichment unavailable)')
    expect(r.communities).toBeDefined()
    expect(r.communities.length).toBe(2)
  })
})

describe('grok_hotspots', () => {
  beforeEach(() => {
    mockPageRank.mockClear()
    queryGraphThrows = false
    queryGraphResult = { answer: 'LLM summary of architecture', sources: [] }
    gitThrows = false
    gitOutput = 'COMMIT:abc123\nsrc/auth.ts\nsrc/db.ts\n\nCOMMIT:def456\nsrc/users.ts\nsrc/auth.ts\nsrc/logger.ts\n'
  })

  it('should return hotspots, temporalCoupling, and llmSummary', async () => {
    const result = await grokTool.call(
      { operation: 'grok_hotspots' } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    expect(result.data.ok).toBe(true)
    expect(result.data.operation).toBe('grok_hotspots')

    const r = result.data.result as any
    expect(r.hotspots).toBeDefined()
    expect(Array.isArray(r.hotspots)).toBe(true)
    expect(r.hotspots.length).toBe(4)
    expect(r.hotspots[0]).toHaveProperty('node')
    expect(r.hotspots[0]).toHaveProperty('score')
    expect(r.hotspots[0]).toHaveProperty('meta')
    expect(r.totalScored).toBe(4)

    expect(r.temporalCoupling).toBeDefined()
    expect(r.temporalCoupling.pairs).toBeDefined()
    expect(Array.isArray(r.temporalCoupling.pairs)).toBe(true)
    expect(r.temporalCoupling.totalCommits).toBe(2)
    expect(r.temporalCoupling.window).toEqual({ since: '30 days', until: 'now' })

    expect(r.llmSummary).toBe('LLM summary of architecture')
  })

  it('should pass damping parameter to pageRank', async () => {
    await grokTool.call(
      { operation: 'grok_hotspots', damping: 0.9 } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    expect(mockPageRank).toHaveBeenCalledWith(0.9)
  })

  it('should respect maxNodes parameter', async () => {
    const result = await grokTool.call(
      { operation: 'grok_hotspots', maxNodes: 2 } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    const r = result.data.result as any
    expect(r.hotspots.length).toBe(2)
  })

  it('should parse temporal coupling pairs from git log', async () => {
    const result = await grokTool.call(
      { operation: 'grok_hotspots' } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    const r = result.data.result as any
    expect(r.temporalCoupling.pairs.length).toBeGreaterThan(0)
    expect(r.temporalCoupling.pairs[0]).toHaveProperty('a')
    expect(r.temporalCoupling.pairs[0]).toHaveProperty('b')
    expect(r.temporalCoupling.pairs[0]).toHaveProperty('coChanges')
  })

  it('should handle git failure gracefully', async () => {
    gitThrows = true

    const result = await grokTool.call(
      { operation: 'grok_hotspots' } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    const r = result.data.result as any
    expect(r.temporalCoupling.pairs).toEqual([])
    expect(r.temporalCoupling.totalCommits).toBe(0)
    expect(r.hotspots).toBeDefined()
    expect(r.hotspots.length).toBe(4)
  })

  it('should handle LLM failure gracefully', async () => {
    queryGraphThrows = true

    const result = await grokTool.call(
      { operation: 'grok_hotspots' } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    )

    const r = result.data.result as any
    expect(r.llmSummary).toBe('(LLM enrichment unavailable)')
    expect(r.hotspots).toBeDefined()
  })
})

describe('GrokTool metadata for new ops', () => {
  it('should include grok_architecture in render labels', () => {
    const label = grokTool.renderToolUseMessage({ operation: 'grok_architecture' })
    expect(label).toBe('架构分析')
  })

  it('should include grok_hotspots in render labels', () => {
    const label = grokTool.renderToolUseMessage({ operation: 'grok_hotspots' })
    expect(label).toBe('热点检测')
  })

  it('should be concurrency safe for grok_architecture', () => {
    expect(grokTool.isConcurrencySafe({ operation: 'grok_architecture' } as any)).toBe(true)
  })

  it('should be concurrency safe for grok_hotspots', () => {
    expect(grokTool.isConcurrencySafe({ operation: 'grok_hotspots' } as any)).toBe(true)
  })

  it('should be read-only for grok_architecture', () => {
    expect(grokTool.isReadOnly({ operation: 'grok_architecture' } as any)).toBe(true)
  })

  it('should be read-only for grok_hotspots', () => {
    expect(grokTool.isReadOnly({ operation: 'grok_hotspots' } as any)).toBe(true)
  })
})
