#!/usr/bin/env node
/**
 * Node.js 22+ stdin rawMode 最终验证脚本
 *
 * 此脚本模拟发布版本的完整 stdin 流程，验证修复是否有效。
 * 运行方法：在真实终端中执行 node scripts/verify-node22-fix.js
 */

console.log('=== Node.js 22+ stdin 修复最终验证 ===');
console.log('Node.js:', process.version);
console.log('');

if (!process.stdin.isTTY) {
  console.log('ERROR: 不是 TTY 环境，请在真实终端运行：');
  console.log('  node scripts/verify-node22-fix.js');
  process.exit(1);
}

// 验证修复的核心原理
console.log('修复原理说明：');
console.log('');
console.log('Node.js Readable Stream 状态机：');
console.log('  - flowing=null: 初始状态');
console.log('  - flowing=true: flowing mode (事件会触发)');
console.log('  - flowing=false: paused mode (事件不触发)');
console.log('');
console.log('关键发现：');
console.log('  - on("readable") 会将 flowing 设为 false');
console.log('  - resume() 会将 flowing 设为 true');
console.log('');
console.log('修复方案：');
console.log('  - 必须在 addListener("readable") 之后调用 resume()');
console.log('  - 确保最终 flowing=true，事件能正常触发');
console.log('');

// 模拟修复后的流程
console.log('=== 模拟修复后的流程 ===');
console.log('');

// Phase 1: earlyInput 启用 rawMode
console.log('Phase 1: earlyInput 启动');
process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdin.ref();
console.log('  setRawMode(true), ref()');

const earlyHandler = () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {}
};
process.stdin.on('readable', earlyHandler);
console.log('  on("readable") - flowing:', process.stdin.readableFlowing);

// Node.js 22+ fix: resume after adding listener
process.stdin.resume();
console.log('  resume() - flowing:', process.stdin.readableFlowing);

await new Promise(r => setTimeout(r, 50));

// Phase 2: earlyInput 停止 (带修复)
console.log('');
console.log('Phase 2: earlyInput 停止 (修复版)');
process.stdin.removeListener('readable', earlyHandler);
console.log('  removeListener("readable")');
console.log('  flowing:', process.stdin.readableFlowing);

// Node.js 22+ fix: pause first to reset stream state
process.stdin.pause();
console.log('  pause() - ★ 重置 stream state');

process.stdin.setRawMode(false);
console.log('  setRawMode(false)');
console.log('  flowing:', process.stdin.readableFlowing);

// Phase 3: Ink handleSetRawMode (带修复)
console.log('');
console.log('Phase 3: Ink handleSetRawMode (修复版)');
process.stdin.setEncoding('utf8');

// Node.js 22+ fix: resume to enable draining after pause from Phase 2
process.stdin.resume();
console.log('  resume() - ★ 启用 draining');

// Drain
while (process.stdin.read() !== null) { /* drain */ }
console.log('  drain stdin');

// Node.js 22+ fix: pause before adding listener
process.stdin.pause();
console.log('  pause() - ★ 重置到 paused mode');

// 启用 rawMode
process.stdin.setRawMode(true);
console.log('  setRawMode(true)');

// 添加 readable 监听器
let success = false;
const inkHandler = () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    const codes = Array.from(chunk).map(c => c.charCodeAt(0));

    if (chunk === '\r' || chunk === '\n' || codes.includes(13) || codes.includes(10)) {
      console.log('');
      console.log('✓✓✓ SUCCESS: Enter 键正确处理！');
      console.log('    flowing:', process.stdin.readableFlowing);
      success = true;
      cleanup();
      process.exit(0);
    }

    if (codes.includes(3)) {
      console.log('Ctrl+C，退出...');
      cleanup();
      process.exit(130);
    }
  }
};

process.stdin.addListener('readable', inkHandler);
console.log('  addListener("readable")');
console.log('  flowing:', process.stdin.readableFlowing);

// 关键修复：在 addListener 之后调用 resume
process.stdin.resume();
console.log('  resume() - ★ 关键修复步骤');
console.log('  flowing:', process.stdin.readableFlowing);

console.log('');
console.log('=== 等待输入测试 ===');
console.log('按 Enter 键验证修复（应看到 SUCCESS）');
console.log('按 Ctrl+C 退出');
console.log('');

const timeout = setTimeout(() => {
  console.log('');
  console.log('✗ Timeout: 10秒内未收到 Enter 键');
  console.log('');
  console.log('诊断信息:');
  console.log('  isRaw:', process.stdin.isRaw);
  console.log('  flowing:', process.stdin.readableFlowing);
  console.log('  readable listeners:', process.stdin.listeners('readable').length);
  console.log('');
  console.log('如果 flowing=false，说明修复未正确应用。');
  cleanup();
  process.exit(1);
}, 10000);

function cleanup() {
  clearTimeout(timeout);
  try {
    process.stdin.removeListener('readable', inkHandler);
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
  } catch {}
}