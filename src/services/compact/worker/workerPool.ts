/**
 * Worker 池管理
 * Phase 3: 支持多个 Worker 并发处理任务
 */
import { Worker } from 'worker_threads'
import path from 'path'
import { fileURLToPath } from 'url'
import { logForDebugging } from '../../../utils/debug.js'
import { logError } from '../../../utils/log.js'
import {
  MEMORY_THRESHOLDS,
  type CompactWorkerRequest,
  type CompactWorkerResponse,
  type CompactProgressEvent,
  type WorkerProgressMessage,
  type CompactContextSnapshot,
  type CompactParams,
} from './types.js'
import type { CompactionResult } from '../compact.js'
import type { Message } from '../../../types/message.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ============================================
// 配置
// ============================================

interface WorkerPoolConfig {
  /** 最大 Worker 数量 */
  maxWorkers: number
  /** 空闲 Worker 存活时间 (ms) */
  idleTimeoutMs: number
  /** 请求超时 (ms) */
  requestTimeoutMs: number
}

const DEFAULT_CONFIG: WorkerPoolConfig = {
  maxWorkers: parseInt(process.env.OLA_CC_COMPACT_POOL_MAX_WORKERS ?? '2', 10),
  idleTimeoutMs: parseInt(process.env.OLA_CC_COMPACT_POOL_IDLE_TIMEOUT ?? '60000', 10), // 1 分钟
  requestTimeoutMs: 120_000, // 2 分钟
}

// ============================================
// 类型
// ============================================

interface PooledWorker {
  worker: Worker
  inUse: boolean
  createdAt: number
  lastUsedAt: number
  requestCount: number
}

interface PendingRequest {
  request: CompactWorkerRequest
  resolve: (result: CompactionResult) => void
  reject: (error: Error) => void
  progressCallback?: (event: CompactProgressEvent) => void
  timeoutHandle: NodeJS.Timeout
}

// ============================================
// Worker 池类
// ============================================

class CompactWorkerPool {
  private workers: Map<number, PooledWorker> = new Map()
  private pendingQueue: PendingRequest[] = []
  private config: WorkerPoolConfig
  private cleanupInterval: NodeJS.Timeout | null = null
  private exitedWorkers: Set<number> = new Set()

  constructor(config: Partial<WorkerPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.startCleanupInterval()
  }

  /**
   * 执行压缩任务
   */
  async execute(
    messages: Message[],
    contextSnapshot: CompactContextSnapshot,
    params: CompactParams,
    onProgress?: (event: CompactProgressEvent) => void,
  ): Promise<CompactionResult> {
    const requestId = `compact-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    // 尝试获取可用的 Worker
    const worker = await this.acquireWorker()

    return new Promise((resolve, reject) => {
      // 设置超时
      const timeoutHandle = setTimeout(() => {
        // 移除消息监听器，避免 race condition
        worker.worker.off('message', messageHandler)
        // 从使用中移除
        worker.inUse = false

        // 超时视为失败，终止该 Worker
        this.terminateWorker(worker)

        reject(new Error('Compact worker timeout'))
      }, this.config.requestTimeoutMs)

      // 消息处理
      const messageHandler = (msg: CompactWorkerResponse | WorkerProgressMessage) => {
        if (msg.requestId !== requestId) return

        if ('success' in msg) {
          // 最终响应
          clearTimeout(timeoutHandle)
          worker.worker.off('message', messageHandler)

          if (msg.success && msg.result) {
            worker.inUse = false
            worker.lastUsedAt = Date.now()
            worker.requestCount++

            resolve(msg.result)
          } else {
            worker.inUse = false
            const error = msg.error
              ? new Error(`[${msg.error.code}] ${msg.error.message}`)
              : new Error('Worker compact failed')
            reject(error)
          }
        } else if (msg.type === 'progress' && onProgress) {
          onProgress(msg.progress)
        }
      }

      worker.worker.on('message', messageHandler)

      // 发送请求
      const request: CompactWorkerRequest = {
        requestId,
        type: params.pivotIndex !== undefined ? 'partialCompact' : 'compact',
        messages,
        contextSnapshot,
        params,
      }

      worker.worker.postMessage(request)
    })
  }

  /**
   * 获取或创建 Worker
   */
  private async acquireWorker(): Promise<PooledWorker> {
    // 查找空闲的 Worker
    for (const [id, worker] of this.workers) {
      if (!worker.inUse && this.isWorkerHealthy(worker)) {
        worker.inUse = true
        return worker
      }
    }

    // 如果未达到上限，创建新 Worker
    if (this.workers.size < this.config.maxWorkers) {
      const worker = await this.createWorker()
      worker.inUse = true
      return worker
    }

    // 等待空闲 Worker (带超时)
    const maxQueueWait = this.config.requestTimeoutMs * 0.5 // 最多等待 50% 请求超时
    const startTime = Date.now()

    return new Promise((resolve, reject) => {
      const checkForWorker = () => {
        // 检查是否超过最大等待时间
        if (Date.now() - startTime > maxQueueWait) {
          reject(new Error('Timed out waiting for available worker'))
          return
        }
        // 等待一段时间后重试
        setTimeout(async () => {
          try {
            resolve(await this.acquireWorker())
          } catch (e) {
            reject(e)
          }
        }, 100)
      }
      checkForWorker()
    })
  }

  /**
   * 创建新 Worker
   */
  private async createWorker(): Promise<PooledWorker> {
    const workerPath = path.join(__dirname, 'compact.worker.js')

    // Bun doesn't support execArgv (Node.js-specific), skip --max-old-space-size
    const isBun = typeof process !== 'undefined' && 'bun' in process.versions
    const execArgv = isBun ? undefined : [
      '--max-old-space-size',
      String(Math.floor(MEMORY_THRESHOLDS.WORKER_HEAP_LIMIT / (1024 * 1024))),
    ]

    const worker = new Worker(workerPath, {
      execArgv,
      env: process.env as Record<string, string>,
    })

    const pooledWorker: PooledWorker = {
      worker,
      inUse: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      requestCount: 0,
    }

    worker.on('error', (error) => {
      logError(error)
      logForDebugging(`[CompactWorkerPool] Worker error: ${error.message}`, { level: 'error' })
      this.removeWorker(pooledWorker)
    })

    worker.on('exit', (code) => {
      logForDebugging(`[CompactWorkerPool] Worker exited with code ${code}`)
      this.exitedWorkers.add(worker.threadId)
      this.removeWorker(pooledWorker)
    })

    this.workers.set(worker.threadId, pooledWorker)
    logForDebugging(`[CompactWorkerPool] Created new worker, total: ${this.workers.size}`)

    return pooledWorker
  }

  /**
   * 检查 Worker 是否健康
   */
  private isWorkerHealthy(worker: PooledWorker): boolean {
    // 检查 Worker 是否已退出
    if (this.exitedWorkers.has(worker.worker.threadId)) {
      return false
    }
    // 检查进程是否存活
    return worker.worker.threadId !== undefined
  }

  /**
   * 移除 Worker
   */
  private removeWorker(worker: PooledWorker): void {
    for (const [id, w] of this.workers) {
      if (w === worker) {
        this.workers.delete(id)
        this.exitedWorkers.delete(worker.threadId)
        break
      }
    }
  }

  /**
   * 终止指定 Worker
   */
  private terminateWorker(worker: PooledWorker): void {
    try {
      worker.worker.terminate()
    } catch (e) {
      // 忽略终止错误
    }
    this.removeWorker(worker)
  }

  /**
   * 定期清理空闲 Worker
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now()

      for (const [id, worker] of this.workers) {
        if (!worker.inUse) {
          const idleTime = now - worker.lastUsedAt
          if (idleTime > this.config.idleTimeoutMs) {
            logForDebugging(`[CompactWorkerPool] Removing idle worker ${id}`)
            this.terminateWorker(worker)
          }
        }
      }
    }, 10000) // 每 10 秒检查一次
  }

  /**
   * 销毁池
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    for (const [id, worker] of this.workers) {
      this.terminateWorker(worker)
    }

    this.workers.clear()
    this.pendingQueue = []

    logForDebugging('[CompactWorkerPool] Disposed')
  }

  /**
   * 获取池状态
   */
  getStatus(): {
    totalWorkers: number
    activeWorkers: number
    idleWorkers: number
    pendingRequests: number
  } {
    let active = 0
    let idle = 0

    for (const worker of this.workers.values()) {
      if (worker.inUse) {
        active++
      } else {
        idle++
      }
    }

    return {
      totalWorkers: this.workers.size,
      activeWorkers: active,
      idleWorkers: idle,
      pendingRequests: this.pendingQueue.length,
    }
  }
}

// ============================================
// 单例实例
// ============================================

let poolInstance: CompactWorkerPool | null = null

/**
 * 获取 Worker 池实例
 */
export function getWorkerPool(): CompactWorkerPool {
  if (!poolInstance) {
    poolInstance = new CompactWorkerPool()
  }
  return poolInstance
}

/**
 * 销毁 Worker 池
 */
export function disposeWorkerPool(): void {
  if (poolInstance) {
    poolInstance.dispose()
    poolInstance = null
  }
}

// ============================================
// 使用池的客户端
// ============================================

/**
 * 使用 Worker 池执行压缩
 */
export async function compactWithWorkerPool(
  messages: Message[],
  contextSnapshot: CompactContextSnapshot,
  params: CompactParams,
  onProgress?: (event: CompactProgressEvent) => void,
): Promise<CompactionResult> {
  const pool = getWorkerPool()
  return pool.execute(messages, contextSnapshot, params, onProgress)
}