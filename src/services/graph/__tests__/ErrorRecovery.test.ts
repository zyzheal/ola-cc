/**
 * ErrorRecovery 测试 — 4 层错误恢复策略
 *
 * Layer 1: 算法超时恢复 (withTimeout)
 * Layer 2: DB 损坏恢复 (withDbProtection)
 * Layer 3: Grok 降级 (withGrokDegradation)
 * Layer 4: 同步冲突恢复 (merge)
 */

import { describe, test, expect } from 'bun:test'
import { ErrorRecovery, type RecoveryResult, type RecoveryError } from '../ErrorRecovery.js'

describe('ErrorRecovery', () => {
  // ============================================================
  // Layer 1: Algorithm timeout recovery
  // ============================================================

  describe('withTimeout', () => {
    test('should return result when promise resolves within timeout', async () => {
      const fastPromise = Promise.resolve(42)
      const result = await ErrorRecovery.withTimeout(fastPromise, 1000, 0)
      expect(result).toBe(42)
    })

    test('should return fallback when promise exceeds timeout', async () => {
      const slowPromise = new Promise<number>(resolve => setTimeout(() => resolve(42), 200))
      const result = await ErrorRecovery.withTimeout(slowPromise, 50, -1)
      expect(result).toBe(-1)
    })

    test('should return fallback when promise rejects', async () => {
      const rejectingPromise = Promise.reject(new Error('algorithm failed'))
      const result = await ErrorRecovery.withTimeout(rejectingPromise, 1000, 'fallback')
      expect(result).toBe('fallback')
    })

    test('should handle complex objects as fallback', async () => {
      const fallback = { scores: [], partial: true }
      const rejectingPromise = Promise.reject(new Error('timeout'))
      const result = await ErrorRecovery.withTimeout(rejectingPromise, 100, fallback)
      expect(result).toEqual({ scores: [], partial: true })
    })
  })

  // ============================================================
  // Layer 2: DB corruption recovery
  // ============================================================

  describe('withDbProtection', () => {
    test('should return data when function succeeds', () => {
      const result = ErrorRecovery.withDbProtection(() => 'hello', 'fallback')
      expect(result.data).toBe('hello')
      expect(result.degraded).toBe(false)
      expect(result.errors).toEqual([])
    })

    test('should catch SQLITE_CORRUPT and return degraded result', () => {
      const corruptFn = () => {
        const err = new Error('database disk image is malformed')
        ;(err as any).code = 'SQLITE_CORRUPT'
        throw err
      }

      const result = ErrorRecovery.withDbProtection(corruptFn, null)
      expect(result.data).toBeNull()
      expect(result.degraded).toBe(true)
      expect(result.errors.length).toBe(1)
      expect(result.errors[0].layer).toBe('database')
      expect(result.errors[0].code).toBe('DB_CORRUPT')
      expect(result.errors[0].recoverable).toBe(true)
      expect(result.errors[0].suggestion).toContain('codegraph_init')
    })

    test('should catch SQLITE_NOTADB and return degraded result', () => {
      const notADBFn = () => {
        const err = new Error('file is not a database')
        ;(err as any).code = 'SQLITE_NOTADB'
        throw err
      }

      const result = ErrorRecovery.withDbProtection(notADBFn, [])
      expect(result.data).toEqual([])
      expect(result.degraded).toBe(true)
      expect(result.errors[0].code).toBe('DB_CORRUPT')
    })

    test('should re-throw non-SQLITE errors', () => {
      const throwFn = () => {
        throw new Error('some other error')
      }

      expect(() => ErrorRecovery.withDbProtection(throwFn, null)).toThrow('some other error')
    })
  })

  // ============================================================
  // Layer 3: Grok degradation
  // ============================================================

  describe('withGrokDegradation', () => {
    test('should return data when function succeeds', () => {
      const result = ErrorRecovery.withGrokDegradation(() => ({ nodes: 10 }), { nodes: 0 })
      expect(result.data).toEqual({ nodes: 10 })
      expect(result.degraded).toBe(false)
      expect(result.errors).toEqual([])
    })

    test('should degrade gracefully when Grok JSON is missing', () => {
      const missingFn = () => {
        const err = new Error('ENOENT: no such file or directory')
        ;(err as any).code = 'ENOENT'
        throw err
      }

      const result = ErrorRecovery.withGrokDegradation(missingFn, { nodes: 0 })
      expect(result.data).toEqual({ nodes: 0 })
      expect(result.degraded).toBe(true)
      expect(result.errors.length).toBe(1)
      expect(result.errors[0].layer).toBe('grok')
      expect(result.errors[0].code).toBe('GROK_UNAVAILABLE')
      expect(result.errors[0].recoverable).toBe(false)
    })

    test('should degrade gracefully when Grok JSON is corrupt', () => {
      const corruptFn = () => {
        throw new SyntaxError('Unexpected token in JSON at position 0')
      }

      const result = ErrorRecovery.withGrokDegradation(corruptFn, { nodes: 0 })
      expect(result.data).toEqual({ nodes: 0 })
      expect(result.degraded).toBe(true)
      expect(result.errors[0].code).toBe('GROK_PARSE_ERROR')
    })

    test('should include warning about degraded mode', () => {
      const missingFn = () => {
        const err = new Error('ENOENT')
        ;(err as any).code = 'ENOENT'
        throw err
      }

      const result = ErrorRecovery.withGrokDegradation(missingFn, null)
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.warnings[0]).toContain('降级')
    })
  })

  // ============================================================
  // Layer 4: merge multiple recovery results
  // ============================================================

  describe('merge', () => {
    test('should merge two non-degraded results', () => {
      const r1: RecoveryResult<number> = { data: 1, degraded: false, errors: [], warnings: [] }
      const r2: RecoveryResult<number> = { data: 2, degraded: false, errors: [], warnings: [] }
      const merged = ErrorRecovery.merge(r1, r2)
      expect(merged.data).toBe(2) // last wins
      expect(merged.degraded).toBe(false)
      expect(merged.errors).toEqual([])
    })

    test('should mark merged result as degraded if any input is degraded', () => {
      const r1: RecoveryResult<number> = { data: 1, degraded: false, errors: [], warnings: [] }
      const r2: RecoveryResult<number> = { data: 2, degraded: true, errors: [], warnings: ['warn'] }
      const merged = ErrorRecovery.merge(r1, r2)
      expect(merged.degraded).toBe(true)
    })

    test('should collect all errors from merged results', () => {
      const err1: RecoveryError = { layer: 'database', code: 'DB_CORRUPT', message: 'corrupt', recoverable: true }
      const err2: RecoveryError = { layer: 'grok', code: 'GROK_UNAVAILABLE', message: 'missing', recoverable: false }
      const r1: RecoveryResult<number> = { data: 1, degraded: true, errors: [err1], warnings: [] }
      const r2: RecoveryResult<number> = { data: 2, degraded: true, errors: [err2], warnings: [] }
      const merged = ErrorRecovery.merge(r1, r2)
      expect(merged.errors.length).toBe(2)
      expect(merged.errors[0].layer).toBe('database')
      expect(merged.errors[1].layer).toBe('grok')
    })

    test('should collect all warnings from merged results', () => {
      const r1: RecoveryResult<number> = { data: 1, degraded: false, errors: [], warnings: ['w1'] }
      const r2: RecoveryResult<number> = { data: 2, degraded: false, errors: [], warnings: ['w2', 'w3'] }
      const merged = ErrorRecovery.merge(r1, r2)
      expect(merged.warnings).toEqual(['w1', 'w2', 'w3'])
    })

    test('should handle merging empty results', () => {
      const merged = ErrorRecovery.merge()
      expect(merged.data).toBeUndefined()
      expect(merged.degraded).toBe(false)
      expect(merged.errors).toEqual([])
      expect(merged.warnings).toEqual([])
    })
  })
})
