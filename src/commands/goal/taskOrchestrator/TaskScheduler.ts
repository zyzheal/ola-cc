// src/commands/goal/taskOrchestrator/TaskScheduler.ts
import type { OrchestratedTask, TaskAnalysisResult, ExecutionPlan, ExecutionStage } from './types.js';
import { DEFAULT_MAX_PARALLEL, MAX_SIMPLE_PARALLEL, MAX_MEDIUM_PARALLEL } from './config.js';

export interface ScheduleOptions {
  maxParallel?: number;
  strategy?: 'all' | 'smart' | 'auto';
}

export class TaskScheduler {
  /**
   * 根据分析结果生成执行计划
   */
  async schedule(
    analysis: TaskAnalysisResult,
    options?: ScheduleOptions
  ): Promise<ExecutionPlan> {
    const maxParallel = options?.maxParallel ?? DEFAULT_MAX_PARALLEL;
    const strategy = options?.strategy ?? 'smart';

    // 1. 拓扑排序确定执行顺序
    const sortedTaskIds = this.topologicalSort(analysis.tasks, analysis.dependencyGraph);

    // 2. 分阶段（按依赖层级）
    const stages = this.createStages(
      sortedTaskIds,
      analysis.tasks,
      maxParallel,
      strategy
    );

    // 3. 计算总预估时间
    const totalEstimatedTime = stages.reduce(
      (sum, stage) => sum + stage.estimatedDuration,
      0
    );

    return { stages, totalEstimatedTime };
  }

  /**
   * 拓扑排序（Kahn 算法）
   */
  private topologicalSort(
    tasks: OrchestratedTask[],
    graph: { nodes: Map<string, OrchestratedTask>; edges: Map<string, string[]> }
  ): string[] {
    const inDegree = new Map<string, number>();
    const result: string[] = [];

    // 从 graph.nodes 初始化入度（包含所有节点）
    for (const taskId of graph.nodes.keys()) {
      inDegree.set(taskId, 0);
    }

    // 计算入度：edges 表示 taskId -> 依赖 taskId 的任务列表
    // 即 dependentId 依赖 taskId，所以 dependentId 的入度 +1
    for (const [taskId, dependents] of graph.edges) {
      for (const dependentId of dependents) {
        inDegree.set(dependentId, (inDegree.get(dependentId) || 0) + 1);
      }
    }

    // 入度为 0 的节点队列（没有任务依赖它，可以先执行）
    const queue: string[] = [];
    for (const [taskId, degree] of inDegree) {
      if (degree === 0) queue.push(taskId);
    }

    while (queue.length > 0) {
      const taskId = queue.shift()!;
      result.push(taskId);

      // 更新依赖节点的入度（当 taskId 完成后，依赖它的任务入度减 1）
      const dependents = graph.edges.get(taskId) || [];
      for (const dependentId of dependents) {
        const newDegree = (inDegree.get(dependentId) || 0) - 1;
        inDegree.set(dependentId, newDegree);
        if (newDegree === 0) queue.push(dependentId);
      }
    }

    // 循环检测：如果结果数量不等于节点数量，说明存在循环依赖
    if (result.length !== graph.nodes.size) {
      const remainingNodes = Array.from(graph.nodes.keys()).filter(id => !result.includes(id));
      throw new Error(`检测到循环依赖: ${remainingNodes.join(' -> ')}`);
    }

    return result;
  }

  /**
   * 创建执行阶段
   */
  private createStages(
    sortedTaskIds: string[],
    tasks: OrchestratedTask[],
    maxParallel: number,
    strategy: 'all' | 'smart' | 'auto'
  ): ExecutionStage[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const stages: ExecutionStage[] = [];
    let currentStage: OrchestratedTask[] = [];

    for (const taskId of sortedTaskIds) {
      const task = taskMap.get(taskId);
      if (!task) continue;

      // 检查是否可以加入当前阶段（无依赖在当前阶段外）
      const canAddToStage = this.canAddToStage(task, currentStage, taskMap);
      if (!canAddToStage) {
        // 创建新阶段
        if (currentStage.length > 0) {
          stages.push(this.createStage(stages.length, currentStage, maxParallel, strategy));
        }
        currentStage = [];
      }

      currentStage.push(task);
    }

    // 添加最后一个阶段
    if (currentStage.length > 0) {
      stages.push(this.createStage(stages.length, currentStage, maxParallel, strategy));
    }

    return stages;
  }

  /**
   * 检查任务是否可以加入当前阶段
   */
  private canAddToStage(
    task: OrchestratedTask,
    currentStage: OrchestratedTask[],
    taskMap: Map<string, OrchestratedTask>
  ): boolean {
    const currentStageIds = new Set(currentStage.map(t => t.id));
    for (const depId of task.dependencies) {
      if (!currentStageIds.has(depId)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 创建单个阶段
   */
  private createStage(
    stageId: number,
    tasks: OrchestratedTask[],
    maxParallel: number,
    strategy: 'all' | 'smart' | 'auto'
  ): ExecutionStage {
    let canParallel = false;
    let effectiveMaxParallel = maxParallel;

    if (strategy === 'all') {
      canParallel = tasks.length > 1;
    } else if (strategy === 'smart') {
      // 智能策略：根据任务复杂度决定
      const hasComplex = tasks.some(t => t.complexity === 'complex');
      if (hasComplex) {
        canParallel = false;
        effectiveMaxParallel = 1;
      } else {
        const hasMedium = tasks.some(t => t.complexity === 'medium');
        canParallel = tasks.length > 1;
        effectiveMaxParallel = hasMedium ? MAX_MEDIUM_PARALLEL : MAX_SIMPLE_PARALLEL;
      }
    } else {
      // auto: 根据上下文动态调整（暂定与 smart 相同）
      canParallel = tasks.length > 1;
    }

    return {
      stageId,
      tasks,
      canParallel,
      estimatedDuration: tasks.reduce((sum, t) => sum + t.estimatedTokens * 10, 0),
      effectiveMaxParallel,
    };
  }
}