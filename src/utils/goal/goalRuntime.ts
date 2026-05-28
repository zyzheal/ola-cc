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
import { checkMemoryIfNeeded, disposeGoalMemory } from "./goalMemory.js";
import { initOrchestratorState, processTurn, formatSkillRecommendations } from "./goalOrchestrator.js";
import { resolveScenario } from "./goalScenario.js";
import { observeTurn } from "./goalReActObserver.js";
import { recordError, shouldPause as trackerShouldPause } from "./goalErrorTracker.js";
import { getSkillMetadata } from "./skillRegistry.js";
import { rankSkills } from "./goalSkillRanker.js";

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
	/** Called when compact is needed (deferred — caller handles actual compact in next turn) */
	onCompactNeeded?: (reason: string) => void;
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
	const goalTaskListId = goal?.goalTaskListId;

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
			onCompactNeeded: opts.onCompactNeeded,
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
	onCompactNeeded?: (reason: string) => void; // Deferred compact notification
		onGoalCompleted?: (goal: Goal) => void; // Phase 3: goal completion recording
}

// Result of processing a runtime event
export interface GoalRuntimeResult {
	shouldContinue: boolean;
	injectedPrompt?: string;
}

/**
 * Get configurable threshold for consecutive critical analyses before auto-pause.
 * Defaults to 3, configurable via OLA_CC_GOAL_AUTO_PAUSE_CRITICAL_THRESHOLD env var.
 */
function getAutoPauseCriticalThreshold(): number {
  const env = parseInt(process.env.OLA_CC_GOAL_AUTO_PAUSE_CRITICAL_THRESHOLD || "", 10);
  return isNaN(env) || env < 1 ? 3 : env;
}

/**
 * Get configurable limit for dead turns before auto-pause.
 * Defaults to 5, configurable via OLA_CC_GOAL_DEAD_TURN_LIMIT env var.
 */
function getDeadTurnLimit(): number {
  const env = parseInt(process.env.OLA_CC_GOAL_DEAD_TURN_LIMIT || "", 10);
  return isNaN(env) || env < 1 ? 5 : env;
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

				// NOTE: Do NOT auto-advance tasks on every tool completion.
				// Tasks are advanced only at turn_finished to avoid
				// a single turn's multiple tool calls advancing multiple tasks.

				return { shouldContinue: true };
			}

			case "tool_completed_goal": {
				// Codex-style: Goal completion via update_goal tool
				// Finalize accounting and mark goal complete
				const lastTurn = runtime.accounting.turn;
				let completedGoal: Goal;
				if (lastTurn && lastTurn.lastTokenUsage) {
					const usage = context.currentTokenUsage;
					const tokenDelta = tokenDeltaSinceLastAccounting(
						lastTurn.lastTokenUsage,
						usage,
					);
					const timeDelta = timeDeltaSinceLastAccounted(
						runtime.accounting.wallClock.lastAccountedAt,
					);

					completedGoal = {
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
					completedGoal = {
						...goal,
						status: Status.Complete,
						updatedAt: Date.now(),
					};
					context.updateGoal(completedGoal);
				}

				// Mark all tasks as completed
				const todos = context.getTodos?.();
				markAllTasksCompleted(todos, context.updateTodos);

				// Phase 3: Notify goal completion for execution recording
				context.onGoalCompleted?.(completedGoal);

				// Clean up goal memory and session MC registry
				disposeGoalMemory(goal.id);

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
				// Check multiple signals for observable work:
				// 1. outputTokens growth (model produced text)
				// 2. tool calls executed (model performed work even without text output)
				// Bug fix: tool-heavy turns (Edit/Bash) may have 0 outputTokens
				//    but still produce real work — count toolCalls as observable change
				const currentOutput = context.currentTokenUsage?.outputTokens;
				const lastOutput = lastTurn?.lastTokenUsage?.outputTokens;
				const toolCallsThisTurn = runtime._toolCallsThisTurn ?? [];
				const outputGrew = currentOutput != null
					? !!(
						lastTurn &&
						context.currentTokenUsage &&
						(currentOutput > 0 ||
							currentOutput > (lastOutput ?? 0))
					  )
					: true; // undefined outputTokens — conservatively assume changes occurred
				// Redefine: only file-system writes count as observable changes
				// (Read-only turns should not reset the dead-turn counter)
				const WRITE_TOOLS = new Set(["Write", "FileWrite", "Edit", "FileEdit"])
				const hasFileSystemChanges = toolCallsThisTurn.some(t => WRITE_TOOLS.has(t))
				const hadObservableChanges = hasFileSystemChanges || (outputGrew && (context.currentTokenUsage?.outputTokens ?? 0) > 100)

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

					// Auto-progress tasks after each turn
					const todos = context.getTodos?.();
					// NOTE: Removed autoProgressTasks — let the model control task
					// progression via TodoWrite to prevent premature advancement.

					// Check if all tasks are completed — if so, stop accumulating
					// time/tokens and prompt model to call update_goal("complete")
					const allTasksDone = todos && todos.length > 0 &&
						todos.every(t => t.status === 'completed');
					if (allTasksDone) {
						// Still update token usage for accuracy, but don't accumulate time
						let updatedGoal: Goal = {
							...goal,
							tokensUsed: goal.tokensUsed + tokenDelta,
							updatedAt: Date.now(),
						};
						updatedGoalRef = updatedGoal;
						context.updateGoal(updatedGoal);
						return {
							shouldContinue: true,
							injectedPrompt: 'All tasks are completed. Call update_goal(status: "complete", summary: "...") to finish the goal.',
						};
					}

					let updatedGoal: Goal = {
						...goal,
						tokensUsed: goal.tokensUsed + tokenDelta,
						timeUsedSeconds: goal.timeUsedSeconds + timeDelta,
						updatedAt: Date.now(),
					};
					updatedGoalRef = updatedGoal;

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

					// Check memory compaction need (budget threshold + cooldown, P0-03)
					const memoryResult = checkMemoryIfNeeded(updatedGoal)
					if (memoryResult.shouldCompact && context.onCompactNeeded) {
						context.onCompactNeeded(memoryResult.message ?? 'memory_check')
					}
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

				// ── Orchestrator decision ──
				// ReAct observation
				const toolCallsForObs = (runtime.turnBuffer[runtime.turnBuffer.length - 1]?.toolCallsSummary ?? []) as string[]
				const observation = observeTurn(toolCallsForObs, context.outputSummary ?? "")
				runtime.lastObservation = {
					mainPhase: observation.mainPhase,
					phases: observation.phases,
					qualitySignals: observation.qualitySignals,
				}

				// Build orchestrator context and get decision
				const scenarioConfig = resolveScenario(goal.objective)
				const prevTurn = runtime.turnBuffer.length >= 2
					? runtime.turnBuffer[runtime.turnBuffer.length - 2]
					: undefined
				const currentTurnRecord = runtime.turnBuffer[runtime.turnBuffer.length - 1]
				const allTodos = context.getTodos?.() ?? []
				const orchGoalTasks = context.getGoalTasks?.()
				const orchTodos = context.getTodos?.()
				const inProgressGoalTask = orchGoalTasks?.find(t => t.status === "in_progress")
				const inProgressTodo = orchTodos?.find(t => t.status === "in_progress")
				const currentTaskContent = inProgressGoalTask?.content ?? inProgressTodo?.content

				const decision = processTurn({
					goal, runtime,
					currentTurn: currentTurnRecord,
					previousTurn: prevTurn,
					todos: allTodos,
					currentTask: currentTaskContent,
					observation,
					scenarioConfig,
				})

				// Apply orchestrator decision
				if (decision.action === "pause") {
					const pausedGoal = {
						...goal,
						status: Status.Paused,
						updatedAt: Date.now(),
						pauseReason: decision.pauseReason ?? decision.reason,
					}
					context.updateGoal(pausedGoal)
					runtime.pendingAnalysis = undefined
					disposeGoalMemory(goal.id)
					return {
						shouldContinue: false,
						injectedPrompt: decision.pauseReason ?? decision.reason,
					}
				}

				if (decision.action === "skip_task") {
					// Mark current task as skipped and advance
					const skipTasks = context.getGoalTasks?.()
					if (skipTasks) {
						const idx = skipTasks.findIndex(t => t.status === "in_progress")
						if (idx !== -1) {
							const updated = [...skipTasks]
							updated[idx] = { ...updated[idx], status: "skipped" }
							// Advance next pending
							const nextIdx = updated.findIndex((t, i) => i > idx && t.status === "pending")
							if (nextIdx !== -1) {
								updated[nextIdx] = { ...updated[nextIdx], status: "in_progress" }
							}
							context.updateGoalTasks?.(updated)
						}
					}
					return {
						shouldContinue: true,
						injectedPrompt: `Task skipped: ${decision.reason}. Moving to next task.`,
					}
				}

				if (decision.action === "retry") {
					return {
						shouldContinue: true,
						injectedPrompt: decision.prompt ?? `Retry: ${decision.reason}`,
					}
				}

				// decision.action === "continue" with specific prompt
				if (decision.prompt) {
					return { shouldContinue: true, injectedPrompt: decision.prompt }
				}

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
				const criticalThreshold = getAutoPauseCriticalThreshold();
				if (
					(runtime.consecutiveCritical ?? 0) >= criticalThreshold
				) {
					const pausedGoal = {
						...goal,
						status: Status.Paused,
						updatedAt: Date.now(),
					};
					context.updateGoal(pausedGoal);
					// Clear pending analysis on pause to prevent stale injection on resume
					runtime.pendingAnalysis = undefined;
					// Clean up goal memory and session MC registry
					disposeGoalMemory(goal.id);
					return {
						shouldContinue: false,
						injectedPrompt: `[Goal auto-paused] ${criticalThreshold} consecutive critical issues detected. Latest: "${analysisResult.reason ?? "Unknown"}". Use /goal resume to continue or /goal stop to cancel.`,
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

				// NOTE: Removed autoAdvanceGoalTasks — let the model control task
				// progression via TodoWrite to prevent premature advancement.

				// Check if all GoalTasks are completed — stop time accumulation
				const goalTasks = context.getGoalTasks?.();
				const allGoalTasksDone = goalTasks && goalTasks.length > 0 &&
					goalTasks.every(t => t.status === 'completed');
				if (allGoalTasksDone && updatedGoalRef?.status === Status.Active) {
					// Don't update timeUsedSeconds — goal is logically done
					context.updateGoal({ ...updatedGoalRef, updatedAt: Date.now() });
					return {
						shouldContinue: true,
						injectedPrompt: 'All tasks are completed. Call update_goal(status: "complete", summary: "...") to finish the goal.',
					};
				}

				// Use updated goal status for continuation check
				const effectiveGoal = updatedGoalRef;

				// If 2+ dead turns, inject strategy check into continuation prompt
				let strategyCheck = "";
				if (turnsWithNoChanges >= 2) {
					strategyCheck = `\n\n## Strategy Check\nThe last ${turnsWithNoChanges} turns produced no observable changes. Consider:\n- Trying a different approach\n- Breaking the problem into smaller steps\n- Using /goal pause to stop and reconsider`;
				}

				// Circuit breaker: auto-pause after excessive dead turns (prevents infinite loops)
				const deadTurnLimit = getDeadTurnLimit();
				if (turnsWithNoChanges >= deadTurnLimit) {
					const pausedGoal = {
						...goal,
						status: Status.Paused,
						updatedAt: Date.now(),
					};
					pausedGoal.pauseReason = `Auto-paused: ${turnsWithNoChanges} consecutive turns with no observable changes (limit: ${deadTurnLimit})`;
					context.updateGoal(pausedGoal);
					runtime.pendingAnalysis = undefined;
					// Clean up goal memory and session MC registry
					disposeGoalMemory(goal.id);
					return {
						shouldContinue: false,
						injectedPrompt: `[Goal auto-paused] ${turnsWithNoChanges} turns with no progress. Latest issue: "${analysisResult.reason ?? "Unknown"}". Use /goal resume to continue or /goal stop to cancel.`,
					};
				}

				if (effectiveGoal.status === Status.Active) {
					// Get current in-progress task for the continuation prompt
					const currentGoalTasks = context.getGoalTasks?.();
					const currentTodos = context.getTodos?.();
					const inProgressGoalTask = currentGoalTasks?.find(t => t.status === "in_progress");
					const inProgressTodo = currentTodos?.find(t => t.status === "in_progress");
					const currentTask = inProgressGoalTask?.content ?? inProgressTodo?.content;

					let continuationPrompt =
						buildContinuationPrompt(effectiveGoal, currentTask) + strategyCheck;

					// Inject skill recommendations if cached skills are available
					if (runtime.cachedSkills && runtime.cachedSkills.length > 0) {
						const query = currentTask ?? effectiveGoal.objective
						const ranked = rankSkills(query, runtime.cachedSkills, scenarioConfig, 3)
						continuationPrompt += formatSkillRecommendations(ranked)
					}

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
					const idleGoalTasks = context.getGoalTasks?.();
					const idleTodos = context.getTodos?.();
					const idleCurrentTask = idleGoalTasks?.find(t => t.status === "in_progress")?.content
						?? idleTodos?.find(t => t.status === "in_progress")?.content;
					const continuationPrompt = buildContinuationPrompt(goal, idleCurrentTask);
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

				// Initialize orchestrator state (scenario, convergence, error tracker)
				initOrchestratorState(runtime, event.goal.objective);

				// Pre-fetch skills for recommendation injection (fire-and-forget)
				getSkillMetadata()
					.then((skills) => { runtime.cachedSkills = skills })
					.catch(() => { /* graceful: no recommendations if fetch fails */ });

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
			// Use error tracker if available, fallback to legacy counter
			if (runtime.errorTracker) {
				recordError(runtime.errorTracker, "runtime_exception")
				if (trackerShouldPause(runtime.errorTracker)) {
					const pausedGoal = { ...goal, status: Status.Paused, updatedAt: Date.now() }
					context.updateGoal(pausedGoal)
					runtime.pendingAnalysis = undefined
					disposeGoalMemory(goal.id)
					return {
						shouldContinue: false,
						injectedPrompt: `[Goal paused due to errors] Error threshold exceeded. Use /goal resume to continue or /goal stop to cancel.`,
					}
				}
			} else {
				// Legacy fallback
				runtime.consecutiveErrors = (runtime.consecutiveErrors ?? 0) + 1;
				if (runtime.consecutiveErrors >= 3) {
					const pausedGoal = {
						...goal,
						status: Status.Paused,
						updatedAt: Date.now(),
					};
					context.updateGoal(pausedGoal);
					runtime.pendingAnalysis = undefined;
					return {
						shouldContinue: false,
						injectedPrompt: `[Goal paused due to errors] 3 consecutive errors encountered. Use /goal resume to continue or /goal stop to cancel.`,
					};
				}
			}
		}
		return { shouldContinue: true };
	}
}
