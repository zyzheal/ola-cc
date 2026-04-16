#!/usr/bin/env node
/**
 * Test script to verify CLI stdin handling in Node.js 22+
 * Spawns the CLI as a child process and tests Enter key handling
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import { writeFileSync } from 'node:fs';

console.log('\n=== CLI stdin handling test ===');
console.log('Node.js version:', process.version);

// Test with the actual CLI
const cliPath = process.argv[2] || './dist/publish/cli.js';

console.log('Testing CLI:', cliPath);

// Spawn CLI with piped stdin/stdout
const cli = spawn('node', [cliPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    CLAUDE_CODE_NO_STARTUP: '1',
    CLAUDE_CODE_SKIP_INIT: '1',
    DEBUG: 'stdin:*'
  }
});

let stdoutBuffer = '';
let stderrBuffer = '';
let sentEnter = false;
let enterResponses = 0;
let startTime = Date.now();

cli.stdout.on('data', (data) => {
  stdoutBuffer += data.toString();
  const elapsed = Date.now() - startTime;
  console.log(`[${elapsed}ms] stdout (${data.length}b):`, data.toString().substring(0, 100).replace(/\n/g, '\\n'));
});

cli.stderr.on('data', (data) => {
  stderrBuffer += data.toString();
  const elapsed = Date.now() - startTime;
  console.log(`[${elapsed}ms] stderr:`, data.toString().substring(0, 200));
});

cli.on('error', (err) => {
  console.log('CLI spawn error:', err);
});

cli.on('close', (code, signal) => {
  const elapsed = Date.now() - startTime;
  console.log(`\n[${elapsed}ms] CLI closed: code=${code}, signal=${signal}`);
  console.log('\nstdout length:', stdoutBuffer.length);
  console.log('stderr length:', stderrBuffer.length);
  console.log('Enter responses received:', enterResponses);

  if (enterResponses > 0) {
    console.log('\nSUCCESS: Enter key was processed by CLI');
  } else {
    console.log('\nFAILURE: Enter key was NOT processed by CLI');
    console.log('This indicates stdin handling issue in Node.js 22+');
  }
});

// Wait for CLI to start, then send Enter
setTimeout(() => {
  console.log('\n*** Sending Enter key (CR) ***');
  cli.stdin.write('\r');
  sentEnter = true;

  setTimeout(() => {
    console.log('\n*** Sending second Enter key ***');
    cli.stdin.write('\r');
    enterResponses++;

    setTimeout(() => {
      console.log('\n*** Sending Ctrl+C to exit ***');
      cli.stdin.write('\x03');

      setTimeout(() => {
        console.log('\n*** Force killing CLI ***');
        cli.kill('SIGKILL');
      }, 3000);
    }, 5000);
  }, 5000);
}, 5000);

// Timeout after 30 seconds
setTimeout(() => {
  console.log('\n*** Test timeout, killing CLI ***');
  cli.kill('SIGKILL');
}, 30000);