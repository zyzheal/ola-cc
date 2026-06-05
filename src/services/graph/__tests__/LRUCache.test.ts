/**
 * LRUCache 测试 (F-57)
 */

import { describe, it, expect } from 'bun:test'
import { LRUCache } from '../LRUCache.js'

describe('LRUCache', () => {
  describe('基础操作', () => {
    it('get/set 基本存取', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('a', 1)
      expect(cache.get('a')).toBe(1)
    })

    it('get 不存在的 key 返回 undefined', () => {
      const cache = new LRUCache<string, number>(10)
      expect(cache.get('missing')).toBeUndefined()
    })

    it('has 检查存在性', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('a', 1)
      expect(cache.has('a')).toBe(true)
      expect(cache.has('b')).toBe(false)
    })

    it('delete 删除条目', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('a', 1)
      expect(cache.delete('a')).toBe(true)
      expect(cache.get('a')).toBeUndefined()
      expect(cache.delete('missing')).toBe(false)
    })

    it('clear 清空所有条目', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('a', 1)
      cache.set('b', 2)
      cache.clear()
      expect(cache.size).toBe(0)
      expect(cache.get('a')).toBeUndefined()
    })

    it('size 返回当前条目数', () => {
      const cache = new LRUCache<string, number>(10)
      expect(cache.size).toBe(0)
      cache.set('a', 1)
      expect(cache.size).toBe(1)
      cache.set('b', 2)
      expect(cache.size).toBe(2)
    })
  })

  describe('LRU 淘汰', () => {
    it('超过 maxSize 淘汰最旧条目', () => {
      const cache = new LRUCache<string, number>(3)
      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)
      cache.set('d', 4) // 应淘汰 'a'

      expect(cache.size).toBe(3)
      expect(cache.get('a')).toBeUndefined()
      expect(cache.get('d')).toBe(4)
    })

    it('get 刷新访问顺序（防止被淘汰）', () => {
      const cache = new LRUCache<string, number>(3)
      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      // 访问 'a'，刷新其位置
      cache.get('a')

      cache.set('d', 4) // 应淘汰 'b'（最久未访问）

      expect(cache.get('a')).toBe(1) // 未被淘汰
      expect(cache.get('b')).toBeUndefined() // 被淘汰
      expect(cache.get('d')).toBe(4)
    })

    it('更新已有 key 刷新位置', () => {
      const cache = new LRUCache<string, number>(3)
      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      // 更新 'a'，刷新其位置
      cache.set('a', 10)

      cache.set('d', 4) // 应淘汰 'b'

      expect(cache.get('a')).toBe(10)
      expect(cache.get('b')).toBeUndefined()
    })

    it('maxSize=1 时只保留最新', () => {
      const cache = new LRUCache<string, number>(1)
      cache.set('a', 1)
      cache.set('b', 2)
      expect(cache.size).toBe(1)
      expect(cache.get('a')).toBeUndefined()
      expect(cache.get('b')).toBe(2)
    })
  })

  describe('命中率统计', () => {
    it('hitRate 初始为 0', () => {
      const cache = new LRUCache<string, number>(10)
      expect(cache.hitRate).toBe(0)
    })

    it('hitRate 正确计算', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('a', 1)
      cache.get('a') // hit
      cache.get('a') // hit
      cache.get('b') // miss

      expect(cache.hitRate).toBeCloseTo(2 / 3)
    })

    it('stats 返回详细统计', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('a', 1)
      cache.get('a')
      cache.get('missing')

      const stats = cache.stats
      expect(stats.hits).toBe(1)
      expect(stats.misses).toBe(1)
      expect(stats.hitRate).toBeCloseTo(0.5)
    })

    it('clear 重置统计', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('a', 1)
      cache.get('a')
      cache.clear()

      expect(cache.hitRate).toBe(0)
      expect(cache.stats.hits).toBe(0)
      expect(cache.stats.misses).toBe(0)
    })
  })

  describe('边界条件', () => {
    it('支持不同 key/value 类型', () => {
      const cache = new LRUCache<number, { name: string }>(5)
      cache.set(1, { name: 'one' })
      cache.set(2, { name: 'two' })
      expect(cache.get(1)).toEqual({ name: 'one' })
    })

    it('大容量缓存正确工作', () => {
      const cache = new LRUCache<number, number>(1000)
      for (let i = 0; i < 1000; i++) {
        cache.set(i, i * 2)
      }
      expect(cache.size).toBe(1000)

      // 添加第 1001 个，淘汰 0
      cache.set(1000, 2000)
      expect(cache.get(0)).toBeUndefined()
      expect(cache.get(1000)).toBe(2000)
    })

    it('has 不影响命中率', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('a', 1)
      cache.has('a')
      cache.has('b')
      // has 不计入 hits/misses
      expect(cache.stats.hits).toBe(0)
      expect(cache.stats.misses).toBe(0)
    })
  })
})
