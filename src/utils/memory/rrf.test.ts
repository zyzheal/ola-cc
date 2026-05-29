import { describe, it, expect } from 'bun:test'
import { reciprocalRankFusion, vectorAnchoredFusion } from './rrf'

describe('RRF', () => {
  it('should fuse multiple score maps correctly', () => {
    const map1 = new Map([['a', 10], ['b', 8], ['c', 5]])
    const map2 = new Map([['a', 9], ['b', 6], ['d', 7]])
    const results = reciprocalRankFusion([map1, map2])
    expect(results.length).toBe(4)
    // 'a' appears high in both → should be rank 1
    expect(results[0].docId).toBe('a')
  })

  it('should rank documents appearing in multiple lists higher', () => {
    const map1 = new Map([['shared', 5], ['only1', 10]])
    const map2 = new Map([['shared', 5], ['only2', 10]])
    const results = reciprocalRankFusion([map1, map2])
    // shared appears in both maps → higher RRF score
    const sharedRank = results.findIndex(r => r.docId === 'shared')
    const only1Rank = results.findIndex(r => r.docId === 'only1')
    expect(sharedRank).toBeLessThan(only1Rank)
  })

  it('should handle single score map', () => {
    const map = new Map([['x', 100], ['y', 50]])
    const results = reciprocalRankFusion([map])
    expect(results.length).toBe(2)
    expect(results[0].docId).toBe('x')
  })

  it('should handle empty score maps', () => {
    const results = reciprocalRankFusion([new Map(), new Map()])
    expect(results.length).toBe(0)
  })

  it('vectorAnchoredFusion should blend BM25 and vector scores', () => {
    const vecScores = new Map([['doc1', 0.9], ['doc2', 0.3]])
    const bm25Scores = new Map([['doc1', 5], ['doc2', 10]])
    const results = vectorAnchoredFusion(vecScores, bm25Scores)
    expect(results.length).toBe(2)
    // doc1 has high vector score → should rank high despite lower BM25
    expect(results[0].docId).toBe('doc1')
  })
})
