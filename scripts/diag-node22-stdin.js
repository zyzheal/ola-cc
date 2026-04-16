#!/usr/bin/env node
/**
 * Node.js 22 stdin rawMode detailed diagnostic
 *
 * Tests the exact flow that might cause Enter key not working.
 * Run in a real terminal: node scripts/diag-node22-stdin.js
 */

console.log('=== Node.js 22 stdin rawMode detailed diagnostic ===');
console.log('Node.js:', process.version);
console.log('Platform:', process.platform);
console.log('');

if (!process.stdin.isTTY) {
  console.log('ERROR: Not a TTY. Run in a real terminal.');
  process.exit(1);
}

const tty = require('tty');
console.log('stdin type:', process.stdin.constructor.name);
console.log('stdin._readableState:', process.stdin._readableState ? {
  flowing: process.stdin._readableState.flowing,
  paused: process.stdin._readableState.paused,
  readable: process.stdin._readableState.readable,
  pipes: process.stdin._readableState.pipes?.length || 0,
} : 'N/A');

// Test scenario: earlyInput -> stop -> Ink handleSetRawMode
console.log('');
console.log('=== Test: Simulating CLI stdin flow ===');
console.log('');

// Phase 1: earlyInput start
console.log('Phase 1: startCapturingEarlyInput');
console.log('  Before: isRaw=', process.stdin.isRaw);

process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdin.ref();

console.log('  After setRawMode(true):');
console.log('    isRaw=', process.stdin.isRaw);
console.log('    readableFlowing=', process.stdin.readableFlowing);

// Add early handler
let earlyBuffer = '';
const earlyHandler = () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    earlyBuffer += chunk;
    console.log('    earlyBuffer received:', JSON.stringify(chunk));
  }
};
process.stdin.on('readable', earlyHandler);
console.log('  Added readable listener');

// Wait for potential early input
await new Promise(r => setTimeout(r, 50));

// Phase 2: stopCapturingEarlyInput (with Node.js 22 fix)
console.log('');
console.log('Phase 2: stopCapturingEarlyInput');
process.stdin.removeListener('readable', earlyHandler);
console.log('  Removed readable listener');

// THE FIX: disable rawMode
process.stdin.setRawMode(false);
console.log('  After setRawMode(false):');
console.log('    isRaw=', process.stdin.isRaw);
console.log('    readableFlowing=', process.stdin.readableFlowing);

// Phase 3: Ink handleSetRawMode (with Node.js 22 fix)
console.log('');
console.log('Phase 3: Ink handleSetRawMode(true)');

process.stdin.setEncoding('utf8');

// Node.js 22 fix: drain
console.log('  Draining stdin...');
let drainCount = 0;
while (process.stdin.read() !== null) {
  drainCount++;
}
console.log('    Drain iterations:', drainCount);

// Node.js 22 fix: resume
console.log('  Calling stdin.resume()...');
process.stdin.resume();
console.log('    After resume:');
console.log('      readableFlowing=', process.stdin.readableFlowing);

// Now check state before setRawMode
console.log('  State before setRawMode(true):');
console.log('    isRaw=', process.stdin.isRaw);
console.log('    readableFlowing=', process.stdin.readableFlowing);

// Enable rawMode
console.log('  Calling setRawMode(true)...');
process.stdin.setRawMode(true);

console.log('  After setRawMode(true):');
console.log('    isRaw=', process.stdin.isRaw);
console.log('    readableFlowing=', process.stdin.readableFlowing);

// Add Ink's readable handler
let receivedEnter = false;
const inkHandler = () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    const codes = Array.from(chunk).map(c => c.charCodeAt(0));
    console.log('    Ink handler received:', JSON.stringify(chunk), 'codes:', codes);

    // Check for Enter
    if (chunk === '\r' || chunk === '\n' || codes.includes(13) || codes.includes(10)) {
      console.log('');
      console.log('    ✓ SUCCESS: Enter key received and processed!');
      receivedEnter = true;
      cleanup();
      process.exit(0);
    }

    // Check for Ctrl+C
    if (codes.includes(3)) {
      console.log('    Ctrl+C received, exiting...');
      cleanup();
      process.exit(130);
    }
  }
};
process.stdin.addListener('readable', inkHandler);
console.log('  Added Ink readable handler');

console.log('');
console.log('=== Waiting for input ===');
console.log('Press ENTER key to test...');
console.log('Press Ctrl+C to exit');
console.log('');

// Timeout
const timeout = setTimeout(() => {
  console.log('');
  console.log('=== Timeout after 15 seconds ===');
  console.log('No Enter key received. This indicates a stdin issue.');
  console.log('');
  console.log('Diagnostic information:');
  console.log('  isRaw:', process.stdin.isRaw);
  console.log('  readableFlowing:', process.stdin.readableFlowing);
  console.log('  readable listeners:', process.stdin.listeners('readable').length);
  console.log('  readableLength:', process.stdin.readableLength);

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