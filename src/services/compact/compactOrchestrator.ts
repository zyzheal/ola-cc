/**
 * 压缩编排器
 * 自动决定本地执行还是 Worker 执行
 *
 * 决策逻辑:
 * 1. 临界内存状态 → 强制使用 Worker
 * 2. 高内存状态 + 大量消息 → 使用 Worker
 * 3. 其他情况 → 本地执行 (保持现有行为)
 */
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import type { RecompactionInfo } from './compact.js'
import { compactConversation } from './compact.js'
import { compactInWorker, terminateWorker, resetWorker } from './worker/workerClient.js'
import { compactWithWorkerPool, disposeWorkerPool } from './worker/workerPool.js'
import {
  getMemoryPressure,
  shouldUseWorker,
  detectMemoryForCompact,
  formatMemoryStatus,
} from './worker/memoryDetection.js'
import type { CompactContextSnapshot, CompactProgressEvent } from './worker/types.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { logEvent } from '../../services/analytics/index.js'
import type { CompactionResult } from './compact.js'

/**
 * Check if running under Bun runtime.
 * Bun has limited Worker thread support and can cause OOM crashes.
 */
function isBunRuntime(): boolean {
  return typeof process !== 'undefined' && 'bun' in process.versions
}

export interface CompactOptions {
  cacheSafeParams: CacheSafeParams
  suppressFollowUpQuestions: boolean
  customInstructions?: string
  isAutoCompact: boolean
  recompactionInfo?: RecompactionInfo
  direction?: 'from' | 'up_to'
  pivotIndex?: number
  userFeedback?: string
}

/**
 * 压缩编排器 - 统一入口
 *
 * @param messages - 需要压缩的消息
 * @param context - ToolUseContext
 * @param options - 压缩选项
 * @returns 压缩结果
 */
export async function compactWithOrchestrator(
  messages: Message[],
  context: ToolUseContext,
  options: CompactOptions,
): Promise<CompactionResult> {
  // 延迟注册进程退出事件 (首次调用时注册)
  registerDisposeOnProcessExit()

  const messageCount = messages.length

  // Bun runtime: completely skip Worker path to prevent OOM crashes.
  // Bun has limited Worker thread support and memory management that can
  // crash the parent process. Always use local compact under Bun.
  if (isBunRuntime()) {
    logForDebugging(
      '[CompactOrchestrator] Bun runtime detected, using local compact (Worker disabled)'
    )
    logEvent('tengu_compact_orchestrator_decision', {
      memoryUsed: 0,
      memoryTotal: 0,
      isHigh: false,
      isCritical: false,
      messageCount,
      useWorker: false,
      isAutoCompact: options.isAutoCompact,
      reason: 'bun_runtime',
    })
    return compactConversation(
      messages,
      context,
      options.cacheSafeParams,
      options.suppressFollowUpQuestions,
      options.customInstructions,
      options.isAutoCompact,
      options.recompactionInfo,
    )
  }

  const memory = getMemoryPressure()

  // 决策: 是否使用 Worker
  const forceWorker = process.env.FORCE_COMPACT_WORKER === '1'
  const useWorker = shouldUseWorker(forceWorker, messageCount)

  logForDebugging(
    `[CompactOrchestrator] memory=${formatMemoryStatus(memory)}, ` +
      `useWorker=${useWorker}, msgCount=${messageCount}`
  )

  // 记录决策日志
  logEvent('tengu_compact_orchestrator_decision', {
    memoryUsed: memory.heapUsed,
    memoryTotal: memory.heapTotal,
    isHigh: memory.isHigh,
    isCritical: memory.isCritical,
    messageCount,
    useWorker,
    isAutoCompact: options.isAutoCompact,
  })

  if (!useWorker) {
    // 本地执行 (现有逻辑)
    logForDebugging('[CompactOrchestrator] Using local compact')
    return compactConversation(
      messages,
      context,
      options.cacheSafeParams,
      options.suppressFollowUpQuestions,
      options.customInstructions,
      options.isAutoCompact,
      options.recompactionInfo,
    )
  }

  // Worker 执行
  try {
    // 序列化上下文 (提取可传递的部分)
    const contextSnapshot = serializeContext(context)

    // 选择使用单一 Worker 还是 Worker 池
    const usePool = process.env.OLA_CC_COMPACT_USE_POOL === '1'

    logForDebugging(`[CompactOrchestrator] Using worker compact (pool: ${usePool})`)

    const result = usePool
      ? await compactWithWorkerPool(
          messages,
          contextSnapshot,
          {
            cacheSafeParams: options.cacheSafeParams,
            suppressFollowUpQuestions: options.suppressFollowUpQuestions,
            customInstructions: options.customInstructions,
            isAutoCompact: options.isAutoCompact,
            recompactionInfo: options.recompactionInfo,
            direction: options.direction,
            pivotIndex: options.pivotIndex,
            userFeedback: options.userFeedback,
          },
          (progress: CompactProgressEvent) => {
            context.onCompactProgress?.(progress)
          },
        )
      : await compactInWorker(
          messages,
          contextSnapshot,
          {
            cacheSafeParams: options.cacheSafeParams,
            suppressFollowUpQuestions: options.suppressFollowUpQuestions,
            customInstructions: options.customInstructions,
            isAutoCompact: options.isAutoCompact,
            recompactionInfo: options.recompactionInfo,
            direction: options.direction,
            pivotIndex: options.pivotIndex,
            userFeedback: options.userFeedback,
          },
          // 进度回调转发
          (progress: CompactProgressEvent) => {
            context.onCompactProgress?.(progress)
          },
        )

    logForDebugging('[CompactOrchestrator] Worker compact succeeded')

    return result

  } catch (workerError) {
    // Worker 失败，降级到本地执行
    const errorMsg = workerError instanceof Error ? workerError.message : String(workerError)

    logForDebugging(
      `[CompactOrchestrator] Worker failed: ${errorMsg}, falling back to local`,
      { level: 'warn' }
    )

    logError(workerError)

    // 记录降级事件
    logEvent('tengu_compact_worker_fallback', {
      error: errorMsg,
      messageCount,
      memoryUsed: memory.heapUsed,
    })

    // Only show fallback message once per session (deduplicate by error type)
    // Avoid flooding conversation with repeated messages on auto-compact retries
    const errorKey = errorMsg.split(':')[0].trim() || 'unknown'
    if (!shownFallbackErrors.has(errorKey)) {
      shownFallbackErrors.add(errorKey)
      context.appendSystemMessage?.({
        type: 'system',
        subtype: 'compact_fallback',
        content: `⚠️ Worker 压缩失败，降级到本地执行: ${errorMsg}`,
        isMeta: true,
      })
    }

    // 降级执行
    return compactConversation(
      messages,
      context,
      options.cacheSafeParams,
      options.suppressFollowUpQuestions,
      options.customInstructions,
      options.isAutoCompact,
      options.recompactionInfo,
    )
  }
}

/**
 * 序列化 ToolUseContext 为可传递的快照
 */
function serializeContext(context: ToolUseContext): CompactContextSnapshot {
  return {
    options: {
      mainLoopModel: context.options.mainLoopModel,
      // 简化 tool 对象，只保留必要字段
      tools: context.options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      mcpClients: [], // Worker 中无法使用 MCP
      agentDefinitions: context.options.agentDefinitions,
      isNonInteractiveSession: context.options.isNonInteractiveSession,
      customSystemPrompt: context.options.customSystemPrompt,
      appendSystemPrompt: context.options.appendSystemPrompt,
      querySource: context.options.querySource,
    },
    agentId: context.agentId,
    agentType: context.agentType,
  }
}

// ============================================
// 便捷函数
// ============================================

/**
 * 获取当前内存状态
 */
export function getCompactMemoryStatus() {
  const memory = getMemoryPressure()
  return {
    ...memory,
    formatted: formatMemoryStatus(memory),
  }
}

/**
 * 清理 Worker 资源 (进程退出时调用)
 */
export function disposeCompactOrchestrator() {
  terminateWorker()
  disposeWorkerPool()
  logForDebugging('[CompactOrchestrator] Disposed')
}

// 延迟注册：首次调用 compactWithOrchestrator 时注册
let disposeRegistered = false
function registerDisposeOnProcessExit() {
  if (disposeRegistered) return
  disposeRegistered = true

  process.on('exit', disposeCompactOrchestrator)
  process.on('SIGTERM', () => {
    disposeCompactOrchestrator()
    process.exit(0)
  })
  process.on('SIGINT', () => {
    disposeCompactOrchestrator()
    process.exit(0)
  })
}

// Session-level deduplication for fallback messages
const shownFallbackErrors = new Set<string>()

/**
 * 强制重置 Worker (用于调试)
 */
export function forceResetCompactWorker() {
  resetWorker()
  logForDebugging('[CompactOrchestrator] Worker force reset')
}