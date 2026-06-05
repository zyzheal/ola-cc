/**
 * RrfSearch 测试
 *
 * F-82: RRF Hybrid Search Fusion
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { RrfSearch } from '../RrfSearch.js'
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
  return join(tmpdir(), `rrf-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
}

function makeStore(): GraphStore {
  const store = createStoreFromAdjacency({
    getData: ['processData'],
    processData: [],
    UserService: [],
    UserModel: [],
    parse_config: [],
    getUser: ['getData'],
  }, `rrf-${Date.now()}`)

  store.nodeMeta.set('getData', {
    id: 'getData', name: 'getData', kind: 'function',
    file: 'src/api.ts', line: 10,
    signature: 'getData(id: string): Promise<Data>',
    qualified_name: 'api.getData',
    docstring: 'Fetch data by ID',
  })
  store.nodeMeta.set('processData', {
    id: 'processData', name: 'processData', kind: 'function',
    file: 'src/api.ts', line: 25,
    signature: 'processData(data: Data): void',
    qualified_name: 'api.processData',
  })
  store.nodeMeta.set('UserService', {
    id: 'UserService', name: 'UserService', kind: 'class',
    file: 'src/services/UserService.ts', line: 1,
    signature: 'class UserService',
    qualified_name: 'services.UserService',
    docstring: 'Manages user operations and data access',
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
  store.nodeMeta.set('getUser', {
    id: 'getUser', name: 'getUser', kind: 'function',
    file: 'src/api.ts', line: 40,
    signature: 'getUser(id: string): Promise<User>',
    qualified_name: 'api.getUser',
    docstring: 'Get user by ID',
  })

  return store
}

// ============================================================
// Tests
// ============================================================

describe('RrfSearch', () => {
  let dbPath: string
  let fts: FtsSearch
  let rrf: RrfSearch
  let store: GraphStore

  beforeEach(() => {
    dbPath = makeTempDbPath()
    fts = new FtsSearch(dbPath)
    fts.createIndex()
    store = makeStore()
    fts.indexNodes(store)
    rrf = new RrfSearch(fts, store)
  })

  afterEach(() => {
    fts.close()
    if (existsSync(dbPath)) unlinkSync(dbPath)
    if (existsSync(dbPath + '-wal')) unlinkSync(dbPath + '-wal')
    if (existsSync(dbPath + '-shm')) unlinkSync(dbPath + '-shm')
  })

  describe('search', () => {
    test('returns results for valid query', () => {
      const results = rrf.search('getData')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('getData')
    })

    test('returns empty for no match', () => {
      const results = rrf.search('zzznothing')
      expect(results.length).toBe(0)
    })

    test('respects limit', () => {
      const results = rrf.search('data', 2)
      expect(results.length).toBeLessThanOrEqual(2)
    })

    test('results are sorted by RRF score descending', () => {
      const results = rrf.search('User')
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    test('graph signal boosts nodes with higher in-degree', () => {
      // getData has incoming edges (getUser -> getData), so it should get a boost
      const results = rrf.search('getData')
      expect(results.length).toBeGreaterThan(0)
      // getData should be top result (exact match + graph signal)
      expect(results[0].name).toBe('getData')
    })
  })

  describe('PascalCase boost', () => {
    test('boosts class/interface kinds for PascalCase query', () => {
      const results = rrf.search('UserService')
      expect(results.length).toBeGreaterThan(0)
      // UserService (class) should rank high
      const topNames = results.slice(0, 3).map(r => r.name)
      expect(topNames).toContain('UserService')
    })
  })

  describe('snake_case boost', () => {
    test('boosts function/method kinds for snake_case query', () => {
      const results = rrf.search('parse_config')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('parse_config')
    })
  })

  describe('camelCase boost', () => {
    test('boosts method/property kinds for camelCase query', () => {
      const results = rrf.search('getData')
      expect(results.length).toBeGreaterThan(0)
      // getData is a function, should rank high
      expect(results[0].name).toBe('getData')
    })
  })

  describe('constructor', () => {
    test('accepts custom k parameter', () => {
      const rrfCustom = new RrfSearch(fts, store, 100)
      const results = rrfCustom.search('getData')
      expect(results.length).toBeGreaterThan(0)
    })

    test('uses default k=60', () => {
      const results = rrf.search('getData')
      expect(results.length).toBeGreaterThan(0)
    })
  })
})
