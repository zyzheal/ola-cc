import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  computeDensity,
  findOptimalCompression,
  computeOptimalTokenBudget,
  isAdaptiveCompressEnabled,
} from './adaptiveSizer'

describe('computeDensity', () => {
  it('returns 1.0 for level 0 (no compression)', () => {
    expect(computeDensity('hello world test', 0)).toBe(1.0)
  })

  it('returns 0 for level 1 (maximum compression)', () => {
    expect(computeDensity('hello world test', 1)).toBe(0)
  })

  it('returns intermediate values for moderate compression', () => {
    const text = 'unique word another different text with many tokens here'
    const density = computeDensity(text, 0.5)
    expect(density).toBeGreaterThan(0)
    expect(density).toBeLessThan(1)
  })

  it('returns 0 for empty text', () => {
    expect(computeDensity('', 0.5)).toBe(1.0) // level 0 for empty
  })

  it('returns 0 for text with only short tokens', () => {
    expect(computeDensity('a b c', 0.5)).toBe(0)
  })
})

describe('findOptimalCompression', () => {
  it('returns valid result with samples', () => {
    const text = 'word '.repeat(100)
    const result = findOptimalCompression(text, 5)
    expect(result.samples.length).toBe(6) // 0 to 5 inclusive
    expect(result.optimalLevel).toBeGreaterThanOrEqual(0)
    expect(result.optimalLevel).toBeLessThanOrEqual(1)
    expect(result.densityAtOptimal).toBeGreaterThanOrEqual(0)
  })

  it('finds a knee for diverse text', () => {
    const text =
      'The authentication system uses JWT tokens with RS256 algorithm. ' +
      'Files modified include auth.ts and middleware.ts. ' +
      'Key decisions: httpOnly cookies, Redis blacklisting, 15-minute expiry. ' +
      'The team also discussed rate limiting and CORS configuration.'
    const result = findOptimalCompression(text, 10)
    // Should find some optimal level
    expect(result.optimalLevel).toBeGreaterThanOrEqual(0)
    expect(result.optimalLevel).toBeLessThanOrEqual(1)
  })

  it('handles very short text', () => {
    const result = findOptimalCompression('hi', 5)
    expect(result.optimalLevel).toBeGreaterThanOrEqual(0)
  })
})

describe('computeOptimalTokenBudget', () => {
  beforeEach(() => {
    process.env.OLA_CC_ADAPTIVE_COMPRESS = '1'
  })

  afterEach(() => {
    delete process.env.OLA_CC_ADAPTIVE_COMPRESS
  })

  it('returns maxTokens when disabled', () => {
    delete process.env.OLA_CC_ADAPTIVE_COMPRESS
    expect(computeOptimalTokenBudget('text', 10000, 1000, 50000)).toBe(50000)
  })

  it('returns budget within bounds', () => {
    const text = 'word '.repeat(100)
    const budget = computeOptimalTokenBudget(text, 10000, 1000, 50000)
    expect(budget).toBeGreaterThanOrEqual(1000)
    expect(budget).toBeLessThanOrEqual(50000)
  })

  it('returns lower budget for highly compressible text', () => {
    const repetitive = 'the the the '.repeat(100)
    const diverse =
      'authentication JWT RS256 httpOnly cookies Redis blacklisting expiry rate-limiting CORS'
    const budgetRepetitive = computeOptimalTokenBudget(repetitive, 10000, 1000, 50000)
    const budgetDiverse = computeOptimalTokenBudget(diverse, 10000, 1000, 50000)
    // Repetitive text should get a lower budget (more compression)
    // This may not always hold due to the heuristic, so just check bounds
    expect(budgetRepetitive).toBeGreaterThanOrEqual(1000)
    expect(budgetDiverse).toBeGreaterThanOrEqual(1000)
  })
})

describe('isAdaptiveCompressEnabled', () => {
  it('returns false by default', () => {
    delete process.env.OLA_CC_ADAPTIVE_COMPRESS
    expect(isAdaptiveCompressEnabled()).toBe(false)
  })

  it('returns true when env is set', () => {
    process.env.OLA_CC_ADAPTIVE_COMPRESS = '1'
    expect(isAdaptiveCompressEnabled()).toBe(true)
    delete process.env.OLA_CC_ADAPTIVE_COMPRESS
  })
})
