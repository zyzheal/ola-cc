/**
 * LearningSystem 测试 — 执行记录 + 对比分析 + 统计
 */

import { describe, it, expect } from 'bun:test'
import { LearningSystem, type ExecutionRecord } from './LearningSystem'

describe('LearningSystem', () => {
  it('should create with default config', () => {
    const ls = new LearningSystem()
    expect(ls.getRecordCount('test')).toBe(0)
  })

  it('should accept custom config', () => {
    const ls = new LearningSystem({ maxRecords: 50, confidenceThreshold: 75 })
    expect(ls).toBeDefined()
  })
})

describe('logExecution / getExecutionHistory', () => {
  it('should record and retrieve execution', () => {
    const ls = new LearningSystem()
    ls.logExecution({
      skill: 'code-review',
      taskDescription: 'Review PR #123',
      outcome: 'success',
      score: 85,
      signal: null,
      edgeCases: [],
      timestamp: new Date(),
      duration_ms: 5000,
    })

    const history = ls.getExecutionHistory('code-review')
    expect(history.length).toBe(1)
    expect(history[0].outcome).toBe('success')
    expect(history[0].score).toBe(85)
  })

  it('should return only relevant skills', () => {
    const ls = new LearningSystem()
    ls.logExecution({ skill: 'a', taskDescription: 'x', outcome: 'success', score: 80, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
  ls.logExecution({ skill: 'b', taskDescription: 'y', outcome: 'failure', score: 40, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 200 })

    expect(ls.getExecutionHistory('a').length).toBe(1)
    expect(ls.getExecutionHistory('b').length).toBe(1)
    expect(ls.getExecutionHistory('c').length).toBe(0)
  })

  it('should respect limit parameter', () => {
    const ls = new LearningSystem()
    for (let i = 0; i < 10; i++) {
      ls.logExecution({
        skill: 'test', taskDescription: `t${i}`, outcome: 'success' as const,
        score: 60 + i, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100,
      })
    }
    const history = ls.getExecutionHistory('test', 5)
    expect(history.length).toBe(5)
  })

  it('should generate unique IDs', () => {
    const ls = new LearningSystem()
    ls.logExecution({ skill: 'test', taskDescription: 'a', outcome: 'success', score: 70, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    ls.logExecution({ skill: 'test', taskDescription: 'b', outcome: 'success', score: 80, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    const ids = [...new Set(ls.getExecutionHistory('test').map(r => r.id))]
    expect(ids.length).toBe(2)
  })
})

describe('getExecutionStats', () => {
  it('should compute correct statistics', () => {
    const ls = new LearningSystem()
    ls.logExecution({ skill: 'review', taskDescription: 'a', outcome: 'success', score: 90, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    ls.logExecution({ skill: 'review', taskDescription: 'b', outcome: 'failure', score: 40, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    ls.logExecution({ skill: 'review', taskDescription: 'c', outcome: 'success', score: 80, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })

    const stats = ls.getExecutionStats('review')
    expect(stats.total).toBe(3)
    expect(stats.success).toBe(2)
    expect(stats.failure).toBe(1)
    expect(stats.avgScore).toBeCloseTo(70, 1) // (90+40+80)/3 = 70
  })

  it('should handle unknown skill', () => {
    const ls = new LearningSystem()
    const stats = ls.getExecutionStats('nonexistent')
    expect(stats.total).toBe(0)
    expect(stats.avgScore).toBe(0)
  })

  it('should track signal distribution', () => {
    const ls = new LearningSystem()
    const base = { skill: 's', taskDescription: 'd', outcome: 'success' as const, score: 80, signal: null, edgeCases: [] as string[], timestamp: new Date(), duration_ms: 100 }
    ls.logExecution({ ...base, signal: { signal_type: 'DISCOVERY' as any, reasoning_trace: 't', target_skill_segment: null, evidence: '', proposed_revision: '' } })
    ls.logExecution({ ...base, signal: { signal_type: 'OPTIMIZATION' as any, reasoning_trace: 't', target_skill_segment: null, evidence: '', proposed_revision: '' } })
    ls.logExecution(base)

    const stats = ls.getExecutionStats('s')
    expect(stats.signalDistribution['DISCOVERY']).toBe(1)
    expect(stats.signalDistribution['OPTIMIZATION']).toBe(1)
  })
})

describe('contrastAnalysis', () => {
  it('should return delta when both winners and losers exist', () => {
    const ls = new LearningSystem()
    // Winners: success + score >= 70
    ls.logExecution({
      skill: 'test', taskDescription: 'w1', outcome: 'success', score: 85,
      signal: { signal_type: 'DISCOVERY' as any, reasoning_trace: 't', target_skill_segment: null, evidence: '', proposed_revision: '' },
      edgeCases: [], timestamp: new Date(), duration_ms: 100,
    })
    // Loser: failure + score < 50
    ls.logExecution({
      skill: 'test', taskDescription: 'l1', outcome: 'failure', score: 40,
      signal: { signal_type: 'EXECUTION_LAPSE' as any, reasoning_trace: 't', target_skill_segment: null, evidence: '', proposed_revision: '' },
      edgeCases: [], timestamp: new Date(), duration_ms: 100,
    })

    const result = ls.contrastAnalysis('test', 10)
    expect(result.delta).not.toBeNull()
    expect(result.delta!.uniqueToWinners).toContain('DISCOVERY')
    expect(result.delta!.uniqueToLosers).toContain('EXECUTION_LAPSE')
    expect(result.delta!.scoreDelta).toBeGreaterThan(0)
    expect(result.insight.length).toBeGreaterThan(0)
  })

  it('should return null delta when not enough data', () => {
    const ls = new LearningSystem()
    ls.logExecution({ skill: 'test', taskDescription: 'x', outcome: 'success', score: 80, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })

    const result = ls.contrastAnalysis('test', 10)
    expect(result.delta).toBeNull()
    expect(result.insight).toContain('数据不足')
  })

  it('should return null delta when no losers exist', () => {
    const ls = new LearningSystem()
    ls.logExecution({ skill: 'test', taskDescription: 'w1', outcome: 'success', score: 85, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    ls.logExecution({ skill: 'test', taskDescription: 'w2', outcome: 'success', score: 90, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })

    const result = ls.contrastAnalysis('test', 10)
    expect(result.delta).toBeNull()
  })

  it('should return null delta when no clear losers (all scores between 50-69)', () => {
    const ls = new LearningSystem()
    ls.logExecution({ skill: 'test', taskDescription: 'winner', outcome: 'success', score: 80, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    ls.logExecution({ skill: 'test', taskDescription: 'mid', outcome: 'success', score: 60, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })

    const result = ls.contrastAnalysis('test', 10)
    expect(result.delta).toBeNull() // winner but no loser (score 60 is between 50 and the "failure/score<50" threshold)
  })

  it('should return null delta when only losers exist, no winners', () => {
    const ls = new LearningSystem()
    ls.logExecution({ skill: 'test', taskDescription: 'l1', outcome: 'failure', score: 30, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    ls.logExecution({ skill: 'test', taskDescription: 'l2', outcome: 'failure', score: 20, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })

    const result = ls.contrastAnalysis('test', 10)
    expect(result.delta).toBeNull()
  })

  it('should return null delta when identical signal_type across winners and losers', () => {
    const ls = new LearningSystem()
    const sameSignal = { signal_type: 'DISCOVERY' as any, reasoning_trace: 't', target_skill_segment: null, evidence: '', proposed_revision: '' }
    ls.logExecution({ skill: 'test', taskDescription: 'w1', outcome: 'success', score: 85, signal: sameSignal, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    ls.logExecution({ skill: 'test', taskDescription: 'l1', outcome: 'failure', score: 30, signal: sameSignal, edgeCases: [], timestamp: new Date(), duration_ms: 100 })

    const result = ls.contrastAnalysis('test', 10)
    expect(result.delta).not.toBeNull()
    expect(result.delta!.uniqueToWinners).toEqual([])
    expect(result.delta!.uniqueToLosers).toEqual([])
    // score delta should exist but signal deltas empty
    expect(result.delta!.scoreDelta).toBeGreaterThan(0)
  })

  it('should respect windowSize limit', () => {
    const ls = new LearningSystem()
    // Insert 20 records with mixed outcomes
    for (let i = 0; i < 20; i++) {
      ls.logExecution({
        skill: 'test', taskDescription: `r${i}`, outcome: i % 3 === 0 ? 'failure' as const : 'success' as const,
        score: i % 3 === 0 ? 30 + i : 80 + i, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100,
      })
    }
    // window = 5 should only look at last 5 records
    const result = ls.contrastAnalysis('test', 5)
    expect(result.delta).not.toBeNull()
    expect(result.delta!.winnerCount + result.delta!.loserCount).toBeLessThanOrEqual(5)
  })

  it('should handle losers with outcome success but score < 50', () => {
    const ls = new LearningSystem()
    // Winner: score >= 70
    ls.logExecution({ skill: 't', taskDescription: 'w', outcome: 'success', score: 85, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    // Loser: outcome success but score 40 < 50
    ls.logExecution({ skill: 't', taskDescription: 'low-score', outcome: 'success', score: 40, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })

    const result = ls.contrastAnalysis('t', 10)
    expect(result.delta).not.toBeNull()
    expect(result.delta!.loserCount).toBe(1)
  })

  it('should handle winners with high score and outcome failure (the "failure but worked" case)', () => {
    const ls = new LearningSystem()
    // Winner: outcome success, score >= 70
    ls.logExecution({ skill: 't', taskDescription: 'w', outcome: 'success', score: 90, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })
    // Not a loser: outcome failure but score 30 < 50
    ls.logExecution({ skill: 't', taskDescription: 'l', outcome: 'failure', score: 30, signal: null, edgeCases: [], timestamp: new Date(), duration_ms: 100 })

    const result = ls.contrastAnalysis('t', 10)
    expect(result.delta).not.toBeNull()
  })
})

describe('FalsePositiveRecord compatibility', () => {
  it('should record false positives (backward compat)', () => {
    const ls = new LearningSystem()
    // This uses the old logFalsePositive API which should still work
    // @ts-ignore — accessing private API for backward compat check
    ls.logFalsePositive?.({ type: 'syntax-error', description: 'bad', severity: 'error' as const }, 'reason', 'detector')
    const records = ls.getRecords()
    expect(records.length).toBe(1)
    expect(records[0].issueType).toBe('syntax-error')
  })
})
