// src/commands/goal/taskOrchestrator/TaskExecutor.ts
import type { ToolUseContext } from '../../../Tool.js';
import type {
	ExecutionPlan,
	ExecutionResult,
	TaskResult,
	TaskError,
	TaskProgressEvent,
	OrchestratedTask,
	CancellationToken,
} from './types.js';
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
					stage.tasks.map(task => this.executeTask(task, context, options))
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