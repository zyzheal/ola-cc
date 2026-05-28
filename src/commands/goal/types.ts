export enum ThreadGoalStatus {
	Active = "active",
	Paused = "paused",
	BudgetLimited = "budget_limited",
	Complete = "complete",
}

// GoalMode: tiered prompt complexity
export type GoalMode = "simple" | "standard" | "complex";

// TurnRecord: per-turn API usage for ring buffer
export interface TurnRecord {
	turnId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	wallStartMs: number;
	wallEndMs: number;
	// NEW: Execution summary for analysis
	toolCallsSummary?: string[]; // Tool names called this turn
	outputSummary?: string; // Output summary (first 200 chars)
	hadObservableChanges?: boolean;
}

// GoalTask: dedicated task (decoupled from TodoWrite)
export interface GoalTask {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "skipped";
	order: number;
}

export interface Goal {
	id: string;
	threadId: string;
	objective: string;
	status: ThreadGoalStatus | "";
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	// 方案 C: 关联 TodoWrite 列表
	todoListId?: string; // 关联的 TodoWrite 列表 ID（sessionId 或 agentId）
	totalApiTokens: number; // Authoritative API token sum
	totalApiWallMs: number; // Total API wall time ms
	mode: GoalMode; // Prompt tier
	autoEdit: boolean; // Auto-approve file edits only
	goalTaskListId?: string; // Dedicated task list ID
	pauseReason?: string; // Reason for pause (auto-pause or manual)
	// Analysis counters moved to GoalRuntimeState (runtime-only, not persisted)
	retryConfig?: RetryConfig; // Fallback retry configuration
	retryCount?: number; // Current retry count for fallback retry
}

export interface RetryConfig {
	enabled: boolean;
	intervalMs: number;
	maxRetryHours: number;
}

export interface GoalRuntimeState {
	accounting: {
		turn: {
			turnId: string;
			lastTokenUsage: TokenUsage;
			activeGoalId: string | null;
		} | null;
		wallClock: { lastAccountedAt: number; activeGoalId: string | null };
	};
	budgetLimitReportedGoalId: string | null;
	continuationTurnId: string | null;
	turnBuffer: TurnRecord[]; // Ring buffer, max 3
	totalApiTokens: number; // Sum of API response tokens
	totalApiWallMs: number; // Sum of API wall time
	consecutiveErrors: number; // Consecutive error counter
	turnsWithNoChanges: number; // Turns with no observable changes
	_currentTurnWallStartMs: number; // Internal: track current turn API start

	// NEW: Pending analysis request
	pendingAnalysis?: {
		reason: string;
		severity: "warning" | "critical";
		triggerTurnId: string;
	};

	// NEW: Last analysis result (persists across turns)
	lastAnalysisResult?: string;

	// NEW: Accumulate tool calls during current turn
	_toolCallsThisTurn?: string[];

	// NEW: Consecutive critical analysis counter (auto-pause threshold)
	consecutiveCritical?: number;

	// v3 orchestrator — 场景
	currentScenario?: string; // ScenarioType

	// v3 orchestrator — 收敛检测
	convergenceState?: {
		informationGains: number[];
		qualityScores: number[];
		changeMagnitudes: number[];
		round: number;
	};

	// v3 orchestrator — 统一错误追踪
	errorTracker?: {
		categories: Record<string, { count: number; threshold: number }>;
		recoveryLayer: string; // RecoveryLayer
		fullRestartUsed: boolean;
	};

	// v3 orchestrator — ReAct 观测（每轮覆盖）
	lastObservation?: {
		mainPhase: string | null; // ReActPhase
		phases: string[];
		qualitySignals: { hasErrors: boolean; hasSuccess: boolean; hasProgress: boolean };
	};

	// v3 orchestrator — 技能缓存（goal 创建时加载，避免每轮异步）
	cachedSkills?: import("../utils/goal/skillRegistry.js").SkillMetadata[];
}

export interface TokenUsage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
}

export const IDLE_GOAL: Goal = {
	id: "",
	threadId: "",
	objective: "",
	status: "",
	tokenBudget: null,
	tokensUsed: 0,
	timeUsedSeconds: 0,
	createdAt: 0,
	updatedAt: 0,
	totalApiTokens: 0,
	totalApiWallMs: 0,
	mode: "standard" as GoalMode,
	autoEdit: false,
};

/**
 * Migrate an existing Goal to the new schema with all fields populated.
 * Called on first access to a goal that may lack new fields.
 */
export function migrateGoal(goal: Goal): Goal {
	return {
		...goal,
		totalApiTokens: goal.totalApiTokens ?? goal.tokensUsed ?? 0,
		totalApiWallMs: goal.totalApiWallMs ?? (goal.timeUsedSeconds ?? 0) * 1000,
		mode: goal.mode ?? "standard",
		autoEdit: goal.autoEdit ?? false,
		retryConfig: goal.retryConfig ?? getRetryConfig({}),
		retryCount: goal.retryCount ?? 0,
	};
}

// Default configuration
const DEFAULT_RETRY_INTERVAL_MS = 600000; // 10 minutes
const DEFAULT_MAX_RETRY_HOURS = 24;

/**
 * Get retry configuration from args and environment variables.
 * Supports formats: 10m, 30s, 1h for interval
 */
export function getRetryConfig(args: {
	retryInterval?: string;
	maxRetryHours?: number;
}): RetryConfig {
	// Environment variables
	const envInterval = parseInt(process.env.OLA_CC_GOAL_RETRY_INTERVAL_MS || "", 10);
	const envMaxHours = parseInt(process.env.OLA_CC_GOAL_MAX_RETRY_HOURS || "", 10);

	// Parse args or fallback to env
	let intervalMs = DEFAULT_RETRY_INTERVAL_MS;
	if (args.retryInterval) {
		const match = args.retryInterval.match(/^(\d+)(m|s|h)$/);
		if (match) {
			const value = parseInt(match[1], 10);
			const unit = match[2];
			const multipliers = { m: 60000, s: 1000, h: 3600000 };
			intervalMs = value * (multipliers[unit as keyof typeof multipliers] || 60000);
		}
	} else if (!isNaN(envInterval)) {
		intervalMs = envInterval;
	}

	const maxRetryHours = args.maxRetryHours ?? (isNaN(envMaxHours) ? DEFAULT_MAX_RETRY_HOURS : envMaxHours);

	return {
		enabled: true, // /goal发起时默认启用兜底
		intervalMs,
		maxRetryHours,
	};
}
