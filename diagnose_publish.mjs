#!/usr/bin/env node
/**
 * 测试发布版本的回车键处理
 * 
 * 这个脚本直接测试 dist/publish/cli.js 中的关键代码路径
 */

import { readFileSync } from 'fs'
import { join } from 'path'

console.error('=== 发布版本回车键诊断 ===\n')

const cliPath = join(process.cwd(), 'dist/publish/cli.js')

try {
  const content = readFileSync(cliPath, 'utf8')
  
  console.error('1. 检查构建输出:')
  console.error(`   文件大小: ${(content.length / 1024 / 1024).toFixed(2)} MB`)
  console.error(`   行数: ${content.split('\n').length}`)
  
  // 2. 搜索关键模式
  console.error('\n2. 搜索关键代码模式:')
  
  // 搜索 \r 比较
  const crPatterns = [
    [/\\r/g, '\\\\r (转义的 \\r)'],
    [/===.*\\r/g, '=== \\r 比较'],
    [/name.*=.*return/g, 'name = return 赋值'],
    [/return.*name/g, 'return name (可能的相关代码)'],
  ]
  
  for (const [pattern, desc] of crPatterns) {
    const matches = content.match(pattern)
    console.error(`   ${desc}: ${matches ? matches.length : 0} 次出现`)
    if (matches && matches.length > 0 && matches.length <= 5) {
      console.error(`     示例: ${matches.slice(0, 2).join(', ')}`)
    }
  }
  
  // 3. 搜索 toString
  console.error('\n3. 搜索 toString 使用:')
  const toStringPatterns = [
    [/\.toString\(/g, '.toString( 调用'],
    [/\.toString\(['"]utf8['"]\)/g, '.toString(\'utf8\') 调用'],
    [/String\(/g, 'String( 调用'],
  ]
  
  for (const [pattern, desc] of toStringPatterns) {
    const matches = content.match(pattern)
    console.error(`   ${desc}: ${matches ? matches.length : 0} 次出现`)
  }
  
  // 4. 搜索 setRawMode
  console.error('\n4. 搜索 setRawMode:')
  const rawModePatterns = [
    [/setRawMode/g, 'setRawMode 引用'],
    [/isRaw/g, 'isRaw 引用'],
    [/setEncoding/g, 'setEncoding 引用'],
  ]
  
  for (const [pattern, desc] of rawModePatterns) {
    const matches = content.match(pattern)
    console.error(`   ${desc}: ${matches ? matches.length : 0} 次出现`)
  }
  
  // 5. 尝试提取关键代码段
  console.error('\n5. 尝试定位 parseKeypress 类似代码:')
  
  // 搜索包含 '\r' 和 'return' 的代码段
  const lines = content.split('\n')
  let foundRelevant = false
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 查找同时包含 \r 和 return 的行
    if (line.includes('\\r') && line.includes('return')) {
      console.error(`   行 ${i + 1}: ${line.substring(0, 120)}...`)
      foundRelevant = true
      break // 只显示第一个
    }
  }
  
  if (!foundRelevant) {
    console.error('   ⚠️  未找到明显的 \\r + return 代码 (可能被 minify 优化)')
  }
  
  console.error('\n=== 诊断完成 ===')
  console.error('\n建议:')
  console.error('1. 运行发布版本并手动测试: node dist/publish/cli.js')
  console.error('2. 如果回车键仍然无效，运行深度诊断: node deep_diagnose_enter.mjs')
  console.error('3. 检查终端是否正确发送 \\r (某些终端可能发送 \\n)')
  
} catch (error) {
  console.error(`❌ 读取文件失败: ${error.message}`)
  process.exit(1)
}
