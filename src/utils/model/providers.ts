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
