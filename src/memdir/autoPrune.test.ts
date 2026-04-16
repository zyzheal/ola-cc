/**
 * Tests for automatic pruning and memory health reports.
 */

import { describe, it, expect } from 'bun:test'
import { findPruneCandidates, findContradictions, generatePruningReport } from './autoPrune.js'
import type { MemoryDoc } from './index.js'

describe('findPruneCandidates', () => {
  const makeDoc = (
    id: number,
    name: string,
    type: string,
    daysAgo: number,
    content = `${name} content with some meaningful text`,
    description: string | null = `desc for ${name}`,
  ): MemoryDoc => ({
    id,
    name,
    description,
    content,
    type,
    mtimeMs: Date.now() - daysAgo * 86400000,
  })

  it('should return empty for healthy memories', () => {
    const docs = [makeDoc(1, 'good', 'feedback', 5)]
    const candidates = findPruneCandidates(docs)
    expect(candidates.length).toBe(0)
  })

  it('should flag stale non-feedback memories', () => {
    const docs = [makeDoc(1, 'old_project', 'project', 200)]
    const candidates = findPruneCandidates(docs)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].reason).toContain('Stale')
  })

  it('should not flag stale feedback memories', () => {
    const docs = [makeDoc(1, 'old_feedback', 'feedback', 200)]
    const candidates = findPruneCandidates(docs)
    // Feedback is timeless - should only be pruned for low quality, not age
    const ageCandidates = candidates.filter(c => c.reason.includes('Stale'))
    expect(ageCandidates.length).toBe(0)
  })

  it('should enforce max memory limit', () => {
    const docs = Array.from({ length: 510 }, (_, i) =>
      makeDoc(i, `mem_${i}`, 'project', i),
    )
    const candidates = findPruneCandidates(docs, { maxMemories: 500 })
    expect(candidates.length).toBeGreaterThanOrEqual(10)
  })

  it('should report reason correctly', () => {
    // Very old project memory with empty content and no description
    const docs = [makeDoc(1, 'dead', 'project', 200, '', null)]
    const candidates = findPruneCandidates(docs)
    expect(candidates.length).toBeGreaterThan(0)
    // Caught by quality score first (0.10 < 0.2 threshold)
    expect(candidates[0].reason).toContain('Low quality')
  })
})

describe('findContradictions', () => {
  const makeDoc = (id: number, name: string, content: string): MemoryDoc => ({
    id,
    name,
    description: null,
    content,
    type: 'feedback',
    mtimeMs: Date.now(),
  })

  it('should find memories with similar names', () => {
    const docs = [
      makeDoc(1, 'testing_convention_rules', 'use real db'),
      makeDoc(2, 'testing_convention_rules_v2', 'use mocks'),
    ]
    const contradictions = findContradictions(docs)
    expect(contradictions.length).toBeGreaterThan(0)
  })

  it('should not flag unrelated memories', () => {
    const docs = [
      makeDoc(1, 'database_setup', 'postgres config'),
      makeDoc(2, 'frontend_colors', 'blue theme'),
    ]
    const contradictions = findContradictions(docs)
    expect(contradictions.length).toBe(0)
  })

  it('should only compare within same type', () => {
    const docs = [
      { ...makeDoc(1, 'testing', 'use real db'), type: 'feedback' as const },
      { ...makeDoc(2, 'testing', 'use mocks'), type: 'project' as const },
    ]
    const contradictions = findContradictions(docs as MemoryDoc[])
    // Different types should not trigger contradiction
    expect(contradictions.length).toBe(0)
  })
})

describe('generatePruningReport', () => {
  const makeDoc = (id: number, type: string, daysAgo: number): MemoryDoc => ({
    id,
    name: `mem_${id}`,
    description: `desc ${id}`,
    content: `content for memory number ${id} with some detail`,
    type,
    mtimeMs: Date.now() - daysAgo * 86400000,
  })

  it('should report correct total count', () => {
    const docs = [
      makeDoc(1, 'user', 1),
      makeDoc(2, 'feedback', 5),
      makeDoc(3, 'project', 10),
    ]
    const report = generatePruningReport(docs)
    expect(report.total).toBe(3)
  })

  it('should count stale memories', () => {
    const docs = [
      makeDoc(1, 'project', 1),
      makeDoc(2, 'project', 200),
      makeDoc(3, 'project', 365),
    ]
    const report = generatePruningReport(docs)
    expect(report.staleCount).toBe(2)
  })

  it('should count memory types', () => {
    const docs = [
      makeDoc(1, 'user', 1),
      makeDoc(2, 'user', 2),
      makeDoc(3, 'feedback', 3),
    ]
    const report = generatePruningReport(docs)
    expect(report.types.user).toBe(2)
    expect(report.types.feedback).toBe(1)
  })

  it('should report avg quality between 0 and 1', () => {
    const docs = [makeDoc(1, 'project', 1)]
    const report = generatePruningReport(docs)
    expect(report.avgQuality).toBeGreaterThanOrEqual(0)
    expect(report.avgQuality).toBeLessThanOrEqual(1)
  })
})
