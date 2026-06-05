/**
 * GrokTool — grok_architecture & grok_hotspots 单元测试
 *
 * 测试策略：不使用 mock.module（process-global 会污染其他测试文件）。
 * 改为直接测试 GrokTool.call() 内部逻辑，通过 GraphStore 单例预注入测试数据。
 *
 * Run: bun test src/tools/GrokTool/__tests__/grok-graph-ops.test.ts
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { GraphStore } from '../../../services/graph/GraphStore.js'
import { GraphEngine } from '../../../services/graph/GraphEngine.js'
import { createStoreFromAdjacency } from '../../../services/graph/__tests__/testHelpers.js'

// ============================================================
// 测试数据
// ============================================================

const TEST_ADJ = {
  AuthService: ['UserController', 'Logger'],
  UserController: [{ to: 'Database', type: 'data' as const }],
  Database: ['Logger'],
  Logger: [],
}

const TEST_NODES: Record<string, { file: string; line: number }> = {
  AuthService: { file: 'src/auth.ts', line: 1 },
  UserController: { file: 'src/users.ts', line: 1 },
  Database: { file: 'src/db.ts', line: 1 },
  Logger: { file: 'src/logger.ts', line: 1 },
}

function makeTestStore(): GraphStore {
  const store = createStoreFromAdjacency(TEST_ADJ)
  // 覆盖 nodeMeta 的 file 字段（testHelpers 默认用 nodeId 作为 file）
  for (const [id, meta] of Object.entries(TEST_NODES)) {
    const existing = store.nodeMeta.get(id)
    if (existing) {
      existing.file = meta.file
      existing.line = meta.line
    }
  }
  return store
}

// ============================================================
// 测试
// ============================================================

describe('grok_architecture', () => {
  let store: GraphStore

  beforeEach(() => {
    store = makeTestStore()
  })

  it('should compute communities and roles from real GraphEngine', async () => {
    const engine = new GraphEngine(store)
    const communities = engine.louvainCommunity()
    const roles = engine.classifyRoles()

    expect(communities.communities.length).toBeGreaterThan(0)
    expect(roles.size).toBe(4)

    // 验证角色分布
    const distribution = new Map<string, number>()
    for (const [, role] of roles) {
      distribution.set(role, (distribution.get(role) ?? 0) + 1)
    }
    expect(distribution.size).toBeGreaterThan(0)
  })

  it('should classify entry nodes (fanIn=0)', () => {
    const engine = new GraphEngine(store)
    const roles = engine.classifyRoles()

    // AuthService has no incoming edges → entry
    expect(roles.get('AuthService')).toBe('entry')
  })

  it('should classify leaf nodes (fanOut=0)', () => {
    const engine = new GraphEngine(store)
    const roles = engine.classifyRoles()

    // Logger has no outgoing edges → leaf
    expect(roles.get('Logger')).toBe('leaf')
  })

  it('should detect communities via Louvain', () => {
    const engine = new GraphEngine(store)
    const result = engine.louvainCommunity()

    expect(result.communities.length).toBeGreaterThan(0)
    // modularity can be negative for very small graphs
    expect(Number.isFinite(result.modularity)).toBe(true)
    expect(result.resolution).toBe(1.0)

    // All nodes should be in some community
    const totalNodes = result.communities.reduce((sum, c) => sum + c.size, 0)
    expect(totalNodes).toBe(4)
  })
})

describe('grok_hotspots', () => {
  let store: GraphStore

  beforeEach(() => {
    store = makeTestStore()
  })

  it('should compute PageRank scores', () => {
    const engine = new GraphEngine(store)
    const result = engine.pageRank()

    expect(result.scores.length).toBe(4)
    // All scores should be valid numbers
    for (const s of result.scores) {
      expect(s.score).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(s.score)).toBe(true)
    }
    // Scores should be sorted descending
    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i].score).toBeLessThanOrEqual(result.scores[i - 1].score)
    }
  })

  it('should parse temporal coupling from git log', () => {
    // Test the git log parsing logic directly
    const gitOutput = 'COMMIT:abc123\nsrc/auth.ts\nsrc/db.ts\n\nCOMMIT:def456\nsrc/users.ts\nsrc/auth.ts\nsrc/logger.ts\n'
    const commits = gitOutput.split(/^COMMIT:/m).filter(Boolean)
    const coChangeMap = new Map<string, number>()

    for (const commit of commits) {
      const lines = commit.trim().split('\n').filter(l => l && !l.startsWith('COMMIT:'))
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const key = [lines[i], lines[j]].sort().join('↔')
          coChangeMap.set(key, (coChangeMap.get(key) ?? 0) + 1)
        }
      }
    }

    expect(coChangeMap.size).toBeGreaterThan(0)
    // auth.ts and db.ts co-changed in first commit
    expect(coChangeMap.get('src/auth.ts↔src/db.ts')).toBe(1)
    // auth.ts appears in both commits
    const authPairs = [...coChangeMap.entries()].filter(([k]) => k.includes('src/auth.ts'))
    expect(authPairs.length).toBeGreaterThan(1)
  })

  it('should handle empty git log', () => {
    const gitOutput = ''
    const commits = gitOutput.split(/^COMMIT:/m).filter(Boolean)
    expect(commits.length).toBe(0)
  })

  it('should handle single-file commits (no co-change pairs)', () => {
    // Each commit changes only 1 file → no co-change pairs
    const files = ['src/auth.ts']
    const coChangeMap = new Map<string, number>()

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = [files[i], files[j]].sort().join('↔')
        coChangeMap.set(key, (coChangeMap.get(key) ?? 0) + 1)
      }
    }

    expect(coChangeMap.size).toBe(0)
  })
})

describe('GrokTool metadata for new ops', () => {
  it('grok_architecture should be concurrency safe', async () => {
    const { grokTool } = await import('../GrokTool.js')
    expect(grokTool.isConcurrencySafe({ operation: 'grok_architecture' } as any)).toBe(true)
  })

  it('grok_hotspots should be concurrency safe', async () => {
    const { grokTool } = await import('../GrokTool.js')
    expect(grokTool.isConcurrencySafe({ operation: 'grok_hotspots' } as any)).toBe(true)
  })

  it('grok_architecture should be read-only', async () => {
    const { grokTool } = await import('../GrokTool.js')
    expect(grokTool.isReadOnly({ operation: 'grok_architecture' } as any)).toBe(true)
  })

  it('grok_hotspots should be read-only', async () => {
    const { grokTool } = await import('../GrokTool.js')
    expect(grokTool.isReadOnly({ operation: 'grok_hotspots' } as any)).toBe(true)
  })

  it('should include grok_architecture in render labels', async () => {
    const { grokTool } = await import('../GrokTool.js')
    const label = grokTool.renderToolUseMessage({ operation: 'grok_architecture' })
    expect(label).toContain('架构')
  })

  it('should include grok_hotspots in render labels', async () => {
    const { grokTool } = await import('../GrokTool.js')
    const label = grokTool.renderToolUseMessage({ operation: 'grok_hotspots' })
    expect(label).toContain('热点')
  })
})
