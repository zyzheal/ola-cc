import { z } from "zod/v4";
import type { Goal, TokenUsage } from "../../commands/goal/types.js";
import { buildTool, type ToolDef } from "../../Tool.js";
import { processGoalRuntimeEvent } from "../../utils/goal/goalRuntime.js";
import { lazySchema } from "../../utils/lazySchema.js";
import {
	renderToolResultMessage,
	renderToolUseMessage,
	renderToolUseRejectedMessage,
} from "./UI.js";

const UPDATE_GOAL_TOOL_NAME = "update_goal";

const inputSchema = lazySchema(() =>
	z.strictObject({
		status: z
			.enum(["active", "paused", "complete"])
			.describe("The new status for the goal"),
		summary: z
			.string()
			.optional()
			.describe("Optional summary of progress made"),
	}),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
	z.object({
		message: z.string().describe("Confirmation message"),
	}),
);
type OutputSchema = ReturnType<typeof outputSchema>;
export type Output = z.infer<OutputSchema>;

export const UpdateGoalTool: ToolDef<InputSchema, Output> = buildTool({
	name: UPDATE_GOAL_TOOL_NAME,
	searchHint: "update goal status",
	maxResultSizeChars: 1000,
	async description() {
		return "更新当前目标的状态。完成任务或需要暂停时调用。";
	},
	get inputSchema(): InputSchema {
		return inputSchema();
	},
	get outputSchema(): OutputSchema {
		return outputSchema();
	},
	userFacingName() {
		return "更新目标";
	},
	isConcurrencySafe() {
		return true;
	},
	isReadOnly() {
		return false;
	},
	async checkPermissions(input: InputSchema) {
		return { behavior: "allow" as const, updatedInput: input };
	},
	async prompt() {
		return '更新当前目标的状态。完成任务或需要暂停时调用。使用 status="complete" 标记目标已达成。';
	},
	renderToolUseMessage,
	renderToolResultMessage,
	renderToolUseRejectedMessage,
	async call(input: InputSchema, context): Promise<{ data: Output }> {
		// Safely access context functions
		const getAppState = context?.getAppState;
		const setAppState = context?.setAppState;

		if (!getAppState || !setAppState) {
			return {
				data: { message: "错误：上下文函数不可用。" },
			};
		}

		const appState = getAppState();
		const currentGoal = appState?.goal;

		if (!currentGoal?.id) {
			return {
				data: { message: "当前未设置活跃目标，无法更新。" },
			};
		}

		// Codex-style restriction: update_goal can only mark complete or paused
		// active status is controlled by user via /goal commands
		if (input.status === "active") {
			return {
				data: {
					message:
						"update_goal 无法设置状态为 active。请使用 /goal resume 命令继续已暂停的目标。",
				},
			};
		}

		const inputStatus = input.status;

		if (inputStatus === "complete") {
			// Trigger goal completion event (Codex-style)
			const currentTokenUsage: TokenUsage = {
				inputTokens: currentGoal.tokensUsed,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: currentGoal.tokensUsed,
			};

			processGoalRuntimeEvent(
				{ type: "tool_completed_goal" },
				{
					goal: currentGoal,
					runtime: appState.goalRuntime,
					currentTokenUsage,
					injectPrompt: async () => {},
					updateGoal: (updatedGoal: Goal) => {
						setAppState((prev) => ({
							...prev,
							goal: updatedGoal,
						}));
					},
				},
			);

			// Generate completion report (matching Codex behavior)
			const updatedGoal = getAppState().goal;
			let response = `目标已完成："${updatedGoal.objective}"\n`;
			response += `用时：${updatedGoal.timeUsedSeconds}s\n`;
			if (updatedGoal.tokenBudget) {
				response += `Token 预算：${updatedGoal.tokensUsed} / ${updatedGoal.tokenBudget}\n`;
			} else {
				response += `Token 消耗：${updatedGoal.tokensUsed}\n`;
			}
			if (input.summary) {
				response += `\n摘要：${input.summary}`;
			}

			return {
				data: { message: response },
			};
		}

		// Pause: update goal status directly and stop the loop
		if (inputStatus === "paused") {
			const pausedGoal: Goal = {
				...currentGoal,
				status: "paused" as const,
				updatedAt: Date.now(),
			};
			if (input.summary) {
				pausedGoal.pauseReason = input.summary;
			}

			// Clear runtime state to stop continuation
			const runtime = appState.goalRuntime;
			if (runtime) {
				runtime.accounting.turn = null;
				runtime.pendingAnalysis = undefined;
			}

			setAppState((prev) => ({
				...prev,
				goal: pausedGoal,
			}));

			let response = `目标已暂停："${currentGoal.objective}"`;
			if (input.summary) {
				response += `\n原因：${input.summary}`;
			}
			response += `\n使用 /goal resume 继续或 /goal stop 取消。`;

			return {
				data: { message: response },
			};
		}

		return {
			data: { message: `目标状态已更新为 ${inputStatus}。` },
		};
	},
	mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
		return {
			tool_use_id: toolUseID,
			type: "tool_result" as const,
			content: data.message,
		};
	},
});

export type { InputSchema as UpdateGoalInput };
export { UPDATE_GOAL_TOOL_NAME };
