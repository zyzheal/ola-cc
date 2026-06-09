import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FrameScheduler, setFrameScheduler, getFrameScheduler, disposeFrameScheduler } from '../FrameScheduler.js'
import type { FrameMetrics, FramePhase } from '../FrameScheduler.js'

// --- Helpers ---

const DEFAULT_PHASES: FramePhase = {
  reconcile: 5,
  layout: 3,
  render: 4,
  diff: 2,
  optimize: 1,
  write: 1,
}

function makeMetrics(overrides: Partial<Omit<FrameMetrics, 'skipped'>> = {}): Omit<FrameMetrics, 'skipped'> {
  return {
    totalMs: 10,
    phases: DEFAULT_PHASES,
    commitCount: 1,
    timestamp: Date.now(),
    ...overrides,
  }
}

// --- Tests ---

describe('FrameScheduler', () => {
  let scheduler: FrameScheduler

  beforeEach(() => {
    scheduler = new FrameScheduler()
    disposeFrameScheduler()
  })

  // === 初始状态 ===

  describe('initial state', () => {
    it('should start in normal state', () => {
      expect(scheduler.getState()).toBe('normal')
    })

    it('should have 16ms interval', () => {
      expect(scheduler.getIntervalMs()).toBe(16)
    })

    it('should have zero stats', () => {
      const stats = scheduler.getStats()
      expect(stats.totalFrames).toBe(0)
      expect(stats.totalSkipped).toBe(0)
      expect(stats.avgFrameMs).toBe(0)
    })
  })

  // === 报告帧 ===

  describe('reportFrame', () => {
    it('should increment totalFrames', () => {
      scheduler.reportFrame(makeMetrics())
      expect(scheduler.getStats().totalFrames).toBe(1)
    })

    it('should track average frame time', () => {
      scheduler.reportFrame(makeMetrics({ totalMs: 10 }))
      scheduler.reportFrame(makeMetrics({ totalMs: 20 }))
      const stats = scheduler.getStats()
      expect(stats.avgFrameMs).toBe(15)
    })

    it('should notify all listeners', () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()
      scheduler.onMetrics(listener1)
      scheduler.onMetrics(listener2)

      scheduler.reportFrame(makeMetrics())

      expect(listener1).toHaveBeenCalledTimes(1)
      expect(listener2).toHaveBeenCalledTimes(1)
    })

    it('should not notify after unsubscribe', () => {
      const listener = vi.fn()
      const unsubscribe = scheduler.onMetrics(listener)

      scheduler.reportFrame(makeMetrics())
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()
      scheduler.reportFrame(makeMetrics())
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('should handle listener errors gracefully', () => {
      const badListener = vi.fn(() => { throw new Error('test') })
      const goodListener = vi.fn()
      scheduler.onMetrics(badListener)
      scheduler.onMetrics(goodListener)

      // Should not throw
      scheduler.reportFrame(makeMetrics())
      expect(goodListener).toHaveBeenCalledTimes(1)
    })
  })

  // === 自适应降频 (Q3: 迟滞防振荡) ===

  describe('adaptive throttling with hysteresis', () => {
    it('should stay normal with fast frames', () => {
      for (let i = 0; i < 100; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 8 }))
      }
      expect(scheduler.getState()).toBe('normal')
      expect(scheduler.getIntervalMs()).toBe(16)
    })

    it('should degrade to degraded after 3 slow frames', () => {
      for (let i = 0; i < 3; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 30 }))
      }
      expect(scheduler.getState()).toBe('degraded')
      expect(scheduler.getIntervalMs()).toBe(33)
    })

    it('should degrade to minimal after 13 slow frames (3 for normal→degraded + 10 for degraded→minimal)', () => {
      // State resets on transition: consecutiveSlowFrames resets to 0
      // So need SLOW_TO_DEGRADED(3) + SLOW_TO_MINIMAL(10) = 13 total
      for (let i = 0; i < 13; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 30 }))
      }
      expect(scheduler.getState()).toBe('minimal')
      expect(scheduler.getIntervalMs()).toBe(100)
    })

    it('should NOT oscillate between states (Q3 hysteresis)', () => {
      // Degrade to degraded
      for (let i = 0; i < 3; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 30 }))
      }
      expect(scheduler.getState()).toBe('degraded')

      // 1 fast frame should NOT recover
      scheduler.reportFrame(makeMetrics({ totalMs: 8 }))
      expect(scheduler.getState()).toBe('degraded')

      // Need 15 consecutive fast frames to recover from degraded
      // Already sent 1 above, need 13 more to reach 14 total (still degraded)
      for (let i = 0; i < 13; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 8 }))
      }
      expect(scheduler.getState()).toBe('degraded') // still degraded at 14 total

      // 15th fast frame should recover
      scheduler.reportFrame(makeMetrics({ totalMs: 8 }))
      expect(scheduler.getState()).toBe('normal')
    })

    it('should not skip degraded when going from normal to minimal', () => {
      // Should go normal → degraded → minimal, not normal → minimal
      for (let i = 0; i < 3; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 30 }))
      }
      expect(scheduler.getState()).toBe('degraded')

      // Need 10 more slow frames (counter resets on transition)
      for (let i = 0; i < 10; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 30 }))
      }
      expect(scheduler.getState()).toBe('minimal')
    })

    it('should require 20 fast frames to recover from minimal', () => {
      // Go to minimal (3 for normal→degraded + 10 for degraded→minimal = 13)
      for (let i = 0; i < 13; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 30 }))
      }
      expect(scheduler.getState()).toBe('minimal')

      // 15 fast frames: NOT enough for minimal→degraded (needs 20)
      for (let i = 0; i < 15; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 8 }))
      }
      expect(scheduler.getState()).toBe('minimal') // still minimal

      // 5 more (total 20): should recover to degraded
      for (let i = 0; i < 5; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 8 }))
      }
      expect(scheduler.getState()).toBe('degraded')
    })

    it('should handle stall frames (200ms+) with fast degradation', () => {
      // Single stall frame (250ms > 200ms threshold) adds 3 to slow counter
      // 3 >= SLOW_TO_DEGRADED(3), so should degrade immediately
      scheduler.reportFrame(makeMetrics({ totalMs: 250 }))
      expect(scheduler.getState()).toBe('degraded')
    })
  })

  // === shouldRender (A1) ===

  describe('shouldRender', () => {
    it('should return true on first call (no prior render)', () => {
      // lastRenderEnd = 0, so elapsed = performance.now() which is always > 16ms
      expect(scheduler.shouldRender()).toBe(true)
    })

    it('should return false when called immediately after reportFrame', () => {
      scheduler.reportFrame(makeMetrics())
      // Immediately after render — not enough time elapsed
      expect(scheduler.shouldRender()).toBe(false)
    })

    it('should return true when enough time has passed', async () => {
      scheduler.reportFrame(makeMetrics())
      // Wait real 20ms (past the 16ms interval)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(scheduler.shouldRender()).toBe(true)
    })

    it('should track skipped frames', () => {
      scheduler.reportFrame(makeMetrics())
      scheduler.shouldRender() // skipped
      scheduler.shouldRender() // skipped again

      const stats = scheduler.getStats()
      expect(stats.totalSkipped).toBe(1) // only counted once per budget cycle
    })
  })

  // === getStats (P2: 缓存) ===

  describe('getStats caching', () => {
    it('should return cached result when no new frames', () => {
      scheduler.reportFrame(makeMetrics())
      const stats1 = scheduler.getStats()
      const stats2 = scheduler.getStats()
      // Same object reference = cached
      expect(stats1).toBe(stats2)
    })

    it('should invalidate cache on new frame', () => {
      scheduler.reportFrame(makeMetrics({ totalMs: 10 }))
      const stats1 = scheduler.getStats()
      expect(stats1.avgFrameMs).toBe(10)

      scheduler.reportFrame(makeMetrics({ totalMs: 20 }))
      const stats2 = scheduler.getStats()
      expect(stats2.avgFrameMs).toBe(15) // (10+20)/2
      expect(stats2).not.toBe(stats1) // different object = recomputed
    })

    it('should compute P95 correctly', () => {
      // Add 50 frames (within ring buffer capacity of 60) with known distribution
      for (let i = 0; i < 50; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: i }))
      }
      const stats = scheduler.getStats()
      // P95 of [0,1,2,...,49]: index = floor(50*0.95) = 47, value = 47
      expect(stats.p95FrameMs).toBeGreaterThanOrEqual(46)
      expect(stats.p95FrameMs).toBeLessThanOrEqual(48)
    })
  })

  // === 环形缓冲区 (P3) ===

  describe('ring buffer (P3)', () => {
    it('should not grow beyond HISTORY_SIZE', () => {
      // Add 120 frames (2x capacity)
      for (let i = 0; i < 120; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: i }))
      }
      const stats = scheduler.getStats()
      expect(stats.totalFrames).toBe(120)

      // P95 should be from the last 60 frames (60-119)
      // P95 of [60,61,...,119] = ~117
      expect(stats.p95FrameMs).toBeGreaterThanOrEqual(115)
    })

    it('should handle overflow correctly', () => {
      // Fill exactly to capacity
      for (let i = 0; i < 60; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: i }))
      }
      const stats1 = scheduler.getStats()
      expect(stats1.totalFrames).toBe(60)

      // Add one more — ring buffer wraps, oldest (0) is evicted
      // Buffer now contains: [1, 2, ..., 59, 999] (60 elements)
      scheduler.reportFrame(makeMetrics({ totalMs: 999 }))
      const stats2 = scheduler.getStats()
      expect(stats2.totalFrames).toBe(61)
      // P95: index = floor(60*0.95) = 57, sorted[57] = 58
      expect(stats2.p95FrameMs).toBe(58)
    })
  })

  // === reset ===

  describe('reset', () => {
    it('should restore initial state', () => {
      // Degrade to minimal (3 + 10 = 13 slow frames)
      for (let i = 0; i < 13; i++) {
        scheduler.reportFrame(makeMetrics({ totalMs: 50 }))
      }
      expect(scheduler.getState()).toBe('minimal')

      scheduler.reset()
      expect(scheduler.getState()).toBe('normal')
      expect(scheduler.getIntervalMs()).toBe(16)
      expect(scheduler.getStats().totalFrames).toBe(0)
    })
  })

  // === 全局单例 (A3) ===

  describe('global singleton (A3)', () => {
    it('should support injection for testing', () => {
      const custom = new FrameScheduler()
      setFrameScheduler(custom)
      expect(getFrameScheduler()).toBe(custom)
    })

    it('should create default instance', () => {
      disposeFrameScheduler()
      const instance = getFrameScheduler()
      expect(instance).toBeInstanceOf(FrameScheduler)
      // Same instance on second call
      expect(getFrameScheduler()).toBe(instance)
    })
  })
})
