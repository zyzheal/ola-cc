/**
 * Smart Cache
 *
 * 实现智能缓存系统，缓存频繁使用的工具结果，减少重复计算和 API 调用
 */

import { SmartCacheConfig } from './types';
import { TOKEN_ESTIMATION_UTILS, TEXT_UTILS, DEBUG_UTILS, CACHE_UTILS } from './utils';

export interface CachedResult {
  key: string;
  result: string;
  metadata: {
    toolName: string;
    inputHash: string;
    timestamp: number;
    hits: number;
    size: number;
    ttl: number;
  };
}

export interface CacheStats {
  totalEntries: number;
  totalSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictionCount: number;
  avgResponseTime: number;
}

export class SmartCache {
  private config: SmartCacheConfig;
  private cache = new Map<string, CachedResult>();
  private accessTimes = new Map<string, number>();
  private hitCount = 0;
  private missCount = 0;
  private totalResponseTime = 0;
  private evictionCount = 0;

  constructor(config?: Partial<SmartCacheConfig>) {
    this.config = {
      enabled: true,
      maxSize: 50 * 1024 * 1024, // 50MB
      defaultTTL: 5 * 60 * 1000, // 5分钟
      maxEntries: 1000,
      compressionEnabled: true,
      evictionPolicy: 'lru',
      adaptiveTTL: true,
      priorityBased: true,
      cleanupInterval: 60 * 1000, // 1分钟
    };

    if (config) {
      this.updateConfig(config);
    }

    // 启动清理定时器
    this.startCleanupTimer();
  }

  /**
   * 获取缓存结果
   */
  async get(
    key: string,
    options: {
      toolName?: string;
      inputHash?: string;
      ttl?: number;
      priority?: 'high' | 'medium' | 'low';
    } = {}
  ): Promise<{ result: string; hit: boolean; metadata?: CachedResult['metadata'] }> {
    const startTime = performance.now();
    const cacheKey = this.generateCacheKey(key, options);

    const cached = this.cache.get(cacheKey);
    if (cached && !this.isExpired(cached.metadata.timestamp, cached.metadata.ttl)) {
      // 更新访问时间
      this.accessTimes.set(cacheKey, Date.now());
      this.hitCount++;

      // 更新命中统计
      cached.metadata.hits++;

      const duration = performance.now() - startTime;
      this.totalResponseTime += duration;

      DEBUG_UTILS.logDebug('SmartCache', `Cache hit: ${cacheKey}`, {
        hits: cached.metadata.hits,
        duration: `${duration.toFixed(2)}ms`,
      });

      return {
        result: cached.result,
        hit: true,
        metadata: cached.metadata,
      };
    }

    const duration = performance.now() - startTime;
    this.totalResponseTime += duration;
    this.missCount++;

    DEBUG_UTILS.logDebug('SmartCache', `Cache miss: ${cacheKey}`, {
      duration: `${duration.toFixed(2)}ms`,
    });

    return {
      result: '',
      hit: false,
    };
  }

  /**
   * 设置缓存
   */
  async set(
    key: string,
    result: string,
    options: {
      toolName?: string;
      inputHash?: string;
      ttl?: number;
      priority?: 'high' | 'medium' | 'low';
      compress?: boolean;
    } = {}
  ): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    const cacheKey = this.generateCacheKey(key, options);
    const ttl = options.ttl || this.getDefaultTTL(options.toolName);
    const shouldCompress = options.compress ?? this.config.compressionEnabled;

    let content = result;
    let size = TOKEN_ESTIMATION_UTILS.estimateTokens(result);

    // 如果启用压缩
    if (shouldCompress && size > 1000) {
      content = this.compressContent(result);
      size = TOKEN_ESTIMATION_UTILS.estimateTokens(content);
    }

    // 检查大小限制
    if (size > this.getMaxEntrySize()) {
      DEBUG_UTILS.logDebug('SmartCache', `Entry too large, skipping cache: ${size} tokens`);
      return false;
    }

    const cachedResult: CachedResult = {
      key: cacheKey,
      result: content,
      metadata: {
        toolName: options.toolName || 'unknown',
        inputHash: options.inputHash || '',
        timestamp: Date.now(),
        hits: 0,
        size,
        ttl,
      },
    };

    // 检查缓存是否已满
    if (this.isCacheFull()) {
      this.evictEntries();
    }

    // 添加到缓存
    this.cache.set(cacheKey, cachedResult);
    this.accessTimes.set(cacheKey, Date.now());

    DEBUG_UTILS.logDebug('SmartCache', `Cache set: ${cacheKey}`, {
      size,
      ttl,
      entries: this.cache.size,
    });

    return true;
  }

  /**
   * 批量获取缓存
   */
  async batchGet(keys: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    for (const key of keys) {
      const { result, hit } = await this.get(key);
      if (hit) {
        results.set(key, result);
      }
    }

    return results;
  }

  /**
   * 批量设置缓存
   */
  async batchSet(
    entries: Array<{
      key: string;
      result: string;
      options?: {
        toolName?: string;
        inputHash?: string;
        ttl?: number;
        priority?: 'high' | 'medium' | 'low';
        compress?: boolean;
      };
    }>
  ): Promise<number> {
    let successCount = 0;

    for (const entry of entries) {
      const success = await this.set(entry.key, entry.result, entry.options);
      if (success) {
        successCount++;
      }
    }

    return successCount;
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(
    key: string,
    options: { toolName?: string; inputHash?: string; priority?: string }
  ): string {
    const parts = [
      key,
      options.toolName || '',
      options.inputHash || '',
      options.priority || '',
    ];

    return Buffer.from(parts.join(':')).toString('base64').substring(0, 64);
  }

  /**
   * 检查缓存是否过期
   */
  private isExpired(timestamp: number, ttl: number): boolean {
    return CACHE_UTILS.isExpired(timestamp, ttl);
  }

  /**
   * 压缩内容
   */
  private compressContent(content: string): string {
    // 简单的内容压缩：移除多余的空白和重复行
    const lines = content.split('\n');
    const uniqueLines = new Set<string>();
    const compressedLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !uniqueLines.has(trimmed)) {
        uniqueLines.add(trimmed);
        compressedLines.push(trimmed);
      }
    }

    return compressedLines.join('\n');
  }

  /**
   * 获取默认 TTL
   */
  private getDefaultTTL(toolName?: string): number {
    if (!this.config.adaptiveTTL) {
      return this.config.defaultTTL;
    }

    // 根据工具类型调整 TTL
    switch (toolName) {
      case 'Read':
        return this.config.defaultTTL * 2; // 读取操作缓存更久
      case 'Bash':
        return this.config.defaultTTL * 0.5; // 命令执行缓存较短
      case 'Glob':
        return this.config.defaultTTL * 3; // 文件列表缓存更久
      default:
        return this.config.defaultTTL;
    }
  }

  /**
   * 获取最大条目大小
   */
  private getMaxEntrySize(): number {
    if (this.config.priorityBased) {
      return Math.floor(this.config.maxSize / this.config.maxEntries * 2); // 高优先项可以有更大空间
    }
    return Math.floor(this.config.maxSize / this.config.maxEntries);
  }

  /**
   * 检查缓存是否已满
   */
  private isCacheFull(): boolean {
    let totalSize = 0;
    const vals = Array.from(this.cache.values());
    for (const entry of vals) {
      totalSize += entry.metadata.size;
    }

    return (
      totalSize >= this.config.maxSize ||
      this.cache.size >= this.config.maxEntries
    );
  }

  /**
   * 淘汰条目
   */
  private evictEntries(): void {
    if (this.config.evictionPolicy === 'lru') {
      this.evictLRU();
    } else if (this.config.evictionPolicy === 'lfu') {
      this.evictLFU();
    } else if (this.config.evictionPolicy === 'random') {
      this.evictRandom();
    }
  }

  /**
   * LRU 淘汰
   */
  private evictLRU(): void {
    if (this.accessTimes.size === 0) return;

    let oldestKey = '';
    let oldestTime = Infinity;

    const keys = Array.from(this.accessTimes.entries());
    for (const [key, time] of keys) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.accessTimes.delete(oldestKey);
      this.evictionCount++;
    }
  }

  /**
   * LFU 淘汰
   */
  private evictLFU(): void {
    let leastUsedKey = '';
    let leastHits = Infinity;

    const vals = Array.from(this.cache.values());
    for (const entry of vals) {
      if (entry.metadata.hits < leastHits) {
        leastHits = entry.metadata.hits;
        leastUsedKey = entry.key;
      }
    }

    if (leastUsedKey) {
      this.cache.delete(leastUsedKey);
      this.accessTimes.delete(leastUsedKey);
      this.evictionCount++;
    }
  }

  /**
   * 随机淘汰
   */
  private evictRandom(): void {
    const keys = Array.from(this.cache.keys());
    if (keys.length > 0) {
      const randomKey = keys[Math.floor(Math.random() * keys.length)];
      this.cache.delete(randomKey);
      this.accessTimes.delete(randomKey);
      this.evictionCount++;
    }
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * 清理过期条目
   */
  private cleanup(): void {
    const now = Date.now();
    let deletedCount = 0;

    const entries = Array.from(this.cache.entries());
    for (const [key, entry] of entries) {
      if (this.isExpired(entry.metadata.timestamp, entry.metadata.ttl)) {
        this.cache.delete(key);
        this.accessTimes.delete(key);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      DEBUG_UTILS.logDebug('SmartCache', `Cleaned up ${deletedCount} expired entries`);
    }
  }

  /**
   * 获取缓存统计
   */
  getStats(): CacheStats {
    const totalSize = Array.from(this.cache.values()).reduce((sum, entry) => sum + entry.metadata.size, 0);
    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 ? this.hitCount / totalRequests : 0;
    const avgResponseTime = this.hitCount > 0 ? this.totalResponseTime / this.hitCount : 0;

    return {
      totalEntries: this.cache.size,
      totalSize,
      hits: this.hitCount,
      misses: this.missCount,
      hitRate,
      evictionCount: this.evictionCount,
      avgResponseTime,
    };
  }

  /**
   * 获取缓存详情
   */
  getCacheDetails(): Array<{
    key: string;
    size: number;
    hits: number;
    age: number;
    toolName: string;
  }> {
    const now = Date.now();

    return Array.from(this.cache.values()).map(entry => ({
      key: entry.key,
      size: entry.metadata.size,
      hits: entry.metadata.hits,
      age: now - entry.metadata.timestamp,
      toolName: entry.metadata.toolName,
    })).sort((a, b) => b.hits - a.hits); // 按命中次数排序
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SmartCacheConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): SmartCacheConfig {
    return { ...this.config };
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.accessTimes.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.totalResponseTime = 0;
    this.evictionCount = 0;
    DEBUG_UTILS.logDebug('SmartCache', 'Cache cleared');
  }

  /**
   * 停止清理定时器
   */
  destroy(): void {
    // 清理定时器在实现时需要保存定时器 ID
    DEBUG_UTILS.logDebug('SmartCache', 'Cache destroyed');
  }
}