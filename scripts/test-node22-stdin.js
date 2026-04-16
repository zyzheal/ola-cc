#!/usr/bin/env node
/**
 * Diagnostic script to test stdin rawMode behavior in Node.js 22
 * Run this in a real terminal to test: node scripts/test-node22-stdin.js
 */

const NODE_VERSION = process.version;
const NODE_MAJOR = parseInt(NODE_VERSION.slice(1).split('.')[0], 10);

console.log('=== Node.js stdin rawMode diagnostic ===');
console.log(`Node.js version: ${NODE_VERSION}`);
console.log(`stdin.isTTY: ${process.stdin.isTTY}`);
console.log('');

if (!process.stdin.isTTY) {
  console.log('ERROR: stdin is not a TTY. Run this script in a real terminal.');
  console.log('Example: node scripts/test-node22-stdin.js');
  process.exit(1);
}

// Test 1: Basic rawMode toggle
console.log('Test 1: Basic rawMode toggle');
console.log('  Initial state: isRaw=', process.stdin.isRaw);

try {
  process.stdin.setRawMode(true);
  console.log('  After setRawMode(true): isRaw=', process.stdin.isRaw);

  process.stdin.setRawMode(false);
  console.log('  After setRawMode(false): isRaw=', process.stdin.isRaw);

  console.log('  ✓ Basic toggle works');
} catch (err) {
  console.log('  ✗ Error:', err.message);
}

console.log('');

// Test 2: Simulating the earlyInput -> Ink flow
console.log('Test 2: Simulating earlyInput -> Ink flow');
console.log('  This simulates what happens in the CLI startup');

try {
  // Step 1: earlyInput starts capturing
  console.log('  Step 1: Enable rawMode (like earlyInput.ts)');
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.ref();
  console.log('    isRaw=', process.stdin.isRaw);

  // Simulate having a readable handler
  const readableHandler = () => {
    let chunk = process.stdin.read();
    while (chunk !== null) {
      console.log('    Received chunk:', JSON.stringify(chunk));
      chunk = process.stdin.read();
    }
  };
  process.stdin.on('readable', readableHandler);

  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 100));

  // Step 2: earlyInput stops capturing (with fix)
  console.log('  Step 2: Stop capturing (like stopCapturingEarlyInput)');
  process.stdin.removeListener('readable', readableHandler);

  // THE FIX: Disable rawMode before Ink takes over
  console.log('    Disabling rawMode (Node.js 22 fix)');
  process.stdin.setRawMode(false);
  console.log('    isRaw=', process.stdin.isRaw);

  // Step 3: Ink takes over (handleSetRawMode)
  console.log('  Step 3: Ink handleSetRawMode(true)');

  // Node.js 22 compatibility: drain and resume
  console.log('    Draining stdin buffer...');
  while (process.stdin.read() !== null) { /* drain */ }
  process.stdin.resume();

  process.stdin.setRawMode(true);
  process.stdin.addListener('readable', () => {
    let chunk = process.stdin.read();
    while (chunk !== null) {
      // Check for Enter key (code 13 or 10)
      if (chunk === '\r' || chunk === '\n' || chunk.charCodeAt(0) === 13 || chunk.charCodeAt(0) === 10) {
        console.log('    ENTER key detected! Raw mode working correctly.');
        process.stdin.setRawMode(false);
        process.exit(0);
      }
      console.log('    Received:', JSON.stringify(chunk), 'codes:', chunk.split('').map(c => c.charCodeAt(0)));
      chunk = process.stdin.read();
    }
  });

  console.log('    isRaw=', process.stdin.isRaw);
  console.log('    ✓ RawMode re-enabled successfully');
  console.log('');
  console.log('  NOW PRESS ENTER KEY TO TEST...');
  console.log('  (Should see "ENTER key detected" message)');
  console.log('  (Press Ctrl+C to exit if stuck)');

} catch (err) {
  console.log('  ✗ Error:', err.message);
  process.exit(1);
}

// Handle Ctrl+C
process.stdin.on('data', (chunk) => {
  if (chunk.charCodeAt(0) === 3) { // Ctrl+C
    console.log('\n  Ctrl+C received, exiting...');
    process.stdin.setRawMode(false);
    process.exit(130);
  }
});

// Timeout after 10 seconds
setTimeout(() => {
  console.log('\n  Timeout: No Enter key received after 10 seconds');
  console.log('  This might indicate a rawMode issue');
  process.stdin.setRawMode(false);
  process.exit(1);
}, 10000);