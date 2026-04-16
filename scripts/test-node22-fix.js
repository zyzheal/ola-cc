#!/usr/bin/env node
/**
 * 测试 Node.js 22 stdin rawMode 修复是否有效
 *
 * 运行方法：
 *   node scripts/test-node22-fix.js
 *
 * 预期结果：
 *   - 按 Enter 键应该看到 "SUCCESS: Enter key received!"
 *   - 如果看到 "Timeout" 表示修复未生效
 */

console.log('=== Node.js 22 stdin rawMode 修复验证 ===');
console.log('Node.js:', process.version);
console.log('');

if (!process.stdin.isTTY) {
  console.log('ERROR: 不是 TTY 环境。请在真实终端中运行此脚本。');
  process.exit(1);
}

// 测试修复后的流程
console.log('测试修复后的 stdin 流程：');
console.log('');

// Phase 1: 启用 rawMode（模拟 earlyInput）
console.log('Phase 1: setRawMode(true) - 模拟 earlyInput 启动');
process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdin.ref();

const earlyHandler = () => {
  let chunk = process.stdin.read();
  while (chunk !== null) {
    console.log('  earlyHandler 收到:', JSON.stringify(chunk));
    chunk = process.stdin.read();
  }
};
process.stdin.on('readable', earlyHandler);

await new Promise(r => setTimeout(r, 50));

// Phase 2: 禁用 rawMode（模拟 stopCapturingEarlyInput）
console.log('Phase 2: setRawMode(false) - 模拟 earlyInput 停止');
process.stdin.removeListener('readable', earlyHandler);
process.stdin.setRawMode(false);

// Phase 3: Ink handleSetRawMode (带修复)
console.log('Phase 3: Ink handleSetRawMode(true) - 带 Node.js 22 修复');
process.stdin.setEncoding('utf8');

// Node.js 22 修复：drain + resume
while (process.stdin.read() !== null) { /* drain */ }
process.stdin.resume();

// 启用 rawMode
process.stdin.setRawMode(true);
// **修复关键点**：在 setRawMode(true) 后调用 resume() 确保 flowing mode
process.stdin.resume();

// 添加 readable 监听器
let success = false;
const inkHandler = () => {
  let chunk = process.stdin.read();
  while (chunk !== null) {
    const codes = Array.from(chunk).map(c => c.charCodeAt(0));
    console.log('  Ink handler 收到:', JSON.stringify(chunk), 'codes:', codes);

    if (chunk === '\r' || chunk === '\n' || codes.includes(13) || codes.includes(10)) {
      console.log('');
      console.log('✓ SUCCESS: Enter key 收到并正确处理！');
      success = true;
      cleanup();
      process.exit(0);
    }

    if (codes.includes(3)) {
      console.log('Ctrl+C 收到，退出...');
      cleanup();
      process.exit(130);
    }
    chunk = process.stdin.read();
  }
};
process.stdin.addListener('readable', inkHandler);

console.log('  readable 监听器已添加');
console.log('');
console.log('等待输入...');
console.log('按 Enter 键测试（应该看到 SUCCESS）');
console.log('按 Ctrl+C 退出');
console.log('');

const timeout = setTimeout(() => {
  console.log('');
  console.log('✗ Timeout: 15 秒内未收到 Enter 键');
  console.log('');
  console.log('诊断信息：');
  console.log('  isRaw:', process.stdin.isRaw);
  console.log('  readableFlowing:', process.stdin.readableFlowing);
  console.log('  readable listeners:', process.stdin.listeners('readable').length);
  console.log('');
  console.log('如果 Timeout，可能需要检查修复是否正确应用。');
  cleanup();
  process.exit(1);
}, 15000);

function cleanup() {
  clearTimeout(timeout);
  try {
    if (process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeListener('readable', inkHandler);
  } catch {}
}