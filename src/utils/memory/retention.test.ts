import { describe, it, expect } from 'bun:test'
import { computeRetention, getTier, TYPE_SALIENCE, RETENTION_TIERS } from './retention'

describe('computeRetention', () => {
  it('returns high score for fresh high-salience memory', () => {
    const result = computeRetention({
      type: 'architecture',
      daysSinceCreation: 0,
    })
    expect(result.score).toBeCloseTo(TYPE_SALIENCE.architecture, 2)
    expect(result.tier).toBe('hot')
  })

  it('decays over time', () => {
    const fresh = computeRetention({ type: 'fact', daysSinceCreation: 0 })
    const old = computeRetention({ type: 'fact', daysSinceCreation: 30 })
    expect(fresh.score).toBeGreaterThan(old.score)
  })

  it('λ=0.5 produces meaningful decay for 1-3 hour sessions', () => {
    // 1 hour = 0.042 days → exp(-0.5*0.042) ≈ 0.979 → 2% decay
    const after1h = computeRetention({ type: 'fact', daysSinceCreation: 0.042 })
    // 3 hours = 0.125 days → exp(-0.5*0.125) ≈ 0.939 → 6% decay
    const after3h = computeRetention({ type: 'fact', daysSinceCreation: 0.125 })
    expect(after1h.score).toBeGreaterThan(after3h.score)
    // Verify meaningful difference
    expect(after1h.score - after3h.score).toBeGreaterThan(0.01)
  })

  it('reinforcement boost from recent accesses', () => {
    const now = Date.now()
    const withAccess = computeRetention({
      type: 'fact',
      daysSinceCreation: 10,
      accessTimestamps: [now - 1000], // 1 second ago
    })
    const withoutAccess = computeRetention({
      type: 'fact',
      daysSinceCreation: 10,
    })
    expect(withAccess.score).toBeGreaterThan(withoutAccess.score)
    expect(withAccess.breakdown.reinforcementBoost).toBeGreaterThan(0)
  })

  it('singularity fix: no division by zero for very recent access', () => {
    const now = Date.now()
    const result = computeRetention({
      type: 'fact',
      daysSinceCreation: 0,
      accessTimestamps: [now], // 0 days ago
    })
    expect(Number.isFinite(result.score)).toBe(true)
    expect(result.breakdown.reinforcementBoost).toBeLessThanOrEqual(0.5) // capped by maxBoost
  })

  it('B1-2 fix: boost is capped by maxBoost', () => {
    const now = Date.now()
    // 50 recent accesses would produce huge uncapped boost
    const timestamps = Array.from({ length: 50 }, () => now - 1000)
    const result = computeRetention({
      type: 'fact',
      daysSinceCreation: 0,
      accessTimestamps: timestamps,
      params: { maxBoost: 0.5 },
    })
    expect(result.breakdown.reinforcementBoost).toBeLessThanOrEqual(0.5)
  })

  it('ignores accesses outside window', () => {
    const now = Date.now()
    const old = computeRetention({
      type: 'fact',
      daysSinceCreation: 10,
      accessTimestamps: [now - 60 * 24 * 60 * 60 * 1000], // 60 days ago
    })
    const fresh = computeRetention({
      type: 'fact',
      daysSinceCreation: 10,
    })
    // Old access outside 30-day window should not boost
    expect(old.score).toBeCloseTo(fresh.score, 5)
  })

  it('caps score at 1.0', () => {
    const now = Date.now()
    const result = computeRetention({
      type: 'architecture', // 0.90 salience
      daysSinceCreation: 0,
      accessTimestamps: Array.from({ length: 10 }, () => now - 1000),
    })
    expect(result.score).toBeLessThanOrEqual(1)
  })

  it('floors score at 0', () => {
    const result = computeRetention({
      type: 'fact',
      daysSinceCreation: 1000, // very old
    })
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('uses default salience for unknown types', () => {
    const result = computeRetention({
      type: 'unknown_type',
      daysSinceCreation: 0,
    })
    expect(result.breakdown.salience).toBe(TYPE_SALIENCE.fact)
  })
})

describe('getTier', () => {
  it('classifies hot', () => expect(getTier(0.8)).toBe('hot'))
  it('classifies warm', () => expect(getTier(0.5)).toBe('warm'))
  it('classifies cold', () => expect(getTier(0.2)).toBe('cold'))
  it('classifies evictable', () => expect(getTier(0.05)).toBe('evictable'))
  it('boundary: exactly hot', () => expect(getTier(0.70)).toBe('hot'))
  it('boundary: just below hot', () => expect(getTier(0.69)).toBe('warm'))
})
