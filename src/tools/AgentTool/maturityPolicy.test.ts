/**
 * MaturityPolicy 测试 — ORION 成熟度判定标准化
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { getMaturity, getNextMaturityHint, getMaturityPolicy, MATURITY_POLICY } from './maturityPolicy'

describe('MATURITY_POLICY', () => {
  it('should have correct thresholds', () => {
    expect(MATURITY_POLICY.tested.minRuns).toBe(3)
    expect(MATURITY_POLICY.tested.minAvg).toBe(60)
    expect(MATURITY_POLICY.hardened.minRuns).toBe(5)
    expect(MATURITY_POLICY.hardened.minAvg).toBe(80)
    expect(MATURITY_POLICY.hardened.requireEdgeCases).toBe(true)
    expect(MATURITY_POLICY.crystallized.minRuns).toBe(5)
    expect(MATURITY_POLICY.crystallized.minAvg).toBe(90)
    expect(MATURITY_POLICY.crystallized.requireEdgeCases).toBe(true)
  })
})

describe('getMaturityPolicy (env override)', () => {
  const origEnv = process.env

  beforeEach(() => {
    process.env = { ...origEnv }
  })

  afterAll(() => {
    process.env = origEnv
  })

  it('should return defaults when no env set', () => {
    const p = getMaturityPolicy()
    expect(p.tested.minRuns).toBe(3)
    expect(p.tested.minAvg).toBe(60)
  })

  it('should respect env overrides', () => {
    process.env.MATURITY_TESTED_RUNS = '5'
    process.env.MATURITY_HARDENED_AVG = '85'
    const p = getMaturityPolicy()
    expect(p.tested.minRuns).toBe(5)
    expect(p.hardened.minAvg).toBe(85)
  })

  it('should allow disabling requireEdgeCases', () => {
    process.env.MATURITY_HARDENED_EDGE_CASES = 'false'
    process.env.MATURITY_CRYSTALLIZED_EDGE_CASES = 'false'
    const p = getMaturityPolicy()
    expect(p.hardened.requireEdgeCases).toBe(false)
    expect(p.crystallized.requireEdgeCases).toBe(false)
  })
})

describe('getMaturity', () => {
  it('should return "draft" when executionCount < 3', () => {
    expect(getMaturity(0, 100, 0)).toBe('draft')
    expect(getMaturity(1, 100, 0)).toBe('draft')
    expect(getMaturity(2, 100, 0)).toBe('draft')
  })

  it('should return "tested" when count >= 3 and avg >= 60', () => {
    expect(getMaturity(3, 60, 0)).toBe('tested')
    expect(getMaturity(5, 75, 0)).toBe('tested')
    expect(getMaturity(10, 60, 0)).toBe('tested')
    expect(getMaturity(10, 85, 1)).toBe('hardened')
    expect(getMaturity(10, 95, 1)).toBe('crystallized')
    expect(getMaturity(5, 85, 0)).toBe('tested')
  })

  it('should return "hardened" when count >= 5, avg >= 80, with edge cases', () => {
    expect(getMaturity(5, 80, 1)).toBe('hardened')
    expect(getMaturity(10, 85, 2)).toBe('hardened')
    expect(getMaturity(5, 80, 0)).toBe('tested')
  })

  it('should return "crystallized" when count >= 5, avg >= 90, with edge cases', () => {
    expect(getMaturity(5, 90, 1)).toBe('crystallized')
    expect(getMaturity(10, 95, 3)).toBe('crystallized')
    expect(getMaturity(5, 90, 0)).toBe('tested')
    expect(getMaturity(5, 85, 1)).toBe('hardened')
  })

  it('should accept custom policy', () => {
    const strictPolicy = {
      tested: { minRuns: 10, minAvg: 80 },
      hardened: { minRuns: 20, minAvg: 90, requireEdgeCases: true },
      crystallized: { minRuns: 30, minAvg: 95, requireEdgeCases: true },
    }
    expect(getMaturity(10, 85, 1, strictPolicy)).toBe('tested')
    expect(getMaturity(5, 95, 1, strictPolicy)).toBe('draft')
  })

  it('should handle negative scores', () => {
    expect(getMaturity(10, -1, 0)).toBe('draft')
  })
})

describe('getNextMaturityHint', () => {
  it('should return null for crystallized', () => {
    expect(getNextMaturityHint('crystallized', 10, 95, 3)).toBeNull()
  })

  it('should provide hint for draft needing more executions (zh)', () => {
    const hint = getNextMaturityHint('draft', 1, 70, 0, 'zh')
    expect(typeof hint).toBe('string')
    expect(hint!.length).toBeGreaterThan(0)
    expect(hint!).toContain('执行')
  })

  it('should provide hint for draft needing score', () => {
    const hint = getNextMaturityHint('draft', 5, 70, 0)
    expect(hint).toContain('avg score 需达到')
  })

  it('should provide hint for tested needing edge cases', () => {
    const hint = getNextMaturityHint('tested', 5, 85, 0)
    expect(hint).toContain('edge case')
  })

  it('should provide hint for tested needing more runs', () => {
    const hint = getNextMaturityHint('tested', 2, 85, 0)
    expect(hint).toContain('更多执行')
  })

  it('should provide hint for hardened needing higher score', () => {
    const hint = getNextMaturityHint('hardened', 10, 85, 1)
    expect(hint).toContain('avg score 需达到')
  })

  describe('locale=en', () => {
    it('should return English hints', () => {
      const hint = getNextMaturityHint('draft', 1, 70, 0, 'en')
      expect(hint).not.toContain('执行')
      expect(hint).toContain('Needs')
    })

    it('should handle tested needing edge cases', () => {
      const hint = getNextMaturityHint('tested', 5, 85, 0, 'en')
      expect(hint).toContain('edge case')
    })

    it('should handle all levels', () => {
      expect(getNextMaturityHint('crystallized', 10, 95, 3, 'en')).toBeNull()
      const h1 = getNextMaturityHint('draft', 5, 70, 0, 'en')
      expect(h1).toContain('Needs')
      const h2 = getNextMaturityHint('hardened', 10, 85, 1, 'en')
      expect(h2).toContain('avg score')
    })
  })
})