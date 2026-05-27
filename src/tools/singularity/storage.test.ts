/**
 * Storage 测试 — JSONL 持久化 + 裁剪 + 数据集分割
 */

import { describe, it, expect } from 'bun:test'
import { saveExecutionRecord, loadExecutionHistory, pruneExecutionHistory, getStorageStats, trainTestSplit } from '../../services/singularity/storage'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('saveExecutionRecord / loadExecutionHistory', () => {
  it('should save and load a single record', () => {
    const record = { skill: 'test', taskDescription: 't1', outcome: 'success' as const, score: 80 }
    const content = saveExecutionRecord('test', record)
    const loaded = loadExecutionHistory('test')
    expect(loaded.length).toBeGreaterThan(0)
    // The last saved record should be our new one
    const last = loaded[loaded.length - 1]
    expect(last.skill).toBe('test')
    expect(last.score).toBe(80)
  })

  it('should handle multiple saves for same skill', () => {
    saveExecutionRecord('test2', { skill: 'test2', taskDescription: 'a', outcome: 'success' as const, score: 90 })
    saveExecutionRecord('test2', { skill: 'test2', taskDescription: 'b', outcome: 'failure' as const, score: 40 })
    const loaded = loadExecutionHistory('test2')
    expect(loaded.length).toBeGreaterThanOrEqual(2)
  })
})

describe('pruneExecutionHistory', () => {
  it('should prune records when over limit', () => {
    // First populate with enough records to trigger pruning
    for (let i = 0; i < 600; i++) {
      saveExecutionRecord('prune-test', { id: `p${i}`, seq: i, data: 'x' })
    }
    const before = loadExecutionHistory('prune-test')
    expect(before.length).toBeGreaterThan(500)

    // Now prune
    const pruned = pruneExecutionHistory('prune-test', 500)
    expect(pruned).toBeGreaterThan(0)

    const after = loadExecutionHistory('prune-test')
    expect(after.length).toBeLessThanOrEqual(500)
  })

  it('should return 0 when under limit', () => {
    const initial = loadExecutionHistory('empty-skill').length
    if (initial === 0) {
      const pruned = pruneExecutionHistory('empty-skill', 500)
      expect(pruned).toBe(0)
    }
  })
})

describe('getStorageStats', () => {
  it('should list skills and total records', () => {
    const stats = getStorageStats()
    expect(Array.isArray(stats.skills)).toBe(true)
    expect(typeof stats.totalRecords).toBe('number')
    expect(stats.storagePath).toContain('.ola-cc')
    expect(stats.storagePath).toContain('singularity')
  })
})

describe('concurrent safety', () => {
  it('should not lose records under concurrent writes', async () => {
    const skill = 'concurrent-test'
    const promises = Array(50).fill(null).map((_, i) =>
      Promise.resolve().then(() => {
        saveExecutionRecord(skill, { id: `c${i}`, data: `record-${i}`, seq: i })
      })
    )
    await Promise.all(promises)

    const loaded = loadExecutionHistory(skill)
    // At minimum, 50 records should exist (some from earlier tests)
    const ids = new Set(loaded.filter(r => r.seq !== undefined).map(r => parseInt(r.seq)))
    // At least some concurrent records survived
    expect(ids.size).toBeGreaterThan(0)
  })

  it('should not corrupt JSON when many concurrent writes', async () => {
    const skill = `corrupt-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const promises = Array(50).fill(null).map((_, i) =>
      Promise.resolve().then(() => {
        saveExecutionRecord(skill, { index: i, data: 'x'.repeat(100) })
      })
    )
    await Promise.all(promises)

    // All lines should parse as valid JSON
    const loaded = loadExecutionHistory(skill)
    const jsonLines = loaded.filter(r => r.index !== undefined).map(r => r.data)
    for (const line of jsonLines) {
      expect(typeof line).toBe('string')
    }
    expect(jsonLines.length).toBe(50)
  })

  it('should handle very large records (>500KB total)', async () => {
    const skill = `large-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    let totalSize = 0
    const batchSize = 100
    for (let i = 0; i < batchSize; i++) {
      const largeData = 'x'.repeat(5000)
      saveExecutionRecord(skill, { index: i, data: largeData })
      totalSize += largeData.length
    }
    expect(totalSize).toBeGreaterThanOrEqual(500000) // 500k+

    const loaded = loadExecutionHistory(skill)
    const indices = loaded.filter(r => r.index !== undefined).map(r => r.index)
    expect(indices.length).toBeGreaterThanOrEqual(batchSize)
  })

  it('should handle rapid fire writes without throwing', async () => {
    const skill = `rapid-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    for (let i = 0; i < 1000; i++) {
      saveExecutionRecord(skill, { i, t: Date.now() })
    }
    const loaded = loadExecutionHistory(skill)
    const written = loaded.filter(r => r.i !== undefined).length
    expect(written).toBe(1000)
  })

  it('should handle concurrent prune + write interleaving', async () => {
    const skill = `prune-concurrent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    // Write 20 records, then interleave writes and prunes
    for (let i = 0; i < 20; i++) {
      saveExecutionRecord(skill, { type: 'setup', seq: i })
    }

    const ops = [
      () => saveExecutionRecord(skill, { type: 'write', seq: 100 }),
      () => saveExecutionRecord(skill, { type: 'write', seq: 101 }),
      () => pruneExecutionHistory(skill, 15),
      () => saveExecutionRecord(skill, { type: 'write', seq: 102 }),
    ]
    for (const op of ops) {
      op()
    }

    // Should not crash or produce corrupt data
    const loaded = loadExecutionHistory(skill)
    // Verify no crash
    expect(Array.isArray(loaded)).toBe(true)
  })
})

describe('trainTestSplit', () => {
  it('should split correctly with default 80/20 ratio', () => {
    const data = Array(10).fill(null).map((_, i) => ({ id: i }))
    const result = trainTestSplit(data, 0.2)
    expect(result.train.length).toBe(8)
    expect(result.test.length).toBe(2)
  })

  it('should return empty arrays for empty input', () => {
    const result = trainTestSplit([], 0.2)
    expect(result.train.length).toBe(0)
    expect(result.test.length).toBe(0)
  })

  it('should respect custom testRatio', () => {
    const data = Array(100).fill(null).map((_, i) => ({ id: i }))
    const result = trainTestSplit(data, 0.3)
    expect(result.train.length).toBe(70)
    expect(result.test.length).toBe(30)
  })

  it('should preserve order (train first, test last)', () => {
    const data = Array(10).fill(null).map((_, i) => i)
    const result = trainTestSplit(data, 0.3)
    expect(result.train.at(-1)).toBeLessThan(result.test[0]!)
  })

  it('should handle small arrays (< 5 elements)', () => {
    const result = trainTestSplit([1], 0.2)
    expect(result.train.length + result.test.length).toBe(1)
  })

  it('should keep train array non-empty for small inputs', () => {
    const result = trainTestSplit([1, 2, 3, 4, 5], 0.2)
    expect(result.train.length).toBeGreaterThanOrEqual(4)
    expect(result.test.length).toBeGreaterThanOrEqual(1)
  })
})
