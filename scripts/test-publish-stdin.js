#!/usr/bin/env node
/**
 * Node.js 22 stdin rawMode diagnostic test
 *
 * Run this script in a real terminal to test stdin behavior:
 *   node scripts/test-publish-stdin.js
 *
 * This script tests the exact flow used by the publish build.
 */

const tty = require('tty');

console.log('=== Node.js 22 stdin rawMode diagnostic ===');
console.log('Node.js version:', process.version);
console.log('');

if (!process.stdin.isTTY) {
  console.log('ERROR: stdin is not a TTY.');
  console.log('Please run this script in a real terminal:');
  console.log('  node scripts/test-publish-stdin.js');
  process.exit(1);
}

console.log('stdin.isTTY:', process.stdin.isTTY);
console.log('stdin.isRaw:', process.stdin.isRaw);
console.log('stdin.readableFlowing:', process.stdin.readableFlowing);
console.log('');

// Test 1: Simulate the publish build flow
console.log('Test 1: Simulating publish build stdin flow');

// Step 1: startCapturingEarlyInput
console.log('  Step 1: startCapturingEarlyInput (setRawMode(true), ref, on readable)');
process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdin.ref();
console.log('    isRaw:', process.stdin.isRaw);

const earlyHandler = () => {
  let chunk = process.stdin.read();
  while (chunk !== null) {
    console.log('    earlyHandler received:', JSON.stringify(chunk));
    chunk = process.stdin.read();
  }
};
process.stdin.on('readable', earlyHandler);

// Wait briefly
setTimeout(() => {
  // Step 2: stopCapturingEarlyInput (with Node.js 22 fix)
  console.log('  Step 2: stopCapturingEarlyInput');
  process.stdin.removeListener('readable', earlyHandler);

  // THE FIX: Disable rawMode
  console.log('    setRawMode(false)');
  process.stdin.setRawMode(false);
  console.log('    isRaw:', process.stdin.isRaw);

  // Step 3: Ink handleSetRawMode (with Node.js 22 fix)
  console.log('  Step 3: Ink handleSetRawMode(true)');
  process.stdin.setEncoding('utf8');

  // Node.js 22 fix: drain and resume
  console.log('    Draining stdin...');
  while (process.stdin.read() !== null) { /* drain */ }
  console.log('    stdin.resume()...');
  process.stdin.resume();

  console.log('    setRawMode(true)');
  process.stdin.setRawMode(true);
  console.log('    isRaw:', process.stdin.isRaw);

  // Add Ink's readable handler
  const inkHandler = () => {
    let chunk = process.stdin.read();
    while (chunk !== null) {
      // Check for Enter key
      if (chunk === '\r' || chunk === '\n' || chunk.charCodeAt(0) === 13 || chunk.charCodeAt(0) === 10) {
        console.log('    ✓ ENTER key received! Raw mode working correctly.');
        cleanup();
        process.exit(0);
      }
      // Check for Ctrl+C
      if (chunk.charCodeAt(0) === 3) {
        console.log('    Ctrl+C received, exiting...');
        cleanup();
        process.exit(130);
      }
      console.log('    Received input:', JSON.stringify(chunk), 'codes:', Array.from(chunk).map(c => c.charCodeAt(0)));
      chunk = process.stdin.read();
    }
  };

  process.stdin.addListener('readable', inkHandler);
  console.log('    readable listener added');

  console.log('');
  console.log('  Waiting for input...');
  console.log('  Press ENTER to test (should see "ENTER key received")');
  console.log('  Press Ctrl+C to exit');
  console.log('');

  // Timeout after 10 seconds
  setTimeout(() => {
    console.log('  ✗ Timeout: No ENTER key received after 10 seconds');
    console.log('  This indicates a stdin/rawMode issue');
    cleanup();
    process.exit(1);
  }, 10000);
}, 100);

function cleanup() {
  try {
    if (process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  } catch (err) {
    // Ignore
  }
}