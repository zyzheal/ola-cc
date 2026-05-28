// src/commands/gd/gd.ts

import type { LocalCommandModule } from '../../commands.js'
import { grokManager } from '../../tools/GrokTool/GrokManager.js'

export const call: LocalCommandModule['call'] = async (args, context) => {
  try {
    const { url, port } = await grokManager.startDashboard()
    return {
      type: 'text',
      value: `✓ Dashboard 已启动: ${url}\n（浏览器自动打开）`,
    }
  } catch (error) {
    return {
      type: 'text',
      value: `✗ Dashboard 启动失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
