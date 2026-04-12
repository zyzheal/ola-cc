import type { Command } from '../../commands.js'

const showAllTools = {
  type: 'local',
  name: 'show-all-tools',
  description: 'Show all available tools and commands (all feature flags removed)',
  aliases: ['tools', 'list-tools', 'show-tools'],
  source: 'builtin',
  async run(_args, _context, onDone) {
    const output: string[] = []

    output.push('='.repeat(80))
    output.push('所有可用工具和命令列表 (所有功能开关已移除)')
    output.push('='.repeat(80))
    output.push('')

    // 导入并列出所有工具
    const { getAllBaseTools } = await import('../../tools.js')
    const allTools = getAllBaseTools()

    output.push('-'.repeat(80))
    output.push(`核心工具 (Core Tools) - 共 ${allTools.length} 个`)
    output.push('-'.repeat(80))
    for (const tool of allTools) {
      const status = tool.isEnabled() ? '[启用]' : '[禁用]'
      const mcpInfo = tool.mcpInfo ? ` (MCP: ${tool.mcpInfo.serverName}/${tool.mcpInfo.toolName})` : ''
      output.push(`  ${status} ${tool.name}${mcpInfo}`)
    }
    output.push('')

    // 导入并列出所有命令
    const { getCommands, INTERNAL_ONLY_COMMANDS } = await import('../../commands.js')
    const { REMOTE_SAFE_COMMANDS, BRIDGE_SAFE_COMMANDS } = await import('../../commands.js')

    output.push('-'.repeat(80))
    output.push('内置命令 (Built-in Commands)')
    output.push('-'.repeat(80))

    const allCommands = await getCommands(process.cwd())

    // 按来源分组命令
    const builtinCommands = allCommands.filter(c => c.source === 'builtin')
    const bundledCommands = allCommands.filter(c => c.source === 'bundled')
    const pluginCommands = allCommands.filter(c => c.source === 'plugin')
    const skillCommands = allCommands.filter(c => c.source === 'skills')

    output.push('')
    output.push(`## 内置命令 - 共 ${builtinCommands.length} 个`)
    for (const cmd of builtinCommands) {
      const aliases = cmd.aliases?.length ? ` (别名：${cmd.aliases.join(', ')})` : ''
      output.push(`  /${cmd.name}${aliases} - ${cmd.description}`)
    }

    output.push('')
    output.push(`## 捆绑命令 - 共 ${bundledCommands.length} 个`)
    for (const cmd of bundledCommands) {
      const aliases = cmd.aliases?.length ? ` (别名：${cmd.aliases.join(', ')})` : ''
      output.push(`  /${cmd.name}${aliases} - ${cmd.description}`)
    }

    output.push('')
    output.push(`## 插件命令 - 共 ${pluginCommands.length} 个`)
    for (const cmd of pluginCommands) {
      const pluginName = cmd.pluginInfo?.pluginManifest.name || 'unknown'
      output.push(`  /${cmd.name} [${pluginName}] - ${cmd.description}`)
    }

    output.push('')
    output.push(`## 技能命令 - 共 ${skillCommands.length} 个`)
    for (const cmd of skillCommands) {
      output.push(`  /${cmd.name} - ${cmd.description}`)
    }

    output.push('')
    output.push('-'.repeat(80))
    output.push(`内部专用命令 (INTERNAL_ONLY) - 共 ${INTERNAL_ONLY_COMMANDS.length} 个`)
    output.push('-'.repeat(80))
    for (const cmd of INTERNAL_ONLY_COMMANDS) {
      output.push(`  /${cmd.name} - ${cmd.description}`)
    }

    output.push('')
    output.push('-'.repeat(80))
    output.push(`远程模式安全命令 (REMOTE_SAFE) - 共 ${REMOTE_SAFE_COMMANDS.size} 个`)
    output.push('-'.repeat(80))
    for (const cmd of REMOTE_SAFE_COMMANDS) {
      output.push(`  /${cmd.name}`)
    }

    output.push('')
    output.push('-'.repeat(80))
    output.push(`桥接安全命令 (BRIDGE_SAFE) - 共 ${BRIDGE_SAFE_COMMANDS.size} 个`)
    output.push('-'.repeat(80))
    for (const cmd of BRIDGE_SAFE_COMMANDS) {
      output.push(`  /${cmd.name}`)
    }

    output.push('')
    output.push('='.repeat(80))
    output.push(`总计：${allTools.length} 个工具，${allCommands.length} 个命令`)
    output.push('='.repeat(80))

    onDone({
      type: 'text',
      content: output.join('\n'),
    })
  },
} satisfies Command

export default showAllTools
