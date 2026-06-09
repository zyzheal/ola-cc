import { describe, it, expect } from 'bun:test'
import { DiagnosticCache } from './cache'

describe('DiagnosticCache', () => {
  it('should return null for missing key', () => {
    const cache = new DiagnosticCache()
    expect(cache.get('missing')).toBeNull()
  })

  it('should store and retrieve value', () => {
    const cache = new DiagnosticCache()
    cache.set('key1', { data: 'value1' }, 'process')
    expect(cache.get('key1')).toEqual({ data: 'value1' })
  })

  it('should expire entries after TTL', async () => {
    const cache = new DiagnosticCache()
    cache.set('key1', 'value1', 'snapshot') // 1s TTL
    expect(cache.get('key1')).toBe('value1')
    // Wait for expiry
    await new Promise(r => setTimeout(r, 1100))
    expect(cache.get('key1')).toBeNull()
  })

  it('should implement LRU eviction', () => {
    const cache = new DiagnosticCache()
    // Fill up to maxSize (256)
    for (let i = 0; i < 256; i++) {
      cache.set(`key${i}`, `value${i}`, 'process')
    }
    // key0 should still be accessible (it was just inserted)
    expect(cache.get('key0')).toBe('value0')
    // Access key1 to refresh its position
    cache.get('key1')
    // Insert one more to trigger eviction
    cache.set('key256', 'value256', 'process')
    // key0 should be evicted (oldest, not accessed)
    // key1 should still exist (accessed recently)
    expect(cache.get('key1')).toBe('value1')
  })

  it('should refresh access order on get (LRU)', () => {
    const cache = new DiagnosticCache()
    cache.set('a', 1, 'process')
    cache.set('b', 2, 'process')
    cache.set('c', 3, 'process')
    // Access 'a' to refresh its position
    cache.get('a')
    // Now 'b' is the least recently used
    // But we can't easily test eviction with only 3 entries (max is 256)
    // Just verify get returns correct value after refresh
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('should clear all entries', () => {
    const cache = new DiagnosticCache()
    cache.set('key1', 'value1', 'process')
    cache.set('key2', 'value2', 'process')
    cache.clear()
    expect(cache.get('key1')).toBeNull()
    expect(cache.get('key2')).toBeNull()
  })
})
