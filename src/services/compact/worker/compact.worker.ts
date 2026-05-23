/**
 * Compact Worker 入口文件
 * 在独立的 Worker 线程中执行压缩
 *
 * 运行方式: node compact.worker.js
 * 通信方式: worker_threads parentPort
 */
import { parentPort, workerData } from 'worker_threads'
import type {
  CompactWorkerRequest,
  CompactWorkerResponse,
  CompactProgressEvent,
  WorkerProgressMessage,
} from './types.js'
import { compactConversation, partialCompactConversation } from '../compact.js'
import { createMockContext } from './mockContext.js'
import { logForDebugging } from '../../../utils/debug.js'

// Worker 日志前缀
const WORKER_LOG_PREFIX = '[CompactWorker]'

// 验证 parentPort 存在
if (!parentPort) {
  console.error(`${WORKER_LOG_PREFIX} Error: parentPort is null (must be run as Worker)`)
  process.exit(1)
}

logForDebugging(`${WORKER_LOG_PREFIX} Started with data: ${JSON.stringify(workerData || {})}`)

/**
 * 处理主进程发来的压缩请求
 */
async function handleCompactRequest(request: CompactWorkerRequest): Promise<CompactWorkerResponse> {
  const { requestId, type, messages, contextSnapshot, params } = request

  logForDebugging(`${WORKER_LOG_PREFIX} Processing request ${requestId}, type: ${type}`)

  const response: CompactWorkerResponse = {
    requestId,
    success: false,
  }

  try {
    // 创建进度回调 - 通过 parentPort 发送进度
    const onProgress = (progress: CompactProgressEvent) => {
      const progressMsg: WorkerProgressMessage = {
        requestId,
        type: 'progress',
        progress,
      }
      parentPort?.postMessage(progressMsg)
    }

    // 创建 Worker 内的模拟 Context
    const context = createMockContext(contextSnapshot, onProgress)

    let result: any

    if (type === 'partialCompact' && params.pivotIndex !== undefined) {
      // Partial compact: 从指定位置压缩
      result = await partialCompactConversation(
        messages,
        params.pivotIndex,
        context,
        params.cacheSafeParams,
        params.userFeedback,
        params.direction ?? 'from',
      )
    } else {
      // 标准压缩
      result = await compactConversation(
        messages,
        context,
        params.cacheSafeParams,
        params.suppressFollowUpQuestions,
        params.customInstructions,
        params.isAutoCompact,
        params.recompactionInfo,
      )
    }

    response.success = true
    response.result = result

    logForDebugging(`${WORKER_LOG_PREFIX} Request ${requestId} completed successfully`)

  } catch (error) {
    response.success = false
    response.error = {
      code: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }

    logForDebugging(`${WORKER_LOG_PREFIX} Request ${requestId} failed: ${response.error.message}`, {
      level: 'error',
    })
  }

  return response
}

// ============================================
// 消息处理循环
// ============================================

/**
 * 处理来自主进程的消息
 */
function handleMessage(request: CompactWorkerRequest): void {
  // 异步处理请求
  handleCompactRequest(request)
    .then((response) => {
      parentPort?.postMessage(response)
    })
    .catch((error) => {
      // 未捕获的错误处理
      const errorResponse: CompactWorkerResponse = {
        requestId: request.requestId,
        success: false,
        error: {
          code: 'UNCAUGHT_ERROR',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      }
      parentPort?.postMessage(errorResponse)
    })
}

// ============================================
// 事件监听
// ============================================

// 监听主进程消息
parentPort.on('message', (request: CompactWorkerRequest) => {
  logForDebugging(`${WORKER_LOG_PREFIX} Received request: ${request.requestId}`)
  handleMessage(request)
})

// 监听错误
parentPort.on('error', (error) => {
  console.error(`${WORKER_LOG_PREFIX} Port error:`, error)
})

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error(`${WORKER_LOG_PREFIX} Uncaught exception:`, error)
  // 尝试通知主进程
  if (parentPort) {
    parentPort.postMessage({
      requestId: 'unknown',
      success: false,
      error: {
        code: 'UNCAUGHT_EXCEPTION',
        message: error.message,
        stack: error.stack,
      },
    })
  }
  process.exit(1)
})

// 处理未捕获的 Promise 拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error(`${WORKER_LOG_PREFIX} Unhandled rejection at:`, promise, 'reason:', reason)
  // 通知主进程，避免 hang 120 秒
  parentPort?.postMessage({
    requestId: 'unknown',
    success: false,
    error: {
      code: 'UNHANDLED_REJECTION',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    },
  })
})

logForDebugging(`${WORKER_LOG_PREFIX} Ready to process requests`)