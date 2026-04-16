#!/usr/bin/env node
/**
 * 诊断发布版本的回车键问题
 * 
 * 测试 stdin raw mode 和回车键处理
 */

console.error('=== stdin 诊断测试 ===\n')

const stdin = process.stdin

console.error('1. stdin 属性:')
console.error('   isTTY:', stdin.isTTY)
console.error('   isRaw:', stdin.isRaw)
console.error('   fd:', stdin.fd)
console.error('   encoding:', stdin.encoding)
console.error('   readable:', stdin.readable)

console.error('\n2. 测试 setRawMode:')
try {
  console.error('   设置 raw mode = true...')
  stdin.setRawMode(true)
  console.error('   ✓ setRawMode(true) 成功')
  console.error('   stdin.isRaw:', stdin.isRaw)
  
  // 监听 readable 事件
  let keyCount = 0
  let enterCount = 0
  let lastKey = null
  
  stdin.on('readable', () => {
    let chunk
    while ((chunk = stdin.read()) !== null) {
      keyCount++
      lastKey = chunk
      
      console.error(`\n   [按键 #${keyCount}]`)
      console.error('     原始值:', JSON.stringify(chunk))
      console.error('     长度:', chunk.length)
      console.error('     字节:', [...chunk].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' '))
      
      if (chunk === '\r') {
        enterCount++
        console.error('     ✓ 检测到回车符 \\r (0x0D)')
      } else if (chunk === '\n') {
        console.error('     ⚠ 检测到换行符 \\n (0x0A) - 这不是 raw mode 下的 Enter')
      } else if (chunk === '\x7f') {
        console.error('     ✓ 检测到退格键 DEL (0x7F)')
      }
      
      // 按 10 个键或 3 个回车后退出
      if (keyCount >= 10 || enterCount >= 3) {
        console.error(`\n3. 测试结果:`)
        console.error(`   总按键: ${keyCount}`)
        console.error(`   回车键: ${enterCount}`)
        console.error(`   最后一个键: ${JSON.stringify(lastKey)}`)
        
        if (enterCount === 0 && keyCount > 0) {
          console.error(`\n   ❌ 问题: 按了回车键但没有检测到 \\r`)
          console.error(`   可能原因:`)
          console.error(`   1. Terminal 没有正确发送 \\r`)
          console.error(`   2. setRawMode 没有正确工作`)
          console.error(`   3. Bun build 的 stdin 处理有问题`)
        } else if (enterCount > 0) {
          console.error(`\n   ✓ 回车键正常工作`)
        }
        
        stdin.setRawMode(false)
        process.exit(0)
      }
    }
  })
  
  console.error('\n3. 请按键测试 (按 10 个键或 3 个回车后自动退出):')
  console.error('   特别注意按 Enter 键的行为\n')
  
} catch (error) {
  console.error('   ❌ setRawMode 失败:', error.message)
  console.error('   这可能是发布版本的问题根源')
  process.exit(1)
}

// 10 秒超时
setTimeout(() => {
  console.error('\n\n⚠ 超时退出')
  stdin.setRawMode(false)
  process.exit(0)
}, 10000)
