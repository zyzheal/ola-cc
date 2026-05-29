import { describe, it, expect } from 'bun:test'
import { BM25, type BM25Result } from './bm25'

describe('BM25', () => {
  it('should index and retrieve documents by keyword', () => {
    const bm25 = new BM25()
    bm25.addDocument('doc1', 'Windows crash fix for Bun runtime')
    bm25.addDocument('doc2', 'macOS installation guide')
    bm25.addDocument('doc3', 'Linux package manager setup')
    const results = bm25.search('Windows crash')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('doc1')
  })

  it('should rank exact match higher than partial match', () => {
    const bm25 = new BM25()
    bm25.addDocument('exact', 'provider switching API routes')
    bm25.addDocument('partial', 'provider configuration and setup guide')
    const results = bm25.search('provider switching')
    expect(results[0].docId).toBe('exact')
  })

  it('should handle Chinese tokenization', () => {
    const bm25 = new BM25()
    bm25.addDocument('cn1', 'provider 切换配置指南')
    bm25.addDocument('cn2', 'API 路由设置')
    const results = bm25.search('切换')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('cn1')
  })

  it('should handle camelCase identifier splitting', () => {
    const bm25 = new BM25()
    bm25.addDocument('code1', 'camelCaseVariable used in function')
    bm25.addDocument('code2', 'some other document')
    const results = bm25.search('camel case')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('code1')
  })

  it('should handle empty query gracefully', () => {
    const bm25 = new BM25()
    bm25.addDocument('doc', 'some content')
    const results = bm25.search('')
    expect(results.length).toBe(0)
  })

  it('should support document removal', () => {
    const bm25 = new BM25()
    bm25.addDocument('doc1', 'first document about testing')
    bm25.addDocument('doc2', 'second document about coding')
    bm25.removeDocument('doc1')
    const results = bm25.search('testing')
    expect(results.find(r => r.docId === 'doc1')).toBeUndefined()
  })

  it('should use IDF smooth variant correctly', () => {
    const bm25 = new BM25()
    bm25.addDocument('common', 'the the the common word appears everywhere')
    bm25.addDocument('rare', 'the unique rare keyword xyzzy appears once')
    const results = bm25.search('xyzzy')
    expect(results.length).toBe(1)
    expect(results[0].docId).toBe('rare')
    expect(results[0].score).toBeGreaterThan(0)
  })
})
