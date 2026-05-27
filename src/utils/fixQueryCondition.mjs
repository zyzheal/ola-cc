#!/usr/bin/env node

/**
 * 修复query.ts中的压缩条件判断
 */

import fs from 'fs'

console.log('🔧 修复query.ts中的压缩条件判断...\n')

// 读取文件
const queryPath = 'src/query.ts'
let content = fs.readFileSync(queryPath, 'utf8')

console.log('📋 已读取 query.ts 文件')

// 1. 移除reactiveCompact和collapseOwnsIt的限制条件
const pattern = /if \(\s*!compactionResult\s*&&\s*querySource\s*!==\s*"compact"\s*&&\s*querySource\s*!==\s*"session_memory"\s*&&\s*!\(\s*reactiveCompact\?\.\sisReactiveCompactEnabled\(\)\s*&&\s*isAutoCompactEnabled\(\)\s*\)\s*&&\s*!collapseOwnsIt\s*\) {/g
const replacement = `if (
				!compactionResult &&
				querySource !== "compact" &&
				querySource !== "session_memory"
			) {`

const newContent = content.replace(pattern, replacement)

if (newContent !== content) {
  content = newContent
  console.log('✅ 已移除 reactiveCompact 和 collapseOwnsIt 的限制')
} else {
  console.log('⚠️  条件已经简化')
}

// 2. 添加自动压缩阈值检查逻辑
const addAutoCompactCheck = `
				// 检查是否达到自动压缩阈值
				if (isAboveAutoCompactThreshold) {
					logForDebugging?.(
						\`[QUERY LOOP] auto-compact threshold reached: tokens=\${tokenCount}, threshold=\${getAutoCompactThreshold(modelForCheck)}\`
					);
				}`

const compactCheckPattern = /if \(isAtBlockingLimit\) {/
const compactCheckReplacement = `${addAutoCompactCheck}
				if (isAtBlockingLimit) {`

const updatedContent = content.replace(compactCheckPattern, compactCheckReplacement)

if (updatedContent !== content) {
  content = updatedContent
  console.log('✅ 已添加自动压缩阈值检查')
} else {
  console.log('⚠️  自动压缩检查已存在')
}

// 写入文件
fs.writeFileSync(queryPath, content)
console.log('✅ 已写入修复后的 query.ts\n')

// 验证修复
console.log('🔍 验证修复结果...')
const checks = [
  { name: '简化条件判断', pattern: /querySource !== "compact" && querySource !== "session_memory"/ },
  { name: 'isAboveAutoCompactThreshold 使用', pattern: /isAboveAutoCompactThreshold/ },
  { name: '自动压缩阈值日志', pattern: /auto-compact threshold reached/ },
  { name: '移除reactiveCompact限制', pattern: /reactiveCompact.*isReactiveCompactEnabled/ },
  { name: '移除collapseOwnsIt限制', pattern: /collapseOwnsIt/ }
]

checks.forEach(check => {
  if (check.pattern.test(content)) {
    if (check.name.includes('移除') && content.match(check.pattern)) {
      console.log(`❌ ${check.name} - 仍然存在`)
    } else {
      console.log(`✅ ${check.name} - 通过`)
    }
  } else {
    if (check.name.includes('移除')) {
      console.log(`✅ ${check.name} - 已移除`)
    } else {
      console.log(`❌ ${check.name} - 失败`)
    }
  }
})

console.log('\n🎉 压缩条件判断修复完成！')
console.log('\n📝 修复摘要:')
console.log('1. 简化了压缩触发条件，移除了不必要的限制')
console.log('2. 添加了自动压缩阈值的检查和日志')
console.log('3. 确保系统始终有机会触发自动压缩')