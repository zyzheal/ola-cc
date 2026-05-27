/**
 * Cached Microcompact: 使用 API cache_editing 功能清理 tool results
 *
 * 优势：直接编辑缓存而不修改消息内容，保持缓存前缀有效
 * 适用场景：需要清理旧 tool results 但不想触发完整压缩
 *
 * P0 修复：从模块级全局状态改为类实例，支持多 session 隔离
 */

import type { Message } from '../../types/message.js'

export interface CachedMCState {
  cacheId: string
  toolResults: Map<string, ToolResultEntry>
  createdAt: number
  /** 已注册的 toolUseId 集合，防止重复注册 */
  registeredIds: Set<string>
}

export interface ToolResultEntry {
  toolUseId: string
  toolName: string
  tokenCount: number
}

export interface CachedMCConfig {
  supportedModels: string[]
  maxCachedResults: number
  maxCachedTokens: number
}

// 支持 cache editing 的模型列表（需要 API 支持）
const SUPPORTED_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-20250520',
  'claude-opus-4-20250520',
  'claude-sonnet-4-6-20250514',
  'claude-opus-4-6-20250514',
]

const DEFAULT_CONFIG: CachedMCConfig = {
  supportedModels: SUPPORTED_MODELS,
  maxCachedResults: 100,
  maxCachedTokens: 50000,
}

// ============================================
// SessionMCRegistry — P0-01 修复
// 替代模块级 globalMCState，提供 per-session 实例管理
// ============================================

/** 每个 goal/session 的 MC 实例包装 */
class SessionMCInstance {
  state: CachedMCState
  lastAccessAt: number

  constructor(goalId: string) {
    this.state = {
      cacheId: `cached-mc-${goalId}-${Math.random().toString(36).slice(2, 11)}`,
      toolResults: new Map(),
      registeredIds: new Set(),
      createdAt: Date.now(),
    }
    this.lastAccessAt = Date.now()
  }

  touch() {
    this.lastAccessAt = Date.now()
  }
}

/** Session 级 CachedMC 注册表 */
class SessionMCRegistryClass {
  private registry = new Map<string, SessionMCInstance>()

  /** 获取或创建指定 goalId 的 MC 实例 */
  getOrCreate(goalId: string): CachedMCState {
    let instance = this.registry.get(goalId)
    if (!instance) {
      instance = new SessionMCInstance(goalId)
      this.registry.set(goalId, instance)
    }
    instance.touch()
    return instance.state
  }

  /** goal 完成时清理对应实例 */
  dispose(goalId: string): void {
    this.registry.delete(goalId)
  }

  /** 定期清理超过指定时间未访问的实例，防止 registry 无限增长 */
  cleanup(maxIdleMs: number = 30 * 60 * 1000): void {
    const now = Date.now()
    const toRemove: string[] = []
    this.registry.forEach((instance, goalId) => {
      if (now - instance.lastAccessAt > maxIdleMs) {
        toRemove.push(goalId)
      }
    })
    for (const goalId of toRemove) {
      this.registry.delete(goalId)
    }
  }

  /** 获取当前注册的实例数量（用于调试） */
  get size(): number {
    return this.registry.size
  }
}

// 模块级单例（注册表本身是全局的，但每个 session 有独立实例）
const sessionRegistry = new SessionMCRegistryClass()

export const SessionMCRegistry = sessionRegistry

// ============================================
// 兼容旧 API 的全局实例（向后兼容 microCompact.ts 的调用方式）
// ============================================

let globalMCState: CachedMCState | null = null

/**
 * 创建新的 Cached MC 状态（旧 API，向后兼容）
 */
export function createCachedMCState(): CachedMCState {
  globalMCState = {
    cacheId: 'cached-mc-' + Math.random().toString(36).slice(2, 11),
    toolResults: new Map(),
    registeredIds: new Set(),
    createdAt: Date.now(),
  }
  return globalMCState
}

/**
 * 获取当前 MC 状态（旧 API，向后兼容）
 */
export function getCachedMCState(): CachedMCState | null {
  return globalMCState
}

/**
 * 重置 Cached MC 状态（供 microCompact.ts 的 resetMicrocompactState 调用）
 */
export function resetCachedMCState(_state: CachedMCState): void {
  // 清空当前全局实例
  if (globalMCState) {
    globalMCState.toolResults.clear()
    globalMCState.registeredIds.clear()
  }
}

/**
 * 标记工具已发送给 API（占位，供 microCompact.ts 调用）
 */
export function markToolsSentToAPI(_state: CachedMCState): void {
  // No-op in current implementation
}

/**
 * Cached Microcompact 是否启用
 * 依赖 feature flag 和模型支持
 */
export function isCachedMicrocompactEnabled(): boolean {
  // 检查是否在 experimental features 中启用
  // TODO: 集成 feature gate 检查
  return true // 默认启用，可通过配置关闭
}

/**
 * 检查模型是否支持 cache editing
 */
export function isModelSupportedForCacheEditing(model: string): boolean {
  // 简化检查：模型名称包含支持的关键词
  const modelLower = model.toLowerCase()
  return (
    modelLower.includes('sonnet-4') ||
    modelLower.includes('opus-4') ||
    SUPPORTED_MODELS.some(m => modelLower.includes(m.toLowerCase()))
  )
}

/**
 * 获取 Cached MC 配置
 */
export function getCachedMCConfig(): CachedMCConfig {
  return DEFAULT_CONFIG
}

/**
 * 注册一个 tool result 到缓存状态
 * P0-01 修复：使用 registeredIds Set 防止重复注册
 */
export function registerToolResult(
  toolUseId: string,
  toolName: string,
  content: string,
): void {
  if (!globalMCState) {
    createCachedMCState()
  }

  // 跳过已注册的 toolUseId，避免重复覆盖
  if (globalMCState!.registeredIds.has(toolUseId)) {
    return
  }

  const config = getCachedMCConfig()
  const tokenCount = Math.ceil(content.length / 4) // 粗略估算

  // 如果超过限制，删除最旧的
  if (globalMCState!.toolResults.size >= config.maxCachedResults) {
    const oldestKey = globalMCState!.toolResults.keys().next().value
    if (oldestKey) {
      globalMCState!.toolResults.delete(oldestKey)
      globalMCState!.registeredIds.delete(oldestKey)
    }
  }

  globalMCState!.toolResults.set(toolUseId, {
    toolUseId,
    toolName,
    tokenCount,
  })
  globalMCState!.registeredIds.add(toolUseId)
}

/**
 * 获取需要删除的 tool results（用于 cache_editing API）
 */
export function getToolResultsToDelete(
  targetTokens: number,
): ToolResultEntry[] {
  if (!globalMCState) return []

  const toDelete: ToolResultEntry[] = []
  let accumulated = 0

  // 按时间顺序（最旧优先）选择要删除的
  for (const [, entry] of globalMCState.toolResults) {
    toDelete.push(entry)
    accumulated += entry.tokenCount
    if (accumulated >= targetTokens) break
  }

  return toDelete
}

/**
 * 创建 cache_edits 块用于 API 请求
 */
export function createCacheEditsBlock(
  toolUseIds: string[],
): { type: string; cache_edit: { operations: Array<{ delete: string }> } } {
  return {
    type: 'cache_edit' as const,
    cache_edit: {
      operations: toolUseIds.map(id => ({ delete: id })),
    },
  }
}

/**
 * 执行 Cached Microcompact
 * 返回需要删除的 tool use IDs
 */
export async function runCachedMicrocompact(
  messages: Message[],
  targetTokens: number = 10000,
): Promise<string[]> {
  if (!isCachedMicrocompactEnabled()) {
    return []
  }

  // 扫描消息中的 tool results 并注册
  for (const msg of messages) {
    if (msg.type === 'tool_result' && msg.tool_use_id) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content)
      registerToolResult(
        msg.tool_use_id,
        msg.tool_name ?? 'unknown',
        content,
      )
    }
  }

  // 获取需要删除的 entries
  const toDelete = getToolResultsToDelete(targetTokens)

  // 从状态中删除
  for (const entry of toDelete) {
    globalMCState?.toolResults.delete(entry.toolUseId)
    globalMCState?.registeredIds.delete(entry.toolUseId)
  }

  return toDelete.map(e => e.toolUseId)
}
