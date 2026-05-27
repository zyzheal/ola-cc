import { describe, expect, it, beforeEach, vi } from 'vitest'
import { LRUCache } from 'lru-cache'
import { checkDomainBlocklist, validateURL, clearWebFetchCache } from './utils.js'
import { DOMAIN_CHECK_CACHE, URL_CACHE } from './utils.js'
import { TIMEOUTS, ERROR_MESSAGES } from './constants.js'

// Mock axios
vi.mock('axios')
const mockedAxios = vi.mocked(await import('axios'))

// Mock environment variable
vi.mocked(() => vi.doMock('bun:bundle')).mockImplementation(() => ({
  feature: () => true,
}))

// Mock settings
vi.mock('../../utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({
    skipWebFetchPreflight: false,
  }),
}))

describe('WebFetch Utils', () => {
  beforeEach(() => {
    // Clear caches before each test
    URL_CACHE.clear()
    DOMAIN_CHECK_CACHE.clear()
    vi.clearAllMocks()
  })

  describe('validateURL', () => {
    it('should validate correct URLs', () => {
      expect(validateURL('https://example.com')).toBe(true)
      expect(validateURL('https://example.com/path')).toBe(true)
      expect(validateURL('https://sub.example.com')).toBe(true)
      expect(validateURL('http://example.com')).toBe(true)
    })

    it('should reject invalid URLs', () => {
      expect(validateURL('')).toBe(false)
      expect(validateURL('not-a-url')).toBe(false)
      expect(validateURL('ftp://example.com')).toBe(false)
      expect(validateURL('https://')).toBe(false)
      expect(validateURL('https://example.com:invalid-port')).toBe(false)
    })

    it('should reject URLs with authentication', () => {
      expect(validateURL('https://user:pass@example.com')).toBe(false)
    })

    it('should reject URLs that are too long', () => {
      const longUrl = 'https://a'.repeat(2001)
      expect(validateURL(longUrl)).toBe(false)
    })
  })

  describe('checkDomainBlocklist', () => {
    const mockDomain = 'example.com'

    it('should allow cached domains', async () => {
      DOMAIN_CHECK_CACHE.set(mockDomain, true)
      const result = await checkDomainBlocklist(mockDomain)
      expect(result.status).toBe('allowed')
      expect(mockedAxios.get).not.toHaveBeenCalled()
    })

    it('should allow domains from API', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { can_fetch: true },
      })

      const result = await checkDomainBlocklist(mockDomain)
      expect(result.status).toBe('allowed')
      expect(DOMAIN_CHECK_CACHE.has(mockDomain)).toBe(true)
    })

    it('should block domains from API', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { can_fetch: false },
      })

      const result = await checkDomainBlocklist(mockDomain)
      expect(result.status).toBe('blocked')
      expect(DOMAIN_CHECK_CACHE.has(mockDomain)).toBe(false)
    })

    it('should require confirmation on failure', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Network error'))

      const result = await checkDomainBlocklist(mockDomain, true)
      expect(result.status).toBe('requires_confirmation')
      expect('message' in result).toBe(true)
    })

    it('should handle invalid domain format', async () => {
      const invalidDomain = 'invalid..domain'
      const result = await checkDomainBlocklist(invalidDomain, true)
      expect(result.status).toBe('requires_confirmation')
    })

    it('should validate domain format strictly', async () => {
      const invalidDomains = [
        '', // empty
        'a', // too short
        'a..b', // consecutive dots
        'a.', // trailing dot
        '.a', // leading dot
        'a_b', // underscore
        'a b', // space
        '-example', // starts with hyphen
        'example-', // ends with hyphen
      ]

      for (const domain of invalidDomains) {
        await expect(checkDomainBlocklist(domain, false)).rejects.toThrow()
      }
    })

    it('should retry on network errors', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Network error'))

      const startTime = Date.now()
      const result = await checkDomainBlocklist(mockDomain, false)
      const endTime = Date.now()

      expect(result.status).toBe('check_failed')
      expect(mockedAxios.get).toHaveBeenCalledTimes(2) // 1 initial + 1 retry
      expect(endTime - startTime).toBeGreaterThan(1000) // Should have waited for retry
    })

    it('should not retry on HTTP errors', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 404,
        data: {},
      })

      const result = await checkDomainBlocklist(mockDomain, false)
      expect(result.status).toBe('check_failed')
      expect(mockedAxios.get).toHaveBeenCalledTimes(1)
    })
  })

  describe('clearWebFetchCache', () => {
    it('should clear both caches', () => {
      URL_CACHE.set('test', {
        bytes: 100,
        code: 200,
        codeText: 'OK',
        content: 'test',
        contentType: 'text/plain',
      })
      DOMAIN_CHECK_CACHE.set('example.com', true)

      expect(URL_CACHE.size).toBe(1)
      expect(DOMAIN_CHECK_CACHE.size).toBe(1)

      clearWebFetchCache()

      expect(URL_CACHE.size).toBe(0)
      expect(DOMAIN_CHECK_CACHE.size).toBe(0)
    })
  })

  describe('Error Messages', () => {
    it('should generate proper error messages', () => {
      expect(ERROR_MESSAGES.INVALID_URL('test')).toContain('无效的URL: test')
      expect(ERROR_MESSAGES.DOMAIN_CHECK_UNAVAILABLE('example.com')).toContain('无法验证域名')
    })
  })
})

describe('WebFetch Utils Integration', () => {
  it('should handle the complete flow', async () => {
    // Test URL validation
    expect(validateURL('https://arxiv.org/abs/1234.5678')).toBe(true)

    // Test domain check flow
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: { can_fetch: true },
    })

    const result = await checkDomainBlocklist('arxiv.org')
    expect(result.status).toBe('allowed')
  })
})