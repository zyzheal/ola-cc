/**
 * GraphUsageTracker tests
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { GraphUsageTracker, type UsageEntry } from '../GraphUsageTracker.js'

// ============================================================
// Helpers
// ============================================================

function makeEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    toolName: 'codegraph',
    operation: 'codegraph_search',
    timestamp: Date.now(),
    success: true,
    duration: 50,
    ...overrides,
  }
}

// ============================================================
// Tests
// ============================================================

describe('GraphUsageTracker', () => {
  let tracker: GraphUsageTracker

  beforeEach(() => {
    GraphUsageTracker.resetAll()
    tracker = GraphUsageTracker.getInstance('/test/project')
  })

  // ----------------------------------------------------------
  // Singleton pattern
  // ----------------------------------------------------------

  describe('singleton pattern', () => {
    it('returns the same instance for the same projectRoot', () => {
      const a = GraphUsageTracker.getInstance('/test/project')
      const b = GraphUsageTracker.getInstance('/test/project')
      expect(a).toBe(b)
    })

    it('returns different instances for different projectRoots', () => {
      const a = GraphUsageTracker.getInstance('/project/a')
      const b = GraphUsageTracker.getInstance('/project/b')
      expect(a).not.toBe(b)
    })

    it('resetAll clears all instances', () => {
      const before = GraphUsageTracker.getInstance('/project/x')
      GraphUsageTracker.resetAll()
      const after = GraphUsageTracker.getInstance('/project/x')
      expect(before).not.toBe(after)
    })
  })

  // ----------------------------------------------------------
  // recordUsage + getRecentOperations roundtrip
  // ----------------------------------------------------------

  describe('recordUsage + getRecentOperations', () => {
    it('records and retrieves a single entry', () => {
      const entry = makeEntry({ operation: 'codegraph_search', query: 'GraphStore' })
      tracker.recordUsage(entry)

      const recent = tracker.getRecentOperations()
      expect(recent).toHaveLength(1)
      expect(recent[0].operation).toBe('codegraph_search')
      expect(recent[0].query).toBe('GraphStore')
    })

    it('returns most recent first', () => {
      tracker.recordUsage(makeEntry({ operation: 'first', timestamp: 100 }))
      tracker.recordUsage(makeEntry({ operation: 'second', timestamp: 200 }))
      tracker.recordUsage(makeEntry({ operation: 'third', timestamp: 300 }))

      const recent = tracker.getRecentOperations()
      expect(recent).toHaveLength(3)
      expect(recent[0].operation).toBe('third')
      expect(recent[1].operation).toBe('second')
      expect(recent[2].operation).toBe('first')
    })

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordUsage(makeEntry({ operation: `op_${i}` }))
      }

      const recent = tracker.getRecentOperations(3)
      expect(recent).toHaveLength(3)
      expect(recent[0].operation).toBe('op_9')
    })
  })

  // ----------------------------------------------------------
  // getStats
  // ----------------------------------------------------------

  describe('getStats', () => {
    it('returns zero stats for empty tracker', () => {
      const stats = tracker.getStats()
      expect(stats.totalCalls).toBe(0)
      expect(stats.successRate).toBe(0)
      expect(stats.avgDuration).toBe(0)
      expect(stats.topOperations).toEqual([])
      expect(stats.recentErrors).toEqual([])
    })

    it('computes correct success rate', () => {
      tracker.recordUsage(makeEntry({ success: true }))
      tracker.recordUsage(makeEntry({ success: true }))
      tracker.recordUsage(makeEntry({ success: false }))
      tracker.recordUsage(makeEntry({ success: true }))

      const stats = tracker.getStats()
      expect(stats.totalCalls).toBe(4)
      expect(stats.successRate).toBe(0.75)
    })

    it('computes correct average duration', () => {
      tracker.recordUsage(makeEntry({ duration: 10 }))
      tracker.recordUsage(makeEntry({ duration: 20 }))
      tracker.recordUsage(makeEntry({ duration: 30 }))

      const stats = tracker.getStats()
      expect(stats.avgDuration).toBe(20)
    })

    it('computes top operations sorted by count', () => {
      tracker.recordUsage(makeEntry({ operation: 'search' }))
      tracker.recordUsage(makeEntry({ operation: 'search' }))
      tracker.recordUsage(makeEntry({ operation: 'search' }))
      tracker.recordUsage(makeEntry({ operation: 'callers' }))
      tracker.recordUsage(makeEntry({ operation: 'callers' }))
      tracker.recordUsage(makeEntry({ operation: 'callees' }))

      const stats = tracker.getStats()
      expect(stats.topOperations).toEqual([
        { operation: 'search', count: 3 },
        { operation: 'callers', count: 2 },
        { operation: 'callees', count: 1 },
      ])
    })

    it('tracks recent errors', () => {
      tracker.recordUsage(makeEntry({ success: false, operation: 'search', query: 'not found' }))
      tracker.recordUsage(makeEntry({ success: false, operation: 'callers', query: 'timeout' }))

      const stats = tracker.getStats()
      expect(stats.recentErrors).toHaveLength(2)
      expect(stats.recentErrors[0]).toMatchObject({ operation: 'search', error: 'not found' })
      expect(stats.recentErrors[1]).toMatchObject({ operation: 'callers', error: 'timeout' })
    })

    it('keeps only last 10 errors', () => {
      for (let i = 0; i < 15; i++) {
        tracker.recordUsage(makeEntry({ success: false, operation: 'search', query: `err_${i}` }))
      }

      const stats = tracker.getStats()
      expect(stats.recentErrors).toHaveLength(5) // getStats returns last 5 from the stored 10
      expect(stats.recentErrors[0].error).toBe('err_10')
    })
  })

  // ----------------------------------------------------------
  // getFrequentPairs
  // ----------------------------------------------------------

  describe('getFrequentPairs', () => {
    it('returns empty for less than 2 entries', () => {
      tracker.recordUsage(makeEntry({ operation: 'search' }))
      expect(tracker.getFrequentPairs()).toEqual([])
    })

    it('detects consecutive operation pairs', () => {
      // search -> callers appears 3 times
      tracker.recordUsage(makeEntry({ operation: 'search' }))
      tracker.recordUsage(makeEntry({ operation: 'callers' }))
      tracker.recordUsage(makeEntry({ operation: 'search' }))
      tracker.recordUsage(makeEntry({ operation: 'callers' }))
      tracker.recordUsage(makeEntry({ operation: 'search' }))
      tracker.recordUsage(makeEntry({ operation: 'callers' }))
      // callees -> search appears once
      tracker.recordUsage(makeEntry({ operation: 'callees' }))
      tracker.recordUsage(makeEntry({ operation: 'search' }))

      const pairs = tracker.getFrequentPairs()
      expect(pairs.length).toBeGreaterThanOrEqual(3)
      expect(pairs[0]).toEqual(['search', 'callers', 3])
      expect(pairs[1]).toEqual(['callers', 'search', 2])
      expect(pairs[2]).toEqual(['callers', 'callees', 1])
    })

    it('returns sorted by count descending', () => {
      // a -> b: 1 time
      tracker.recordUsage(makeEntry({ operation: 'a' }))
      tracker.recordUsage(makeEntry({ operation: 'b' }))
      // b -> c: 2 times
      tracker.recordUsage(makeEntry({ operation: 'b' }))
      tracker.recordUsage(makeEntry({ operation: 'c' }))
      tracker.recordUsage(makeEntry({ operation: 'b' }))
      tracker.recordUsage(makeEntry({ operation: 'c' }))

      const pairs = tracker.getFrequentPairs()
      expect(pairs[0][2]).toBeGreaterThanOrEqual(pairs[1][2])
    })
  })

  // ----------------------------------------------------------
  // Circular buffer overflow
  // ----------------------------------------------------------

  describe('circular buffer overflow', () => {
    it('keeps last 100 entries when buffer overflows', () => {
      // Add 150 entries
      for (let i = 0; i < 150; i++) {
        tracker.recordUsage(makeEntry({ operation: `op_${i}`, timestamp: i }))
      }

      const recent = tracker.getRecentOperations()
      expect(recent).toHaveLength(100)
      // Most recent should be op_149
      expect(recent[0].operation).toBe('op_149')
      // Oldest should be op_50
      expect(recent[99].operation).toBe('op_50')
    })

    it('stats reflect only buffered entries', () => {
      // Add 100 successes then 50 failures
      for (let i = 0; i < 100; i++) {
        tracker.recordUsage(makeEntry({ success: true }))
      }
      for (let i = 0; i < 50; i++) {
        tracker.recordUsage(makeEntry({ success: false }))
      }

      const stats = tracker.getStats()
      expect(stats.totalCalls).toBe(100)
      // Only last 100 entries: 50 success + 50 failure
      expect(stats.successRate).toBe(0.5)
    })

    it('handles multiple wraps correctly', () => {
      // Add 350 entries (3.5 wraps)
      for (let i = 0; i < 350; i++) {
        tracker.recordUsage(makeEntry({ operation: `op_${i}`, timestamp: i }))
      }

      const recent = tracker.getRecentOperations()
      expect(recent).toHaveLength(100)
      expect(recent[0].operation).toBe('op_349')
      expect(recent[99].operation).toBe('op_250')
    })
  })

  // ----------------------------------------------------------
  // reset
  // ----------------------------------------------------------

  describe('reset', () => {
    it('clears all data', () => {
      tracker.recordUsage(makeEntry({ success: false, query: 'err' }))
      tracker.recordUsage(makeEntry({ operation: 'search' }))

      tracker.reset()

      const stats = tracker.getStats()
      expect(stats.totalCalls).toBe(0)
      expect(stats.recentErrors).toEqual([])
      expect(tracker.getRecentOperations()).toEqual([])
      expect(tracker.getFrequentPairs()).toEqual([])
    })
  })
})
