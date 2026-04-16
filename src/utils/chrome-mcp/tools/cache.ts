/**
 * 工具列表缓存
 * 
 * 缓存从扩展获取的工具列表
 * 减少重复请求，提高响应速度
 */

import { Logger } from '../utils/logger';
import type { ToolDefinition } from '../types';

/** 缓存的工具列表 */
interface CachedToolList {
  /** 工具列表 */
  tools: ToolDefinition[];
  
  /** 缓存时间戳 */
  timestamp: number;
  
  /** 缓存来源 */
  source: 'extension' | 'fallback';
}

/** 工具列表缓存配置 */
export interface ToolListCacheConfig {
  /** 缓存 TTL（毫秒） */
  ttl?: number;
  
  /** 最大缓存条目数 */
  maxEntries?: number;
  
  /** 日志器 */
  logger?: Logger;
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<ToolListCacheConfig> = {
  ttl: 5 * 60 * 1000, // 5 分钟
  maxEntries: 50,
  logger: new Logger({ prefix: '[ToolListCache]' }),
};

/** 工具列表缓存 */
export class ToolListCache {
  private cache: CachedToolList | null = null;
  private lastFetchTime: number = 0;
  private fetchPromise: Promise<ToolDefinition[]> | null = null;
  private config: Required<ToolListCacheConfig>;
  
  constructor(config?: ToolListCacheConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /** 获取工具列表（带缓存） */
  async getTools(
    fetchFn: () => Promise<ToolDefinition[]>,
    forceRefresh: boolean = false
  ): Promise<ToolDefinition[]> {
    const now = Date.now();
    
    // 返回缓存（如果仍然有效）
    if (!forceRefresh && this.cache && now - this.cache.timestamp < this.config.ttl) {
      this.config.logger.debug(
        `Returning cached tools (age: ${Math.round((now - this.cache.timestamp) / 1000)}s)`
      );
      return this.cache.tools;
    }
    
    // 如果正在获取，等待完成
    if (this.fetchPromise) {
      this.config.logger.debug('Waiting for ongoing fetch...');
      return this.fetchPromise;
    }
    
    // 开始新的获取
    this.config.logger.debug('Starting new fetch...');
    this.fetchPromise = this.fetchTools(fetchFn);
    
    try {
      const tools = await this.fetchPromise;
      
      // 更新缓存
      this.cache = {
        tools,
        timestamp: now,
        source: 'extension',
      };
      this.lastFetchTime = now;
      
      this.config.logger.debug(`Cached ${tools.length} tools`);
      
      return tools;
    } catch (error) {
      this.config.logger.error(`Fetch failed: ${error}`);
      
      // 获取失败，返回缓存（如果有）
      if (this.cache) {
        this.config.logger.debug('Returning stale cache as fallback');
        return this.cache.tools;
      }
      
      // 没有缓存，抛出错误
      throw error;
    } finally {
      this.fetchPromise = null;
    }
  }
  
  /** 获取工具列表（内部方法） */
  private async fetchTools(fetchFn: () => Promise<ToolDefinition[]>): Promise<ToolDefinition[]> {
    const tools = await fetchFn();
    
    // 限制缓存条目数
    if (tools.length > this.config.maxEntries) {
      this.config.logger.warn(
        `Tool list exceeds max entries (${tools.length} > ${this.config.maxEntries}), truncating`
      );
      return tools.slice(0, this.config.maxEntries);
    }
    
    return tools;
  }
  
  /** 使缓存失效 */
  invalidate(): void {
    this.config.logger.debug('Cache invalidated');
    this.cache = null;
    this.fetchPromise = null;
  }
  
  /** 获取缓存状态 */
  getStatus(): {
    hasCache: boolean;
    age: number;
    toolCount: number;
    lastFetchTime: number;
  } {
    const now = Date.now();
    
    return {
      hasCache: this.cache !== null,
      age: this.cache ? Math.round((now - this.cache.timestamp) / 1000) : 0,
      toolCount: this.cache?.tools.length || 0,
      lastFetchTime: this.lastFetchTime,
    };
  }
  
  /** 获取缓存的工具列表（不触发获取） */
  getCachedTools(): ToolDefinition[] {
    return this.cache?.tools || [];
  }
  
  /** 检查缓存是否有效 */
  isCacheValid(): boolean {
    if (!this.cache) {
      return false;
    }
    
    const now = Date.now();
    return now - this.cache.timestamp < this.config.ttl;
  }
  
  /** 获取缓存年龄（秒） */
  getCacheAge(): number {
    if (!this.cache) {
      return -1;
    }
    
    return Math.round((Date.now() - this.cache.timestamp) / 1000);
  }
}

/** 创建工具列表缓存实例 */
export function createToolListCache(config?: ToolListCacheConfig): ToolListCache {
  return new ToolListCache(config);
}
