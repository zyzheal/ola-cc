#!/usr/bin/env node
/**
 * Postinstall script for the wrapper package.
 *
 * Detects the current platform and copies the native binary from the
 * appropriate platform-specific optional dependency package.
 *
 * This is called automatically by npm during `npm install @zyzheal/ola-cc`.
 */

const { existsSync, mkdirSync, cpSync, chmodSync, readFileSync } = require('fs')
const { join, dirname } = require('path')

const PACKAGE_NAME = '@zyzheal/ola-cc'

// Platform mapping matching the optionalDependencies in package.json
const PLATFORM_MAP = {
  'darwin-arm64': `${PACKAGE_NAME}-darwin-arm64`,
  'darwin-x64': `${PACKAGE_NAME}-darwin-x64`,
  'linux-x64': `${PACKAGE_NAME}-linux-x64`,
  'linux-arm64': `${PACKAGE_NAME}-linux-arm64`,
  'linux-x64-musl': `${PACKAGE_NAME}-linux-x64-musl`,
  'linux-arm64-musl': `${PACKAGE_NAME}-linux-arm64-musl`,
  'win32-x64': `${PACKAGE_NAME}-win32-x64`,
  'win32-arm64': `${PACKAGE_NAME}-win32-arm64`,
}

const pkgRoot = __dirname
const nodeModules = join(pkgRoot, '..', '..')  // resolve up to node_modules/ root
const binDir = join(pkgRoot, 'bin')

function detectPlatform() {
  const platform = process.platform
  const arch = process.arch

  // Detect musl libc on Linux
  let isMusl = false
  if (platform === 'linux') {
    try {
      const report = typeof process.report?.getReport === 'function'
        ? process.report.getReport()
        : null
      isMusl = report != null && report.header?.glibcVersionRuntime === undefined
    } catch {
      try {
        const ldd = require('child_process').execSync('ldd --version 2>&1', { encoding: 'utf8' })
        isMusl = ldd.toLowerCase().includes('musl')
      } catch {
        // Assume glibc if we can't determine
      }
    }
  }

  return platform === 'linux'
    ? `${platform}-${arch}${isMusl ? '-musl' : ''}`
    : `${platform}-${arch}`
}

function main() {
  // Determine binary name - platform packages store binary at root level
  // Windows packages may have .exe extension, others don't
  const platformKey = detectPlatform()
  const depName = PLATFORM_MAP[platformKey]

  // Binary name based on platform - hardcode for reliability
  const isWindows = process.platform === 'win32'
  const binaryName = isWindows ? 'ola-cc.exe' : 'ola-cc'

  if (!depName) {
    console.error(`Warning: Unsupported platform ${process.platform} ${process.arch}.`)
    console.error('ola-cc requires a native binary for your platform.')
    return
  }

  const depPath = join(nodeModules, depName)

  if (!existsSync(depPath)) {
    console.error(`Warning: Platform package ${depName} not installed.`)
    console.error(`Run: npm install ${depName}`)
    return
  }

  // Binary is at the root of the platform package
  const srcBinary = join(depPath, binaryName)
  if (!existsSync(srcBinary)) {
    // Fallback: try cli.mjs for JS bundle fallback (Windows)
    const jsBundle = join(depPath, 'cli.mjs')
    if (existsSync(jsBundle)) {
      const destName = 'ola-cc.js'
      const destBinary = join(binDir, destName)
      try {
        cpSync(jsBundle, destBinary)
        console.log(`ola-cc: Installed JS bundle for ${platformKey}`)
      } catch (err) {
        console.error(`ola-cc: Failed to install JS bundle: ${err.message}`)
      }
      return
    }
    console.error(`Warning: Binary not found at ${srcBinary}`)
    return
  }

  // Create bin directory
  mkdirSync(binDir, { recursive: true })

  // Copy binary
  const destName = process.platform === 'win32' ? 'ola-cc.exe' : 'ola-cc'
  const destBinary = join(binDir, destName)

  try {
    cpSync(srcBinary, destBinary)
    chmodSync(destBinary, 0o755)
    console.log(`ola-cc: Installed native binary for ${platformKey}`)
  } catch (err) {
    console.error(`ola-cc: Failed to install binary: ${err.message}`)
  }

  // Copy vendor files if present (ripgrep, etc.)
  const srcVendor = join(depPath, 'vendor')
  if (existsSync(srcVendor)) {
    const destVendor = join(pkgRoot, 'vendor')
    try {
      mkdirSync(destVendor, { recursive: true })
      cpSync(srcVendor, destVendor, { recursive: true })
    } catch {
      // Best effort
    }
  }
}

// Run with error handling
try {
  main()
} catch (err) {
  console.error(`ola-cc postinstall error: ${err.message}`)
  // Don't fail the install
  process.exit(0)
}
