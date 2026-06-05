/**
 * ErrorRecovery — 4 层错误恢复策略
 *
 * Layer 1: 算法超时恢复 (withTimeout)
 * Layer 2: DB 损坏恢复 (withDbProtection)
 * Layer 3: Grok 降级 (withGrokDegradation)
 * Layer 4: 合并多个恢复结果 (merge)
 */

// ============================================================
// Types
// ============================================================

export interface RecoveryResult<T> {
  data?: T
  degraded: boolean
  errors: RecoveryError[]
  warnings: string[]
}

export interface RecoveryError {
  layer: 'algorithm' | 'database' | 'grok' | 'sync'
  code: string
  message: string
  suggestion?: string
  recoverable: boolean
}

// ============================================================
// ErrorRecovery
// ============================================================

export class ErrorRecovery {
  /**
   * Layer 1: 包装算法执行，带超时 + 降级返回
   *
   * - promise 在 ms 内完成 → 返回结果
   * - promise 超时或 reject → 返回 fallback
   */
  static async withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const timeoutPromise = new Promise<T>((resolve) => {
      timeoutId = setTimeout(() => resolve(fallback), ms)
    })

    try {
      const result = await Promise.race([promise, timeoutPromise])
      return result
    } catch {
      return fallback
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }

  /**
   * Layer 2: 执行函数，捕获 DB 损坏错误
   *
   * - SQLITE_CORRUPT / SQLITE_NOTADB → 返回降级结果 + 错误信息
   * - 其他错误 → 重新抛出
   */
  static withDbProtection<T>(fn: () => T, fallback: T): RecoveryResult<T> {
    try {
      const data = fn()
      return { data, degraded: false, errors: [], warnings: [] }
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'SQLITE_CORRUPT' || err.code === 'SQLITE_NOTADB' ||
          err.message?.includes('malformed') || err.message?.includes('not a database')) {
        return {
          data: fallback,
          degraded: true,
          errors: [{
            layer: 'database',
            code: 'DB_CORRUPT',
            message: `数据库损坏: ${err.message}`,
            suggestion: 'codegraph_init rebuild',
            recoverable: true,
          }],
          warnings: ['数据库损坏，已降级到空数据。请执行 codegraph_init rebuild 重建数据库。'],
        }
      }
      throw e
    }
  }

  /**
   * Layer 3: 执行函数，Grok 不可用时降级到 codegraph-only 模式
   *
   * - ENOENT (文件不存在) → 降级 + GROK_UNAVAILABLE
   * - SyntaxError (JSON 解析失败) → 降级 + GROK_PARSE_ERROR
   * - 其他错误 → 降级 + GROK_UNKNOWN_ERROR
   */
  static withGrokDegradation<T>(fn: () => T, fallback: T): RecoveryResult<T> {
    try {
      const data = fn()
      return { data, degraded: false, errors: [], warnings: [] }
    } catch (e) {
      const err = e as Error & { code?: string }
      let code: string
      let message: string

      if (err.code === 'ENOENT') {
        code = 'GROK_UNAVAILABLE'
        message = '知识图谱文件不存在，降级到 codegraph-only 模式'
      } else if (e instanceof SyntaxError) {
        code = 'GROK_PARSE_ERROR'
        message = `知识图谱 JSON 解析失败: ${err.message}`
      } else {
        code = 'GROK_UNKNOWN_ERROR'
        message = `知识图谱加载失败: ${err.message}`
      }

      return {
        data: fallback,
        degraded: true,
        errors: [{
          layer: 'grok',
          code,
          message,
          recoverable: false,
        }],
        warnings: ['Grok 数据不可用，已降级到 codegraph-only 模式。结果可能缺少语义信息。'],
      }
    }
  }

  /**
   * Layer 4: 合并多个 RecoveryResult
   *
   * - data: 最后一个有 data 的结果
   * - degraded: 任一结果 degraded 则为 true
   * - errors: 收集所有错误
   * - warnings: 收集所有警告
   */
  static merge<T>(...results: RecoveryResult<T>[]): RecoveryResult<T> {
    if (results.length === 0) {
      return { data: undefined, degraded: false, errors: [], warnings: [] }
    }

    let data: T | undefined
    let degraded = false
    const errors: RecoveryError[] = []
    const warnings: string[] = []

    for (const result of results) {
      if (result.data !== undefined) data = result.data
      if (result.degraded) degraded = true
      errors.push(...result.errors)
      warnings.push(...result.warnings)
    }

    return { data, degraded, errors, warnings }
  }
}
