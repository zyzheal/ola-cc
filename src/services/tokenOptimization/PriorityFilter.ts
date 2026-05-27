/**
 * Priority Filter
 *
 * 根据优先级过滤和优化工具调用，确保高优先级任务优先执行
 */

import { PriorityFilterConfig, Priority, ToolWithPriority } from './types';
import { TOKEN_ESTIMATION_UTILS, TEXT_UTILS, DEBUG_UTILS } from './utils';
import { DEFAULT_CONFIG } from './constants';

export interface ToolCall {
  name: string;
  description: string;
  priority: Priority;
  estimatedTokens: number;
  urgency: 'immediate' | 'high' | 'medium' | 'low';
  dependencies?: string[];
  context?: {
    userIntent: string;
    systemState: string;
    timeSensitivity: boolean;
  };
}

export interface FilterResult {
  filteredTools: ToolWithPriority[];
  blockedTools: ToolWithPriority[];
  reasoning: {
    highPriorityCount: number;
    mediumPriorityCount: number;
    lowPriorityCount: number;
    criticalActions: string[];
  };
  efficiency: {
    potentialSavings: number;
    executionOrder: string[];
  };
}

export class PriorityFilter {
  private config: PriorityFilterConfig;
  private toolHistory = new Map<string, {
    calls: number;
    averageTime: number;
    successRate: number;
    lastUsed: number;
  }>();
  private emergencyMode = false;

  constructor(config?: Partial<PriorityFilterConfig>) {
    this.config = {
      ...DEFAULT_CONFIG.priorityFilter,
      ...config,
    };
  }

  /**
   * 过滤和优先级排序工具
   */
  async filterAndPrioritize(
    tools: ToolWithPriority[],
    context: {
      userIntent: string;
      systemState: string;
      timeSensitivity: boolean;
      availableResources: {
        memory: number;
        time: number;
        concurrentOps: number;
      };
    }
  ): Promise<FilterResult> {
    DEBUG_UTILS.logDebug('PriorityFilter', 'Starting tool filtering and prioritization', {
      toolCount: tools.length,
      timeSensitivity: context.timeSensitivity,
    });

    // 1. 分析工具优先级
    const analyzedTools = await this.analyzeToolPriorities(tools, context);

    // 2. 检查紧急模式
    this.checkEmergencyMode(analyzedTools);

    // 3. 应用过滤器
    const filtered = this.applyFilters(analyzedTools, context);

    // 4. 优化执行顺序
    const executionOrder = this.optimizeExecutionOrder(filtered, context);

    // 5. 生成结果
    const result: FilterResult = {
      filteredTools: filtered,
      blockedTools: this.getBlockedTools(tools, filtered),
      reasoning: this.generateReasoning(filtered),
      efficiency: {
        potentialSavings: this.calculatePotentialSavings(filtered),
        executionOrder,
      },
    };

    DEBUG_UTILS.logDebug('PriorityFilter',
      'Filtering completed',
      {
        remainingTools: filtered.length,
        blockedTools: result.blockedTools.length,
        savings: result.efficiency.potentialSavings,
      }
    );

    return result;
  }

  /**
   * 分析工具优先级
   */
  private async analyzeToolPriorities(
    tools: ToolWithPriority[],
    context: any
  ): Promise<ToolWithPriority[]> {
    return tools.map(tool => {
      const priority = this.calculateToolPriority(tool, context);
      const urgency = this.calculateUrgency(tool, context);

      return {
        ...tool,
        priority,
        urgency,
        estimatedTokens: TOKEN_ESTIMATION_UTILS.estimateTokens(tool.description),
      };
    });
  }

  /**
   * 计算工具优先级
   */
  private calculateToolPriority(tool: ToolWithPriority, context: any): Priority {
    // 1. 基于历史使用频率
    const history = this.toolHistory.get(tool.name);
    const historicalPriority = history ? this.getHistoricalPriority(history) : 'MEDIUM';

    // 2. 基于用户意图匹配
    const intentPriority = this.matchUserIntent(tool, context.userIntent);

    // 3. 基于系统状态
    const statePriority = this.matchSystemState(tool, context.systemState);

    // 4. 基于时间敏感性
    const timePriority = context.timeSensitivity ? this.getTimeSensitivePriority(tool) : 'MEDIUM';

    // 综合判断
    const priorities: Priority[] = [historicalPriority, intentPriority, statePriority, timePriority];

    // 如果有任何 CRITICAL 级别，直接返回
    if (priorities.includes('CRITICAL')) {
      return 'CRITICAL';
    }

    // 如果有 HIGH 级别且超过一半，返回 HIGH
    if (priorities.filter(p => p === 'HIGH').length >= 2) {
      return 'HIGH';
    }

    return priorities.reduce((prev, current) => {
      const priorityOrder: Priority[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
      return priorityOrder.indexOf(prev) > priorityOrder.indexOf(current) ? prev : current;
    }, 'MEDIUM' as Priority);
  }

  /**
   * 计算紧急程度
   */
  private calculateUrgency(tool: ToolWithPriority, context: any): 'immediate' | 'high' | 'medium' | 'low' {
    if (this.emergencyMode && tool.priority === 'CRITICAL') {
      return 'immediate';
    }

    if (context.timeSensitivity && this.isTimeCritical(tool)) {
      return 'high';
    }

    if (tool.name === 'Bash' || tool.name === 'Read') {
      return 'medium';
    }

    return 'low';
  }

  /**
   * 检查紧急模式
   */
  private checkEmergencyMode(tools: ToolWithPriority[]): void {
    const criticalCount = tools.filter(t => t.priority === 'CRITICAL').length;

    if (criticalCount >= this.config.criticalThreshold) {
      this.emergencyMode = true;
      DEBUG_UTILS.logDebug('PriorityFilter', 'Emergency mode activated');
    } else {
      this.emergencyMode = false;
    }
  }

  /**
   * 应用过滤器
   */
  private applyFilters(
    tools: ToolWithPriority[],
    context: any
  ): ToolWithPriority[] {
    let filtered = [...tools];

    // 1. 移除低优先级工具（紧急模式时更严格）
    const priorityThreshold = this.emergencyMode ? 'MEDIUM' : 'LOW';
    filtered = filtered.filter(tool =>
      this.comparePriorities(tool.priority, priorityThreshold) >= 0
    );

    // 2. 资源限制过滤
    filtered = this.applyResourceLimits(filtered, context);

    // 3. 依赖关系过滤
    filtered = this.applyDependencyChecks(filtered);

    return filtered;
  }

  /**
   * 应用资源限制
   */
  private applyResourceLimits(
    tools: ToolWithPriority[],
    context: any
  ): ToolWithPriority[] {
    const { memory, time, concurrentOps } = context.availableResources;

    // 按优先级排序
    const sorted = tools.sort((a, b) =>
      this.comparePriorities(b.priority, a.priority)
    );

    let filtered: ToolWithPriority[] = [];
    let totalMemory = 0;
    let totalTime = 0;
    let concurrentCount = 0;

    for (const tool of sorted) {
      const toolMemory = this.estimateToolMemory(tool);
      const toolTime = this.estimateToolTime(tool);

      // 检查并发限制
      if (concurrentCount >= concurrentOps) {
        continue;
      }

      // 检查内存限制
      if (totalMemory + toolMemory > memory) {
        continue;
      }

      // 检查时间限制
      if (totalTime + toolTime > time) {
        continue;
      }

      filtered.push(tool);
      totalMemory += toolMemory;
      totalTime += toolTime;
      concurrentCount++;
    }

    return filtered;
  }

  /**
   * 应用依赖检查
   */
  private applyDependencyChecks(tools: ToolWithPriority[]): ToolWithPriority[] {
    const availableTools = new Set(tools.map(t => t.name));
    const filtered: ToolWithPriority[] = [];

    for (const tool of tools) {
      // 检查依赖是否满足
      if (tool.dependencies) {
        const dependenciesMet = tool.dependencies.every(dep => availableTools.has(dep));
        if (!dependenciesMet) {
          continue;
        }
      }

      filtered.push(tool);
    }

    return filtered;
  }

  /**
   * 优化执行顺序
   */
  private optimizeExecutionOrder(
    tools: ToolWithPriority[],
    context: any
  ): string[] {
    // 1. 按优先级排序
    const byPriority = tools.sort((a, b) =>
      this.comparePriorities(b.priority, a.priority)
    );

    // 2. 按紧急程度排序
    const byUrgency = byPriority.sort((a, b) => {
      const urgencyOrder = ['immediate', 'high', 'medium', 'low'];
      return urgencyOrder.indexOf(b.urgency) - urgencyOrder.indexOf(a.urgency);
    });

    // 3. 考虑依赖关系
    const executionOrder: string[] = [];
    const executed = new Set<string>();

    while (executed.size < byUrgency.length) {
      let found = false;

      for (const tool of byUrgency) {
        if (executed.has(tool.name)) continue;

        // 检查依赖是否已执行
        const dependenciesMet = !tool.dependencies?.every(dep =>
          !executionOrder.includes(dep)
        ) || !tool.dependencies?.length;

        if (dependenciesMet) {
          executionOrder.push(tool.name);
          executed.add(tool.name);
          found = true;
          break;
        }
      }

      // 如果找不到可以执行的，跳过
      if (!found) {
        break;
      }
    }

    return executionOrder;
  }

  /**
   * 比较优先级
   */
  private comparePriorities(a: Priority, b: Priority): number {
    const priorityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    return priorityOrder.indexOf(a) - priorityOrder.indexOf(b);
  }

  /**
   * 获取历史优先级
   */
  private getHistoricalPriority(history: any): Priority {
    const successRate = history.successRate;

    if (successRate > 0.9) {
      return 'HIGH';
    } else if (successRate > 0.7) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  /**
   * 匹配用户意图
   */
  private matchUserIntent(tool: ToolWithPriority, intent: string): Priority {
    const intentKeywords = {
      'read': ['Read', 'Glob', 'Grep'],
      'write': ['Write', 'Edit', 'FileWrite'],
      'execute': ['Bash', 'Execute'],
      'search': ['Glob', 'Grep', 'ToolSearch'],
      'manage': ['AgentTool', 'Workflow'],
    };

    for (const [keyword, tools] of Object.entries(intentKeywords)) {
      if (intent.includes(keyword) && tools.includes(tool.name)) {
        return 'HIGH';
      }
    }

    return 'MEDIUM';
  }

  /**
   * 匹配系统状态
   */
  private matchSystemState(tool: ToolWithPriority, state: string): Priority {
    if (state.includes('error') && (tool.name === 'Read' || tool.name === 'Bash')) {
      return 'HIGH';
    }

    if (state.includes('performance') && tool.name === 'Bash') {
      return 'HIGH';
    }

    return 'MEDIUM';
  }

  /**
   * 获取时间敏感性优先级
   */
  private getTimeSensitivePriority(tool: ToolWithPriority): Priority {
    const timeCriticalTools = ['Bash', 'Write', 'Edit'];

    if (timeCriticalTools.includes(tool.name)) {
      return 'HIGH';
    }

    return 'MEDIUM';
  }

  /**
   * 检查是否时间关键
   */
  private isTimeCritical(tool: ToolWithPriority): boolean {
    return tool.name === 'Bash' || tool.name === 'Write';
  }

  /**
   * 估算工具内存使用
   */
  private estimateToolMemory(tool: ToolWithPriority): number {
    // 简化的内存估算
    switch (tool.name) {
      case 'Read':
        return 1024 * 1024; // 1MB
      case 'Bash':
        return 2 * 1024 * 1024; // 2MB
      case 'Write':
      case 'Edit':
        return 512 * 1024; // 512KB
      case 'Glob':
      case 'Grep':
        return 256 * 1024; // 256KB
      default:
        return 128 * 1024; // 128KB
    }
  }

  /**
   * 估算工具执行时间
   */
  private estimateToolTime(tool: ToolWithPriority): number {
    // 简化的时间估算（毫秒）
    switch (tool.name) {
      case 'Read':
        return 100;
      case 'Bash':
        return 5000;
      case 'Write':
      case 'Edit':
        return 2000;
      case 'Glob':
      case 'Grep':
        return 1000;
      default:
        return 500;
    }
  }

  /**
   * 生成推理结果
   */
  private generateReasoning(filteredTools: ToolWithPriority[]) {
    const counts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };

    const criticalActions: string[] = [];

    filteredTools.forEach(tool => {
      counts[tool.priority.toLowerCase() as keyof typeof counts]++;
      if (tool.priority === 'CRITICAL') {
        criticalActions.push(tool.name);
      }
    });

    return {
      highPriorityCount: counts.critical + counts.high,
      mediumPriorityCount: counts.medium,
      lowPriorityCount: counts.low,
      criticalActions,
    };
  }

  /**
   * 计算潜在节省
   */
  private calculatePotentialSavings(filteredTools: ToolWithPriority[]): number {
    return filteredTools.reduce((total, tool) => {
      return total + tool.estimatedTokens * 0.3; // 假设能节省 30% 的 tokens
    }, 0);
  }

  /**
   * 获取被阻塞的工具
   */
  private getBlockedTools(allTools: ToolWithPriority[], filteredTools: ToolWithPriority[]) {
    const filteredNames = new Set(filteredTools.map(t => t.name));
    return allTools.filter(tool => !filteredNames.has(tool.name));
  }

  /**
   * 记录工具使用
   */
  recordToolUsage(toolName: string, success: boolean, executionTime: number): void {
    const history = this.toolHistory.get(toolName) || {
      calls: 0,
      averageTime: 0,
      successRate: 0,
      lastUsed: 0,
    };

    history.calls++;
    history.lastUsed = Date.now();
    history.averageTime = (history.averageTime * (history.calls - 1) + executionTime) / history.calls;
    history.successRate = (history.successRate * (history.calls - 1) + (success ? 1 : 0)) / history.calls;

    this.toolHistory.set(toolName, history);
  }

  /**
   * 获取过滤统计
   */
  getFilterStats(): {
    totalToolsProcessed: number;
    averageFilterRate: number;
    emergencyModeCount: number;
    topPrioritizedTools: string[];
  } {
    const totalTools = Array.from(this.toolHistory.values()).reduce((sum, h) => sum + h.calls, 0);
    const emergencyCount = this.emergencyMode ? 1 : 0;

    const topTools = Array.from(this.toolHistory.entries())
      .sort(([,a], [,b]) => b.successRate - a.successRate)
      .slice(0, 5)
      .map(([name]) => name);

    return {
      totalToolsProcessed: totalTools,
      averageFilterRate: 0.8, // 假设平均值
      emergencyModeCount: emergencyCount,
      topPrioritizedTools: topTools,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<PriorityFilterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): PriorityFilterConfig {
    return { ...this.config };
  }

  /**
   * 重置紧急模式
   */
  resetEmergencyMode(): void {
    this.emergencyMode = false;
  }
}