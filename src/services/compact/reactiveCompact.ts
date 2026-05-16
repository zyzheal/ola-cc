import type { Message } from '../../types/message.js'
import { groupMessagesByApiRound } from './grouping.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'

export interface ReactiveCompactConfig {
  maxRetries: number // 默认 3
  initialOverflowMultiplier: number // 1.2 从 120% 开始
  minMessagesToKeep: number // 最少保留最近 N 条
}

const DEFAULT_CONFIG: ReactiveCompactConfig = {
  maxRetries: 3,
  initialOverflowMultiplier: 1.2,
  minMessagesToKeep: 2,
}

/**
 * Reactive Compact: 当 API 返回 413 (prompt too long) 时自动触发
 *
 * 核心逻辑：
 * 1. 从原始溢出大小开始计算需要删除的 token 数
 * 2. 按 API round 分组消息
 * 3. 从最旧的组开始逐步删除，直到在限制内
 * 4. 最多重试 maxRetries 次
 */
export async function runReactiveCompact(
  messages: Message[],
  overflowSize: number,
  config: Partial<ReactiveCompactConfig> = {},
): Promise<Message[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // 计算初始需要删除的 token 数（考虑 multiplier）
  const targetDropTokens = Math.ceil(overflowSize * cfg.initialOverflowMultiplier)

  return tryReactiveCompact(messages, targetDropTokens, cfg)
}

/**
 * 尝试响应式压缩
 */
async function tryReactiveCompact(
  messages: Message[],
  targetDropTokens: number,
  config: ReactiveCompactConfig,
): Promise<Message[]> {
  const groups = groupMessagesByApiRound(messages)

  if (groups.length <= config.minMessagesToKeep) {
    // 消息太少，无法进一步压缩
    return messages
  }

  let accumulatedDrop = 0
  let dropCount = 0

  // 从最旧的组开始，计算需要删除多少组
  for (let i = 0; i < groups.length - config.minMessagesToKeep; i++) {
    accumulatedDrop += roughTokenCountEstimationForMessages(groups[i])
    dropCount = i + 1

    if (accumulatedDrop >= targetDropTokens) {
      break
    }
  }

  // 确保至少保留 config.minMessagesToKeep 组
  const actualDropCount = Math.min(dropCount, groups.length - config.minMessagesToKeep)

  if (actualDropCount < 1) {
    return messages
  }

  // 返回删除后的消息
  const result = groups.slice(actualDropCount).flat()

  // 如果删除后仍然超出限制，递归尝试
  const newTokenCount = roughTokenCountEstimationForMessages(result)
  if (newTokenCount > targetDropTokens * 1.5 && config.maxRetries > 1) {
    // 还需要更多删除，递归重试（减少 multiplier）
    return tryReactiveCompact(
      result,
      targetDropTokens * 0.8,
      { ...config, maxRetries: config.maxRetries - 1 },
    )
  }

  return result
}

/**
 * 当收到 413 错误时触发响应式压缩
 */
export async function runReactiveCompactOnPTL(
  messages: Message[],
  ptlError: { overflow_size?: number },
  config?: Partial<ReactiveCompactConfig>,
): Promise<Message[]> {
  // 从错误中获取溢出大小，如果没有则使用默认计算
  const overflowSize = ptlError.overflow_size ?? 10000

  return runReactiveCompact(messages, overflowSize, config)
}
