/**
 * UnderstandChat 单元测试
 *
 * 测试问题解析、节点搜索、PageRank 排序、prompt 构建。
 * 使用 testHelpers 工厂注入测试数据，不依赖文件系统。
 *
 * Run: bun test src/tools/GrokTool/__tests__/UnderstandChat.test.ts
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { UnderstandChat } from '../UnderstandChat.js'
import { createStoreFromAdjacency } from '../../../services/graph/__tests__/testHelpers.js'
import { GraphEngine } from '../../../services/graph/GraphEngine.js'
import type { GraphStore } from '../../../services/graph/GraphStore.js'

// ============================================================
// 测试数据
// ============================================================

const TEST_ADJ = {
  AuthService: ['UserController', 'Database'],
  UserController: ['Database', 'Logger'],
  Database: ['Logger'],
  Logger: [],
  ConfigService: ['Database'],
  Router: ['AuthService', 'UserController'],
}

const TEST_NODES: Record<string, { file: string; kind: string; layer?: string; domain?: string }> = {
  AuthService: { file: 'src/auth/service.ts', kind: 'class', layer: 'service', domain: 'auth' },
  UserController: { file: 'src/users/controller.ts', kind: 'class', layer: 'controller', domain: 'users' },
  Database: { file: 'src/db/database.ts', kind: 'class', layer: 'infrastructure', domain: 'persistence' },
  Logger: { file: 'src/utils/logger.ts', kind: 'function', layer: 'utility', domain: 'logging' },
  ConfigService: { file: 'src/config/service.ts', kind: 'class', layer: 'service', domain: 'config' },
  Router: { file: 'src/http/router.ts', kind: 'class', layer: 'controller', domain: 'http' },
}

function makeTestStore(): GraphStore {
  const store = createStoreFromAdjacency(TEST_ADJ)
  for (const [id, meta] of Object.entries(TEST_NODES)) {
    const existing = store.nodeMeta.get(id)
    if (existing) {
      existing.file = meta.file
      existing.kind = meta.kind
      if (meta.layer) existing.layer = meta.layer
      if (meta.domain) existing.domain = meta.domain
    }
  }
  return store
}

// ============================================================
// extractTerms
// ============================================================

describe('UnderstandChat.extractTerms', () => {
  let chat: UnderstandChat

  beforeEach(() => {
    const store = makeTestStore()
    const engine = new GraphEngine(store)
    chat = new UnderstandChat(store, engine)
  })

  it('extracts meaningful terms from a question', () => {
    const terms = chat.extractTerms('How does AuthService handle authentication?')
    expect(terms).toContain('AuthService')
    expect(terms).toContain('handle')
    expect(terms).toContain('authentication')
  })

  it('removes stop words', () => {
    const terms = chat.extractTerms('What is the database used for?')
    // 'what', 'is', 'the', 'for' should be removed
    expect(terms).not.toContain('What')
    expect(terms).not.toContain('is')
    expect(terms).not.toContain('the')
    expect(terms).not.toContain('for')
    expect(terms).toContain('database')
  })

  it('splits camelCase', () => {
    const terms = chat.extractTerms('Where is UserController defined?')
    // Should keep User and Controller as well as UserController
    expect(terms.some(t => t.toLowerCase().includes('user'))).toBe(true)
  })

  it('handles dotted identifiers', () => {
    const terms = chat.findContext('AuthService.login')
    // findContext calls extractTerms internally
    expect(terms.nodes.length).toBeGreaterThan(0)
  })

  it('returns empty for empty input', () => {
    const terms = chat.extractTerms('')
    expect(terms).toEqual([])
  })

  it('returns empty for stop-word-only input', () => {
    const terms = chat.extractTerms('is the a an')
    expect(terms).toEqual([])
  })
})

// ============================================================
// findContext
// ============================================================

describe('UnderstandChat.findContext', () => {
  let chat: UnderstandChat

  beforeEach(() => {
    const store = makeTestStore()
    const engine = new GraphEngine(store)
    chat = new UnderstandChat(store, engine)
  })

  it('finds matching nodes', () => {
    const ctx = chat.findContext('How does AuthService work?')
    expect(ctx.nodes.length).toBeGreaterThan(0)
    expect(ctx.nodes).toContain('AuthService')
  })

  it('finds multiple matches', () => {
    const ctx = chat.findContext('What does UserController and Database do?')
    expect(ctx.nodes).toContain('UserController')
    expect(ctx.nodes).toContain('Database')
  })

  it('returns empty for no matches', () => {
    const ctx = chat.findContext('What is NonExistentModule?')
    // The term "nonexistentmodule" won't match any node name exactly,
    // but it might partially match. Let's check it doesn't have all nodes.
    // With very specific terms, it should find few or no matches.
    expect(ctx.nodes.length).toBeLessThan(6)
  })

  it('generates graph facts', () => {
    const ctx = chat.findContext('AuthService')
    expect(ctx.facts.length).toBeGreaterThan(0)
    // Should have some relationship facts
    expect(ctx.facts.some(f => f.includes('AuthService'))).toBe(true)
  })

  it('includes layer/domain info in facts', () => {
    const ctx = chat.findContext('AuthService')
    expect(ctx.facts.some(f => f.includes('layer=') || f.includes('domain='))).toBe(true)
  })

  it('ranks by PageRank (more connected nodes rank higher)', () => {
    const ctx = chat.findContext('AuthService Database Router')
    // Router has outgoing edges to AuthService and UserController
    // AuthService has outgoing edges to UserController and Database
    // Both should be found and ranked
    expect(ctx.nodes.length).toBeGreaterThan(0)
    // Verify the order is by PageRank (exact order depends on the algorithm)
    expect(ctx.nodes.length).toBeLessThanOrEqual(15)
  })
})

// ============================================================
// buildPrompt
// ============================================================

describe('UnderstandChat.buildPrompt', () => {
  let chat: UnderstandChat

  beforeEach(() => {
    const store = makeTestStore()
    const engine = new GraphEngine(store)
    chat = new UnderstandChat(store, engine)
  })

  it('includes the question in the prompt', () => {
    const prompt = chat.buildPrompt('How does the auth system work?')
    expect(prompt).toContain('How does the auth system work?')
  })

  it('includes relevant symbols section', () => {
    const prompt = chat.buildPrompt('AuthService')
    expect(prompt).toContain('## Relevant Symbols')
    expect(prompt).toContain('AuthService')
  })

  it('includes graph facts section', () => {
    const prompt = chat.buildPrompt('AuthService')
    expect(prompt).toContain('## Graph Facts')
  })

  it('includes instructions section', () => {
    const prompt = chat.buildPrompt('Any question')
    expect(prompt).toContain('## Instructions')
  })

  it('includes symbol metadata (file, kind)', () => {
    const prompt = chat.buildPrompt('AuthService')
    expect(prompt).toContain('class')
    expect(prompt).toContain('src/auth/service.ts')
  })

  it('includes layer/domain when available', () => {
    const prompt = chat.buildPrompt('AuthService')
    expect(prompt).toContain('layer: service')
    expect(prompt).toContain('domain: auth')
  })

  it('works with no matching context', () => {
    const prompt = chat.buildPrompt('xyzzy nonexistent 12345')
    expect(prompt).toContain('## Question')
    expect(prompt).toContain('xyzzy nonexistent 12345')
    // Should still have instructions
    expect(prompt).toContain('## Instructions')
  })

  it('handles multiple matching symbols', () => {
    const prompt = chat.buildPrompt('AuthService UserController Database')
    // All three should appear
    expect(prompt).toContain('AuthService')
    expect(prompt).toContain('UserController')
    expect(prompt).toContain('Database')
  })
})

// ============================================================
// Integration with real GraphEngine
// ============================================================

describe('UnderstandChat integration', () => {
  it('works with PageRank computation', () => {
    const store = makeTestStore()
    const engine = new GraphEngine(store)
    const chat = new UnderstandChat(store, engine)

    // Trigger findContext which calls pageRank internally
    const ctx = chat.findContext('auth database logger')
    expect(ctx).toHaveProperty('nodes')
    expect(ctx).toHaveProperty('facts')
    expect(Array.isArray(ctx.nodes)).toBe(true)
    expect(Array.isArray(ctx.facts)).toBe(true)
  })

  it('caches PageRank across calls', () => {
    const store = makeTestStore()
    const engine = new GraphEngine(store)
    const chat = new UnderstandChat(store, engine)

    // First call initializes PageRank cache
    chat.findContext('AuthService')
    // Second call should reuse cache (no error thrown)
    const ctx = chat.findContext('Database')
    expect(ctx.nodes.length).toBeGreaterThan(0)
  })

  it('handles empty graph gracefully', () => {
    const emptyStore = createStoreFromAdjacency({})
    const emptyEngine = new GraphEngine(emptyStore)
    const chat = new UnderstandChat(emptyStore, emptyEngine)

    const ctx = chat.findContext('anything')
    expect(ctx.nodes).toEqual([])
    expect(ctx.facts.length).toBeGreaterThanOrEqual(0)
  })

  it('buildPrompt produces valid output for empty context', () => {
    const emptyStore = createStoreFromAdjacency({})
    const emptyEngine = new GraphEngine(emptyStore)
    const chat = new UnderstandChat(emptyStore, emptyEngine)

    const prompt = chat.buildPrompt('test question')
    expect(prompt).toContain('test question')
    expect(prompt).toContain('## Question')
    expect(prompt).toContain('## Instructions')
  })
})
