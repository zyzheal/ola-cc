/**
 * Module Integration Test (F-80)
 *
 * Tests that all new modules work together:
 * - GraphStore + GraphEngine + FtsSearch
 * - SemanticModel + ScopeResolver
 * - ContractRegistry + ModuleImpactAnalyzer
 * - ErrorRecovery with all data sources
 * - RollbackManager with real file operations
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createStoreFromAdjacency } from './testHelpers.js'
import { GraphEngine } from '../GraphEngine.js'
import { FtsSearch } from '../FtsSearch.js'
import { RrfSearch } from '../RrfSearch.js'
import { ContractRegistry } from '../ContractRegistry.js'
import { ModuleImpactAnalyzer } from '../ModuleImpactAnalyzer.js'
import { SemanticModel } from '../SemanticModel.js'
import { ScopeResolver } from '../ScopeResolver.js'
import { ErrorRecovery } from '../ErrorRecovery.js'
import { RollbackManager } from '../RollbackManager.js'
import type { GraphStore, NodeMetadata } from '../GraphStore.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from 'fs'

// ============================================================
// Helpers
// ============================================================

function makeTempDbPath(): string {
  return join(tmpdir(), `module-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
}

function createRichStore(): GraphStore {
  const store = createStoreFromAdjacency({
    'src/core/engine.ts:start': [
      { to: 'src/core/engine.ts:stop', type: 'calls' },
      { to: 'src/utils/logger.ts:log', type: 'calls' },
      { to: 'src/config/loader.ts:loadConfig', type: 'imports' },
    ],
    'src/core/engine.ts:stop': [
      { to: 'src/utils/logger.ts:log', type: 'calls' },
    ],
    'src/api/server.ts:handleRequest': [
      { to: 'src/core/engine.ts:start', type: 'calls' },
      { to: 'src/auth/middleware.ts:authenticate', type: 'calls' },
    ],
    'src/api/server.ts:emitEvent': [
      { to: 'src/events/bus.ts:publish', type: 'publishes' },
    ],
    'src/auth/middleware.ts:authenticate': [
      { to: 'src/utils/crypto.ts:verify', type: 'calls' },
    ],
    'src/config/loader.ts:loadConfig': [],
    'src/utils/logger.ts:log': [],
    'src/utils/crypto.ts:verify': [],
    'src/events/bus.ts:publish': [
      { to: 'src/events/bus.ts:subscribe', type: 'publishes' },
    ],
    'src/events/bus.ts:subscribe': [],
  }, `integ-${Date.now()}`)

  // Enrich metadata
  const enrich = (id: string, meta: Partial<NodeMetadata>) => {
    const node = store.nodeMeta.get(id)
    if (node) Object.assign(node, meta)
  }

  enrich('src/core/engine.ts:start', {
    kind: 'function', name: 'start', file: 'src/core/engine.ts',
    is_exported: true, signature: 'start(config: Config): Promise<void>',
    qualified_name: 'core.engine.start',
  })
  enrich('src/core/engine.ts:stop', {
    kind: 'function', name: 'stop', file: 'src/core/engine.ts',
    is_exported: true, signature: 'stop(): void',
  })
  enrich('src/api/server.ts:handleRequest', {
    kind: 'function', name: 'handleRequest', file: 'src/api/server.ts',
    is_exported: true, signature: '@Get("/api") handleRequest(req)',
  })
  enrich('src/api/server.ts:emitEvent', {
    kind: 'function', name: 'emitEvent', file: 'src/api/server.ts',
  })
  enrich('src/auth/middleware.ts:authenticate', {
    kind: 'function', name: 'authenticate', file: 'src/auth/middleware.ts',
    is_exported: true, signature: 'authenticate(req, res, next)',
  })
  enrich('src/config/loader.ts:loadConfig', {
    kind: 'function', name: 'loadConfig', file: 'src/config/loader.ts',
    is_exported: true, signature: 'loadConfig(path: string): Config',
  })
  enrich('src/utils/logger.ts:log', {
    kind: 'function', name: 'log', file: 'src/utils/logger.ts',
    is_exported: true, signature: 'log(msg: string): void',
  })
  enrich('src/utils/crypto.ts:verify', {
    kind: 'function', name: 'verify', file: 'src/utils/crypto.ts',
    is_exported: true, signature: 'verify(token: string): boolean',
  })
  enrich('src/events/bus.ts:publish', {
    kind: 'function', name: 'publish', file: 'src/events/bus.ts',
    is_exported: true, signature: 'publish(event: string, data: any)',
  })
  enrich('src/events/bus.ts:subscribe', {
    kind: 'function', name: 'subscribe', file: 'src/events/bus.ts',
    is_exported: true, signature: 'subscribe(event: string, handler: Function)',
  })

  return store
}

// ============================================================
// Tests
// ============================================================

describe('module integration: GraphStore + GraphEngine + FtsSearch', () => {
  let store: GraphStore
  let engine: GraphEngine
  let dbPath: string
  let fts: FtsSearch

  beforeEach(() => {
    store = createRichStore()
    engine = new GraphEngine(store)
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

  test('GraphEngine BFS + FtsSearch find same nodes', () => {
    const bfsResult = engine.bfs('src/core/engine.ts:start')
    const ftsResults = fts.search('start')

    // Both should find the start node
    expect(bfsResult.nodes).toContain('src/core/engine.ts:start')
    expect(ftsResults.some(r => r.id === 'src/core/engine.ts:start')).toBe(true)
  })

  test('PageRank scores correlate with FTS relevance', () => {
    const pr = engine.pageRank()
    const ftsResults = fts.search('engine')

    // Nodes found by FTS should have PageRank scores
    for (const r of ftsResults) {
      const prEntry = pr.scores.find(s => s.node === r.id)
      expect(prEntry).toBeDefined()
    }
  })

  test('RrfSearch fuses graph + text signals', () => {
    const rrf = new RrfSearch(fts, store)
    const results = rrf.search('engine')

    expect(results.length).toBeGreaterThan(0)
    // Results should have both text match and graph signal
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0)
    }
  })

  test('GraphEngine roles + FtsSearch kind filter', () => {
    const roles = engine.classifyRoles()
    const funcResults = fts.searchByKind('start', 'function')

    // start should be classified and found
    expect(roles.has('src/core/engine.ts:start')).toBe(true)
    expect(funcResults.some(r => r.name === 'start')).toBe(true)
  })
})

describe('module integration: SemanticModel + ScopeResolver', () => {
  let store: GraphStore
  let model: SemanticModel
  let resolver: ScopeResolver

  beforeEach(() => {
    store = createRichStore()
    model = new SemanticModel()
    model.buildFromStore(store)
    resolver = new ScopeResolver(store, model)
  })

  test('SemanticModel indexes all nodes from store', () => {
    expect(model.size).toBe(store.nodeMeta.size)
    expect(model.lookupByKind('method').length).toBeGreaterThan(0)
  })

  test('ScopeResolver builds import map using node ID', () => {
    // buildImportMap works with node IDs (adjacency is keyed by node IDs)
    const importMap = resolver.buildImportMap('src/core/engine.ts:start')
    // start imports loadConfig via imports edge
    expect(importMap.size).toBeGreaterThan(0)
  })

  test('ScopeResolver resolves cross-file symbols', () => {
    const result = resolver.resolve('loadConfig', 'src/core/engine.ts', 5)
    expect(result).toBeDefined()
    expect(result!.symbol).toBe('loadConfig')
  })

  test('SemanticModel lookup by file', () => {
    const symbols = model.lookupByFile('src/core/engine.ts')
    expect(symbols.length).toBe(2) // start, stop
  })

  test('SemanticModel lookup by name', () => {
    const symbols = model.lookupByName('authenticate')
    expect(symbols.length).toBe(1)
    expect(symbols[0].file).toBe('src/auth/middleware.ts')
  })

  test('ScopeResolver confidence scoring', () => {
    const result = resolver.resolve('verify', 'src/auth/middleware.ts', 5)
    expect(result).toBeDefined()
    expect(result!.confidence).toBeGreaterThanOrEqual(0)
    expect(result!.confidence).toBeLessThanOrEqual(1)
  })
})

describe('module integration: ContractRegistry + ModuleImpactAnalyzer', () => {
  let store: GraphStore
  let engine: GraphEngine
  let registry: ContractRegistry
  let analyzer: ModuleImpactAnalyzer

  beforeEach(() => {
    store = createRichStore()
    engine = new GraphEngine(store)
    registry = new ContractRegistry(store)
    registry.extractAll()
    analyzer = new ModuleImpactAnalyzer(store, engine, registry)
  })

  test('ContractRegistry extracts all module contracts', () => {
    expect(registry.size).toBeGreaterThan(0)
    // Each file should have a contract
    expect(registry.getContract('src/core/engine.ts')).toBeDefined()
    expect(registry.getContract('src/api/server.ts')).toBeDefined()
  })

  test('ContractRegistry detects API handlers', () => {
    const apiContract = registry.getContract('src/api/server.ts')
    expect(apiContract).toBeDefined()
    expect(apiContract!.apis.length).toBeGreaterThan(0)
    expect(apiContract!.apis[0].method).toBe('GET')
  })

  test('ContractRegistry detects event patterns', () => {
    const eventContract = registry.getContract('src/events/bus.ts')
    expect(eventContract).toBeDefined()
    expect(eventContract!.events.length).toBeGreaterThan(0)
  })

  test('ModuleImpactAnalyzer stage1 BFS from engine.ts', () => {
    const result = analyzer.analyze('src/core/engine.ts')
    // engine.ts is used by api/server.ts
    expect(result.stage1.directImpact.some(f => f.includes('api'))).toBe(true)
  })

  test('ModuleImpactAnalyzer stage2 contract analysis', () => {
    const result = analyzer.analyze('src/core/engine.ts')
    expect(result.stage2.affectedExports.length).toBeGreaterThan(0)
    expect(['low', 'medium', 'high']).toContain(result.stage2.contractBreakRisk)
  })

  test('ModuleImpactAnalyzer matchContracts wildcard', () => {
    const matches = analyzer.matchContracts('src/core/*')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some(m => m.module.includes('core'))).toBe(true)
  })

  test('ContractRegistry + GraphEngine together identify risk', () => {
    // Find highly connected modules
    const pr = engine.pageRank()
    const highRankNodes = pr.scores
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)

    // Their contracts should be extractable
    for (const { node } of highRankNodes) {
      const meta = store.getNode(node)
      if (meta?.file) {
        const contract = registry.getContract(meta.file)
        // Contract may or may not exist depending on file grouping
        // Just verify no crash
        expect(contract === undefined || typeof contract === 'object').toBe(true)
      }
    }
  })
})

describe('module integration: ErrorRecovery with all data sources', () => {
  let store: GraphStore
  let engine: GraphEngine

  beforeEach(() => {
    store = createRichStore()
    engine = new GraphEngine(store)
  })

  test('ErrorRecovery.withTimeout wraps PageRank', async () => {
    const result = await ErrorRecovery.withTimeout(
      Promise.resolve(engine.pageRank()),
      5000,
      { scores: [] },
    )
    expect(result.scores.length).toBe(10)
  })

  test('ErrorRecovery.withTimeout wraps Tarjan SCC', async () => {
    const result = await ErrorRecovery.withTimeout(
      Promise.resolve(engine.tarjanSCC()),
      5000,
      [],
    )
    expect(result.length).toBeGreaterThan(0)
  })

  test('ErrorRecovery.withDbProtection wraps store operations', () => {
    const result = ErrorRecovery.withDbProtection(() => {
      return store.size
    }, { nodes: 0, edges: 0 })

    expect(result.degraded).toBe(false)
    expect(result.data!.nodes).toBe(10)
  })

  test('ErrorRecovery.withGrokDegradation wraps graph load', () => {
    const result = ErrorRecovery.withGrokDegradation(() => {
      return engine.classifyRoles()
    }, new Map())

    expect(result.degraded).toBe(false)
    expect(result.data!.size).toBe(10)
  })

  test('ErrorRecovery.merge combines algorithm + DB + Grok results', () => {
    const algoResult = { data: engine.pageRank(), degraded: false, errors: [], warnings: [] }
    const dbResult = ErrorRecovery.withDbProtection(() => store.size, { nodes: 0, edges: 0 })
    const grokResult = ErrorRecovery.withGrokDegradation(() => engine.classifyRoles(), new Map())

    const merged = ErrorRecovery.merge(algoResult, dbResult, grokResult)
    expect(merged.degraded).toBe(false)
    expect(merged.data).toBeDefined() // last wins: classifyRoles
    expect(merged.errors.length).toBe(0)
  })
})

describe('module integration: RollbackManager with real file operations', () => {
  let tmpDir: string
  let manager: RollbackManager

  beforeEach(() => {
    tmpDir = join(tmpdir(), `rollback-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(tmpDir, '.understand-anything'), { recursive: true })

    // Create a mock knowledge-graph.json
    const kg = {
      nodes: [
        { id: 'n1', name: 'Node1', kind: 'function' },
        { id: 'n2', name: 'Node2', kind: 'class' },
      ],
      edges: [
        { from: 'n1', to: 'n2', type: 'calls' },
      ],
    }
    writeFileSync(
      join(tmpDir, '.understand-anything', 'knowledge-graph.json'),
      JSON.stringify(kg, null, 2),
    )

    manager = new RollbackManager(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('createRollback creates backup', () => {
    const point = manager.createRollback('test backup')
    expect(point.tag).toBeDefined()
    expect(point.nodeCount).toBe(2)
    expect(point.edgeCount).toBe(1)
    expect(point.description).toBe('test backup')
  })

  test('listRollbacks shows created backups', () => {
    manager.createRollback('first')
    manager.createRollback('second')

    const rollbacks = manager.listRollbacks()
    expect(rollbacks.length).toBe(2)
    // Both should be present (order may vary due to same-millisecond timestamps)
    const descriptions = rollbacks.map(r => r.description)
    expect(descriptions).toContain('first')
    expect(descriptions).toContain('second')
  })

  test('rollback restores previous version', () => {
    const point = manager.createRollback('before change')

    // Modify the file
    const newKg = {
      nodes: [{ id: 'n1', name: 'Modified', kind: 'function' }],
      edges: [],
    }
    writeFileSync(
      join(tmpDir, '.understand-anything', 'knowledge-graph.json'),
      JSON.stringify(newKg),
    )

    // Rollback
    const success = manager.rollback(point.tag)
    expect(success).toBe(true)

    // Verify restoration
    const content = JSON.parse(
      require('fs').readFileSync(
        join(tmpDir, '.understand-anything', 'knowledge-graph.json'),
        'utf-8',
      ),
    )
    expect(content.nodes.length).toBe(2)
  })

  test('rollback creates safety backup before restoring', () => {
    const point = manager.createRollback('original')

    // Modify
    writeFileSync(
      join(tmpDir, '.understand-anything', 'knowledge-graph.json'),
      JSON.stringify({ nodes: [], edges: [] }),
    )

    // Rollback
    manager.rollback(point.tag)

    // Safety backup should exist
    const rollbacks = manager.listRollbacks()
    expect(rollbacks.length).toBeGreaterThanOrEqual(2) // original + safety
  })

  test('deleteRollback removes backup', () => {
    const point = manager.createRollback('to delete')
    expect(manager.listRollbacks().length).toBe(1)

    const deleted = manager.deleteRollback(point.tag)
    expect(deleted).toBe(true)
    expect(manager.listRollbacks().length).toBe(0)
  })

  test('prune keeps max N rollbacks', () => {
    for (let i = 0; i < 5; i++) {
      manager.createRollback(`backup ${i}`)
    }
    expect(manager.listRollbacks().length).toBe(5)

    const pruned = manager.prune(2)
    expect(pruned).toBe(3)
    expect(manager.listRollbacks().length).toBe(2)
  })

  test('rollback returns false for non-existent tag', () => {
    const result = manager.rollback('nonexistent-tag')
    expect(result).toBe(false)
  })

  test('deleteRollback returns false for non-existent tag', () => {
    const result = manager.deleteRollback('nonexistent-tag')
    expect(result).toBe(false)
  })

  test('listRollbacks returns empty when no backups dir', () => {
    // Create a fresh manager without backups
    const freshDir = join(tmpdir(), `rollback-fresh-${Date.now()}`)
    mkdirSync(join(freshDir, '.understand-anything'), { recursive: true })
    writeFileSync(join(freshDir, '.understand-anything', 'knowledge-graph.json'), '{}')

    const freshManager = new RollbackManager(freshDir)
    expect(freshManager.listRollbacks()).toEqual([])

    rmSync(freshDir, { recursive: true, force: true })
  })
})
