/**
 * IPC 消息类型定义
 * Worker 与主进程之间的通信协议
 */
import type { Message } from '../../../types/message.js'
import type { CompactionResult } from '../compact.js'
import type { CacheSafeParams } from '../../../utils/forkedAgent.js'
import type { RecompactionInfo } from '../compact.js'

// ============================================
// 内存阈值配置
// ============================================

/** 默认内存阈值 (字节) */
const DEFAULT_HIGH_THRESHOLD = 1 * 1024 * 1024 * 1024 // 1GB
const DEFAULT_CRITICAL_THRESHOLD = 1.5 * 1024 * 1024 * 1024 // 1.5GB
const DEFAULT_WORKER_HEAP_LIMIT = 1 * 1024 * 1024 * 1024 // 1GB

/** 内存阈值配置 (可环境变量覆盖) */
export const MEMORY_THRESHOLDS = {
  /** 高内存阈值: 超过此值优先使用 Worker (默认 1GB) */
  HIGH: parseInt(process.env.OLA_CC_COMPACT_WORKER_THRESHOLD_HIGH ?? String(DEFAULT_HIGH_THRESHOLD), 10),
  /** 临界内存阈值: 超过此值强制使用 Worker (默认 1.5GB) */
  CRITICAL: parseInt(process.env.OLA_CC_COMPACT_WORKER_THRESHOLD_CRITICAL ?? String(DEFAULT_CRITICAL_THRESHOLD), 10),
  /** Worker 专用堆内存限制 (默认 1GB) */
  WORKER_HEAP_LIMIT: parseInt(process.env.OLA_CC_COMPACT_WORKER_HEAP_LIMIT ?? String(DEFAULT_WORKER_HEAP_LIMIT), 10),
}

// ============================================
// 内存状态
// ============================================

export interface MemoryPressureState {
  heapUsed: number
  heapTotal: number
  isHigh: boolean
  isCritical: boolean
}

// ============================================
// IPC 请求/响应类型
// ============================================

/** 主进程 -> Worker 的请求 */
export interface CompactWorkerRequest {
  requestId: string
  type: 'compact' | 'partialCompact'
  messages: Message[]
  contextSnapshot: CompactContextSnapshot
  params: CompactParams
}

/** Worker -> 主进程的响应 */
export interface CompactWorkerResponse {
  requestId: string
  success: boolean
  result?: CompactionResult
  error?: CompactWorkerError
}

/** 进度事件 (Worker -> 主进程) */
export interface CompactProgressEvent {
  type: 'compact_start' | 'compact_progress' | 'compact_end' | 'hooks_start' | 'hooks_end'
  stage?: 'summarizing' | 'processing' | 'post_processing' | 'complete'
  progress?: number // 0-100
  message?: string
  hookType?: 'pre_compact' | 'post_compact' | 'session_start'
}

/** 错误信息 */
export interface CompactWorkerError {
  code: string
  message: string
  stack?: string
}

// ============================================
// 参数类型
// ============================================

export interface CompactParams {
  cacheSafeParams: CacheSafeParams
  suppressFollowUpQuestions: boolean
  customInstructions?: string
  isAutoCompact: boolean
  recompactionInfo?: RecompactionInfo
  direction?: 'from' | 'up_to'
  pivotIndex?: number
  userFeedback?: string
}

// ============================================
// 上下文快照 (序列化后的 Context)
// ============================================

/** 上下文快照 - 去除无法序列化的函数 */
export interface CompactContextSnapshot {
  options: {
    mainLoopModel: string
    tools: Array<{
      name: string
      description: string
      inputSchema: unknown
    }>
    mcpClients: unknown[]
    agentDefinitions: unknown
    isNonInteractiveSession: boolean
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: string
  }
  agentId?: string
  agentType?: string
}

// ============================================
// 消息通道类型
// ============================================

/** Worker 进度消息 (分离的通道) */
export interface WorkerProgressMessage {
  requestId: string
  type: 'progress'
  progress: CompactProgressEvent
}

/** Worker 错误消息 */
export interface WorkerErrorMessage {
  requestId: string
  type: 'error'
  error: CompactWorkerError
}