import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../Tool.js'
import { formatFileSize } from '../../utils/format.js'
import type { PermissionDecision } from '../../types/permissions.js'
import type { ToolUseContext } from '../Tool.js'
import { ERROR_MESSAGES, USER_ACTIONS } from './WebFetchTool/constants.js'
import { domainPreferenceManager } from './WebFetchTool/DomainPreferenceManager.js'

const inputSchema = z.strictObject({
  url: z.string().url().describe('The URL that needs domain confirmation'),
  action: z.enum(['allow', 'deny', 'skip']).describe('Action to take: allow access, deny access, or skip domain check for this request only'),
})

type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = z.object({
  success: z.boolean().describe('Whether the action was successful'),
  message: z.string().describe('Result message explaining what happened'),
  domain: z.string().describe('The domain that was confirmed'),
  actionTaken: z.string().describe('The action that was taken'),
})

type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<typeof outputSchema>

export const ConfirmDomainAccessTool = buildTool({
  name: 'confirm_domain_access',
  searchHint: 'confirm domain access for web fetch',
  maxResultSizeChars: 1000,
  shouldDefer: false,
  description() {
    return '确认域名访问权限'
  },
  userFacingName() {
    return 'Confirm Domain Access'
  },
  get inputSchema() {
    return inputSchema
  },
  get outputSchema() {
    return outputSchema
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    // This tool should always be allowed as it's part of the domain confirmation workflow
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'other', reason: 'Domain confirmation tool' },
    }
  },
  async prompt() {
    return `此工具用于确认域名访问权限。当WebFetch工具无法验证域名安全性时，可以使用此工具手动确认访问权限。`
  },
  validateInput(input) {
    return { result: true }
  },
  async call(
    { url, action },
    _context,
  ) {
    const parsedUrl = new URL(url)
    const domain = parsedUrl.hostname

    // Get domain information for better user experience
    const category = domainPreferenceManager.getDomainCategory(domain)
    const previousPreference = domainPreferenceManager.getDomainPreference(domain)
    const suggestion = domainPreferenceManager.getSuggestion(domain)

    let message = ''
    let success = true

    switch (action) {
      case 'allow':
        message = `✅ 已确认允许访问域名: ${domain}\n`
        if (category !== 'unknown') {
          message += `   类型: ${category}\n`
        }
        if (previousPreference) {
          message += `   之前的选择: ${previousPreference.action}\n`
        }
        if (suggestion === 'allow') {
          message += `   智能建议: 允许 (基于历史记录)\n`
        }
        message += `\nWebFetch工具现在将尝试访问此域名。`
        break

      case 'deny':
        message = `❌ 已拒绝访问域名: ${domain}\n`
        if (category !== 'unknown') {
          message += `   类型: ${category}\n`
        }
        if (previousPreference) {
          message += `   之前的选择: ${previousPreference.action}\n`
        }
        message += `\nWebFetch工具将不会尝试访问此域名。`
        success = false
        break

      case 'skip':
        message = `⏭️ 已跳过域名检查此次请求: ${domain}\n`
        if (category !== 'unknown') {
          message += `   类型: ${category}\n`
        }
        message += `\nWebFetch工具将尝试访问此域名，但不会记住此决定。`
        break
    }

    // Record the decision in preference manager
    domainPreferenceManager.recordDecision(domain, action, url, domainPreferenceManager.getDomainCategory(url))

    const output: Output = {
      success,
      message,
      domain,
      actionTaken: action,
    }

    return {
      data: output,
    }
  },
  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
}) satisfies ToolDef<InputSchema, Output>