#!/usr/bin/env node
// Entry point for ola-cc.
//
// Windows: tries compiled ola-cc.exe (pkg) first, falls back to JS bundle (cli.mjs)
//          via Node.js if .exe is not available.
// macOS/Linux: spawns the native binary (bun --compile) for performance.
// Falls back to cli-wrapper.cjs if postinstall didn't run.

const { spawnSync } = require('child_process')
const { constants } = require('os')
const path = require('path')
const fs = require('fs')

const BINARY_NAME = process.platform === 'win32' ? 'ola-cc.exe' : 'ola-cc'
const BIN_DIR = path.join(__dirname)
const WRAPPER = path.join(__dirname, '..', 'cli-wrapper.cjs')
const CLI_BUNDLE = path.join(__dirname, '..', 'cli.mjs')

function main() {
  // Windows: try compiled .exe first, then JS bundle fallback
  if (process.platform === 'win32') {
    const exePath = path.join(BIN_DIR, 'ola-cc.exe')
    try {
      fs.accessSync(exePath)
      const result = spawnSync(exePath, process.argv.slice(2), {
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
      // .exe not found, fall through to JS bundle
    }

    // JS bundle fallback
    try {
      fs.accessSync(CLI_BUNDLE)
      const result = spawnSync('node', [CLI_BUNDLE, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: process.env,
      })
      if (result.error) {
        console.error(`Error: Failed to start Node.js: ${result.error.message}`)
        console.error('Ensure Node.js is installed and in your PATH.')
        process.exit(1)
      }
      if (result.signal) {
        const signum = constants.signals[result.signal] || 0
        process.exit(128 + signum)
      }
      process.exit(result.status || 0)
    } catch (_) {
      // cli.mjs not found, fall through to wrapper
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
