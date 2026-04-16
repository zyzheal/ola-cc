#!/usr/bin/env node
/**
 * Test script to verify stdin handling in Node.js 22+ TTY environment
 *
 * This script creates a minimal reproduction of the stdin handling patterns
 * used in the CLI to identify issues with raw mode and 'readable' event listeners.
 */

import process from 'node:process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';

// Create a minimal CLI test script
const testCliContent = `
// Minimal stdin test that simulates the CLI's stdin handling
import process from 'node:process';

console.log('=== Minimal stdin test ===');
console.log('Node.js version:', process.version);
console.log('stdin.isTTY:', process.stdin.isTTY);

if (!process.stdin.isTTY) {
  console.log('ERROR: stdin is not a TTY');
  process.exit(1);
}

let inputReceived = false;
let inputBuffer = '';

// Pattern 1: Early input capture (BUG: missing resume after adding listener)
function testEarlyInputPattern() {
  console.log('\\n1. Testing early input pattern (missing resume)...');

  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.ref();

  const handler = () => {
    let chunk = process.stdin.read();
    while (chunk !== null) {
      if (typeof chunk === 'string') {
        inputBuffer += chunk;
        console.log('Received:', JSON.stringify(chunk));
        inputReceived = true;

        // Exit on Enter
        if (chunk === '\\r' || chunk === '\\n') {
          console.log('Enter detected, stopping early input...');
          stopEarlyInput();
          return;
        }
      }
      chunk = process.stdin.read();
    }
  };

  process.stdin.on('readable', handler);
  // BUG: Missing resume() here!

  console.log('Waiting for Enter key...');
}

function stopEarlyInput() {
  console.log('\\n2. Stopping early input...');

  // Remove listener
  process.stdin.removeAllListeners('readable');

  // BUG: Not handling stream state properly before setRawMode(false)
  process.stdin.setRawMode(false);

  console.log('inputReceived:', inputReceived);
  console.log('inputBuffer:', JSON.stringify(inputBuffer));

  // Now test handleSetRawMode pattern
  testHandleSetRawModePattern();
}

// Pattern 2: handleSetRawMode pattern (FIX: resume after adding listener)
function testHandleSetRawModePattern() {
  console.log('\\n3. Testing handleSetRawMode pattern...');

  let handleReceived = false;
  let handleBuffer = '';

  process.stdin.setEncoding('utf8');

  // Drain any buffered data
  try {
    while (process.stdin.read() !== null) { /* drain */ }
  } catch (e) {
    console.log('Drain error:', e.message);
  }

  process.stdin.ref();
  process.stdin.setRawMode(true);

  const handleReadable = () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
      if (typeof chunk === 'string') {
        handleBuffer += chunk;
        console.log('Handle received:', JSON.stringify(chunk));
        handleReceived = true;

        if (chunk === '\\r' || chunk === '\\n') {
          finish(handleReceived, handleBuffer);
        }
      }
    }
  };

  process.stdin.addListener('readable', handleReadable);
  process.stdin.resume(); // FIX: resume AFTER adding listener

  console.log('Waiting for Enter key...');

  // Timeout after 10 seconds
  setTimeout(() => {
    console.log('\\nTimeout!');
    finish(handleReceived, handleBuffer);
  }, 10000);
}

function finish(received, buffer) {
  console.log('\\n4. Results:');
  console.log('handleReceived:', received);
  console.log('handleBuffer:', JSON.stringify(buffer));

  process.stdin.removeAllListeners('readable');
  process.stdin.setRawMode(false);

  console.log('\\n=== Test complete ===');
  process.exit(received ? 0 : 1);
}

testEarlyInputPattern();
`;

// Write the test CLI script
const testCliPath = '/tmp/test-stdin-cli.mjs';
writeFileSync(testCliPath, testCliContent);

console.log('Test CLI script written to:', testCliPath);
console.log('\nTo test manually:');
console.log('  node', testCliPath);
console.log('\nPress Enter twice to test the stdin patterns.');

// Also create a script that tests the actual dist/publish/cli.js
const actualCliTest = `
import process from 'node:process';
import { spawn } from 'node:child_process';

console.log('=== Testing actual CLI stdin handling ===');
console.log('Node.js version:', process.version);

// Spawn the actual CLI
const cli = spawn('node', ['../dist/publish/cli.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: '/tmp',
  env: { ...process.env, CLAUDE_CODE_NO_STARTUP: '1' }
});

let output = '';
let sentEnter = false;

cli.stdout.on('data', (data) => {
  output += data.toString();
  console.log('CLI stdout:', data.toString().substring(0, 100));

  // When we see a prompt-like output, send Enter
  if (!sentEnter && output.length > 100) {
    console.log('\\nSending Enter key...');
    cli.stdin.write('\\r');
    sentEnter = true;

    setTimeout(() => {
      console.log('\\nSending another Enter...');
      cli.stdin.write('\\r');

      setTimeout(() => {
        console.log('\\nExiting...');
        cli.kill('SIGINT');
      }, 5000);
    }, 5000);
  }
});

cli.stderr.on('data', (data) => {
  console.log('CLI stderr:', data.toString());
});

cli.on('close', (code) => {
  console.log('\\nCLI exited with code:', code);
  console.log('\\nTotal output length:', output.length);
});

cli.on('error', (err) => {
  console.log('CLI error:', err);
});

// Timeout after 30 seconds
setTimeout(() => {
  console.log('\\nTest timeout, killing CLI...');
  cli.kill();
}, 30000);
`;

const actualCliTestPath = '/tmp/test-actual-cli.mjs';
writeFileSync(actualCliTestPath, actualCliTest);

console.log('\nActual CLI test script written to:', actualCliTestPath);
console.log('\nTo test actual CLI:');
console.log('  node', actualCliTestPath);