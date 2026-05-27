/**
 * User Behavior Learner
 *
 * 学习用户行为模式，根据使用习惯动态调整优化策略
 */

import { UserBehaviorConfig, BehaviorPattern, OptimizationPreference } from './types';
import { TOKEN_ESTIMATION_UTILS, TEXT_UTILS, DEBUG_UTILS } from './utils';
import { DEFAULT_CONFIG } from './constants';

export interface UserAction {
  timestamp: number;
  toolName: string;
  inputSize: number;
  outputSize: number;
  compressionLevel: string;
  satisfaction: 'high' | 'medium' | 'low';
  responseTime: number;
  context: {
    taskType: string;
    complexity: 'low' | 'medium' | 'high';
    urgency: 'immediate' | 'high' | 'medium' | 'low';
  };
}

export interface LearningResult {
  learnedPatterns: BehaviorPattern[];
  recommendations: OptimizationPreference[];
  confidence: number;
  nextOptimization: {
    compressionLevel: string;
    priority: string[];
    cacheStrategy: string;
    riskTolerance: string;
  };
}

export class UserBehaviorLearner {
  private config: UserBehaviorConfig;
  private actionHistory: UserAction[] = [];
  private patterns: BehaviorPattern[] = [];
  private userModel = {
    preferredCompression: 'medium' as string,
    riskTolerance: 'medium' as string,
    toolPreferences: new Map<string, number>(),
    timeSensitivity: 0.5,
    qualityPriority: 0.7,
    compressionSavings: 0,
  };
  private learningRate: number;

  constructor(config?: Partial<UserBehaviorConfig>) {
    this.config = {
      ...DEFAULT_CONFIG.userBehavior,
      ...config,
    };

    this.learningRate = this.config.learningRate;
    this.loadSavedPatterns();
  }

  /**
   * 记录用户行为
   */
  recordAction(action: UserAction): void {
    DEBUG_UTILS.logDebug('UserBehaviorLearner', 'Recording user action', {
      tool: action.toolName,
      compression: action.compressionLevel,
      satisfaction: action.satisfaction,
    });

    this.actionHistory.push(action);
    this.updateModel(action);
    this.detectPatterns();

    // 保持历史记录大小
    if (this.actionHistory.length > this.config.maxHistory) {
      this.actionHistory = this.actionHistory.slice(-this.config.maxHistory);
    }

    // 定期保存模式
    if (this.actionHistory.length % 50 === 0) {
      this.savePatterns();
    }
  }

  /**
   * 学习用户行为
   */
  async learn(): Promise<LearningResult> {
    // 1. 分析最近的行动
    const recentActions = this.actionHistory.slice(-100);
    if (recentActions.length < 10) {
      DEBUG_UTILS.logDebug('UserBehaviorLearner', 'Insufficient data for learning');
      return this.getDefaultLearningResult();
    }

    // 2. 提取模式
    const patterns = this.extractPatterns(recentActions);

    // 3. 生成优化建议
    const recommendations = this.generateRecommendations(patterns);

    // 4. 计算置信度
    const confidence = this.calculateConfidence(patterns, recentActions);

    // 5. 确定下一次优化策略
    const nextOptimization = this.determineNextOptimization(patterns, recommendations);

    const result: LearningResult = {
      learnedPatterns: patterns,
      recommendations,
      confidence,
      nextOptimization,
    };

    DEBUG_UTILS.logDebug('UserBehaviorLearner',
      'Learning completed',
      {
        patternsCount: patterns.length,
        confidence,
        nextOptimization,
      }
    );

    return result;
  }

  /**
   * 更新用户模型
   */
  private updateModel(action: UserAction): void {
    // 更新压缩偏好
    if (action.satisfaction === 'high') {
      this.userModel.preferredCompression = this.adjustCompressionPreference(
        this.userModel.preferredCompression,
        action.compressionLevel,
        1
      );
    } else if (action.satisfaction === 'low') {
      this.userModel.preferredCompression = this.adjustCompressionPreference(
        this.userModel.preferredCompression,
        action.compressionLevel,
        -1
      );
    }

    // 更新风险容忍度
    const riskTolerance = this.assessRiskTolerance(action);
    this.userModel.riskTolerance = this.updateRiskTolerance(
      this.userModel.riskTolerance,
      riskTolerance,
      action.satisfaction === 'high'
    );

    // 更新工具偏好
    const toolScore = this.calculateToolScore(action);
    const currentScore = this.userModel.toolPreferences.get(action.toolName) || 0;
    const newScore = currentScore * (1 - this.learningRate) + toolScore * this.learningRate;
    this.userModel.toolPreferences.set(action.toolName, newScore);

    // 更新时间敏感性
    this.userModel.timeSensitivity = this.updateTimeSensitivity(
      this.userModel.timeSensitivity,
      action.context.urgency,
      action.responseTime,
      action.satisfaction
    );

    // 更新质量优先级
    this.userModel.qualityPriority = this.updateQualityPriority(
      this.userModel.qualityPriority,
      action.inputSize,
      action.outputSize,
      action.satisfaction
    );

    // 更新压缩节省统计
    this.userModel.compressionSavings += this.calculateSavings(action);
  }

  /**
   * 检测行为模式
   */
  private detectPatterns(): void {
    const patterns: BehaviorPattern[] = [];

    // 1. 时间模式
    const timePatterns = this.detectTimePatterns();
    patterns.push(...timePatterns);

    // 2. 工具使用模式
    const toolPatterns = this.detectToolPatterns();
    patterns.push(...toolPatterns);

    // 3. 压缩偏好模式
    const compressionPatterns = this.detectCompressionPatterns();
    patterns.push(...compressionPatterns);

    // 4. 任务类型模式
    const taskPatterns = this.detectTaskPatterns();
    patterns.push(...taskPatterns);

    // 更新模式
    this.patterns = patterns;
  }

  /**
   * 检测时间模式
   */
  private detectTimePatterns(): BehaviorPattern[] {
    const patterns: BehaviorPattern[] = [];
    const recentActions = this.actionHistory.slice(-50);

    // 检测高峰时段
    const hourCounts: { [hour: number]: number } = {};
    recentActions.forEach(action => {
      const hour = new Date(action.timestamp).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });

    const peakHours = Object.entries(hourCounts)
      .filter(([_, count]) => count > 3)
      .map(([hour]) => parseInt(hour));

    if (peakHours.length > 0) {
      patterns.push({
        type: 'time_peak',
        description: `用户在 ${peakHours.join(', ')} 点使用频繁`,
        confidence: peakHours.length / 24,
        parameters: { hours: peakHours },
        action: 'increase_cache_during_peak',
      });
    }

    return patterns;
  }

  /**
   * 检测工具使用模式
   */
  private detectToolPatterns(): BehaviorPattern[] {
    const patterns: BehaviorPattern[] = [];
    const toolUsage = this.countToolUsage();

    // 常用工具
    const frequentTools = Object.entries(toolUsage)
      .filter(([_, count]) => count > 10)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([tool]) => tool);

    if (frequentTools.length > 0) {
      patterns.push({
        type: 'tool_preference',
        description: `常用工具: ${frequentTools.join(', ')}`,
        confidence: frequentTools.length / this.userModel.toolPreferences.size,
        parameters: { tools: frequentTools },
        action: 'prioritize_frequent_tools',
      });
    }

    // 成对使用模式
    const pairs = this.detectToolPairs();
    if (pairs.length > 0) {
      patterns.push({
        type: 'tool_sequence',
        description: `常用工具序列: ${pairs.slice(0, 3).join(' → ')}`,
        confidence: pairs.length > 5 ? 0.8 : 0.6,
        parameters: { sequences: pairs.slice(0, 5) },
        action: 'optimize_tool_sequences',
      });
    }

    return patterns;
  }

  /**
   * 检测压缩偏好模式
   */
  private detectCompressionPatterns(): BehaviorPattern[] {
    const patterns: BehaviorPattern[] = [];
    const recentActions = this.actionHistory.slice(-30);

    // 满意度分析
    const satisfactionByCompression: { [level: string]: number } = {};
    const countByCompression: { [level: string]: number } = {};

    recentActions.forEach(action => {
      const level = action.compressionLevel;
      countByCompression[level] = (countByCompression[level] || 0) + 1;

      if (action.satisfaction === 'high') {
        satisfactionByCompression[level] = (satisfactionByCompression[level] || 0) + 1;
      }
    });

    // 找出最满意的压缩级别
    for (const [level, count] of Object.entries(countByCompression)) {
      if (count > 5) {
        const satisfactionRate = satisfactionByCompression[level] / count;
        if (satisfactionRate > 0.7) {
          patterns.push({
            type: 'compression_preference',
            description: `${level} 压缩级别满意度高达 ${Math.round(satisfactionRate * 100)}%`,
            confidence: satisfactionRate,
            parameters: { level, satisfactionRate },
            action: 'use_preferred_compression',
          });
        }
      }
    }

    return patterns;
  }

  /**
   * 检测任务类型模式
   */
  private detectTaskPatterns(): BehaviorPattern[] {
    const patterns: BehaviorPattern[] = [];
    const recentActions = this.actionHistory.slice(-50);

    // 任务类型分布
    const taskCounts: { [type: string]: number } = {};
    recentActions.forEach(action => {
      taskCounts[action.context.taskType] = (taskCounts[action.context.taskType] || 0) + 1;
    });

    // 主要任务类型
    const mainTasks = Object.entries(taskCounts)
      .filter(([_, count]) => count > 5)
      .sort(([,a], [,b]) => b - a);

    if (mainTasks.length > 0) {
      patterns.push({
        type: 'task_type',
        description: `主要任务类型: ${mainTasks.map(([task]) => task).join(', ')}`,
        confidence: mainTasks.length / Object.keys(taskCounts).length,
        parameters: { tasks: mainTasks.map(([task]) => task) },
        action: 'optimize_for_main_tasks',
      });
    }

    return patterns;
  }

  /**
   * 提取模式
   */
  private extractPatterns(actions: UserAction[]): BehaviorPattern[] {
    this.detectPatterns();
    return this.patterns;
  }

  /**
   * 生成优化建议
   */
  private generateRecommendations(patterns: BehaviorPattern[]): OptimizationPreference[] {
    const recommendations: OptimizationPreference[] = [];

    // 基于模式生成建议
    patterns.forEach(pattern => {
      switch (pattern.type) {
        case 'time_peak':
          recommendations.push({
            name: 'peak_time_optimization',
            description: '在高峰时段启用缓存和预处理',
            priority: 'high',
            parameters: pattern.parameters,
          });
          break;

        case 'tool_preference':
          recommendations.push({
            name: 'tool_optimization',
            description: '优先优化常用工具的性能',
            priority: 'high',
            parameters: pattern.parameters,
          });
          break;

        case 'compression_preference':
          recommendations.push({
            name: 'compression_adjustment',
            description: `使用 ${pattern.parameters.level} 压缩级别以获得最佳满意度`,
            priority: 'medium',
            parameters: pattern.parameters,
          });
          break;

        case 'task_type':
          recommendations.push({
            name: 'task_specific_optimization',
            description: '为主要任务类型定制优化策略',
            priority: 'high',
            parameters: pattern.parameters,
          });
          break;
      }
    });

    // 基于用户模型生成建议
    if (this.userModel.timeSensitivity > 0.7) {
      recommendations.push({
        name: 'speed_optimization',
        description: '优先考虑响应速度',
        priority: 'high',
        parameters: { speedThreshold: 'low' },
      });
    }

    if (this.userModel.qualityPriority > 0.8) {
      recommendations.push({
        name: 'quality_preservation',
        description: '保持高质量输出',
        priority: 'medium',
        parameters: { minQuality: 0.9 },
      });
    }

    return recommendations.sort((a, b) => b.priority.localeCompare(a.priority));
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(patterns: BehaviorPattern[], actions: UserAction[]): number {
    if (patterns.length === 0) return 0.1;

    // 基于模式数量
    const patternConfidence = Math.min(1, patterns.length / 10);

    // 基于数据量
    const dataConfidence = Math.min(1, actions.length / 100);

    // 基于模式一致性
    const consistency = patterns.reduce((sum, pattern) => sum + pattern.confidence, 0) / patterns.length;

    return (patternConfidence * 0.3 + dataConfidence * 0.3 + consistency * 0.4);
  }

  /**
   * 确定下一次优化
   */
  private determineNextOptimization(
    patterns: BehaviorPattern[],
    recommendations: OptimizationPreference[]
  ): LearningResult['nextOptimization'] {
    // 压缩级别
    let compressionLevel = this.userModel.preferredCompression;
    const compressionPattern = patterns.find(p => p.type === 'compression_preference');
    if (compressionPattern) {
      compressionLevel = compressionPattern.parameters.level;
    }

    // 优先级列表
    const priority = recommendations
      .filter(r => r.priority === 'high')
      .map(r => r.name);

    // 缓存策略
    let cacheStrategy = 'adaptive';
    if (this.userModel.timeSensitivity > 0.7) {
      cacheStrategy = 'aggressive';
    } else if (this.userModel.qualityPriority > 0.8) {
      cacheStrategy = 'conservative';
    }

    // 风险容忍度
    let riskTolerance = this.userModel.riskTolerance;
    if (recommendations.some(r => r.name === 'speed_optimization')) {
      riskTolerance = 'high';
    } else if (recommendations.some(r => r.name === 'quality_preservation')) {
      riskTolerance = 'low';
    }

    return {
      compressionLevel,
      priority,
      cacheStrategy,
      riskTolerance,
    };
  }

  /**
   * 获取默认学习结果
   */
  private getDefaultLearningResult(): LearningResult {
    return {
      learnedPatterns: [],
      recommendations: [],
      confidence: 0,
      nextOptimization: {
        compressionLevel: 'medium',
        priority: ['default_optimization'],
        cacheStrategy: 'adaptive',
        riskTolerance: 'medium',
      },
    };
  }

  /**
   * 工具计数
   */
  private countToolUsage(): { [toolName: string]: number } {
    const counts: { [toolName: string]: number } = {};
    this.actionHistory.forEach(action => {
      counts[action.toolName] = (counts[action.toolName] || 0) + 1;
    });
    return counts;
  }

  /**
   * 检测工具序列
   */
  private detectToolPairs(): string[] {
    const pairs: { [pair: string]: number } = {};
    const recent = this.actionHistory.slice(-50);

    for (let i = 0; i < recent.length - 1; i++) {
      const pair = `${recent[i].toolName} → ${recent[i + 1].toolName}`;
      pairs[pair] = (pairs[pair] || 0) + 1;
    }

    return Object.entries(pairs)
      .sort(([,a], [,b]) => b - a)
      .map(([pair]) => pair);
  }

  /**
   * 调整压缩偏好
   */
  private adjustCompressionPreference(
    current: string,
    action: string,
    direction: number
  ): string {
    const levels = ['none', 'light', 'medium', 'heavy'];
    const currentIndex = levels.indexOf(current);
    let newIndex = currentIndex + direction * this.learningRate;

    // 确保在有效范围内
    newIndex = Math.max(0, Math.min(levels.length - 1, Math.round(newIndex)));
    return levels[newIndex];
  }

  /**
   * 评估风险容忍度
   */
  private assessRiskTolerance(action: UserAction): string {
    if (action.satisfaction === 'low' && action.compressionLevel === 'heavy') {
      return 'low';
    } else if (action.satisfaction === 'high' && action.compressionLevel === 'heavy') {
      return 'high';
    }
    return 'medium';
  }

  /**
   * 更新风险容忍度
   */
  private updateRiskTolerance(
    current: string,
    newRisk: string,
    positive: boolean
  ): string {
    const toleranceOrder = ['low', 'medium', 'high'];
    if (positive) {
      // 向更高容忍度移动
      if (toleranceOrder.indexOf(newRisk) > toleranceOrder.indexOf(current)) {
        return newRisk;
      }
    } else {
      // 向更低容忍度移动
      if (toleranceOrder.indexOf(newRisk) < toleranceOrder.indexOf(current)) {
        return newRisk;
      }
    }
    return current;
  }

  /**
   * 计算工具分数
   */
  private calculateToolScore(action: UserAction): number {
    let score = 50; // 基础分数

    // 基于满意度
    if (action.satisfaction === 'high') score += 30;
    else if (action.satisfaction === 'low') score -= 20;

    // 基于响应时间
    if (action.responseTime < 1000) score += 20;
    else if (action.responseTime > 5000) score -= 20;

    return Math.max(0, score);
  }

  /**
   * 更新时间敏感性
   */
  private updateTimeSensitivity(
    current: number,
    urgency: string,
    responseTime: number,
    satisfaction: string
  ): number {
    let newSensitivity = current;

    // 基于紧急程度
    const urgencyFactor = {
      immediate: 0.3,
      high: 0.2,
      medium: 0.1,
      low: 0,
    };
    newSensitivity += urgencyFactor[urgency as keyof typeof urgencyFactor];

    // 基于响应时间和满意度
    if (satisfaction === 'high' && responseTime < 1000) {
      newSensitivity += 0.1;
    } else if (satisfaction === 'low' && responseTime > 3000) {
      newSensitivity += 0.2;
    }

    return Math.min(1, newSensitivity * (1 - this.learningRate) + newSensitivity * this.learningRate);
  }

  /**
   * 更新质量优先级
   */
  private updateQualityPriority(
    current: number,
    inputSize: number,
    outputSize: number,
    satisfaction: string
  ): number {
    let newPriority = current;

    // 基于输入输出比例
    const ratio = outputSize / inputSize;
    if (ratio > 0.8) {
      newPriority += 0.1; // 保留较多内容
    } else if (ratio < 0.3) {
      newPriority -= 0.1; // 压缩较多
    }

    // 基于满意度
    if (satisfaction === 'high') {
      newPriority += 0.05;
    } else if (satisfaction === 'low') {
      newPriority -= 0.05;
    }

    return Math.max(0, Math.min(1, newPriority));
  }

  /**
   * 计算节省量
   */
  private calculateSavings(action: UserAction): number {
    return action.inputSize - action.outputSize;
  }

  /**
   * 保存模式
   */
  private savePatterns(): void {
    // 实际实现中会保存到持久化存储
    DEBUG_UTILS.logDebug('UserBehaviorLearner', 'Saved patterns to storage');
  }

  /**
   * 加载保存的模式
   */
  private loadSavedPatterns(): void {
    // 实际实现中会从持久化存储加载
    DEBUG_UTILS.logDebug('UserBehaviorLearner', 'Loaded patterns from storage');
  }

  /**
   * 获取学习统计
   */
  getLearningStats(): {
    totalActions: number;
    patternsFound: number;
    confidence: number;
    userModel: {
      preferredCompression: string;
      riskTolerance: string;
      topTools: string[];
      timeSensitivity: number;
      qualityPriority: number;
    };
  } {
    const topTools = Array.from(this.userModel.toolPreferences.entries())
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([tool]) => tool);

    return {
      totalActions: this.actionHistory.length,
      patternsFound: this.patterns.length,
      confidence: this.calculateConfidence(this.patterns, this.actionHistory),
      userModel: {
        preferredCompression: this.userModel.preferredCompression,
        riskTolerance: this.userModel.riskTolerance,
        topTools,
        timeSensitivity: this.userModel.timeSensitivity,
        qualityPriority: this.userModel.qualityPriority,
      },
    };
  }

  /**
   * 重置学习数据
   */
  resetLearning(): void {
    this.actionHistory = [];
    this.patterns = [];
    this.userModel = {
      preferredCompression: 'medium',
      riskTolerance: 'medium',
      toolPreferences: new Map(),
      timeSensitivity: 0.5,
      qualityPriority: 0.7,
      compressionSavings: 0,
    };
    DEBUG_UTILS.logDebug('UserBehaviorLearner', 'Learning data reset');
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<UserBehaviorConfig>): void {
    this.config = { ...this.config, ...config };
    this.learningRate = this.config.learningRate;
  }

  /**
   * 获取当前配置
   */
  getConfig(): UserBehaviorConfig {
    return { ...this.config };
  }
}