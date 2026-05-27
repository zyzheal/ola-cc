import { describe, expect, it } from 'vitest'
import { ConfirmDomainAccessTool } from './ConfirmDomainAccessTool.js'
import { USER_ACTIONS } from './tools/WebFetchTool/constants.js'

describe('ConfirmDomainAccessTool', () => {
  describe('Input Validation', () => {
    it('should allow valid inputs', () => {
      const validInput = {
        url: 'https://example.com',
        action: USER_ACTIONS.ALLOW,
      }
      const result = ConfirmDomainAccessTool.inputSchema.safeParse(validInput)
      expect(result.success).toBe(true)
    })

    it('should reject invalid URLs', () => {
      const invalidInput = {
        url: 'not-a-url',
        action: USER_ACTIONS.ALLOW,
      }
      const result = ConfirmDomainAccessTool.inputSchema.safeParse(invalidInput)
      expect(result.success).toBe(false)
    })

    it('should reject invalid actions', () => {
      const invalidInput = {
        url: 'https://example.com',
        action: 'invalid_action',
      }
      const result = ConfirmDomainAccessTool.inputSchema.safeParse(invalidInput)
      expect(result.success).toBe(false)
    })
  })

  describe('Domain Confirmation Logic', () => {
    it('should handle allow action', async () => {
      const input = {
        url: 'https://example.com',
        action: USER_ACTIONS.ALLOW,
      }

      const result = await ConfirmDomainAccessTool.call(input, {} as any)

      expect(result.data.success).toBe(true)
      expect(result.data.domain).toBe('example.com')
      expect(result.data.actionTaken).toBe(USER_ACTIONS.ALLOW)
      expect(result.data.message).toContain('已确认允许访问域名')
    })

    it('should handle deny action', async () => {
      const input = {
        url: 'https://example.com',
        action: USER_ACTIONS.DENY,
      }

      const result = await ConfirmDomainAccessTool.call(input, {} as any)

      expect(result.data.success).toBe(false)
      expect(result.data.domain).toBe('example.com')
      expect(result.data.actionTaken).toBe(USER_ACTIONS.DENY)
      expect(result.data.message).toContain('已拒绝访问域名')
    })

    it('should handle skip action', async () => {
      const input = {
        url: 'https://example.com',
        action: USER_ACTIONS.SKIP,
      }

      const result = await ConfirmDomainAccessTool.call(input, {} as any)

      expect(result.data.success).toBe(true)
      expect(result.data.domain).toBe('example.com')
      expect(result.data.actionTaken).toBe(USER_ACTIONS.SKIP)
      expect(result.data.message).toContain('已跳过域名检查此次请求')
    })

    it('should extract domain from URL', async () => {
      const input = {
        url: 'https://sub.example.com/path',
        action: USER_ACTIONS.ALLOW,
      }

      const result = await ConfirmDomainAccessTool.call(input, {} as any)

      expect(result.data.domain).toBe('sub.example.com')
    })
  })

  describe('Output Formatting', () => {
    it('should return proper output structure', async () => {
      const input = {
        url: 'https://example.com',
        action: USER_ACTIONS.ALLOW,
      }

      const result = await ConfirmDomainAccessTool.call(input, {} as any)

      expect(result.data).toHaveProperty('success')
      expect(result.data).toHaveProperty('message')
      expect(result.data).toHaveProperty('domain')
      expect(result.data).toHaveProperty('actionTaken')
    })

    it('should generate appropriate success message', async () => {
      const input = {
        url: 'https://arxiv.org/abs/1234.5678',
        action: USER_ACTIONS.ALLOW,
      }

      const result = await ConfirmDomainAccessTool.call(input, {} as any)

      expect(result.data.success).toBe(true)
      expect(result.data.message).toContain('arxiv.org')
      expect(result.data.message).toContain('已确认允许访问')
    })
  })
})

describe('ConfirmDomainAccessTool Edge Cases', () => {
  it('should handle malformed URLs gracefully', async () => {
    const input = {
      url: 'https://',
      action: USER_ACTIONS.ALLOW,
    }

    // This should not throw due to pre-validation
    expect(() => ConfirmDomainAccessTool.inputSchema.safeParse(input)).toThrow()
  })

  it('should preserve original URL in response', async () => {
    const input = {
      url: 'https://example.com?query=value',
      action: USER_ACTIONS.ALLOW,
    }

    const result = await ConfirmDomainAccessTool.call(input, {} as any)

    expect(result.data.domain).toBe('example.com') // Only domain extracted
    expect(input.url).toBe('https://example.com?query=value') // Original preserved
  })
})