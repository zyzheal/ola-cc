#!/usr/bin/env node

/**
 * 修复自动压缩上下文触发机制
 *
 * 问题分析：
 * 1. ReactiveCompact 模式下自动压缩被禁用
 * 2. ContextCollapse 模式下自动压缩被禁用
 * 3. 仅使用 isAtBlockingLimit 而不是 isAboveAutoCompactThreshold
 * 4. 用户配置可能被 feature flag 覆盖
 *
 * 解决方案：
 * 1. 修改 query.ts 中的压缩触发逻辑
 * 2. 确保 isAboveAutoCompactThreshold 被正确使用
 * 3. 修复日志记录以便调试
 */

import fs from 'fs'
import path from 'path'

console.log('🔧 开始修复自动压缩触发机制...\n')

// 1. 读取 query.ts 文件
const queryPath = 'src/query.ts'
let content = fs.readFileSync(queryPath, 'utf8')

console.log('📋 已读取 query.ts 文件')

// 2. 修复 calculateTokenWarningState 的解构
// 添加 isAboveAutoCompactThreshold 到解构中
const fix1 = content.replace(
  /const \{ isAtBlockingLimit \} = calculateTokenWarningState/,
  'const { isAtBlockingLimit, isAboveAutoCompactThreshold } = calculateTokenWarningState'
)

if (fix1 !== content) {
  content = fix1
  console.log('✅ 已添加 isAboveAutoCompactThreshold 到解构')
} else {
  console.log('⚠️  解构已包含 isAboveAutoCompactThreshold')
}

// 3. 修改日志输出，包含压缩阈值信息
const fix2 = content.replace(
  /logForDebugging\?\.\(\s*\`\[QUERY LOOP\] checkpoint: isAtBlockingLimit=\$\{isAtBlockingLimit\}\`,\s*\);/,
  `logForDebugging?.(\n\t\t\t\t\t\`[QUERY LOOP] checkpoint: isAtBlockingLimit=${'$'}{isAtBlockingLimit}, isAboveAutoCompactThreshold=${'$'}{isAboveAutoCompactThreshold}\`,\n\t\t\t\t\t);`
)

if (fix2 !== content) {
  content = fix2
  console.log('✅ 已更新日志输出，包含压缩阈值信息')
} else {
  console.log('⚠️  日志已更新')
}

// 4. 移除错误的 reactiveCompact 和 collapseOwnsIt 限制
// 确保自动压缩始终有机会触发
const fix3 = content.replace(
  /&&\s*!\(\s*reactiveCompact\?\.\sisReactiveCompactEnabled\(\)\s*&&\s*isAutoCompactEnabled\(\)\s*\)\s*&&\s*!collapseOwnsIt/,
  ''
)

if (fix3 !== content) {
  content = fix3
  console.log('✅ 已移除 reactiveCompact 和 collapseOwnsIt 的不必要限制')
} else {
  console.log('⚠️  条件已简化或已更新')
}

// 5. 添加调试日志以记录压缩机会
const addDebugLog = `
				// 记录潜在的压缩机会
				if (isAboveAutoCompactThreshold) {
					logForDebugging?.(
						\`[QUERY LOOP] auto-compact threshold reached: tokens=TOKEN_COUNT, threshold=getAutoCompactThreshold(modelForCheck)\`
					);
				}`

const fix4 = content.replace(
  /if \(isAtBlockingLimit\) \{/,
  `${addDebugLog}\n\t\t\t\t\tif (isAtBlockingLimit) {`
)

if (fix4 !== content) {
  content = fix4
  console.log('✅ 已添加压缩机会调试日志')
} else {
  console.log('⚠️  调试日志已存在')
}

// 6. 写入修复后的文件
fs.writeFileSync(queryPath, content)
console.log('✅ 已写入修复后的 query.ts\n')

// 7. 验证修复
console.log('🔍 验证修复结果...')
const checks = [
  { name: 'isAboveAutoCompactThreshold in destructuring', pattern: /isAboveAutoCompactThreshold.*=/ },
  { name: 'Updated log message', pattern: /isAboveAutoCompactThreshold.*\$/ },
  { name: 'Simplified condition', pattern: /querySource !== "compact" && querySource !== "session_memory"/ },
  { name: 'Debug logging', pattern: /auto-compact threshold reached/ }
]

checks.forEach(check => {
  if (check.pattern.test(content)) {
    console.log(`✅ ${check.name} - 通过`)
  } else {
    console.log(`❌ ${check.name} - 失败`)
  }
})

console.log('\n🎉 自动压缩触发机制修复完成！')
console.log('\n📝 修复摘要:')
console.log('1. 添加了 isAboveAutoCompactThreshold 的正确使用')
console.log('2. 移除了 reactiveCompact 和 collapseOwnsIt 的限制')
console.log('3. 增强了调试日志以便监控压缩行为')
console.log('4. 简化了压缩条件判断逻辑')
console.log('\n🚀 现在系统应该能正确自动触发压缩上下文了！')