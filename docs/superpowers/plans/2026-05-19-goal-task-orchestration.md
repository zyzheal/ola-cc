# Goal 任务编排与并行执行实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/goal` 命令添加自动任务拆分和智能并行执行能力

**Architecture:** 新建 `taskOrchestrator` 模块，包含 TaskAnalyzer、TaskScheduler、TaskExecutor、ResultAggregator 四个核心组件。使用现有 `runAgent` 函数执行任务，通过 `agentType` 参数选择执行模式。

**Tech Stack:** TypeScript, 复用现有 AgentTool、GoalTask 类型

---

## 文件结构

```
src/commands/goal/taskOrchestrator/
├── index.ts                # 统一导出，GoalTaskOrchestrator 主类
├── config.ts               # 配置参数（超时、并行数等）
├── types.ts                # 类型定义（扩展 GoalTask）
├── TaskAnalyzer.ts         # 任务分析器：拆分 + 依赖分析 + 循环检测
├── TaskScheduler.ts        # 任务调度器：智能并行决策
├── TaskExecutor.ts         # 任务执行器：使用 runAgent 执行
└── ResultAggregator.ts     # 结果聚合器
```

需要修改：
- `src/commands/goal/goal.tsx` - 集成任务编排
- `src/commands/goal/types.ts` - 确认 GoalTask 已被正确引用

---

## Task 1: 创建配置模块 (config.ts)

**Files:**
- Create: `src/commands/goal/taskOrchestrator/config.ts`

- [ ] **Step 1: 创建配置模块**

```typescript
// src/commands/goal/taskOrchestrator/config.ts

// 并行策略配置
export const MAX_SIMPLE_PARALLEL = 5;
export const MAX_MEDIUM_PARALLEL = 3;
export const DEFAULT_MAX_PARALLEL = 3;

// 超时配置
export const TASK_TIMEOUT_MS = 5 * 60 * 1000;  // 5 分钟
export const STAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

// 重试配置
export const DEFAULT_RETRY_COUNT = 1;

// 复杂度阈值
export const COMPLEXITY_THRESHOLDS = {
  simple: { maxTokens: 1000, maxTools: 2 },
  medium: { maxTokens: 5000, maxTools: 5 },
};

export interface OrchestratorConfig {
  maxParallel: number;
  strategy: 'all' | 'smart' | 'auto';
  timeoutMs: number;
  retryCount: number;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  maxParallel: DEFAULT_MAX_PARALLEL,
  strategy: 'smart',
  timeoutMs: TASK_TIMEOUT_MS,
  retryCount: DEFAULT_RETRY_COUNT,
};
```

- [ ] **Step 2: 运行验证**

Run: `bun run build:dev 2>&1 | head -10`
Expected: 构建成功，无错误

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/taskOrchestrator/config.ts
git commit -m "feat(goal): add task orchestrator config module"
```

---

## Task 2: 创建类型定义 (types.ts)

**Files:**
- Create: `src/commands/goal/taskOrchestrator/types.ts`

- [ ] **Step 1: 创建类型定义**

```typescript
// src/commands/goal/taskOrchestrator/types.ts
import type { GoalTask } from '../types.js';

// 扩展 GoalTask，添加编排所需字段
export interface OrchestratedTask extends GoalTask {
  complexity: 'simple' | 'medium' | 'complex';
  estimatedTokens: number;
  requiresMcp?: string[];
  dependencies: string[];  // 依赖的任务 ID
}

export interface TaskAnalysisResult {
  tasks: OrchestratedTask[];
  dependencyGraph: DependencyGraph;
  estimatedParallelism: number;
  qualityScore: SplitQualityScore;
}

export interface DependencyGraph {
  nodes: Map<string, OrchestratedTask>;
  edges: Map<string, string[]>;  // taskId -> dependent taskIds
  hasCycle: boolean;
  cyclePath?: string[];
}

export interface SplitQualityScore {
  averageTaskSize: number;
  independenceScore: number;
  parallelismPotential: number;
}

export interface ExecutionPlan {
  stages: ExecutionStage[];
  totalEstimatedTime: number;
}

export interface ExecutionStage {
  stageId: number;
  tasks: OrchestratedTask[];
  canParallel: boolean;
  estimatedDuration: number;
}

export interface TaskProgressEvent {
  type: 'stage_start' | 'stage_complete' | 'task_start' | 'task_complete' | 'task_error';
  stageId?: number;
  taskId?: string;
  message?: string;
}

export interface ExecutionResult {
  completedTasks: TaskResult[];
  failedTasks: TaskError[];
  aggregatedResult: string;
}

export interface TaskResult {
  taskId: string;
  output: string;
  tokensUsed: number;
  duration: number;
}

export interface TaskError {
  taskId: string;
  error: string;
  canRetry: boolean;
}

export interface AggregatedResult {
  summary: string;
  taskBreakdown: TaskBreakdown[];
  totalTokens: number;
  totalDuration: number;
  recommendations?: string[];
}

export interface TaskBreakdown {
  taskId: string;
  description: string;
  status: 'success' | 'failed' | 'skipped';
  summary: string;
}

export interface CancellationToken {
  isCancelled(): boolean;
  onCancelled(callback: () => void): void;
  cancel(): void;
}
```

- [ ] **Step 2: 运行验证**

Run: `bun run build:dev 2>&1 | head -10`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/taskOrchestrator/types.ts
git commit -m "feat(goal): add task orchestrator types"
```

---

## Task 3: 创建任务分析器 (TaskAnalyzer.ts)

**Files:**
- Create: `src/commands/goal/taskOrchestrator/TaskAnalyzer.ts`

- [ ] **Step 1: 创建任务分析器基础结构**

```typescript
// src/commands/goal/taskOrchestrator/TaskAnalyzer.ts
import type { OrchestratedTask, DependencyGraph, TaskAnalysisResult, SplitQualityScore } from './types.js';
import { COMPLEXITY_THRESHOLDS } from './config.js';

const randomUUID = () => crypto.randomUUID();

export class TaskAnalyzer {
  /**
   * 分析目标，拆分为细粒度任务 + 构建依赖图
   */
  async analyze(
    objective: string,
    explicitDependencies?: { from: string; to: string }[]
  ): Promise<TaskAnalysisResult> {
    // 1. 调用 AI 拆分任务
    const tasks = await this.splitTasks(objective);

    // 2. 构建依赖图
    const dependencyGraph = this.buildDependencyGraph(tasks, explicitDependencies);

    // 3. 检测循环依赖
    const cycleResult = this.detectCycle(dependencyGraph);
    dependencyGraph.hasCycle = cycleResult.hasCycle;
    dependencyGraph.cyclePath = cycleResult.cycle;

    if (cycleResult.hasCycle) {
      throw new Error(`循环依赖 detected: ${cycleResult.cycle.join(' -> ')}`);
    }

    // 4. 评估拆分质量
    const qualityScore = this.evaluateQuality(tasks);

    // 5. 计算预估并行度
    const estimatedParallelism = this.calculateParallelism(tasks, dependencyGraph);

    return { tasks, dependencyGraph, estimatedParallelism, qualityScore };
  }

  /**
   * 使用 AI 拆分任务（占位实现，后续需要调用 AI）
   * TODO: 集成 AI 调用
   */
  private async splitTasks(objective: string): Promise<OrchestratedTask[]> {
    // 临时实现：返回默认任务列表
    // 后续需要替换为 AI 调用
    const defaultTasks = [
      `分析目标: ${objective}`,
      '收集相关信息和资源',
      '设计解决方案',
      '实施方案 - 步骤 1',
      '实施方案 - 步骤 2',
      '实施方案 - 步骤 3',
      '测试和验证',
      '优化和完善',
      '文档和总结',
    ];

    return defaultTasks.map((content, index) => ({
      id: randomUUID(),
      content,
      status: 'pending' as const,
      order: index,
      complexity: this.estimateComplexity(content),
      estimatedTokens: this.estimateTokens(content),
      dependencies: [],
    }));
  }

  /**
   * 评估任务复杂度
   */
  private estimateComplexity(description: string): 'simple' | 'medium' | 'complex' {
    const tokenEstimate = this.estimateTokens(description);
    if (tokenEstimate <= COMPLEXITY_THRESHOLDS.simple.maxTokens) return 'simple';
    if (tokenEstimate <= COMPLEXITY_THRESHOLDS.medium.maxTokens) return 'medium';
    return 'complex';
  }

  /**
   * 估算 token 数量（简单估算）
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * 构建依赖图
   */
  private buildDependencyGraph(
    tasks: OrchestratedTask[],
    explicitDependencies?: { from: string; to: string }[]
  ): DependencyGraph {
    const nodes = new Map<string, OrchestratedTask>();
    const edges = new Map<string, string[]>();

    // 添加所有节点
    for (const task of tasks) {
      nodes.set(task.id, task);
      edges.set(task.id, []);
    }

    // 添加显式依赖
    if (explicitDependencies) {
      for (const dep of explicitDependencies) {
        const fromTask = tasks.find(t => t.content.includes(dep.from));
        const toTask = tasks.find(t => t.content.includes(dep.to));
        if (fromTask && toTask) {
          const deps = edges.get(fromTask.id) || [];
          deps.push(toTask.id);
          edges.set(fromTask.id, deps);
          toTask.dependencies.push(fromTask.id);
        }
      }
    }

    return { nodes, edges, hasCycle: false };
  }

  /**
   * 检测循环依赖（DFS 算法）
   */
  private detectCycle(graph: DependencyGraph): { hasCycle: boolean; cycle?: string[] } {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycle: string[] = [];

    const dfs = (nodeId: string, path: string[]): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      cycle.push(nodeId);

      const dependencies = graph.edges.get(nodeId) || [];
      for (const depId of dependencies) {
        if (!visited.has(depId)) {
          if (dfs(depId, [...path, depId])) return true;
        } else if (recursionStack.has(depId)) {
          cycle.push(depId);
          return true;
        }
      }

      recursionStack.delete(nodeId);
      cycle.pop();
      return false;
    };

    for (const nodeId of graph.nodes.keys()) {
      if (!visited.has(nodeId)) {
        if (dfs(nodeId, [nodeId])) {
          return { hasCycle: true, cycle };
        }
      }
    }

    return { hasCycle: false };
  }

  /**
   * 评估拆分质量
   */
  private evaluateQuality(tasks: OrchestratedTask[]): SplitQualityScore {
    const avgSize = tasks.reduce((sum, t) => sum + t.estimatedTokens, 0) / tasks.length;
    const independentCount = tasks.filter(t => t.dependencies.length === 0).length;

    return {
      averageTaskSize: avgSize,
      independenceScore: independentCount / tasks.length,
      parallelismPotential: independentCount / tasks.length,
    };
  }

  /**
   * 计算预估并行度
   */
  private calculateParallelism(tasks: OrchestratedTask[], graph: DependencyGraph): number {
    const maxParallel = Math.max(
      ...tasks.map(t => {
        if (t.complexity === 'simple') return 5;
        if (t.complexity === 'medium') return 3;
        return 1;
      })
    );
    return Math.min(maxParallel, tasks.length);
  }
}
```

- [ ] **Step 2: 运行验证**

Run: `bun run build:dev 2>&1 | head -10`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/taskOrchestrator/TaskAnalyzer.ts
git commit -m "feat(goal): add TaskAnalyzer with cycle detection"
```

---

## Task 4: 创建任务调度器 (TaskScheduler.ts)

**Files:**
- Create: `src/commands/goal/taskOrchestrator/TaskScheduler.ts`

- [ ] **Step 1: 创建任务调度器**

```typescript
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

    // 初始化入度
    for (const task of tasks) {
      inDegree.set(task.id, 0);
    }

    // 计算入度
    for (const [taskId, deps] of graph.edges) {
      for (const depId of deps) {
        inDegree.set(depId, (inDegree.get(depId) || 0) + 1);
      }
    }

    // 入度为 0 的节点队列
    const queue: string[] = [];
    for (const [taskId, degree] of inDegree) {
      if (degree === 0) queue.push(taskId);
    }

    while (queue.length > 0) {
      const taskId = queue.shift()!;
      result.push(taskId);

      // 更新依赖节点的入度
      const deps = graph.edges.get(taskId) || [];
      for (const depId of deps) {
        const newDegree = (inDegree.get(depId) || 0) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) queue.push(depId);
      }
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

    // 限制并行数
    const parallelTasks = canParallel ? tasks.slice(0, effectiveMaxParallel) : tasks;

    return {
      stageId,
      tasks: parallelTasks,
      canParallel,
      estimatedDuration: tasks.reduce((sum, t) => sum + t.estimatedTokens * 10, 0), // 简单估算
    };
  }
}
```

- [ ] **Step 2: 运行验证**

Run: `bun run build:dev 2>&1 | head -10`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/taskOrchestrator/TaskScheduler.ts
git commit -m "feat(goal): add TaskScheduler with topological sort"
```

---

## Task 5: 创建任务执行器 (TaskExecutor.ts)

**Files:**
- Create: `src/commands/goal/taskOrchestrator/TaskExecutor.ts`

- [ ] **Step 1: 创建任务执行器**

```typescript
// src/commands/goal/taskOrchestrator/TaskExecutor.ts
import type { ToolUseContext } from '../../Tool.js';
import type { ExecutionPlan, ExecutionResult, TaskResult, TaskError, TaskProgressEvent, OrchestratedTask, CancellationToken } from './types.js';
import { TASK_TIMEOUT_MS, DEFAULT_RETRY_COUNT } from './config.js';

export interface TaskExecutorOptions {
  agentType: 'fork' | 'async' | 'sync';
  onProgress?: (event: TaskProgressEvent) => void;
  cancellationToken?: CancellationToken;
}

/**
 * 简单的 CancellationToken 实现
 */
export class SimpleCancellationToken implements CancellationToken {
  private cancelled = false;
  private callbacks: (() => void)[] = [];

  isCancelled(): boolean {
    return this.cancelled;
  }

  onCancelled(callback: () => void): void {
    this.callbacks.push(callback);
  }

  cancel(): void {
    this.cancelled = true;
    for (const cb of this.callbacks) {
      cb();
    }
  }
}

export class TaskExecutor {
  private toolUseContext: ToolUseContext;

  constructor(toolUseContext: ToolUseContext) {
    this.toolUseContext = toolUseContext;
  }

  /**
   * 执行任务计划
   */
  async execute(
    plan: ExecutionPlan,
    context: ToolUseContext,
    options: TaskExecutorOptions
  ): Promise<ExecutionResult> {
    const completedTasks: TaskResult[] = [];
    const failedTasks: TaskError[] = [];

    for (const stage of plan.stages) {
      // 检查取消状态
      if (options.cancellationToken?.isCancelled()) {
        break;
      }

      // 发送阶段开始事件
      options.onProgress?.({
        type: 'stage_start',
        stageId: stage.stageId,
        message: `开始阶段 ${stage.stageId + 1}/${plan.stages.length}`,
      });

      if (stage.canParallel && stage.tasks.length > 1) {
        // 并行执行
        const results = await Promise.all(
          stage.tasks.map(task =>
            this.executeTask(task, context, options)
          )
        );

        for (const result of results) {
          if (result.success) {
            completedTasks.push(result.result!);
          } else {
            failedTasks.push(result.error!);
          }
        }
      } else {
        // 串行执行
        for (const task of stage.tasks) {
          if (options.cancellationToken?.isCancelled()) {
            break;
          }

          const result = await this.executeTask(task, context, options);
          if (result.success) {
            completedTasks.push(result.result!);
          } else {
            failedTasks.push(result.error!);
          }
        }
      }

      // 发送阶段完成事件
      options.onProgress?.({
        type: 'stage_complete',
        stageId: stage.stageId,
        message: `阶段 ${stage.stageId + 1} 完成`,
      });
    }

    return {
      completedTasks,
      failedTasks,
      aggregatedResult: this.generateAggregatedResult(completedTasks, failedTasks),
    };
  }

  /**
   * 执行单个任务
   */
  private async executeTask(
    task: OrchestratedTask,
    context: ToolUseContext,
    options: TaskExecutorOptions
  ): Promise<{ success: boolean; result?: TaskResult; error?: TaskError }> {
    const startTime = Date.now();

    // 发送任务开始事件
    options.onProgress?.({
      type: 'task_start',
      taskId: task.id,
      message: `开始任务: ${task.content}`,
    });

    try {
      // TODO: 集成 runAgent 执行任务
      // 临时实现：模拟任务执行
      const output = await this.simulateTaskExecution(task, options);

      const duration = Date.now() - startTime;
      const tokensUsed = Math.ceil(task.estimatedTokens);

      options.onProgress?.({
        type: 'task_complete',
        taskId: task.id,
        message: `任务完成: ${task.content}`,
      });

      return {
        success: true,
        result: {
          taskId: task.id,
          output,
          tokensUsed,
          duration,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = Date.now() - startTime;

      options.onProgress?.({
        type: 'task_error',
        taskId: task.id,
        message: `任务失败: ${task.content} - ${errorMessage}`,
      });

      return {
        success: false,
        error: {
          taskId: task.id,
          error: errorMessage,
          canRetry: this.isRetryable(error),
        },
      };
    }
  }

  /**
   * 模拟任务执行（TODO: 替换为真实的 runAgent 调用）
   */
  private async simulateTaskExecution(
    task: OrchestratedTask,
    options: TaskExecutorOptions
  ): Promise<string> {
    // 检查取消状态
    if (options.cancellationToken?.isCancelled()) {
      throw new Error('任务已取消');
    }

    // 模拟执行延迟
    await new Promise(resolve => setTimeout(resolve, 100));

    // TODO: 后续集成 runAgent
    // const agentParams = {
    //   agentDefinition: FORK_AGENT,
    //   promptMessages: [createUserMessage({ content: task.content })],
    //   toolUseContext: this.toolUseContext,
    //   isAsync: options.agentType !== 'sync',
    //   ...
    // };
    // for await (const msg of runAgent(agentParams)) { ... }

    return `任务 "${task.content}" 已完成`;
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      // 网络错误、超时等可重试
      const retryablePatterns = ['timeout', 'network', 'ECONNREFUSED', 'ETIMEDOUT'];
      return retryablePatterns.some(p => error.message.toLowerCase().includes(p));
    }
    return false;
  }

  /**
   * 生成聚合结果
   */
  private generateAggregatedResult(
    completedTasks: TaskResult[],
    failedTasks: TaskError[]
  ): string {
    const total = completedTasks.length + failedTasks.length;
    const successCount = completedTasks.length;
    const failCount = failedTasks.length;

    let result = `任务执行完成：${successCount}/${total} 成功`;
    if (failCount > 0) {
      result += `，${failCount} 失败`;
    }
    return result;
  }
}
```

- [ ] **Step 2: 运行验证**

Run: `bun run build:dev 2>&1 | head -10`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/taskOrchestrator/TaskExecutor.ts
git commit -m "feat(goal): add TaskExecutor with parallel execution"
```

---

## Task 6: 创建结果聚合器 (ResultAggregator.ts)

**Files:**
- Create: `src/commands/goal/taskOrchestrator/ResultAggregator.ts`

- [ ] **Step 1: 创建结果聚合器**

```typescript
// src/commands/goal/taskOrchestrator/ResultAggregator.ts
import type { ExecutionResult, AggregatedResult, TaskBreakdown } from './types.js';

export class ResultAggregator {
  /**
   * 聚合任务执行结果
   */
  async aggregate(
    results: ExecutionResult,
    originalObjective: string
  ): Promise<AggregatedResult> {
    const taskBreakdown = this.createTaskBreakdown(results);
    const summary = this.generateSummary(results, originalObjective);
    const recommendations = this.generateRecommendations(results);

    const totalTokens = results.completedTasks.reduce((sum, t) => sum + t.tokensUsed, 0);
    const totalDuration = results.completedTasks.reduce((sum, t) => sum + t.duration, 0);

    return {
      summary,
      taskBreakdown,
      totalTokens,
      totalDuration,
      recommendations,
    };
  }

  /**
   * 创建任务分解表
   */
  private createTaskBreakdown(results: ExecutionResult): TaskBreakdown[] {
    const breakdown: TaskBreakdown[] = [];

    // 添加成功的任务
    for (const task of results.completedTasks) {
      breakdown.push({
        taskId: task.taskId,
        description: task.output,
        status: 'success',
        summary: task.output.substring(0, 200),
      });
    }

    // 添加失败的任务
    for (const error of results.failedTasks) {
      breakdown.push({
        taskId: error.taskId,
        description: error.error,
        status: 'failed',
        summary: error.error,
      });
    }

    return breakdown;
  }

  /**
   * 生成总结
   */
  private generateSummary(results: ExecutionResult, objective: string): string {
    const total = results.completedTasks.length + results.failedTasks.length;
    const successRate = total > 0 ? Math.round((results.completedTasks.length / total) * 100) : 0;

    let summary = `目标 "${objective}" 执行完成\n`;
    summary += `- 总任务数: ${total}\n`;
    summary += `- 成功: ${results.completedTasks.length}\n`;
    summary += `- 失败: ${results.failedTasks.length}\n`;
    summary += `- 成功率: ${successRate}%\n`;

    if (results.completedTasks.length > 0) {
      summary += `\n完成的任务:\n`;
      for (const task of results.completedTasks) {
        summary += `- ${task.output}\n`;
      }
    }

    if (results.failedTasks.length > 0) {
      summary += `\n失败的任务:\n`;
      for (const error of results.failedTasks) {
        summary += `- ${error.taskId}: ${error.error}\n`;
      }
    }

    return summary;
  }

  /**
   * 生成建议
   */
  private generateRecommendations(results: ExecutionResult): string[] {
    const recommendations: string[] = [];

    if (results.failedTasks.length > 0) {
      recommendations.push('部分任务失败，建议检查失败原因后重试');
    }

    if (results.completedTasks.length > 10) {
      recommendations.push('任务数量较多，可考虑进一步拆分以提高并行度');
    }

    return recommendations;
  }
}
```

- [ ] **Step 2: 运行验证**

Run: `bun run build:dev 2>&1 | head -10`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/taskOrchestrator/ResultAggregator.ts
git commit -m "feat(goal): add ResultAggregator"
```

---

## Task 7: 创建统一导出和主类 (index.ts)

**Files:**
- Create: `src/commands/goal/taskOrchestrator/index.ts`

- [ ] **Step 1: 创建统一导出**

```typescript
// src/commands/goal/taskOrchestrator/index.ts
export { TaskAnalyzer } from './TaskAnalyzer.js';
export { TaskScheduler, type ScheduleOptions } from './TaskScheduler.js';
export { TaskExecutor, SimpleCancellationToken, type TaskExecutorOptions } from './TaskExecutor.js';
export { ResultAggregator } from './ResultAggregator.js';
export { DEFAULT_CONFIG, type OrchestratorConfig } from './config.js';

export type {
  OrchestratedTask,
  TaskAnalysisResult,
  DependencyGraph,
  SplitQualityScore,
  ExecutionPlan,
  ExecutionStage,
  TaskProgressEvent,
  ExecutionResult,
  TaskResult,
  TaskError,
  AggregatedResult,
  TaskBreakdown,
  CancellationToken,
} from './types.js';

/**
 * GoalTaskOrchestrator - 主类
 * 整合所有模块，提供统一的任务编排入口
 */
import type { ToolUseContext } from '../../Tool.js';
import type { OrchestratorConfig, AggregatedResult } from './index.js';
import { TaskAnalyzer } from './TaskAnalyzer.js';
import { TaskScheduler } from './TaskScheduler.js';
import { TaskExecutor, SimpleCancellationToken } from './TaskExecutor.js';
import { ResultAggregator } from './ResultAggregator.js';
import { DEFAULT_CONFIG } from './config.js';

export class GoalTaskOrchestrator {
  private analyzer: TaskAnalyzer;
  private scheduler: TaskScheduler;
  private executor: TaskExecutor;
  private aggregator: ResultAggregator;
  private config: OrchestratorConfig;
  private cancellationToken: SimpleCancellationToken;

  constructor(
    private toolUseContext: ToolUseContext,
    config?: Partial<OrchestratorConfig>
  ) {
    this.analyzer = new TaskAnalyzer();
    this.scheduler = new TaskScheduler();
    this.executor = new TaskExecutor(toolUseContext);
    this.aggregator = new ResultAggregator();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cancellationToken = new SimpleCancellationToken();
  }

  /**
   * 执行目标
   */
  async execute(
    objective: string,
    onProgress?: (event: { type: string; message: string }) => void
  ): Promise<AggregatedResult> {
    // 1. 分析目标，拆分任务
    const analysis = await this.analyzer.analyze(objective);

    // 2. 生成执行计划
    const plan = await this.scheduler.schedule(analysis, {
      maxParallel: this.config.maxParallel,
      strategy: this.config.strategy,
    });

    // 3. 执行任务
    const executionResult = await this.executor.execute(
      plan,
      this.toolUseContext,
      {
        agentType: 'fork',
        onProgress: (event) => {
          onProgress?.({
            type: event.type,
            message: event.message || '',
          });
        },
        cancellationToken: this.cancellationToken,
      }
    );

    // 4. 聚合结果
    const aggregatedResult = await this.aggregator.aggregate(
      executionResult,
      objective
    );

    return aggregatedResult;
  }

  /**
   * 取消执行
   */
  cancel(): void {
    this.cancellationToken.cancel();
  }
}
```

- [ ] **Step 2: 运行验证**

Run: `bun run build:dev 2>&1 | head -10`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/taskOrchestrator/index.ts
git commit -m "feat(goal): add GoalTaskOrchestrator main class"
```

---

## Task 8: 集成到 Goal 命令 (goal.tsx)

**Files:**
- Modify: `src/commands/goal/goal.tsx`

- [ ] **Step 1: 修改 goal.tsx 添加 autoSplit 参数**

在文件顶部添加导入：
```typescript
import { GoalTaskOrchestrator } from './taskOrchestrator/index.js';
```

找到 `GoalCommandArgs` 接口，添加：
```typescript
interface GoalCommandArgs {
  // ... existing
  autoSplit?: boolean;     // 自动拆分任务
  maxParallel?: number;    // 最大并行数
}
```

找到 `parseGoalArgs` 函数，添加参数解析：
```typescript
const autoSplitIndex = args.indexOf('--auto-split');
const autoSplit = autoSplitIndex !== -1;
if (autoSplit) {
  args = args.filter(a => a !== '--auto-split');
}

const maxParallelMatch = args.find(a => a.startsWith('--max-parallel='));
let maxParallel: number | undefined;
if (maxParallelMatch) {
  maxParallel = parseInt(maxParallelMatch.split('=')[1], 10);
  args = args.filter(a => a !== maxParallelMatch);
```

更新函数返回值包含新参数：
```typescript
return { 
  objective: args.join(' '), 
  tokenBudget, 
  autoAccept, 
  autoEdit, 
  mode, 
  retryInterval, 
  maxRetryHours,
  autoSplit,
  maxParallel,
}
```

- [ ] **Step 2: 添加任务编排执行逻辑**

找到创建新目标的代码段（约第 227 行），添加 autoSplit 分支：

```typescript
// Create new goal
if (!objective) {
  onDone('错误：未提供目标描述。用法：/goal <目标描述>', { display: 'system' })
  return
}

// 新增：autoSplit 模式
if (autoSplit) {
  try {
    const orchestrator = new GoalTaskOrchestrator(context, { maxParallel })
    const result = await orchestrator.execute(objective, (event) => {
      // 进度回调，可以发送到 UI
      context.appendSystemMessage?.({
        type: 'system',
        subtype: 'task_progress',
        content: event.message,
        isMeta: true,
      })
    })
    
    // 更新 goal 状态
    context.setAppState(s => ({
      ...s,
      goal: { ...s.goal, status: 'complete' as ThreadGoalStatus }
    }))
    
    onDone(result.summary, { display: 'system' })
    return
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    onDone(`任务编排失败: ${errorMsg}`, { display: 'system' })
    return
  }
}

// 原有逻辑继续...
```

- [ ] **Step 3: 运行验证**

Run: `bun run build:dev 2>&1 | head -10`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add src/commands/goal/goal.tsx
git commit -m "feat(goal): integrate task orchestration with autoSplit option"
```

---

## 任务完成汇总

- [ ] Task 1: config.ts - 配置模块
- [ ] Task 2: types.ts - 类型定义
- [ ] Task 3: TaskAnalyzer.ts - 任务分析器（含循环检测）
- [ ] Task 4: TaskScheduler.ts - 任务调度器（拓扑排序）
- [ ] Task 5: TaskExecutor.ts - 任务执行器（并行执行）
- [ ] Task 6: ResultAggregator.ts - 结果聚合器
- [ ] Task 7: index.ts - 统一导出和主类
- [ ] Task 8: goal.tsx - 集成到 Goal 命令

---

## 后续任务（可选）

1. **集成 runAgent**：将 TaskExecutor 中的 simulateTaskExecution 替换为真实的 runAgent 调用
2. **AI 任务拆分**：将 TaskAnalyzer 中的占位实现替换为 AI 调用
3. **进度 UI**：添加 Terminal UI 展示任务进度
4. **测试**：添加单元测试和集成测试