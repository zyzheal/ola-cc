/**
 * Cached Microcompact: 使用 API cache_editing 功能清理 tool results
 *
 * 优势：直接编辑缓存而不修改消息内容，保持缓存前缀有效
 * 适用场景：需要清理旧 tool results 但不想触发完整压缩
 */

import type { Message } from '../../types/message.js'

export interface CachedMCState {
  cacheId: string
  toolResults: Map<string, ToolResultEntry>
  createdAt: number
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

let globalMCState: CachedMCState | null = null

/**
 * 创建新的 Cached MC 状态
 */
export function createCachedMCState(): CachedMCState {
  globalMCState = {
    cacheId: 'cached-mc-' + Math.random().toString(36).slice(2, 11),
    toolResults: new Map(),
    createdAt: Date.now(),
  }
  return globalMCState
}

/**
 * 获取当前 MC 状态
 */
export function getCachedMCState(): CachedMCState | null {
  return globalMCState
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
 */
export function registerToolResult(
  toolUseId: string,
  toolName: string,
  content: string,
): void {
  if (!globalMCState) {
    createCachedMCState()
  }

  const config = getCachedMCConfig()
  const tokenCount = Math.ceil(content.length / 4) // 粗略估算

  // 如果超过限制，删除最旧的
  if (globalMCState.toolResults.size >= config.maxCachedResults) {
    const oldestKey = globalMCState.toolResults.keys().next().value
    if (oldestKey) {
      globalMCState.toolResults.delete(oldestKey)
    }
  }

  globalMCState.toolResults.set(toolUseId, {
    toolUseId,
    toolName,
    tokenCount,
  })
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
  for (const [_, entry] of globalMCState.toolResults) {
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
  }

  return toDelete.map(e => e.toolUseId)
}
