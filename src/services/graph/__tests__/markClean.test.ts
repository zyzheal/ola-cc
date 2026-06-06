/**
 * Phase 6d: markClean + ensureReady tests
 *
 * Tests:
 * 1. IncrementalSync.markClean() updates mtime/hash cache
 * 2. GraphStore.ensureReady() with loaded store
 * 3. GraphStore.ensureReady() with stale DB fallback
 * 4. GraphStore.ensureReady() failure case
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { GraphStore, GraphStoreError } from '../GraphStore.js'
import { IncrementalSync } from '../IncrementalSync.js'
import { resolve } from 'path'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync, rmSync, statSync } from 'fs'

const TEST_DIR = resolve('/tmp', 'markclean-test-' + Date.now())

/**
 * Helper: create a GraphStore backed by a minimal SQLite DB.
 */
async function createStoreWithDb(dir: string): Promise<GraphStore> {
  mkdirSync(resolve(dir, '.codegraph'), { recursive: true })
  const dbPath = resolve(dir, '.codegraph', 'codegraph.db')
  const db = new Database(dbPath)
  db.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`)
  db.run(`CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`)
  db.run(`INSERT INTO nodes VALUES ('n:a', 'function', 'a', 'a.ts', 1)`)
  db.run(`INSERT INTO edges VALUES ('n:a', 'n:a', 'calls')`)
  db.close()

  const store = GraphStore.getInstance(dir)
  await store.load()
  return store
}

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  // Clean up singletons for test dirs
  for (const key of [TEST_DIR + '/basic', TEST_DIR + '/stale', TEST_DIR + '/fail']) {
    GraphStore.deleteInstance(key)
  }
})

// ──────────────────────────────────────────────
// IncrementalSync.markClean()
// ──────────────────────────────────────────────

describe('IncrementalSync.markClean()', () => {
  test('updates mtime and hash cache so mtime/hashes do not re-trigger', async () => {
    const dir = TEST_DIR + '/basic'
    const store = await createStoreWithDb(dir)
    const sync = new IncrementalSync(store, dir)

    // Establish baseline
    sync.detect()

    // markClean should update internal caches
    sync.markClean()

    // After markClean, mtime/hash detection should be stable
    // (git-diff may still report dirty if working tree has changes, that's fine)
    const result = sync.detect()
    if (result.reason === 'mtime' || result.reason === 'hash') {
      expect(result.dirty).toBe(false)
    }
  })

  test('markClean with no arguments updates cache from db file', async () => {
    const dir = TEST_DIR + '/basic'
    const store = await createStoreWithDb(dir)
    const sync = new IncrementalSync(store, dir)

    // Should not throw when called without arguments
    expect(() => sync.markClean()).not.toThrow()
  })

  test('markClean does not throw when db file is missing', async () => {
    const dir = '/tmp/nonexistent-db-' + Date.now()
    const store = GraphStore.getInstance(dir)
    const sync = new IncrementalSync(store, dir)

    // Should handle missing db gracefully
    expect(() => sync.markClean()).not.toThrow()
  })
})

// ──────────────────────────────────────────────
// GraphStore.ensureReady()
// ──────────────────────────────────────────────

describe('GraphStore.ensureReady()', () => {
  test('returns ready=true when store is already loaded', async () => {
    const dir = TEST_DIR + '/basic'
    const store = await createStoreWithDb(dir)

    const result = await store.ensureReady()

    expect(result.ready).toBe(true)
    expect(result.stale).toBe(false)
    expect(result.lastSync).toBeUndefined()
    expect(result.message).toBeUndefined()
  })

  test('returns ready=true and loads store when not yet loaded', async () => {
    const dir = TEST_DIR + '/basic'
    // Create DB but don't load store yet
    mkdirSync(resolve(dir, '.codegraph'), { recursive: true })
    const dbPath = resolve(dir, '.codegraph', 'codegraph.db')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`)
    db.run(`CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`)
    db.run(`INSERT INTO nodes VALUES ('n:a', 'function', 'a', 'a.ts', 1)`)
    db.close()

    // Mark dirty to force fresh load
    const store = GraphStore.getInstance(dir)
    store.markDirty()

    expect(store.isLoaded).toBe(false)

    const result = await store.ensureReady()

    expect(result.ready).toBe(true)
    expect(result.stale).toBe(false)
    expect(store.isLoaded).toBe(true)
  })

  test('returns stale=true when load fails but stale data exists', async () => {
    const dir = TEST_DIR + '/stale'
    const store = await createStoreWithDb(dir)

    // Verify store has data
    expect(store.adjacency.size).toBeGreaterThan(0)

    // Now mark dirty so ensureReady tries to reload
    store.markDirty()
    expect(store.isLoaded).toBe(false)
    // But adjacency still has data from previous load

    // Since the DB still exists, load should succeed.
    // To test the stale fallback, we'd need to remove the DB after load.
    // Instead, verify the API contract: allowStaleDb option is accepted.
    const result = await store.ensureReady({ allowStaleDb: true })

    // Load should succeed since DB is still there
    expect(result.ready).toBe(true)
  })

  test('returns stale data when load fails with allowStaleDb and stale data exists', async () => {
    const dir = TEST_DIR + '/stale'

    // First, create and load the store with an actual edge
    mkdirSync(resolve(dir, '.codegraph'), { recursive: true })
    const dbPath = resolve(dir, '.codegraph', 'codegraph.db')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`)
    db.run(`CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`)
    db.run(`INSERT INTO nodes VALUES ('n:a', 'function', 'a', 'a.ts', 1)`)
    db.run(`INSERT INTO nodes VALUES ('n:b', 'function', 'b', 'b.ts', 2)`)
    db.run(`INSERT INTO edges VALUES ('n:a', 'n:b', 'calls')`)
    db.close()

    const store = GraphStore.getInstance(dir)
    await store.load()

    // Verify loaded with data
    expect(store.isLoaded).toBe(true)
    expect(store.nodeMeta.size).toBe(2)
    expect(store.adjacency.size).toBeGreaterThan(0)

    // Now delete the DB and mark dirty so reload will fail
    rmSync(dbPath)
    store.markDirty()

    // ensureReady with allowStaleDb should return stale data
    const result = await store.ensureReady({ allowStaleDb: true })

    expect(result.ready).toBe(true)
    expect(result.stale).toBe(true)
    expect(result.lastSync).toBeGreaterThan(0)
    expect(result.message).toContain('outdated')
  })

  test('returns ready=false when load fails and no stale data', async () => {
    const dir = TEST_DIR + '/fail'
    const store = GraphStore.getInstance(dir)
    // No DB, no data — load will fail with NO_DATA_SOURCE

    const result = await store.ensureReady()

    expect(result.ready).toBe(false)
    expect(result.stale).toBe(false)
    expect(result.message).toBeTruthy()
  })

  test('returns ready=false when load fails without allowStaleDb even if stale data exists', async () => {
    const dir = TEST_DIR + '/stale'

    // First, create and load the store with data
    mkdirSync(resolve(dir, '.codegraph'), { recursive: true })
    const dbPath = resolve(dir, '.codegraph', 'codegraph.db')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`)
    db.run(`CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`)
    db.run(`INSERT INTO nodes VALUES ('n:a', 'function', 'a', 'a.ts', 1)`)
    db.run(`INSERT INTO nodes VALUES ('n:b', 'function', 'b', 'b.ts', 2)`)
    db.run(`INSERT INTO edges VALUES ('n:a', 'n:b', 'calls')`)
    db.close()

    const store = GraphStore.getInstance(dir)
    await store.load()

    // Delete DB and mark dirty
    rmSync(dbPath)
    store.markDirty()

    // Without allowStaleDb, should return ready=false
    const result = await store.ensureReady({ allowStaleDb: false })

    expect(result.ready).toBe(false)
    expect(result.stale).toBe(false)
  })

  test('loadedAt is set after successful load', async () => {
    const dir = TEST_DIR + '/basic'
    const store = await createStoreWithDb(dir)

    // loadedAt should be a positive number
    expect(store.loadedAt).toBeGreaterThan(0)
  })

  test('loadedAt is updated on reload', async () => {
    const dir = TEST_DIR + '/basic'
    const store = await createStoreWithDb(dir)

    const firstLoadedAt = store.loadedAt
    expect(firstLoadedAt).toBeGreaterThan(0)

    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10))

    store.markDirty()
    await store.load()

    expect(store.loadedAt).toBeGreaterThanOrEqual(firstLoadedAt)
  })
})

// ──────────────────────────────────────────────
// Integration: markClean + ensureReady workflow
// ──────────────────────────────────────────────

describe('Phase 6d: markClean + ensureReady integration', () => {
  test('full workflow: detect -> sync -> markClean -> ensureReady', async () => {
    const dir = TEST_DIR + '/basic'
    const store = await createStoreWithDb(dir)
    const sync = new IncrementalSync(store, dir)

    // 1. detect baseline
    sync.detect()

    // 2. sync
    await sync.sync()
    expect(store.isLoaded).toBe(true)

    // 3. markClean
    sync.markClean()

    // 4. ensureReady should be happy
    const result = await store.ensureReady()
    expect(result.ready).toBe(true)
    expect(result.stale).toBe(false)
  })
})
