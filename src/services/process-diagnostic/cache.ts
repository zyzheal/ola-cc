// 缓存绑定到 ToolUseContext 生命周期，session 结束时自动清理
// 使用 LRU 策略限制缓存大小，避免内存增长

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

export class DiagnosticCache {
  private cache = new Map<string, CacheEntry<unknown>>()
  private maxSize = 256  // LRU 最大条目数

  // TTL 配置（毫秒）
  private static TTL = {
    process:    10_000,   // 进程信息 10s
    socket:      2_000,   // socket 列表 2s（变化频繁，连续查询时延长到 5s）
    service:    30_000,   // 服务映射 30s（已知服务），未知服务 5s
    container:   5_000,   // 容器列表 5s
    snapshot:    1_000,   // 进程快照 1s（Windows ToolHelp32）
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }
    // LRU: 刷新访问顺序 — 先删后插，使该条目移到 Map 尾部
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.data as T
  }

  set<T>(key: string, data: T, type: keyof typeof DiagnosticCache.TTL): void {
    // LRU 淘汰：超过 maxSize 时删除最久未访问的条目（Map 头部）
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + DiagnosticCache.TTL[type],
    })
  }

  clear(): void {
    this.cache.clear()
  }
}

// 全局缓存实例管理：通过 ToolUseContext 绑定到 session 生命周期
const cacheInstances = new WeakMap<object, DiagnosticCache>()

export function getOrCreateCache(context: { abortController: AbortController }): DiagnosticCache {
  let cache = cacheInstances.get(context.abortController)
  if (!cache) {
    cache = new DiagnosticCache()
    cacheInstances.set(context.abortController, cache)
    // session 结束时清理缓存
    context.abortController.signal.addEventListener('abort', () => cache!.clear(), { once: true })
  }
  return cache
}
