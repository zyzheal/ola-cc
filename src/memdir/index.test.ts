/**
 * Tests for the new TF-IDF memory index engine.
 *
 * Pure computation — no I/O, no API calls.
 */

import { describe, it, expect } from 'bun:test'
import { MemoryIndex } from './index.js'

describe('MemoryIndex', () => {
  const makeDoc = (
    id: number,
    name: string,
    type: string,
    content: string,
    description: string | null = null,
  ) => ({
    id,
    name,
    description,
    content,
    type,
    mtimeMs: Date.now() - 86400000, // 1 day ago
  })

  describe('build', () => {
    it('should index documents and report correct size', () => {
      const index = new MemoryIndex()
      index.build([
        makeDoc(1, 'test_file', 'project', 'This is test content about databases'),
        makeDoc(2, 'user_prefs', 'user', 'User prefers bun over npm'),
      ])
      expect(index.size).toBe(2)
    })

    it('should clear previous index on rebuild', () => {
      const index = new MemoryIndex()
      index.build([makeDoc(1, 'old', 'project', 'old content')])
      expect(index.size).toBe(1)
      index.build([makeDoc(2, 'new', 'project', 'new content')])
      expect(index.size).toBe(1)
      expect(index.getDoc(1)).toBeUndefined()
      expect(index.getDoc(2)).toBeDefined()
    })
  })

  describe('search', () => {
    it('should return empty for empty index', () => {
      const index = new MemoryIndex()
      expect(index.search('anything')).toEqual([])
    })

    it('should return empty for empty query', () => {
      const index = new MemoryIndex()
      index.build([makeDoc(1, 'test', 'project', 'some content')])
      expect(index.search('')).toEqual([])
    })

    it('should find documents matching query terms', () => {
      const index = new MemoryIndex()
      index.build([
        makeDoc(1, 'db_setup', 'project', 'PostgreSQL database configuration'),
        makeDoc(2, 'frontend', 'project', 'React component library'),
      ])

      const results = index.search('database postgresql')
      expect(results.length).toBe(1)
      expect(results[0].id).toBe(1)
    })

    it('should rank more relevant docs higher', () => {
      const index = new MemoryIndex()
      index.build([
        makeDoc(1, 'test', 'project', 'a quick mention of testing'),
        makeDoc(2, 'testing_guide', 'project', 'Comprehensive guide to testing with unit tests integration tests and end-to-end tests'),
        makeDoc(3, 'deploy', 'project', 'Deployment pipeline configuration'),
      ])

      const results = index.search('testing guide comprehensive')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBe(2)
    })

    it('should filter tokens shorter than 3 chars', () => {
      const index = new MemoryIndex()
      index.build([
        makeDoc(1, 'test', 'project', 'an it is to be'),
      ])

      const results = index.search('it is to')
      expect(results).toEqual([])
    })

    it('should handle CJK characters', () => {
      const index = new MemoryIndex()
      index.build([
        makeDoc(1, 'chinese', 'project', '中文内容测试'),
      ])

      // Should not crash on CJK input
      const results = index.search('中文')
      // Results may vary depending on tokenization, but should not throw
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('update', () => {
    it('should add new documents incrementally', () => {
      const index = new MemoryIndex()
      index.build([makeDoc(1, 'existing', 'project', 'existing content here')])
      expect(index.size).toBe(1)

      index.update([makeDoc(2, 'added', 'project', 'newly added content')], new Set())
      expect(index.size).toBe(2)
    })

    it('should remove deleted documents', () => {
      const index = new MemoryIndex()
      index.build([
        makeDoc(1, 'keep', 'project', 'keep this'),
        makeDoc(2, 'remove', 'project', 'remove this'),
      ])
      expect(index.size).toBe(2)

      index.update([], new Set([2]))
      expect(index.size).toBe(1)
      expect(index.getDoc(2)).toBeUndefined()
    })

    it('should update search results after incremental changes', () => {
      const index = new MemoryIndex()
      index.build([makeDoc(1, 'test', 'project', 'original content')])

      index.update([makeDoc(1, 'test', 'project', 'updated database content')], new Set())

      const results = index.search('database')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBe(1)
    })
  })

  describe('getDoc', () => {
    it('should return undefined for non-existent doc', () => {
      const index = new MemoryIndex()
      expect(index.getDoc(999)).toBeUndefined()
    })

    it('should return the correct document', () => {
      const index = new MemoryIndex()
      const doc = makeDoc(42, 'my_mem', 'feedback', 'feedback content')
      index.build([doc])
      expect(index.getDoc(42)).toEqual(doc)
    })
  })

  describe('getDocIds', () => {
    it('should return all indexed doc ids', () => {
      const index = new MemoryIndex()
      index.build([
        makeDoc(1, 'a', 'project', 'content one'),
        makeDoc(5, 'b', 'project', 'content two'),
        makeDoc(10, 'c', 'project', 'content three'),
      ])
      const ids = index.getDocIds().sort((a, b) => a - b)
      expect(ids).toEqual([1, 5, 10])
    })
  })

  describe('stop words', () => {
    it('should filter common stop words', () => {
      const index = new MemoryIndex()
      index.build([
        makeDoc(1, 'test', 'project', 'the and for are but not you all'),
      ])

      const results = index.search('the and for are')
      expect(results).toEqual([])
    })
  })

  describe('IDF smoothing', () => {
    it('should boost rare terms over common terms', () => {
      const index = new MemoryIndex()
      index.build([
        makeDoc(1, 'a', 'project', 'shared term zephyr'),
        makeDoc(2, 'b', 'project', 'shared term blorp'),
        makeDoc(3, 'c', 'project', 'shared term quux'),
        makeDoc(4, 'd', 'project', 'shared term flim'),
        makeDoc(5, 'e', 'project', 'shared term flam'),
      ])

      // "zephyr" appears only in doc 1 — rare term should rank it highest
      const results = index.search('zephyr shared')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBe(1)
    })
  })
})
