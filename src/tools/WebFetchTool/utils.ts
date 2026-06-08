import axios, { type AxiosResponse } from 'axios'
import { getEnvOrThrow } from '../../utils/envUtils.js'
import { LRUCache } from 'lru-cache'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { queryHaiku } from '../../services/api/claude.js'
import { AbortError } from '../../utils/errors.js'
import { getWebFetchUserAgent } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import {
  isBinaryContentType,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import {
  TIMEOUTS,
  LIMITS,
  ERROR_MESSAGES,
  ERROR_TYPES,
  CACHE,
} from './constants.js'
import { domainPreferenceManager } from './DomainPreferenceManager.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { isPreapprovedHost } from './preapproved.js'
import { makeSecondaryModelPrompt } from './prompt.js'

// Custom error classes for domain blocking
class DomainBlockedError extends Error {
  constructor(domain: string) {
    super(`ola-cc is unable to fetch from ${domain}`)
    this.name = 'DomainBlockedError'
  }
}

class DomainCheckFailedError extends Error {
  constructor(domain: string) {
    super(
      `Unable to verify if domain ${domain} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking claude.ai.`,
    )
    this.name = 'DomainCheckFailedError'
  }
}

class EgressBlockedError extends Error {
  constructor(public readonly domain: string) {
    super(
      JSON.stringify({
        error_type: 'EGRESS_BLOCKED',
        domain,
        message: `Access to ${domain} is blocked by the network egress proxy.`,
      }),
    )
    this.name = 'EgressBlockedError'
  }
}

class DomainCheckRequiresConfirmationError extends Error {
  constructor(
    public readonly domain: string,
    public readonly message: string,
  ) {
    super(
      JSON.stringify({
        error_type: 'DOMAIN_CHECK_REQUIRES_CONFIRMATION',
        domain,
        message,
      }),
    )
    this.name = 'DomainCheckRequiresConfirmationError'
  }
}

// Cache for storing fetched URL content
type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

// Cache configuration using constants from constants.ts
/** @internal - exported for testing only */
export const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: CACHE.MAX_URL_CACHE_SIZE,
  ttl: CACHE.TTL_URL,
})

// Separate cache for preflight domain checks. URL_CACHE is URL-keyed, so
// fetching two paths on the same domain triggers two identical preflight
// HTTP round-trips to api.anthropic.com. This hostname-keyed cache avoids
// that. Only 'allowed' is cached — blocked/failed re-check on next attempt.
/** @internal - exported for testing only */
export const DOMAIN_CHECK_CACHE = new LRUCache<string, true>({
  max: CACHE.MAX_DOMAIN_CACHE_SIZE,
  ttl: CACHE.TTL_DOMAIN_CHECK,
})

export function clearWebFetchCache(): void {
  URL_CACHE.clear()
  DOMAIN_CHECK_CACHE.clear()
}

// Lazy singleton — defers the turndown → @mixmark-io/domino import (~1.4MB
// retained heap) until the first HTML fetch, and reuses one instance across
// calls (construction builds 15 rule objects; .turndown() is stateless).
// @types/turndown ships only `export =` (no .d.mts), so TS types the import
// as the class itself while Bun wraps CJS in { default } — hence the cast.
type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

// PSR requested limiting the length of URLs to 250 to lower the potential
// for a data exfiltration. However, this is too restrictive for some customers'
// legitimate use cases, such as JWT-signed URLs (e.g., cloud service signed URLs)
// that can be much longer. We already require user approval for each domain,
// which provides a primary security boundary. In addition, ola-cc has
// other data exfil channels, and this one does not seem relatively high risk,
// so I'm removing that length restriction. -ab
// Cap same-host redirect hops. Without this a malicious server can return
// a redirect loop (/a → /b → /a …) and the per-request FETCH_TIMEOUT_MS
// resets on every hop, hanging the tool until user interrupt.
const MAX_REDIRECTS = LIMITS.MAX_REDIRECTS // ~500KB

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)
  } catch {
    return false
  }
}

export function validateURL(url: string): boolean {
  if (url.length > LIMITS.MAX_URL_LENGTH) {
    return false
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // We don't need to check protocol here, as we'll upgrade http to https when making the request

  // As long as we aren't supporting aiming to cookies or internal domains,
  // we should block URLs with usernames/passwords too, even though these
  // seem exceedingly unlikely.
  if (parsed.username || parsed.password) {
    return false
  }

  // Initial filter that this isn't a privileged, company-internal URL
  // by checking that the hostname is publicly resolvable
  const hostname = parsed.hostname
  const parts = hostname.split('.')
  if (parts.length < 2) {
    return false
  }

  return true
}

type DomainCheckResult =
  | { status: 'allowed' }
  | { status: 'blocked' }
  | { status: 'check_failed'; error: Error }

export async function checkDomainBlocklist(
  domain: string,
  requireConfirmationOnFailure: boolean = false,
): Promise<DomainCheckResult | { status: 'requires_confirmation'; message: string }> {
  // Basic domain validation
  if (!domain || typeof domain !== 'string' || domain.length > 253) {
    throw new Error('Invalid domain name')
  }

  // Check cache first
  if (DOMAIN_CHECK_CACHE.has(domain)) {
    return { status: 'allowed' }
  }

  // Validate domain format
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
  if (!domainRegex.test(domain)) {
    if (requireConfirmationOnFailure) {
      return {
        status: 'requires_confirmation',
        message: `域名格式异常: ${domain}。请确认是否要继续访问。`,
      }
    }
    return {
      status: 'check_failed',
      error: new Error(`Invalid domain format: ${domain}`),
    }
  }

  // Try domain check with retry logic
  const maxRetries = 1
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(
        `${getEnvOrThrow('CLAUDE_WEB_DOMAIN_INFO_URL')}?domain=${encodeURIComponent(domain)}`,
        {
          timeout: TIMEOUTS.DOMAIN_CHECK,
          headers: {
            'User-Agent': 'ola-cc-webfetch/1.0',
          },
        },
      )

      if (response.status === 200) {
        if (response.data.can_fetch === true) {
          DOMAIN_CHECK_CACHE.set(domain, true)
          return { status: 'allowed' }
        }
        return { status: 'blocked' }
      }

      // Non-200 status but didn't throw
      if (requireConfirmationOnFailure) {
        return {
          status: 'requires_confirmation',
          message: `无法验证域名 ${domain} 的安全性。服务器返回状态码 ${response.status}。`,
        }
      }
      return {
        status: 'check_failed',
        error: new Error(`Domain check returned status ${response.status}`),
      }
    } catch (e) {
      lastError = e as Error
      logError(e)

      // If it's not a network error, don't retry
      if (axios.isAxiosError(e) && e.response?.status >= 400) {
        break
      }

      // Wait before retry (exponential backoff)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
      }
    }
  }

  // All attempts failed
  if (requireConfirmationOnFailure) {
    return {
      status: 'requires_confirmation',
      message: `无法验证域名 ${domain} 的安全性。这可能是由于网络限制或企业安全策略阻止了对 claude.ai 的访问。`,
    }
  }
  return { status: 'check_failed', error: lastError || new Error('Unknown error during domain check') }
}

/**
 * Check if a redirect is safe to follow
 * Allows redirects that:
 * - Add or remove "www." in the hostname
 * - Keep the origin the same but change path/query params
 * - Or both of the above
 */
export function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const parsedOriginal = new URL(originalUrl)
    const parsedRedirect = new URL(redirectUrl)

    if (parsedRedirect.protocol !== parsedOriginal.protocol) {
      return false
    }

    if (parsedRedirect.port !== parsedOriginal.port) {
      return false
    }

    if (parsedRedirect.username || parsedRedirect.password) {
      return false
    }

    // Now check hostname conditions
    // 1. Adding www. is allowed: example.com -> www.example.com
    // 2. Removing www. is allowed: www.example.com -> example.com
    // 3. Same host (with or without www.) is allowed: paths can change
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '')
    const originalHostWithoutWww = stripWww(parsedOriginal.hostname)
    const redirectHostWithoutWww = stripWww(parsedRedirect.hostname)
    return originalHostWithoutWww === redirectHostWithoutWww
  } catch (_error) {
    return false
  }
}

/**
 * Helper function to handle fetching URLs with custom redirect handling
 * Recursively follows redirects if they pass the redirectChecker function
 *
 * Per PSR:
 * "Do not automatically follow redirects because following redirects could
 * allow for an attacker to exploit an open redirect vulnerability in a
 * trusted domain to force a user to make a request to a malicious domain
 * unknowingly"
 */
type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`)
  }
  try {
    return await axios.get(url, {
      signal,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_HTTP_CONTENT_LENGTH,
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': getWebFetchUserAgent(),
      },
    })
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response &&
      [301, 302, 307, 308].includes(error.response.status)
    ) {
      const redirectLocation = error.response.headers.location
      if (!redirectLocation) {
        throw new Error('Redirect missing Location header')
      }

      // Resolve relative URLs against the original URL
      const redirectUrl = new URL(redirectLocation, url).toString()

      if (redirectChecker(url, redirectUrl)) {
        // Recursively follow the permitted redirect
        return getWithPermittedRedirects(
          redirectUrl,
          signal,
          redirectChecker,
          depth + 1,
        )
      } else {
        // Return redirect information to the caller
        return {
          type: 'redirect',
          originalUrl: url,
          redirectUrl,
          statusCode: error.response.status,
        }
      }
    }

    // Detect egress proxy blocks: the proxy returns 403 with
    // X-Proxy-Error: blocked-by-allowlist when egress is restricted
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      error.response.headers['x-proxy-error'] === 'blocked-by-allowlist'
    ) {
      const hostname = new URL(url).hostname
      throw new EgressBlockedError(hostname)
    }

    throw error
  }
}

function isRedirectInfo(
  response: AxiosResponse<ArrayBuffer> | RedirectInfo,
): response is RedirectInfo {
  return 'type' in response && response.type === 'redirect'
}

export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
  requireConfirmationOnFailure: boolean = true,
): Promise<FetchedContent | RedirectInfo | { status: 'requires_confirmation'; message: string; domain: string }> {
  if (!validateURL(url)) {
    throw new ERROR_MESSAGES.INVALID_URL(url)
  }

  // Additional validation for common edge cases
  try {
    const parsedUrl = new URL(url)
    if (!parsedUrl.hostname) {
      throw new Error('URL must include a hostname')
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS protocols are supported')
    }
  } catch (error) {
    throw new ERROR_MESSAGES.URL_VALIDATION_FAILED(error instanceof Error ? error.message : String(error))
  }

  const hostname = parsedUrl.hostname

  // Check user preferences first
  if (domainPreferenceManager.isDomainAllowed(hostname)) {
    // Domain is explicitly allowed, skip confirmation
    console.log(`Domain ${hostname} is in allowed list, skipping confirmation`)
  } else if (domainPreferenceManager.isDomainDenied(hostname)) {
    // Domain is explicitly denied
    throw new Error(`Domain ${hostname} is in denied list`)
  } else {
    // Check for academic auto-allow if configured
    if (webFetchConfigManager.shouldAllowAcademic() && domainPreferenceManager.getDomainCategory(hostname) === 'academic') {
      console.log(`Auto-allowing academic domain ${hostname}`)
      domainPreferenceManager.recordDecision(hostname, 'allow', url, 'academic')
    } else if (!requireConfirmationOnFailure || !domainPreferenceManager.shouldAskForConfirmation(hostname)) {
      // User has confirmed recently or confirmation is disabled
      const suggestion = domainPreferenceManager.getSuggestion(hostname)
      if (suggestion === 'allow') {
        console.log(`Auto-allowing domain ${hostname} based on history`)
        domainPreferenceManager.recordDecision(hostname, 'allow', url, domainPreferenceManager.getDomainCategory(hostname))
      }
    }
  }

  // Check cache (LRUCache handles TTL automatically)
  const cachedEntry = URL_CACHE.get(url)
  if (cachedEntry) {
    return {
      bytes: cachedEntry.bytes,
      code: cachedEntry.code,
      codeText: cachedEntry.codeText,
      content: cachedEntry.content,
      contentType: cachedEntry.contentType,
      persistedPath: cachedEntry.persistedPath,
      persistedSize: cachedEntry.persistedSize,
    }
  }

  let parsedUrl: URL
  let upgradedUrl = url

  try {
    parsedUrl = new URL(url)

    // Upgrade http to https if needed
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:'
      upgradedUrl = parsedUrl.toString()
    }

    const hostname = parsedUrl.hostname

    // Check if the user has opted to skip the blocklist check
    // This is for enterprise customers with restrictive security policies
    // that prevent outbound connections to claude.ai
    const settings = getSettings_DEPRECATED()
    if (!settings.skipWebFetchPreflight) {
      const checkResult = await checkDomainBlocklist(hostname, requireConfirmationOnFailure)
      if (checkResult.status === 'requires_confirmation') {
        return {
          status: 'requires_confirmation',
          message: checkResult.message,
          domain: hostname,
        }
      }
      switch (checkResult.status) {
        case 'allowed':
          // Continue with the fetch
          break
        case 'blocked':
          throw new DomainBlockedError(hostname)
        case 'check_failed':
          throw new DomainCheckFailedError(hostname)
      }
    }

    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_web_fetch_host', {
        hostname:
          hostname as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  } catch (e) {
    if (
      e instanceof DomainBlockedError ||
      e instanceof DomainCheckFailedError
    ) {
      // Expected user-facing failures - re-throw without logging as internal error
      throw e
    }
    logError(e)
  }

  const response = await getWithPermittedRedirects(
    upgradedUrl,
    abortController.signal,
    isPermittedRedirect,
  )

  // Check if we got a redirect response
  if (isRedirectInfo(response)) {
    return response
  }

  const rawBuffer = Buffer.from(response.data)
  // Release the axios-held ArrayBuffer copy; rawBuffer owns the bytes now.
  // This lets GC reclaim up to MAX_HTTP_CONTENT_LENGTH (10MB) before Turndown
  // builds its DOM tree (which can be 3-5x the HTML size).
  ;(response as { data: unknown }).data = null
  const contentType = response.headers['content-type'] ?? ''

  // Binary content: save raw bytes to disk with a proper extension so Claude
  // can inspect the file later. We still fall through to the utf-8 decode +
  // Haiku path below — for PDFs in particular the decoded string has enough
  // ASCII structure (/Title, text streams) that Haiku can summarize it, and
  // the saved file is a supplement rather than a replacement.
  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await persistBinaryContent(rawBuffer, contentType, persistId)
    if (!('error' in result)) {
      persistedPath = result.filepath
      persistedSize = result.size
    }
  }

  const bytes = rawBuffer.length
  const rawHtml = rawBuffer.toString('utf-8')

  let markdownContent: string
  let contentBytes: number
  if (contentType.includes('text/html')) {
    // Truncate BEFORE turndown to prevent DOM-tree OOM on超大 HTML pages
    const htmlToConvert =
      rawHtml.length > MAX_HTML_BEFORE_TURNDOWN
        ? rawHtml.slice(0, MAX_HTML_BEFORE_TURNDOWN)
        : rawHtml
    markdownContent = (await getTurndownService()).turndown(htmlToConvert)
    contentBytes = Buffer.byteLength(markdownContent)
  } else {
    // It's not HTML - just use it raw. The decoded string's UTF-8 byte
    // length equals rawBuffer.length (modulo U+FFFD replacement on invalid
    // bytes — negligible for cache eviction accounting), so skip the O(n)
    // Buffer.byteLength scan.
    markdownContent = htmlContent
    contentBytes = bytes
  }

  // Store the fetched content in cache. Note that it's stored under
  // the original URL, not the upgraded or redirected URL.
  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    persistedPath,
    persistedSize,
  }
  // lru-cache requires positive integers; clamp to 1 for empty responses.
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) })
  return entry
}

export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  isPreapprovedDomain: boolean,
): Promise<string> {
  // Truncate content to avoid "Prompt is too long" errors from the secondary model
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) +
        '\n\n[Content truncated due to length...]'
      : markdownContent

  const modelPrompt = makeSecondaryModelPrompt(
    truncatedContent,
    prompt,
    isPreapprovedDomain,
  )
  const assistantMessage = await queryHaiku({
    systemPrompt: asSystemPrompt([]),
    userPrompt: modelPrompt,
    signal,
    options: {
      querySource: 'web_fetch_apply',
      agents: [],
      isNonInteractiveSession,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  // We need to bubble this up, so that the tool call throws, causing us to return
  // an is_error tool_use block to the server, and render a red dot in the UI.
  if (signal.aborted) {
    throw new AbortError()
  }

  const { content } = assistantMessage.message
  if (content.length > 0) {
    const contentBlock = content[0]
    if ('text' in contentBlock!) {
      return contentBlock.text
    }
  }
  return 'No response from model'
}
