/**
 * OAuth 配置模块
 *
 * OAuth 功能默认禁用。不配置任何 OAuth 环境变量时，getOauthConfig() 返回 undefined。
 * 如需启用 OAuth，在 ~/.ola-cc/settings.json env 字段或 process.env 中设置对应变量。
 */

export type OauthConfig = {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  OLA_CC_AI_AUTHORIZE_URL: string
  OLA_CC_AI_ORIGIN: string
  TOKEN_URL: string
  API_KEY_URL: string
  ROLES_URL: string
  CONSOLE_SUCCESS_URL: string
  CLAUDEAI_SUCCESS_URL: string
  MANUAL_REDIRECT_URL: string
  CLIENT_ID: string
  OAUTH_FILE_SUFFIX: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
}

export const OLA_CC_AI_INFERENCE_SCOPE = 'user:inference' as const
// Backward compatibility alias (deprecated)
export const CLAUDE_AI_INFERENCE_SCOPE = OLA_CC_AI_INFERENCE_SCOPE

export const OLA_CC_AI_PROFILE_SCOPE = 'user:profile' as const
// Backward compatibility alias (deprecated)
export const CLAUDE_AI_PROFILE_SCOPE = OLA_CC_AI_PROFILE_SCOPE
const CONSOLE_SCOPE = 'org:create_api_key' as const
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const

export const CONSOLE_OAUTH_SCOPES = [
  CONSOLE_SCOPE,
  OLA_CC_AI_PROFILE_SCOPE,
] as const

export const OLA_CC_AI_OAUTH_SCOPES = [
  OLA_CC_AI_PROFILE_SCOPE,
  OLA_CC_AI_INFERENCE_SCOPE,
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

// Backward compatibility alias (deprecated)
export const CLAUDE_AI_OAUTH_SCOPES = OLA_CC_AI_OAUTH_SCOPES

export const ALL_OAUTH_SCOPES = Array.from(
  new Set([...CONSOLE_OAUTH_SCOPES, ...OLA_CC_AI_OAUTH_SCOPES]),
)

const OAUTH_ENV_KEYS = [
  'OLA_CC_AI_BASE_URL',
  'OLA_CC_OAUTH_CONSOLE_AUTHORIZE_URL',
  'OLA_CC_OAUTH_OLA_CC_AI_AUTHORIZE_URL',
  'OLA_CC_OAUTH_OLA_CC_AI_ORIGIN',
  'OLA_CC_OAUTH_TOKEN_URL',
  'OLA_CC_OAUTH_API_KEY_URL',
  'OLA_CC_OAUTH_ROLES_URL',
  'OLA_CC_OAUTH_CONSOLE_SUCCESS_URL',
  'OLA_CC_OAUTH_CLAUDEAI_SUCCESS_URL',
  'OLA_CC_OAUTH_MANUAL_REDIRECT_URL',
  'OLA_CC_OAUTH_CLIENT_ID',
  'OLA_CC_MCP_PROXY_URL',
] as const

let _oauthConfig: OauthConfig | undefined
let _oauthChecked = false

/**
 * Read env var: process.env → settings.json env → undefined
 */
function getEnv(name: string): string | undefined {
  let value = process.env[name]
  if (!value) {
    try {
      const { readFileSync } = require('fs')
      const { join } = require('path')
      const home = process.env.HOME || process.env.USERPROFILE || ''
      if (home) {
        const settingsPath = join(home, '.ola-cc', 'settings.json')
        const raw = readFileSync(settingsPath, 'utf-8')
        const parsed = JSON.parse(raw)
        value = parsed?.env?.[name]
      }
    } catch {
      // settings.json not found or parse error
    }
  }
  return value || undefined
}

/**
 * Check if OAuth is enabled by looking for any OAuth-related env var.
 */
export function isOAuthConfigured(): boolean {
  for (const key of OAUTH_ENV_KEYS) {
    if (process.env[key]) return true
  }
  try {
    const { readFileSync } = require('fs')
    const { join } = require('path')
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (home) {
      const settingsPath = join(home, '.ola-cc', 'settings.json')
      const raw = readFileSync(settingsPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed?.env) {
        for (const key of OAUTH_ENV_KEYS) {
          if (parsed.env[key]) return true
        }
      }
    }
  } catch {
    // ignore
  }
  return false
}

function buildOauthConfig(): OauthConfig | undefined {
  const values: Record<string, string> = {}
  for (const key of OAUTH_ENV_KEYS) {
    const v = getEnv(key)
    if (!v) return undefined // not fully configured
    values[key] = v
  }
  return {
    BASE_API_URL: values['OLA_CC_AI_BASE_URL'],
    CONSOLE_AUTHORIZE_URL: values['OLA_CC_OAUTH_CONSOLE_AUTHORIZE_URL'],
    OLA_CC_AI_AUTHORIZE_URL: values['OLA_CC_OAUTH_OLA_CC_AI_AUTHORIZE_URL'],
    OLA_CC_AI_ORIGIN: values['OLA_CC_OAUTH_OLA_CC_AI_ORIGIN'],
    TOKEN_URL: values['OLA_CC_OAUTH_TOKEN_URL'],
    API_KEY_URL: values['OLA_CC_OAUTH_API_KEY_URL'],
    ROLES_URL: values['OLA_CC_OAUTH_ROLES_URL'],
    CONSOLE_SUCCESS_URL: values['OLA_CC_OAUTH_CONSOLE_SUCCESS_URL'],
    CLAUDEAI_SUCCESS_URL: values['OLA_CC_OAUTH_CLAUDEAI_SUCCESS_URL'],
    MANUAL_REDIRECT_URL: values['OLA_CC_OAUTH_MANUAL_REDIRECT_URL'],
    CLIENT_ID: values['OLA_CC_OAUTH_CLIENT_ID'],
    OAUTH_FILE_SUFFIX: '',
    MCP_PROXY_URL: values['OLA_CC_MCP_PROXY_URL'],
    MCP_PROXY_PATH: '/v1/mcp/{server_id}',
  }
}

export function fileSuffixForOauthConfig(): string {
  return ''
}

/**
 * Client ID Metadata Document URL for MCP OAuth.
 */
export const MCP_CLIENT_METADATA_URL =
  'https://claude.ai/oauth/claude-code-client-metadata'

/**
 * Get OAuth config. Returns undefined if OAuth is not configured.
 * Enable by setting OAuth env vars in process.env or ~/.ola-cc/settings.json env field.
 */
export function getOauthConfig(): OauthConfig | undefined {
  if (!_oauthChecked) {
    _oauthChecked = true
    _oauthConfig = buildOauthConfig()
  }

  if (!_oauthConfig) return undefined

  const clientIdOverride = process.env.OLA_CC_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    return {
      ..._oauthConfig,
      CLIENT_ID: clientIdOverride,
    }
  }

  return _oauthConfig
}
