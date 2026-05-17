// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type {
	ToolResultBlockParam,
	ToolUseBlock,
} from "@anthropic-ai/sdk/resources/index.mjs";
import type { CanUseToolFn } from "./hooks/useCanUseTool.js";
import { FallbackTriggeredError, CannotRetryError } from "./services/api/withRetry.js";
import {
	calculateTokenWarningState,
	isAutoCompactEnabled,
	type AutoCompactTrackingState,
} from "./services/compact/autoCompact.js";
import {
	buildPostCompactMessages,
	resetGoalRuntimeAfterCompact,
} from "./services/compact/compact.js";
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature("REACTIVE_COMPACT")
	? (require("./services/compact/reactiveCompact.js") as typeof import("./services/compact/reactiveCompact.js"))
	: null;
const contextCollapse = feature("CONTEXT_COLLAPSE")
	? (require("./services/contextCollapse/index.js") as typeof import("./services/contextCollapse/index.js"))
	: null;
/* eslint-enable @typescript-eslint/no-require-imports */
import {
	logEvent,
	type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from "src/services/analytics/index.js";
import { ImageSizeError } from "./utils/imageValidation.js";
import { ImageResizeError } from "./utils/imageResizer.js";
import { createToolRegistry, type ToolUseContext } from "./Tool.js";
import { asSystemPrompt, type SystemPrompt } from "./utils/systemPromptType.js";
import type {
	AssistantMessage,
	AttachmentMessage,
	Message,
	RequestStartEvent,
	StreamEvent,
	ToolUseSummaryMessage,
	UserMessage,
	TombstoneMessage,
} from "./types/message.js";
import { logError } from "./utils/log.js";
import { sleep } from "./utils/sleep.js";
import {
	PROMPT_TOO_LONG_ERROR_MESSAGE,
	isPromptTooLongMessage,
} from "./services/api/errors.js";
import { logAntError, logForDebugging } from "./utils/debug.js";
import {
	createUserMessage,
	createUserInterruptionMessage,
	normalizeMessagesForAPI,
	createSystemMessage,
	createAssistantAPIErrorMessage,
	getMessagesAfterCompactBoundary,
	createToolUseSummaryMessage,
	createMicrocompactBoundaryMessage,
	stripSignatureBlocks,
} from "./utils/messages.js";
import { generateToolUseSummary } from "./services/toolUseSummary/toolUseSummaryGenerator.js";
import { prependUserContext, appendSystemContext } from "./utils/api.js";
import {
	createAttachmentMessage,
	filterDuplicateMemoryAttachments,
	getAttachmentMessages,
	startRelevantMemoryPrefetch,
} from "./utils/attachments.js";
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature("EXPERIMENTAL_SKILL_SEARCH")
	? (require("./services/skillSearch/prefetch.js") as typeof import("./services/skillSearch/prefetch.js"))
	: null;
const jobClassifier = feature("TEMPLATES")
	? (require("./jobs/classifier.js") as typeof import("./jobs/classifier.js"))
	: null;
/* eslint-enable @typescript-eslint/no-require-imports */
import {
	remove as removeFromQueue,
	getCommandsByMaxPriority,
	isSlashCommand,
} from "./utils/messageQueueManager.js";
import { notifyCommandLifecycle } from "./utils/commandLifecycle.js";
import { headlessProfilerCheckpoint } from "./utils/headlessProfiler.js";
import {
	getRuntimeMainLoopModel,
	renderModelName,
} from "./utils/model/model.js";
import {
	doesMostRecentAssistantMessageExceed200k,
	finalContextTokensFromLastResponse,
	tokenCountWithEstimation,
} from "./utils/tokens.js";
import { ESCALATED_MAX_TOKENS } from "./utils/context.js";
import { getFeatureValue_CACHED_MAY_BE_STALE } from "./services/analytics/growthbook.js";
import { SLEEP_TOOL_NAME } from "./tools/SleepTool/prompt.js";
import { executePostSamplingHooks } from "./utils/hooks/postSamplingHooks.js";
import { executeStopFailureHooks } from "./utils/hooks.js";
import type { QuerySource } from "./constants/querySource.js";
import { createDumpPromptsFetch } from "./services/api/dumpPrompts.js";
import { StreamingToolExecutor } from "./services/tools/StreamingToolExecutor.js";
import { queryCheckpoint } from "./utils/queryProfiler.js";
import { runTools } from "./services/tools/toolOrchestration.js";
import { applyToolResultBudget } from "./utils/toolResultStorage.js";
import { recordContentReplacement } from "./utils/sessionStorage.js";
import {
	forceMemoryBasedMicrocompact,
	clearOldThinkingBlocks,
} from "./services/compact/microCompact.js";
import { handleStopHooks } from "./query/stopHooks.js";
import { buildQueryConfig } from "./query/config.js";
import { productionDeps, type QueryDeps } from "./query/deps.js";
import type { Terminal, Continue } from "./query/transitions.js";
import { feature } from "bun:bundle";
import {
	getCurrentTurnTokenBudget,
	getTurnOutputTokens,
	incrementBudgetContinuationCount,
} from "./bootstrap/state.js";
import { createBudgetTracker, checkTokenBudget } from "./query/tokenBudget.js";
import { count } from "./utils/array.js";
import {
	processGoalRuntimeEvent,
	finishTurnForGoal,
} from "./utils/goal/goalRuntime.js";
import { buildAnalysisPrompt } from "./utils/goal/goalSteering.js";
import {
	ThreadGoalStatus,
	type Goal,
	type TokenUsage,
} from "./commands/goal/types.js";
import type { TodoItem } from "./utils/todo/types.js";

/**
 * Quick (non-stringify) estimate of a single message's byte size.
 * Walks the message's content blocks and sums text byte lengths.
 * Zero allocation — no JSON.stringify, no temporary strings.
 * Used for per-turn memory checks when a full scan isn't due.
 */

/**
 * Deterministic JSON stringify: sorts object keys before serialization.
 * Ensures {a: 1, b: 2} and {b: 2, a: 1} produce identical output for
 * duplicate tool call detection.
 */
function stableStringify(obj: unknown, seen = new Set<object>()): string {
	if (obj === null || typeof obj !== "object") {
		return JSON.stringify(obj);
	}
	if (seen.has(obj)) {
		return '"[circular]"';
	}
	seen.add(obj);
	try {
		if (Array.isArray(obj)) {
			return "[" + obj.map((v) => stableStringify(v, seen)).join(",") + "]";
		}
		const keys = Object.keys(obj).sort();
		const parts = keys.map((k) => {
			const v = (obj as Record<string, unknown>)[k];
			return JSON.stringify(k) + ":" + stableStringify(v, seen);
		});
		return "{" + parts.join(",") + "}";
	} finally {
		seen.delete(obj);
	}
}

function quickMessageByteEstimate(msg: Message): number {
	const OVERHEAD = 256;
	// Image/document blocks are ~2000 tokens ≈ 8KB base64 payload on average.
	// This is a rough constant — actual sizes vary from 1KB (small PNG) to
	// 5MB+ (large screenshot), but 8KB is a reasonable mean estimate.
	const MEDIA_BLOCK_BYTES = 8 * 1024;
	let total = OVERHEAD;

	if (Array.isArray(msg.message.content)) {
		for (const block of msg.message.content) {
			if (block.type === "text" && "text" in block) {
				total += Buffer.byteLength((block as { text: string }).text, "utf8");
			} else if (block.type === "tool_result" && "content" in block) {
				const c = block.content;
				if (typeof c === "string") {
					total += Buffer.byteLength(c, "utf8");
				} else if (Array.isArray(c)) {
					for (const item of c) {
						if (item.type === "text" && "text" in item) {
							total += Buffer.byteLength(
								(item as { text: string }).text,
								"utf8",
							);
						} else if (item.type === "image" || item.type === "document") {
							total += MEDIA_BLOCK_BYTES;
						}
					}
				}
			} else if (block.type === "thinking" && "thinking" in block) {
				total += Buffer.byteLength(
					(block as { thinking: string }).thinking,
					"utf8",
				);
			} else if (block.type === "redacted_thinking" && "data" in block) {
				total += Buffer.byteLength((block as { data: string }).data, "utf8");
			} else if (block.type === "tool_use" && "input" in block) {
				total += Buffer.byteLength(JSON.stringify(block.input ?? {}), "utf8");
			} else if (block.type === "image" || block.type === "document") {
				// Top-level image/document blocks (not inside tool_result)
				total += MEDIA_BLOCK_BYTES;
			}
		}
	}

	return total;
}

/**
 * Full scan byte-size estimator for the message array.
 * Uses JSON.stringify for accuracy — creates a temporary string.
 * Called every 100 turns to recalibrate the quick estimate.
 */
function estimateMessageArrayByteSize(messages: Message[]): number {
	const OVERHEAD = 256 + 8;
	let total = 0;
	for (const msg of messages) {
		total += OVERHEAD;
		total += Buffer.byteLength(JSON.stringify(msg), "utf8");
	}
	return total;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature("HISTORY_SNIP")
	? (require("./services/compact/snipCompact.js") as typeof import("./services/compact/snipCompact.js"))
	: null;
const taskSummaryModule = feature("BG_SESSIONS")
	? (require("./utils/taskSummary.js") as typeof import("./utils/taskSummary.js"))
	: null;
/* eslint-enable @typescript-eslint/no-require-imports */

function* yieldMissingToolResultBlocks(
	assistantMessages: AssistantMessage[],
	errorMessage: string,
) {
	for (const assistantMessage of assistantMessages) {
		// Extract all tool use blocks from this assistant message
		const toolUseBlocks = assistantMessage.message.content.filter(
			(content) => content.type === "tool_use",
		) as ToolUseBlock[];

		// Emit an interruption message for each tool use
		for (const toolUse of toolUseBlocks) {
			yield createUserMessage({
				content: [
					{
						type: "tool_result",
						content: errorMessage,
						is_error: true,
						tool_use_id: toolUse.id,
					},
				],
				toolUseResult: errorMessage,
				sourceToolAssistantUUID: assistantMessage.uuid,
			});
		}
	}
}

/**
 * The rules of thinking are lengthy and fortuitous. They require plenty of thinking
 * of most long duration and deep meditation for a wizard to wrap one's noggin around.
 *
 * The rules follow:
 * 1. A message that contains a thinking or redacted_thinking block must be part of a query whose max_thinking_length > 0
 * 2. A thinking block may not be the last message in a block
 * 3. Thinking blocks must be preserved for the duration of an assistant trajectory (a single turn, or if that turn includes a tool_use block then also its subsequent tool_result and the following assistant message)
 *
 * Heed these rules well, young wizard. For they are the rules of thinking, and
 * the rules of thinking are the rules of the universe. If ye does not heed these
 * rules, ye will be punished with an entire day of debugging and hair pulling.
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

/**
 * Is this a max_output_tokens error message? If so, the streaming loop should
 * withhold it from SDK callers until we know whether the recovery loop can
 * continue. Yielding early leaks an intermediate error to SDK callers (e.g.
 * cowork/desktop) that terminate the session on any `error` field — the
 * recovery loop keeps running but nobody is listening.
 *
 * Mirrors reactiveCompact.isWithheldPromptTooLong.
 */
function isWithheldMaxOutputTokens(
	msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
	return msg?.type === "assistant" && msg.apiError === "max_output_tokens";
}

export type QueryParams = {
	messages: Message[];
	systemPrompt: SystemPrompt;
	userContext: { [k: string]: string };
	systemContext: { [k: string]: string };
	canUseTool: CanUseToolFn;
	toolUseContext: ToolUseContext;
	fallbackModel?: string;
	querySource: QuerySource;
	maxOutputTokensOverride?: number;
	maxTurns?: number;
	skipCacheWrite?: boolean;
	// API task_budget (output_config.task_budget, beta task-budgets-2026-03-13).
	// Distinct from the tokenBudget +500k auto-continue feature. `total` is the
	// budget for the whole agentic turn; `remaining` is computed per iteration
	// from cumulative API usage. See configureTaskBudgetParams in claude.ts.
	taskBudget?: { total: number };
	deps?: QueryDeps;
};

// -- query loop state

// Mutable state carried between loop iterations
type State = {
	messages: Message[];
	toolUseContext: ToolUseContext;
	autoCompactTracking: AutoCompactTrackingState | undefined;
	maxOutputTokensRecoveryCount: number;
	hasAttemptedReactiveCompact: boolean;
	maxOutputTokensOverride: number | undefined;
	pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined;
	stopHookActive: boolean | undefined;
	turnCount: number;
	// Why the previous iteration continued. Undefined on first iteration.
	// Lets tests assert recovery paths fired without inspecting message contents.
	transition: Continue | undefined;
};

export async function* query(
	params: QueryParams,
): AsyncGenerator<
	| StreamEvent
	| RequestStartEvent
	| Message
	| TombstoneMessage
	| ToolUseSummaryMessage,
	Terminal
> {
	const consumedCommandUuids: string[] = [];
	const terminal = yield* queryLoop(params, consumedCommandUuids);
	// Only reached if queryLoop returned normally. Skipped on throw (error
	// propagates through yield*) and on .return() (Return completion closes
	// both generators). This gives the same asymmetric started-without-completed
	// signal as print.ts's drainCommandQueue when the turn fails.
	for (const uuid of consumedCommandUuids) {
		notifyCommandLifecycle(uuid, "completed");
	}
	return terminal;
}

async function* queryLoop(
	params: QueryParams,
	consumedCommandUuids: string[],
): AsyncGenerator<
	| StreamEvent
	| RequestStartEvent
	| Message
	| TombstoneMessage
	| ToolUseSummaryMessage,
	Terminal
> {
	// Immutable params — never reassigned during the query loop.
	const {
		systemPrompt,
		userContext,
		systemContext,
		canUseTool,
		fallbackModel,
		querySource,
		maxTurns,
		skipCacheWrite,
	} = params;
	const deps = params.deps ?? productionDeps();

	// Mutable cross-iteration state. The loop body destructures this at the top
	// of each iteration so reads stay bare-name (`messages`, `toolUseContext`).
	// Continue sites write `state = { ... }` instead of 9 separate assignments.
	let state: State = {
		messages: params.messages,
		toolUseContext: params.toolUseContext,
		maxOutputTokensOverride: params.maxOutputTokensOverride,
		autoCompactTracking: undefined,
		stopHookActive: undefined,
		maxOutputTokensRecoveryCount: 0,
		hasAttemptedReactiveCompact: false,
		turnCount: 1,
		pendingToolUseSummary: undefined,
		transition: undefined,
	};

	// Goal auto-continue state
	let pendingGoalPrompt: string | undefined;
	let currentTokenUsage: TokenUsage | undefined;
	let currentOutputSummary: string | undefined;

	// Duplicate tool call tracking: detect consecutive turns with identical tool calls
	// (same tools, same params) to catch brainstorming skill loops
	type ToolCallSignature = { toolName: string; inputHash: string };
	let _prevTurnToolSignatures: ToolCallSignature[] | null = null;
	let _consecutiveDuplicateTurns = 0;

	const budgetTracker = feature("TOKEN_BUDGET") ? createBudgetTracker() : null;

	// task_budget.remaining tracking across compaction boundaries. Undefined
	// until first compact fires — while context is uncompacted the server can
	// see the full history and handles the countdown from {total} itself (see
	// api/api/sampling/prompt/renderer.py:292). After a compact, the server sees
	// only the summary and would under-count spend; remaining tells it the
	// pre-compact final window that got summarized away. Cumulative across
	// multiple compacts: each subtracts the final context at that compact's
	// trigger point. Loop-local (not on State) to avoid touching the 7 continue
	// sites.
	let taskBudgetRemaining: number | undefined;

	// Snapshot immutable env/statsig/session state once at entry. See QueryConfig
	// for what's included and why feature() gates are intentionally excluded.
	const config = buildQueryConfig();

	// Fired once per user turn — the prompt is invariant across loop iterations,
	// so per-iteration firing would ask sideQuery the same question N times.
	// Consume point polls settledAt (never blocks). `using` disposes on all
	// generator exit paths — see MemoryPrefetch for dispose/telemetry semantics.
	using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
		state.messages,
		state.toolUseContext,
	);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		// DIAGNOSTIC: Track loop iteration entry
		logForDebugging?.(
			`[QUERY LOOP] iteration start: messages=${state.messages.length}, turnCount=${state.turnCount}, reason=${state.transition?.reason ?? "initial"}`,
		);

		// Destructure state at the top of each iteration. toolUseContext alone
		// is reassigned within an iteration (queryTracking, messages updates);
		// the rest are read-only between continue sites.
		let { toolUseContext } = state;
		const {
			messages,
			autoCompactTracking,
			maxOutputTokensRecoveryCount,
			hasAttemptedReactiveCompact,
			maxOutputTokensOverride,
			pendingToolUseSummary,
			stopHookActive,
			turnCount,
		} = state;

		// Goal auto-continue: check local variable (from turn_finished continuation)
		// Skip injection if the last message is a non-meta user message (fresh user input).
		// The continuation prompt from a previous turn should NOT override new user input.
		const lastMsg = state.messages.at(-1);
		const hasFreshUserInput =
			lastMsg?.type === "user" && !(lastMsg as UserMessage).isMeta;
		if (pendingGoalPrompt && !hasFreshUserInput) {
			state.messages = [
				...state.messages,
				createUserMessage({
					content: pendingGoalPrompt,
					isMeta: true,
				}),
			];
			pendingGoalPrompt = undefined;
		}

		// Goal Analysis: check for pending analysis and inject context
		const currentAppState = toolUseContext.getAppState();
		if (
			currentAppState.goalRuntime?.pendingAnalysis &&
			currentAppState.goal?.status === ThreadGoalStatus.Active
		) {
			const pendingAnalysis = currentAppState.goalRuntime.pendingAnalysis;
			// Get context from the last turn in buffer
			const lastTurn =
				currentAppState.goalRuntime.turnBuffer?.[
					currentAppState.goalRuntime.turnBuffer.length - 1
				];
			const analysisPrompt = buildAnalysisPrompt(pendingAnalysis, {
				outputSummary: lastTurn?.outputSummary,
				toolCallsSummary: lastTurn?.toolCallsSummary,
			});
			state.messages = [
				...state.messages,
				createUserMessage({
					content: analysisPrompt,
					isMeta: true,
				}),
			];
			// Clear pending analysis after injection (use setAppState to persist)
			toolUseContext.setAppState((prev) => ({
				...prev,
				goalRuntime: prev.goalRuntime
					? {
							...prev.goalRuntime,
							pendingAnalysis: undefined,
							lastAnalysisResult: pendingAnalysis.reason,
						}
					: undefined,
			}));
		}

		// Skill discovery prefetch — per-iteration (uses findWritePivot guard
		// that returns early on non-write iterations). Discovery runs while the
		// model streams and tools execute; awaited post-tools alongside the
		// memory prefetch consume. Replaces the blocking assistant_turn path
		// that ran inside getAttachmentMessages (97% of those calls found
		// nothing in prod). Turn-0 user-input discovery still blocks in
		// userInputAttachments — that's the one signal where there's no prior
		// work to hide under.
		const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
			null,
			messages,
			toolUseContext,
		);

		yield { type: "stream_request_start" };

		queryCheckpoint("query_fn_entry");

		// Record query start for headless latency tracking (skip for subagents)
		if (!toolUseContext.agentId) {
			headlessProfilerCheckpoint("query_started");
		}

		// Initialize or increment query chain tracking
		const queryTracking = toolUseContext.queryTracking
			? {
					chainId: toolUseContext.queryTracking.chainId,
					depth: toolUseContext.queryTracking.depth + 1,
				}
			: {
					chainId: deps.uuid(),
					depth: 0,
				};

		const queryChainIdForAnalytics =
			queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;

		toolUseContext = {
			...toolUseContext,
			queryTracking,
		};

		let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)];

		let tracking = autoCompactTracking;

		// Enforce per-message budget on aggregate tool result size. Runs BEFORE
		// microcompact — cached MC operates purely by tool_use_id (never inspects
		// content), so content replacement is invisible to it and the two compose
		// cleanly. No-ops when contentReplacementState is undefined (feature off).
		// Persist only for querySources that read records back on resume: agentId
		// routes to sidechain file (AgentTool resume) or session file (/resume).
		// Ephemeral runForkedAgent callers (agent_summary etc.) don't persist.
		const persistReplacements =
			querySource.startsWith("agent:") ||
			querySource.startsWith("repl_main_thread");
		messagesForQuery = await applyToolResultBudget(
			messagesForQuery,
			toolUseContext.contentReplacementState,
			persistReplacements
				? (records) =>
						void recordContentReplacement(
							records,
							toolUseContext.agentId,
						).catch(logError)
				: undefined,
			new Set(
				toolUseContext.options.tools
					.filter((t) => !Number.isFinite(t.maxResultSizeChars))
					.map((t) => t.name),
			),
		);
		logForDebugging?.(
			`[QUERY LOOP] checkpoint: after applyToolResultBudget, messagesForQuery=${messagesForQuery.length}`,
		);

		// Apply snip before microcompact (both may run — they are not mutually exclusive).
		// snipTokensFreed is plumbed to autocompact so its threshold check reflects
		// what snip removed; tokenCountWithEstimation alone can't see it (reads usage
		// from the protected-tail assistant, which survives snip unchanged).
		let snipTokensFreed = 0;
		if (feature("HISTORY_SNIP")) {
			queryCheckpoint("query_snip_start");
			const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery);
			messagesForQuery = snipResult.messages;
			snipTokensFreed = snipResult.tokensFreed;
			if (snipResult.boundaryMessage) {
				yield snipResult.boundaryMessage;
			}
			queryCheckpoint("query_snip_end");
		}

		// Apply microcompact before autocompact
		queryCheckpoint("query_microcompact_start");
		const microcompactResult = await deps.microcompact(
			messagesForQuery,
			toolUseContext,
			querySource,
		);
		messagesForQuery = microcompactResult.messages;
		// For cached microcompact (cache editing), defer boundary message until after
		// the API response so we can use actual cache_deleted_input_tokens.
		// Gated behind feature() so the string is eliminated from external builds.
		const pendingCacheEdits = feature("CACHED_MICROCOMPACT")
			? microcompactResult.compactionInfo?.pendingCacheEdits
			: undefined;
		queryCheckpoint("query_microcompact_end");
		logForDebugging?.(
			`[QUERY LOOP] checkpoint: after microcompact, messagesForQuery=${messagesForQuery.length}`,
		);

		// Memory-pressure escape valve with incremental tracking.
		// The byte tracker does a full JSON.stringify scan every 30 turns;
		// on other checks it uses quick per-message heuristics (zero allocation).
		const MEMORY_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500MB
		const MEMORY_CHECK_INTERVAL = 10;
		// Lazy init: one tracker per query() call, carried across loop iterations.
		// Stored on a module-level var would leak across concurrent queries.
		if (turnCount === 1) {
			// first turn — reset counter from outer scope (see State pattern below)
		}
		if (turnCount % MEMORY_CHECK_INTERVAL === 0) {
			// Use full scan every 10th check (i.e. every 100 turns), quick estimate otherwise.
			// This balances accuracy against peak memory pressure.
			const useFullScan = turnCount % (MEMORY_CHECK_INTERVAL * 10) === 0;
			let estimatedBytes: number;
			try {
				estimatedBytes = useFullScan
					? estimateMessageArrayByteSize(messagesForQuery)
					: messagesForQuery.reduce(
							(sum, msg) => sum + quickMessageByteEstimate(msg),
							0,
						);
			} catch (err) {
				// If byte estimation fails, skip memory check rather than crashing
				// the query loop. This can happen with circular refs or extreme message sizes.
				logEvent("tengu_memory_estimation_failed", {
					messageCount: messagesForQuery.length,
					useFullScan,
					error: (err as Error).message,
				});
				logForDebugging(
					`[MEMORY CHECK] byte estimation failed (${useFullScan ? "fullScan" : "quick"}, ${messagesForQuery.length} msgs): ${(err as Error).message}, skipping check`,
				);
				estimatedBytes = 0;
			}

			// Track the estimate for diagnostics (log every 30 checks to avoid spam)
			if (turnCount % (MEMORY_CHECK_INTERVAL * 3) === 0) {
				logEvent("tengu_memory_pressure_check", {
					estimatedBytes,
					messageCount: messagesForQuery.length,
					isFullScan: useFullScan,
					thresholdBytes: MEMORY_THRESHOLD_BYTES,
				});
			}

			if (estimatedBytes > MEMORY_THRESHOLD_BYTES) {
				const preCompactBytes = estimatedBytes;
				logForDebugging(
					`[MEMORY TRIGGER] messagesForQuery ~${(preCompactBytes / 1024 / 1024).toFixed(1)}MB exceeds 500MB, forcing memory-based micro-compact`,
				);
				const memResult = forceMemoryBasedMicrocompact(
					messagesForQuery,
					20, // Keep last 20 tool results
					querySource,
				);
				if (memResult) {
					messagesForQuery = memResult.messages;
				}
				// Also clear old thinking blocks from assistant messages
				messagesForQuery = clearOldThinkingBlocks(messagesForQuery, 3);

				// Post-compaction: measure savings for observability
				const postCompactBytes = estimateMessageArrayByteSize(messagesForQuery);
				const bytesFreed = preCompactBytes - postCompactBytes;
				logEvent("tengu_memory_based_compaction_fired", {
					preCompactBytes,
					postCompactBytes,
					bytesFreed,
					messageCountBefore: messagesForQuery.length, // approximate, may differ if memResult changed length
					messageCountAfter: messagesForQuery.length,
				});
				logForDebugging(
					`[MEMORY TRIGGER] freed ~${(bytesFreed / 1024 / 1024).toFixed(1)}MB (${((bytesFreed / preCompactBytes) * 100).toFixed(0)}% reduction)`,
				);
			}
		}

		logForDebugging?.(
			`[QUERY LOOP] checkpoint: after memory check, messagesForQuery=${messagesForQuery.length}`,
		);

		// Project the collapsed context view and maybe commit more collapses.
		// Runs BEFORE autocompact so that if collapse gets us under the
		// autocompact threshold, autocompact is a no-op and we keep granular
		// context instead of a single summary.
		//
		// Nothing is yielded — the collapsed view is a read-time projection
		// over the REPL's full history. Summary messages live in the collapse
		// store, not the REPL array. This is what makes collapses persist
		// across turns: projectView() replays the commit log on every entry.
		// Within a turn, the view flows forward via state.messages at the
		// continue site (query.ts:1192), and the next projectView() no-ops
		// because the archived messages are already gone from its input.
		if (feature("CONTEXT_COLLAPSE") && contextCollapse) {
			const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
				messagesForQuery,
				toolUseContext,
				querySource,
			);
			messagesForQuery = collapseResult.messages;
		}

		logForDebugging?.(
			`[QUERY LOOP] after context collapse: messagesForQuery=${messagesForQuery.length}`,
		);
		const fullSystemPrompt = asSystemPrompt(
			appendSystemContext(systemPrompt, systemContext),
		);

		queryCheckpoint("query_autocompact_start");
		logForDebugging?.(`[QUERY LOOP] entering autocompact setup`);
		const { compactionResult, consecutiveFailures } = await deps.autocompact(
			messagesForQuery,
			toolUseContext,
			{
				systemPrompt,
				userContext,
				systemContext,
				toolUseContext,
				forkContextMessages: messagesForQuery,
			},
			querySource,
			tracking,
			snipTokensFreed,
		);
		queryCheckpoint("query_autocompact_end");
		logForDebugging?.(
			`[QUERY LOOP] setup complete, entering API loop: messagesForQuery=${messagesForQuery.length}, compactionResult=${!!compactionResult}`,
		);

		if (compactionResult) {
			const {
				preCompactTokenCount,
				postCompactTokenCount,
				truePostCompactTokenCount,
				compactionUsage,
			} = compactionResult;

			logEvent("tengu_auto_compact_succeeded", {
				originalMessageCount: messages.length,
				compactedMessageCount:
					compactionResult.summaryMessages.length +
					compactionResult.attachments.length +
					compactionResult.hookResults.length,
				preCompactTokenCount,
				postCompactTokenCount,
				truePostCompactTokenCount,
				compactionInputTokens: compactionUsage?.input_tokens,
				compactionOutputTokens: compactionUsage?.output_tokens,
				compactionCacheReadTokens:
					compactionUsage?.cache_read_input_tokens ?? 0,
				compactionCacheCreationTokens:
					compactionUsage?.cache_creation_input_tokens ?? 0,
				compactionTotalTokens: compactionUsage
					? compactionUsage.input_tokens +
						(compactionUsage.cache_creation_input_tokens ?? 0) +
						(compactionUsage.cache_read_input_tokens ?? 0) +
						compactionUsage.output_tokens
					: 0,

				queryChainId: queryChainIdForAnalytics,
				queryDepth: queryTracking.depth,
			});

			// task_budget: capture pre-compact final context window before
			// messagesForQuery is replaced with postCompactMessages below.
			// iterations[-1] is the authoritative final window (post server tool
			// loops); see #304930.
			if (params.taskBudget) {
				const preCompactContext =
					finalContextTokensFromLastResponse(messagesForQuery);
				taskBudgetRemaining = Math.max(
					0,
					(taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
				);
			}

			// Reset on every compact so turnCounter/turnId reflect the MOST RECENT
			// compact. recompactionInfo (autoCompact.ts:190) already captured the
			// old values for turnsSincePreviousCompact/previousCompactTurnId before
			// the call, so this reset doesn't lose those.
			tracking = {
				compacted: true,
				turnId: deps.uuid(),
				turnCounter: 0,
				consecutiveFailures: 0,
			};

			const postCompactMessages = buildPostCompactMessages(compactionResult);

			for (const message of postCompactMessages) {
				yield message;
			}

			// Continue on with the current query call using the post compact messages
			messagesForQuery = postCompactMessages;

			// Reset goalRuntime accounting.turn to prevent negative tokenDelta after compact
			// CRITICAL: This must be called after every compact operation
			resetGoalRuntimeAfterCompact(
				toolUseContext.setAppState,
				compactionResult.compactionUsage,
			);
		} else if (consecutiveFailures !== undefined) {
			// Autocompact failed — propagate failure count so the circuit breaker
			// can stop retrying on the next iteration.
			tracking = {
				...(tracking ?? { compacted: false, turnId: "", turnCounter: 0 }),
				consecutiveFailures,
			};
		}

		//TODO: no need to set toolUseContext.messages during set-up since it is updated here
		toolUseContext = {
			...toolUseContext,
			messages: messagesForQuery,
		};

		const assistantMessages: AssistantMessage[] = [];
		const toolResults: (UserMessage | AttachmentMessage)[] = [];
		// @see https://docs.claude.com/en/docs/build-with-claude/tool-use
		// Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly.
		// Set during streaming whenever a tool_use block arrives — the sole
		// loop-exit signal. If false after streaming, we're done (modulo stop-hook retry).
		const toolUseBlocks: ToolUseBlock[] = [];
		let needsFollowUp = false;

		queryCheckpoint("query_setup_start");
		const useStreamingToolExecution = config.gates.streamingToolExecution;
		let streamingToolExecutor = useStreamingToolExecution
			? new StreamingToolExecutor(
					toolUseContext.options.tools,
					canUseTool,
					toolUseContext,
				)
			: null;

		const appState = toolUseContext.getAppState();

		// Trigger turn_started event at the beginning of each turn for goal tracking
		if (
			appState.goal?.id &&
			appState.goal?.status === ThreadGoalStatus.Active
		) {
			const turnBaselineUsage: TokenUsage = {
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 0,
			};
			processGoalRuntimeEvent(
				{
					type: "turn_started",
					turnId: tracking?.turnId ?? deps.uuid(),
					tokenUsage: turnBaselineUsage,
				},
				{
					goal: appState.goal,
					runtime: appState.goalRuntime,
					currentTokenUsage: currentTokenUsage ?? turnBaselineUsage,
					injectPrompt: async () => {},
					updateGoal: (goal: Goal) => {
						toolUseContext.setAppState((prev) => ({
							...prev,
							goal,
						}));
					},
					getTodos: () => {
						const todoListId = appState.goal?.todoListId;
						if (!todoListId) return undefined;
						return toolUseContext.getAppState().todos?.[todoListId];
					},
					updateTodos: (todos) => {
						const todoListId = appState.goal?.todoListId;
						if (!todoListId) return;
						toolUseContext.setAppState((prev) => ({
							...prev,
							todos: {
								...prev.todos,
								[todoListId]: todos,
							},
						}));
					},
					getGoalTasks: () => {
						const goalTaskListId = (appState.goal as any)?.goalTaskListId;
						if (!goalTaskListId) return undefined;
						return toolUseContext.getAppState().goalTasks?.[goalTaskListId];
					},
					updateGoalTasks: (tasks) => {
						const goalTaskListId = (appState.goal as any)?.goalTaskListId;
						if (!goalTaskListId) return;
						toolUseContext.setAppState((prev) => ({
							...prev,
							goalTasks: {
								...prev.goalTasks,
								[goalTaskListId]: tasks,
							},
						}));
					},
				},
			);
		}

		const permissionMode = appState.toolPermissionContext.mode;
		let currentModel = getRuntimeMainLoopModel({
			permissionMode,
			mainLoopModel: toolUseContext.options.mainLoopModel,
			exceeds200kTokens:
				permissionMode === "plan" &&
				doesMostRecentAssistantMessageExceed200k(messagesForQuery),
		});

		queryCheckpoint("query_setup_end");

		// Create fetch wrapper once per query session to avoid memory retention.
		// Each call to createDumpPromptsFetch creates a closure that captures the request body.
		// Creating it once means only the latest request body is retained (~700KB),
		// instead of all request bodies from the session (~500MB for long sessions).
		// Note: agentId is effectively constant during a query() call - it only changes
		// between queries (e.g., /clear command or session resume).
		const dumpPromptsFetch = config.gates.isAnt
			? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
			: undefined;

		// Block if we've hit the hard blocking limit (only applies when auto-compact is OFF)
		// This reserves space so users can still run /compact manually
		// Skip this check if compaction just happened - the compaction result is already
		// validated to be under the threshold, and tokenCountWithEstimation would use
		// stale input_tokens from kept messages that reflect pre-compaction context size.
		// Same staleness applies to snip: subtract snipTokensFreed (otherwise we'd
		// falsely block in the window where snip brought us under autocompact threshold
		// but the stale usage is still above blocking limit — before this PR that
		// window never existed because autocompact always fired on the stale count).
		// Also skip for compact/session_memory queries — these are forked agents that
		// inherit the full conversation and would deadlock if blocked here (the compact
		// agent needs to run to REDUCE the token count).
		// Also skip when reactive compact is enabled and automatic compaction is
		// allowed — the preempt's synthetic error returns before the API call,
		// so reactive compact would never see a prompt-too-long to react to.
		// Widened to walrus so RC can act as fallback when proactive fails.
		//
		// Same skip for context-collapse: its recoverFromOverflow drains
		// staged collapses on a REAL API 413, then falls through to
		// reactiveCompact. A synthetic preempt here would return before the
		// API call and starve both recovery paths. The isAutoCompactEnabled()
		// conjunct preserves the user's explicit "no automatic anything"
		// config — if they set DISABLE_AUTO_COMPACT, they get the preempt.
		let collapseOwnsIt = false;
		if (feature("CONTEXT_COLLAPSE")) {
			collapseOwnsIt =
				(contextCollapse?.isContextCollapseEnabled() ?? false) &&
				isAutoCompactEnabled();
		}
		// Hoist media-recovery gate once per turn. Withholding (inside the
		// stream loop) and recovery (after) must agree; CACHED_MAY_BE_STALE can
		// flip during the 5-30s stream, and withhold-without-recover would eat
		// the message. PTL doesn't hoist because its withholding is ungated —
		// it predates the experiment and is already the control-arm baseline.
		const mediaRecoveryEnabled =
			reactiveCompact?.isReactiveCompactEnabled() ?? false;
		logForDebugging?.(
			`[QUERY LOOP] checkpoint: before blocking limit check, compactionResult=${!!compactionResult}, querySource=${querySource}`,
		);
		if (
			!compactionResult &&
			querySource !== "compact" &&
			querySource !== "session_memory" &&
			!(
				reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
			) &&
			!collapseOwnsIt
		) {
			const tokenCount =
				tokenCountWithEstimation(messagesForQuery) - snipTokensFreed;
			const modelForCheck = toolUseContext.options.mainLoopModel;
			logForDebugging?.(
				`[QUERY LOOP] checkpoint: computing token warning state, tokenCount=${tokenCount}, model=${modelForCheck}`,
			);
			const { isAtBlockingLimit } = calculateTokenWarningState(
				tokenCount,
				modelForCheck,
			);
			logForDebugging?.(
				`[QUERY LOOP] checkpoint: isAtBlockingLimit=${isAtBlockingLimit}`,
			);
			if (isAtBlockingLimit) {
				logForDebugging?.(`[QUERY LOOP] exit: blocking_limit reached`);
				yield createAssistantAPIErrorMessage({
					content: PROMPT_TOO_LONG_ERROR_MESSAGE,
					error: "invalid_request",
				});
				return { reason: "blocking_limit" };
			}
		}

		let attemptWithFallback = true;

		queryCheckpoint("query_api_loop_start");
		try {
			while (attemptWithFallback) {
				attemptWithFallback = false;
				try {
					let streamingFallbackOccured = false;
					queryCheckpoint("query_api_streaming_start");
					for await (const message of deps.callModel({
						messages: prependUserContext(messagesForQuery, userContext),
						systemPrompt: fullSystemPrompt,
						thinkingConfig: toolUseContext.options.thinkingConfig,
						tools: toolUseContext.options.tools,
						signal: toolUseContext.abortController.signal,
						options: {
							async getToolPermissionContext() {
								const appState = toolUseContext.getAppState();
								return appState.toolPermissionContext;
							},
							model: currentModel,
							...(config.gates.fastModeEnabled && {
								fastMode: appState.fastMode,
							}),
							toolChoice: undefined,
							isNonInteractiveSession:
								toolUseContext.options.isNonInteractiveSession,
							fallbackModel,
							onStreamingFallback: () => {
								streamingFallbackOccured = true;
							},
							querySource,
							agents: toolUseContext.options.agentDefinitions.activeAgents,
							allowedAgentTypes:
								toolUseContext.options.agentDefinitions.allowedAgentTypes,
							hasAppendSystemPrompt:
								!!toolUseContext.options.appendSystemPrompt,
							maxOutputTokensOverride,
							fetchOverride: dumpPromptsFetch,
							mcpTools: appState.mcp.tools,
							hasPendingMcpServers: appState.mcp.clients.some(
								(c) => c.type === "pending",
							),
							queryTracking,
							effortValue: appState.effortValue,
							advisorModel: appState.advisorModel,
							skipCacheWrite,
							agentId: toolUseContext.agentId,
							addNotification: toolUseContext.addNotification,
							...(params.taskBudget && {
								taskBudget: {
									total: params.taskBudget.total,
									...(taskBudgetRemaining !== undefined && {
										remaining: taskBudgetRemaining,
									}),
								},
							}),
						},
					})) {
						// We won't use the tool_calls from the first attempt
						// We could.. but then we'd have to merge assistant messages
						// with different ids and double up on full the tool_results
						if (streamingFallbackOccured) {
							// Yield tombstones for orphaned messages so they're removed from UI and transcript.
							// These partial messages (especially thinking blocks) have invalid signatures
							// that would cause "thinking blocks cannot be modified" API errors.
							for (const msg of assistantMessages) {
								yield { type: "tombstone" as const, message: msg };
							}
							logEvent("tengu_orphaned_messages_tombstoned", {
								orphanedMessageCount: assistantMessages.length,
								queryChainId: queryChainIdForAnalytics,
								queryDepth: queryTracking.depth,
							});

							assistantMessages.length = 0;
							toolResults.length = 0;
							toolUseBlocks.length = 0;
							needsFollowUp = false;

							// Discard pending results from the failed streaming attempt and create
							// a fresh executor. This prevents orphan tool_results (with old tool_use_ids)
							// from being yielded after the fallback response arrives.
							if (streamingToolExecutor) {
								streamingToolExecutor.discard();
								streamingToolExecutor = new StreamingToolExecutor(
									toolUseContext.options.tools,
									canUseTool,
									toolUseContext,
								);
							}
						}
						// Backfill tool_use inputs on a cloned message before yield so
						// SDK stream output and transcript serialization see legacy/derived
						// fields. The original `message` is left untouched for
						// assistantMessages.push below — it flows back to the API and
						// mutating it would break prompt caching (byte mismatch).
						let yieldMessage: typeof message = message;
						if (message.type === "assistant") {
							let clonedContent: typeof message.message.content | undefined;
							for (let i = 0; i < message.message.content.length; i++) {
								const block = message.message.content[i]!;
								if (
									block.type === "tool_use" &&
									typeof block.input === "object" &&
									block.input !== null
								) {
									const toolRegistry = createToolRegistry(toolUseContext.options.tools);
									const tool = toolRegistry.find(block.name);
									if (tool?.backfillObservableInput) {
										const originalInput = block.input as Record<
											string,
											unknown
										>;
										const inputCopy = { ...originalInput };
										tool.backfillObservableInput(inputCopy);
										// Only yield a clone when backfill ADDED fields; skip if
										// it only OVERWROTE existing ones (e.g. file tools
										// expanding file_path). Overwrites change the serialized
										// transcript and break VCR fixture hashes on resume,
										// while adding nothing the SDK stream needs — hooks get
										// the expanded path via toolExecution.ts separately.
										const addedFields = Object.keys(inputCopy).some(
											(k) => !(k in originalInput),
										);
										if (addedFields) {
											clonedContent ??= [...message.message.content];
											clonedContent[i] = { ...block, input: inputCopy };
										}
									}
								}
							}
							if (clonedContent) {
								yieldMessage = {
									...message,
									message: { ...message.message, content: clonedContent },
								};
							}
						}
						// Withhold recoverable errors (prompt-too-long, max-output-tokens)
						// until we know whether recovery (collapse drain / reactive
						// compact / truncation retry) can succeed. Still pushed to
						// assistantMessages so the recovery checks below find them.
						// Either subsystem's withhold is sufficient — they're
						// independent so turning one off doesn't break the other's
						// recovery path.
						//
						// feature() only works in if/ternary conditions (bun:bundle
						// tree-shaking constraint), so the collapse check is nested
						// rather than composed.
						let withheld = false;
						if (feature("CONTEXT_COLLAPSE")) {
							if (
								contextCollapse?.isWithheldPromptTooLong(
									message,
									isPromptTooLongMessage,
									querySource,
								)
							) {
								withheld = true;
							}
						}
						if (reactiveCompact?.isWithheldPromptTooLong(message)) {
							withheld = true;
						}
						if (
							mediaRecoveryEnabled &&
							reactiveCompact?.isWithheldMediaSizeError(message)
						) {
							withheld = true;
						}
						if (isWithheldMaxOutputTokens(message)) {
							withheld = true;
						}
						if (!withheld) {
							yield yieldMessage;
						}
						if (message.type === "assistant") {
							assistantMessages.push(message);

							const msgToolUseBlocks = message.message.content.filter(
								(content) => content.type === "tool_use",
							) as ToolUseBlock[];
							if (msgToolUseBlocks.length > 0) {
								toolUseBlocks.push(...msgToolUseBlocks);
								needsFollowUp = true;
							}

							if (
								streamingToolExecutor &&
								!toolUseContext.abortController.signal.aborted
							) {
								for (const toolBlock of msgToolUseBlocks) {
									streamingToolExecutor.addTool(toolBlock, message);
								}
							}
						}

						if (
							streamingToolExecutor &&
							!toolUseContext.abortController.signal.aborted
						) {
							for (const result of streamingToolExecutor.getCompletedResults()) {
								if (result.message) {
									yield result.message;
									toolResults.push(
										...normalizeMessagesForAPI(
											[result.message],
											toolUseContext.options.tools,
										).filter((_) => _.type === "user"),
									);
								}
							}
						}
					}
					queryCheckpoint("query_api_streaming_end");

					// Yield deferred microcompact boundary message using actual API-reported
					// token deletion count instead of client-side estimates.
					// Entire block gated behind feature() so the excluded string
					// is eliminated from external builds.
					if (feature("CACHED_MICROCOMPACT") && pendingCacheEdits) {
						const lastAssistant = assistantMessages.at(-1);
						// The API field is cumulative/sticky across requests, so we
						// subtract the baseline captured before this request to get the delta.
						const usage = lastAssistant?.message.usage;
						const cumulativeDeleted = usage
							? ((usage as unknown as Record<string, number>)
									.cache_deleted_input_tokens ?? 0)
							: 0;
						const deletedTokens = Math.max(
							0,
							cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
						);
						if (deletedTokens > 0) {
							yield createMicrocompactBoundaryMessage(
								pendingCacheEdits.trigger,
								0,
								deletedTokens,
								pendingCacheEdits.deletedToolIds,
								[],
							);
						}
					}

					// Update goal accounting with token usage from API response
					const lastAssistantMsg = assistantMessages.at(-1);
					const apiUsage = lastAssistantMsg?.message.usage;
					if (apiUsage) {
						// Accumulate token usage from all API responses in this turn
						// (multi-tool turns may have multiple API calls)
						currentTokenUsage = {
							inputTokens:
								(currentTokenUsage?.inputTokens ?? 0) + apiUsage.input_tokens,
							cachedInputTokens:
								(currentTokenUsage?.cachedInputTokens ?? 0) +
								(apiUsage.cache_read_input_tokens || 0),
							outputTokens:
								(currentTokenUsage?.outputTokens ?? 0) + apiUsage.output_tokens,
							reasoningOutputTokens:
								(currentTokenUsage?.reasoningOutputTokens ?? 0) +
								((apiUsage as unknown as Record<string, number>)
									.reasoning_tokens || 0),
							totalTokens:
								(currentTokenUsage?.totalTokens ?? 0) +
								apiUsage.input_tokens +
								apiUsage.output_tokens,
						};

						// Extract first 200 chars of output for goal analysis
						const content = lastAssistantMsg?.message?.content;
						if (content) {
							const textContent =
								typeof content === "string"
									? content
									: Array.isArray(content)
										? content
												.map((b) =>
													typeof b === "object" && "text" in b ? b.text : "",
												)
												.join("")
										: "";
							currentOutputSummary = textContent.slice(0, 200);
						}
					}
				} catch (innerError) {
					if (innerError instanceof FallbackTriggeredError && fallbackModel) {
						// Fallback was triggered - switch model and retry
						currentModel = fallbackModel;
						attemptWithFallback = true;

						// Clear assistant messages since we'll retry the entire request
						yield* yieldMissingToolResultBlocks(
							assistantMessages,
							"Model fallback triggered",
						);
						assistantMessages.length = 0;
						toolResults.length = 0;
						toolUseBlocks.length = 0;
						needsFollowUp = false;

						// Discard pending results from the failed attempt and create a
						// fresh executor. This prevents orphan tool_results (with old
						// tool_use_ids) from leaking into the retry.
						if (streamingToolExecutor) {
							streamingToolExecutor.discard();
							streamingToolExecutor = new StreamingToolExecutor(
								toolUseContext.options.tools,
								canUseTool,
								toolUseContext,
							);
						}

						// Update tool use context with new model
						toolUseContext.options.mainLoopModel = fallbackModel;

						// Thinking signatures are model-bound: replaying a protected-thinking
						// block (e.g. capybara) to an unprotected fallback (e.g. opus) 400s.
						// Strip before retry so the fallback model gets clean history.
						if (process.env.USER_TYPE === "ant") {
							messagesForQuery = stripSignatureBlocks(messagesForQuery);
						}

						// Log the fallback event
						logEvent("tengu_model_fallback_triggered", {
							original_model:
								innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
							fallback_model:
								fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
							entrypoint:
								"cli" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
							queryChainId: queryChainIdForAnalytics,
							queryDepth: queryTracking.depth,
						});

						// Yield system message about fallback — use 'warning' level so
						// users see the notification without needing verbose mode
						yield createSystemMessage(
							`Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
							"warning",
						);

						continue;
					}
					throw innerError;
				}
			}
		} catch (error) {
			logError(error);
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logEvent("tengu_query_error", {
				assistantMessages: assistantMessages.length,
				toolUses: assistantMessages.flatMap((_) =>
					_.message.content.filter((content) => content.type === "tool_use"),
				).length,

				queryChainId: queryChainIdForAnalytics,
				queryDepth: queryTracking.depth,
			});

			// Goal fallback retry detection - detect when goal has retry config and all retries exhausted
			const appState = toolUseContext.getAppState();
			const goal = appState.goal as Goal | undefined;

			if (
				error instanceof CannotRetryError &&
				goal &&
				goal.status === ThreadGoalStatus.Active &&
				goal.retryConfig?.enabled
			) {
				// Check for permanent errors (401/403) - should not retry
				const originalError = error.originalError;
				let isPermanentError = false;
				if (originalError instanceof Error && "status" in originalError) {
					const status = (originalError as { status?: number }).status;
					isPermanentError = status === 401 || status === 403;
				}

				if (isPermanentError) {
					logError(new Error(`Goal retry skipped: permanent error`));
					// Let it propagate as normal error
				} else {
					// Implement full fallback retry loop with heartbeat
					const retryConfig = goal.retryConfig;
					const startTime = Date.now();
					const maxRetryTimeMs = retryConfig.maxRetryHours * 3600000;
					let retryNumber = (goal.retryCount || 0) + 1;
					let lastErrorMessage = error.message || "Unknown error";

					// Output immediate notification
					const nextRetryAt = new Date(Date.now() + retryConfig.intervalMs);
					const initialMessage = `⏳ Goal 10 次快速重试均失败，进入兜底重试模式
   下次重试: ${nextRetryAt.toLocaleTimeString()} (${Math.round(retryConfig.intervalMs / 60000)} 分钟后)
   最大重试时间: ${retryConfig.maxRetryHours} 小时`;

					yield createSystemMessage(initialMessage, "warning");

					while (true) {
						// Check if we've exceeded max retry time
						const elapsed = Date.now() - startTime;
						if (elapsed >= maxRetryTimeMs) {
							yield createSystemMessage(
								`❌ Goal 兜底重试超时：已超过最大重试时间 ${retryConfig.maxRetryHours} 小时`,
								"error",
							);
							break;
						}

						// Check if goal still exists and is active
						const currentGoal = toolUseContext.getAppState().goal;
						if (!currentGoal || currentGoal.status !== ThreadGoalStatus.Active) {
							yield createSystemMessage(
								"⚠️ Goal 已暂停或取消，终止兜底重试",
								"warning",
							);
							break;
						}

						// Check abort signal (user cancellation)
						if (toolUseContext.abortController?.signal.aborted) {
							yield createSystemMessage(
								"⚠️ 用户取消操作，终止兜底重试",
								"warning",
							);
							break;
						}

						const currentNextRetryAt = new Date(Date.now() + retryConfig.intervalMs);
						const retryMessage = `🔄 Goal 兜底重试 (第 ${retryNumber} 次)
   上次错误: ${lastErrorMessage}
   下次重试: ${currentNextRetryAt.toLocaleTimeString()} (${Math.round(retryConfig.intervalMs / 60000)} 分钟后)
   已耗时: ${Math.floor(elapsed / 60000)} 分钟 / 最大 ${retryConfig.maxRetryHours} 小时`;

						yield createSystemMessage(retryMessage, "warning");

						// Update retry count
						toolUseContext.setAppState((prev) => ({
							...prev,
							goal: prev.goal
								? { ...prev.goal, retryCount: retryNumber }
								: undefined,
						}));

						// Chunked sleep with heartbeat - check abort every 30 seconds
						const HEARTBEAT_INTERVAL = 30_000;
						let sleepRemaining = retryConfig.intervalMs;
						let sleepCancelled = false;

						while (sleepRemaining > 0) {
							if (toolUseContext.abortController?.signal.aborted) {
								sleepCancelled = true;
								break;
							}

							const chunk = Math.min(sleepRemaining, HEARTBEAT_INTERVAL);
							try {
								await sleep(chunk, toolUseContext.abortController?.signal, {
									abortError: () => new Error("Retry cancelled by user"),
								});
							} catch (e) {
								if (e instanceof Error && e.message === "Retry cancelled by user") {
									sleepCancelled = true;
									break;
								}
								throw e;
							}

							sleepRemaining -= chunk;
						}

						if (sleepCancelled) {
							yield createSystemMessage(
								"⚠️ 用户取消操作，终止兜底重试",
								"warning",
							);
							break;
						}

						// Execute retry - yield a system message to trigger re-query
						yield {
							type: "system" as const,
							subtype: "goal_retry_trigger",
							content: "重新尝试执行 Goal...",
							retryCount: retryNumber,
						};

						// Update retry number for next iteration
						retryNumber++;

						// Break and let the outer loop handle the retry
						// The goal_retry_trigger message will signal that retry is needed
						return { reason: "goal_retry_triggered", retryCount: retryNumber - 1 };
					}
				}
			}

			// Handle image size/resize errors with user-friendly messages
			if (
				error instanceof ImageSizeError ||
				error instanceof ImageResizeError
			) {
				yield createAssistantAPIErrorMessage({
					content: error.message,
				});
				return { reason: "image_error" };
			}

			// Generally queryModelWithStreaming should not throw errors but instead
			// yield them as synthetic assistant messages. However if it does throw
			// due to a bug, we may end up in a state where we have already emitted
			// a tool_use block but will stop before emitting the tool_result.
			yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage);

			// Surface the real error instead of a misleading "[Request interrupted
			// by user]" — this path is a model/runtime failure, not a user action.
			// SDK consumers were seeing phantom interrupts on e.g. Node 18's missing
			// Array.prototype.with(), masking the actual cause.
			yield createAssistantAPIErrorMessage({
				content: errorMessage,
			});

			// To help track down bugs, log loudly for ants
			logAntError("Query error", error);
			return { reason: "model_error", error };
		}

		// Execute post-sampling hooks after model response is complete
		if (assistantMessages.length > 0) {
			void executePostSamplingHooks(
				[...messagesForQuery, ...assistantMessages],
				systemPrompt,
				userContext,
				systemContext,
				toolUseContext,
				querySource,
			);
		}

		// We need to handle a streaming abort before anything else.
		// When using streamingToolExecutor, we must consume getRemainingResults() so the
		// executor can generate synthetic tool_result blocks for queued/in-progress tools.
		// Without this, tool_use blocks would lack matching tool_result blocks.
		if (toolUseContext.abortController.signal.aborted) {
			if (streamingToolExecutor) {
				// Consume remaining results - executor generates synthetic tool_results for
				// aborted tools since it checks the abort signal in executeTool()
				for await (const update of streamingToolExecutor.getRemainingResults()) {
					if (update.message) {
						yield update.message;
					}
				}
			} else {
				yield* yieldMissingToolResultBlocks(
					assistantMessages,
					"Interrupted by user",
				);
			}
			// chicago MCP: auto-unhide + lock release on interrupt. Same cleanup
			// as the natural turn-end path in stopHooks.ts. Main thread only —
			// see stopHooks.ts for the subagent-releasing-main's-lock rationale.
			if (feature("CHICAGO_MCP") && !toolUseContext.agentId) {
				try {
					const { cleanupComputerUseAfterTurn } = await import(
						"./utils/computerUse/cleanup.js"
					);
					await cleanupComputerUseAfterTurn(toolUseContext);
				} catch {
					// Failures are silent — this is dogfooding cleanup, not critical path
				}
			}

			// Skip the interruption message for submit-interrupts — the queued
			// user message that follows provides sufficient context.
			if (toolUseContext.abortController.signal.reason !== "interrupt") {
				yield createUserInterruptionMessage({
					toolUse: false,
				});
			}
			return { reason: "aborted_streaming" };
		}

		// Yield tool use summary from previous turn — haiku (~1s) resolved during model streaming (5-30s)
		if (pendingToolUseSummary) {
			const summary = await pendingToolUseSummary;
			if (summary) {
				yield summary;
			}
		}

		if (!needsFollowUp) {
			// No tool calls this turn — reset consecutive counter but keep
			// the previous signatures. This way, alternating tool/no-tool
			// turns (e.g., Agent -> text -> Agent with same params) will
			// still be caught on the next tool turn.
			_consecutiveDuplicateTurns = 0;

			const lastMessage = assistantMessages.at(-1);

			// Prompt-too-long recovery: the streaming loop withheld the error
			// (see withheldByCollapse / withheldByReactive above). Try collapse
			// drain first (cheap, keeps granular context), then reactive compact
			// (full summary). Single-shot on each — if a retry still 413's,
			// the next stage handles it or the error surfaces.
			const isWithheld413 =
				lastMessage?.type === "assistant" &&
				lastMessage.isApiErrorMessage &&
				isPromptTooLongMessage(lastMessage);
			// Media-size rejections (image/PDF/many-image) are recoverable via
			// reactive compact's strip-retry. Unlike PTL, media errors skip the
			// collapse drain — collapse doesn't strip images. mediaRecoveryEnabled
			// is the hoisted gate from before the stream loop (same value as the
			// withholding check — these two must agree or a withheld message is
			// lost). If the oversized media is in the preserved tail, the
			// post-compact turn will media-error again; hasAttemptedReactiveCompact
			// prevents a spiral and the error surfaces.
			const isWithheldMedia =
				mediaRecoveryEnabled &&
				reactiveCompact?.isWithheldMediaSizeError(lastMessage);
			if (isWithheld413) {
				// First: drain all staged context-collapses. Gated on the PREVIOUS
				// transition not being collapse_drain_retry — if we already drained
				// and the retry still 413'd, fall through to reactive compact.
				if (
					feature("CONTEXT_COLLAPSE") &&
					contextCollapse &&
					state.transition?.reason !== "collapse_drain_retry"
				) {
					const drained = contextCollapse.recoverFromOverflow(
						messagesForQuery,
						querySource,
					);
					if (drained.committed > 0) {
						const next: State = {
							messages: drained.messages,
							toolUseContext,
							autoCompactTracking: tracking,
							maxOutputTokensRecoveryCount,
							hasAttemptedReactiveCompact,
							maxOutputTokensOverride: undefined,
							pendingToolUseSummary: undefined,
							stopHookActive: undefined,
							turnCount,
							transition: {
								reason: "collapse_drain_retry",
								committed: drained.committed,
							},
						};
						state = next;
						continue;
					}
				}
			}
			if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
				const compacted = await reactiveCompact.tryReactiveCompact({
					hasAttempted: hasAttemptedReactiveCompact,
					querySource,
					aborted: toolUseContext.abortController.signal.aborted,
					messages: messagesForQuery,
					cacheSafeParams: {
						systemPrompt,
						userContext,
						systemContext,
						toolUseContext,
						forkContextMessages: messagesForQuery,
					},
				});

				if (compacted) {
					// task_budget: same carryover as the proactive path above.
					// messagesForQuery still holds the pre-compact array here (the
					// 413-failed attempt's input).
					if (params.taskBudget) {
						const preCompactContext =
							finalContextTokensFromLastResponse(messagesForQuery);
						taskBudgetRemaining = Math.max(
							0,
							(taskBudgetRemaining ?? params.taskBudget.total) -
								preCompactContext,
						);
					}

					const postCompactMessages = buildPostCompactMessages(compacted);
					for (const msg of postCompactMessages) {
						yield msg;
					}
					// Reset goalRuntime accounting.turn to prevent negative tokenDelta after compact
					resetGoalRuntimeAfterCompact(
						toolUseContext.setAppState,
						compacted.compactionUsage,
					);
					const next: State = {
						messages: postCompactMessages,
						toolUseContext,
						autoCompactTracking: undefined,
						maxOutputTokensRecoveryCount,
						hasAttemptedReactiveCompact: true,
						maxOutputTokensOverride: undefined,
						pendingToolUseSummary: undefined,
						stopHookActive: undefined,
						turnCount,
						transition: { reason: "reactive_compact_retry" },
					};
					state = next;
					continue;
				}

				// No recovery — surface the withheld error and exit. Do NOT fall
				// through to stop hooks: the model never produced a valid response,
				// so hooks have nothing meaningful to evaluate. Running stop hooks
				// on prompt-too-long creates a death spiral: error → hook blocking
				// → retry → error → … (the hook injects more tokens each cycle).
				yield lastMessage;
				void executeStopFailureHooks(lastMessage, toolUseContext);
				return { reason: isWithheldMedia ? "image_error" : "prompt_too_long" };
			} else if (feature("CONTEXT_COLLAPSE") && isWithheld413) {
				// reactiveCompact compiled out but contextCollapse withheld and
				// couldn't recover (staged queue empty/stale). Surface. Same
				// early-return rationale — don't fall through to stop hooks.
				yield lastMessage;
				void executeStopFailureHooks(lastMessage, toolUseContext);
				return { reason: "prompt_too_long" };
			}

			// Check for max_output_tokens and inject recovery message. The error
			// was withheld from the stream above; only surface it if recovery
			// exhausts.
			if (isWithheldMaxOutputTokens(lastMessage)) {
				// Escalating retry: if we used the capped 8k default and hit the
				// limit, retry the SAME request at 64k — no meta message, no
				// multi-turn dance. This fires once per turn (guarded by the
				// override check), then falls through to multi-turn recovery if
				// 64k also hits the cap.
				// 3P default: false (not validated on Bedrock/Vertex)
				const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
					"tengu_otk_slot_v1",
					false,
				);
				if (
					capEnabled &&
					maxOutputTokensOverride === undefined &&
					!process.env.OLA_CC_MAX_OUTPUT_TOKENS
				) {
					logEvent("tengu_max_tokens_escalate", {
						escalatedTo: ESCALATED_MAX_TOKENS,
					});
					const next: State = {
						messages: messagesForQuery,
						toolUseContext,
						autoCompactTracking: tracking,
						maxOutputTokensRecoveryCount,
						hasAttemptedReactiveCompact,
						maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
						pendingToolUseSummary: undefined,
						stopHookActive: undefined,
						turnCount,
						transition: { reason: "max_output_tokens_escalate" },
					};
					state = next;
					continue;
				}

				if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
					const recoveryMessage = createUserMessage({
						content:
							`Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
							`Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
						isMeta: true,
					});

					const next: State = {
						messages: [
							...messagesForQuery,
							...assistantMessages,
							recoveryMessage,
						],
						toolUseContext,
						autoCompactTracking: tracking,
						maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
						hasAttemptedReactiveCompact,
						maxOutputTokensOverride: undefined,
						pendingToolUseSummary: undefined,
						stopHookActive: undefined,
						turnCount,
						transition: {
							reason: "max_output_tokens_recovery",
							attempt: maxOutputTokensRecoveryCount + 1,
						},
					};
					state = next;
					continue;
				}

				// Recovery exhausted — surface the withheld error now.
				yield lastMessage;
			}

			// Skip stop hooks when the last message is an API error (rate limit,
			// prompt-too-long, auth failure, etc.). The model never produced a
			// real response — hooks evaluating it create a death spiral:
			// error → hook blocking → retry → error → …
			if (lastMessage?.isApiErrorMessage) {
				logForDebugging?.(
					`[QUERY LOOP] exit: API error message, reason=completed`,
				);
				void executeStopFailureHooks(lastMessage, toolUseContext);
				return { reason: "completed" };
			}

			logForDebugging?.(
				`[QUERY LOOP] entering stop hooks: assistantMessages=${assistantMessages.length}`,
			);
			const stopHookResult = yield* handleStopHooks(
				messagesForQuery,
				assistantMessages,
				systemPrompt,
				userContext,
				systemContext,
				toolUseContext,
				querySource,
				stopHookActive,
			);

			if (stopHookResult.preventContinuation) {
				logForDebugging?.(`[QUERY LOOP] exit: stop_hook_prevented`);
				return { reason: "stop_hook_prevented" };
			}

			if (stopHookResult.blockingErrors.length > 0) {
				const next: State = {
					messages: [
						...messagesForQuery,
						...assistantMessages,
						...stopHookResult.blockingErrors,
					],
					toolUseContext,
					autoCompactTracking: tracking,
					maxOutputTokensRecoveryCount: 0,
					// Preserve the reactive compact guard — if compact already ran and
					// couldn't recover from prompt-too-long, retrying after a stop-hook
					// blocking error will produce the same result. Resetting to false
					// here caused an infinite loop: compact → still too long → error →
					// stop hook blocking → compact → … burning thousands of API calls.
					hasAttemptedReactiveCompact,
					maxOutputTokensOverride: undefined,
					pendingToolUseSummary: undefined,
					stopHookActive: true,
					turnCount,
					transition: { reason: "stop_hook_blocking" },
				};
				state = next;
				continue;
			}

			if (feature("TOKEN_BUDGET")) {
				const decision = checkTokenBudget(
					budgetTracker!,
					toolUseContext.agentId,
					getCurrentTurnTokenBudget(),
					getTurnOutputTokens(),
				);

				if (decision.action === "continue") {
					incrementBudgetContinuationCount();
					logForDebugging(
						`Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
					);
					state = {
						messages: [
							...messagesForQuery,
							...assistantMessages,
							createUserMessage({
								content: decision.nudgeMessage,
								isMeta: true,
							}),
						],
						toolUseContext,
						autoCompactTracking: tracking,
						maxOutputTokensRecoveryCount: 0,
						hasAttemptedReactiveCompact: false,
						maxOutputTokensOverride: undefined,
						pendingToolUseSummary: undefined,
						stopHookActive: undefined,
						turnCount,
						transition: { reason: "token_budget_continuation" },
					};
					continue;
				}

				if (decision.completionEvent) {
					if (decision.completionEvent.diminishingReturns) {
						logForDebugging(
							`Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
						);
					}
					logEvent("tengu_token_budget_completed", {
						...decision.completionEvent,
						queryChainId: queryChainIdForAnalytics,
						queryDepth: queryTracking.depth,
					});
				}
			}

			// Goal auto-continue: even without tool calls, if goal is active, continue with continuation prompt
			// However, if the model's last response is asking a question (e.g., "这个方案对吗？"),
			// we should yield to the REPL and wait for natural user input instead of auto-continuing.
			const lastAssistantMsg = assistantMessages.at(-1);
			const lastAssistantText = lastAssistantMsg?.message.content
				.filter((block) => block.type === "text")
				.map((block) => ("text" in block ? block.text : ""))
				.filter(Boolean)
				.join("")
				.trim();
			const isAskingQuestion =
				lastAssistantText &&
				(lastAssistantText.endsWith("?") ||
					lastAssistantText.endsWith("？") ||
					/确认后/.test(lastAssistantText) ||
					/请确认/.test(lastAssistantText) ||
					/对吗/.test(lastAssistantText) ||
					/是否正确/.test(lastAssistantText) ||
					/请(选择|挑选|决定)/.test(lastAssistantText) ||
					/推荐哪/.test(lastAssistantText) ||
					/建议如何/.test(lastAssistantText) ||
					/请选择/.test(lastAssistantText) ||
					/which\s+(one|option|do\s+you)/i.test(lastAssistantText) ||
					/would\s+you\s+(prefer|like)/i.test(lastAssistantText) ||
					/your\s+(preference|choice)/i.test(lastAssistantText) ||
					/let\s+me\s+know\s+(which|if)/i.test(lastAssistantText) ||
					/how\s+would\s+you\s+like/i.test(lastAssistantText) ||
					/请告诉我你的选择/.test(lastAssistantText) ||
					/你(更|想|希望)/.test(lastAssistantText));

			const goalCheckState = toolUseContext.getAppState();
			if (
				!isAskingQuestion &&
				goalCheckState.goal?.id &&
				goalCheckState.goal?.status === ThreadGoalStatus.Active
			) {
				const noToolGoalResult = finishTurnForGoal(
					goalCheckState.goal,
					goalCheckState.goalRuntime,
					currentTokenUsage,
					{
						onInjectPrompt: (prompt: string) => {
							pendingGoalPrompt = prompt;
						},
						onUpdateGoal: (updatedGoal: Goal) => {
							toolUseContext.setAppState((prev) => ({
								...prev,
								goal: updatedGoal,
							}));
						},
						getTodos: (listId: string) => goalCheckState.todos?.[listId],
						updateTodos: (listId: string, todos) => {
							toolUseContext.setAppState((prev) => ({
								...prev,
								todos: { ...prev.todos, [listId]: todos },
							}));
						},
						getGoalTasks: (listId: string) => goalCheckState.goalTasks?.[listId],
						updateGoalTasks: (listId: string, tasks) => {
							toolUseContext.setAppState((prev) => ({
								...prev,
								goalTasks: { ...prev.goalTasks, [listId]: tasks },
							}));
						},
						outputSummary: currentOutputSummary,
					},
				);

				if (noToolGoalResult.injectedPrompt) {
					pendingGoalPrompt = noToolGoalResult.injectedPrompt;
					// Goal wants to continue - skip tool execution and go straight to next turn
					// No tool results to add since needsFollowUp was false
					const nextTurnCount = turnCount + 1;
					if (maxTurns && nextTurnCount > maxTurns) {
						yield createAttachmentMessage({
							type: "max_turns_reached",
							maxTurns,
							turnCount: nextTurnCount,
						});
						return { reason: "max_turns", turnCount: nextTurnCount };
					}
					logForDebugging(
						`[QUERY LOOP] goal auto-continue (no tools): messages=${messagesForQuery.length + assistantMessages.length}, turnCount=${nextTurnCount}`,
					);
					state = {
						messages: [...messagesForQuery, ...assistantMessages],
						toolUseContext,
						autoCompactTracking: tracking,
						turnCount: nextTurnCount,
						maxOutputTokensRecoveryCount: 0,
						hasAttemptedReactiveCompact,
						pendingToolUseSummary: undefined,
						maxOutputTokensOverride: undefined,
						stopHookActive: undefined,
						transition: { reason: "goal_auto_continue" },
					};
					continue;
				}
			}
			return { reason: "completed" };
		}

		let shouldPreventContinuation = false;
		let updatedToolUseContext = toolUseContext;

		queryCheckpoint("query_tool_execution_start");

		if (streamingToolExecutor) {
			logEvent("tengu_streaming_tool_execution_used", {
				tool_count: toolUseBlocks.length,
				queryChainId: queryChainIdForAnalytics,
				queryDepth: queryTracking.depth,
			});
		} else {
			logEvent("tengu_streaming_tool_execution_not_used", {
				tool_count: toolUseBlocks.length,
				queryChainId: queryChainIdForAnalytics,
				queryDepth: queryTracking.depth,
			});
		}

		const toolUpdates = streamingToolExecutor
			? streamingToolExecutor.getRemainingResults()
			: runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext);

		for await (const update of toolUpdates) {
			if (update.message) {
				yield update.message;

				if (
					update.message.type === "attachment" &&
					update.message.attachment.type === "hook_stopped_continuation"
				) {
					shouldPreventContinuation = true;
				}

				toolResults.push(
					...normalizeMessagesForAPI(
						[update.message],
						toolUseContext.options.tools,
					).filter((_) => _.type === "user"),
				);
			}
			if (update.newContext) {
				updatedToolUseContext = {
					...update.newContext,
					queryTracking,
				};
			}
		}
		queryCheckpoint("query_tool_execution_end");

		// Dispatch tool_completed events for goal runtime tracking
		if (toolUseBlocks.length > 0 && toolUseContext.getAppState().goal?.id) {
			const appState = toolUseContext.getAppState();
			for (const toolUse of toolUseBlocks) {
				processGoalRuntimeEvent(
					{ type: "tool_completed", toolName: toolUse.name },
					{
						goal: appState.goal!,
						runtime: appState.goalRuntime!,
						currentTokenUsage: {
							inputTokens: 0,
							cachedInputTokens: 0,
							outputTokens: 0,
							reasoningOutputTokens: 0,
							totalTokens: 0,
						},
						injectPrompt: async () => {},
						updateGoal: (updatedGoal: Goal) => {
							toolUseContext.setAppState((prev) => ({
								...prev,
								goal: updatedGoal,
							}));
						},
						getTodos: () => {
							const todoListId = appState.goal?.todoListId;
							if (!todoListId) return undefined;
							return appState.todos?.[todoListId];
						},
						updateTodos: (todos) => {
							const todoListId = appState.goal?.todoListId;
							if (!todoListId) return;
							toolUseContext.setAppState((prev) => ({
								...prev,
								todos: { ...prev.todos, [todoListId]: todos },
							}));
						},
						getGoalTasks: () => {
							const goalTaskListId = (appState.goal as any)?.goalTaskListId;
							if (!goalTaskListId) return undefined;
							return appState.goalTasks?.[goalTaskListId];
						},
						updateGoalTasks: (tasks) => {
							const goalTaskListId = (appState.goal as any)?.goalTaskListId;
							if (!goalTaskListId) return;
							toolUseContext.setAppState((prev) => ({
								...prev,
								goalTasks: { ...prev.goalTasks, [goalTaskListId]: tasks },
							}));
						},
					},
				);
			}
		}

		// Duplicate tool call detection: compare current turn's tool calls with
		// previous turn's. If identical (same tools + same params) for 2+ consecutive
		// turns, inject a strategy-change prompt to break the loop.
		if (toolUseBlocks.length > 0) {
			const currentSignatures: ToolCallSignature[] = toolUseBlocks.map((tu) => ({
				toolName: tu.name,
				inputHash: stableStringify(tu.input ?? {}),
			}));
			if (_prevTurnToolSignatures !== null) {
				const signaturesMatch =
					currentSignatures.length === _prevTurnToolSignatures.length &&
					currentSignatures.every(
						(sig, i) =>
							sig.toolName === _prevTurnToolSignatures![i].toolName &&
							sig.inputHash === _prevTurnToolSignatures![i].inputHash,
					);
				if (signaturesMatch) {
					_consecutiveDuplicateTurns++;
				} else {
					_consecutiveDuplicateTurns = 0;
				}
			}
			_prevTurnToolSignatures = currentSignatures;
		}

		logForDebugging?.(
			`[QUERY LOOP] tool execution complete: toolResults=${toolResults.length}, shouldPreventContinuation=${shouldPreventContinuation}, aborted=${toolUseContext.abortController.signal.aborted}`,
		);

		// Generate tool use summary after tool batch completes — passed to next recursive call
		let nextPendingToolUseSummary:
			| Promise<ToolUseSummaryMessage | null>
			| undefined;
		if (
			config.gates.emitToolUseSummaries &&
			toolUseBlocks.length > 0 &&
			!toolUseContext.abortController.signal.aborted &&
			!toolUseContext.agentId // subagents don't surface in mobile UI — skip the Haiku call
		) {
			// Extract the last assistant text block for context
			const lastAssistantMessage = assistantMessages.at(-1);
			let lastAssistantText: string | undefined;
			if (lastAssistantMessage) {
				const textBlocks = lastAssistantMessage.message.content.filter(
					(block) => block.type === "text",
				);
				if (textBlocks.length > 0) {
					const lastTextBlock = textBlocks.at(-1);
					if (lastTextBlock && "text" in lastTextBlock) {
						lastAssistantText = lastTextBlock.text;
					}
				}
			}

			// Collect tool info for summary generation
			const toolUseIds = toolUseBlocks.map((block) => block.id);
			const toolInfoForSummary = toolUseBlocks.map((block) => {
				// Find the corresponding tool result
				const toolResult = toolResults.find(
					(result) =>
						result.type === "user" &&
						Array.isArray(result.message.content) &&
						result.message.content.some(
							(content) =>
								content.type === "tool_result" &&
								content.tool_use_id === block.id,
						),
				);
				const resultContent =
					toolResult?.type === "user" &&
					Array.isArray(toolResult.message.content)
						? toolResult.message.content.find(
								(c): c is ToolResultBlockParam =>
									c.type === "tool_result" && c.tool_use_id === block.id,
							)
						: undefined;
				return {
					name: block.name,
					input: block.input,
					output:
						resultContent && "content" in resultContent
							? resultContent.content
							: null,
				};
			});

			// Fire off summary generation without blocking the next API call
			nextPendingToolUseSummary = generateToolUseSummary({
				tools: toolInfoForSummary,
				signal: toolUseContext.abortController.signal,
				isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
				lastAssistantText,
			})
				.then((summary) => {
					if (summary) {
						return createToolUseSummaryMessage(summary, toolUseIds);
					}
					return null;
				})
				.catch(() => null);
		}

		// We were aborted during tool calls
		if (toolUseContext.abortController.signal.aborted) {
			// chicago MCP: auto-unhide + lock release when aborted mid-tool-call.
			// This is the most likely Ctrl+C path for CU (e.g. slow screenshot).
			// Main thread only — see stopHooks.ts for the subagent rationale.
			if (feature("CHICAGO_MCP") && !toolUseContext.agentId) {
				try {
					const { cleanupComputerUseAfterTurn } = await import(
						"./utils/computerUse/cleanup.js"
					);
					await cleanupComputerUseAfterTurn(toolUseContext);
				} catch {
					// Failures are silent — this is dogfooding cleanup, not critical path
				}
			}
			// Skip the interruption message for submit-interrupts — the queued
			// user message that follows provides sufficient context.
			if (toolUseContext.abortController.signal.reason !== "interrupt") {
				yield createUserInterruptionMessage({
					toolUse: true,
				});
			}
			// Check maxTurns before returning when aborted
			const nextTurnCountOnAbort = turnCount + 1;
			if (maxTurns && nextTurnCountOnAbort > maxTurns) {
				yield createAttachmentMessage({
					type: "max_turns_reached",
					maxTurns,
					turnCount: nextTurnCountOnAbort,
				});
			}
			return { reason: "aborted_tools" };
		}

		// If a hook indicated to prevent continuation, stop here
		if (shouldPreventContinuation) {
			return { reason: "hook_stopped" };
		}

		if (tracking?.compacted) {
			tracking.turnCounter++;
			logEvent("tengu_post_autocompact_turn", {
				turnId:
					tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
				turnCounter: tracking.turnCounter,

				queryChainId: queryChainIdForAnalytics,
				queryDepth: queryTracking.depth,
			});
		}

		// Be careful to do this after tool calls are done, because the API
		// will error if we interleave tool_result messages with regular user messages.

		// Instrumentation: Track message count before attachments
		logEvent("tengu_query_before_attachments", {
			messagesForQueryCount: messagesForQuery.length,
			assistantMessagesCount: assistantMessages.length,
			toolResultsCount: toolResults.length,
			queryChainId: queryChainIdForAnalytics,
			queryDepth: queryTracking.depth,
		});

		// Get queued commands snapshot before processing attachments.
		// These will be sent as attachments so Claude can respond to them in the current turn.
		//
		// Drain pending notifications. LocalShellTask completions are 'next'
		// (when MONITOR_TOOL is on) and drain without Sleep. Other task types
		// (agent/workflow/framework) still default to 'later' — the Sleep flush
		// covers those. If all task types move to 'next', this branch could go.
		//
		// Slash commands are excluded from mid-turn drain — they must go through
		// processSlashCommand after the turn ends (via useQueueProcessor), not be
		// sent to the model as text. Bash-mode commands are already excluded by
		// INLINE_NOTIFICATION_MODES in getQueuedCommandAttachments.
		//
		// Agent scoping: the queue is a process-global singleton shared by the
		// coordinator and all in-process subagents. Each loop drains only what's
		// addressed to it — main thread drains agentId===undefined, subagents
		// drain their own agentId. User prompts (mode:'prompt') still go to main
		// only; subagents never see the prompt stream.
		// eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
		const sleepRan = toolUseBlocks.some((b) => b.name === SLEEP_TOOL_NAME);
		const isMainThread =
			querySource.startsWith("repl_main_thread") || querySource === "sdk";
		const currentAgentId = toolUseContext.agentId;
		const queuedCommandsSnapshot = getCommandsByMaxPriority(
			sleepRan ? "later" : "next",
		).filter((cmd) => {
			if (isSlashCommand(cmd)) return false;
			if (isMainThread) return cmd.agentId === undefined;
			// Subagents only drain task-notifications addressed to them — never
			// user prompts, even if someone stamps an agentId on one.
			return cmd.mode === "task-notification" && cmd.agentId === currentAgentId;
		});

		for await (const attachment of getAttachmentMessages(
			null,
			updatedToolUseContext,
			null,
			queuedCommandsSnapshot,
			[...messagesForQuery, ...assistantMessages, ...toolResults],
			querySource,
		)) {
			yield attachment;
			toolResults.push(attachment);
		}

		// Memory prefetch consume: only if settled and not already consumed on
		// an earlier iteration. If not settled yet, skip (zero-wait) and retry
		// next iteration — the prefetch gets as many chances as there are loop
		// iterations before the turn ends. readFileState (cumulative across
		// iterations) filters out memories the model already Read/Wrote/Edited
		// — including in earlier iterations, which the per-iteration
		// toolUseBlocks array would miss.
		if (
			pendingMemoryPrefetch &&
			pendingMemoryPrefetch.settledAt !== null &&
			pendingMemoryPrefetch.consumedOnIteration === -1
		) {
			const memoryAttachments = filterDuplicateMemoryAttachments(
				await pendingMemoryPrefetch.promise,
				toolUseContext.readFileState,
			);
			for (const memAttachment of memoryAttachments) {
				const msg = createAttachmentMessage(memAttachment);
				yield msg;
				toolResults.push(msg);
			}
			pendingMemoryPrefetch.consumedOnIteration = turnCount - 1;
		}

		// Inject prefetched skill discovery. collectSkillDiscoveryPrefetch emits
		// hidden_by_main_turn — true when the prefetch resolved before this point
		// (should be >98% at AKI@250ms / Haiku@573ms vs turn durations of 2-30s).
		if (skillPrefetch && pendingSkillPrefetch) {
			const skillAttachments =
				await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch);
			for (const att of skillAttachments) {
				const msg = createAttachmentMessage(att);
				yield msg;
				toolResults.push(msg);
			}
		}

		// Remove only commands that were actually consumed as attachments.
		// Prompt and task-notification commands are converted to attachments above.
		const consumedCommands = queuedCommandsSnapshot.filter(
			(cmd) => cmd.mode === "prompt" || cmd.mode === "task-notification",
		);
		if (consumedCommands.length > 0) {
			for (const cmd of consumedCommands) {
				if (cmd.uuid) {
					consumedCommandUuids.push(cmd.uuid);
					notifyCommandLifecycle(cmd.uuid, "started");
				}
			}
			removeFromQueue(consumedCommands);
		}

		// Instrumentation: Track file change attachments after they're added
		const fileChangeAttachmentCount = count(
			toolResults,
			(tr) =>
				tr.type === "attachment" && tr.attachment.type === "edited_text_file",
		);

		logEvent("tengu_query_after_attachments", {
			totalToolResultsCount: toolResults.length,
			fileChangeAttachmentCount,
			queryChainId: queryChainIdForAnalytics,
			queryDepth: queryTracking.depth,
		});

		// Refresh tools between turns so newly-connected MCP servers become available
		if (updatedToolUseContext.options.refreshTools) {
			const refreshedTools = updatedToolUseContext.options.refreshTools();
			if (refreshedTools !== updatedToolUseContext.options.tools) {
				updatedToolUseContext = {
					...updatedToolUseContext,
					options: {
						...updatedToolUseContext.options,
						tools: refreshedTools,
					},
				};
			}
		}

		const toolUseContextWithQueryTracking = {
			...updatedToolUseContext,
			queryTracking,
		};

		// Each time we have tool results and are about to recurse, that's a turn
		const nextTurnCount = turnCount + 1;

		// Periodic task summary for `claude ps` — fires mid-turn so a
		// long-running agent still refreshes what it's working on. Gated
		// only on !agentId so every top-level conversation (REPL, SDK, HFI,
		// remote) generates summaries; subagents/forks don't.
		if (feature("BG_SESSIONS")) {
			if (
				!toolUseContext.agentId &&
				taskSummaryModule!.shouldGenerateTaskSummary()
			) {
				taskSummaryModule!.maybeGenerateTaskSummary({
					systemPrompt,
					userContext,
					systemContext,
					toolUseContext,
					forkContextMessages: [
						...messagesForQuery,
						...assistantMessages,
						...toolResults,
					],
				});
			}
		}

		// Check if goal should auto-continue after turn completion
		// Skip auto-continue if the model's last response is asking a question
		const lastAssistantMsgForAuto = assistantMessages.at(-1);
		const lastAssistantTextForAuto = lastAssistantMsgForAuto?.message.content
			.filter((block) => block.type === "text")
			.map((block) => ("text" in block ? block.text : ""))
			.filter(Boolean)
			.join("")
			.trim();
		const isAskingQuestionAfterTools =
			lastAssistantTextForAuto &&
			(lastAssistantTextForAuto.endsWith("?") ||
				lastAssistantTextForAuto.endsWith("？") ||
				/确认后/.test(lastAssistantTextForAuto) ||
				/请确认/.test(lastAssistantTextForAuto) ||
				/对吗/.test(lastAssistantTextForAuto) ||
				/是否正确/.test(lastAssistantTextForAuto) ||
				/请(选择|挑选|决定)/.test(lastAssistantTextForAuto) ||
				/推荐哪/.test(lastAssistantTextForAuto) ||
				/建议如何/.test(lastAssistantTextForAuto) ||
				/请选择/.test(lastAssistantTextForAuto) ||
				/which\s+(one|option|do\s+you)/i.test(lastAssistantTextForAuto) ||
				/would\s+you\s+(prefer|like)/i.test(lastAssistantTextForAuto) ||
				/your\s+(preference|choice)/i.test(lastAssistantTextForAuto) ||
				/let\s+me\s+know\s+(which|if)/i.test(lastAssistantTextForAuto) ||
				/how\s+would\s+you\s+like/i.test(lastAssistantTextForAuto) ||
				/请告诉我你的选择/.test(lastAssistantTextForAuto) ||
				/你(更|想|希望)/.test(lastAssistantTextForAuto));

		// Duplicate tool call circuit breaker: 2+ consecutive turns with identical
		// tool calls (same tools + same params) — inject strategy-change prompt
		// and return to break the loop before goal auto-continue kicks in.
		const CONSECUTIVE_DUPLICATE_LIMIT = 2;
		if (_consecutiveDuplicateTurns >= CONSECUTIVE_DUPLICATE_LIMIT) {
			const dupTools = _prevTurnToolSignatures
				?.map((s) => s.toolName)
				.join(", ") ?? "unknown";
			const loopBreakMessage = createUserMessage({
				content: `[Loop detected] Last ${_consecutiveDuplicateTurns + 1} turns called the same tools with identical parameters: ${dupTools}. Do NOT repeat the same approach. Try a completely different strategy, or use /goal pause to stop and reconsider.`,
				isMeta: true,
			});

			// Check maxTurns before returning
			if (maxTurns && nextTurnCount > maxTurns) {
				yield createAttachmentMessage({
					type: "max_turns_reached",
					maxTurns,
					turnCount: nextTurnCount,
				});
				return { reason: "max_turns", turnCount: nextTurnCount };
			}

			// Inject the loop-break message and continue immediately,
			// skipping the fall-through state assignment below which
			// would overwrite the messages array (losing loopBreakMessage).
			const next: State = {
				messages: [
					...messagesForQuery,
					...assistantMessages,
					...toolResults,
					loopBreakMessage,
				],
				toolUseContext: toolUseContextWithQueryTracking,
				autoCompactTracking: tracking,
				turnCount: nextTurnCount,
				maxOutputTokensRecoveryCount: 0,
				hasAttemptedReactiveCompact: false,
				pendingToolUseSummary: nextPendingToolUseSummary,
				maxOutputTokensOverride: undefined,
				stopHookActive,
				transition: { reason: "duplicate_tool_call_detected" },
			};
			state = next;
			_consecutiveDuplicateTurns = 0;
			continue;
		} else if (
			!isAskingQuestionAfterTools &&
			toolUseContext.getAppState().goal?.id &&
			toolUseContext.getAppState().goal?.status === ThreadGoalStatus.Active
		) {
			const freshAppState = toolUseContext.getAppState();
			const goalResult = finishTurnForGoal(
				freshAppState.goal,
				freshAppState.goalRuntime,
				currentTokenUsage,
				{
					onInjectPrompt: (prompt: string) => {
						pendingGoalPrompt = prompt;
					},
					onUpdateGoal: (updatedGoal: Goal) => {
						toolUseContext.setAppState((prev) => ({
							...prev,
							goal: updatedGoal,
						}));
					},
					getTodos: (listId: string) => freshAppState.todos?.[listId],
					updateTodos: (listId: string, todos) => {
						toolUseContext.setAppState((prev) => ({
							...prev,
							todos: { ...prev.todos, [listId]: todos },
						}));
					},
					getGoalTasks: (listId: string) => freshAppState.goalTasks?.[listId],
					updateGoalTasks: (listId: string, tasks) => {
						toolUseContext.setAppState((prev) => ({
							...prev,
							goalTasks: { ...prev.goalTasks, [listId]: tasks },
						}));
					},
					outputSummary: currentOutputSummary,
				},
			);

			if (goalResult.injectedPrompt) {
				pendingGoalPrompt = goalResult.injectedPrompt;
			}
		}

		// Check if we've reached the max turns limit
		if (maxTurns && nextTurnCount > maxTurns) {
			yield createAttachmentMessage({
				type: "max_turns_reached",
				maxTurns,
				turnCount: nextTurnCount,
			});
			return { reason: "max_turns", turnCount: nextTurnCount };
		}

		queryCheckpoint("query_recursive_call");
		logForDebugging?.(
			`[QUERY LOOP] continuing to next turn: messages=${[...messagesForQuery, ...assistantMessages, ...toolResults].length}, turnCount=${nextTurnCount}`,
		);
		const next: State = {
			messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
			toolUseContext: toolUseContextWithQueryTracking,
			autoCompactTracking: tracking,
			turnCount: nextTurnCount,
			maxOutputTokensRecoveryCount: 0,
			hasAttemptedReactiveCompact: false,
			pendingToolUseSummary: nextPendingToolUseSummary,
			maxOutputTokensOverride: undefined,
			stopHookActive,
			transition: { reason: "next_turn" },
		};
		state = next;
	} // while (true)
}
