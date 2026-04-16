#!/usr/bin/env node
/**
 * 深度诊断回车键问题
 * 
 * 这个脚本模拟实际的 stdin 处理流程来定位问题
 */

import { Buffer } from 'buffer'

console.error('=== 回车键深度诊断 ===\n')

// 1. 测试 Buffer.toString('utf8') vs String(Buffer)
console.error('1. 测试 Buffer 转换方法:')
const testBuffer = Buffer.from([0x0D]) // \r 的字节
const method1 = testBuffer.toString('utf8')
const method2 = String(testBuffer)

console.error(`   Buffer: [${[...testBuffer].map(b => '0x' + b.toString(16)).join(', ')}]`)
console.error(`   toString('utf8'): ${JSON.stringify(method1)} (长度: ${method1.length})`)
console.error(`   String(): ${JSON.stringify(method2)} (长度: ${method2.length})`)
console.error(`   两者相等: ${method1 === method2 ? '✅ 是' : '❌ 否'}`)

if (method1 === '\r') {
  console.error(`   ✅ toString('utf8') 正确返回 '\\r'`)
} else {
  console.error(`   ❌ toString('utf8') 返回了意外值`)
}

if (method2 === '\r') {
  console.error(`   ✅ String() 也正确返回 '\\r'`)
} else {
  console.error(`   ⚠️  String() 返回了意外值（这可能是问题根源）`)
}

// 2. 测试实际的比较
console.error('\n2. 测试关键比较:')
const s1 = method1
const s2 = method2
console.error(`   s === '\\r' (toString): ${s1 === '\r' ? '✅ true' : '❌ false'}`)
console.error(`   s === '\\r' (String): ${s2 === '\r' ? '✅ true' : '❌ false'}`)
console.error(`   s.charCodeAt(0): ${s1.charCodeAt(0)} (应该是 13 = 0x0D)`)

// 3. 测试 stdin 行为
console.error('\n3. 测试 stdin raw mode:')

const stdin = process.stdin

console.error(`   stdin.isTTY: ${stdin.isTTY}`)
console.error(`   stdin.encoding: ${stdin.encoding}`)

if (!stdin.isTTY) {
  console.error('   ⚠️  stdin 不是 TTY，这可能影响测试')
}

// 设置 raw mode 并测试
try {
  stdin.setEncoding('utf8')
  console.error(`   ✅ setEncoding('utf8') 成功`)
  
  stdin.setRawMode(true)
  console.error(`   ✅ setRawMode(true) 成功`)
  console.error(`   stdin.isRaw: ${stdin.isRaw}`)
  
  // 监听输入
  let testCount = 0
  const maxTests = 5
  
  stdin.on('readable', () => {
    let chunk
    while ((chunk = stdin.read()) !== null) {
      testCount++
      
      console.error(`\n   [测试 #${testCount}]`)
      console.error(`   原始 chunk 类型: ${typeof chunk}`)
      console.error(`   原始 chunk 值: ${JSON.stringify(chunk)}`)
      
      if (typeof chunk === 'string') {
        console.error(`   ✅ chunk 是字符串`)
        console.error(`   长度: ${chunk.length}`)
        console.error(`   字符代码: ${[...chunk].map(c => c.charCodeAt(0))}`)
        
        if (chunk === '\r') {
          console.error(`   ✅ 检测到回车符 '\\r'`)
          console.error(`   chunk === '\\r': ${chunk === '\r'}`)
        } else if (chunk === '\n') {
          console.error(`   ⚠️  检测到换行符 '\\n' 而不是 '\\r'`)
        } else {
          console.error(`   内容: "${chunk}"`)
        }
      } else if (Buffer.isBuffer(chunk)) {
        console.error(`   ⚠️  chunk 是 Buffer (不应该在 setEncoding 后发生)`)
        console.error(`   Buffer 内容: [${[...chunk].map(b => '0x' + b.toString(16)).join(', ')}]`)
        console.error(`   buffer.toString('utf8'): ${JSON.stringify(chunk.toString('utf8'))}`)
      }
      
      if (testCount >= maxTests) {
        console.error(`\n=== 诊断完成 ===`)
        console.error(`已完成 ${testCount} 次测试`)
        stdin.setRawMode(false)
        process.exit(0)
      }
    }
  })
  
  console.error(`\n4. 请按键测试 (按 ${maxTests} 个键后自动退出):`)
  console.error(`   特别注意:`)
  console.error(`   - 按 Enter 键`)
  console.error(`   - 按普通字母键`)
  console.error(`   - 按 Backspace 键`)
  console.error(``)
  
} catch (error) {
  console.error(`   ❌ 设置失败: ${error.message}`)
  console.error(`   堆栈: ${error.stack}`)
  process.exit(1)
}

// 超时保护
setTimeout(() => {
  console.error(`\n\n⚠️  超时退出 (30 秒)`)
  stdin.setRawMode(false)
  process.exit(0)
}, 30000)
