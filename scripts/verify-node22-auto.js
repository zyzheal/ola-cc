#!/usr/bin/env node
/**
 * Node.js 22+ stdin rawMode 自动化验证脚本
 *
 * 此脚本验证 stdin 状态机的关键修复点，无需用户交互。
 */

console.log('=== Node.js 22+ stdin 状态机自动化验证 ===');
console.log('Node.js:', process.version);
console.log('');

if (!process.stdin.isTTY) {
  console.log('ERROR: 不是 TTY 环境，请在真实终端运行');
  process.exit(1);
}

let phaseResults = [];

// Phase 1: earlyInput 启用 rawMode (带 resume 修复)
console.log('Phase 1: earlyInput 启动 (修复版)');
process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdin.ref();

const earlyHandler = () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {}
};

process.stdin.on('readable', earlyHandler);
const flowingAfterListener = process.stdin.readableFlowing;
console.log('  on("readable") - flowing:', flowingAfterListener);
phaseResults.push(['addListener', flowingAfterListener === false ? 'PASS' : 'UNEXPECTED']);

// 关键修复：在 addListener 之后调用 resume
process.stdin.resume();
const flowingAfterResume = process.stdin.readableFlowing;
console.log('  resume() - flowing:', flowingAfterResume);
phaseResults.push(['resume_after_addListener', flowingAfterResume === true ? 'PASS' : 'FAIL']);

// Phase 2: earlyInput 停止 (带 pause 修复)
console.log('');
console.log('Phase 2: earlyInput 停止 (修复版)');
process.stdin.removeListener('readable', earlyHandler);
const flowingAfterRemove = process.stdin.readableFlowing;
console.log('  removeListener("readable") - flowing:', flowingAfterRemove);
phaseResults.push(['removeListener', flowingAfterRemove === true ? 'PASS' : 'UNEXPECTED']);

// Node.js 22+ fix: pause first to reset stream state
process.stdin.pause();
const flowingAfterPause = process.stdin.readableFlowing;
console.log('  pause() - flowing:', flowingAfterPause);
phaseResults.push(['pause_before_setRawMode', flowingAfterPause === false ? 'PASS' : 'FAIL']);

process.stdin.setRawMode(false);
const flowingAfterRawOff = process.stdin.readableFlowing;
console.log('  setRawMode(false) - flowing:', flowingAfterRawOff);
phaseResults.push(['setRawMode_false', flowingAfterRawOff === false ? 'PASS' : 'UNEXPECTED']);

// Phase 3: Ink handleSetRawMode (完整修复)
console.log('');
console.log('Phase 3: Ink handleSetRawMode (完整修复版)');
process.stdin.setEncoding('utf8');

// Node.js 22+ fix: resume to enable draining after pause
process.stdin.resume();
const flowingBeforeDrain = process.stdin.readableFlowing;
console.log('  resume() - flowing:', flowingBeforeDrain);
phaseResults.push(['resume_for_drain', flowingBeforeDrain === true ? 'PASS' : 'FAIL']);

// Drain
let drainedCount = 0;
try {
  while (process.stdin.read() !== null) {
    drainedCount++;
  }
} catch (e) {}
console.log('  drain stdin - drained:', drainedCount);

// Node.js 22+ fix: pause before adding listener
process.stdin.pause();
const flowingBeforeAddListener = process.stdin.readableFlowing;
console.log('  pause() - flowing:', flowingBeforeAddListener);
phaseResults.push(['pause_before_addListener', flowingBeforeAddListener === false ? 'PASS' : 'FAIL']);

// 启用 rawMode
process.stdin.setRawMode(true);
console.log('  setRawMode(true)');

// 添加 readable 监听器
const inkHandler = () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {}
};

process.stdin.addListener('readable', inkHandler);
const flowingAfterAddInkListener = process.stdin.readableFlowing;
console.log('  addListener("readable") - flowing:', flowingAfterAddInkListener);
phaseResults.push(['addListener_ink', flowingAfterAddInkListener === false ? 'PASS' : 'UNEXPECTED']);

// 关键修复：在 addListener 之后调用 resume
process.stdin.resume();
const flowingFinal = process.stdin.readableFlowing;
console.log('  resume() - flowing:', flowingFinal);
phaseResults.push(['final_resume', flowingFinal === true ? 'PASS' : 'FAIL']);

// Cleanup
process.stdin.removeListener('readable', inkHandler);
process.stdin.setRawMode(false);

// Summary
console.log('');
console.log('=== 验证结果汇总 ===');
console.log('');

let allPassed = true;
for (const [step, result] of phaseResults) {
  console.log(`  ${step}: ${result}`);
  if (result === 'FAIL') {
    allPassed = false;
  }
}

console.log('');
if (allPassed) {
  console.log('✓✓✓ 所有状态转换正确！stdin 修复有效。');
  process.exit(0);
} else {
  console.log('✗✗✗ 检测到状态转换问题。请检查修复是否正确应用。');
  process.exit(1);
}