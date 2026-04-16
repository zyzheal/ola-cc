/**
 * Tests for multi-factor recall scoring.
 */

import { describe, it, expect } from 'bun:test'
import { rankMemories } from './recall.js'
import type { MemoryDoc } from './index.js'

describe('rankMemories', () => {
  const makeDoc = (
    id: number,
    name: string,
    type: string,
    daysAgo: number,
  ): MemoryDoc => ({
    id,
    name,
    description: `${name} description`,
    content: `${name} content here`,
    type,
    mtimeMs: Date.now() - daysAgo * 86400000,
  })

  it('should return empty for empty input', () => {
    expect(rankMemories([])).toEqual([])
  })

  it('should rank feedback higher than reference with same TF-IDF', () => {
    const docs = [
      { doc: makeDoc(1, 'ref', 'reference', 1), tfidfScore: 0.5 },
      { doc: makeDoc(2, 'fb', 'feedback', 1), tfidfScore: 0.5 },
    ]

    const results = rankMemories(docs)
    expect(results[0].id).toBe(2) // feedback weighted higher
  })

  it('should decay old memories', () => {
    const fresh = { doc: makeDoc(1, 'fresh', 'project', 1), tfidfScore: 0.5 }
    const stale = { doc: makeDoc(2, 'stale', 'project', 120), tfidfScore: 0.5 }

    const results = rankMemories([stale, fresh])
    expect(results[0].id).toBe(1) // fresh should score higher
  })

  it('should respect the limit parameter', () => {
    const docs = [
      { doc: makeDoc(1, 'a', 'project', 1), tfidfScore: 0.9 },
      { doc: makeDoc(2, 'b', 'project', 1), tfidfScore: 0.8 },
      { doc: makeDoc(3, 'c', 'project', 1), tfidfScore: 0.7 },
      { doc: makeDoc(4, 'd', 'project', 1), tfidfScore: 0.6 },
    ]

    const results = rankMemories(docs, 2)
    expect(results.length).toBe(2)
    expect(results[0].id).toBe(1)
    expect(results[1].id).toBe(2)
  })

  it('should filter out zero-score results', () => {
    // Very old doc with age decay approaching zero
    const docs = [
      { doc: makeDoc(1, 'normal', 'project', 1), tfidfScore: 0.5 },
      { doc: makeDoc(2, 'old', 'project', 365), tfidfScore: 0.0 },
    ]

    const results = rankMemories(docs)
    expect(results.every(r => r.score > 0)).toBe(true)
  })

  it('should sort results by score descending', () => {
    const docs = [
      { doc: makeDoc(1, 'low', 'reference', 30), tfidfScore: 0.3 },
      { doc: makeDoc(2, 'high', 'feedback', 1), tfidfScore: 0.9 },
      { doc: makeDoc(3, 'mid', 'user', 10), tfidfScore: 0.6 },
    ]

    const results = rankMemories(docs)
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score)
    }
  })
})
