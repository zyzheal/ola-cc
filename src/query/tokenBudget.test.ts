import { describe, it, expect } from 'bun:test'
import {
  createBudgetTracker,
  checkTokenBudget,
  type BudgetTracker,
} from './tokenBudget.js'

// ─── BudgetTracker Creation ─────────────────────────────────────────────────

describe('createBudgetTracker', () => {
  it('initializes with zero counts', () => {
    const tracker = createBudgetTracker()
    expect(tracker.continuationCount).toBe(0)
    expect(tracker.lastDeltaTokens).toBe(0)
    expect(tracker.lastGlobalTurnTokens).toBe(0)
    expect(tracker.startedAt).toBeDefined()
  })
})

// ─── Token Budget Checking ──────────────────────────────────────────────────

describe('checkTokenBudget', () => {
  describe('stop conditions', () => {
    it('stops when agentId is set (subagent scenario)', () => {
      const tracker = createBudgetTracker()
      const result = checkTokenBudget(tracker, 'agent-123', 1000, 500)
      expect(result.action).toBe('stop')
      expect(result.completionEvent).toBeNull()
    })

    it('stops when budget is null', () => {
      const tracker = createBudgetTracker()
      const result = checkTokenBudget(tracker, undefined, null, 500)
      expect(result.action).toBe('stop')
      expect(result.completionEvent).toBeNull()
    })

    it('stops when budget is zero or negative', () => {
      const tracker = createBudgetTracker()
      expect(checkTokenBudget(tracker, undefined, 0, 500).action).toBe('stop')
      expect(checkTokenBudget(tracker, undefined, -100, 500).action).toBe('stop')
    })

    it('stops when usage is above 90% threshold', () => {
      const tracker = createBudgetTracker()
      // 950 / 1000 = 95% > 90%
      const result = checkTokenBudget(tracker, undefined, 1000, 950)
      expect(result.action).toBe('stop')
    })

    it('stops when diminishing returns detected', () => {
      const tracker: BudgetTracker = {
        continuationCount: 3,
        lastDeltaTokens: 100,
        lastGlobalTurnTokens: 600,
        startedAt: Date.now() - 5000,
      }
      // 400 token increase but delta is small (diminishing)
      const result = checkTokenBudget(tracker, undefined, 1000, 1000)
      expect(result.action).toBe('stop')
      expect(result.completionEvent).not.toBeNull()
      expect(result.completionEvent!.diminishingReturns).toBe(true)
    })
  })

  describe('continue conditions', () => {
    it('continues when under 90% threshold', () => {
      const tracker = createBudgetTracker()
      // 500 / 1000 = 50% < 90%
      const result = checkTokenBudget(tracker, undefined, 1000, 500)
      expect(result.action).toBe('continue')
      expect(result.pct).toBe(50)
      expect(result.continuationCount).toBe(1)
      expect(result.nudgeMessage).toContain('50%')
    })

    it('continues with correct percentage calculation', () => {
      const tracker = createBudgetTracker()
      const result = checkTokenBudget(tracker, undefined, 2000, 1200)
      expect(result.action).toBe('continue')
      expect(result.pct).toBe(60)
    })

    it('increments continuation count on consecutive checks', () => {
      const tracker = createBudgetTracker()
      checkTokenBudget(tracker, undefined, 1000, 400)
      expect(tracker.continuationCount).toBe(1)

      checkTokenBudget(tracker, undefined, 1000, 500)
      expect(tracker.continuationCount).toBe(2)

      checkTokenBudget(tracker, undefined, 1000, 600)
      expect(tracker.continuationCount).toBe(3)
    })

    it('updates tracker state on continue', () => {
      const tracker = createBudgetTracker()
      checkTokenBudget(tracker, undefined, 1000, 500)
      expect(tracker.lastGlobalTurnTokens).toBe(500)
      expect(tracker.lastDeltaTokens).toBe(500)
    })
  })

  describe('stop after continuation', () => {
    it('stops with completion event after continuations', () => {
      const tracker = createBudgetTracker()
      // First: continue (50%)
      checkTokenBudget(tracker, undefined, 1000, 500)
      // Second: continue (60%)
      checkTokenBudget(tracker, undefined, 1000, 600)
      // Third: now above 90% should stop
      const result = checkTokenBudget(tracker, undefined, 1000, 950)
      expect(result.action).toBe('stop')
      expect(result.completionEvent).not.toBeNull()
      expect(result.completionEvent!.continuationCount).toBe(2)
      expect(result.completionEvent!.diminishingReturns).toBe(false)
    })

    it('includes duration in completion event', () => {
      const tracker: BudgetTracker = {
        continuationCount: 2,
        lastDeltaTokens: 200,
        lastGlobalTurnTokens: 600,
        startedAt: Date.now() - 10000,
      }
      const result = checkTokenBudget(tracker, undefined, 1000, 950)
      expect(result.action).toBe('stop')
      expect(result.completionEvent!.durationMs).toBeGreaterThanOrEqual(10000)
    })
  })
})
