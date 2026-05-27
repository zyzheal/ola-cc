/**
 * Progressive Compressor
 *
 * 实现渐进式压缩策略，根据风险级别动态调整压缩强度
 */

import { ProgressiveCompressionConfig, CompressionLevel, RiskLevel } from './types';
import { TOKEN_ESTIMATION_UTILS, TEXT_UTILS, DEBUG_UTILS } from './utils';
import { COMPRESSION_LEVELS, DEFAULT_CONFIG } from './constants';

export interface CompressionResult {
  compressed: string;
  level: CompressionLevel;
  riskLevel: RiskLevel;
  compressionRatio: number;
  tokensSaved: number;
  metadata: {
    originalSize: number;
    compressedSize: number;
    processingTime: number;
    confidence: number;
  };
}

export interface CompressionRequest {
  content: string;
  context: {
    urgency: 'immediate' | 'high' | 'medium' | 'low';
    importance: 'critical' | 'high' | 'medium' | 'low';
    userPreference?: CompressionLevel;
    riskTolerance?: RiskLevel;
  };
  currentLevel?: CompressionLevel;
}

export class ProgressiveCompressor {
  private config: ProgressiveCompressionConfig;
  private compressionHistory = new Array<{
    timestamp: number;
    level: CompressionLevel;
    riskLevel: RiskLevel;
    success: boolean;
    savings: number;
  }>();
  private riskMetrics = {
    lossRate: 0,
    userAcceptance: 0,
    systemPerformance: 0,
  };

  constructor(config?: Partial<ProgressiveCompressionConfig>) {
    this.config = {
      ...DEFAULT_CONFIG.progressiveCompression,
      ...config,
    };

    this.initializeRiskMetrics();
  }

  /**
   * 渐进式压缩主入口
   */
  async compress(request: CompressionRequest): Promise<CompressionResult> {
    const startTime = performance.now();

    // 1. 分析压缩需求
    const analysis = this.analyzeCompressionNeed(request);

    // 2. 确定初始压缩级别
    const initialLevel = this.determineInitialLevel(request, analysis);

    // 3. 执行渐进式压缩
    const result = await this.progressiveCompress(request, initialLevel);

    // 4. 更新风险指标
    this.updateRiskMetrics(result);

    // 5. 记录压缩历史
    this.recordCompression(result);

    const duration = performance.now() - startTime;
    DEBUG_UTILS.logDebug('ProgressiveCompressor',
      `Progressive compression completed: ${result.level} -> ${result.compressionRatio.toFixed(2)} ratio`,
      {
        originalSize: result.metadata.originalSize,
        compressedSize: result.metadata.compressedSize,
        tokensSaved: result.tokensSaved,
        duration: `${duration.toFixed(2)}ms`,
      }
    );

    return result;
  }

  /**
   * 分析压缩需求
   */
  private analyzeCompressionNeed(request: CompressionRequest): {
    urgencyFactor: number;
    importanceFactor: number;
    contentComplexity: number;
    tokenPressure: number;
  } {
    const contentTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(request.content);
    const lineCount = request.content.split('\n').length;

    // 紧急程度因子 (0-1)
    const urgencyFactor = this.calculateUrgencyFactor(request.context.urgency);

    // 重要程度因子 (0-1)
    const importanceFactor = this.calculateImportanceFactor(request.context.importance);

    // 内容复杂度因子 (0-1)
    const contentComplexity = Math.min(1, lineCount / 1000);

    // Token 压力因子 (0-1)
    const tokenPressure = Math.min(1, contentTokens / 10000);

    return {
      urgencyFactor,
      importanceFactor,
      contentComplexity,
      tokenPressure,
    };
  }

  /**
   * 计算紧急程度因子
   */
  private calculateUrgencyFactor(urgency: string): number {
    const urgencyMap = {
      immediate: 1.0,
      high: 0.8,
      medium: 0.5,
      low: 0.2,
    };
    return urgencyMap[urgency as keyof typeof urgencyMap];
  }

  /**
   * 计算重要程度因子
   */
  private calculateImportanceFactor(importance: string): number {
    const importanceMap = {
      critical: 1.0,
      high: 0.7,
      medium: 0.4,
      low: 0.1,
    };
    return importanceMap[importance as keyof typeof importanceMap];
  }

  /**
   * 确定初始压缩级别
   */
  private determineInitialLevel(
    request: CompressionRequest,
    analysis: any
  ): CompressionLevel {
    // 1. 检查用户偏好
    if (request.context.userPreference) {
      return request.context.userPreference;
    }

    // 2. 检查风险容忍度
    if (request.context.riskTolerance) {
      const levelConfig = COMPRESSION_LEVELS[request.context.riskTolerance];
      return this.getCompressionLevelFromRatio(levelConfig.ratio);
    }

    // 3. 基于分析结果计算综合分数
    const combinedScore = (
      analysis.urgencyFactor * 0.4 +
      analysis.importanceFactor * 0.3 +
      analysis.contentComplexity * 0.2 +
      analysis.tokenPressure * 0.1
    );

    // 4. 根据分数选择初始级别
    if (combinedScore > 0.8) {
      return 'HEAVY';
    } else if (combinedScore > 0.6) {
      return 'MEDIUM';
    } else if (combinedScore > 0.4) {
      return 'LIGHT';
    } else {
      return 'NONE';
    }
  }

  /**
   * 渐进式压缩
   */
  private async progressiveCompress(
    request: CompressionRequest,
    initialLevel: CompressionLevel
  ): Promise<CompressionResult> {
    let currentLevel = initialLevel;
    let result: CompressionResult;

    // 第一轮：轻量级压缩
    result = await this.applyCompression(request.content, currentLevel, request.context);

    // 如果压缩效果不理想，逐步加强
    if (result.compressionRatio < this.config.targetRatio && currentLevel !== 'HEAVY') {
      const levels: CompressionLevel[] = ['LIGHT', 'MEDIUM', 'HEAVY'];
      const currentIndex = levels.indexOf(currentLevel);

      if (currentIndex < levels.length - 1) {
        currentLevel = levels[currentIndex + 1];
        result = await this.applyCompression(request.content, currentLevel, request.context);
      }
    }

    // 如果压缩过度，逐步减弱
    if (result.compressionRatio > this.config.maxRatio && currentLevel !== 'NONE') {
      const levels: CompressionLevel[] = ['HEAVY', 'MEDIUM', 'LIGHT', 'NONE'];
      const currentIndex = levels.indexOf(currentLevel);

      if (currentIndex < levels.length - 1) {
        currentLevel = levels[currentIndex + 1];
        result = await this.applyCompression(request.content, currentLevel, request.context);
      }
    }

    return result;
  }

  /**
   * 应用压缩
   */
  private async applyCompression(
    content: string,
    level: CompressionLevel,
    context: CompressionRequest['context']
  ): Promise<CompressionResult> {
    const startTime = performance.now();
    const originalSize = TOKEN_ESTIMATION_UTILS.estimateTokens(content);

    let compressed = content;
    let strategy: string;

    switch (level) {
      case 'NONE':
        compressed = content;
        strategy = 'no_compression';
        break;

      case 'LIGHT':
        compressed = this.lightCompression(content, context);
        strategy = 'light_compression';
        break;

      case 'MEDIUM':
        compressed = this.mediumCompression(content, context);
        strategy = 'medium_compression';
        break;

      case 'HEAVY':
        compressed = this.heavyCompression(content, context);
        strategy = 'heavy_compression';
        break;

      default:
        compressed = content;
        strategy = 'unknown';
    }

    const compressedSize = TOKEN_ESTIMATION_UTILS.estimateTokens(compressed);
    const tokensSaved = originalSize - compressedSize;
    const compressionRatio = compressedSize / originalSize;

    const processingTime = performance.now() - startTime;
    const riskLevel = this.assessRiskLevel(level, context, compressionRatio);

    return {
      compressed,
      level,
      riskLevel,
      compressionRatio,
      tokensSaved,
      metadata: {
        originalSize,
        compressedSize,
        processingTime,
        confidence: this.calculateConfidence(level, context),
      },
    };
  }

  /**
   * 轻量级压缩
   */
  private lightCompression(content: string, context: any): string {
    // 移除多余空格和换行
    let compressed = TEXT_UTILS.normalizeText(content);

    // 移除注释（保留文档注释）
    const lines = compressed.split('\n');
    const filteredLines = lines.filter(line => {
      const trimmed = line.trim();
      // 保留文档注释
      if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        return true;
      }
      // 保留包含重要信息的内容
      if (trimmed.includes('ERROR:') || trimmed.includes('WARNING:')) {
        return true;
      }
      // 移除空行和装饰线
      return trimmed && !/^[-=#*]{3,}$/.test(trimmed);
    });

    return filteredLines.join('\n');
  }

  /**
   * 中等压缩
   */
  private mediumCompression(content: string, context: any): string {
    // 先应用轻量级压缩
    let compressed = this.lightCompression(content, context);

    // 进一步压缩：保留关键字段
    if (context.importance === 'critical') {
      compressed = this.preserveCriticalFields(compressed);
    } else {
      compressed = this.preserveStructure(compressed);
    }

    // 如果仍然太大，进行智能截断
    if (TOKEN_ESTIMATION_UTILS.estimateTokens(compressed) > 5000) {
      compressed = TEXT_UTILS.smartTruncate(compressed, 5000, 'summary');
    }

    return compressed;
  }

  /**
   * 重度压缩
   */
  private heavyCompression(content: string, context: any): string {
    // 先应用中等压缩
    let compressed = this.mediumCompression(content, context);

    // 最大程度压缩：保留结构
    compressed = this.preserveOnlyEssentialStructure(compressed);

    // 限制大小
    const maxTokens = context.urgency === 'immediate' ? 2000 : 5000;
    if (TOKEN_ESTIMATION_UTILS.estimateTokens(compressed) > maxTokens) {
      compressed = TEXT_UTILS.smartTruncate(compressed, maxTokens, 'head_tail');
    }

    return compressed;
  }

  /**
   * 保留关键字段
   */
  private preserveCriticalFields(content: string): string {
    const lines = content.split('\n');
    const criticalLines: string[] = [];
    let inCriticalBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 开始关键区块标记
      if (trimmed.includes('ERROR:') || trimmed.includes('CRITICAL:')) {
        inCriticalBlock = true;
        criticalLines.push(line);
        continue;
      }

      // 结束关键区块标记
      if (trimmed.includes('===') || trimmed.includes('---')) {
        inCriticalBlock = false;
        criticalLines.push(line);
        continue;
      }

      // 保留关键区块内容
      if (inCriticalBlock) {
        criticalLines.push(line);
        continue;
      }

      // 保留基本结构
      if (trimmed.startsWith('#') || trimmed.match(/^[A-Z][A-Z\s]*:/)) {
        criticalLines.push(line);
      }
    }

    return criticalLines.join('\n');
  }

  /**
   * 保留结构
   */
  private preserveStructure(content: string): string {
    const lines = content.split('\n');
    const preservedLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // 保留标题
      if (trimmed.startsWith('#')) {
        preservedLines.push(line);
        continue;
      }

      // 保留代码签名
      if (trimmed.match(/^(class|interface|function|const|let|var)\s+/)) {
        preservedLines.push(line);
        continue;
      }

      // 保留错误信息
      if (trimmed.includes('ERROR:') || trimmed.includes('WARNING:')) {
        preservedLines.push(line);
        continue;
      }

      // 保留文件头
      if (trimmed.match(/^(\.\w+|\w+\.\w+)$/)) {
        preservedLines.push(line);
        continue;
      }

      // 保留重要数据
      if (trimmed.length > 10 && !trimmed.startsWith('//')) {
        preservedLines.push(line);
      }
    }

    return preservedLines.join('\n');
  }

  /**
   * 保留仅 essential 结构
   */
  private preserveOnlyEssentialStructure(content: string): string {
    const lines = content.split('\n');
    const essentialLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // 仅保留标题
      if (trimmed.startsWith('#')) {
        essentialLines.push(line);
        continue;
      }

      // 仅保留错误信息
      if (trimmed.includes('ERROR:') || trimmed.includes('WARNING:')) {
        essentialLines.push(line);
        continue;
      }

      // 仅保留状态信息
      if (trimmed.includes('✓') || trimmed.includes('✗') || trimmed.includes('→')) {
        essentialLines.push(line);
        continue;
      }

      // 保留文件名
      if (trimmed.match(/^[-.\w]+\.\w+$/)) {
        essentialLines.push(line);
      }
    }

    return essentialLines.join('\n');
  }

  /**
   * 评估风险级别
   */
  private assessRiskLevel(
    level: CompressionLevel,
    context: any,
    compressionRatio: number
  ): RiskLevel {
    const baseRisk = this.getBaseRiskLevel(level);
    const contextRisk = this.getContextRisk(context);
    const compressionRisk = this.getCompressionRisk(compressionRatio);

    const combinedRisk = (baseRisk + contextRisk + compressionRisk) / 3;

    if (combinedRisk > 0.8) return 'HIGH';
    if (combinedRisk > 0.6) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * 获取基础风险级别
   */
  private getBaseRiskLevel(level: CompressionLevel): number {
    const riskMap = {
      NONE: 0,
      LIGHT: 0.3,
      MEDIUM: 0.6,
      HEAVY: 0.9,
    };
    return riskMap[level];
  }

  /**
   * 获取上下文风险
   */
  private getContextRisk(context: any): number {
    if (context.importance === 'critical') return 0.2;
    if (context.importance === 'high') return 0.4;
    if (context.importance === 'medium') return 0.6;
    return 0.8;
  }

  /**
   * 获取压缩风险
   */
  private getCompressionRisk(compressionRatio: number): number {
    return compressionRatio;
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(level: CompressionLevel, context: any): number {
    const baseConfidence = 0.8;

    // 根据级别调整
    if (level === 'NONE') return 1.0;
    if (level === 'HEAVY') return 0.6;

    // 根据重要性调整
    if (context.importance === 'critical') return baseConfidence * 1.2;

    return baseConfidence;
  }

  /**
   * 从比率获取压缩级别
   */
  private getCompressionLevelFromRatio(ratio: number): CompressionLevel {
    if (ratio > 0.9) return 'HEAVY';
    if (ratio > 0.7) return 'MEDIUM';
    if (ratio > 0.5) return 'LIGHT';
    return 'NONE';
  }

  /**
   * 初始化风险指标
   */
  private initializeRiskMetrics(): void {
    // 从历史数据或默认值初始化
    this.riskMetrics = {
      lossRate: 0.05,
      userAcceptance: 0.8,
      systemPerformance: 0.9,
    };
  }

  /**
   * 更新风险指标
   */
  private updateRiskMetrics(result: CompressionResult): void {
    // 更新用户接受率（假设）
    if (result.level !== 'HEAVY') {
      this.riskMetrics.userAcceptance = Math.min(1, this.riskMetrics.userAcceptance + 0.01);
    }

    // 更新系统性能
    this.riskMetrics.systemPerformance = Math.max(0, 1 - result.metadata.processingTime / 1000);
  }

  /**
   * 记录压缩历史
   */
  private recordCompression(result: CompressionResult): void {
    this.compressionHistory.push({
      timestamp: Date.now(),
      level: result.level,
      riskLevel: result.riskLevel,
      success: result.compressionRatio > 0.5,
      savings: result.tokensSaved,
    });

    // 保持历史记录大小
    if (this.compressionHistory.length > this.config.maxHistorySize) {
      this.compressionHistory = this.compressionHistory.slice(-this.config.maxHistorySize);
    }
  }

  /**
   * 获取压缩统计
   */
  getCompressionStats(): {
    totalCompressions: number;
    averageSavings: number;
    mostUsedLevel: CompressionLevel;
    riskDistribution: { low: number; medium: number; high: number };
    compressionEfficiency: number;
  } {
    if (this.compressionHistory.length === 0) {
      return {
        totalCompressions: 0,
        averageSavings: 0,
        mostUsedLevel: 'NONE',
        riskDistribution: { low: 0, medium: 0, high: 0 },
        compressionEfficiency: 0,
      };
    }

    const totalSavings = this.compressionHistory.reduce((sum, h) => sum + h.savings, 0);
    const averageSavings = totalSavings / this.compressionHistory.length;

    // 统计使用次数
    const levelCounts: { [key in CompressionLevel]: number } = {
      NONE: 0,
      LIGHT: 0,
      MEDIUM: 0,
      HEAVY: 0,
    };

    // 统计风险分布
    const riskCounts = { low: 0, medium: 0, high: 0 };

    this.compressionHistory.forEach(h => {
      levelCounts[h.level]++;
      riskCounts[h.riskLevel as keyof typeof riskCounts]++;
    });

    // 找出最常用的级别
    const mostUsedLevel = Object.entries(levelCounts).sort(([,a], [,b]) => b - a)[0][0] as CompressionLevel;

    // 计算压缩效率
    const compressionEfficiency = this.compressionHistory.filter(h => h.success).length / this.compressionHistory.length;

    return {
      totalCompressions: this.compressionHistory.length,
      averageSavings,
      mostUsedLevel,
      riskDistribution: riskCounts,
      compressionEfficiency,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ProgressiveCompressionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): ProgressiveCompressionConfig {
    return { ...this.config };
  }
}