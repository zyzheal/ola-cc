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
 * 整合所有模块,提供统一的任务编排入口
 */
import type { ToolUseContext } from '../../Tool.js';
import type { OrchestratorConfig } from './config.js';
import type { AggregatedResult } from './types.js';
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
		// 1. 分析目标,拆分任务
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