/**
 * Goal state batching utilities for CPU optimization.
 *
 * Collects multiple goal state changes and applies them in a single setAppState call,
 * reducing store notification storms from 4× setAppState per turn to 1×.
 */

import type { Goal, GoalRuntimeState, GoalTask } from "../commands/goal/types.js"
import type { TodoItem } from "./todo/types.js"

/**
 * Collected state changes to be applied in batch.
 */
export interface GoalStateChanges {
	goal?: Goal
	todos?: { listId: string; items: TodoItem[] }[]
	goalTasks?: { listId: string; items: GoalTask[] }[]
	goalRuntime?: GoalRuntimeState
}

/**
 * Creates a batching context for goal state updates.
 *
 * Usage:
 * ```ts
 * const batch = createGoalBatchingContext()
 *
 * // Pass batch callbacks to processGoalRuntimeEvent
 * processGoalRuntimeEvent(event, {
 *   ...otherContext,
 *   updateGoal: batch.updateGoal,
 *   updateTodos: batch.updateTodos,
 *   updateGoalTasks: batch.updateGoalTasks,
 * })
 *
 * // Apply all changes in single setAppState
 * batch.applyToStore(toolUseContext.setAppState)
 * ```
 */
export function createGoalBatchingContext() {
	const changes: GoalStateChanges = {}

	// Track if goalRuntime was mutated in-place
	let runtimeMutated = false

	const hasChanges = () => {
		return !!(
			changes.goal ||
			(changes.todos && changes.todos.length > 0) ||
			(changes.goalTasks && changes.goalTasks.length > 0) ||
			runtimeMutated
		)
	}

	const applyToStore = (setAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void): boolean => {
		if (!hasChanges()) {
			return false
		}

		setAppState((prev) => {
			const newState = { ...prev }

			// Apply goal update
			if (changes.goal) {
				newState.goal = changes.goal
			}

			// Apply todos updates (merge into existing todos)
			if (changes.todos && changes.todos.length > 0) {
				const prevTodos = (prev.todos as Record<string, TodoItem[]>) ?? {}
				const newTodos = { ...prevTodos }
				for (const { listId, items } of changes.todos) {
					newTodos[listId] = items
				}
				newState.todos = newTodos
			}

			// Apply goalTasks updates (merge into existing goalTasks)
			if (changes.goalTasks && changes.goalTasks.length > 0) {
				const prevGoalTasks = (prev.goalTasks as Record<string, GoalTask[]>) ?? {}
				const newGoalTasks = { ...prevGoalTasks }
				for (const { listId, items } of changes.goalTasks) {
					newGoalTasks[listId] = items
				}
				newState.goalTasks = newGoalTasks
			}

			// Apply goalRuntime sync
			if (runtimeMutated && changes.goalRuntime) {
				newState.goalRuntime = changes.goalRuntime
			}

			return newState
		})

		return true
	}

	return {
		/**
		 * Collect goal update. Replaces previous goal if any.
		 */
		updateGoal: (goal: Goal) => {
			changes.goal = goal
		},

		/**
		 * Collect todos update. Multiple updates to same listId are merged (last wins).
		 */
		updateTodos: (listId: string, items: TodoItem[]) => {
			if (!changes.todos) changes.todos = []
			const existing = changes.todos.findIndex((t) => t.listId === listId)
			if (existing >= 0) {
				changes.todos[existing] = { listId, items }
			} else {
				changes.todos.push({ listId, items })
			}
		},

		/**
		 * Collect goalTasks update. Multiple updates to same listId are merged (last wins).
		 */
		updateGoalTasks: (listId: string, items: GoalTask[]) => {
			if (!changes.goalTasks) changes.goalTasks = []
			const existing = changes.goalTasks.findIndex((t) => t.listId === listId)
			if (existing >= 0) {
				changes.goalTasks[existing] = { listId, items }
			} else {
				changes.goalTasks.push({ listId, items })
			}
		},

		/**
		 * Mark goalRuntime as mutated (needs sync to store).
		 * Call this after processGoalRuntimeEvent when runtime was mutated in-place.
		 */
		markRuntimeMutated: (runtime: GoalRuntimeState) => {
			changes.goalRuntime = runtime
			runtimeMutated = true
		},

		/**
		 * Check if there are any pending changes.
		 */
		hasChanges,

		/**
		 * Apply all collected changes to store in single setAppState call.
		 * Returns true if changes were applied.
		 */
		applyToStore,

		/**
		 * Get collected changes (for testing/debugging).
		 */
		getChanges: () => ({ ...changes }),
	}
}
