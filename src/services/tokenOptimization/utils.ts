/**
 * Token Optimization Utilities
 *
 * 提供各种工具函数，包括 token 估算、文本处理、缓存管理等
 */

import { TOKEN_ESTIMATION } from './constants';

/**
 * Token 估算工具
 */
export const TOKEN_ESTIMATION_UTILS = {
  /**
   * 估算文本的 token 数量
   */
  estimateTokens(text: string): number {
    // 基于平均长度估算
    return Math.ceil(
      text.split(/\s+/).length * TOKEN_ESTIMATION.avgTokensPerWord +
      text.split('\n').length * TOKEN_ESTIMATION.avgTokensPerLine * 0.1
    );
  },

  /**
   * 估算文件大小的 token 数量
   */
  estimateFileTokens(filePath: string, fileSize: number): number {
    // 假设平均每个字节对应 0.2 个 tokens
    return Math.ceil(fileSize * 0.2);
  },

  /**
   * 估算工具调用的 token 开销
   */
  estimateToolOverhead(toolName: string, input: any): number {
    let overhead = TOKEN_ESTIMATION.overheadPerTool;

    // 根据工具类型调整开销
    switch (toolName) {
      case 'Read':
        overhead += 50; // 文件读取额外开销
        break;
      case 'Bash':
        overhead += 100; // 命令执行额外开销
        break;
      case 'FileEdit':
        overhead += 150; // 文件编辑额外开销
        break;
    }

    return overhead;
  },
};

/**
 * 文本处理工具
 */
export const TEXT_UTILS = {
  /**
   * 智能截断文本
   */
  smartTruncate(text: string, maxSize: number, strategy: 'head_tail' | 'summary' = 'head_tail'): string {
    const estimatedTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(text);

    if (estimatedTokens <= maxSize) {
      return text;
    }

    switch (strategy) {
      case 'head_tail':
        return this.headTailTruncate(text, maxSize);
      case 'summary':
        return this.summaryTruncate(text, maxSize);
      default:
        return text.substring(0, maxSize * 2); // 简单截断
    }
  },

  /**
   * 保留头部和尾部的截断
   */
  headTailTruncate(text: string, maxSize: number): string {
    const lines = text.split('\n');
    const estimatedSize = TOKEN_ESTIMATION_UTILS.estimateTokens(text);

    if (estimatedSize <= maxSize) {
      return text;
    }

    // 计算需要保留的比例
    const ratio = maxSize / estimatedSize;
    const headLines = Math.ceil(lines.length * ratio * 0.6);
    const tailLines = Math.ceil(lines.length * ratio * 0.4);

    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(-tailLines).join('\n');

    return `${head}\n[... ${lines.length - headLines - tailLines} lines omitted ...]\n${tail}`;
  },

  /**
   * 生成文本摘要
   */
  summaryTruncate(text: string, maxSize: number): string {
    const lines = text.split('\n');
    const summary: string[] = [];

    // 提取关键信息
    for (const line of lines) {
      if (line.includes('ERROR:') || line.includes('WARNING:')) {
        summary.push(`⚠️ ${line}`);
        continue;
      }

      if (line.includes('===') || line.includes('---')) {
        summary.push(line);
        continue;
      }

      if (line.trim() && !line.trim().startsWith('//')) {
        summary.push(line);
      }
    }

    // 如果摘要还是太大，进一步截断
    const summaryText = summary.join('\n');
    if (TOKEN_ESTIMATION_UTILS.estimateTokens(summaryText) > maxSize) {
      return this.headTailTruncate(summaryText, maxSize);
    }

    return summaryText;
  },

  /**
   * 规范化文本（去除多余空格和换行）
   */
  normalizeText(text: string): string {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();
  },

  /**
   * 计算文本相似度
   */
  calculateSimilarity(text1: string, text2: string): number {
    const set1 = new Set(this.normalizeText(text1).split(/\s+/));
    const set2 = new Set(this.normalizeText(text2).split(/\s+/));

    const intersection = new Set(Array.from(set1).filter(x => set2.has(x)));
    const union = new Set([...Array.from(set1), ...Array.from(set2)]);

    return intersection.size / union.size;
  },

  /**
   * 提取命令指纹
   */
  extractCommandFingerprint(command: string): string {
    const parts = command.split(' ');
    const mainCommand = parts[0];
    const args = parts.slice(1, 3); // 只取前两个参数

    return `${mainCommand} ${args.join(' ')}`;
  },

  /**
   * 检测文件类型
   */
  detectFileType(filePath: string): 'config' | 'test' | 'source' | 'docs' | 'types' | 'unknown' {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    switch (ext) {
      case 'json':
      case 'yaml':
      case 'yml':
      case 'toml':
      case 'ini':
        return 'config';
      case 'test.spec.ts':
      case 'test.spec.js':
      case 'test.ts':
      case 'test.js':
        return 'test';
      case 'ts':
      case 'tsx':
      case 'js':
      case 'jsx':
      case 'rs':
      case 'go':
      case 'py':
      case 'java':
        return 'source';
      case 'md':
      case 'txt':
        return 'docs';
      case 'd.ts':
        return 'types';
      default:
        return 'unknown';
    }
  },

  /**
   * 判断是否为大文件
   */
  isLargeFile(filePath: string, size: number): boolean {
    return size > 10 * 1024 * 1024; // 10MB
  },

  /**
   * 判断是否为二进制文件
   */
  isBinaryFile(filePath: string): boolean {
    const binaryExtensions = ['.bin', '.exe', '.dll', '.so', '.dylib', '.png', '.jpg', '.jpeg', '.gif'];
    return binaryExtensions.some(ext => filePath.endsWith(ext));
  },
};

/**
 * 缓存工具
 */
export const CACHE_UTILS = {
  /**
   * 生成缓存键
   */
  generateCacheKey(prefix: string, ...parts: string[]): string {
    const key = `${prefix}:${parts.join(':')}`;
    return Buffer.from(key).toString('base64');
  },

  /**
   * 检查缓存是否过期
   */
  isExpired(timestamp: number, ttl: number): boolean {
    return Date.now() - timestamp > ttl;
  },

  /**
   * LRU 缓存实现
   */
  createLRUCache<K, V>(maxSize: number) {
    const cache = new Map<K, { value: V; timestamp: number }>();

    return {
      get(key: K): V | undefined {
        const item = cache.get(key);
        if (!item) return undefined;

        // 更新访问时间
        cache.set(key, { ...item, timestamp: Date.now() });
        return item.value;
      },

      set(key: K, value: V): void {
        // 如果已存在，更新值
        if (cache.has(key)) {
          cache.set(key, { value, timestamp: Date.now() });
          return;
        }

        // 如果缓存已满，删除最旧的
        if (cache.size >= maxSize) {
          const oldestKey = cache.keys().next().value;
          cache.delete(oldestKey);
        }

        cache.set(key, { value, timestamp: Date.now() });
      },

      delete(key: K): boolean {
        return cache.delete(key);
      },

      clear(): void {
        cache.clear();
      },

      size(): number {
        return cache.size;
      },
    };
  },
};

/**
 * 性能监控工具
 */
export const PERFORMANCE_UTILS = {
  /**
   * 测量函数执行时间
   */
  async measureAsync<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;
    return { result, duration };
  },

  /**
   * 测量同步函数执行时间
   */
  measureSync<T>(fn: () => T): { result: T; duration: number } {
    const start = performance.now();
    const result = fn();
    const duration = performance.now() - start;
    return { result, duration };
  },

  /**
   * 记录内存使用
   */
  getMemoryUsage(): { used: number; total: number; percentage: number } {
    const usage = process.memoryUsage();
    return {
      used: usage.heapUsed,
      total: usage.heapTotal,
      percentage: (usage.heapUsed / usage.heapTotal) * 100,
    };
  },

  /**
   * 检查性能阈值
   */
  checkThresholds(metrics: { memory?: number; time?: number }): { ok: boolean; warnings: string[] } {
    const warnings: string[] = [];
    let ok = true;

    if (metrics.memory && metrics.memory > 100 * 1024 * 1024) { // 100MB
      warnings.push('Memory usage exceeds threshold');
      ok = false;
    }

    if (metrics.time && metrics.time > 100) { // 100ms
      warnings.push('Processing time exceeds threshold');
      ok = false;
    }

    return { ok, warnings };
  },
};

/**
 * 调试工具
 */
export const DEBUG_UTILS = {
  /**
   * 格式化调试信息
   */
  formatDebugInfo(strategy: string, input: any, output: any, metrics: any): string {
    return `[Token Optimization] ${strategy}:
  Input size: ${input ? `${input.length} chars` : 'N/A'}
  Output size: ${output ? `${output.length} chars` : 'N/A'}
  Savings: ${metrics?.savings || 'N/A'}
  Processing time: ${metrics?.duration || 'N/A'}ms`;
  },

  /**
   * 记录调试信息
   */
  logDebug(strategy: string, message: string, data?: any): void {
    if (process.env.DEBUG_TOKEN_OPTIMIZATION) {
      console.log(`[Token Optimization:${strategy}]`, message, data || '');
    }
  },
};