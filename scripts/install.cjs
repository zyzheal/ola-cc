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
  let isRedHatCompatible = false

  if (platform === 'linux') {
    try {
      const report = typeof process.report?.getReport === 'function'
        ? process.report.getReport()
        : null
      isMusl = report != null && report.header?.glibcVersionRuntime === undefined
    } catch {
      try {
        const ldd = require('child_process').execSync('ldd --version 2>&1', { encoding: 'utf8' })
        const lddLower = ldd.toLowerCase()
        isMusl = lddLower.includes('musl')
        // 检测 glibc 版本 - RHEL/Rocky/AlmaLinux 8+ 使用 glibc 2.28
        // CentOS 7 使用 glibc 2.17
        const glibcMatch = ldd.match(/glibc(?:64)?\s+(\d+)\.(\d+)/)
        if (glibcMatch) {
          const major = parseInt(glibcMatch[1], 10)
          const minor = parseInt(glibcMatch[2], 10)
          // glibc 2.28+ (RHEL 8+, Rocky 8+, AlmaLinux 8+)
          isRedHatCompatible = major > 2 || (major === 2 && minor >= 28)
        }
      } catch {
        // Assume glibc if we can't determine
      }
    }

    // 尝试读取 /etc/os-release 获取更精确的发行版信息
    try {
      const osRelease = require('fs').readFileSync('/etc/os-release', 'utf8')
      const idMatch = osRelease.match(/^ID="?([^"\n]+)"?/m)
      if (idMatch) {
        const id = idMatch[1].toLowerCase()
        // Rocky Linux, AlmaLinux, RHEL, CentOS Stream 都使用 glibc 2.28+ (version 8+)
        if (id === 'rocky' || id === 'alma' || id === 'rhel' || id === 'centos') {
          const versionMatch = osRelease.match(/^VERSION_ID="?(\d+)"?/m)
          if (versionMatch) {
            const majorVersion = parseInt(versionMatch[1], 10)
            if (majorVersion >= 8) {
              isRedHatCompatible = true
            }
          }
        }
      }
    } catch {
      // 无法读取 os-release
    }
  }

  // 对于 Red Hat 兼容系统 (Rock8, Alma8, RHEL 8+) 使用标准 glibc 版本
  // 而不是 musl 版本
  if (platform === 'linux' && isRedHatCompatible && !isMusl) {
    return `${platform}-${arch}`
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
