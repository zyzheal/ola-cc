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
			recommendations.push('部分任务失败,建议检查失败原因后重试');
		}

		if (results.completedTasks.length > 10) {
			recommendations.push('任务数量较多,可考虑进一步拆分以提高并行度');
		}

		return recommendations;
	}
}