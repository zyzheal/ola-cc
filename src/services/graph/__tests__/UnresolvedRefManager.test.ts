/**
 * UnresolvedRefManager 测试
 *
 * F-62: UnresolvedReference Interface
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { UnresolvedRefManager } from '../UnresolvedRefManager.js'
import { createStoreFromAdjacency } from './testHelpers.js'
import type { GraphStore, NodeMetadata } from '../GraphStore.js'

// ============================================================
// Helpers
// ============================================================

function makeStore(): GraphStore {
  const store = createStoreFromAdjacency({
    main: ['helper', 'externalLib'],
    helper: [],
  }, `unres-${Date.now()}`)

  // externalLib is a dangling target (no nodeMeta entry for it as a real node)
  // The test factory creates nodeMeta for all IDs, so we remove it
  store.nodeMeta.delete('externalLib')

  // Add richer metadata
  store.nodeMeta.set('main', {
    id: 'main', name: 'main', kind: 'function',
    file: 'src/main.ts', line: 1,
    qualified_name: 'app.main',
    docstring: 'Entry point',
  })
  store.nodeMeta.set('helper', {
    id: 'helper', name: 'helper', kind: 'function',
    file: 'src/utils.ts', line: 5,
    qualified_name: 'utils.helper',
    docstring: 'Helper function',
  })

  return store
}

// ============================================================
// Tests
// ============================================================

describe('UnresolvedRefManager', () => {
  let store: GraphStore
  let manager: UnresolvedRefManager

  beforeEach(() => {
    store = makeStore()
    manager = new UnresolvedRefManager(store)
  })

  describe('loadFromEdges', () => {
    test('detects dangling edges as unresolved refs', () => {
      // externalLib is in adjacency but not in nodeMeta
      manager['loadFromEdges']()
      const unresolved = manager.getUnresolved()
      expect(unresolved.length).toBeGreaterThan(0)
      expect(unresolved.some(r => r.toName === 'externalLib')).toBe(true)
    })

    test('does not flag edges to existing nodes', () => {
      manager['loadFromEdges']()
      const unresolved = manager.getUnresolved()
      // helper exists in nodeMeta, should not be unresolved
      expect(unresolved.some(r => r.toName === 'helper')).toBe(false)
    })
  })

  describe('resolve', () => {
    test('resolves refs when matching node is added', () => {
      manager['loadFromEdges']()
      const unresolvedBefore = manager.getUnresolved()
      expect(unresolvedBefore.length).toBeGreaterThan(0)

      // Add the missing node
      store.nodeMeta.set('externalLib', {
        id: 'externalLib', name: 'externalLib', kind: 'module',
        file: 'node_modules/external/index.ts', line: 1,
      })

      const newlyResolved = manager.resolve()
      expect(newlyResolved).toBe(1)
      expect(manager.getUnresolved().length).toBe(0)
    })

    test('returns 0 when nothing to resolve', () => {
      const emptyStore = createStoreFromAdjacency({ A: [] }, `empty-${Date.now()}`)
      const mgr = new UnresolvedRefManager(emptyStore)
      expect(mgr.resolve()).toBe(0)
    })

    test('resolves by name match', () => {
      const mgr = new UnresolvedRefManager(store)
      mgr.addRef({
        fromNode: 'main', fromFile: 'src/main.ts',
        toName: 'helper', kind: 'call', line: 5, resolved: false,
      })

      // helper exists in store by name
      expect(mgr.resolve()).toBe(1)
      expect(mgr.getUnresolved().length).toBe(0)
    })

    test('resolves by qualified_name match', () => {
      const mgr = new UnresolvedRefManager(store)
      mgr.addRef({
        fromNode: 'main', fromFile: 'src/main.ts',
        toName: 'utils.helper', kind: 'import', line: 2, resolved: false,
      })

      expect(mgr.resolve()).toBe(1)
      expect(mgr.getUnresolved().length).toBe(0)
    })

    test('resolves by file:name key match', () => {
      const mgr = new UnresolvedRefManager(store)
      mgr.addRef({
        fromNode: 'main', fromFile: 'src/main.ts',
        toName: 'helper', toFile: 'src/utils.ts',
        kind: 'import', line: 2, resolved: false,
      })

      expect(mgr.resolve()).toBe(1)
    })
  })

  describe('getUnresolved', () => {
    test('returns only unresolved refs', () => {
      manager.addRef({
        fromNode: 'main', fromFile: 'src/main.ts',
        toName: 'existing', kind: 'import', line: 1, resolved: false,
      })
      manager.addRef({
        fromNode: 'helper', fromFile: 'src/utils.ts',
        toName: 'resolved_one', kind: 'call', line: 5, resolved: true, resolvedTo: 'some_id',
      })

      const unresolved = manager.getUnresolved()
      expect(unresolved.every(r => !r.resolved)).toBe(true)
    })
  })

  describe('getUnresolvedByFile', () => {
    test('filters by file path', () => {
      manager.addRef({
        fromNode: 'main', fromFile: 'src/main.ts',
        toName: 'foo', kind: 'import', line: 1, resolved: false,
      })
      manager.addRef({
        fromNode: 'helper', fromFile: 'src/utils.ts',
        toName: 'bar', kind: 'import', line: 3, resolved: false,
      })

      const fromMain = manager.getUnresolvedByFile('src/main.ts')
      expect(fromMain.length).toBe(1)
      expect(fromMain[0].toName).toBe('foo')

      const fromUtils = manager.getUnresolvedByFile('src/utils.ts')
      expect(fromUtils.length).toBe(1)
      expect(fromUtils[0].toName).toBe('bar')
    })

    test('returns empty for file with no unresolved refs', () => {
      expect(manager.getUnresolvedByFile('src/nonexistent.ts')).toEqual([])
    })
  })

  describe('addRef', () => {
    test('adds a reference to the manager', () => {
      const before = manager.size
      manager.addRef({
        fromNode: 'main', fromFile: 'src/main.ts',
        toName: 'something', kind: 'import', line: 10, resolved: false,
      })
      expect(manager.size).toBe(before + 1)
    })
  })

  describe('getAll', () => {
    test('returns both resolved and unresolved refs', () => {
      manager.addRef({
        fromNode: 'main', fromFile: 'src/main.ts',
        toName: 'foo', kind: 'import', line: 1, resolved: false,
      })
      manager.addRef({
        fromNode: 'helper', fromFile: 'src/utils.ts',
        toName: 'bar', kind: 'call', line: 5, resolved: true, resolvedTo: 'some_id',
      })

      expect(manager.getAll().length).toBe(2)
    })
  })

  describe('size', () => {
    test('returns total reference count', () => {
      const initial = manager.size
      manager.addRef({
        fromNode: 'a', fromFile: 'f.ts',
        toName: 'b', kind: 'import', line: 1, resolved: false,
      })
      expect(manager.size).toBe(initial + 1)
    })
  })
})
