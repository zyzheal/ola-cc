/**
 * 内存检测逻辑
 * 决定是否使用 Worker 执行压缩
 */
import { MEMORY_THRESHOLDS, type MemoryPressureState } from './types.js'

/**
 * 获取当前内存压力状态
 */
export function getMemoryPressure(): MemoryPressureState {
  const usage = process.memoryUsage()
  const heapUsed = usage.heapUsed
  const heapTotal = usage.heapTotal

  return {
    heapUsed,
    heapTotal,
    isHigh: heapUsed >= MEMORY_THRESHOLDS.HIGH,
    isCritical: heapUsed >= MEMORY_THRESHOLDS.CRITICAL,
  }
}

/**
 * 检测运行时是否支持 Worker 线程
 * Bun 不支持 execArgv（--max-old-space-size），Worker 会失败
 */
function isWorkerRuntimeSupported(): boolean {
  const isBun = typeof process !== 'undefined' && 'bun' in process.versions
  return !isBun
}

/**
 * 检测是否应该使用 Worker
 * @param forceWorker - 强制使用 Worker
 * @param messageCount - 消息数量，用于估算内存使用
 */
export function shouldUseWorker(forceWorker = false, messageCount = 0): boolean {
  if (forceWorker) return true

  // Bun doesn't support execArgv, Worker will fail — skip Worker path entirely
  if (!isWorkerRuntimeSupported()) return false

  const { isHigh, isCritical } = getMemoryPressure()

  // 临界状态强制使用 Worker
  if (isCritical) return true

  // 高内存状态 + 消息量大于阈值时使用 Worker
  if (isHigh) {
    const messageCountThreshold = parseInt(
      process.env.OLA_CC_COMPACT_WORKER_MSG_COUNT_THRESHOLD ?? '500'
    )
    return messageCount >= messageCountThreshold
  }

  return false
}

/**
 * 检测是否应该使用 Worker (异步版本)
 * 可用于更精确的内存检测
 */
export async function detectMemoryForCompact(
  messageCount: number,
  options?: { forceWorker?: boolean }
): Promise<{
  shouldUseWorker: boolean
  memory: MemoryPressureState
  reason: string
}> {
  const memory = getMemoryPressure()
  const forceWorker = options?.forceWorker ?? false

  if (forceWorker) {
    return {
      shouldUseWorker: true,
      memory,
      reason: 'forced by option',
    }
  }

  if (memory.isCritical) {
    return {
      shouldUseWorker: true,
      memory,
      reason: `critical memory: ${formatBytes(memory.heapUsed)}`,
    }
  }

  if (memory.isHigh && messageCount >= 500) {
    return {
      shouldUseWorker: true,
      memory,
      reason: `high memory: ${formatBytes(memory.heapUsed)}, messages: ${messageCount}`,
    }
  }

  return {
    shouldUseWorker: false,
    memory,
    reason: `normal memory: ${formatBytes(memory.heapUsed)}, messages: ${messageCount}`,
  }
}

/**
 * 格式化字节数为可读字符串
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

/**
 * 格式化内存状态为日志字符串
 */
export function formatMemoryStatus(memory: MemoryPressureState): string {
  const usage = ((memory.heapUsed / memory.heapTotal) * 100).toFixed(1)
  return `${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)} (${usage}%)`
}