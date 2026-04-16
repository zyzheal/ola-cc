#!/usr/bin/env node
/**
 * Diagnostic script for Node.js stdin rawMode issue in publish build
 *
 * This script tests the stdin rawMode flow that causes Enter key
 * not working in Node.js 22+ with the publish build.
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('=== Node.js stdin rawMode diagnostic ===');
console.log('Node.js version:', process.version);
console.log('Platform:', process.platform);
console.log('');

// Test 1: Basic rawMode functionality
console.log('Test 1: Basic stdin.setRawMode functionality');
try {
  if (process.stdin.isTTY) {
    console.log('  stdin.isTTY: true');

    // Test the flow: enable -> disable -> enable
    console.log('  Testing rawMode cycle...');

    // First enable
    process.stdin.setRawMode(true);
    console.log('  setRawMode(true) - SUCCESS');

    // Then disable
    process.stdin.setRawMode(false);
    console.log('  setRawMode(false) - SUCCESS');

    // Re-enable
    process.stdin.setRawMode(true);
    console.log('  setRawMode(true) again - SUCCESS');

    // Final disable
    process.stdin.setRawMode(false);
    console.log('  setRawMode(false) again - SUCCESS');

    console.log('  ✓ Basic rawMode cycle works');
  } else {
    console.log('  stdin.isTTY: false (not a TTY)');
    console.log('  Skipping rawMode test');
  }
} catch (err) {
  console.log('  ✗ Error:', err.message);
}

console.log('');

// Test 2: stdin buffer drain
console.log('Test 2: stdin buffer drain behavior');
try {
  if (process.stdin.isTTY) {
    // Enable rawMode first
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');

    // Drain any buffered data
    console.log('  Draining stdin buffer...');
    let drained = 0;
    while (process.stdin.read() !== null) {
      drained++;
    }
    console.log('  Drained iterations:', drained);

    // Resume stdin
    console.log('  Calling stdin.resume()...');
    process.stdin.resume();

    console.log('  ✓ Buffer drain works');

    // Clean up
    process.stdin.setRawMode(false);
  } else {
    console.log('  Not a TTY, skipping');
  }
} catch (err) {
  console.log('  ✗ Error:', err.message);
}

console.log('');

// Test 3: Check if stdin readable event works after rawMode toggle
console.log('Test 3: stdin readable event after rawMode cycle');
try {
  if (process.stdin.isTTY) {
    let receivedData = false;

    // Setup
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);

    // Add readable listener
    const handler = () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        receivedData = true;
        console.log('  Received input:', JSON.stringify(chunk));
      }
    };

    process.stdin.on('readable', handler);
    console.log('  Added readable listener');

    // Clean up immediately
    process.stdin.removeListener('readable', handler);
    process.stdin.setRawMode(false);

    console.log('  ✓ Readable event setup/cleanup works');
  } else {
    console.log('  Not a TTY, skipping');
  }
} catch (err) {
  console.log('  ✗ Error:', err.message);
}

console.log('');

// Test 4: Run the actual publish build and check stdin setup
console.log('Test 4: Testing publish build startup');
const cliPath = path.join(__dirname, 'dist/publish/cli.js');

if (require('fs').existsSync(cliPath)) {
  console.log('  CLI exists at:', cliPath);

  // Spawn with --version to test quick startup
  const child = spawn('node', [cliPath, '--version'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  child.on('close', (code) => {
    console.log('  Exit code:', code);
    console.log('  Stdout:', stdout.trim() || '(empty)');
    if (stderr) {
      console.log('  Stderr:', stderr.trim());
    }

    if (code === 0 && stdout.includes('Claude Code')) {
      console.log('  ✓ Publish build basic startup works');
    } else {
      console.log('  ✗ Publish build startup issue');
    }
  });
} else {
  console.log('  CLI not found at:', cliPath);
}

console.log('');

// Test 5: Check for Node.js 22 specific issues
console.log('Test 5: Node.js 22 specific checks');
const nodeVersion = parseInt(process.version.slice(1).split('.')[0]);

if (nodeVersion >= 22) {
  console.log('  Running Node.js 22+, checking specific behaviors...');

  // Node.js 22 introduced changes to TTY handling
  // Check if stdin has the expected properties
  console.log('  stdin properties check:');
  console.log('    - isTTY:', process.stdin.isTTY);
  console.log('    - readable:', process.stdin.readable);
  console.log('    - readableFlowing:', process.stdin.readableFlowing);
  console.log('    - readableLength:', process.stdin.readableLength);

  if (process.stdin.isTTY) {
    // In Node.js 22, the rawMode state machine might differ
    console.log('  Testing multiple rapid rawMode toggles...');
    try {
      for (let i = 0; i < 5; i++) {
        process.stdin.setRawMode(true);
        process.stdin.setRawMode(false);
      }
      console.log('  ✓ Rapid toggles work');
    } catch (err) {
      console.log('  ✗ Rapid toggle error:', err.message);
    }
  }
} else {
  console.log('  Node.js version < 22, no special checks needed');
}

console.log('');
console.log('=== Diagnostic complete ===');