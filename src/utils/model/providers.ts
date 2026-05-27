import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai'

/**
 * Common third-party proxy hosts that use the Anthropic-compatible API format
 * but don't support prompt caching and other first-party features.
 */
const THIRD_PARTY_HOSTS = [
  'dashscope.aliyuncs.com',
  'coding.dashscope.aliyuncs.com',
  'api.deepseek.com',
  'cmecloud.cn',
]

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
          ? 'openai'
          : 'firstParty'
}

/**
 * Check if the current provider is a known third-party proxy.
 * This is used to disable features that only work with first-party Anthropic API,
 * such as prompt cache sharing (cache_control markers).
 */
export function isThirdPartyProvider(): boolean {
  // If CLAUDE_CODE_USE_OPENAI is set, it's definitely third-party
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    return true
  }

  // Check ANTHROPIC_BASE_URL against known third-party hosts
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).host
      // Use exact match or subdomain boundary (preceded by dot)
      // to prevent false positives like "evil-dashscope.aliyuncs.com"
      return THIRD_PARTY_HOSTS.some(h => host === h || host.endsWith('.' + h))
    } catch {
      // If URL is invalid, conservatively treat as third-party
      // (disable cache sharing since we cannot verify support)
      return true
    }
  }

  return false
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is the configured API URL.
 * Returns true if not set (default API) or matches the configured BASE_API_URL host.
 */
/**
 * 缓存策略类型：
 * - explicit: Claude 原生 cache_control marker
 * - prefix:   DeepSeek/vLLM 自动 prefix caching（需前缀稳定）
 */
export type CacheStrategy = 'explicit' | 'prefix'

/** 已知支持 prefix caching 的 hostname 列表 */
const PREFIX_CACHE_HOSTS = [
  'api.deepseek.com',
  'moma.cmecloud.cn',
]

/**
 * 检测当前 provider 的缓存策略。
 *
 * - OpenAI 兼容模式：检查 OPENAI_API_BASE / OPENAI_BASE_URL
 * - Anthropic API 模式：检查 ANTHROPIC_BASE_URL
 * - 可通过 OLA_CC_PREFIX_CACHE_HOSTS 环境变量扩展白名单
 */
export function getCacheStrategy(): CacheStrategy {
  // 环境变量显式指定
  if (isEnvTruthy(process.env.OLA_CC_FORCE_PREFIX_CACHE)) {
    return 'prefix'
  }
  if (isEnvTruthy(process.env.OLA_CC_FORCE_EXPLICIT_CACHE)) {
    return 'explicit'
  }

  const extraHosts = process.env.OLA_CC_PREFIX_CACHE_HOSTS
    ? process.env.OLA_CC_PREFIX_CACHE_HOSTS.split(',').map(h => h.trim()).filter(Boolean)
    : []
  const allHosts = [...PREFIX_CACHE_HOSTS, ...extraHosts]

  // OpenAI 兼容模式
  const openaiBase = process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL
  if (openaiBase) {
    try {
      const host = new URL(openaiBase).host
      if (allHosts.some(h => host === h || host.endsWith('.' + h))) return 'prefix'
    } catch {}
    return 'explicit'
  }

  // Anthropic API 模式
  if (process.env.ANTHROPIC_BASE_URL) {
    try {
      const host = new URL(process.env.ANTHROPIC_BASE_URL).host
      if (allHosts.some(h => host === h || host.endsWith('.' + h))) return 'prefix'
    } catch {}
  }

  return 'explicit'
}

export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const configHost = new URL(getOauthConfig().BASE_API_URL).host
    return new URL(baseUrl).host === configHost
  } catch {
    return false
  }
}
