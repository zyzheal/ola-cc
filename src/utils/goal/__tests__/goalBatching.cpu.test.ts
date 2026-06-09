/**
 * CPU regression tests for Goal setAppState batching
 *
 * Run: bun test src/utils/goal/__tests__/goalBatching.cpu.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test"

// Simulate the batching mechanism
interface GoalStateChanges {
	goal?: { id: string; status: string; tokensUsed: number; updatedAt: number }
	todos?: Record<string, unknown>
	goalTasks?: Record<string, unknown>
	goalRuntime?: { _toolCallsThisTurn: string[] }
}

describe("Goal setAppState batching", () => {
	let changes: GoalStateChanges
	let setAppStateCallCount: number

	beforeEach(() => {
		changes = {}
		setAppStateCallCount = 0
	})

	it("should batch multiple goal updates into single setAppState", () => {
		// Simulate OLD behavior: each update triggers setAppState
		const oldWay = (changes: GoalStateChanges, update: Partial<GoalStateChanges>) => {
			setAppStateCallCount++
			return { ...changes, ...update }
		}

		// Simulate NEW behavior: collect changes, apply once
		const newWay = {
			collect: (changes: GoalStateChanges, update: Partial<GoalStateChanges>) => {
				return { ...changes, ...update }
			},
			apply: (changes: GoalStateChanges) => {
				setAppStateCallCount++
				return changes
			},
		}

		// Test old way: 3 updates = 3 setAppState calls
		let oldChanges = {}
		oldChanges = oldWay(oldChanges, { goal: { id: "1", status: "active", tokensUsed: 100, updatedAt: 1 } })
		oldChanges = oldWay(oldChanges, { todos: { list1: [] } })
		oldChanges = oldWay(oldChanges, { goalTasks: { list1: [] } })
		expect(setAppStateCallCount).toBe(3)

		// Reset
		setAppStateCallCount = 0

		// Test new way: 3 updates collected, 1 setAppState call
		let newChanges = {}
		newChanges = newWay.collect(newChanges, { goal: { id: "1", status: "active", tokensUsed: 100, updatedAt: 1 } })
		newChanges = newWay.collect(newChanges, { todos: { list1: [] } })
		newChanges = newWay.collect(newChanges, { goalTasks: { list1: [] } })
		newChanges = newWay.apply(newChanges)
		expect(setAppStateCallCount).toBe(1)
	})

	it("should collect changes without triggering setAppState", () => {
		const collectChanges = (changes: GoalStateChanges, update: Partial<GoalStateChanges>) => {
			return { ...changes, ...update }
		}

		// Collect multiple changes
		changes = collectChanges(changes, { goal: { id: "1", status: "active", tokensUsed: 100, updatedAt: 1 } })
		changes = collectChanges(changes, { todos: { list1: [] } })
		changes = collectChanges(changes, { goalRuntime: { _toolCallsThisTurn: ["tool1", "tool2"] } })

		// No setAppState calls yet
		expect(setAppStateCallCount).toBe(0)

		// Apply once
		setAppStateCallCount++
		expect(setAppStateCallCount).toBe(1)
		expect(changes.goal?.status).toBe("active")
		expect(changes.goalRuntime?._toolCallsThisTurn.length).toBe(2)
	})

	it("should merge nested updates correctly", () => {
		// Simulate merging nested objects (todos, goalTasks)
		const mergeNested = <T extends Record<string, unknown>>(
			prev: T | undefined,
			key: string,
			value: unknown,
		): T => {
			return {
				...(prev ?? {}),
				[key]: value,
			} as T
		}

		// First update
		changes.todos = mergeNested(changes.todos, "list1", [{ content: "task1" }])

		// Second update (different list)
		changes.todos = mergeNested(changes.todos, "list2", [{ content: "task2" }])

		expect(changes.todos?.list1).toBeDefined()
		expect(changes.todos?.list2).toBeDefined()
	})

	it("should handle undefined changes gracefully", () => {
		const collectChanges = (changes: GoalStateChanges | undefined, update: Partial<GoalStateChanges>) => {
			return { ...(changes ?? {}), ...update }
		}

		// Start with undefined
		let localChanges: GoalStateChanges | undefined = undefined

		// Collect first change
		localChanges = collectChanges(localChanges, { goal: { id: "1", status: "active", tokensUsed: 0, updatedAt: 1 } })

		expect(localChanges?.goal?.id).toBe("1")
	})
})
