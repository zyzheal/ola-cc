import { readFileSync } from 'fs'
import { join } from 'path'

// Lazy evaluation: env vars are only read when first accessed,
// preventing crashes at module load time.
// Falls back to ~/.claude/settings.json env field, then default value.

let _settingsEnv: Record<string, string> | undefined
function getSettingsEnv(): Record<string, string> {
  if (_settingsEnv !== undefined) return _settingsEnv
  try {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (!home) {
      _settingsEnv = {}
      return _settingsEnv
    }
    const settingsPath = join(home, '.claude', 'settings.json')
    const raw = readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    _settingsEnv = parsed?.env || {}
  } catch {
    _settingsEnv = {}
  }
  return _settingsEnv
}

function lazyEnv(name: string, defaultValue?: string): string {
  let value: string | undefined
  return new Proxy({} as string, {
    get(_, prop) {
      if (value === undefined) {
        value = process.env[name] || getSettingsEnv()[name]
        if (!value && defaultValue !== undefined) value = defaultValue
        if (!value) {
          throw new Error(
            `Missing required environment variable: ${name}. ` +
            `Please configure it in process.env or ~/.claude/settings.json env field.`,
          )
        }
      }
      const v = value
      const result = (v as any)[prop]
      return typeof result === 'function' ? result.bind(v) : result
    },
    getOwnPropertyDescriptor() {
      if (value === undefined) {
        value = process.env[name] || getSettingsEnv()[name]
        if (!value && defaultValue !== undefined) value = defaultValue
        if (!value) {
          throw new Error(
            `Missing required environment variable: ${name}. ` +
            `Please configure it in process.env or ~/.claude/settings.json env field.`,
          )
        }
      }
      return { value, enumerable: true, configurable: true, writable: true }
    },
  }) as unknown as string
}

export const PRODUCT_URL = lazyEnv('CLAUDE_PRODUCT_URL', 'https://claude.ai')

// ola-cc Remote session URLs — default to Anthropic official URLs
export const CLAUDE_AI_BASE_URL = lazyEnv('CLAUDE_AI_BASE_URL', 'https://claude.ai')
export const CLAUDE_AI_STAGING_BASE_URL = lazyEnv('CLAUDE_AI_STAGING_BASE_URL', 'https://staging.claude.ai')
export const CLAUDE_AI_LOCAL_BASE_URL = lazyEnv('CLAUDE_AI_LOCAL_BASE_URL', 'http://localhost:3000')

/**
 * Determine if we're in a staging environment for remote sessions.
 */
export function isRemoteSessionStaging(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_staging_') === true ||
    ingressUrl?.includes('staging') === true
  )
}

/**
 * Determine if we're in a local-dev environment for remote sessions.
 */
export function isRemoteSessionLocal(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_local_') === true ||
    ingressUrl?.includes('localhost') === true
  )
}

/**
 * Get the base URL for Claude AI based on environment.
 */
export function getClaudeAiBaseUrl(
  sessionId?: string,
  ingressUrl?: string,
): string {
  if (isRemoteSessionLocal(sessionId, ingressUrl)) {
    return CLAUDE_AI_LOCAL_BASE_URL
  }
  if (isRemoteSessionStaging(sessionId, ingressUrl)) {
    return CLAUDE_AI_STAGING_BASE_URL
  }
  return CLAUDE_AI_BASE_URL
}

/**
 * Get the full session URL for a remote session.
 */
export function getRemoteSessionUrl(
  sessionId: string,
  ingressUrl?: string,
): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { toCompatSessionId } =
    require('../bridge/sessionIdCompat.js') as typeof import('../bridge/sessionIdCompat.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const compatId = toCompatSessionId(sessionId)
  const baseUrl = getClaudeAiBaseUrl(compatId, ingressUrl)
  return `${baseUrl}/code/${compatId}`
}
