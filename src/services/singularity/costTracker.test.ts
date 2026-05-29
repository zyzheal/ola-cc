import { describe, expect, it } from 'bun:test'
import { CostTrackerImpl } from './costTracker'

describe('CostTracker', () => {
  it('should record calls and return correct total cost', () => {
    const tracker = new CostTrackerImpl()
    tracker.recordLLMCall(1000, 'claude-sonnet-4-20250514', 0.003)
    tracker.recordLLMCall(2000, 'claude-sonnet-4-20250514', 0.006)
    expect(tracker.getTotalCost()).toBeCloseTo(0.009)
  })

  it('should report over budget when cost exceeds budget', () => {
    const tracker = new CostTrackerImpl()
    tracker.recordLLMCall(5000, 'claude-opus-4-20250514', 0.075)
    expect(tracker.isOverBudget(0.05)).toBe(true)
  })

  it('should report not over budget when cost is within budget', () => {
    const tracker = new CostTrackerImpl()
    tracker.recordLLMCall(1000, 'claude-sonnet-4-20250514', 0.003)
    expect(tracker.isOverBudget(0.05)).toBe(false)
  })

  it('should reset all state', () => {
    const tracker = new CostTrackerImpl()
    tracker.recordLLMCall(1000, 'claude-sonnet-4-20250514', 0.003)
    tracker.recordLLMCall(2000, 'claude-opus-4-20250514', 0.030)
    tracker.reset()
    expect(tracker.getTotalCost()).toBe(0)
    expect(tracker.getCallCount()).toBe(0)
    expect(tracker.isOverBudget(0)).toBe(false)
  })

  it('should return correct call count', () => {
    const tracker = new CostTrackerImpl()
    expect(tracker.getCallCount()).toBe(0)
    tracker.recordLLMCall(1000, 'claude-sonnet-4-20250514', 0.003)
    tracker.recordLLMCall(2000, 'claude-opus-4-20250514', 0.030)
    tracker.recordLLMCall(500, 'claude-sonnet-4-20250514', 0.0015)
    expect(tracker.getCallCount()).toBe(3)
  })

  it('should group calls by model correctly', () => {
    const tracker = new CostTrackerImpl()
    tracker.recordLLMCall(1000, 'claude-sonnet-4-20250514', 0.003)
    tracker.recordLLMCall(2000, 'claude-opus-4-20250514', 0.030)
    tracker.recordLLMCall(500, 'claude-sonnet-4-20250514', 0.0015)

    const byModel = tracker.getCallsByModel()
    const sonnet = byModel['claude-sonnet-4-20250514']
    expect(sonnet.count).toBe(2)
    expect(sonnet.tokens).toBe(1500)
    expect(sonnet.cost).toBeCloseTo(0.0045)

    const opus = byModel['claude-opus-4-20250514']
    expect(opus.count).toBe(1)
    expect(opus.tokens).toBe(2000)
    expect(opus.cost).toBeCloseTo(0.030)
  })

  it('should return 0 average cost when no calls recorded', () => {
    const tracker = new CostTrackerImpl()
    expect(tracker.getAverageCostPerCall()).toBe(0)
  })

  it('should return correct average cost per call', () => {
    const tracker = new CostTrackerImpl()
    tracker.recordLLMCall(1000, 'claude-sonnet-4-20250514', 0.003)
    tracker.recordLLMCall(2000, 'claude-sonnet-4-20250514', 0.006)
    expect(tracker.getAverageCostPerCall()).toBeCloseTo(0.0045)
  })
})
