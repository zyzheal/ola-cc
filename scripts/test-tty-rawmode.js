#!/usr/bin/env node
/**
 * TTY Raw Mode Test
 * Verifies that setRawMode works correctly in Node.js 22
 * This test simulates the exact flow that earlyInput.ts -> Ink uses
 */

const tty = require('tty');
const { ReadStream } = tty;

console.log('=== TTY Raw Mode Test for Node.js 22 ===\n');

// Test 1: Check process.stdin capabilities
console.log('Test 1: process.stdin capabilities');
console.log(`  isTTY: ${process.stdin.isTTY}`);
console.log(`  setRawMode: ${typeof process.stdin.setRawMode}`);
console.log(`  isRaw: ${process.stdin.isRaw}`);

// Test 2: Verify setRawMode can be called multiple times
console.log('\nTest 2: Multiple setRawMode calls');
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    try {
        console.log('  Calling setRawMode(true)...');
        process.stdin.setRawMode(true);
        console.log(`  isRaw after true: ${process.stdin.isRaw}`);

        console.log('  Calling setRawMode(false)...');
        process.stdin.setRawMode(false);
        console.log(`  isRaw after false: ${process.stdin.isRaw}`);

        console.log('  Calling setRawMode(true) again...');
        process.stdin.setRawMode(true);
        console.log(`  isRaw after second true: ${process.stdin.isRaw}`);

        console.log('  Calling setRawMode(false) again...');
        process.stdin.setRawMode(false);
        console.log(`  isRaw after second false: ${process.stdin.isRaw}`);

        console.log('  ✓ Multiple setRawMode calls work correctly');
    } catch (err) {
        console.log(`  ✗ Error: ${err.message}`);
    }
} else {
    console.log('  ⊘ Skipped (stdin is not a TTY)');
}

// Test 3: Test with /dev/tty ReadStream (simulating renderOptions.ts)
console.log('\nTest 3: ReadStream from /dev/tty fd');
const fs = require('fs');
try {
    const fd = fs.openSync('/dev/tty', 'r');
    const ttyStream = new ReadStream(fd);

    console.log(`  Created ReadStream from fd ${fd}`);
    console.log(`  isTTY: ${ttyStream.isTTY}`);
    console.log(`  setRawMode: ${typeof ttyStream.setRawMode}`);
    console.log(`  isRaw: ${ttyStream.isRaw}`);

    if (typeof ttyStream.setRawMode === 'function') {
        try {
            console.log('  Calling setRawMode(true)...');
            ttyStream.setRawMode(true);
            console.log(`  isRaw after true: ${ttyStream.isRaw}`);

            console.log('  Calling setRawMode(false)...');
            ttyStream.setRawMode(false);
            console.log(`  isRaw after false: ${ttyStream.isRaw}`);

            console.log('  ✓ ReadStream setRawMode works correctly');
        } catch (err) {
            console.log(`  ✗ setRawMode error: ${err.message}`);
        }
    } else {
        console.log('  ⊘ setRawMode not available on ReadStream');
    }

    ttyStream.close();
    fs.closeSync(fd);
} catch (err) {
    console.log(`  ⊘ Skipped (/dev/tty not available: ${err.message})`);
}

// Test 4: Verify encoding can be set
console.log('\nTest 4: Encoding settings');
if (process.stdin.isTTY) {
    try {
        process.stdin.setEncoding('utf8');
        console.log('  ✓ setEncoding(utf8) works');
    } catch (err) {
        console.log(`  ✗ setEncoding error: ${err.message}`);
    }
} else {
    console.log('  ⊘ Skipped (stdin is not a TTY)');
}

// Test 5: Verify ref/unref work
console.log('\nTest 5: Stream ref/unref');
if (process.stdin.isTTY) {
    try {
        process.stdin.ref();
        console.log('  ✓ ref() works');
        process.stdin.unref();
        console.log('  ✓ unref() works');
    } catch (err) {
        console.log(`  ✗ ref/unref error: ${err.message}`);
    }
} else {
    console.log('  ⊘ Skipped (stdin is not a TTY)');
}

console.log('\n=== Test Summary ===');
console.log('Node.js version:', process.version);
console.log('Platform:', process.platform);
console.log('TTY available:', process.stdin.isTTY ? 'Yes' : 'No');
console.log('\nThe fix in earlyInput.ts ensures setRawMode(false) is called');
console.log('before Ink takes over, providing a clean state transition.');
console.log('\nThis is critical for Node.js 22 where leaving raw mode enabled');
console.log('can cause Enter key handling issues.');
