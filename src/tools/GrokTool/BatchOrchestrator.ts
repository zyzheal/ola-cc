/**
 * BatchOrchestrator — 批量 LLM 编排模式 (F-105)
 *
 * 将大批量任务拆分为小批次，支持并发控制、重试、断点续传，
 * 用于 Grok 批量分析等场景。
 *
 * 设计文档: Phase Z2 — Batch LLM Orchestration
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

// ============================================================
// Types
// ============================================================

export interface BatchConfig {
  batchSize: number       // 每批处理的元素数量 (10-15)
  concurrency: number     // 最大并发批次数 (≤3)
  retryCount: number      // 每批重试次数 (2)
  checkpointFile: string  // 断点续传文件路径
}

export interface BatchProgress {
  completed: number
  total: number
  failed: number
  elapsed: number
}

export interface CheckpointData<T = unknown> {
  timestamp: number
  completedBatches: number
  totalBatches: number
  results: T[]
  errors: Array<{ batchIndex: number; error: string }>
}

// ============================================================
// Defaults
// ============================================================

const DEFAULT_CONFIG: BatchConfig = {
  batchSize: 12,
  concurrency: 2,
  retryCount: 2,
  checkpointFile: '.understand-anything/checkpoint.json',
}

// ============================================================
// BatchOrchestrator
// ============================================================

export class BatchOrchestrator {
  private config: BatchConfig

  constructor(config?: Partial<BatchConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 将数组拆分为批次
   */
  splitBatches<T>(items: T[]): T[][] {
    const batches: T[][] = []
    for (let i = 0; i < items.length; i += this.config.batchSize) {
      batches.push(items.slice(i, i + this.config.batchSize))
    }
    return batches
  }

  /**
   * 带并发控制和重试的批量执行
   *
   * @param batches - 批次数组
   * @param processor - 每个批次的处理函数
   * @param onProgress - 进度回调
   * @returns 所有批次结果的展平数组
   */
  async executeBatches<T, R>(
    batches: T[][],
    processor: (batch: T[]) => Promise<R[]>,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<R[]> {
    const results: R[] = []
    const errors: Array<{ batchIndex: number; error: string }> = []
    let completed = 0
    const total = batches.length
    const startTime = Date.now()

    // 加载断点续传数据
    const checkpoint = this.loadCheckpoint<R[]>()
    if (checkpoint) {
      // 恢复已完成的结果
      for (const batchResult of checkpoint.results) {
        results.push(...batchResult)
      }
      completed = checkpoint.completedBatches
    }

    // 信号量实现并发控制
    const semaphore = new Semaphore(this.config.concurrency)

    const pending: Promise<void>[] = []

    for (let i = completed; i < batches.length; i++) {
      const batchIndex = i
      const batch = batches[batchIndex]

      const task = semaphore.acquire().then(async (release) => {
        try {
          let lastError: Error | null = null

          for (let retry = 0; retry <= this.config.retryCount; retry++) {
            try {
              const batchResult = await processor(batch)
              results.push(...batchResult)
              completed++

              // 保存断点
              this.saveCheckpoint({
                timestamp: Date.now(),
                completedBatches: completed,
                totalBatches: total,
                results: this.chunkResults(results, batches.length),
                errors,
              })

              onProgress?.(completed, total)
              break
            } catch (err) {
              lastError = err instanceof Error ? err : new Error(String(err))
              if (retry < this.config.retryCount) {
                // 指数退避: 100ms, 200ms, 400ms...
                await sleep(100 * Math.pow(2, retry))
              }
            }
          }

          if (lastError) {
            errors.push({
              batchIndex,
              error: lastError.message,
            })
            completed++
            onProgress?.(completed, total)
          }
        } finally {
          release()
        }
      })

      pending.push(task)
    }

    await Promise.all(pending)

    return results
  }

  /**
   * 简化接口：直接对数组执行批量处理
   */
  async process<T, R>(
    items: T[],
    processor: (batch: T[]) => Promise<R[]>,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<{ results: R[]; errors: Array<{ batchIndex: number; error: string }> }> {
    const batches = this.splitBatches(items)
    const errors: Array<{ batchIndex: number; error: string }> = []
    const results: R[] = []
    let completed = 0

    const semaphore = new Semaphore(this.config.concurrency)
    const pending: Promise<void>[] = []

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      const task = semaphore.acquire().then(async (release) => {
        try {
          let lastError: Error | null = null

          for (let retry = 0; retry <= this.config.retryCount; retry++) {
            try {
              const batchResult = await processor(batch)
              results.push(...batchResult)
              break
            } catch (err) {
              lastError = err instanceof Error ? err : new Error(String(err))
              if (retry < this.config.retryCount) {
                await sleep(100 * Math.pow(2, retry))
              }
            }
          }

          if (lastError) {
            errors.push({ batchIndex: i, error: lastError.message })
          }
        } finally {
          completed++
          onProgress?.(completed, batches.length)
          release()
        }
      })

      pending.push(task)
    }

    await Promise.all(pending)
    return { results, errors }
  }

  /**
   * 保存断点续传数据
   */
  saveCheckpoint(data: unknown): void {
    try {
      const dir = dirname(this.config.checkpointFile)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.config.checkpointFile, JSON.stringify(data, null, 2), 'utf-8')
    } catch {
      // 断点保存失败不应阻断主流程
    }
  }

  /**
   * 加载断点续传数据
   */
  loadCheckpoint<T = unknown>(): CheckpointData<T> | null {
    try {
      if (!existsSync(this.config.checkpointFile)) return null
      const raw = readFileSync(this.config.checkpointFile, 'utf-8')
      return JSON.parse(raw) as CheckpointData<T>
    } catch {
      return null
    }
  }

  /**
   * 清除断点文件
   */
  clearCheckpoint(): void {
    try {
      if (existsSync(this.config.checkpointFile)) {
        const { unlinkSync } = require('fs')
        unlinkSync(this.config.checkpointFile)
      }
    } catch {
      // ignore
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): BatchConfig {
    return { ...this.config }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /**
   * 将展平结果重新分块（用于 checkpoint 序列化）
   */
  private chunkResults<R>(results: R[], expectedBatches: number): R[][] {
    if (expectedBatches <= 1) return [results]
    const chunkSize = Math.ceil(results.length / expectedBatches)
    const chunks: R[][] = []
    for (let i = 0; i < results.length; i += chunkSize) {
      chunks.push(results.slice(i, i + chunkSize))
    }
    return chunks
  }
}

// ============================================================
// Semaphore (并发控制)
// ============================================================

class Semaphore {
  private current = 0
  private queue: Array<() => void> = []

  constructor(private max: number) {}

  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++
      return () => this.release()
    }

    return new Promise<() => void>(resolve => {
      this.queue.push(() => {
        this.current++
        resolve(() => this.release())
      })
    })
  }

  private release(): void {
    this.current--
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
