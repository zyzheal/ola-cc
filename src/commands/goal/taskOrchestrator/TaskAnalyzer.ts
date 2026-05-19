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
	private calculateParallelism(_tasks: OrchestratedTask[], _graph: DependencyGraph): number {
		const maxParallel = Math.max(
			..._tasks.map(t => {
				if (t.complexity === 'simple') return 5;
				if (t.complexity === 'medium') return 3;
				return 1;
			})
		);
		return Math.min(maxParallel, _tasks.length);
	}
}