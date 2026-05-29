import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryIndex } from './memoryIndex'
import * as fs from 'fs'
import * as path from 'path'

describe('MemoryIndex', () => {
  const tmpDir = '/tmp/test-memory-index-' + Date.now()

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '- [Test](test.md)\n')
    fs.writeFileSync(path.join(tmpDir, 'test.md'), '# Test\nThis is about Windows crash fix for Bun')
    fs.writeFileSync(path.join(tmpDir, 'provider.md'), '# Provider\nAPI routing and provider switching guide')
    fs.writeFileSync(path.join(tmpDir, 'chinese.md'), '# 中文\nprovider 切换配置指南')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should index all memory files on startup', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    const stats = idx.getStats()
    expect(stats.totalDocuments).toBe(3) // excludes MEMORY.md
  })

  it('should search after indexing', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    const { results, degraded } = await idx.search('Windows crash')
    expect(degraded).toBe(false)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('test.md')
  })

  it('should support incremental index update', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    // Add new file
    fs.writeFileSync(path.join(tmpDir, 'new.md'), '# New\nDocker container setup')
    idx.indexFile(path.join(tmpDir, 'new.md'))
    const { results } = await idx.search('Docker container')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('new.md')
  })

  it('should support file removal', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    idx.removeFile(path.join(tmpDir, 'test.md'))
    const stats = idx.getStats()
    expect(stats.totalDocuments).toBe(2)
  })

  it('should degrade gracefully when not indexed', async () => {
    const idx = new MemoryIndex(tmpDir)
    const { results, degraded } = await idx.search('anything')
    expect(degraded).toBe(true)
    expect(results.length).toBe(0)
  })

  it('should handle pending files during indexing', async () => {
    const idx = new MemoryIndex(tmpDir)
    // Start indexing (takes time)
    const indexPromise = idx.indexAll()
    // Try to add file while indexing
    idx.indexFile(path.join(tmpDir, 'test.md'))
    await indexPromise
    // pending file should be replayed
    const stats = idx.getStats()
    expect(stats.totalDocuments).toBeGreaterThanOrEqual(3)
  })

  it('should return hybrid search results with source field', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    const { results } = await idx.search('Windows crash')
    expect(results.length).toBeGreaterThan(0)
    // source should be 'bm25' or 'hybrid' depending on vector availability
    expect(['bm25', 'hybrid']).toContain(results[0].source)
  })

  it('should report vector stats', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    const stats = idx.getStats()
    expect(stats).toHaveProperty('vectorDocuments')
    expect(stats).toHaveProperty('vectorReady')
    // vectorReady depends on @xenova/transformers availability
    expect(typeof stats.vectorReady).toBe('boolean')
  })
})
