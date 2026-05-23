# Goal 任务编排与并行执行设计

## 概述

为 `/goal` 命令添加自动任务拆分和智能并行执行能力。当用户创建目标时，系统自动分析目标内容，将其拆分为细粒度子任务，识别依赖关系，并智能决定哪些任务可以并行执行。

## 核心目标

1. **细粒度拆分** - 将目标拆分为多个可独立执行的子任务（5-15+ 个）
2. **智能并行** - 根据任务复杂度判断并行策略，简单任务并行，复杂任务串行
3. **混合依赖** - AI 自动分析依赖 + 用户可显式声明补充
4. **部分共享** - 子任务共享系统 prompt 和工具，但消息历史独立

## 架构设计

### 组件结构

```
src/commands/goal/
├── goal.tsx                    # 现有：Goal 命令入口
├── types.ts                    # 现有：Goal 类型定义（含 GoalTask）
└── taskOrchestrator/           # 新增：任务编排模块
    ├── index.ts                # 统一导出
    ├── TaskAnalyzer.ts         # 任务分析器：拆分 + 依赖分析 + 循环检测
    ├── TaskScheduler.ts        # 任务调度器：智能并行决策
    ├── TaskExecutor.ts         # 任务执行器：使用 runAgent 执行
    ├── ResultAggregator.ts     # 结果聚合器
    ├── config.ts               # 配置参数
    └── types.ts                # 任务相关类型
```

### 数据流

```
用户输入目标
    ↓
TaskAnalyzer.analyze() → 拆分任务 + 构建依赖图 + 循环检测
    ↓
TaskScheduler.schedule() → 确定执行顺序 + 并行策略
    ↓
TaskExecutor.execute() → 按计划执行任务
    ↓
ResultAggregator.aggregate() → 合并结果
    ↓
返回最终结果给用户
```

## 详细设计

### 0. 配置参数 (config.ts)

```typescript
// 并行策略配置
export const MAX_SIMPLE_PARALLEL = 5;      // simple 任务最大并行数
export const MAX_MEDIUM_PARALLEL = 3;      // medium 任务最大并行数
export const DEFAULT_MAX_PARALLEL = 3;     // 默认最大并行数

// 超时配置
export const TASK_TIMEOUT_MS = 5 * 60 * 1000;  // 单任务超时 5 分钟
export const STAGE_TIMEOUT_MS = 30 * 60 * 1000; // 阶段超时 30 分钟

// 重试配置
export const DEFAULT_RETRY_COUNT = 1;      // 默认重试次数

// 复杂度阈值
export const COMPLEXITY_THRESHOLDS = {
  simple: { maxTokens: 1000, maxTools: 2 },
  medium: { maxTokens: 5000, maxTools: 5 },
  // complex: 超过 medium 即为 complex
};
```

### 1. TaskAnalyzer（任务分析器）

**职责**：
- 分析目标内容，拆分为细粒度子任务
- 识别任务间的依赖关系
- 评估任务复杂度
- **检测循环依赖**（P0 修复）

**接口**：

```typescript
// 复用现有 GoalTask，扩展编排所需字段
interface OrchestratedTask extends GoalTask {
  complexity: 'simple' | 'medium' | 'complex';
  estimatedTokens: number;
  requiresMcp?: string[];
  dependencies: string[];  // 依赖的任务 ID
}

interface TaskAnalyzer {
  analyze(
    objective: string,
    explicitDependencies?: TaskDependency[]
  ): Promise<TaskAnalysisResult>
}

interface TaskAnalysisResult {
  tasks: OrchestratedTask[];
  dependencyGraph: DependencyGraph;
  estimatedParallelism: number;
  qualityScore: SplitQualityScore;
}

interface DependencyGraph {
  nodes: Map<string, OrchestratedTask>;
  edges: Map<string, string[]>; // taskId -> dependent taskIds
  // 新增：循环检测结果
  hasCycle: boolean;
  cyclePath?: string[];
}

interface SplitQualityScore {
  averageTaskSize: number;
  independenceScore: number;     // 0-1
  parallelismPotential: number;  // 0-1
}
```

**拆分策略**：
- 使用 AI 分析目标内容，识别可独立执行的子任务
- 目标：拆分为 5-15+ 个细粒度任务
- 每个任务应有清晰的输入/输出定义
- 使用 `minDescriptionLength` / `maxDescriptionLength` 规范任务描述

**依赖分析**：
- 自动分析：检查任务描述中的因果关系（如 "基于 X 做 Y"）
- 显式依赖：解析用户提供的 `task1 -> task2` 语法

**循环依赖检测（P0）**：
```typescript
class DependencyGraph {
  // 使用 DFS 检测循环
  detectCycle(): CycleDetectionResult {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycle: string[] = [];

    for (const node of this.nodes.keys()) {
      if (this.hasCycleDFS(node, visited, recursionStack, cycle)) {
        return { hasCycle: true, cycle };
      }
    }
    return { hasCycle: false };
  }

  // 拓扑排序（Kahn 算法）
  topologicalSort(): string[] {
    // ... 实现
  }
}
```

### 2. TaskScheduler（任务调度器）

**职责**：
- 根据依赖图确定执行顺序
- 判断哪些任务可以并行
- 决定并行数量（智能策略）

**接口**：

```typescript
interface TaskScheduler {
  schedule(
    analysis: TaskAnalysisResult,
    options?: ScheduleOptions
  ): Promise<ExecutionPlan>
}

interface ScheduleOptions {
  maxParallel?: number;
  strategy?: 'all' | 'smart' | 'auto';
}

interface ExecutionPlan {
  stages: ExecutionStage[];
  totalEstimatedTime: number;
}

interface ExecutionStage {
  stageId: number;
  tasks: OrchestratedTask[];
  canParallel: boolean;
  estimatedDuration: number;
}
```

**复杂度评估（P1）**：
```typescript
interface ComplexityEvaluator {
  evaluate(task: OrchestratedTask, context: ToolUseContext): 'simple' | 'medium' | 'complex'

  // 评估因素
  factors: {
    estimatedTokens: number;      // 预计 token 消耗
    estimatedToolCount: number;   // 预计使用工具数
    hasFileOperations: boolean;   // 是否涉及文件操作
    hasExternalCalls: boolean;    // 是否有外部调用
  }
}

// 使用阈值判断
function evaluateComplexity(estimatedTokens: number): 'simple' | 'medium' | 'complex' {
  if (estimatedTokens <= COMPLEXITY_THRESHOLDS.simple.maxTokens) return 'simple';
  if (estimatedTokens <= COMPLEXITY_THRESHOLDS.medium.maxTokens) return 'medium';
  return 'complex';
}
```

**智能并行策略**：
- `simple` 任务：可以大量并行（最多 MAX_SIMPLE_PARALLEL=5 个）
- `medium` 任务：少量并行（最多 MAX_MEDIUM_PARALLEL=3 个）
- `complex` 任务：串行执行
- 动态调整：根据上下文窗口和内存状态调整并行数
- **API 限流考虑**：检查 rateLimitRemaining，动态调整

### 3. TaskExecutor（任务执行器）

**职责**：
- 按照执行计划调度任务
- 使用 `runAgent` 执行（修复：不再直接用 forkSubagent）
- 处理任务状态、进度、取消

**接口**：

```typescript
interface TaskExecutorOptions {
  agentType: 'fork' | 'async' | 'sync';  // 通过 agentType 选择执行模式
  onProgress?: (event: TaskProgressEvent) => void;
  cancellationToken?: CancellationToken;
}

interface TaskExecutor {
  execute(
    plan: ExecutionPlan,
    context: ToolUseContext,
    options: TaskExecutorOptions
  ): Promise<ExecutionResult>
}

interface TaskProgressEvent {
  type: 'stage_start' | 'stage_complete' | 'task_start' | 'task_complete' | 'task_error';
  stageId?: number;
  taskId?: string;
  message?: string;
}

interface ExecutionResult {
  completedTasks: TaskResult[];
  failedTasks: TaskError[];
  aggregatedResult: string;
}

interface TaskResult {
  taskId: string;
  output: string;
  tokensUsed: number;
  duration: number;
}

interface TaskError {
  taskId: string;
  error: string;
  canRetry: boolean;
}
```

**用户中断处理（P2）**：
```typescript
interface CancellationToken {
  isCancelled(): boolean;
  onCancelled(callback: () => void): void;
  cancel(): void;
}
```

**执行策略**：
- 使用 `runAgent()` 函数 + 配置 `agentType` 执行任务
  - `simple`/`medium` 任务 → `agentType: 'fork'` 或 `'async'`
  - `complex` 任务 → `agentType: 'sync'`
- 并行任务通过 Promise.all 调度
- 串行任务按顺序执行
- 失败任务根据错误类型决定是否重试（最多 DEFAULT_RETRY_COUNT 次）
- **超时处理**：每个任务有 TASK_TIMEOUT_MS 超时限制

### 4. ResultAggregator（结果聚合器）

**职责**：
- 收集所有子任务的结果
- 合并为最终输出
- 生成执行报告

**接口**：

```typescript
interface ResultAggregator {
  aggregate(
    results: ExecutionResult,
    originalObjective: string
  ): Promise<AggregatedResult>
}

interface AggregatedResult {
  summary: string;
  taskBreakdown: TaskBreakdown[];
  totalTokens: number;
  totalDuration: number;
  recommendations?: string[];
}

interface TaskBreakdown {
  taskId: string;
  description: string;
  status: 'success' | 'failed' | 'skipped';
  summary: string;
}
```

## 集成设计

### 与 Goal 命令集成

修改 `src/commands/goal/goal.tsx`：

```typescript
// 新增参数
interface GoalCommandArgs {
  // ... 现有参数
  autoSplit?: boolean;     // 自动拆分任务
  maxParallel?: number;    // 最大并行数
}

// 创建目标时
if (autoSplit && objective) {
  const orchestrator = new GoalTaskOrchestrator(context)
  const result = await orchestrator.execute(objective)
  onDone(result.summary, { display: 'system' })
  return
}
```

### 与现有系统集成

| 现有系统 | 集成方式 |
|---------|---------|
| **GoalTask** | 扩展为 `OrchestratedTask`，复用现有类型 |
| **runAgent** | TaskExecutor 使用 `runAgent()` + `agentType` 参数执行 |
| **AppState** | 任务状态存储在 `goalRuntime` 中 |
| **Progress** | **独立的任务进度机制**（不复用 onCompactProgress） |
| **Coordinator Mode** | 可选集成，通过 Coordinator 共享任务状态 |
| **Compact** | 监听上下文大小，手动触发 micro-compact |

**独立进度机制**：
```typescript
// 任务进度状态
interface TaskProgressState {
  currentStage: number;
  stages: ExecutionStage[];
  taskStatuses: Map<string, 'pending' | 'running' | 'completed' | 'failed'>;
}

// 通过 setAppState 更新进度
context.setAppState(s => ({
  ...s,
  goalRuntime: {
    ...s.goalRuntime,
    taskProgress: newProgressState
  }
}))
```

## 边界情况处理

| 场景 | 处理 |
|------|------|
| 循环依赖检测 | **P0**：检测到循环依赖时抛出错误，要求用户修复 |
| 所有任务有依赖 | 退化为纯串行执行 |
| 任务执行失败 | 记录错误，继续执行其他任务，最终报告失败列表 |
| 上下文溢出 | 自动触发 micro-compact 或降低并行度 |
| 用户中断 | **P2**：通过 CancellationToken 优雅停止正在执行的任务 |
| 任务超时 | **P1**：单个任务超时 TASK_TIMEOUT_MS 后标记失败 |
| API 限流 | **P2**：检测 rateLimitRemaining，动态调整并行数 |

## 错误处理

| 场景 | 处理 |
|------|------|
| 任务拆分失败 | 回退到默认任务列表（分析、规划、执行、验证） |
| 依赖分析失败 | 假设所有任务独立，允许最大并行 |
| 执行失败 | 重试 DEFAULT_RETRY_COUNT 次，失败则记录并继续 |
| 上下文超限 | 减少并行度或退化为串行 |
| 循环依赖 | 抛出明确错误，指出循环路径 |

## 成功标准

1. 用户创建目标后，系统自动拆分为 5-15+ 个细粒度任务
2. 无依赖的任务智能并行执行，总耗时 < 串行执行时间
3. 任务进度可实时查看
4. 最终结果清晰展示每个任务的执行情况
5. 降级场景（失败、超限）有优雅处理
6. **循环依赖能被检测并报告**

## 后续扩展

- **任务优先级**：用户可指定任务优先级
- **任务重新排序**：执行中可调整后续任务
- **检查点**：支持从某个任务恢复执行
- **可视化**：在 UI 中展示任务依赖图和执行进度
- **缓存机制**：相同目标的任务拆分结果缓存（P3）