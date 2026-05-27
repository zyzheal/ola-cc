/**
 * Model Optimizer
 *
 * 针对不同模型进行优化，根据模型特性调整策略和参数
 */

import { ModelOptimizationConfig, ModelType, OptimizedModelConfig } from './types';
import { TOKEN_ESTIMATION_UTILS, TEXT_UTILS, DEBUG_UTILS } from './utils';
import { DEFAULT_CONFIG } from './constants';

export interface ModelAnalysis {
  modelType: ModelType;
  capabilities: {
    contextWindow: number;
    maxTokens: number;
    supportsStreaming: boolean;
    supportsCaching: boolean;
    preferredStrategies: string[];
  };
  performance: {
    tokenRate: number;
    latency: number;
    throughput: number;
  };
  optimization: {
    compressionRatio: number;
    batchSize: number;
    cacheEnabled: boolean;
    priority: string[];
  };
}

export interface OptimizationResult {
  optimizedConfig: OptimizedModelConfig;
  recommendations: string[];
  expectedImprovement: {
    tokenReduction: number;
    latencyImprovement: number;
    throughputImprovement: number;
  };
  confidence: number;
}

export class ModelOptimizer {
  private config: ModelOptimizationConfig;
  private modelRegistry = new Map<string, ModelAnalysis>();
  private performanceMetrics = new Map<string, {
    tokenCount: number;
    processingTime: number;
    successRate: number;
    timestamp: number;
  }[]>();

  constructor(config?: Partial<ModelOptimizationConfig>) {
    this.config = {
      ...DEFAULT_CONFIG.modelOptimization,
      ...config,
    };

    this.initializeModelRegistry();
  }

  /**
   * 优化模型配置
   */
  async optimize(modelName: string, context: {
    inputTokens: number;
    outputTokens: number;
    complexity: 'low' | 'medium' | 'high';
    requiredAccuracy: number;
    timeConstraints: number;
  }): Promise<OptimizationResult> {
    DEBUG_UTILS.logDebug('ModelOptimizer', `Optimizing for model: ${modelName}`, context);

    // 1. 分析模型
    const modelAnalysis = this.analyzeModel(modelName);
    if (!modelAnalysis) {
      throw new Error(`Unsupported model: ${modelName}`);
    }

    // 2. 根据上下文优化配置
    const optimizedConfig = this.optimizeModelConfig(modelAnalysis, context);

    // 3. 生成建议
    const recommendations = this.generateRecommendations(modelAnalysis, optimizedConfig, context);

    // 4. 计算预期改进
    const expectedImprovement = this.calculateExpectedImprovement(modelAnalysis, optimizedConfig, context);

    // 5. 计算置信度
    const confidence = this.calculateConfidence(modelAnalysis, optimizedConfig, context);

    const result: OptimizationResult = {
      optimizedConfig,
      recommendations,
      expectedImprovement,
      confidence,
    };

    DEBUG_UTILS.logDebug('ModelOptimizer',
      'Model optimization completed',
      {
        model: modelName,
        compressionRatio: optimizedConfig.compressionRatio,
        expectedTokenReduction: expectedImprovement.tokenReduction,
        confidence,
      }
    );

    return result;
  }

  /**
   * 分析模型
   */
  private analyzeModel(modelName: string): ModelAnalysis | null {
    // 从注册表中查找模型
    let analysis = this.modelRegistry.get(modelName.toLowerCase());

    if (!analysis) {
      // 尝试匹配模型模式
      analysis = this.matchModelPattern(modelName);
    }

    return analysis;
  }

  /**
   * 匹配模型模式
   */
  private matchModelPattern(modelName: string): ModelAnalysis | null {
    const name = modelName.toLowerCase();

    // Claude 系列
    if (name.includes('claude')) {
      if (name.includes('opus') || name.includes('3-opus')) {
        return this.getModelAnalysis('claude-3-opus');
      } else if (name.includes('sonnet') || name.includes('3-sonnet')) {
        return this.getModelAnalysis('claude-3-sonnet');
      } else if (name.includes('haiku') || name.includes('3-haiku')) {
        return this.getModelAnalysis('claude-3-haiku');
      }
    }

    // GPT 系列
    if (name.includes('gpt-4')) {
      return this.getModelAnalysis('gpt-4');
    } else if (name.includes('gpt-3.5')) {
      return this.getModelAnalysis('gpt-3.5');
    }

    // 其他模型
    if (name.includes('llama')) {
      return this.getModelAnalysis('llama');
    } else if (name.includes('mistral')) {
      return this.getModelAnalysis('mistral');
    }

    // 通用模型分析
    return this.getGenericModelAnalysis(modelName);
  }

  /**
   * 获取模型分析
   */
  private getModelAnalysis(modelType: ModelType): ModelAnalysis {
    const modelConfigs = {
      'claude-3-opus': {
        contextWindow: 200000,
        maxTokens: 4096,
        supportsStreaming: true,
        supportsCaching: true,
        preferredStrategies: ['light_compression', 'priority_filter'],
        tokenRate: 100,
        latency: 2000,
        throughput: 50,
      },
      'claude-3-sonnet': {
        contextWindow: 200000,
        maxTokens: 4096,
        supportsStreaming: true,
        supportsCaching: true,
        preferredStrategies: ['adaptive_compression', 'smart_truncation'],
        tokenRate: 150,
        latency: 1000,
        throughput: 75,
      },
      'claude-3-haiku': {
        contextWindow: 32000,
        maxTokens: 4096,
        supportsStreaming: true,
        supportsCaching: false,
        preferredStrategies: ['aggressive_compression', 'summary_only'],
        tokenRate: 300,
        latency: 500,
        throughput: 150,
      },
      'gpt-4': {
        contextWindow: 128000,
        maxTokens: 4096,
        supportsStreaming: true,
        supportsCaching: true,
        preferredStrategies: ['balanced_compression', 'context_partition'],
        tokenRate: 120,
        latency: 2500,
        throughput: 40,
      },
      'gpt-3.5': {
        contextWindow: 16385,
        maxTokens: 4096,
        supportsStreaming: true,
        supportsCaching: true,
        preferredStrategies: ['light_compression', 'cache_optimization'],
        tokenRate: 200,
        latency: 800,
        throughput: 100,
      },
      'llama': {
        contextWindow: 8192,
        maxTokens: 2048,
        supportsStreaming: false,
        supportsCaching: false,
        preferredStrategies: ['minimal_compression', 'fast_processing'],
        tokenRate: 50,
        latency: 3000,
        throughput: 20,
      },
      'mistral': {
        contextWindow: 32768,
        maxTokens: 2048,
        supportsStreaming: true,
        supportsCaching: false,
        preferredStrategies: ['smart_truncation', 'parallel_processing'],
        tokenRate: 100,
        latency: 1500,
        throughput: 60,
      },
    };

    const config = modelConfigs[modelType as keyof typeof modelConfigs] || modelConfigs['claude-3-sonnet'];

    return {
      modelType,
      capabilities: {
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        supportsStreaming: config.supportsStreaming,
        supportsCaching: config.supportsCaching,
        preferredStrategies: config.preferredStrategies,
      },
      performance: {
        tokenRate: config.tokenRate,
        latency: config.latency,
        throughput: config.throughput,
      },
      optimization: {
        compressionRatio: this.calculateOptimalCompressionRatio(modelType, config),
        batchSize: this.calculateOptimalBatchSize(modelType, config),
        cacheEnabled: config.supportsCaching,
        priority: config.preferredStrategies,
      },
    };
  }

  /**
   * 获取通用模型分析
   */
  private getGenericModelAnalysis(modelName: string): ModelAnalysis {
    return {
      modelType: modelName as ModelType,
      capabilities: {
        contextWindow: 100000,
        maxTokens: 4096,
        supportsStreaming: true,
        supportsCaching: false,
        preferredStrategies: ['adaptive_compression', 'smart_truncation'],
      },
      performance: {
        tokenRate: 100,
        latency: 1500,
        throughput: 50,
      },
      optimization: {
        compressionRatio: 0.7,
        batchSize: 4,
        cacheEnabled: false,
        priority: ['adaptive_compression', 'smart_truncation'],
      },
    };
  }

  /**
   * 优化模型配置
   */
  private optimizeModelConfig(
    analysis: ModelAnalysis,
    context: any
  ): OptimizedModelConfig {
    const baseCompression = analysis.optimization.compressionRatio;

    // 根据复杂度调整压缩率
    let compressionRatio = baseCompression;
    if (context.complexity === 'high') {
      compressionRatio = Math.min(0.9, baseCompression * 1.2);
    } else if (context.complexity === 'low') {
      compressionRatio = Math.max(0.5, baseCompression * 0.8);
    }

    // 根据时间约束调整批大小
    let batchSize = analysis.optimization.batchSize;
    if (context.timeConstraints < 1000) {
      batchSize = Math.max(1, batchSize - 1);
    } else if (context.timeConstraints > 5000) {
      batchSize = Math.min(8, batchSize + 1);
    }

    // 根据精度要求调整策略
    const strategies = [...analysis.optimization.priority];
    if (context.requiredAccuracy > 0.9) {
      // 高精度要求，优先保守策略
      strategies.unshift('minimal_compression');
    } else if (context.requiredAccuracy < 0.7) {
      // 低精度要求，可以激进压缩
      strategies.unshift('aggressive_compression');
    }

    // 缓存策略
    const cacheEnabled = analysis.optimization.cacheEnabled && context.complexity !== 'high';

    return {
      modelType: analysis.modelType,
      compressionRatio,
      batchSize,
      cacheEnabled,
      strategies: strategies.slice(0, 3), // 保留前3个策略
      contextWindow: analysis.capabilities.contextWindow,
      maxTokens: analysis.capabilities.maxTokens,
      preferredStrategies: analysis.capabilities.preferredStrategies,
    };
  }

  /**
   * 生成优化建议
   */
  private generateRecommendations(
    analysis: ModelAnalysis,
    config: OptimizedModelConfig,
    context: any
  ): string[] {
    const recommendations: string[] = [];

    // 1. 压缩策略建议
    if (config.compressionRatio > 0.8) {
      recommendations.push('建议使用渐进式压缩策略，避免过度压缩影响质量');
    } else if (config.compressionRatio < 0.6) {
      recommendations.push('压缩率较低，可以增加压缩强度以节省更多 tokens');
    }

    // 2. 批处理建议
    if (config.batchSize > 4) {
      recommendations.push('建议启用批处理以提高吞吐量');
    } else if (config.batchSize === 1) {
      recommendations.push('建议减少批大小以保证响应速度');
    }

    // 3. 缓存建议
    if (!config.cacheEnabled) {
      recommendations.push('该模型不支持缓存，考虑使用客户端缓存');
    }

    // 4. 上下文管理建议
    const contextUtilization = (context.inputTokens + context.outputTokens) / analysis.capabilities.contextWindow;
    if (contextUtilization > 0.8) {
      recommendations.push('上下文利用率高，建议启用上下文分区策略');
    }

    // 5. 流式处理建议
    if (analysis.capabilities.supportsStreaming && context.timeConstraints < 2000) {
      recommendations.push('建议启用流式处理以减少等待时间');
    }

    // 6. 特定模型建议
    if (analysis.modelType.includes('claude')) {
      recommendations.push('Claude 模型支持提示缓存，建议启用相关优化');
    } else if (analysis.modelType.includes('gpt')) {
      recommendations.push('GPT 模型对 batch size 敏感，建议测试不同批大小');
    }

    return recommendations;
  }

  /**
   * 计算预期改进
   */
  private calculateExpectedImprovement(
    analysis: ModelAnalysis,
    config: OptimizedModelConfig,
    context: any
  ) {
    const tokenReduction = context.inputTokens * (1 - config.compressionRatio);
    const latencyImprovement = analysis.performance.latency * (1 - 0.2 * config.compressionRatio);
    const throughputImprovement = analysis.performance.throughput * (1 + config.batchSize * 0.1);

    return {
      tokenReduction: Math.round(tokenReduction),
      latencyImprovement: Math.round(latencyImprovement),
      throughputImprovement: Math.round(throughputImprovement),
    };
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(
    analysis: ModelAnalysis,
    config: OptimizedModelConfig,
    context: any
  ): number {
    let confidence = 0.8; // 基础置信度

    // 根据模型支持的特性调整
    if (analysis.capabilities.supportsStreaming) confidence += 0.1;
    if (analysis.capabilities.supportsCaching) confidence += 0.1;

    // 根据上下文调整
    if (context.complexity === 'medium') confidence += 0.05;
    if (context.requiredAccuracy < 0.8) confidence += 0.05;

    // 根据历史数据调整
    const history = this.performanceMetrics.get(analysis.modelType);
    if (history && history.length > 10) {
      const avgSuccessRate = history.reduce((sum, h) => sum + h.successRate, 0) / history.length;
      confidence *= avgSuccessRate;
    }

    return Math.min(1, confidence);
  }

  /**
   * 计算最优压缩比率
   */
  private calculateOptimalCompressionRatio(modelType: string, config: any): number {
    const modelConfigs = {
      'claude-3-opus': 0.6,
      'claude-3-sonnet': 0.65,
      'claude-3-haiku': 0.8,
      'gpt-4': 0.7,
      'gpt-3.5': 0.7,
      'llama': 0.5,
      'mistral': 0.6,
    };

    return modelConfigs[modelType as keyof typeof modelConfigs] || 0.6;
  }

  /**
   * 计算最优批大小
   */
  private calculateOptimalBatchSize(modelType: string, config: any): number {
    const modelConfigs = {
      'claude-3-opus': 4,
      'claude-3-sonnet': 4,
      'claude-3-haiku': 8,
      'gpt-4': 4,
      'gpt-3.5': 4,
      'llama': 1,
      'mistral': 2,
    };

    return modelConfigs[modelType as keyof typeof modelConfigs] || 4;
  }

  /**
   * 记录性能指标
   */
  recordPerformanceMetrics(
    modelType: string,
    tokens: number,
    processingTime: number,
    success: boolean
  ): void {
    const metrics = this.performanceMetrics.get(modelType) || [];

    metrics.push({
      tokenCount: tokens,
      processingTime,
      successRate: success ? 1 : 0,
      timestamp: Date.now(),
    });

    // 保持最近 1000 条记录
    if (metrics.length > 1000) {
      metrics.splice(0, metrics.length - 1000);
    }

    this.performanceMetrics.set(modelType, metrics);
  }

  /**
   * 获取模型统计
   */
  getModelStats(modelType: string): {
    averageTokens: number;
    averageLatency: number;
    successRate: number;
    usageCount: number;
    trend: 'improving' | 'stable' | 'declining';
  } {
    const metrics = this.performanceMetrics.get(modelType) || [];

    if (metrics.length === 0) {
      return {
        averageTokens: 0,
        averageLatency: 0,
        successRate: 0,
        usageCount: 0,
        trend: 'stable',
      };
    }

    const avgTokens = metrics.reduce((sum, m) => sum + m.tokenCount, 0) / metrics.length;
    const avgLatency = metrics.reduce((sum, m) => sum + m.processingTime, 0) / metrics.length;
    const successRate = metrics.reduce((sum, m) => sum + m.successRate, 0) / metrics.length;

    // 计算趋势
    const recent = metrics.slice(-50);
    const older = metrics.slice(-100, -50);
    const recentAvg = recent.reduce((sum, m) => sum + m.successRate, 0) / recent.length;
    const olderAvg = older.length > 0 ? older.reduce((sum, m) => sum + m.successRate, 0) / older.length : recentAvg;

    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    if (recentAvg > olderAvg + 0.05) trend = 'improving';
    else if (recentAvg < olderAvg - 0.05) trend = 'declining';

    return {
      averageTokens: Math.round(avgTokens),
      averageLatency: Math.round(avgLatency),
      successRate: Math.round(successRate * 100) / 100,
      usageCount: metrics.length,
      trend,
    };
  }

  /**
   * 获取所有支持的模型
   */
  getSupportedModels(): string[] {
    return Array.from(this.modelRegistry.keys());
  }

  /**
   * 添加自定义模型配置
   */
  addCustomModel(modelConfig: {
    modelType: ModelType;
    contextWindow: number;
    maxTokens: number;
    supportsStreaming: boolean;
    supportsCaching: boolean;
    preferredStrategies: string[];
    tokenRate: number;
    latency: number;
    throughput: number;
  }): void {
    const analysis: ModelAnalysis = {
      modelType: modelConfig.modelType,
      capabilities: {
        contextWindow: modelConfig.contextWindow,
        maxTokens: modelConfig.maxTokens,
        supportsStreaming: modelConfig.supportsStreaming,
        supportsCaching: modelConfig.supportsCaching,
        preferredStrategies: modelConfig.preferredStrategies,
      },
      performance: {
        tokenRate: modelConfig.tokenRate,
        latency: modelConfig.latency,
        throughput: modelConfig.throughput,
      },
      optimization: {
        compressionRatio: this.calculateOptimalCompressionRatio(modelConfig.modelType, modelConfig),
        batchSize: this.calculateOptimalBatchSize(modelConfig.modelType, modelConfig),
        cacheEnabled: modelConfig.supportsCaching,
        priority: modelConfig.preferredStrategies,
      },
    };

    this.modelRegistry.set(modelConfig.modelType.toLowerCase(), analysis);
    DEBUG_UTILS.logDebug('ModelOptimizer', `Added custom model: ${modelConfig.modelType}`);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ModelOptimizationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): ModelOptimizationConfig {
    return { ...this.config };
  }

  /**
   * 初始化模型注册表
   */
  private initializeModelRegistry(): void {
    // 初始化内置模型
    const builtinModels = [
      'claude-3-opus',
      'claude-3-sonnet',
      'claude-3-haiku',
      'gpt-4',
      'gpt-3.5',
      'llama',
      'mistral',
    ];

    for (const model of builtinModels) {
      this.modelRegistry.set(model, this.getModelAnalysis(model as ModelType));
    }
  }
}