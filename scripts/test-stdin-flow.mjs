#!/usr/bin/env node
/**
 * Simple stdin test for Node.js 22+ TTY environment
 * Tests the stdin handling patterns used in the CLI
 */

import process from 'node:process';

console.log('\n=== Simple stdin state machine test ===');
console.log('Node.js version:', process.version);
console.log('stdin.isTTY:', process.stdin.isTTY);

if (!process.stdin.isTTY) {
  console.log('ERROR: stdin is not a TTY');
  process.exit(1);
}

// Test the complete flow: early input -> stop -> handleSetRawMode
async function testCompleteFlow() {
  let phase = 1;
  let receivedInPhase2 = false;
  let receivedInPhase3 = false;

  // Phase 1: Simulate earlyInput pattern with FIX (resume after addListener)
  console.log('\nPhase 1: Setting up early input capture (with resume)...');
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.ref();

  const earlyHandler = () => {
    let chunk = process.stdin.read();
    while (chunk !== null) {
      if (typeof chunk === 'string') {
        console.log('Phase 1 received:', JSON.stringify(chunk));
        if (chunk === '\r' || chunk === '\n') {
          console.log('Enter detected in Phase 1, moving to Phase 2...');
          transitionToPhase2();
          return;
        }
      }
      chunk = process.stdin.read();
    }
  };

  process.stdin.on('readable', earlyHandler);
  process.stdin.resume(); // FIX: resume after adding listener

  console.log('Press Enter to continue to Phase 2...');

  function transitionToPhase2() {
    phase = 2;

    // Phase 2: Stop early input with FIX (pause before setRawMode)
    console.log('\nPhase 2: Stopping early input (with pause)...');
    process.stdin.removeListener('readable', earlyHandler);

    // FIX: pause before setRawMode(false)
    process.stdin.pause();
    process.stdin.setRawMode(false);

    console.log('Early input stopped. Press Enter to continue to Phase 3...');

    // Phase 3: handleSetRawMode pattern with FIX
    setTimeout(() => {
      phase = 3;
      console.log('\nPhase 3: Setting up handleSetRawMode pattern...');

      process.stdin.setEncoding('utf8');

      // Resume to enable draining
      try {
        process.stdin.resume();
      } catch (e) {
        console.log('Resume error:', e.message);
      }

      // Drain any buffered data
      try {
        while (process.stdin.read() !== null) { /* drain */ }
      } catch (e) {
        console.log('Drain error:', e.message);
      }

      // Pause before adding listener
      try {
        process.stdin.pause();
      } catch (e) {
        console.log('Pause error:', e.message);
      }

      process.stdin.ref();
      process.stdin.setRawMode(true);

      const handleReadable = () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
          if (typeof chunk === 'string') {
            console.log('Phase 3 received:', JSON.stringify(chunk));
            receivedInPhase3 = true;
            if (chunk === '\r' || chunk === '\n') {
              console.log('Enter detected in Phase 3, test complete!');
              finishTest();
            }
          }
        }
      };

      process.stdin.addListener('readable', handleReadable);
      process.stdin.resume(); // FIX: resume after adding listener

      console.log('Press Enter to complete test...');
    }, 1000);
  }

  function finishTest() {
    console.log('\n=== Test Results ===');
    console.log('Phase 1: Early input capture worked');
    console.log('Phase 2: Stop early input worked');
    console.log('Phase 3: handleSetRawMode worked:', receivedInPhase3);

    process.stdin.removeAllListeners('readable');
    process.stdin.setRawMode(false);
    process.exit(0);
  }

  // Timeout after 30 seconds
  setTimeout(() => {
    console.log('\nTimeout at phase:', phase);
    process.exit(1);
  }, 30000);
}

testCompleteFlow();