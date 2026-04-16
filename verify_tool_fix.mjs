#!/usr/bin/env bun

/**
 * 验证工具识别修复
 * 
 * 此脚本验证：
 * 1. PowerShellTool 在 macOS 上被禁用
 * 2. GrepTool 正确启用并配置
 * 3. 平台检测正常工作
 */

import { getPlatform } from './src/utils/platform.js'
import { getAllBaseTools } from './src/tools.js'

console.log('=== 工具识别验证 ===\n')

// 1. 验证平台检测
const platform = getPlatform()
console.log(`📱 当前平台: ${platform}`)
console.log(`   预期: macos`)
console.log(`   状态: ${platform === 'macos' ? '✅ 正确' : '❌ 错误'}\n`)

// 2. 获取所有工具
const tools = getAllBaseTools()
console.log(`🔧 可用工具总数: ${tools.length}\n`)

// 3. 验证 PowerShellTool
const powerShellTool = tools.find(t => t.name === 'PowerShell')
if (powerShellTool) {
  const isEnabled = powerShellTool.isEnabled()
  console.log(`⚡ PowerShellTool:`)
  console.log(`   启用状态: ${isEnabled}`)
  console.log(`   预期: ${platform === 'windows' ? 'true' : 'false'}`)
  console.log(`   状态: ${isEnabled === (platform === 'windows') ? '✅ 正确' : '❌ 错误'}\n`)
} else {
  console.log(`❌ PowerShellTool 未找到\n`)
}

// 4. 验证 GrepTool
const grepTool = tools.find(t => t.name === 'Grep')
if (grepTool) {
  const isEnabled = grepTool.isEnabled()
  const isSearch = grepTool.isSearchOrReadCommand({})
  console.log(`🔍 GrepTool:`)
  console.log(`   启用状态: ${isEnabled}`)
  console.log(`   isSearchOrReadCommand: ${JSON.stringify(isSearch)}`)
  console.log(`   预期启用: true`)
  console.log(`   状态: ${isEnabled ? '✅ 正确' : '❌ 错误'}\n`)
} else {
  console.log(`❌ GrepTool 未找到\n`)
}

// 5. 验证 BashTool
const bashTool = tools.find(t => t.name === 'Bash')
if (bashTool) {
  const isEnabled = bashTool.isEnabled()
  console.log(`💻 BashTool:`)
  console.log(`   启用状态: ${isEnabled}`)
  console.log(`   预期: true (在 macOS/Linux 上)`);
  console.log(`   状态: ${isEnabled ? '✅ 正确' : '❌ 错误'}\n`)
} else {
  console.log(`❌ BashTool 未找到\n`)
}

// 6. 验证 ripgrep 状态
try {
  const { getRipgrepStatus } = await import('./src/utils/ripgrep.js')
  const rgStatus = getRipgrepStatus()
  console.log(`📦 Ripgrep 状态:`)
  console.log(`   模式: ${rgStatus.mode}`)
  console.log(`   路径: ${rgStatus.path}`)
  console.log(`   工作状态: ${rgStatus.working}`)
  console.log(`   状态: ${rgStatus.working !== false ? '✅ 可用' : '⚠️  可能有问题'}\n`)
} catch (error) {
  console.log(`❌ 无法加载 ripgrep 模块: ${error.message}\n`)
}

// 7. 总结
console.log('=== 验证总结 ===')
const allChecks = [
  platform === 'macos',
  powerShellTool?.isEnabled() === false,
  grepTool?.isEnabled() === true,
  grepTool?.isSearchOrReadCommand({}).isSearch === true,
]

const passed = allChecks.filter(Boolean).length
const total = allChecks.length

console.log(`通过: ${passed}/${total}`)

if (passed === total) {
  console.log('\n✅ 所有检查通过！工具识别修复成功。')
  process.exit(0)
} else {
  console.log('\n❌ 部分检查失败，请检查修复是否正确应用。')
  process.exit(1)
}
