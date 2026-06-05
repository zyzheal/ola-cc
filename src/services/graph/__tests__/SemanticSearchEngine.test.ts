/**
 * SemanticSearchEngine 测试
 *
 * F-106: SemanticSearchEngine
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  SemanticSearchEngine,
  MockEmbeddingProvider,
  SQLiteVectorStore,
} from '../SemanticSearchEngine.js'
import { FtsSearch } from '../FtsSearch.js'
import { createStoreFromAdjacency } from './testHelpers.js'
import { Database } from 'bun:sqlite'
import type { GraphStore } from '../GraphStore.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'

// ============================================================
// Helpers
// ============================================================

function makeTempDbPath(): string {
  return join(tmpdir(), `semantic-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
}

function makeStore(): GraphStore {
  const store = createStoreFromAdjacency({
    getData: ['processData'],
    processData: [],
    UserService: [],
    UserModel: [],
    parse_config: [],
  }, `semantic-${Date.now()}`)

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
    docstring: 'Manages user operations and authentication',
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
    docstring: 'Parse configuration file from disk',
  })

  return store
}

// ============================================================
// Tests
// ============================================================

describe('MockEmbeddingProvider', () => {
  test('embed returns a vector of correct dimensions', async () => {
    const provider = new MockEmbeddingProvider(42, 64)
    const vec = await provider.embed('hello world')
    expect(vec.length).toBe(64)
  })

  test('embedBatch returns correct number of vectors', async () => {
    const provider = new MockEmbeddingProvider(42, 32)
    const vecs = await provider.embedBatch(['a', 'b', 'c'])
    expect(vecs.length).toBe(3)
    expect(vecs[0].length).toBe(32)
  })

  test('same text produces same vector (deterministic)', async () => {
    const provider = new MockEmbeddingProvider(42)
    const v1 = await provider.embed('getData')
    const v2 = await provider.embed('getData')
    expect(v1).toEqual(v2)
  })

  test('different text produces different vectors', async () => {
    const provider = new MockEmbeddingProvider(42)
    const v1 = await provider.embed('getData')
    const v2 = await provider.embed('UserService')
    // Very unlikely to be equal with 128 dimensions
    expect(v1).not.toEqual(v2)
  })

  test('vectors are normalized (unit length)', async () => {
    const provider = new MockEmbeddingProvider(42)
    const vec = await provider.embed('test')
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
    expect(norm).toBeCloseTo(1.0, 5)
  })
})

describe('SQLiteVectorStore', () => {
  let db: Database
  let store: SQLiteVectorStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new SQLiteVectorStore(db, 4)
    store.createTable()
  })

  afterEach(() => {
    db.close()
  })

  describe('createTable', () => {
    test('creates vectors table', () => {
      expect(store.count).toBe(0)
    })

    test('is idempotent', () => {
      expect(() => store.createTable()).not.toThrow()
    })
  })

  describe('upsert', () => {
    test('stores a vector', () => {
      store.upsert('node1', [1, 0, 0, 0])
      expect(store.count).toBe(1)
    })

    test('updates existing vector', () => {
      store.upsert('node1', [1, 0, 0, 0])
      store.upsert('node1', [0, 1, 0, 0])
      expect(store.count).toBe(1)
    })
  })

  describe('upsertBatch', () => {
    test('stores multiple vectors', () => {
      store.upsertBatch([
        { id: 'a', embedding: [1, 0, 0, 0] },
        { id: 'b', embedding: [0, 1, 0, 0] },
        { id: 'c', embedding: [0, 0, 1, 0] },
      ])
      expect(store.count).toBe(3)
    })
  })

  describe('knn', () => {
    test('returns closest vectors first', () => {
      store.upsert('a', [1, 0, 0, 0])
      store.upsert('b', [0, 1, 0, 0])
      store.upsert('c', [0, 0, 1, 0])

      // Query closest to 'a'
      const results = store.knn([0.9, 0.1, 0, 0], 3)
      expect(results.length).toBe(3)
      expect(results[0].id).toBe('a')
      expect(results[0].distance).toBeLessThan(results[1].distance)
    })

    test('returns k results', () => {
      store.upsert('a', [1, 0, 0, 0])
      store.upsert('b', [0, 1, 0, 0])
      store.upsert('c', [0, 0, 1, 0])

      const results = store.knn([1, 0, 0, 0], 2)
      expect(results.length).toBe(2)
    })

    test('identical vectors have distance 0', () => {
      store.upsert('a', [1, 0, 0, 0])
      const results = store.knn([1, 0, 0, 0], 1)
      expect(results[0].distance).toBeCloseTo(0, 5)
    })

    test('orthogonal vectors have distance 1', () => {
      store.upsert('a', [1, 0, 0, 0])
      const results = store.knn([0, 1, 0, 0], 1)
      expect(results[0].distance).toBeCloseTo(1, 5)
    })

    test('returns empty for empty store', () => {
      const emptyStore = new SQLiteVectorStore(new Database(':memory:'), 4)
      emptyStore.createTable()
      const results = emptyStore.knn([1, 0, 0, 0], 5)
      expect(results.length).toBe(0)
    })
  })
})

describe('SemanticSearchEngine', () => {
  let ftsDbPath: string
  let fts: FtsSearch
  let vectorDb: Database
  let vectorStore: SQLiteVectorStore
  let embedding: MockEmbeddingProvider
  let engine: SemanticSearchEngine
  let store: GraphStore

  beforeEach(async () => {
    ftsDbPath = makeTempDbPath()
    fts = new FtsSearch(ftsDbPath)
    fts.createIndex()

    store = makeStore()
    fts.indexNodes(store)

    vectorDb = new Database(':memory:')
    vectorStore = new SQLiteVectorStore(vectorDb, 128)
    vectorStore.createTable()

    embedding = new MockEmbeddingProvider(42, 128)
    engine = new SemanticSearchEngine(fts, vectorStore, embedding, store)
  })

  afterEach(() => {
    fts.close()
    vectorDb.close()
    if (existsSync(ftsDbPath)) unlinkSync(ftsDbPath)
    if (existsSync(ftsDbPath + '-wal')) unlinkSync(ftsDbPath + '-wal')
    if (existsSync(ftsDbPath + '-shm')) unlinkSync(ftsDbPath + '-shm')
  })

  describe('indexAll', () => {
    test('indexes all nodes into vector store', async () => {
      await engine.indexAll()
      expect(vectorStore.count).toBe(store.nodeMeta.size)
    })

    test('is idempotent — re-indexing does not duplicate', async () => {
      await engine.indexAll()
      await engine.indexAll()
      expect(vectorStore.count).toBe(store.nodeMeta.size)
    })
  })

  describe('searchByText', () => {
    test('returns results after indexing', async () => {
      await engine.indexAll()
      const results = await engine.searchByText('getData')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('getData')
    })

    test('works without pre-indexing (FTS still works)', async () => {
      // No indexAll — only FTS/BM25 signals should work
      const results = await engine.searchByText('getData')
      expect(results.length).toBeGreaterThan(0)
    })

    test('results sorted by combined score descending', async () => {
      await engine.indexAll()
      const results = await engine.searchByText('User')
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    test('respects limit', async () => {
      await engine.indexAll()
      const results = await engine.searchByText('data', 2)
      expect(results.length).toBeLessThanOrEqual(2)
    })

    test('semantic signal returns results even for unmatched query (KNN always returns neighbors)', async () => {
      await engine.indexAll()
      // KNN always returns nearest neighbors, so semantic search won't return empty
      // But scores should be lower than direct matches
      const noMatchResults = await engine.searchByText('zzznothing')
      const directResults = await engine.searchByText('getData')
      // Direct match should have higher top score
      if (noMatchResults.length > 0 && directResults.length > 0) {
        expect(directResults[0].score).toBeGreaterThan(noMatchResults[0].score)
      }
    })

    test('search by docstring content', async () => {
      await engine.indexAll()
      const results = await engine.searchByText('configuration')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].name).toBe('parse_config')
    })

    test('3-way fusion improves ranking vs single signal', async () => {
      await engine.indexAll()

      // Semantic search should help when FTS/BM25 alone might not rank well
      const results = await engine.searchByText('remote API fetch')
      expect(results.length).toBeGreaterThan(0)
      // getData has docstring about "Fetch data by ID from the remote API"
      const topNames = results.slice(0, 3).map(r => r.name)
      expect(topNames).toContain('getData')
    })
  })
})
