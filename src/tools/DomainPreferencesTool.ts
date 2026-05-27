import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../Tool.js'
import { domainPreferenceManager } from './WebFetchTool/DomainPreferenceManager.js'
import { webFetchConfigManager } from './WebFetchTool/WebFetchConfig.js'
import { ERROR_MESSAGES } from './WebFetchTool/constants.js'
import type { PermissionDecision } from '../../types/permissions.js'

const inputSchema = z.strictObject({
  action: z.enum(['show_stats', 'show_help', 'clear_preferences', 'export_config', 'import_config']).describe('Action to perform'),
  config: z.string().optional().describe('Configuration string for import_config action'),
})

type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = z.object({
  success: z.boolean().describe('Whether the action was successful'),
  message: z.string().describe('Result message or data'),
  data: z.any().optional().describe('Additional data if applicable'),
})

type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<typeof outputSchema>

export const DomainPreferencesTool = buildTool({
  name: 'domain_preferences',
  searchHint: 'manage domain preferences and web fetch settings',
  maxResultSizeChars: 5000,
  shouldDefer: false,
  description() {
    return '管理域名偏好设置和WebFetch配置'
  },
  userFacingName() {
    return 'Domain Preferences'
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
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'other', reason: 'Domain preferences management tool' },
    }
  },
  async prompt() {
    return `此工具用于管理域名偏好设置和WebFetch配置。您可以查看统计信息、获取帮助、清除偏好或管理配置。`
  },
  validateInput(input) {
    return { result: true }
  },
  async call(
    { action, config },
    _context,
  ) {
    let message = ''
    let success = true
    let data: any = null

    switch (action) {
      case 'show_stats':
        const stats = domainPreferenceManager.getStatistics()
        message = ERROR_MESSAGES.STATISTICS(stats)
        data = stats
        break

      case 'show_help':
        message = ERROR_MESSAGES.HELP_CONFIRMATION()
        break

      case 'clear_preferences':
        domainPreferenceManager.clearAllPreferences()
        message = ERROR_MESSAGES.PREFERENCE_CLEARED()
        break

      case 'export_config':
        const configStr = webFetchConfigManager.exportConfig()
        data = configStr
        message = '配置已导出'
        break

      case 'import_config':
        if (!config) {
          success = false
          message = '导入配置需要提供配置字符串'
        } else {
          const result = webFetchConfigManager.importConfig(config)
          if (result.success) {
            message = '配置导入成功'
          } else {
            success = false
            message = ERROR_MESSAGES.CONFIG_INVALID(result.errors)
          }
        }
        break

      default:
        success = false
        message = '未知操作'
    }

    const output: Output = {
      success,
      message,
      data,
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