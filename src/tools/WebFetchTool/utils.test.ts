import { describe, expect, it, beforeEach, mock } from 'bun:test'

// Set required env var before any imports
process.env.CLAUDE_WEB_DOMAIN_INFO_URL = 'https://test.example.com/domain-info'

// Mock axios before importing utils
const mockGet = mock(() => Promise.resolve({ status: 200, data: { can_fetch: true } }))
mock.module('axios', () => ({
  default: {
    get: mockGet,
    isAxiosError: (e: any) => e?.isAxiosError === true,
  },
  get: mockGet,
  isAxiosError: (e: any) => e?.isAxiosError === true,
}))

// Now import the modules under test (after mocks are set up)
const { checkDomainBlocklist, validateURL, clearWebFetchCache } = await import('./utils.js')
const { DOMAIN_CHECK_CACHE, URL_CACHE } = await import('./utils.js')
const { ERROR_MESSAGES } = await import('./constants.js')

describe('WebFetch Utils', () => {
  beforeEach(() => {
    URL_CACHE.clear()
    DOMAIN_CHECK_CACHE.clear()
    mockGet.mockClear()
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
      expect(validateURL('https://')).toBe(false)
      expect(validateURL('https://example.com:invalid-port')).toBe(false)
    })

    it('should reject URLs with authentication', () => {
      expect(validateURL('https://user:pass@example.com')).toBe(false)
    })

    it('should reject URLs that are too long', () => {
      // LIMITS.MAX_URL_LENGTH is 2000
      const longUrl = 'https://example.com/' + 'a'.repeat(2000)
      expect(validateURL(longUrl)).toBe(false)
    })
  })

  describe('checkDomainBlocklist', () => {
    const mockDomain = 'example.com'

    it('should allow cached domains', async () => {
      DOMAIN_CHECK_CACHE.set(mockDomain, true)
      const result = await checkDomainBlocklist(mockDomain)
      expect(result.status).toBe('allowed')
      expect(mockGet).not.toHaveBeenCalled()
    })

    it('should allow domains from API', async () => {
      mockGet.mockImplementationOnce(() => Promise.resolve({
        status: 200,
        data: { can_fetch: true },
      }))

      const result = await checkDomainBlocklist(mockDomain)
      expect(result.status).toBe('allowed')
      expect(DOMAIN_CHECK_CACHE.has(mockDomain)).toBe(true)
    })

    it('should block domains from API', async () => {
      mockGet.mockImplementationOnce(() => Promise.resolve({
        status: 200,
        data: { can_fetch: false },
      }))

      const result = await checkDomainBlocklist(mockDomain)
      expect(result.status).toBe('blocked')
      expect(DOMAIN_CHECK_CACHE.has(mockDomain)).toBe(false)
    })

    it('should require confirmation on failure', async () => {
      mockGet.mockImplementation(() => Promise.reject(new Error('Network error')))

      const result = await checkDomainBlocklist(mockDomain, true)
      expect(result.status).toBe('requires_confirmation')
      expect('message' in result).toBe(true)
    })

    it('should handle invalid domain format', async () => {
      const invalidDomain = 'invalid..domain'
      const result = await checkDomainBlocklist(invalidDomain, true)
      expect(result.status).toBe('requires_confirmation')
    })

    it('should return check_failed for invalid domains without confirmation', async () => {
      const invalidDomains = [
        'a..b', // consecutive dots
        'a.', // trailing dot
        '.a', // leading dot
        'a_b', // underscore
        '-example', // starts with hyphen
        'example-', // ends with hyphen
      ]

      for (const domain of invalidDomains) {
        const result = await checkDomainBlocklist(domain, false)
        expect(result.status).toBe('check_failed')
      }
    })

    it('should throw for empty or missing domain', async () => {
      await expect(checkDomainBlocklist('', false)).rejects.toThrow()
    })

    it('should retry on network errors', async () => {
      mockGet.mockImplementation(() => Promise.reject(new Error('Network error')))

      const startTime = Date.now()
      const result = await checkDomainBlocklist(mockDomain, false)
      const endTime = Date.now()

      expect(result.status).toBe('check_failed')
      expect(mockGet).toHaveBeenCalledTimes(2) // 1 initial + 1 retry
      expect(endTime - startTime).toBeGreaterThanOrEqual(1000) // Should have waited for retry
    })

    it('should not retry on HTTP errors', async () => {
      mockGet.mockImplementationOnce(() => Promise.resolve({
        status: 404,
        data: {},
      }))

      const result = await checkDomainBlocklist(mockDomain, false)
      expect(result.status).toBe('check_failed')
      expect(mockGet).toHaveBeenCalledTimes(1)
    })
  })

  describe('clearWebFetchCache', () => {
    it('should clear both caches', () => {
      DOMAIN_CHECK_CACHE.set('example.com', true)
      expect(DOMAIN_CHECK_CACHE.size).toBe(1)

      clearWebFetchCache()
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
    expect(validateURL('https://arxiv.org/abs/1234.5678')).toBe(true)

    mockGet.mockImplementationOnce(() => Promise.resolve({
      status: 200,
      data: { can_fetch: true },
    }))

    const result = await checkDomainBlocklist('arxiv.org')
    expect(result.status).toBe('allowed')
  })
})
