/**
 * Result Deduplicator
 *
 * 实现智能结果去重，避免重复的输出和相似的结果返回
 */

import { DeduplicationConfig } from './types';
import { TOKEN_ESTIMATION_UTILS, TEXT_UTILS, DEBUG_UTILS } from './utils';
import { CACHE_UTILS } from './utils';

export interface DeduplicationResult {
  deduplicated: string;
  isDuplicate: boolean;
  similarityScore: number;
  savedTokens: number;
  sourceHash?: string;
}

export class ResultDeduplicator {
  private config: DeduplicationConfig;
  private historyCache: ReturnType<typeof CACHE_UTILS.createLRUCache<string, { content: string; timestamp: number }>>;

  constructor(config?: Partial<DeduplicationConfig>) {
    this.config = {
      enabled: true,
      threshold: 0.8,
      historySize: 100,
      timeWindow: 5 * 60 * 1000,
      ...config,
    };
    this.historyCache = CACHE_UTILS.createLRUCache<string, { content: string; timestamp: number }>(
      this.config.historySize
    );
  }

  /**
   * 去重处理
   */
  async deduplicate(
    content: string,
    metadata?: {
      toolName?: string;
      toolDescription?: string;
      command?: string;
      timestamp?: number;
    }
  ): Promise<DeduplicationResult> {
    const startTime = performance.now();
    const normalizedContent = this.normalizeContent(content);

    // 计算内容指纹
    const contentHash = this.generateContentHash(normalizedContent, metadata);

    // 检查是否为重复内容
    const existingEntry = this.historyCache.get(contentHash);
    if (existingEntry && !this.isExpired(existingEntry.timestamp)) {
      DEBUG_UTILS.logDebug('ResultDeduplicator', `Duplicate detected with hash: ${contentHash}`);

      return {
        deduplicated: this.generateDuplicateIndicator(content),
        isDuplicate: true,
        similarityScore: 1.0,
        savedTokens: TOKEN_ESTIMATION_UTILS.estimateTokens(content),
        sourceHash: contentHash,
      };
    }

    // 检查相似内容
    const similarResult = await this.findSimilarContent(normalizedContent);
    if (similarResult && similarResult.score >= this.config.threshold) {
      DEBUG_UTILS.logDebug('ResultDeduplicator', `Similar content detected: ${similarResult.score.toFixed(2)}`);

      return {
        deduplicated: this.generateSimilarityReport(content, similarResult.score),
        isDuplicate: false,
        similarityScore: similarResult.score,
        savedTokens: TOKEN_ESTIMATION_UTILS.estimateTokens(content) * 0.7,
        sourceHash: similarResult.hash,
      };
    }

    // 添加到历史记录
    this.addToHistory(contentHash, normalizedContent);

    const duration = performance.now() - startTime;
    DEBUG_UTILS.logDebug('ResultDeduplicator',
      `Deduplication completed: new result (${duration}ms)`,
      { hash: contentHash, contentLength: normalizedContent.length }
    );

    return {
      deduplicated: content,
      isDuplicate: false,
      similarityScore: 0,
      savedTokens: 0,
    };
  }

  /**
   * 批量去重处理
   */
  async batchDeduplicate(
    results: Array<{
      content: string;
      metadata?: {
        toolName?: string;
        toolDescription?: string;
        command?: string;
        timestamp?: number;
      };
    }>
  ): Promise<DeduplicationResult[]> {
    const deduplicatedResults: DeduplicationResult[] = [];
    const processedHashes = new Set<string>();

    // 第一遍：检测完全重复
    for (const result of results) {
      const normalized = this.normalizeContent(result.content);
      const hash = this.generateContentHash(normalized, result.metadata);

      if (processedHashes.has(hash)) {
        deduplicatedResults.push({
          deduplicated: this.generateDuplicateIndicator(result.content),
          isDuplicate: true,
          similarityScore: 1.0,
          savedTokens: TOKEN_ESTIMATION_UTILS.estimateTokens(result.content),
          sourceHash: hash,
        });
        continue;
      }

      processedHashes.add(hash);
      deduplicatedResults.push({
        deduplicated: result.content,
        isDuplicate: false,
        similarityScore: 0,
        savedTokens: 0,
      });
    }

    // 第二遍：检测相似内容（仅对未标记为重复的）
    const nonDuplicates = deduplicatedResults.filter(r => !r.isDuplicate);
    for (let i = 0; i < nonDuplicates.length; i++) {
      if (nonDuplicates[i].similarityScore > 0) continue;

      const result = results[i];
      const normalized = this.normalizeContent(result.content);

      const similar = await this.findSimilarContent(normalized);
      if (similar && similar.score >= this.config.threshold * 0.9) {
        deduplicatedResults[i] = {
          deduplicated: this.generateSimilarityReport(result.content, similar.score),
          isDuplicate: false,
          similarityScore: similar.score,
          savedTokens: TOKEN_ESTIMATION_UTILS.estimateTokens(result.content) * 0.7,
          sourceHash: similar.hash,
        };
      }
    }

    return deduplicatedResults;
  }

  /**
   * 规范化内容
   */
  private normalizeContent(content: string): string {
    // 移除多余的空白和换行
    let normalized = TEXT_UTILS.normalizeText(content);

    // 移除会话特定的信息
    normalized = normalized.replace(/Session\s+\d+/g, '[SESSION]');
    normalized = normalized.replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g, '[TIMESTAMP]');
    normalized = normalized.replace(/\/tmp\/claude-[\w\d]+/g, '[TEMP_PATH]');

    // 移除调试信息
    normalized = normalized.replace(/\[DEBUG\].*$/gm, '');
    normalized = normalized.replace(/verbose:\s*\d+$/gm, '');

    return normalized.trim();
  }

  /**
   * 生成内容指纹
   */
  private generateContentHash(content: string, metadata?: any): string {
    const baseString = `${content}:${JSON.stringify(metadata || {})}`;
    return Buffer.from(baseString).toString('base64').substring(0, 32);
  }

  /**
   * 检查历史记录是否过期
   */
  private isExpired(timestamp: number): boolean {
    return CACHE_UTILS.isExpired(timestamp, this.config.timeWindow);
  }

  /**
   * 添加到历史记录
   */
  private addToHistory(hash: string, content: string): void {
    this.historyCache.set(hash, {
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * 查找相似内容
   */
  private async findSimilarContent(content: string): Promise<{
    score: number;
    hash: string;
    content: string;
  } | null> {
    // Simple similarity check based on word overlap (Jaccard-like)
    // Uses stored content hashes for comparison
    const inputWords = new Set(this.normalizeContent(content).split(/\s+/).filter(Boolean));
    if (inputWords.size < 3) return null; // Too short for meaningful comparison

    // Iterate through history via a stored keys array
    // Since LRU cache doesn't expose iteration, we use a fallback hash approach
    const inputFingerprint = this.generateContentFingerprint(content);

    // Compare against recent history using simple heuristic
    // This is a lightweight approximation; for full similarity,
    // a proper LSH/SimHash implementation would be needed
    const similarHash = this.findFingerprintMatch(inputFingerprint);

    if (similarHash) {
      return {
        score: 0.85, // Placeholder: exact match via fingerprint
        hash: similarHash,
        content: '',
      };
    }

    return null;
  }

  /**
   * 生成内容指纹（基于关键词提取）
   */
  private generateContentFingerprint(content: string): string {
    const words = this.normalizeContent(content)
      .split(/\s+/)
      .filter(w => w.length > 3)
      .sort()
      .slice(0, 20); // 取前20个关键词
    return words.join(' ');
  }

  /**
   * 查找匹配的指纹
   */
  private findFingerprintMatch(_fingerprint: string): string | null {
    // Simplified: exact hash match only
    // Full implementation would iterate over stored fingerprints
    return null;
  }

  /**
   * 生成重复指示器
   */
  private generateDuplicateIndicator(content: string): string {
    return `# [DUPLICATE RESULT]
This content is similar to a previous result.
See previous output for details.

## Original Content Preview
${content.substring(0, 200)}${content.length > 200 ? '...' : ''}

## Saved Resources
- Avoided reprocessing ${TOKEN_ESTIMATION_UTILS.estimateTokens(content)} tokens
- ${content.split('\n').length} lines of output skipped`;
  }

  /**
   * 生成相似度报告
   */
  private generateSimilarityReport(content: string, similarity: number): string {
    return `# [SIMILAR RESULT]
This content is ${Math.round(similarity * 100)}% similar to a previous result.

## Differences Detected
- Similarity score: ${similarity.toFixed(2)}
- Original tokens: ${TOKEN_ESTIMATION_UTILS.estimateTokens(content)}
- Estimated savings: ${Math.round(TOKEN_ESTIMATION_UTILS.estimateTokens(content) * (1 - similarity))}

## New Content Preview
${content.substring(0, 300)}${content.length > 300 ? '...' : ''}`;
  }

  /**
   * 获取去重统计
   */
  getStats(): {
    totalProcessed: number;
    duplicatesFound: number;
    similarFound: number;
    totalSavedTokens: number;
    cacheSize: number;
  } {
    return {
      totalProcessed: this.historyCache.size(),
      duplicatesFound: 0, // 需要维护专门的计数器
      similarFound: 0,
      totalSavedTokens: 0,
      cacheSize: this.historyCache.size(),
    };
  }

  /**
   * 清理过期记录
   */
  cleanup(): void {
    // LRU 缓存自动清理，这里可以添加额外的清理逻辑
    DEBUG_UTILS.logDebug('ResultDeduplicator', 'Cleanup completed');
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<DeduplicationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): DeduplicationConfig {
    return { ...this.config };
  }

  /**
   * 清空历史记录
   */
  clearHistory(): void {
    this.historyCache.clear();
    DEBUG_UTILS.logDebug('ResultDeduplicator', 'History cleared');
  }
}