#!/usr/bin/env node
/**
 * Postinstall script for the wrapper package.
 *
 * Detects the current platform and copies the native binary from the
 * appropriate platform-specific optional dependency package.
 *
 * This is called automatically by npm during `npm install @zyzheal/ola-cc`.
 */

const { existsSync, mkdirSync, cpSync, chmodSync } = require('fs')
const { join } = require('path')

const PACKAGE_NAME = '@zyzheal/ola-cc'

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
// npm installs optionalDependencies inside the package's node_modules directory
// when using global install or certain package managers (pnpm, yarn).
// Check both locations to support all installation modes.
const nodeModulesNested = join(pkgRoot, 'node_modules')  // npm global / pnpm / yarn
const nodeModulesTopLevel = join(pkgRoot, '..', '..')    // npm local (legacy behavior)
const binDir = join(pkgRoot, 'bin')

function detectPlatform() {
  const platform = process.platform
  const arch = process.arch

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

function findPlatformPackage(depName) {
  // Try nested location first (npm global, pnpm, yarn)
  const nestedPath = join(nodeModulesNested, depName)
  if (existsSync(nestedPath)) {
    return nestedPath
  }
  // Try top-level location (npm local install legacy behavior)
  const topLevelPath = join(nodeModulesTopLevel, depName)
  if (existsSync(topLevelPath)) {
    return topLevelPath
  }
  return null
}

function main() {
  const platformKey = detectPlatform()
  const depName = PLATFORM_MAP[platformKey]

  if (!depName) {
    console.warn(`ola-cc: Unsupported platform ${process.platform} ${process.arch}.`)
    return
  }

  const depPath = findPlatformPackage(depName)

  if (!depPath) {
    console.warn(`ola-cc: Platform package ${depName} not installed.`)
    return
  }

  const isWindows = process.platform === 'win32'
  const binaryName = isWindows ? 'ola-cc.exe' : 'ola-cc'
  const srcBinary = join(depPath, binaryName)

  if (!existsSync(srcBinary)) {
    // Fallback: JS bundle mode for platforms without native compilation (e.g. darwin-x64)
    const jsBundle = join(depPath, 'cli.mjs')
    if (existsSync(jsBundle)) {
      mkdirSync(binDir, { recursive: true })
      cpSync(jsBundle, join(binDir, 'cli.mjs'))
      console.log(`ola-cc: Installed JS bundle (cli.mjs) for ${platformKey}`)
      return
    }
    console.warn(`ola-cc: Binary not found at ${srcBinary}`)
    return
  }

  mkdirSync(binDir, { recursive: true })
  const destName = isWindows ? 'ola-cc.exe' : 'ola-cc'
  const destBinary = join(binDir, destName)

  cpSync(srcBinary, destBinary)
  chmodSync(destBinary, 0o755)
  console.log(`ola-cc: Installed native binary for ${platformKey}`)

  // Copy vendor files if present (ripgrep, etc.)
  const srcVendor = join(depPath, 'vendor')
  if (existsSync(srcVendor)) {
    const destVendor = join(pkgRoot, 'vendor')
    try {
      cpSync(srcVendor, destVendor, { recursive: true })
    } catch {
      // Best effort
    }
  }
}

try {
  main()
} catch (err) {
  console.error(`ola-cc postinstall error: ${err.message}`)
  // Don't fail the install
  process.exit(0)
}
