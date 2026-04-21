#!/usr/bin/env node
// Entry point for ola-cc.
//
// macOS/Linux: spawns the native binary (bun --compile) for performance.
// Windows: runs the JS bundle (cli.js) directly via Node.js to avoid
//          bun-compiled binary crashes on Windows.
// Falls back to cli-wrapper.cjs if postinstall didn't run.

const { spawnSync } = require('child_process')
const { constants } = require('os')
const path = require('path')
const fs = require('fs')

const BINARY_NAME = process.platform === 'win32' ? 'ola-cc.exe' : 'ola-cc'
const BIN_DIR = path.join(__dirname)
const WRAPPER = path.join(__dirname, '..', 'cli-wrapper.cjs')
const CLI_BUNDLE = path.join(__dirname, '..', 'cli.js')

function main() {
  // Windows: run the JS bundle directly via Node.js to avoid bun-compiled
  // binary crashes. The cli.js bundle is a Node.js-compatible ESM bundle
  // that contains the full application.
  if (process.platform === 'win32') {
    try {
      fs.accessSync(CLI_BUNDLE)
      const result = spawnSync('node', [CLI_BUNDLE, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: process.env,
      })
      if (!result.error) {
        if (result.signal) {
          const signum = constants.signals[result.signal] || 0
          process.exit(128 + signum)
        }
        process.exit(result.status || 0)
      }
    } catch (_) {
      // cli.js not found, fall through to wrapper
    }
  }

  // macOS/Linux: try native binary first
  const nativePath = path.join(BIN_DIR, BINARY_NAME)
  try {
    fs.accessSync(nativePath)
    const result = spawnSync(nativePath, process.argv.slice(2), {
      stdio: 'inherit',
      env: process.env,
    })
    if (!result.error) {
      if (result.signal) {
        const signum = constants.signals[result.signal] || 0
        process.exit(128 + signum)
      }
      process.exit(result.status || 0)
    }
  } catch (_) {
    // Native not found, fall through to wrapper
  }

  // Fallback: try cli-wrapper.cjs
  try {
    require(WRAPPER)
    return
  } catch (_) {}

  console.error('Error: ola-cc binary not installed.')
  console.error('Run: node node_modules/@zyzheal/ola-cc/install.cjs')
  process.exit(1)
}

main()
