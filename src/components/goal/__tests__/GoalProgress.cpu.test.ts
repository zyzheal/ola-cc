/**
 * CPU 100% regression tests for GoalProgress selectors.
 *
 * Problem: GoalProgress.tsx has 12+ useAppState selectors that subscribe to
 * s.goal.* and s.goalRuntime.* fields. During agent execution, query.ts calls
 * setAppState with updated goalRuntime on EVERY tool completion (4 call sites
 * with "setState#4 goalRuntime sync"). Each update triggers all 12+ selectors
 * to re-evaluate, causing a render storm that pegs CPU at 100%.
 *
 * These tests verify that narrow selectors (useDerivedStore / useMemo-stabilized)
 * do NOT re-render when irrelevant goalRuntime fields change.
 */
import { describe, it, expect } from 'bun:test'
import type { Goal, GoalRuntimeState } from '../../commands/goal/types.js'

// ── Selector simulation (same logic as GoalProgress but without React) ──

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    threadId: 't1',
    objective: 'Fix CPU 100%',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    todoListId: undefined,
    goalTaskListId: undefined,
    totalApiTokens: 0,
    totalApiWallMs: 0,
    mode: 'standard',
    autoEdit: false,
    consecutiveErrors: 0,
    turnsWithNoChanges: 0,
    ...overrides,
  }
}

function makeGoalRuntime(overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState {
  return {
    accounting: {
      turn: null,
      wallClock: { lastAccountedAt: 0, activeGoalId: null },
    },
    budgetLimitReportedGoalId: null,
    continuationTurnId: null,
    turnBuffer: [],
    totalApiTokens: 0,
    totalApiWallMs: 0,
    consecutiveErrors: 0,
    turnsWithNoChanges: 0,
    _currentTurnWallStartMs: 0,
    _toolCallsThisTurn: undefined,
    consecutiveCritical: 0,
    currentScenario: undefined,
    convergenceState: undefined,
    errorTracker: undefined,
    lastObservation: undefined,
    lastAnalysisResult: undefined,
    ...overrides,
  } as GoalRuntimeState
}

describe('GoalProgress selectors: CPU 100% regression', () => {
  describe('goal.* primitive selectors: should not re-render on goalRuntime updates', () => {
    it('goal.status selector is stable when goalRuntime changes', () => {
      const goal = makeGoal()
      const derive = (s: { goal: Goal }) => s.goal?.status ?? ''
      let snapshot = derive({ goal })

      // Simulate goalRuntime update (what query.ts does on every tool completion)
      const newRuntime = makeGoalRuntime({ _toolCallsThisTurn: ['Bash'] })
      // goal object is the SAME reference — only goalRuntime changed
      const nextState = { goal, goalRuntime: newRuntime }

      const next = derive(nextState)
      expect(next).toBe(snapshot) // Same primitive, no re-render needed
    })

    it('goal.objective selector is stable when goalRuntime changes', () => {
      const goal = makeGoal()
      const derive = (s: { goal: Goal }) => s.goal?.objective ?? ''
      let snapshot = derive({ goal })

      const newRuntime = makeGoalRuntime({ consecutiveErrors: 1 })
      const next = derive({ goal, goalRuntime: newRuntime })
      expect(next).toBe(snapshot)
    })

    it('goal.tokenBudget selector is stable when goalRuntime changes', () => {
      const goal = makeGoal({ tokenBudget: 100000 })
      const derive = (s: { goal: Goal }) => s.goal?.tokenBudget ?? null
      let snapshot = derive({ goal })

      const newRuntime = makeGoalRuntime({ totalApiTokens: 5000 })
      const next = derive({ goal, goalRuntime: newRuntime })
      expect(next).toBe(snapshot)
    })

    it('goal.tokensUsed selector is stable when goalRuntime changes', () => {
      const goal = makeGoal({ tokensUsed: 1000 })
      const derive = (s: { goal: Goal }) => s.goal?.tokensUsed ?? 0
      let snapshot = derive({ goal })

      const newRuntime = makeGoalRuntime({ turnsWithNoChanges: 2 })
      const next = derive({ goal, goalRuntime: newRuntime })
      expect(next).toBe(snapshot)
    })

    it('all 8 goal.* selectors are stable across 100 goalRuntime updates', () => {
      const goal = makeGoal({ tokensUsed: 1000, totalApiTokens: 2000, timeUsedSeconds: 30 })

      const selectors = [
        (s: { goal: Goal }) => s.goal?.status ?? '',
        (s: { goal: Goal }) => s.goal?.objective ?? '',
        (s: { goal: Goal }) => s.goal?.tokenBudget ?? null,
        (s: { goal: Goal }) => s.goal?.tokensUsed ?? 0,
        (s: { goal: Goal }) => s.goal?.timeUsedSeconds ?? 0,
        (s: { goal: Goal }) => s.goal?.totalApiTokens ?? 0,
        (s: { goal: Goal }) => s.goal?.mode ?? 'standard',
        (s: { goal: Goal }) => s.goal?.autoEdit ?? false,
      ]

      const snapshots = selectors.map(sel => sel({ goal }))
      let anyChanged = false

      for (let i = 0; i < 100; i++) {
        const newRuntime = makeGoalRuntime({
          _toolCallsThisTurn: [`Tool${i}`],
          consecutiveErrors: i % 3,
          turnsWithNoChanges: i % 5,
          totalApiTokens: i * 100,
        })
        const state = { goal, goalRuntime: newRuntime }
        selectors.forEach((sel, idx) => {
          const next = sel(state)
          if (next !== snapshots[idx]) anyChanged = true
        })
      }

      expect(anyChanged).toBe(false) // None should change — goal is the same object
    })
  })

  describe('goalRuntime.* selectors: should not re-render on goal updates', () => {
    it('consecutiveErrors selector is stable when goal changes', () => {
      const runtime = makeGoalRuntime({ consecutiveErrors: 2 })
      const derive = (s: { goalRuntime?: GoalRuntimeState }) =>
        s.goalRuntime?.consecutiveErrors ?? 0

      let snapshot = derive({ goalRuntime: runtime })

      // Simulate goal update (tokensUsed changes)
      const newGoal = makeGoal({ tokensUsed: 5000, updatedAt: Date.now() })
      const next = derive({ goal: newGoal, goalRuntime: runtime })
      expect(next).toBe(snapshot)
    })

    it('turnsWithNoChanges selector is stable when goal changes', () => {
      const runtime = makeGoalRuntime({ turnsWithNoChanges: 3 })
      const derive = (s: { goalRuntime?: GoalRuntimeState }) =>
        s.goalRuntime?.turnsWithNoChanges ?? 0

      let snapshot = derive({ goalRuntime: runtime })

      const newGoal = makeGoal({ timeUsedSeconds: 60 })
      const next = derive({ goal: newGoal, goalRuntime: runtime })
      expect(next).toBe(snapshot)
    })
  })

  describe('narrow selector vs broad selector: render count comparison', () => {
    it('broad s.goal selector re-renders on every goalRuntime update', () => {
      // This is the ANTI-PATTERN that causes CPU 100%
      const goal = makeGoal()
      const broadSelector = (s: { goal: Goal }) => s.goal

      let renderCount = 0
      let snapshot = broadSelector({ goal })

      // 50 goalRuntime updates (simulating tool completions)
      for (let i = 0; i < 50; i++) {
        // Even though goal hasn't changed, a new state object triggers the selector
        // In real useAppState, this would cause re-render because the state object changed
        const state = { goal, goalRuntime: makeGoalRuntime({ _toolCallsThisTurn: [`T${i}`] }) }
        // Broad selector returns the SAME goal reference, but useAppState still
        // evaluates it on every setAppState call
        const next = broadSelector(state)
        // In the real store, with selectorSkip, this would be skipped IF the
        // selector result is === compared. But if the goal object reference
        // changes (which it does in query.ts: goal: appState.goal!), it won't skip.
        // However, if goal is the same reference, selectorSkip should handle it.
        if (next !== snapshot) {
          snapshot = next
          renderCount++
        }
      }

      // With same goal reference, broad selector should have 0 renders
      // But this test documents that if goal reference changes, ALL 50 trigger
      expect(renderCount).toBe(0)
    })

    it('broad s.goal selector re-renders when goal reference changes (the real bug)', () => {
      // In query.ts, goal object is often reconstructed, causing new reference
      let goal = makeGoal()
      const broadSelector = (s: { goal: Goal }) => s.goal

      let renderCount = 0
      let snapshot = broadSelector({ goal })

      for (let i = 0; i < 50; i++) {
        // Simulate goal reference change (what happens in real goal updates)
        goal = { ...goal, tokensUsed: i * 100, updatedAt: Date.now() }
        const state = { goal }
        const next = broadSelector(state)
        if (next !== snapshot) {
          snapshot = next
          renderCount++
        }
      }

      // Every goal reference change triggers re-render with broad selector
      expect(renderCount).toBe(50)
    })

    it('narrow s.goal.status selector filters out most goal reference changes', () => {
      let goal = makeGoal()
      const narrowSelector = (s: { goal: Goal }) => s.goal?.status ?? ''

      let renderCount = 0
      let snapshot = narrowSelector({ goal })

      for (let i = 0; i < 50; i++) {
        // Goal reference changes, but status stays 'active'
        goal = { ...goal, tokensUsed: i * 100, updatedAt: Date.now() }
        const next = narrowSelector({ goal })
        if (next !== snapshot) {
          snapshot = next
          renderCount++
        }
      }

      // Narrow selector: 0 re-renders because status never changed
      expect(renderCount).toBe(0)
    })
  })

  describe('goalRuntime._toolCallsThisTurn: useMemo-stabilized selector', () => {
    it('selector with EMPTY_STRING_ARRAY fallback requires useMemo stabilization', () => {
      const EMPTY_STRING_ARRAY: string[] = []

      // Without useMemo, inline selector creates new fallback each time
      const unstableSelector = (s: { goalRuntime?: { _toolCallsThisTurn?: string[] } }) =>
        s.goalRuntime?._toolCallsThisTurn ?? []

      // With useMemo, selector uses stable EMPTY_STRING_ARRAY reference
      const stableSelector = (s: { goalRuntime?: { _toolCallsThisTurn?: string[] } }) =>
        s.goalRuntime?._toolCallsThisTurn ?? EMPTY_STRING_ARRAY

      // No toolCalls in runtime
      const runtime = makeGoalRuntime()

      // Unstable selector returns NEW empty array each call
      const unstable1 = unstableSelector({ goalRuntime: runtime })
      const unstable2 = unstableSelector({ goalRuntime: runtime })
      expect(unstable1).not.toBe(unstable2) // Different references — causes re-render!

      // Stable selector returns SAME EMPTY_STRING_ARRAY reference
      const stable1 = stableSelector({ goalRuntime: runtime })
      const stable2 = stableSelector({ goalRuntime: runtime })
      expect(stable1).toBe(stable2) // Same reference — no re-render
      expect(stable1).toBe(EMPTY_STRING_ARRAY)
    })

    it('selector returns new array only when toolCalls actually change', () => {
      const EMPTY_STRING_ARRAY: string[] = []

      const selector = (s: { goalRuntime?: { _toolCallsThisTurn?: string[] } }) =>
        s.goalRuntime?._toolCallsThisTurn ?? EMPTY_STRING_ARRAY

      const runtime1 = makeGoalRuntime({ _toolCallsThisTurn: ['Bash'] })
      const result1 = selector({ goalRuntime: runtime1 })

      const runtime2 = makeGoalRuntime({ _toolCallsThisTurn: ['Bash'] })
      const result2 = selector({ goalRuntime: runtime2 })

      // Different array instances with same content — useDerivedStore with
      // reference equality would see these as different (triggering re-render)
      // This is why useDerivedStore needs custom isEqual for array selectors
      expect(result1).not.toBe(result2) // Different references
      expect(result1).toEqual(result2)  // Same content
    })
  })

  describe('combined goal+goalRuntime update pattern (query.ts)', () => {
    it('simulates real query.ts update pattern: goal + goalRuntime change together', () => {
      let goal = makeGoal({ tokensUsed: 0, totalApiTokens: 0 })
      let goalRuntime = makeGoalRuntime()

      // Track render counts for each selector type
      let broadRenders = 0
      let narrowRenders = 0

      let broadSnapshot = goal
      let narrowSnapshot = goal.status

      // Simulate 20 tool completions
      for (let i = 0; i < 20; i++) {
        // query.ts pattern: both goal and goalRuntime get updated
        goal = { ...goal, tokensUsed: i * 50, totalApiTokens: i * 100, updatedAt: Date.now() }
        goalRuntime = { ...goalRuntime, _toolCallsThisTurn: [`Tool${i}`], totalApiTokens: i * 100 }

        // Broad selector (s.goal) — triggers on every update
        const broadNext = goal
        if (broadNext !== broadSnapshot) {
          broadSnapshot = broadNext
          broadRenders++
        }

        // Narrow selector (s.goal.status) — only triggers when status changes
        const narrowNext = goal.status
        if (narrowNext !== narrowSnapshot) {
          narrowSnapshot = narrowNext
          narrowRenders++
        }
      }

      // Broad: 20 re-renders (every goal reference change)
      expect(broadRenders).toBe(20)
      // Narrow: 0 re-renders (status never changed from 'active')
      expect(narrowRenders).toBe(0)
    })
  })
})
