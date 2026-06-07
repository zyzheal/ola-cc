import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  detectTier,
  getPolicyBufferTokens,
  getPolicyMaxCompactTokens,
  shouldUseAggressiveMicroCompact,
  isCompressionPolicyEnabled,
  DEFAULT_BUFFER_TOKENS,
  DEFAULT_MAX_COMPACT_TOKENS,
} from './CompressionPolicy'

describe('detectTier', () => {
  it('returns free for short sessions on free tier', () => {
    expect(detectTier(10, 20, false)).toBe('free')
  })

  it('returns paid for short sessions on paid tier', () => {
    expect(detectTier(10, 20, true)).toBe('paid')
  })

  it('returns long-session for old sessions', () => {
    expect(detectTier(90, 20, false)).toBe('long-session')
    expect(detectTier(90, 20, true)).toBe('long-session')
  })

  it('returns long-session for many messages', () => {
    expect(detectTier(10, 150, false)).toBe('long-session')
    expect(detectTier(10, 150, true)).toBe('long-session')
  })
})

describe('getPolicyBufferTokens', () => {
  beforeEach(() => {
    process.env.OLA_CC_COMPRESSION_POLICY = '1'
  })

  afterEach(() => {
    delete process.env.OLA_CC_COMPRESSION_POLICY
  })

  it('returns env override when provided', () => {
    expect(getPolicyBufferTokens('free', 10000)).toBe(10000)
  })

  it('returns GrowthBook value when provided', () => {
    expect(getPolicyBufferTokens('free', undefined, 30000)).toBe(30000)
  })

  it('returns tier-specific value when policy enabled', () => {
    expect(getPolicyBufferTokens('free')).toBe(20000)
    expect(getPolicyBufferTokens('paid')).toBe(60000)
    expect(getPolicyBufferTokens('long-session')).toBe(40000)
  })

  it('returns default when policy disabled', () => {
    delete process.env.OLA_CC_COMPRESSION_POLICY
    expect(getPolicyBufferTokens('free')).toBe(DEFAULT_BUFFER_TOKENS)
  })

  it('env override takes precedence over GrowthBook', () => {
    expect(getPolicyBufferTokens('free', 5000, 30000)).toBe(5000)
  })
})

describe('getPolicyMaxCompactTokens', () => {
  beforeEach(() => {
    process.env.OLA_CC_COMPRESSION_POLICY = '1'
  })

  afterEach(() => {
    delete process.env.OLA_CC_COMPRESSION_POLICY
  })

  it('returns tier-specific max tokens', () => {
    expect(getPolicyMaxCompactTokens('free')).toBe(30000)
    expect(getPolicyMaxCompactTokens('paid')).toBe(50000)
    expect(getPolicyMaxCompactTokens('long-session')).toBe(40000)
  })

  it('returns default when disabled', () => {
    delete process.env.OLA_CC_COMPRESSION_POLICY
    expect(getPolicyMaxCompactTokens('free')).toBe(DEFAULT_MAX_COMPACT_TOKENS)
  })
})

describe('shouldUseAggressiveMicroCompact', () => {
  beforeEach(() => {
    process.env.OLA_CC_COMPRESSION_POLICY = '1'
  })

  afterEach(() => {
    delete process.env.OLA_CC_COMPRESSION_POLICY
  })

  it('returns true for free tier', () => {
    expect(shouldUseAggressiveMicroCompact('free')).toBe(true)
  })

  it('returns false for paid tier', () => {
    expect(shouldUseAggressiveMicroCompact('paid')).toBe(false)
  })

  it('returns false when disabled', () => {
    delete process.env.OLA_CC_COMPRESSION_POLICY
    expect(shouldUseAggressiveMicroCompact('free')).toBe(false)
  })
})
