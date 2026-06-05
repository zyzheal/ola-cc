/**
 * LRUCache — 通用 LRU 缓存 (F-57)
 *
 * 基于 Map 的 LRU（最近最少使用）缓存实现，
 * 用于 GraphStore.getNode() 等高频访问场景。
 *
 * 设计文档: Phase Z2 — Query Optimization
 */

export class LRUCache<K, V> {
  private cache = new Map<K, V>()
  private maxSize: number
  private hits = 0
  private misses = 0

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize
  }

  /**
   * 获取缓存值。命中时刷新访问顺序。
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // 刷新：删除后重新插入，移到 Map 末尾（最近使用）
      this.cache.delete(key)
      this.cache.set(key, value)
      this.hits++
      return value
    }
    this.misses++
    return undefined
  }

  /**
   * 设置缓存值。超过 maxSize 时淘汰最久未使用的条目。
   */
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // 已存在：先删除再插入（刷新位置）
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // 淘汰最旧条目：Map.keys().next() 返回插入顺序的第一个
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) {
        this.cache.delete(oldest)
      }
    }
    this.cache.set(key, value)
  }

  /**
   * 检查 key 是否存在（不刷新访问顺序）
   */
  has(key: K): boolean {
    return this.cache.has(key)
  }

  /**
   * 删除指定 key
   */
  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  /**
   * 清空缓存并重置统计
   */
  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
  }

  /**
   * 当前缓存条目数
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * 命中率 (0.0 ~ 1.0)，无访问时返回 0
   */
  get hitRate(): number {
    const total = this.hits + this.misses
    if (total === 0) return 0
    return this.hits / total
  }

  /**
   * 命中/未命中统计
   */
  get stats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
    }
  }
}
