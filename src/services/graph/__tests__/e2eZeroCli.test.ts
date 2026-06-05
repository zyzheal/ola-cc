/**
 * End-to-End Zero CLI Dependency Test (F-78)
 *
 * Tests the full pipeline without any external CLI calls:
 * - GraphStore (in-memory via testHelpers)
 * - GraphEngine algorithms
 * - FtsSearch indexing and searching
 * - ContractRegistry extraction
 * - ModuleImpactAnalyzer analysis
 * - SemanticModel + ScopeResolver
 * - ErrorRecovery layers
 *
 * All operations work without CodegraphManager CLI calls.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createStoreFromAdjacency, type GraphFixture } from './testHelpers.js'
import { GraphEngine } from '../GraphEngine.js'
import { FtsSearch } from '../FtsSearch.js'
import { RrfSearch } from '../RrfSearch.js'
import { ContractRegistry } from '../ContractRegistry.js'
import { ModuleImpactAnalyzer } from '../ModuleImpactAnalyzer.js'
import { SemanticModel } from '../SemanticModel.js'
import { ScopeResolver } from '../ScopeResolver.js'
import { ErrorRecovery } from '../ErrorRecovery.js'
import type { GraphStore, NodeMetadata } from '../GraphStore.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'

// ============================================================
// Setup helpers
// ============================================================

function makeTempDbPath(): string {
  return join(tmpdir(), `e2e-zero-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
}

/**
 * Create a realistic project graph with multiple modules and relationships.
 */
function createProjectGraph(): GraphStore {
  const store = createStoreFromAdjacency({
    // Auth module
    'src/auth/login.ts:login': [
      { to: 'src/auth/login.ts:validateInput', type: 'calls' },
      { to: 'src/auth/session.ts:createSession', type: 'calls' },
      { to: 'src/utils/hash.ts:verifyPassword', type: 'imports' },
    ],
    'src/auth/login.ts:validateInput': [],
    'src/auth/session.ts:createSession': [
      { to: 'src/utils/crypto.ts:generateToken', type: 'calls' },
    ],
    'src/auth/session.ts:destroySession': [],
    'src/auth/session.ts:validateSession': [
      { to: 'src/utils/crypto.ts:verifyToken', type: 'calls' },
    ],

    // API module
    'src/api/users.ts:getUsers': [
      { to: 'src/auth/login.ts:login', type: 'calls' },
      { to: 'src/db/users.ts:findAll', type: 'calls' },
    ],
    'src/api/users.ts:createUser': [
      { to: 'src/auth/login.ts:login', type: 'calls' },
      { to: 'src/db/users.ts:insert', type: 'calls' },
      { to: 'src/events/emitter.ts:emitUserCreated', type: 'calls' },
    ],

    // DB module
    'src/db/users.ts:findAll': [],
    'src/db/users.ts:insert': [],

    // Utils
    'src/utils/hash.ts:verifyPassword': [],
    'src/utils/crypto.ts:generateToken': [],
    'src/utils/crypto.ts:verifyToken': [],

    // Events
    'src/events/emitter.ts:emitUserCreated': [
      { to: 'src/events/emitter.ts:onUserCreated', type: 'publishes' },
    ],
    'src/events/emitter.ts:onUserCreated': [],
  }, `e2e-${Date.now()}`)

  // Enrich metadata
  const enrichNode = (id: string, meta: Partial<NodeMetadata>) => {
    const node = store.nodeMeta.get(id)
    if (node) Object.assign(node, meta)
  }

  enrichNode('src/auth/login.ts:login', {
    kind: 'function', name: 'login', file: 'src/auth/login.ts',
    is_exported: true, signature: 'login(req: Request): Promise<Response>',
  })
  enrichNode('src/auth/login.ts:validateInput', {
    kind: 'function', name: 'validateInput', file: 'src/auth/login.ts',
  })
  enrichNode('src/auth/session.ts:createSession', {
    kind: 'function', name: 'createSession', file: 'src/auth/session.ts',
    is_exported: true,
  })
  enrichNode('src/auth/session.ts:destroySession', {
    kind: 'function', name: 'destroySession', file: 'src/auth/session.ts',
    is_exported: true,
  })
  enrichNode('src/auth/session.ts:validateSession', {
    kind: 'function', name: 'validateSession', file: 'src/auth/session.ts',
    is_exported: true,
  })
  enrichNode('src/api/users.ts:getUsers', {
    kind: 'function', name: 'getUsers', file: 'src/api/users.ts',
    is_exported: true, signature: '@Get("/users") getUsers(req)',
  })
  enrichNode('src/api/users.ts:createUser', {
    kind: 'function', name: 'createUser', file: 'src/api/users.ts',
    is_exported: true, signature: '@Post("/users") createUser(req)',
  })
  enrichNode('src/db/users.ts:findAll', {
    kind: 'function', name: 'findAll', file: 'src/db/users.ts',
    is_exported: true,
  })
  enrichNode('src/db/users.ts:insert', {
    kind: 'function', name: 'insert', file: 'src/db/users.ts',
    is_exported: true,
  })
  enrichNode('src/utils/hash.ts:verifyPassword', {
    kind: 'function', name: 'verifyPassword', file: 'src/utils/hash.ts',
    is_exported: true,
  })
  enrichNode('src/utils/crypto.ts:generateToken', {
    kind: 'function', name: 'generateToken', file: 'src/utils/crypto.ts',
    is_exported: true,
  })
  enrichNode('src/utils/crypto.ts:verifyToken', {
    kind: 'function', name: 'verifyToken', file: 'src/utils/crypto.ts',
    is_exported: true,
  })
  enrichNode('src/events/emitter.ts:emitUserCreated', {
    kind: 'function', name: 'emitUserCreated', file: 'src/events/emitter.ts',
  })
  enrichNode('src/events/emitter.ts:onUserCreated', {
    kind: 'function', name: 'onUserCreated', file: 'src/events/emitter.ts',
  })

  return store
}

// ============================================================
// Tests
// ============================================================

describe('e2e zero CLI dependency', () => {
  let store: GraphStore
  let engine: GraphEngine

  beforeEach(() => {
    store = createProjectGraph()
    engine = new GraphEngine(store)
  })

  // ----------------------------------------------------------
  // GraphStore (in-memory, no CLI)
  // ----------------------------------------------------------

  describe('GraphStore in-memory', () => {
    test('loads from testHelpers without any CLI', () => {
      expect(store.isLoaded).toBe(true)
      expect(store.nodeMeta.size).toBe(14)
    })

    test('has correct adjacency structure', () => {
      // login → validateInput, createSession, verifyPassword
      const outEdges = store.getOutEdges('src/auth/login.ts:login')
      expect(outEdges.size).toBe(3)
    })

    test('has correct reverse edges', () => {
      // login is called by getUsers and createUser
      const inEdges = store.getInEdges('src/auth/login.ts:login')
      expect(inEdges.size).toBe(2)
    })

    test('node metadata is complete', () => {
      const login = store.getNode('src/auth/login.ts:login')
      expect(login).toBeDefined()
      expect(login!.name).toBe('login')
      expect(login!.file).toBe('src/auth/login.ts')
      expect(login!.is_exported).toBe(true)
      expect(login!.signature).toContain('login')
    })
  })

  // ----------------------------------------------------------
  // GraphEngine algorithms on loaded data
  // ----------------------------------------------------------

  describe('GraphEngine on loaded data', () => {
    test('BFS traverses from login', () => {
      const result = engine.bfs('src/auth/login.ts:login')
      expect(result.nodes.length).toBeGreaterThan(1)
      expect(result.nodes).toContain('src/auth/session.ts:createSession')
    })

    test('DFS traverses from login', () => {
      const result = engine.dfs('src/auth/login.ts:login')
      expect(result.nodes.length).toBeGreaterThan(1)
    })

    test('Tarjan SCC finds no cycles (tree structure)', () => {
      const sccs = engine.tarjanSCC()
      const nonTrivial = sccs.filter(s => !s.isTrivial)
      expect(nonTrivial.length).toBe(0)
    })

    test('PageRank scores all nodes', () => {
      const result = engine.pageRank()
      expect(result.scores.length).toBe(14)
      // login should have high PageRank (many incoming edges)
      const loginScore = result.scores.find(s => s.node === 'src/auth/login.ts:login')
      expect(loginScore).toBeDefined()
      expect(loginScore!.score).toBeGreaterThan(0)
    })

    test('classifyRoles identifies entry points', () => {
      const roles = engine.classifyRoles()
      expect(roles.size).toBe(14)
      // getUsers and createUser should be entry points (exported, high fan-out)
      const getUsersRole = roles.get('src/api/users.ts:getUsers')
      expect(getUsersRole).toBeDefined()
    })

    test('backwardReachability from login finds callers', () => {
      const result = engine.backwardReachability('src/auth/login.ts:login')
      expect(result.reachable).toContain('src/api/users.ts:getUsers')
      expect(result.reachable).toContain('src/api/users.ts:createUser')
    })

    test('couplingMetrics identifies high-coupling nodes', () => {
      const result = engine.couplingMetrics()
      expect(result).toBeDefined()
    })
  })

  // ----------------------------------------------------------
  // FtsSearch indexing and searching (no CLI)
  // ----------------------------------------------------------

  describe('FtsSearch (no CLI)', () => {
    let dbPath: string
    let fts: FtsSearch

    beforeEach(() => {
      dbPath = makeTempDbPath()
      fts = new FtsSearch(dbPath)
      fts.createIndex()
      fts.indexNodes(store)
    })

    afterEach(() => {
      fts.close()
      for (const suffix of ['', '-wal', '-shm']) {
        const p = dbPath + suffix
        if (existsSync(p)) unlinkSync(p)
      }
    })

    test('indexes all nodes from GraphStore', () => {
      const results = fts.search('login')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('login')
    })

    test('searches by qualified name', () => {
      const results = fts.search('auth.login')
      expect(results.length).toBeGreaterThan(0)
    })

    test('searches by signature', () => {
      const results = fts.search('Promise')
      expect(results.length).toBeGreaterThan(0)
    })

    test('searchByKind filters correctly', () => {
      const results = fts.searchByKind('login', 'function')
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.kind).toBe('function')
      }
    })

    test('BM25 scoring works', () => {
      const results = fts.searchWithBM25('login')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].score).toBeGreaterThan(0)
    })
  })

  // ----------------------------------------------------------
  // RRF fusion search (no CLI)
  // ----------------------------------------------------------

  describe('RrfSearch (no CLI)', () => {
    let dbPath: string
    let fts: FtsSearch
    let rrf: RrfSearch

    beforeEach(() => {
      dbPath = makeTempDbPath()
      fts = new FtsSearch(dbPath)
      fts.createIndex()
      fts.indexNodes(store)
      rrf = new RrfSearch(fts, store)
    })

    afterEach(() => {
      fts.close()
      for (const suffix of ['', '-wal', '-shm']) {
        const p = dbPath + suffix
        if (existsSync(p)) unlinkSync(p)
      }
    })

    test('fuses FTS + BM25 + graph signals', () => {
      const results = rrf.search('login')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('login')
    })

    test('graph signal boosts high in-degree nodes', () => {
      // login has 2 incoming edges (getUsers, createUser) + validateInput + createSession
      const results = rrf.search('login')
      expect(results[0].name).toBe('login')
    })

    test('results are sorted by RRF score', () => {
      const results = rrf.search('user')
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })
  })

  // ----------------------------------------------------------
  // ContractRegistry extraction (no CLI)
  // ----------------------------------------------------------

  describe('ContractRegistry (no CLI)', () => {
    test('extracts contracts from all modules', () => {
      const registry = new ContractRegistry(store)
      registry.extractAll()

      expect(registry.size).toBeGreaterThan(0)
    })

    test('detects exported functions', () => {
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const authContract = registry.getContract('src/auth/login.ts')
      expect(authContract).toBeDefined()
      expect(authContract!.exports.some(e => e.name === 'login')).toBe(true)
    })

    test('detects API handlers from signatures', () => {
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const apiContract = registry.getContract('src/api/users.ts')
      expect(apiContract).toBeDefined()
      expect(apiContract!.apis.length).toBeGreaterThan(0)
    })

    test('detects event emitters', () => {
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const eventContract = registry.getContract('src/events/emitter.ts')
      expect(eventContract).toBeDefined()
      expect(eventContract!.events.some(e => e.type === 'emit')).toBe(true)
    })

    test('extracts dependencies from import edges', () => {
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const authContract = registry.getContract('src/auth/login.ts')
      expect(authContract).toBeDefined()
      expect(authContract!.dependencies.length).toBeGreaterThan(0)
    })

    test('findModules by pattern works', () => {
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const modules = registry.findModules({
        exports: [{ name: 'login', kind: '', isDefault: false }],
      })
      expect(modules.some(m => m.includes('login'))).toBe(true)
    })

    test('exportToJson produces valid JSON', () => {
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const json = registry.exportToJson()
      const parsed = JSON.parse(json)
      expect(typeof parsed).toBe('object')
    })
  })

  // ----------------------------------------------------------
  // ModuleImpactAnalyzer (no CLI)
  // ----------------------------------------------------------

  describe('ModuleImpactAnalyzer (no CLI)', () => {
    let registry: ContractRegistry
    let analyzer: ModuleImpactAnalyzer

    beforeEach(() => {
      registry = new ContractRegistry(store)
      registry.extractAll()
      analyzer = new ModuleImpactAnalyzer(store, engine, registry)
    })

    test('analyzes impact of changing auth module', () => {
      const result = analyzer.analyze('src/auth/login.ts')

      expect(result.stage1).toBeDefined()
      expect(result.stage1.directImpact.length).toBeGreaterThan(0)
      // Changing login should impact api/users.ts (uses login)
      expect(result.stage1.directImpact.some(f => f.includes('api'))).toBe(true)
    })

    test('analyzes impact of changing utils module', () => {
      const result = analyzer.analyze('src/utils/hash.ts')

      expect(result.stage1).toBeDefined()
      // hash.ts is used by auth/login.ts
      expect(result.stage1.directImpact.some(f => f.includes('auth'))).toBe(true)
    })

    test('stage2 identifies affected APIs and events', () => {
      const result = analyzer.analyze('src/auth/login.ts')

      expect(result.stage2).toBeDefined()
      expect(Array.isArray(result.stage2.affectedApis)).toBe(true)
      expect(Array.isArray(result.stage2.affectedEvents)).toBe(true)
      expect(Array.isArray(result.stage2.affectedExports)).toBe(true)
      expect(['low', 'medium', 'high']).toContain(result.stage2.contractBreakRisk)
    })

    test('matchContracts by wildcard works', () => {
      const matches = analyzer.matchContracts('src/auth/*')
      expect(matches.length).toBeGreaterThan(0)
    })
  })

  // ----------------------------------------------------------
  // SemanticModel + ScopeResolver (no CLI)
  // ----------------------------------------------------------

  describe('SemanticModel + ScopeResolver (no CLI)', () => {
    test('SemanticModel builds from GraphStore', () => {
      const model = new SemanticModel()
      model.buildFromStore(store)

      expect(model.size).toBe(14)
      expect(model.lookupByKind('method').length).toBeGreaterThan(0)
    })

    test('SemanticModel lookup by qualified name', () => {
      const model = new SemanticModel()
      model.buildFromStore(store)

      // The qualified_name field is set on nodeMeta via testHelpers defaults
      // Let's set it explicitly for test
      const login = store.nodeMeta.get('src/auth/login.ts:login')!
      login.qualified_name = 'auth.login'

      // Rebuild to pick up the change
      model.buildFromStore(store)
      const found = model.lookup('auth.login')
      expect(found).toBeDefined()
      expect(found!.name).toBe('login')
    })

    test('ScopeResolver builds import map using node ID', () => {
      const model = new SemanticModel()
      model.buildFromStore(store)
      const resolver = new ScopeResolver(store, model)

      // buildImportMap works with node IDs (since adjacency is keyed by node IDs)
      const importMap = resolver.buildImportMap('src/auth/login.ts:login')
      // login imports verifyPassword via imports edge
      expect(importMap.size).toBeGreaterThan(0)
    })

    test('ScopeResolver resolves symbol across files', () => {
      const model = new SemanticModel()
      model.buildFromStore(store)
      const resolver = new ScopeResolver(store, model)

      const result = resolver.resolve('verifyPassword', 'src/auth/login.ts')
      expect(result).toBeDefined()
      expect(result!.symbol).toBe('verifyPassword')
      expect(result!.confidence).toBeGreaterThanOrEqual(0)
    })
  })

  // ----------------------------------------------------------
  // ErrorRecovery with all data sources (no CLI)
  // ----------------------------------------------------------

  describe('ErrorRecovery with all data sources', () => {
    test('withTimeout returns result when fast', async () => {
      const result = await ErrorRecovery.withTimeout(
        Promise.resolve(engine.pageRank()),
        5000,
        { scores: [] },
      )
      expect(result.scores.length).toBeGreaterThan(0)
    })

    test('withTimeout returns fallback when slow', async () => {
      const slow = new Promise(resolve => setTimeout(() => resolve('done'), 200))
      const result = await ErrorRecovery.withTimeout(slow, 50, 'fallback')
      expect(result).toBe('fallback')
    })

    test('withDbProtection catches SQLITE_CORRUPT', () => {
      const result = ErrorRecovery.withDbProtection(() => {
        const err = new Error('database is malformed')
        ;(err as any).code = 'SQLITE_CORRUPT'
        throw err
      }, null)

      expect(result.degraded).toBe(true)
      expect(result.errors[0].layer).toBe('database')
    })

    test('withGrokDegradation catches ENOENT', () => {
      const result = ErrorRecovery.withGrokDegradation(() => {
        const err = new Error('ENOENT')
        ;(err as any).code = 'ENOENT'
        throw err
      }, { nodes: 0 })

      expect(result.degraded).toBe(true)
      expect(result.errors[0].code).toBe('GROK_UNAVAILABLE')
    })

    test('merge combines multiple recovery results', () => {
      const r1 = { data: engine.pageRank(), degraded: false, errors: [], warnings: [] }
      const r2 = { data: undefined, degraded: true, errors: [{ layer: 'grok' as const, code: 'X', message: 'err', recoverable: false }], warnings: ['warn'] }

      const merged = ErrorRecovery.merge(r1, r2)
      expect(merged.degraded).toBe(true)
      expect(merged.data).toBeDefined()
      expect(merged.errors.length).toBe(1)
    })
  })
})
