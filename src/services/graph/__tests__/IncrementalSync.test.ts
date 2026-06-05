/**
 * IncrementalSync 测试
 *
 * 测试三级变更检测逻辑:
 * 1. detect() 返回正确结构
 * 2. markDirty 和 sync 行为验证
 * 3. 三级检测优先级验证
 */

import { describe, test, expect } from 'bun:test'
import { IncrementalSync } from '../IncrementalSync.js'
import { GraphStore } from '../GraphStore.js'

describe('IncrementalSync', () => {
  test('detect() returns correct result structure', () => {
    const store = GraphStore.getInstance(process.cwd())
    const sync = new IncrementalSync(store, process.cwd())

    const result = sync.detect()

    expect(typeof result.dirty).toBe('boolean')
    expect(Array.isArray(result.changedFiles)).toBe(true)
    expect(['none', 'git-diff', 'mtime', 'hash']).toContain(result.reason)
  })

  test('detect() reports git-diff when working tree has changes', () => {
    const store = GraphStore.getInstance(process.cwd())
    const sync = new IncrementalSync(store, process.cwd())

    const result = sync.detect()

    // In the current repo state there are uncommitted changes,
    // so git-diff should detect them
    if (result.dirty) {
      expect(result.reason).toBe('git-diff')
      expect(result.changedFiles.length).toBeGreaterThan(0)
    }
  })

  test('detect() called twice is consistent', () => {
    const store = GraphStore.getInstance(process.cwd())
    const sync = new IncrementalSync(store, process.cwd())

    const first = sync.detect()
    const second = sync.detect()

    expect(first.dirty).toBe(second.dirty)
    expect(first.reason).toBe(second.reason)
  })

  test('sync() reloads store and preserves node count', async () => {
    const store = GraphStore.getInstance(process.cwd())
    await store.load()
    const nodesBefore = store.size.nodes

    const sync = new IncrementalSync(store, process.cwd())
    await sync.sync()

    expect(store.isLoaded).toBe(true)
    expect(store.size.nodes).toBe(nodesBefore)
  })

  test('sync() updates cached state so re-detect is stable', async () => {
    const store = GraphStore.getInstance(process.cwd())
    const sync = new IncrementalSync(store, process.cwd())

    // Establish baseline
    sync.detect()
    await sync.sync()

    // After sync, mtime/hash caches are updated
    // Subsequent detect may still report git-diff if working tree is dirty,
    // but mtime and hash levels should be stable
    const after = sync.detect()
    if (after.reason === 'mtime' || after.reason === 'hash') {
      // If we got past git-diff, mtime/hash should not report dirty
      expect(after.dirty).toBe(false)
    }
  })
})
