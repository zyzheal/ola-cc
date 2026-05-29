import { describe, it, expect } from 'bun:test'
import { VectorStore } from './vectorStore'

describe('VectorStore', () => {
  it('should add and search vectors', () => {
    const store = new VectorStore()
    store.add('doc1', new Float32Array([1, 0, 0]))
    store.add('doc2', new Float32Array([0, 1, 0]))
    store.add('doc3', new Float32Array([0.7, 0.7, 0]))

    const results = store.search(new Float32Array([1, 0, 0]), 3)
    expect(results.length).toBe(3)
    expect(results[0].docId).toBe('doc1')
    expect(results[0].score).toBeCloseTo(1.0, 5)
  })

  it('should rank by cosine similarity', () => {
    const store = new VectorStore()
    store.add('close', new Float32Array([0.9, 0.1, 0]))
    store.add('far', new Float32Array([0.1, 0.9, 0]))

    const results = store.search(new Float32Array([1, 0, 0]), 2)
    expect(results[0].docId).toBe('close')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })

  it('should support remove', () => {
    const store = new VectorStore()
    store.add('doc1', new Float32Array([1, 0, 0]))
    store.add('doc2', new Float32Array([0, 1, 0]))
    store.remove('doc1')

    expect(store.size).toBe(1)
    const results = store.search(new Float32Array([1, 0, 0]), 5)
    expect(results.find(r => r.docId === 'doc1')).toBeUndefined()
  })

  it('should support topK limiting', () => {
    const store = new VectorStore()
    for (let i = 0; i < 20; i++) {
      store.add(`doc${i}`, new Float32Array([Math.random(), Math.random(), Math.random()]))
    }

    const results = store.search(new Float32Array([1, 0, 0]), 5)
    expect(results.length).toBe(5)
  })

  it('should handle empty store', () => {
    const store = new VectorStore()
    const results = store.search(new Float32Array([1, 0, 0]), 5)
    expect(results.length).toBe(0)
  })

  it('should support has() check', () => {
    const store = new VectorStore()
    store.add('doc1', new Float32Array([1, 0, 0]))
    expect(store.has('doc1')).toBe(true)
    expect(store.has('doc2')).toBe(false)
  })

  it('should support clear()', () => {
    const store = new VectorStore()
    store.add('doc1', new Float32Array([1, 0, 0]))
    store.add('doc2', new Float32Array([0, 1, 0]))
    store.clear()
    expect(store.size).toBe(0)
  })

  it('should return all doc IDs', () => {
    const store = new VectorStore()
    store.add('a', new Float32Array([1, 0]))
    store.add('b', new Float32Array([0, 1]))
    expect(store.getDocIds().sort()).toEqual(['a', 'b'])
  })
})
