/**
 * Worker 客户端
 * 主进程侧用于与 Worker 通信的封装
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Worker 实例缓存 (复用而非每次创建)
let cachedWorker: Worker | null = null
let currentRequestId = 0

// 请求超时时间 (2 分钟)
const REQUEST_TIMEOUT_MS = 120_000

/**
 * 在 Worker 中执行压缩
 */
export async function compactInWorker(
  messages: unknown[],
  contextSnapshot: CompactContextSnapshot,
  params: CompactParams,
  onProgress?: (event: CompactProgressEvent) => void,
): Promise<CompactionResult> {
  const requestId = `compact-${++currentRequestId}-${Date.now()}`

  // 获取或创建 Worker
  const worker = await getOrCreateWorker()

  return new Promise((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | null = null
    let progressHandler: ((msg: WorkerProgressMessage) => void) | null = null
    let errorHandler: ((error: Error) => void) | null = null

    // Set up error handler — reject in-flight request if Worker crashes
    errorHandler = (error: Error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      if (progressHandler) {
        worker.off('message', progressHandler)
      }
      reject(new Error(`Compact worker crashed: ${error.message}`))
    }
    worker.on('error', errorHandler)

    // 设置超时
    timeoutHandle = setTimeout(() => {
      // 超时后移除监听器并拒绝
      if (progressHandler) {
        worker.off('message', progressHandler)
      }
      if (errorHandler) {
        worker.off('error', errorHandler)
      }
      reject(new Error('Compact worker timeout'))
    }, REQUEST_TIMEOUT_MS)

    // 消息处理函数
    progressHandler = (msg: CompactWorkerResponse | WorkerProgressMessage) => {
      // 只处理当前请求的消息
      if (msg.requestId !== requestId) return

      if ('success' in msg) {
        // 最终响应
        if (timeoutHandle) {
          clearTimeout(timeoutHandle)
          timeoutHandle = null
        }
        worker.off('message', progressHandler!)
        if (errorHandler) {
          worker.off('error', errorHandler)
        }

        if (msg.success && msg.result) {
          logForDebugging(`[Compact Worker] Request ${requestId} succeeded`)
          resolve(msg.result)
        } else {
          const errorMsg = msg.error
            ? `[${msg.error.code}] ${msg.error.message}`
            : 'Worker compact failed with no error details'
          reject(new Error(errorMsg))
        }
      } else if (msg.type === 'progress' && onProgress) {
        // 进度更新 - 转发给调用方
        onProgress(msg.progress)
      }
    }

    // 监听消息
    worker.on('message', progressHandler)

    // 发送请求
    const request: CompactWorkerRequest = {
      requestId,
      type: params.pivotIndex !== undefined ? 'partialCompact' : 'compact',
      messages: messages as any,
      contextSnapshot,
      params,
    }

    logForDebugging(`[Compact Worker] Sending request ${requestId}`)

    try {
      worker.postMessage(request)
    } catch (postError) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      if (progressHandler) {
        worker.off('message', progressHandler)
      }
      if (errorHandler) {
        worker.off('error', errorHandler)
      }
      reject(postError)
    }
  })
}

/**
 * 获取或创建 Worker 实例
 */
async function getOrCreateWorker(): Promise<Worker> {
  if (cachedWorker) {
    return cachedWorker
  }

  const workerPath = path.join(__dirname, 'compact.worker.js')

  // Bun doesn't support execArgv (Node.js-specific), skip --max-old-space-size
  const isBun = typeof process !== 'undefined' && 'bun' in process.versions
  const execArgv = isBun ? undefined : [
    '--max-old-space-size',
    String(Math.floor(MEMORY_THRESHOLDS.WORKER_HEAP_LIMIT / (1024 * 1024 * 1024) * 1024)),
  ]

  cachedWorker = new Worker(workerPath, {
    execArgv,
    env: process.env as Record<string, string>,
  })

  cachedWorker.on('error', (error) => {
    logError(error)
    logForDebugging('[Compact Worker] Worker error, will recreate on next request', {
      level: 'error',
    })
    cachedWorker = null
  })

  cachedWorker.on('exit', (code) => {
    logForDebugging(`[Compact Worker] Worker exited with code ${code}`)
    cachedWorker = null
  })

  logForDebugging('[Compact Worker] New worker created')

  return cachedWorker
}

/**
 * 清理 Worker (进程退出时调用)
 */
export function terminateWorker(): void {
  if (cachedWorker) {
    cachedWorker.terminate()
    cachedWorker = null
    logForDebugging('[Compact Worker] Worker terminated')
  }
}

/**
 * 重置 Worker (强制销毁并重建)
 */
export function resetWorker(): void {
  if (cachedWorker) {
    cachedWorker.terminate()
    cachedWorker = null
    logForDebugging('[Compact Worker] Worker reset')
  }
}

/**
 * 检查 Worker 是否可用
 */
export function isWorkerReady(): boolean {
  return cachedWorker !== null
}

/**
 * 获取 Worker 状态信息
 */
export function getWorkerStatus(): {
  active: boolean
  hasCachedWorker: boolean
} {
  return {
    active: cachedWorker !== null,
    hasCachedWorker: cachedWorker !== null,
  }
}