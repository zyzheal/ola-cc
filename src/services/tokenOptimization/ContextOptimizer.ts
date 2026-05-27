/**
 * Context Optimizer
 *
 * 优化系统提示词和工具架构的 token 使用，确保对话在 context window 内高效运行
 */

import { ContextOptimizationConfig } from './types';
import { TOKEN_ESTIMATION_UTILS, TEXT_UTILS, DEBUG_UTILS } from './utils';
import { DEFAULT_CONFIG } from './constants';

export interface ContextStats {
  systemPromptTokens: number;
  toolsSchemaTokens: number;
  conversationHistoryTokens: number;
  totalContextTokens: number;
  availableTokens: number;
  utilizationRate: number;
}

export interface OptimizationResult {
  optimized: boolean;
  actionsTaken: string[];
  stats: ContextStats;
  savings: number;
}

export class ContextOptimizer {
  private config: ContextOptimizationConfig;
  private history: Array<{
    timestamp: number;
    stats: ContextStats;
    actions: string[];
  }> = [];
  private lastOptimization = 0;

  constructor(config?: Partial<ContextOptimizationConfig>) {
    this.config = {
      ...DEFAULT_CONFIG.contextOptimization,
      ...config,
    };
  }

  /**
   * 优化上下文
   */
  async optimize(
    systemPrompt: string,
    toolsSchema: any[],
    conversationHistory: any[],
    currentModel: string
  ): Promise<OptimizationResult> {
    const startTime = performance.now();
    const actionsTaken: string[] = [];

    // 计算当前上下文统计
    const currentStats = this.calculateContextStats(
      systemPrompt,
      toolsSchema,
      conversationHistory
    );

    // 检查是否需要优化
    if (!this.needsOptimization(currentStats)) {
      DEBUG_UTILS.logDebug('ContextOptimizer', 'No optimization needed');

      return {
        optimized: false,
        actionsTaken: [],
        stats: currentStats,
        savings: 0,
      };
    }

    // 执行优化
    let optimizedPrompt = systemPrompt;
    let optimizedTools = [...toolsSchema];

    // 1. 优化系统提示词
    if (currentStats.systemPromptTokens > this.config.systemPrompt) {
      const promptOptimization = this.optimizeSystemPrompt(optimizedPrompt);
      optimizedPrompt = promptOptimization.optimized;
      actionsTaken.push(...promptOptimization.actions);
    }

    // 2. 优化工具架构
    if (currentStats.toolsSchemaTokens > this.config.toolsSchema) {
      const toolsOptimization = this.optimizeToolsSchema(optimizedTools, currentModel);
      optimizedTools = toolsOptimization.optimized;
      actionsTaken.push(...toolsOptimization.actions);
    }

    // 3. 优化对话历史
    const historyOptimization = this.optimizeConversationHistory(
      conversationHistory,
      currentStats.totalContextTokens
    );
    actionsTaken.push(...historyOptimization.actions);

    // 计算优化后的统计
    const optimizedStats = this.calculateContextStats(optimizedPrompt, optimizedTools, historyOptimization.optimized);

    const savings = currentStats.totalContextTokens - optimizedStats.totalContextTokens;
    const duration = performance.now() - startTime;

    DEBUG_UTILS.logDebug('ContextOptimizer',
      `Context optimization completed: ${savings} tokens saved (${duration}ms)`,
      {
        current: currentStats,
        optimized: optimizedStats,
        actions: actionsTaken,
      }
    );

    // 记录优化历史
    this.recordOptimization(optimizedStats, actionsTaken);

    return {
      optimized: true,
      actionsTaken,
      stats: optimizedStats,
      savings,
    };
  }

  /**
   * 计算上下文统计
   */
  private calculateContextStats(
    systemPrompt: string,
    toolsSchema: any[],
    conversationHistory: any[]
  ): ContextStats {
    const systemPromptTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(systemPrompt);
    const toolsSchemaTokens = this.estimateToolsSchemaTokens(toolsSchema);
    const conversationHistoryTokens = this.estimateConversationHistoryTokens(conversationHistory);

    const totalContextTokens = systemPromptTokens + toolsSchemaTokens + conversationHistoryTokens;

    // 保守估计可用 token（保留缓冲）
    const availableTokens = this.getContextWindow() - totalContextTokens - this.config.minConversationSpace;

    const utilizationRate = totalContextTokens / this.getContextWindow();

    return {
      systemPromptTokens,
      toolsSchemaTokens,
      conversationHistoryTokens,
      totalContextTokens,
      availableTokens,
      utilizationRate,
    };
  }

  /**
   * 检查是否需要优化
   */
  private needsOptimization(stats: ContextStats): boolean {
    // 检查利用率是否过高
    if (stats.utilizationRate > this.config.maxUtilizationRate) {
      return true;
    }

    // 检查可用 token 是否过少
    if (stats.availableTokens < this.config.minConversationSpace) {
      return true;
    }

    // 检查系统提示词是否过大
    if (stats.systemPromptTokens > this.config.systemPrompt) {
      return true;
    }

    // 检查工具架构是否过大
    if (stats.toolsSchemaTokens > this.config.toolsSchema) {
      return true;
    }

    return false;
  }

  /**
   * 优化系统提示词
   */
  private optimizeSystemPrompt(prompt: string): {
    optimized: string;
    actions: string[];
  } {
    const actions: string[] = [];
    let optimized = prompt;

    // 1. 移除重复的指令
    const originalLength = prompt.length;
    optimized = this.removeDuplicateInstructions(optimized);
    if (optimized.length < originalLength) {
      actions.push('Removed duplicate instructions');
    }

    // 2. 压缩冗余描述
    const beforeCompress = optimized.length;
    optimized = this.compressRedundantDescriptions(optimized);
    if (optimized.length < beforeCompress) {
      actions.push('Compressed redundant descriptions');
    }

    // 3. 移除非必要的历史回顾
    const beforeHistory = optimized.length;
    optimized = this.removeHistoricalReferences(optimized);
    if (optimized.length < beforeHistory) {
      actions.push('Removed historical references');
    }

    // 4. 如果仍然太大，使用智能截断
    if (TOKEN_ESTIMATION_UTILS.estimateTokens(optimized) > this.config.systemPrompt) {
      optimized = TEXT_UTILS.smartTruncate(optimized, this.config.systemPrompt, 'summary');
      actions.push('Applied intelligent truncation to system prompt');
    }

    return { optimized, actions };
  }

  /**
   * 优化工具架构
   */
  private optimizeToolsSchema(tools: any[], model: string): {
    optimized: any[];
    actions: string[];
  } {
    const actions: string[] = [];
    let optimized = [...tools];

    // 1. 根据模型特性调整工具优先级
    optimized = this.adjustToolsForModel(optimized, model);
    actions.push('Adjusted tools for model capabilities');

    // 2. 移除低频使用的工具
    const originalCount = optimized.length;
    optimized = this.removeLowFrequencyTools(optimized);
    if (optimized.length < originalCount) {
      actions.push(`Removed ${originalCount - optimized.length} low-frequency tools`);
    }

    // 3. 压缩工具描述
    optimized = this.compressToolDescriptions(optimized);
    actions.push('Compressed tool descriptions');

    // 4. 应用工具排名
    optimized = this.rankToolsByRelevance(optimized);
    actions.push('Ranked tools by relevance');

    return { optimized, actions };
  }

  /**
   * 优化对话历史
   */
  private optimizeConversationHistory(
    history: any[],
    totalContextTokens: number
  ): {
    optimized: any[];
    actions: string[];
  } {
    const actions: string[] = [];
    let optimized = [...history];

    // 1. 移除已完成的工具调用结果
    optimized = this.removeCompletedToolCalls(optimized);
    actions.push('Removed completed tool calls');

    // 2. 压缩系统消息
    optimized = this.compressSystemMessages(optimized);
    actions.push('Compressed system messages');

    // 3. 应用历史截断
    if (optimized.length > this.config.maxHistory) {
      optimized = optimized.slice(-this.config.maxHistory);
      actions.push(`Limited history to ${this.config.maxHistory} messages`);
    }

    // 4. 移除冗余的用户消息
    optimized = this.removeRedundantUserMessages(optimized);
    actions.push('Removed redundant user messages');

    return { optimized, actions };
  }

  /**
   * 估算工具架构 token 数量
   */
  private estimateToolsSchemaTokens(tools: any[]): number {
    // 简化的估算：每个工具约 200-500 tokens
    return tools.length * 350;
  }

  /**
   * 估算对话历史 token 数量
   */
  private estimateConversationHistoryTokens(history: any[]): number {
    let tokens = 0;
    for (const message of history) {
      if (message.content) {
        if (typeof message.content === 'string') {
          tokens += TOKEN_ESTIMATION_UTILS.estimateTokens(message.content);
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (typeof part === 'string') {
              tokens += TOKEN_ESTIMATION_UTILS.estimateTokens(part);
            }
          }
        }
      }
    }
    return tokens;
  }

  /**
   * 获取上下文窗口大小
   */
  private getContextWindow(): number {
    // 根据模型返回不同的上下文窗口
    switch (this.config.model) {
      case 'claude-3-opus':
      case 'opus':
        return 200000;
      case 'claude-3-sonnet':
      case 'sonnet':
        return 200000;
      case 'claude-3-haiku':
      case 'haiku':
        return 200000;
      default:
        if (process.env.DEBUG_TOKEN_OPTIMIZATION && !this.config.model) {
          console.warn('[ContextOptimizer] Unknown or unspecified model, using default context window of 200000');
        }
        return 200000; // 默认值
    }
  }

  /**
   * 移除重复指令
   */
  private removeDuplicateInstructions(prompt: string): string {
    // 移除重复的 "You are" 部分
    const youArePattern = /You are.*?\.You are.*?\.?/g;
    prompt = prompt.replace(youArePattern, (match) => {
      const parts = match.split('You are');
      return parts[0] + 'You are' + parts.slice(1).join('').replace(/You are/, '');
    });

    return prompt;
  }

  /**
   * 压缩冗余描述
   */
  private compressRedundantDescriptions(prompt: string): string {
    // 移除重复的行
    const lines = prompt.split('\n');
    const uniqueLines = new Set<string>();
    const compressedLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !uniqueLines.has(trimmed)) {
        uniqueLines.add(trimmed);
        compressedLines.push(line);
      }
    }

    return compressedLines.join('\n');
  }

  /**
   * 移除历史回顾
   */
  private removeHistoricalReferences(prompt: string): string {
    // 移除具体的日期和版本信息
    const datePattern = /\d{4}-\d{2}-\d{2}/g;
    const versionPattern = /\bv\d+\.\d+\.\d+\b/g;

    prompt = prompt.replace(datePattern, '[DATE]');
    prompt = prompt.replace(versionPattern, '[VERSION]');

    return prompt;
  }

  /**
   * 根据模型调整工具
   */
  private adjustToolsForModel(tools: any[], model: string): any[] {
    // 对于小模型，移除复杂工具
    if (model.includes('haiku') || model.includes('sonnet')) {
      return tools.filter(tool =>
        !tool.name.toLowerCase().includes('agent') &&
        !tool.name.toLowerCase().includes('workflow')
      );
    }

    return tools;
  }

  /**
   * 移除低频使用工具
   */
  private removeLowFrequencyTools(tools: any[]): any[] {
    // 模拟的工具使用频率数据（实际实现需要从使用统计中获取）
    const highFrequencyTools = [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
      'FileEdit', 'FileWrite', 'ToolSearch', 'AskUserQuestion'
    ];

    return tools.filter(tool => highFrequencyTools.includes(tool.name));
  }

  /**
   * 压缩工具描述
   */
  private compressToolDescriptions(tools: any[]): any[] {
    return tools.map(tool => ({
      ...tool,
      description: TEXT_UTILS.smartTruncate(tool.description, 200, 'summary'),
    }));
  }

  /**
   * 按相关性排名工具
   */
  private rankToolsByRelevance(tools: any[]): any[] {
    // 核心工具在前
    const coreTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];
    const otherTools = tools.filter(tool => !coreTools.includes(tool.name));

    return [...coreTools.map(name => tools.find(t => t.name === name)!), ...otherTools];
  }

  /**
   * 移除已完成的工具调用
   */
  private removeCompletedToolCalls(history: any[]): any[] {
    return history.filter(message => {
      // 移除工具调用的结果消息（保留工具调用的请求）
      if (message.role === 'assistant' && message.content) {
        if (typeof message.content === 'string') {
          return !message.content.includes('Tool called') && !message.content.includes('Result:');
        }
      }
      return true;
    });
  }

  /**
   * 压缩系统消息
   */
  private compressSystemMessages(history: any[]): any[] {
    return history.filter(message => {
      if (message.role === 'system') {
        return TOKEN_ESTIMATION_UTILS.estimateTokens(message.content || '') < 1000;
      }
      return true;
    });
  }

  /**
   * 移除冗余用户消息
   */
  private removeRedundantUserMessages(history: any[]): any[] {
    const userMessages = history.filter(m => m.role === 'user');
    const uniqueMessages: string[] = [];

    return history.filter(message => {
      if (message.role === 'user') {
        const content = typeof message.content === 'string' ? message.content :
          (Array.isArray(message.content) ? message.content.join('') : '');

        if (!uniqueMessages.includes(content)) {
          uniqueMessages.push(content);
          return true;
        }
        return false;
      }
      return true;
    });
  }

  /**
   * 记录优化历史
   */
  private recordOptimization(stats: ContextStats, actions: string[]): void {
    this.history.push({
      timestamp: Date.now(),
      stats,
      actions,
    });

    // 保持历史记录大小
    if (this.history.length > this.config.maxHistorySize) {
      this.history = this.history.slice(-this.config.maxHistorySize);
    }
  }

  /**
   * 获取优化统计
   */
  getOptimizationStats(): {
    totalOptimizations: number;
    averageSavings: number;
    mostEffectiveAction: string;
    contextUtilization: number;
  } {
    if (this.history.length === 0) {
      return {
        totalOptimizations: 0,
        averageSavings: 0,
        mostEffectiveAction: 'N/A',
        contextUtilization: 0,
      };
    }

    const totalSavings = this.history.reduce((sum, h) => sum + h.stats.totalContextTokens, 0);
    const avgSavings = totalSavings / this.history.length;

    const actionCounts: { [key: string]: number } = {};
    this.history.forEach(h => {
      h.actions.forEach(action => {
        actionCounts[action] = (actionCounts[action] || 0) + 1;
      });
    });

    const mostEffectiveAction = Object.entries(actionCounts)
      .sort(([,a], [,b]) => b - a)[0]?.[0] || 'N/A';

    const latestUtilization = this.history[this.history.length - 1].stats.utilizationRate;

    return {
      totalOptimizations: this.history.length,
      averageSavings: avgSavings,
      mostEffectiveAction,
      contextUtilization: latestUtilization,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ContextOptimizationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): ContextOptimizationConfig {
    return { ...this.config };
  }
}