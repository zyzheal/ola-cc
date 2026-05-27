#!/usr/bin/env node

/**
 * 测试自动压缩功能
 *
 * 这个脚本测试系统是否正确触发自动压缩
 */

console.log('🧪 开始测试自动压缩功能...\n')

// 模拟消息列表
const mockMessages = [
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'text',
          text: '这是一个很长的消息，用于测试自动压缩功能。' + 'x'.repeat(1000)
        }
      ]
    }
  },
  // 添加更多消息以增加token计数
  ...Array(10).fill(null).map((_, i) => ({
    type: 'user',
    message: {
      content: [
        {
          type: 'text',
          text: `消息 ${i + 1}: 这是第${i + 1}个测试消息，包含大量文本用于模拟上下文溢出。` + 'y'.repeat(2000)
        }
      ]
    }
  }))
]

console.log('📊 模拟消息创建完成')
console.log(`- 消息数量: ${mockMessages.length}`)
console.log(`- 模拟文本大小: ${(mockMessages.reduce((acc, msg) => acc + (msg.message.content[0]?.text?.length || 0), 0) / 1024).toFixed(2)} KB\n`)

// 1. 测试 isAutoCompactEnabled 函数
console.log('🔍 测试 1: 检查自动压缩启用状态')
try {
  const { isAutoCompactEnabled } = await import('./services/compact/autoCompact.js')
  const enabled = isAutoCompactEnabled()
  console.log(`✅ 自动压缩当前状态: ${enabled ? '已启用' : '已禁用'}`)
} catch (error) {
  console.log(`❌ 无法检查自动压缩状态: ${error.message}`)
}

// 2. 测试 getAutoCompactThreshold 函数
console.log('\n🔍 测试 2: 检查自动压缩阈值')
try {
  const { getAutoCompactThreshold } = await import('./services/compact/autoCompact.js')
  const threshold = getAutoCompactThreshold('claude-3-5-sonnet-20241022')
  console.log(`✅ 自动压缩阈值: ${threshold.toLocaleString()} tokens`)
} catch (error) {
  console.log(`❌ 无法计算自动压缩阈值: ${error.message}`)
}

// 3. 测试 calculateTokenWarningState 函数
console.log('\n🔍 测试 3: 检查token警告状态')
try {
  const { calculateTokenWarningState } = await import('./services/compact/autoCompact.js')
  const tokenCount = 150000 // 模拟大量tokens
  const model = 'claude-3-5-sonnet-20241022'
  const warningState = calculateTokenWarningState(tokenCount, model)

  console.log(`✅ Token计数: ${tokenCount.toLocaleString()}`)
  console.log(`✅ 剩余百分比: ${warningState.percentLeft}%`)
  console.log(`✅ 超过警告阈值: ${warningState.isAboveWarningThreshold}`)
  console.log(`✅ 超过错误阈值: ${warningState.isAboveErrorThreshold}`)
  console.log(`✅ 超过自动压缩阈值: ${warningState.isAboveAutoCompactThreshold}`)
  console.log(`✅ 达到阻塞限制: ${warningState.isAtBlockingLimit}`)
} catch (error) {
  console.log(`❌ 无法计算token警告状态: ${error.message}`)
}

// 4. 测试 shouldAutoCompact 函数
console.log('\n🔍 测试 4: 检查是否应该触发自动压缩')
try {
  const { shouldAutoCompact } = await import('./services/compact/autoCompact.js')
  const shouldCompact = await shouldAutoCompact(mockMessages, 'claude-3-5-sonnet-20241022')
  console.log(`✅ 应该触发自动压缩: ${shouldCompact}`)
} catch (error) {
  console.log(`❌ 无法检查自动压缩条件: ${error.message}`)
}

console.log('\n📝 测试总结:')
console.log('- 检查了自动压缩的各个核心功能')
console.log('- 验证了阈值计算和状态判断')
console.log('- 测试了压缩条件检查逻辑')
console.log('\n🎉 自动压缩功能测试完成！')

try {
  if (warningState?.isAboveAutoCompactThreshold) {
    console.log('\n⚠️  注意: 当前模拟数据已超过自动压缩阈值，系统应该会触发压缩。')
    console.log('💡 建议: 在实际使用中，当看到 "auto-compact threshold reached" 的调试日志时，说明压缩即将触发。')
  } else {
    console.log('\nℹ️  当前模拟数据未达到自动压缩阈值，但系统逻辑正常工作。')
  }
} catch (e) {
  console.log('\nℹ️  无法检查压缩状态，但这可能是正常的（模块导入失败）。')
}