#!/usr/bin/env node
/**
 * 使用 node-pty 模拟真实 TTY 环境测试 stdin rawMode
 * 此脚本自动化测试 Enter 键在 Node.js 22+ 环境下的行为
 */

import pty from 'node-pty';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('=== node-pty TTY stdin 自动化测试 ===');
console.log('Node.js:', process.version);
console.log('');

const cliPath = path.join(__dirname, '../dist/publish/cli.js');

// 创建 PTY 进程模拟真实终端
const ptyProcess = pty.spawn('node', [cliPath], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env
});

console.log('PTY 进程已启动');
console.log('');

let output = '';
let startTime = Date.now();
let enterKeyPressed = false;
let responseReceived = false;

// 收集输出
ptyProcess.onData((data) => {
  output += data;
  const elapsed = Date.now() - startTime;

  // 检查是否进入了交互界面（有提示符或 logo）
  if (data.includes('Claude') || data.includes('│') || data.includes('?')) {
    if (!enterKeyPressed && elapsed > 2000) {
      console.log(`[${elapsed}ms] 检测到交互界面，准备发送 Enter 键测试`);

      // 等待一小段时间确保界面稳定
      setTimeout(() => {
        console.log('发送 Enter 键 (\\r)...');
        ptyProcess.write('\r');

        enterKeyPressed = true;
        startTime = Date.now();

        // 等待响应
        setTimeout(() => {
          if (!responseReceived) {
            console.log('');
            console.log('=== 测试结果 ===');
            console.log('Enter 键发送后 3 秒内未收到响应');
            console.log('');
            console.log('收集的输出:');
            console.log(output.slice(-500));
            console.log('');
            console.log('这表明 stdin rawMode 可能有问题');

            // 尝试发送其他测试输入
            console.log('');
            console.log('尝试发送测试文本...');
            ptyProcess.write('test input\r');

            setTimeout(() => {
              console.log('');
              console.log('最终输出:');
              console.log(output.slice(-1000));
              ptyProcess.kill();
              process.exit(1);
            }, 2000);
          }
        }, 3000);
      }, 500);
    }
  }

  // 检查是否有响应（消息被处理）
  if (enterKeyPressed && (data.includes('Thinking') || data.includes('processing') || data.includes('response'))) {
    responseReceived = true;
    console.log('');
    console.log('=== 测试成功 ===');
    console.log('Enter 键正常工作！收到响应');
    console.log('');
    ptyProcess.kill();
    process.exit(0);
  }
});

ptyProcess.onExit(({ exitCode }) => {
  console.log('');
  console.log('PTY 进程退出，code:', exitCode);
  console.log('');
  console.log('=== 输出摘要 ===');
  console.log(output.slice(-2000));
});

// 超时保护
setTimeout(() => {
  console.log('');
  console.log('=== 测试超时 (15秒) ===');
  console.log('');
  console.log('收集的输出:');
  console.log(output);
  console.log('');
  console.log('Enter 键已发送:', enterKeyPressed);
  console.log('响应已收到:', responseReceived);

  ptyProcess.kill();
  process.exit(enterKeyPressed && responseReceived ? 0 : 1);
}, 15000);