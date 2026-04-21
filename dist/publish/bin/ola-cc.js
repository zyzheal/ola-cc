#!/usr/bin/env node
// Entry point for ola-cc. Detects the native binary and spawns it.
// Falls back to cli-wrapper.cjs if postinstall didn't run.

const { spawnSync } = require('child_process')
const { constants } = require('os')
const path = require('path')

const BINARY_NAME = process.platform === 'win32' ? 'ola-cc.exe' : 'ola-cc'
const BIN_DIR = path.join(__dirname)
const WRAPPER = path.join(__dirname, '..', 'cli-wrapper.cjs')

function main() {
  // Try native binary first
  const nativePath = path.join(BIN_DIR, BINARY_NAME)
  try {
    require('fs').accessSync(nativePath)
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

  // Try cli-wrapper.cjs
  try {
    require(WRAPPER)
    return
  } catch (_) {}

  console.error('Error: ola-cc native binary not installed.')
  console.error('Run: node node_modules/@zyzheal/ola-cc/install.cjs')
  process.exit(1)
}

main()
