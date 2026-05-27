/**
 * Token Optimizer
 *
 * 主优化控制器，协调所有优化策略
 */

import { TokenOptimizationConfig, OptimizationStrategy } from './types';
import { DEFAULT_CONFIG, OPTIMIZATION_STRATEGIES } from './constants';
import { DEBUG_UTILS, TOKEN_ESTIMATION_UTILS } from './utils';

// 导入所有优化器
import { SmartReadTruncator } from './SmartReadTruncator';
import { BashStreamingProcessor } from './BashStreamingProcessor';
import { GitCompressor } from './GitCompressor';
import { DirectoryCache } from './DirectoryCache';
import { ResultDeduplicator } from './ResultDeduplicator';
import { SmartCache } from './SmartCache';
import { ContextOptimizer } from './ContextOptimizer';
import { PriorityFilter } from './PriorityFilter';
import { ProgressiveCompressor } from './ProgressiveCompressor';
import { ModelOptimizer } from './ModelOptimizer';
import { UserBehaviorLearner } from './UserBehaviorLearner';
import { PredictiveOptimizer } from './PredictiveOptimizer';

export interface OptimizationRequest {
  strategy: OptimizationStrategy;
  input: any;
  context: {
    toolName?: string;
    modelName?: string;
    urgency?: 'immediate' | 'high' | 'medium' | 'low';
    importance?: 'critical' | 'high' | 'medium' | 'low';
  };
}

export interface OptimizationResult {
  strategy: OptimizationStrategy;
  optimized: any;
  savings: number;
  compressionRatio: number;
  processingTime: number;
  success: boolean;
  error?: string;
}

export class TokenOptimizer {
  private config: TokenOptimizationConfig;
  private initialized = false;
  private strategies = new Map<OptimizationStrategy, any>();
  private activeRequests = new Map<string, Promise<OptimizationResult>>();

  constructor(config?: Partial<TokenOptimizationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeStrategies();
  }

  private initializeStrategies(): void {
    if (this.config.readTruncation.enabled) {
      this.strategies.set('read_truncation', new SmartReadTruncator(this.config.readTruncation));
    }
    if (this.config.bashStreaming.enabled) {
      this.strategies.set('bash_streaming', new BashStreamingProcessor(this.config.bashStreaming));
    }
    if (this.config.gitCompression.enabled) {
      this.strategies.set('git_compression', new GitCompressor(this.config.gitCompression));
    }
    if (this.config.directoryCache.enabled) {
      this.strategies.set('directory_cache', new DirectoryCache(this.config.directoryCache));
    }
    if (this.config.deduplication.enabled) {
      this.strategies.set('result_deduplication', new ResultDeduplicator(this.config.deduplication));
    }
    if (this.config.smartCache?.enabled) {
      this.strategies.set('smart_cache', new SmartCache(this.config.smartCache));
    }
    if (this.config.contextOptimization.enabled) {
      this.strategies.set('context_optimization', new ContextOptimizer(this.config.contextOptimization));
    }
    if (this.config.priorityFilter.enabled) {
      this.strategies.set('priority_filter', new PriorityFilter(this.config.priorityFilter));
    }
    if (this.config.progressiveCompression.enabled) {
      this.strategies.set('progressive_compression', new ProgressiveCompressor(this.config.progressiveCompression));
    }
    if (this.config.modelOptimization.enabled) {
      this.strategies.set('model_optimization', new ModelOptimizer(this.config.modelOptimization));
    }
    if (this.config.userBehavior.enabled) {
      this.strategies.set('user_behavior_learning', new UserBehaviorLearner(this.config.userBehavior));
    }
    if (this.config.predictiveOptimization.enabled) {
      this.strategies.set('predictive_optimization', new PredictiveOptimizer(this.config.predictiveOptimization));
    }

    this.initialized = true;
  }

  async optimize(request: OptimizationRequest): Promise<OptimizationResult> {
    if (!this.initialized) {
      throw new Error('TokenOptimizer not initialized');
    }

    const requestId = `${request.strategy}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimizationPromise = this.performOptimization(request);
    this.activeRequests.set(requestId, optimizationPromise);

    try {
      return await optimizationPromise;
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  private async performOptimization(request: OptimizationRequest): Promise<OptimizationResult> {
    const startTime = performance.now();
    const strategy = this.strategies.get(request.strategy);

    if (!strategy) {
      return {
        strategy: request.strategy,
        optimized: null,
        savings: 0,
        compressionRatio: 1,
        processingTime: 0,
        success: false,
        error: `Strategy ${request.strategy} not available`,
      };
    }

    try {
      let result: any;
      let savings = 0;
      let compressionRatio = 1;

      switch (request.strategy) {
        case 'read_truncation':
          result = await strategy.truncate(request.input.path, request.input.content, request.input.fileType);
          savings = result.savings;
          compressionRatio = 1 - result.savings / TOKEN_ESTIMATION_UTILS.estimateTokens(request.input.content || '');
          break;
        case 'bash_streaming':
          result = await strategy.execute(request.input.command, request.input.args || [], request.input.options);
          savings = result.originalSize - result.truncatedSize;
          compressionRatio = result.truncatedSize / result.originalSize || 1;
          break;
        case 'git_compression':
          result = await strategy.compress(request.input.command, request.input.args || [], request.input.rawOutput);
          savings = result.savings;
          compressionRatio = result.compressionRatio;
          break;
        case 'directory_cache':
          result = await strategy.getDirectoryStructure(request.input.path, request.input.options || {});
          break;
        case 'result_deduplication':
          result = await strategy.deduplicate(request.input.content, request.input.metadata);
          savings = result.savedTokens;
          break;
        case 'smart_cache':
          if (request.input.mode === 'get') {
            result = await strategy.get(request.input.key, request.input.options);
            if (result.hit) savings = TOKEN_ESTIMATION_UTILS.estimateTokens(result.result) * 0.8;
          } else {
            result = await strategy.set(request.input.key, request.input.result, request.input.options);
          }
          break;
        case 'context_optimization':
          result = await strategy.optimize(
            request.input.systemPrompt, request.input.toolsSchema,
            request.input.conversationHistory, request.input.currentModel
          );
          savings = result.savings;
          break;
        case 'priority_filter':
          result = await strategy.filterAndPrioritize(request.input.tools, request.input.context);
          savings = result.efficiency.potentialSavings;
          break;
        case 'progressive_compression':
          result = await strategy.compress(request.input);
          savings = result.tokensSaved;
          compressionRatio = result.compressionRatio;
          break;
        case 'model_optimization':
          result = await strategy.optimize(request.input.modelName, request.input.context);
          savings = result.expectedImprovement.tokenReduction;
          break;
        case 'user_behavior_learning':
          result = await strategy.learn();
          break;
        case 'predictive_optimization':
          result = await strategy.predictAndOptimize();
          savings = result.scenarios.reduce((sum: number, s: any) => sum + s.expectedImprovement.tokenReduction, 0);
          break;
      }

      return {
        strategy: request.strategy,
        optimized: result,
        savings,
        compressionRatio,
        processingTime: performance.now() - startTime,
        success: true,
      };
    } catch (error: any) {
      return {
        strategy: request.strategy,
        optimized: null,
        savings: 0,
        compressionRatio: 1,
        processingTime: performance.now() - startTime,
        success: false,
        error: error.message,
      };
    }
  }

  updateConfig(config: Partial<TokenOptimizationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): TokenOptimizationConfig {
    return { ...this.config };
  }

  setStrategyEnabled(strategy: OptimizationStrategy, enabled: boolean): void {
    this.strategies.get(strategy)?.updateConfig?.({ enabled });
  }

  async cleanup(): Promise<void> {
    const strategies = Array.from(this.strategies.values());
    for (const strategy of strategies) {
      if (typeof strategy.destroy === 'function') {
        strategy.destroy();
      }
      if (typeof strategy.clear === 'function') {
        strategy.clear();
      }
    }
    this.activeRequests.clear();
  }

  getAvailableStrategies(): OptimizationStrategy[] {
    return OPTIMIZATION_STRATEGIES.filter(s => this.strategies.has(s));
  }
}
