import type {
	Goal,
	GoalRuntimeState,
	TokenUsage,
	GoalTask,
} from "../../commands/goal/types.js";
import {
	migrateGoal,
	ThreadGoalStatus as Status,
} from "../../commands/goal/types.js";
import type { TodoItem } from "../todo/types.js";
import {
	isBudgetExhausted,
	recordTurnApiUsage,
	timeDeltaSinceLastAccounted,
	tokenDeltaSinceLastAccounting,
} from "./goalAccounting.js";
import { analyzeTurnLightweight } from "./goalAnalysis.js";
import {
	buildBudgetLimitPrompt,
	buildContinuationPrompt,
} from "./goalSteering.js";

/**
 * Options for building the GoalRuntimeContext callbacks.
 * The caller provides these to avoid coupling to ToolUseContext.
 */
export interface GoalContextOptions {
	/** Called when a continuation prompt should be injected for the next turn */
	onInjectPrompt: (prompt: string) => void;
	/** Updates the goal in app state */
	onUpdateGoal: (goal: Goal) => void;
	/** Returns todos for a given list ID */
	getTodos: (listId: string) => TodoItem[] | undefined;
	/** Updates todos for a given list ID */
	updateTodos: (listId: string, todos: TodoItem[]) => void;
	/** Returns goalTasks for a given list ID */
	getGoalTasks: (listId: string) => GoalTask[] | undefined;
	/** Updates goalTasks for a given list ID */
	updateGoalTasks: (listId: string, tasks: GoalTask[]) => void;
	/** First 200 chars of last API response for analysis */
	outputSummary?: string;
}

/**
 * Builds a GoalRuntimeContext for a 'turn_finished' event and processes it.
 * Eliminates ~60 lines of duplicated callback construction at each call site.
 */
export function finishTurnForGoal(
	goal: Goal,
	runtime: GoalRuntimeState,
	currentTokenUsage: TokenUsage | undefined,
	opts: GoalContextOptions,
): GoalRuntimeResult {
	const effectiveTokenUsage: TokenUsage = currentTokenUsage ?? {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	};

	const todoListId = goal?.todoListId;
	const goalTaskListId = (goal as any)?.goalTaskListId;

	return processGoalRuntimeEvent(
		{ type: "turn_finished", turnCompleted: true },
		{
			goal,
			runtime,
			currentTokenUsage: effectiveTokenUsage,
			outputSummary: opts.outputSummary,
			injectPrompt: async (prompt: string) => {
				opts.onInjectPrompt(prompt);
			},
			updateGoal: (updatedGoal: Goal) => {
				opts.onUpdateGoal(updatedGoal);
			},
			getTodos: () => {
				if (!todoListId) return undefined;
				return opts.getTodos(todoListId);
			},
			updateTodos: (todos) => {
				if (!todoListId) return;
				opts.updateTodos(todoListId, todos);
			},
			getGoalTasks: () => {
				if (!goalTaskListId) return undefined;
				return opts.getGoalTasks(goalTaskListId);
			},
			updateGoalTasks: (tasks) => {
				if (!goalTaskListId) return;
				opts.updateGoalTasks(goalTaskListId, tasks);
			},
		},
	);
}

// Goal runtime events (matching Codex pattern)
export type GoalRuntimeEvent =
	| { type: "turn_started"; turnId: string; tokenUsage: TokenUsage }
	| { type: "tool_completed"; toolName: string }
	| { type: "tool_completed_goal" } // Codex-style: goal completion event
	| { type: "turn_finished"; turnCompleted: boolean }
	| { type: "maybe_continue_if_idle" }
	| { type: "external_set"; goal: Goal }
	| { type: "thread_resumed" }
	| { type: "goal_created"; goal: Goal };

// Context passed to runtime event processor
export interface GoalRuntimeContext {
	goal: Goal;
	runtime: GoalRuntimeState;
	currentTokenUsage: TokenUsage; // Pass current token usage from caller
	outputSummary?: string; // First 200 chars of last API response
	injectPrompt: (prompt: string) => Promise<void>;
	updateGoal: (goal: Goal) => void;
	updateTodos?: (todos: TodoItem[]) => void; // Optional: update task list
	getTodos?: () => TodoItem[] | undefined; // Optional: get current task list
	updateGoalTasks?: (tasks: GoalTask[]) => void; // Optional: update goal task list
	getGoalTasks?: () => GoalTask[] | undefined; // Optional: get current goal task list
}

// Result of processing a runtime event
export interface GoalRuntimeResult {
	shouldContinue: boolean;
	injectedPrompt?: string;
}

/**
 * Work tools that should auto-progress tasks.
 * Replaces hardcoded exclusion list with explicit inclusion.
 */
const WORK_TOOLS = new Set([
	"Bash",
	"FileEdit",
	"FileWrite",
	"FileRead",
	"Glob",
	"Grep",
	"Agent",
	"SkillTool",
	"TodoWrite",
	"Edit",
	"Write",
	"Read",
]);

function isWorkTool(toolName: string): boolean {
	return WORK_TOOLS.has(toolName);
}

/** Threshold for consecutive critical analyses before auto-pause */
const AUTO_PAUSE_CRITICAL_THRESHOLD = 3;

// Helper: Auto-progress task status
function autoProgressTasks(
	todos: TodoItem[] | undefined,
	updateTodos: ((todos: TodoItem[]) => void) | undefined,
): void {
	if (!todos || !updateTodos || todos.length === 0) return;

	// Find current in_progress task
	const inProgressIndex = todos.findIndex((t) => t.status === "in_progress");

	// If no task in progress, start the first pending task
	if (inProgressIndex === -1) {
		const firstPendingIndex = todos.findIndex((t) => t.status === "pending");
		if (firstPendingIndex !== -1) {
			const updatedTodos = [...todos];
			updatedTodos[firstPendingIndex] = {
				...updatedTodos[firstPendingIndex],
				status: "in_progress",
			};
			updateTodos(updatedTodos);
		}
		return;
	}

	// Mark current task as completed and start next
	const updatedTodos = [...todos];
	updatedTodos[inProgressIndex] = {
		...updatedTodos[inProgressIndex],
		status: "completed",
	};

	const nextPendingIndex = todos.findIndex(
		(t, i) => i > inProgressIndex && t.status === "pending",
	);
	if (nextPendingIndex !== -1) {
		updatedTodos[nextPendingIndex] = {
			...updatedTodos[nextPendingIndex],
			status: "in_progress",
		};
	}

	updateTodos(updatedTodos);
}

// Helper: Mark all tasks as completed
function markAllTasksCompleted(
	todos: TodoItem[] | undefined,
	updateTodos: ((todos: TodoItem[]) => void) | undefined,
): void {
	if (!todos || !updateTodos || todos.length === 0) return;
	const updatedTodos = todos.map((t) => ({ ...t, status: "completed" }));
	updateTodos(updatedTodos);
}

// Helper: Auto-advance goal tasks when a turn produces observable changes.
// Marks the current in_progress task as completed and advances the next
// pending task to in_progress.
function autoAdvanceGoalTasks(
	tasks: GoalTask[] | undefined,
	updateGoalTasks: ((tasks: GoalTask[]) => void) | undefined,
): void {
	if (!tasks || !updateGoalTasks || tasks.length === 0) return;

	const currentIdx = tasks.findIndex(t => t.status === "in_progress");
	if (currentIdx === -1) {
		// No task in progress — start the first pending task
		const firstPending = tasks.findIndex(t => t.status === "pending");
		if (firstPending !== -1) {
			const updated = [...tasks];
			updated[firstPending] = { ...updated[firstPending], status: "in_progress" };
			updateGoalTasks(updated);
		}
		return;
	}

	// Find next pending task after current
	const nextIdx = tasks.findIndex((t, i) => i > currentIdx && t.status === "pending");
	if (nextIdx === -1) {
		// No more pending tasks — just mark current as completed
		const updated = [...tasks];
		updated[currentIdx] = { ...updated[currentIdx], status: "completed" };
		updateGoalTasks(updated);
		return;
	}

	// Mark current as completed, advance next to in_progress
	const updated = [...tasks];
	updated[currentIdx] = { ...updated[currentIdx], status: "completed" };
	updated[nextIdx] = { ...updated[nextIdx], status: "in_progress" };
	updateGoalTasks(updated);
}

// Process goal runtime events with error handling
export function processGoalRuntimeEvent(
	event: GoalRuntimeEvent,
	context: GoalRuntimeContext,
): GoalRuntimeResult {
	try {
		let { goal, runtime } = context;

		// Migrate goal if needed (handles goals loaded from old schema)
		if (goal && goal.id) {
			const migratedGoal = migrateGoal(goal);
			if (migratedGoal !== goal) {
				context.updateGoal(migratedGoal);
				goal = migratedGoal;
			}
		}

		// Safety checks
		if (!goal || !goal.id) {
			return { shouldContinue: false };
		}
		if (!runtime) {
			return { shouldContinue: true };
		}

		switch (event.type) {
			case "turn_started": {
				// Reset error counter on turn start
				runtime.consecutiveErrors = 0;
				// Clear tool calls accumulator for new turn
				runtime._toolCallsThisTurn = [];
				// Initialize turn accounting
				runtime.accounting.turn = {
					turnId: event.turnId,
					lastTokenUsage: event.tokenUsage,
					activeGoalId: goal.id,
				};
				// Record wall time start
				runtime._currentTurnWallStartMs = Date.now();
				// Auto-start first task if none is in progress
				const todos = context.getTodos?.();
				if (
					todos &&
					todos.length > 0 &&
					!todos.some((t) => t.status === "in_progress")
				) {
					autoProgressTasks(todos, context.updateTodos);
				}
				return { shouldContinue: true };
			}

			case "tool_completed": {
				// Don't account for update_goal tool calls
				if (event.toolName === "update_goal") {
					return { shouldContinue: true };
				}

				// Accumulate tool calls for analysis
				runtime._toolCallsThisTurn = [
					...(runtime._toolCallsThisTurn ?? []),
					event.toolName,
				];

				// Auto-progress task after significant tool completion
				const todos = context.getTodos?.();
				const inProgressTask = todos?.find((t) => t.status === "in_progress");
				// Only progress if there's an in-progress task and this is a work-related tool
				if (inProgressTask && isWorkTool(event.toolName)) {
					autoProgressTasks(todos, context.updateTodos);
				}

				return { shouldContinue: true };
			}

			case "tool_completed_goal": {
				// Codex-style: Goal completion via update_goal tool
				// Finalize accounting and mark goal complete
				const lastTurn = runtime.accounting.turn;
				if (lastTurn && lastTurn.lastTokenUsage) {
					const usage = context.currentTokenUsage;
					const tokenDelta = tokenDeltaSinceLastAccounting(
						lastTurn.lastTokenUsage,
						usage,
					);
					const timeDelta = timeDeltaSinceLastAccounted(
						runtime.accounting.wallClock.lastAccountedAt,
					);

					const completedGoal: Goal = {
						...goal,
						status: Status.Complete,
						tokensUsed: goal.tokensUsed + tokenDelta,
						timeUsedSeconds: goal.timeUsedSeconds + timeDelta,
						updatedAt: Date.now(),
					};

					context.updateGoal(completedGoal);
					runtime.accounting.turn = null;
				} else {
					// No turn accounting, just mark complete
					const completedGoal: Goal = {
						...goal,
						status: Status.Complete,
						updatedAt: Date.now(),
					};
					context.updateGoal(completedGoal);
				}

				// Mark all tasks as completed
				const todos = context.getTodos?.();
				markAllTasksCompleted(todos, context.updateTodos);

				// Goal complete - no continuation needed
				return { shouldContinue: false };
			}

			case "turn_finished": {
				if (!event.turnCompleted) {
					return { shouldContinue: true };
				}

				// Clear turn accounting
				const lastTurn = runtime.accounting.turn;
				runtime.accounting.turn = null;

				// Track updated goal reference
				let updatedGoalRef: Goal = goal;

				// Dead-turn detection: 2+ turns with no observable changes
				let turnsWithNoChanges = runtime.turnsWithNoChanges ?? 0;
				// Use Boolean() to ensure strict boolean type (fixes null issue)
				// Only check outputTokens growth, not inputTokens (context grows naturally)
				const hadObservableChanges = !!(
					lastTurn &&
					context.currentTokenUsage &&
					(context.currentTokenUsage.outputTokens > 0 ||
						context.currentTokenUsage.outputTokens >
							(lastTurn.lastTokenUsage?.outputTokens ?? 0))
				);

				if (!hadObservableChanges) {
					turnsWithNoChanges++;
				} else {
					turnsWithNoChanges = 0;
				}
				runtime.turnsWithNoChanges = turnsWithNoChanges;

				// Accumulate token usage for this turn
				if (lastTurn && goal.status === Status.Active) {
					const usage = context.currentTokenUsage;
					const tokenDelta = tokenDeltaSinceLastAccounting(
						lastTurn.lastTokenUsage,
						usage,
					);
					const timeDelta = timeDeltaSinceLastAccounted(
						runtime.accounting.wallClock.lastAccountedAt,
					);

					let updatedGoal: Goal = {
						...goal,
						tokensUsed: goal.tokensUsed + tokenDelta,
						timeUsedSeconds: goal.timeUsedSeconds + timeDelta,
						updatedAt: Date.now(),
					};
					updatedGoalRef = updatedGoal;

					// Auto-progress tasks after each turn
					const todos = context.getTodos?.();
					autoProgressTasks(todos, context.updateTodos);

					// Check budget exhaustion
					if (
						isBudgetExhausted(updatedGoal) &&
						runtime.budgetLimitReportedGoalId !== goal.id
					) {
						updatedGoal = {
							...updatedGoal,
							status: Status.BudgetLimited,
						};
						updatedGoalRef = updatedGoal;
						runtime.budgetLimitReportedGoalId = goal.id;
						context.updateGoal(updatedGoal);
						const budgetPrompt = buildBudgetLimitPrompt(updatedGoal);
						return { shouldContinue: true, injectedPrompt: budgetPrompt };
					}

					context.updateGoal(updatedGoal);
				}

				// Record turn in ring buffer with analysis fields
				const wallEndMs = Date.now();
				const wallStartMs = runtime._currentTurnWallStartMs ?? wallEndMs;
				runtime.turnBuffer = recordTurnApiUsage(
					runtime.turnBuffer ?? [],
					lastTurn?.turnId ?? "unknown",
					context.currentTokenUsage,
					wallStartMs,
					wallEndMs,
					{
						toolCallsSummary: runtime._toolCallsThisTurn ?? [],
						outputSummary: context.outputSummary,
						hadObservableChanges,
					},
				);
				// Clear tool calls accumulator for next turn
				runtime._toolCallsThisTurn = [];

				// Lightweight analysis after turn completion
				const analysisResult = analyzeTurnLightweight(
					runtime.turnBuffer?.[runtime.turnBuffer.length - 1],
					turnsWithNoChanges,
				);

				// Track consecutive critical analyses (auto-pause circuit breaker)
				if (analysisResult.status === "critical") {
					runtime.consecutiveCritical = (runtime.consecutiveCritical ?? 0) + 1;
				} else {
					runtime.consecutiveCritical = 0;
				}

				if (analysisResult.status !== "ok") {
					runtime.pendingAnalysis = {
						reason: analysisResult.reason ?? "Analysis needed",
						severity:
							analysisResult.status === "critical" ? "critical" : "warning",
						triggerTurnId: lastTurn?.turnId ?? "unknown",
					};
				}

				// Circuit breaker: auto-pause after consecutive critical analyses
				if (
					(runtime.consecutiveCritical ?? 0) >= AUTO_PAUSE_CRITICAL_THRESHOLD
				) {
					const pausedGoal = {
						...goal,
						status: Status.Paused,
						updatedAt: Date.now(),
					};
					context.updateGoal(pausedGoal);
					// Clear pending analysis on pause to prevent stale injection on resume
					runtime.pendingAnalysis = undefined;
					return {
						shouldContinue: false,
						injectedPrompt: `[Goal auto-paused] 3 consecutive critical issues detected. Latest: "${analysisResult.reason ?? "Unknown"}". Use /goal resume to continue or /goal stop to cancel.`,
					};
				}

				// Accumulate authoritative totals (cumulative, not just last-3-turns)
				// Exclude cached input tokens (they're part of inputTokens, not additional cost)
				const thisTurnTokens =
					Math.max(0, (context.currentTokenUsage?.outputTokens ?? 0)) +
					Math.max(0, (context.currentTokenUsage?.inputTokens ?? 0) -
						(context.currentTokenUsage?.cachedInputTokens ?? 0));
				const thisTurnWall = wallEndMs - wallStartMs;
				runtime.totalApiTokens = (runtime.totalApiTokens ?? 0) + thisTurnTokens;
				runtime.totalApiWallMs = (runtime.totalApiWallMs ?? 0) + thisTurnWall;

				// Auto-advance goal tasks when a turn produces observable changes
				if (analysisResult?.hadObservableChanges) {
					autoAdvanceGoalTasks(context.getGoalTasks?.(), context.updateGoalTasks);
				}

				// Use updated goal status for continuation check
				const effectiveGoal = updatedGoalRef;

				// If 2+ dead turns, inject strategy check into continuation prompt
				let strategyCheck = "";
				if (turnsWithNoChanges >= 2) {
					strategyCheck = `\n\n## Strategy Check\nThe last ${turnsWithNoChanges} turns produced no observable changes. Consider:\n- Trying a different approach\n- Breaking the problem into smaller steps\n- Using /goal pause to stop and reconsider`;
				}

				// Circuit breaker: auto-pause after excessive dead turns (prevents infinite loops)
				const DEAD_TURN_LIMIT = 5;
				if (turnsWithNoChanges >= DEAD_TURN_LIMIT) {
					const pausedGoal = {
						...goal,
						status: Status.Paused,
						updatedAt: Date.now(),
					};
					pausedGoal.pauseReason = `Auto-paused: ${turnsWithNoChanges} consecutive turns with no observable changes`;
					context.updateGoal(pausedGoal);
					runtime.pendingAnalysis = undefined;
					return {
						shouldContinue: false,
						injectedPrompt: `[Goal auto-paused] ${turnsWithNoChanges} turns with no progress. Latest issue: "${analysisResult.reason ?? "Unknown"}". Use /goal resume to continue or /goal stop to cancel.`,
					};
				}

				if (effectiveGoal.status === Status.Active) {
					const continuationPrompt =
						buildContinuationPrompt(effectiveGoal) + strategyCheck;
					return { shouldContinue: true, injectedPrompt: continuationPrompt };
				}

				return { shouldContinue: false };
			}

			case "maybe_continue_if_idle": {
				// Don't re-inject for paused goals
				if (goal.status === Status.Paused) {
					return { shouldContinue: false };
				}
				if (goal.status === Status.Active) {
					const continuationPrompt = buildContinuationPrompt(goal);
					return { shouldContinue: true, injectedPrompt: continuationPrompt };
				}
				return { shouldContinue: false };
			}

			case "external_set": {
				context.updateGoal(event.goal);
				return { shouldContinue: event.goal.status === Status.Active };
			}

			case "thread_resumed": {
				// Restore runtime state for resumed thread
				if (goal.status === Status.Active) {
					runtime.accounting.wallClock.activeGoalId = goal.id;
					runtime.accounting.wallClock.lastAccountedAt = Date.now();
				}
				return { shouldContinue: goal.status === Status.Active };
			}

			case "goal_created": {
				// 新 Goal 创建时，初始化 runtime 并注入启动 prompt
				context.updateGoal(event.goal);
				runtime.accounting.wallClock.activeGoalId = event.goal.id;
				runtime.accounting.wallClock.lastAccountedAt = Date.now();
				// Initialize analysis fields for new goal
				runtime._toolCallsThisTurn = [];
				runtime.turnsWithNoChanges = 0;
				runtime.consecutiveErrors = 0;
				runtime.consecutiveCritical = 0;

				// Start first task as in_progress
				const todos = context.getTodos?.();
				if (todos && todos.length > 0) {
					const firstPendingIndex = todos.findIndex(
						(t) => t.status === "pending",
					);
					if (firstPendingIndex !== -1) {
						const updatedTodos = [...todos];
						updatedTodos[firstPendingIndex] = {
							...updatedTodos[firstPendingIndex],
							status: "in_progress",
						};
						context.updateTodos?.(updatedTodos);
					}
				}

				// 注入启动 prompt，让模型开始执行目标
				const continuationPrompt = buildContinuationPrompt(event.goal);
				return { shouldContinue: true, injectedPrompt: continuationPrompt };
			}

			default: {
				// Unknown event type - should not happen
				return { shouldContinue: true };
			}
		}
	} catch (error) {
		// Graceful error handling - don't crash the REPL
		console.error("[goalRuntime] Error processing event:", error);
		const { goal, runtime } = context;
		if (goal && runtime) {
			runtime.consecutiveErrors = (runtime.consecutiveErrors ?? 0) + 1;

			if (runtime.consecutiveErrors >= 3) {
				const pausedGoal = {
					...goal,
					status: Status.Paused,
					updatedAt: Date.now(),
				};
				context.updateGoal(pausedGoal);
				// Clear pending analysis on pause to prevent stale injection on resume
				runtime.pendingAnalysis = undefined;
				return {
					shouldContinue: false,
					injectedPrompt: `[Goal paused due to errors] 3 consecutive errors encountered. Use /goal resume to continue or /goal stop to cancel.`,
				};
			}
		}
		return { shouldContinue: true };
	}
}
