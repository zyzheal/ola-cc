// src/commands/goal/taskOrchestrator/types.ts
import type { GoalTask } from '../types.js';

// 扩展 GoalTask，添加编排所需字段
export interface OrchestratedTask extends GoalTask {
	complexity: 'simple' | 'medium' | 'complex';
	estimatedTokens: number;
	requiresMcp?: string[];
	dependencies: string[]; // 依赖的任务 ID
}

export interface TaskAnalysisResult {
	tasks: OrchestratedTask[];
	dependencyGraph: DependencyGraph;
	estimatedParallelism: number;
	qualityScore: SplitQualityScore;
}

export interface DependencyGraph {
	nodes: Map<string, OrchestratedTask>;
	edges: Map<string, string[]>; // taskId -> dependent taskIds
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