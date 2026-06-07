import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  scoreCompactQuality,
  validateCompactQuality,
  isCompactQualityEnabled,
} from './compactQuality'

describe('scoreCompactQuality', () => {
  it('scores a good summary highly', () => {
    const summary =
      'The conversation discussed implementing a new authentication system using JWT tokens. ' +
      'Key decisions: use RS256 algorithm, store tokens in httpOnly cookies, implement refresh token rotation. ' +
      'Files modified: auth.ts, middleware.ts, config.ts. ' +
      'The team decided to use Redis for token blacklisting and set expiry to 15 minutes for access tokens.'
    const result = scoreCompactQuality(summary, 10000, 500)
    expect(result.score).toBeGreaterThan(0.3)
    expect(result.passes).toBe(true)
  })

  it('penalizes too-short summaries', () => {
    const summary = 'Did stuff.'
    const result = scoreCompactQuality(summary, 10000, 50)
    expect(result.score).toBeLessThan(0.6)
    expect(result.breakdown.lengthScore).toBeLessThan(1.0)
  })

  it('penalizes too-verbose summaries', () => {
    // Summary that's 60% of original — too verbose
    const summary = 'word '.repeat(6000)
    const result = scoreCompactQuality(summary, 10000, 6000)
    expect(result.breakdown.lengthScore).toBeLessThan(1.0)
  })

  it('penalizes low information density', () => {
    // Repetitive text
    const summary = 'the the the the the the the the the the. '.repeat(10)
    const result = scoreCompactQuality(summary, 10000, 400)
    expect(result.breakdown.densityScore).toBeLessThan(0.8)
  })

  it('penalizes poor structure (single sentence)', () => {
    const summary = 'a'.repeat(200) // One long "sentence"
    const result = scoreCompactQuality(summary, 10000, 200)
    expect(result.breakdown.structureScore).toBeLessThan(1.0)
  })

  it('handles empty summary', () => {
    const result = scoreCompactQuality('', 10000, 0)
    expect(result.score).toBe(0)
    expect(result.passes).toBe(false)
  })

  it('handles zero original tokens', () => {
    const result = scoreCompactQuality('some text here', 0, 100)
    expect(result.breakdown.lengthRatio).toBe(0)
  })
})

describe('validateCompactQuality', () => {
  beforeEach(() => {
    process.env.OLA_CC_COMPACT_QUALITY = '1'
  })

  afterEach(() => {
    delete process.env.OLA_CC_COMPACT_QUALITY
  })

  it('returns true for good summaries', () => {
    const summary =
      'Implemented JWT authentication with RS256 algorithm. Files modified: auth.ts, middleware.ts. ' +
      'Decision: use httpOnly cookies for token storage. Set up Redis for token blacklisting.'
    expect(validateCompactQuality(summary, 10000, 300)).toBe(true)
  })

  it('returns false for very poor summaries', () => {
    expect(validateCompactQuality('ok', 10000, 10)).toBe(false)
  })

  it('returns true when disabled', () => {
    delete process.env.OLA_CC_COMPACT_QUALITY
    expect(validateCompactQuality('ok', 10000, 10)).toBe(true)
  })
})

describe('isCompactQualityEnabled', () => {
  it('returns false by default', () => {
    delete process.env.OLA_CC_COMPACT_QUALITY
    expect(isCompactQualityEnabled()).toBe(false)
  })

  it('returns true when env is set', () => {
    process.env.OLA_CC_COMPACT_QUALITY = '1'
    expect(isCompactQualityEnabled()).toBe(true)
    delete process.env.OLA_CC_COMPACT_QUALITY
  })
})
