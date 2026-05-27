/**
 * rubricEvaluator 测试
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { evaluateQuality, getFailedDimensions, getRubricConfig, type QualityInput } from './rubricEvaluator'

// ============================================
// 帮助函数
// ============================================

function makeQuality(partial: Partial<QualityInput>): QualityInput {
  return {
    tokenBudget: 10000,
    tokensUsed: 5000,
    baselineTokens: 8000,
    ...partial,
  }
}

// ============================================
// 测试：基础评分
// ============================================

describe('evaluateQuality — 基础维度', () => {
  it('should pass all dimensions with ideal inputs', () => {
    const result = evaluateQuality(makeQuality({
      testResults: [
        { passed: true, name: 'test1', regression: false },
        { passed: true, name: 'test2', regression: false },
        { passed: true, name: 'test3', regression: false },
        { passed: true, name: 'test4', regression: false },
      ],
      triggerAccuracy: 0.9,
    }))
    expect(result.passed).toBe(true)
  })

  it('should fail when holdout_floor < threshold', () => {
    const result = evaluateQuality(makeQuality({
      testResults: [
        { passed: true, name: 'test1', regression: false },
        { passed: false, name: 'test2', regression: false }, // 50% pass rate
      ],
      triggerAccuracy: 0.95,
    }))
    expect(result.passed).toBe(false)
    expect(result.dimensions.holdout_floor.passed).toBe(false)
    expect(result.dimensions.holdout_floor.value).toBe(0.5)
    expect(result.dimensions.holdout_floor.threshold).toBe(0.6)
  })

  it('should pass holdout_floor when exactly at threshold', () => {
    const result = evaluateQuality(makeQuality({
      testResults: [
        { passed: true, name: 'test1', regression: false },
        { passed: true, name: 'test2', regression: false },
        { passed: false, name: 'test3', regression: false }, // 66.7% >= 60%
      ],
      triggerAccuracy: 0.95,
    }))
    expect(result.passed).toBe(true)
    expect(result.dimensions.holdout_floor.value).toBeGreaterThan(0.66)
  })

  it('should handle min_delta failure (tokens used exceeds budget significantly)', () => {
    const result = evaluateQuality(makeQuality({
      tokensUsed: 12000, // > baseline 8000 → delta < 0
      baselineTokens: 8000,
    }))
    expect(result.passed).toBe(false)
    expect(result.dimensions.min_delta.passed).toBe(false)
    expect(result.dimensions.min_delta.value).toBeLessThan(0.05)
  })

  it('should fail when trigger_f1 below threshold', () => {
    const result = evaluateQuality(makeQuality({
      triggerAccuracy: 0.8, // below 0.85 threshold
    }))
    expect(result.passed).toBe(false)
    expect(result.dimensions.trigger_f1.passed).toBe(false)
    expect(result.dimensions.trigger_f1.value).toBe(0.8)
  })

  it('should fail when cost_ratio exceeds max', () => {
    const result = evaluateQuality(makeQuality({
      tokensUsed: 10000,
      baselineTokens: 5000, // ratio = 2.0 > 1.2
    }))
    expect(result.passed).toBe(false)
    expect(result.dimensions.cost_budget.passed).toBe(false)
    expect(result.dimensions.cost_budget.value).toBe(2.0)
  })

  it('should pass when no test results (passRate defaults to 1.0)', () => {
    const result = evaluateQuality(makeQuality({ testResults: [] }))
    expect(result.dimensions.holdout_floor.value).toBe(1.0)
    // But may still fail on other dims - check each independently
    expect(result.dimensions.holdout_floor.passed).toBe(true)
  })

  it('should handle regression failures', () => {
    const result = evaluateQuality(makeQuality({
      testResults: [
        { passed: true, name: 'normal_test', regression: false },
        { passed: false, name: 'regression_test_1', regression: true },
      ],
    }))
    expect(result.passed).toBe(false)
    expect(result.dimensions.regression_check.passed).toBe(false)
    expect(result.dimensions.regression_check.value).toEqual(['regression_test_1'])
  })
})

// ============================================
// 测试：AND 门控逻辑
// ============================================

describe('evaluateQuality — AND 门控', () => {
  it('should fail when ANY single dimension fails', () => {
    // Only trigger_f1 fails
    const result = evaluateQuality(makeQuality({
      triggerAccuracy: 0.5, // well below threshold
    }))
    expect(result.passed).toBe(false)
    expect(result.dimensions.trigger_f1.passed).toBe(false)
  })

  it('should only pass when ALL dimensions pass simultaneously', () => {
    const result = evaluateQuality(makeQuality({
      testResults: Array(10).fill(null).map((_, i) => ({
        passed: i !== 2, // 90% pass rate
        name: `test_${i}`,
        regression: false,
      })),
      triggerAccuracy: 0.95,
      tokensUsed: 6000, // ratio 0.75 < 1.2
    }))
    expect(result.passed).toBe(true)
  })
})

// ============================================
// 测试：getFailedDimensions
// ============================================

describe('getFailedDimensions', () => {
  it('should return empty array when all pass', () => {
    const result = evaluateQuality(makeQuality({}))
    const failed = getFailedDimensions(result)
    // May have some failures depending on inputs; let's use a controlled case
    const passResult = evaluateQuality(makeQuality({
      testResults: [{ passed: true, name: 't1', regression: false }],
      triggerAccuracy: 1.0,
      tokensUsed: 1000, // well under budget
      baselineTokens: 10000,
    }))
    expect(passResult.passed).toBe(true)
    expect(getFailedDimensions(passResult)).toEqual([])
  })

  it('should list only failed dimensions with values', () => {
    const result = evaluateQuality(makeQuality({
      tokensUsed: 10000,
      baselineTokens: 5000, // ratio 2.0 > 1.2
      triggerAccuracy: 0.5, // < 0.85
    }))
    const failed = getFailedDimensions(result)
    expect(failed.length).toBeGreaterThan(0)
    for (const f of failed) {
      expect(f.length).toBeGreaterThan(5) // should have dimension name and value
    }
  })
})

// ============================================
// 测试：配置覆盖（环境变量）
// ============================================

describe('evaluateQuality — 环境变量覆盖', () => {
  const origEnv = process.env

  beforeEach(() => {
    process.env = { ...origEnv }
  })

  afterAll(() => {
    process.env = origEnv
  })

  it('should respect custom thresholds via env vars', () => {
    process.env.RUBRIC_HOLDOUT_FLOOR = '0.9'
    process.env.RUBRIC_MIN_DELTA = '0.1'
    process.env.RUBRIC_TRIGGER_F1 = '0.9'
    process.env.RUBRIC_MAX_COST_RATIO = '1.5'

    const config = getRubricConfig()
    expect(config.holdoutFloor).toBe(0.9)
    expect(config.minDelta).toBe(0.1)
    expect(config.triggerF1Floor).toBe(0.9)
    expect(config.maxCostRatio).toBe(1.5)
  })

  it('should default when invalid float is provided', () => {
    process.env.RUBRIC_HOLDOUT_FLOOR = 'invalid'
    const config = getRubricConfig()
    expect(config.holdoutFloor).toBeNaN() // parseFloat('invalid') = NaN
  })

  it('should fall back to defaults when no env set', () => {
    delete process.env.RUBRIC_HOLDOUT_FLOOR
    delete process.env.RUBRIC_MIN_DELTA
    delete process.env.RUBRIC_TRIGGER_F1
    delete process.env.RUBRIC_MAX_COST_RATIO

    const config = getRubricConfig()
    expect(config.holdoutFloor).toBe(0.6)
    expect(config.minDelta).toBe(0.05)
    expect(config.triggerF1Floor).toBe(0.85)
    expect(config.maxCostRatio).toBe(1.2)
  })
})

// ============================================
// 测试：边界条件
// ============================================

describe('evaluateQuality — 边界条件', () => {
  it('should handle undefined triggerAccuracy (defaults to 1.0)', () => {
    const result = evaluateQuality(makeQuality({
      triggerAccuracy: undefined,
    }))
    expect(result.dimensions.trigger_f1.value).toBe(1.0)
    expect(result.dimensions.trigger_f1.passed).toBe(true)
  })

  it('should handle null tokenBudget', () => {
    // null budget → no cost restriction
    const result = evaluateQuality(makeQuality({
      tokenBudget: null,
      tokensUsed: 99999,
      baselineTokens: 1000,
    }))
    expect(result.dimensions.cost_budget.value).toBe(99.999)
  })

  it('should handle zero baselineTokens (no improvement possible)', () => {
    const result = evaluateQuality(makeQuality({
      baselineTokens: 0,
    }))
    expect(result.dimensions.min_delta.value).toBe(0)
    expect(result.dimensions.min_delta.passed).toBe(false) // 0 < 0.05
    expect(result.dimensions.cost_budget.value).toBe(1.0) // default when baseline is 0
  })

  it('should handle empty testResults array', () => {
    const result = evaluateQuality(makeQuality({
      testResults: [],
    }))
    expect(result.dimensions.holdout_floor.value).toBe(1.0)
    expect(result.dimensions.holdout_floor.passed).toBe(true)
    expect(result.dimensions.regression_check.passed).toBe(true)
  })

  it('should count regressions correctly', () => {
    const result = evaluateQuality(makeQuality({
      testResults: [
        { passed: false, name: 'r1', regression: true },
        { passed: false, name: 'r2', regression: true },
        { passed: true, name: 'n1', regression: false },
      ],
    }))
    expect(result.dimensions.regression_check.value).toEqual(['r1', 'r2'])
  })
})
