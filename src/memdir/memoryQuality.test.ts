/**
 * Tests for memory quality validation and scoring.
 */

import { describe, it, expect } from 'bun:test'
import { validateMemoryQuality, isDuplicate, qualityScore } from './memoryQuality.js'
import type { MemoryDoc } from './index.js'

describe('validateMemoryQuality', () => {
  it('should accept valid memory', () => {
    const result = validateMemoryQuality('user_role', 'user', 'User is a senior engineer with deep Go experience')
    expect(result.ok).toBe(true)
  })

  it('should reject short name', () => {
    const result = validateMemoryQuality('a', 'user', 'some content here')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('too short')
    }
  })

  it('should reject invalid type', () => {
    const result = validateMemoryQuality('test', 'invalid_type', 'some content here')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('Invalid memory type')
    }
  })

  it('should reject content too short', () => {
    const result = validateMemoryQuality('test', 'project', 'hi')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('too short')
    }
  })

  it('should reject content too long', () => {
    const longContent = 'x'.repeat(2001)
    const result = validateMemoryQuality('test', 'project', longContent)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('too long')
    }
  })

  it('should reject derivable content patterns', () => {
    const result = validateMemoryQuality('test', 'project', 'This describes the git log and code patterns in this project')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('derivable')
    }
  })

  it('should accept all valid types', () => {
    for (const type of ['user', 'feedback', 'project', 'reference']) {
      const result = validateMemoryQuality('test', type, 'valid memory content here for testing')
      expect(result.ok).toBe(true)
    }
  })
})

describe('isDuplicate', () => {
  const existingDocs: MemoryDoc[] = [
    {
      id: 1,
      name: 'user_role',
      description: 'User background',
      content: 'Senior engineer with Go expertise',
      type: 'user',
      mtimeMs: Date.now(),
    },
    {
      id: 2,
      name: 'testing_policy',
      description: 'Testing conventions',
      content: 'Always use real database in tests',
      type: 'feedback',
      mtimeMs: Date.now(),
    },
  ]

  it('should detect exact name duplicate', () => {
    expect(isDuplicate('user_role', 'new content', existingDocs)).toBe(true)
  })

  it('should allow unique names', () => {
    expect(isDuplicate('deployment_info', 'deploy info', existingDocs)).toBe(false)
  })

  it('should detect highly similar content', () => {
    expect(isDuplicate('go_expert', 'Senior engineer with deep Go expertise', existingDocs, 0.5)).toBe(true)
  })
})

describe('qualityScore', () => {
  const makeDoc = (overrides: Partial<MemoryDoc> = {}): MemoryDoc => ({
    id: 1,
    name: 'test',
    description: null,
    content: '',
    type: 'project',
    mtimeMs: Date.now(),
    ...overrides,
  })

  it('should score high for well-structured memory', () => {
    const doc = makeDoc({
      description: 'A detailed description of something important',
      content: 'This is the content. Why: because of reasons. How to apply: do this thing. For example: see the docs.',
      type: 'feedback',
      mtimeMs: Date.now(),
    })
    expect(qualityScore(doc)).toBeGreaterThan(0.7)
  })

  it('should score low for empty memory', () => {
    const doc = makeDoc({
      description: null,
      content: 'short',
      mtimeMs: Date.now() - 200 * 86400000, // 200 days ago
    })
    expect(qualityScore(doc)).toBeLessThan(0.3)
  })

  it('should give recency bonus', () => {
    const fresh = makeDoc({ mtimeMs: Date.now() })
    const stale = makeDoc({ mtimeMs: Date.now() - 100 * 86400000 })
    // Otherwise identical
    expect(qualityScore(fresh)).toBeGreaterThan(qualityScore(stale))
  })
})
