/**
 * 读取必需的环境变量，未设置则抛出异常。
 * 所有 OAuth/API 端点均通过此函数强制要求配置。
 * 每个环境变量在文件头部有对应的配置说明注释。
 */
export function getEnvOrThrow(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Please configure it before running the application.`
    )
  }
  return value
}

// OAuth config type is now always 'prod' (all values come from env vars)
type OauthConfigType = 'prod'

function getOauthConfigType(): 'prod' {
  return 'prod'
}

// Always return empty suffix since OAUTH_FILE_SUFFIX is now always ''
export function fileSuffixForOauthConfig(): string {
  return ''
}

export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference' as const
export const CLAUDE_AI_PROFILE_SCOPE = 'user:profile' as const
const CONSOLE_SCOPE = 'org:create_api_key' as const
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const

// Console OAuth scopes - for API key creation via Console
export const CONSOLE_OAUTH_SCOPES = [
  CONSOLE_SCOPE,
  CLAUDE_AI_PROFILE_SCOPE,
] as const

// Claude.ai OAuth scopes - for Claude.ai subscribers (Pro/Max/Team/Enterprise)
export const CLAUDE_AI_OAUTH_SCOPES = [
  CLAUDE_AI_PROFILE_SCOPE,
  CLAUDE_AI_INFERENCE_SCOPE,
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

// All OAuth scopes - union of all scopes used in Claude CLI
// When logging in, request all scopes in order to handle both Console -> Claude.ai redirect
// Ensure that `OAuthConsentPage` in apps repo is kept in sync with this list.
export const ALL_OAUTH_SCOPES = Array.from(
  new Set([...CONSOLE_OAUTH_SCOPES, ...CLAUDE_AI_OAUTH_SCOPES]),
)

type OauthConfig = {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  CLAUDE_AI_AUTHORIZE_URL: string
  /**
   * The claude.ai web origin. Separate from CLAUDE_AI_AUTHORIZE_URL because
   * that now routes through claude.com/cai/* for attribution — deriving
   * .origin from it would give claude.com, breaking links to /code,
   * /settings/connectors, and other claude.ai web pages.
   */
  CLAUDE_AI_ORIGIN: string
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

// ============================================================
// OAuth/API 端点配置 — 全部通过环境变量提供，无默认值
//
// 必需环境变量清单:
//   CLAUDE_API_BASE_URL                  — API 基础地址
//   CLAUDE_OAUTH_CONSOLE_AUTHORIZE_URL   — Console OAuth 授权页
//   CLAUDE_OAUTH_CLAUDE_AI_AUTHORIZE_URL — claude.ai OAuth 授权页
//   CLAUDE_OAUTH_CLAUDE_AI_ORIGIN        — claude.ai Web Origin
//   CLAUDE_OAUTH_TOKEN_URL              — Token 交换端点
//   CLAUDE_OAUTH_API_KEY_URL            — API Key 创建端点
//   CLAUDE_OAUTH_ROLES_URL              — 用户角色查询端点
//   CLAUDE_OAUTH_CLIENT_ID              — OAuth Client ID
//   CLAUDE_OAUTH_CONSOLE_SUCCESS_URL    — Console 认证成功跳转页
//   CLAUDE_OAUTH_CLAUDEAI_SUCCESS_URL   — claude.ai 认证成功跳转页
//   CLAUDE_OAUTH_MANUAL_REDIRECT_URL    — 手动认证回调地址
//   CLAUDE_MCP_PROXY_URL                — MCP 代理服务器地址
// ============================================================

const PROD_OAUTH_CONFIG = {
  BASE_API_URL: getEnvOrThrow('CLAUDE_API_BASE_URL'),
  CONSOLE_AUTHORIZE_URL: getEnvOrThrow('CLAUDE_OAUTH_CONSOLE_AUTHORIZE_URL'),
  CLAUDE_AI_AUTHORIZE_URL: getEnvOrThrow('CLAUDE_OAUTH_CLAUDE_AI_AUTHORIZE_URL'),
  CLAUDE_AI_ORIGIN: getEnvOrThrow('CLAUDE_OAUTH_CLAUDE_AI_ORIGIN'),
  TOKEN_URL: getEnvOrThrow('CLAUDE_OAUTH_TOKEN_URL'),
  API_KEY_URL: getEnvOrThrow('CLAUDE_OAUTH_API_KEY_URL'),
  ROLES_URL: getEnvOrThrow('CLAUDE_OAUTH_ROLES_URL'),
  CONSOLE_SUCCESS_URL: getEnvOrThrow('CLAUDE_OAUTH_CONSOLE_SUCCESS_URL'),
  CLAUDEAI_SUCCESS_URL: getEnvOrThrow('CLAUDE_OAUTH_CLAUDEAI_SUCCESS_URL'),
  MANUAL_REDIRECT_URL: getEnvOrThrow('CLAUDE_OAUTH_MANUAL_REDIRECT_URL'),
  CLIENT_ID: getEnvOrThrow('CLAUDE_OAUTH_CLIENT_ID'),
  OAUTH_FILE_SUFFIX: '',
  MCP_PROXY_URL: getEnvOrThrow('CLAUDE_MCP_PROXY_URL'),
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
} as const

/**
 * Client ID Metadata Document URL for MCP OAuth (CIMD / SEP-991).
 * When an MCP auth server advertises client_id_metadata_document_supported: true,
 * Claude Code uses this URL as its client_id instead of Dynamic Client Registration.
 * The URL must point to a JSON document hosted by Anthropic.
 * See: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00
 */
export const MCP_CLIENT_METADATA_URL =
  'https://claude.ai/oauth/claude-code-client-metadata'

// Default to prod config (all values come from environment variables)
export function getOauthConfig(): OauthConfig {
  const config = PROD_OAUTH_CONFIG

  // Allow CLIENT_ID override via environment variable (e.g., for Xcode integration)
  const clientIdOverride = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    return {
      ...config,
      CLIENT_ID: clientIdOverride,
    }
  }

  return config
}
