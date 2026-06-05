/**
 * FtsSearch 测试
 *
 * F-60: FTS5 Search Integration
 * F-61: BM25 Multi-signal Scoring
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { FtsSearch } from '../FtsSearch.js'
import { createStoreFromAdjacency } from './testHelpers.js'
import type { GraphStore } from '../GraphStore.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'

// ============================================================
// Helpers
// ============================================================

function makeTempDbPath(): string {
  return join(tmpdir(), `fts-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
}

function makeStoreWithMeta(): GraphStore {
  const store = createStoreFromAdjacency({
    getData: ['processData'],
    processData: [],
    UserService: [],
    UserModel: [],
    parse_config: [],
  }, `fts-${Date.now()}`)

  // Override metadata with richer info
  store.nodeMeta.set('getData', {
    id: 'getData', name: 'getData', kind: 'function',
    file: 'src/api.ts', line: 10,
    signature: 'getData(id: string): Promise<Data>',
    qualified_name: 'api.getData',
    docstring: 'Fetch data by ID from the remote API',
  })
  store.nodeMeta.set('processData', {
    id: 'processData', name: 'processData', kind: 'function',
    file: 'src/api.ts', line: 25,
    signature: 'processData(data: Data): void',
    qualified_name: 'api.processData',
    docstring: 'Process and transform the fetched data',
  })
  store.nodeMeta.set('UserService', {
    id: 'UserService', name: 'UserService', kind: 'class',
    file: 'src/services/UserService.ts', line: 1,
    signature: 'class UserService',
    qualified_name: 'services.UserService',
    docstring: 'Manages user operations',
  })
  store.nodeMeta.set('UserModel', {
    id: 'UserModel', name: 'UserModel', kind: 'class',
    file: 'src/models/UserModel.ts', line: 1,
    signature: 'class UserModel extends BaseModel',
    qualified_name: 'models.UserModel',
    docstring: 'User data model with validation',
  })
  store.nodeMeta.set('parse_config', {
    id: 'parse_config', name: 'parse_config', kind: 'function',
    file: 'src/config.ts', line: 5,
    signature: 'parse_config(path: string): Config',
    qualified_name: 'config.parse_config',
    docstring: 'Parse configuration file',
  })

  return store
}

// ============================================================
// Tests
// ============================================================

describe('FtsSearch', () => {
  let dbPath: string
  let fts: FtsSearch
  let store: GraphStore

  beforeEach(() => {
    dbPath = makeTempDbPath()
    fts = new FtsSearch(dbPath)
    fts.createIndex()
    store = makeStoreWithMeta()
    fts.indexNodes(store)
  })

  afterEach(() => {
    fts.close()
    if (existsSync(dbPath)) unlinkSync(dbPath)
    // Clean WAL/SHM files
    if (existsSync(dbPath + '-wal')) unlinkSync(dbPath + '-wal')
    if (existsSync(dbPath + '-shm')) unlinkSync(dbPath + '-shm')
  })

  describe('search', () => {
    test('finds nodes by name', () => {
      const results = fts.search('getData')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('getData')
    })

    test('finds nodes by qualified name', () => {
      const results = fts.search('services.UserService')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('UserService')
    })

    test('finds nodes by docstring content', () => {
      const results = fts.search('configuration')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('parse_config')
    })

    test('finds nodes by signature', () => {
      const results = fts.search('Promise')
      expect(results.length).toBeGreaterThan(0)
      expect(results.some(r => r.name === 'getData')).toBe(true)
    })

    test('returns empty for no match', () => {
      const results = fts.search('xyznonexistent')
      expect(results.length).toBe(0)
    })

    test('respects limit parameter', () => {
      const results = fts.search('data', 1)
      expect(results.length).toBeLessThanOrEqual(1)
    })

    test('returns results with scores', () => {
      const results = fts.search('data')
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0)
      }
    })

    test('handles empty query', () => {
      const results = fts.search('')
      expect(results.length).toBe(0)
    })
  })

  describe('searchByKind', () => {
    test('filters by kind', () => {
      const classResults = fts.searchByKind('User', 'class')
      expect(classResults.length).toBeGreaterThan(0)
      for (const r of classResults) {
        expect(r.kind).toBe('class')
      }
    })

    test('returns empty when kind does not match', () => {
      const results = fts.searchByKind('getData', 'class')
      expect(results.length).toBe(0)
    })

    test('function kind filter works', () => {
      const results = fts.searchByKind('data', 'function')
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.kind).toBe('function')
      }
    })
  })

  describe('searchWithBM25', () => {
    test('returns results with BM25 scores', () => {
      const results = fts.searchWithBM25('getData')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('getData')
      expect(results[0].score).toBeGreaterThan(0)
    })

    test('ranks name matches higher than docstring matches', () => {
      // "getData" in name should rank higher than "data" in docstring
      const results = fts.searchWithBM25('getData')
      expect(results[0].name).toBe('getData')
    })

    test('returns empty for no match', () => {
      const results = fts.searchWithBM25('zzznothing')
      expect(results.length).toBe(0)
    })
  })

  describe('createIndex', () => {
    test('is idempotent — calling twice does not error', () => {
      expect(() => fts.createIndex()).not.toThrow()
    })
  })

  describe('close', () => {
    test('closes without error', () => {
      expect(() => fts.close()).not.toThrow()
    })
  })
})
