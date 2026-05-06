#!/usr/bin/env bun
/**
 * 二进制分发构建脚本
 *
 * 参照 @anthropic-ai/claude-code 的 npm 分发架构，生成：
 *   1. 主包 wrapper（dist/publish/）— 仅含包装器脚本
 *   2. 平台子包（dist/publish-bin/）— 每个平台一个目录，仅含编译后的二进制
 *
 * 输出结构:
 *   dist/publish/              # 主包（wrapper）
 *   ├── cli-wrapper.cjs        # 降级启动器
 *   ├── install.cjs            # postinstall 脚本
 *   ├── bin/ola-cc.exe         # 占位符
 *   ├── package.json           # wrapper 模式 package.json
 *   ├── sdk-tools.d.ts
 *   ├── README.md
 *   └── LICENSE.md
 *
 *   dist/publish-bin/          # 平台子包目录
 *   ├── darwin-arm64/
 *   │   ├── package.json
 *   │   └── ola-cc             # 编译后的二进制
 *   ├── darwin-x64/
 *   ├── linux-x64/
 *   ├── linux-arm64/
 *   ├── linux-x64-musl/
 *   ├── linux-arm64-musl/
 *   ├── win32-x64/
 *   └── win32-arm64/
 */

import { mkdirSync, cpSync, writeFileSync, chmodSync, existsSync, readFileSync, copyFileSync } from 'fs'
import { join } from 'path'
import { PUBLISH_PACKAGE_NAME, PUBLISH_BASE_NAME } from './publish-config.ts'

const pkg = await Bun.file(join(process.cwd(), 'package.json')).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const onlyWrapper = args.includes('--only-wrapper')
const onlyBin = args.includes('--only-bin')

// ─── Version ───────────────────────────────────────────────
const publishVersion = pkg.version
const packageName = PUBLISH_PACKAGE_NAME

// ─── Platform Definitions ──────────────────────────────────
const PLATFORMS = [
  { key: 'darwin-arm64',   binName: 'ola-cc' },
  { key: 'darwin-x64',     binName: 'ola-cc' },
  { key: 'linux-x64',      binName: 'ola-cc' },
  { key: 'linux-arm64',    binName: 'ola-cc' },
  { key: 'linux-x64-musl', binName: 'ola-cc' },
  { key: 'linux-arm64-musl', binName: 'ola-cc' },
  { key: 'win32-x64',      binName: 'ola-cc.exe' },
  { key: 'win32-arm64',    binName: 'ola-cc.exe' },
]

// ─── Feature Flags (same as build-publish.ts) ─────────────
const defaultFeatures = ['VOICE_MODE', 'BUDDY']
const featureSet = new Set(defaultFeatures)

const fullExperimentalFeatures = [
  'AGENT_MEMORY_SNAPSHOT', 'AGENT_TRIGGERS', 'AGENT_TRIGGERS_REMOTE',
  'AWAY_SUMMARY', 'BASH_CLASSIFIER', 'BRIDGE_MODE',
  'BUILTIN_EXPLORE_PLAN_AGENTS', 'CACHED_MICROCOMPACT', 'CCR_AUTO_CONNECT',
  'CCR_MIRROR', 'CCR_REMOTE_SETUP', 'COMPACTION_REMINDERS', 'CONNECTOR_TEXT',
  'EXTRACT_MEMORIES', 'HISTORY_PICKER', 'HOOK_PROMPTS', 'KAIROS_BRIEF',
  'KAIROS_CHANNELS', 'LODESTONE', 'MCP_RICH_OUTPUT', 'MESSAGE_ACTIONS',
  'NATIVE_CLIPBOARD_IMAGE', 'NEW_INIT', 'POWERSHELL_AUTO_MODE',
  'PROMPT_CACHE_BREAK_DETECTION', 'QUICK_SEARCH', 'SHOT_STATS', 'TEAMMEM',
  'TOKEN_BUDGET', 'TREE_SITTER_BASH', 'TREE_SITTER_BASH_SHADOW',
  'ULTRAPLAN', 'ULTRATHINK', 'UNATTENDED_RETRY', 'VERIFICATION_AGENT',
] as const

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature-set' && args[i + 1]) {
    if (args[i + 1] === 'dev-full') {
      for (const f of fullExperimentalFeatures) featureSet.add(f)
    }
    i += 1; continue
  }
  if (arg === '--feature-set=dev-full') {
    for (const f of fullExperimentalFeatures) featureSet.add(f); continue
  }
  if (arg === '--feature' && args[i + 1]) {
    featureSet.add(args[i + 1]!); i += 1; continue
  }
  if (arg.startsWith('--feature=')) {
    featureSet.add(arg.slice('--feature='.length))
  }
}
const features = [...featureSet]

function detectMusl(): boolean {
  if (process.platform !== 'linux') return false
  const report = typeof process.report?.getReport === 'function'
    ? process.report.getReport()
    : null
  return report != null && report.header?.glibcVersionRuntime === undefined
}

/**
 * 检测 Linux 发行版类型和 glibc 版本
 * 用于确保构建的二进制兼容目标平台
 */
function detectLinuxDistro(): { isRedHat: boolean; isRocky: boolean; isAlma: boolean; isMusl: boolean; glibcVersion: string } {
  if (process.platform !== 'linux') {
    return { isRedHat: false, isRocky: false, isAlma: false, isMusl: false, glibcVersion: '0' }
  }
  
  // 先检测 musl
  const isMusl = detectMusl()
  
  let isRedHat = false
  let isRocky = false
  let isAlma = false
  let glibcVersion = '0'
  
  // 读取 os-release 文件识别发行版
  const osReleasePaths = [
    '/etc/os-release',
    '/usr/lib/os-release',
  ]
  
  for (const relPath of osReleasePaths) {
    try {
      const content = Bun.file(relPath).text()
      const idMatch = content.match(/^ID="?([^"\n]+)"?/m)
      const versionMatch = content.match(/^VERSION_ID="?(\d+)"?/m)
      
      if (idMatch) {
        const id = idMatch[1].toLowerCase()
        isRedHat = id.includes('rhel') || id.includes('redhat') || id.includes('centos')
        isRocky = id === 'rocky'
        isAlma = id === 'alma'
      }
      
      if (versionMatch && (isRedHat || isRocky || isAlma)) {
        const majorVersion = parseInt(versionMatch[1], 10)
        // RHEL/CentOS 8+, Rocky 8+, Alma 8+ 使用 glibc 2.28+
        if (majorVersion >= 8) {
          glibcVersion = '2.28'
        } else if (majorVersion >= 7) {
          glibcVersion = '2.17'
        }
      }
      
      if (isRedHat || isRocky || isAlma) break
    } catch {
      // 文件不存在，继续尝试下一个
    }
  }
  
  // 如果无法从 os-release 获取，尝试通过 glibc 版本直接判断
  if (glibcVersion === '0') {
    try {
      const report = typeof process.report?.getReport === 'function'
        ? process.report.getReport()
        : null
      if (report?.header?.glibcVersionRuntime) {
        glibcVersion = report.header.glibcVersionRuntime
      }
    } catch {}
  }
  
  return { isRedHat, isRocky, isAlma, isMusl, glibcVersion }
}

/**
 * 获取目标平台的最小 glibc 版本要求
 * 这是确保跨平台兼容的关键
 */
function getTargetGlibcVersion(platformKey: string): string {
  // Rock8/AlmaLinux 8 = glibc 2.28, CentOS 7 = glibc 2.17
  // 默认使用较旧的 glibc 版本以确保最大兼容性
  if (platformKey.startsWith('linux-')) {
    // 使用 glibc 2.28 作为所有 Linux 目标的基础
    // 因为它是 RHEL 8/Rocky 8 的标准版本
    return '2.28'
  }
  return '0'
}

// ─── Compile Binary ────────────────────────────────────────
function compileBinary(target?: string): string | null {
  const outfile = join(process.cwd(), 'dist', 'publish', 'ola-cc-temp')
  const buildTime = new Date().toISOString()

  const cmd = [
    'bun', 'build',
    './src/entrypoints/cli.tsx',
    '--target', 'node',
    '--format', 'esm',
    '--outfile', outfile,
    '--minify',
    '--packages', 'bundle',
    '--conditions', 'node',
    '--external', 'bun:*',
    '--compile',
  ]

  const externals = [
    '@anthropic-ai/bedrock-sdk',
    '@anthropic-ai/foundry-sdk',
    '@anthropic-ai/vertex-sdk',
    '@aws-sdk/client-bedrock',
    '@aws-sdk/client-sts',
    '@azure/identity',
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/exporter-logs-otlp-http',
    '@opentelemetry/exporter-logs-otlp-proto',
    '@opentelemetry/exporter-metrics-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-metrics-otlp-proto',
    '@opentelemetry/exporter-prometheus',
    '@opentelemetry/exporter-trace-otlp-grpc',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-trace-otlp-proto',
    'audio-capture-napi',
    'image-processor-napi',
    'modifiers-napi',
    'node-pty',
    'sharp',
    'turndown',
    'url-handler-napi',
  ]

  for (const ext of externals) cmd.push('--external', ext)
  for (const feature of features) cmd.push(`--feature=${feature}`)

  const macros: Record<string, string> = {
    'process.env.USER_TYPE': JSON.stringify('external'),
    'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
    'process.env.CCR_FORCE_BUNDLE': JSON.stringify('true'),
    'MACRO.VERSION': JSON.stringify(publishVersion),
    'MACRO.BUILD_TIME': JSON.stringify(buildTime),
    'MACRO.PACKAGE_URL': JSON.stringify(packageName),
    'MACRO.NATIVE_PACKAGE_URL': 'undefined',
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(
      'This reconstructed source snapshot does not include Anthropic internal issue routing.',
    ),
    'MACRO.VERSION_CHANGELOG': JSON.stringify('https://github.com/zyzheal/ola-cc'),
  }
  for (const [key, value] of Object.entries(macros)) cmd.push('--define', `${key}=${value}`)

  console.log(`[publish-bin] Compiling native binary...`)
  const proc = Bun.spawnSync({ cmd, cwd: process.cwd(), stdout: 'inherit', stderr: 'inherit' })

  if (proc.exitCode !== 0) {
    console.error('[publish-bin] Compilation failed')
    return null
  }

  // bun --compile outputs to the outfile path directly on the current platform
  // On Windows, bun appends .exe automatically
  const currentPlatform = process.platform
  const currentArch = process.arch
  const isMusl = detectMusl()
  const currentKey = currentPlatform === 'linux'
    ? `linux-${currentArch}${isMusl ? '-musl' : ''}`
    : `${currentPlatform}-${currentArch}`

  let binaryPath = outfile
  if (!existsSync(binaryPath)) {
    // Try with .exe extension (Windows)
    binaryPath = outfile + '.exe'
  }
  if (!existsSync(binaryPath)) {
    console.error(`[publish-bin] Compiled binary not found at ${outfile} or ${outfile}.exe`)
    return null
  }

  chmodSync(binaryPath, 0o755)
  const size = Bun.file(binaryPath).size
  console.log(`[publish-bin] Compiled: ${(size / 1024 / 1024).toFixed(2)} MB (${currentKey})`)

  return binaryPath
}

// ─── Build Wrapper Package ─────────────────────────────────
async function buildWrapper() {
  const outDir = './dist/publish'
  mkdirSync(outDir, { recursive: true })
  mkdirSync(join(outDir, 'bin'), { recursive: true })

  // Warn if cli.mjs hasn't been generated yet (requires build-publish.ts first)
  if (!existsSync(join(outDir, 'cli.mjs'))) {
    console.warn('[publish-bin] Warning: cli.mjs not found. Run `bun run build:publish` first for Windows support.')
  }

  // Read wrapper scripts from source files — single source of truth
  const installCjsContent = await Bun.file('./scripts/install.cjs').text()
  const cliWrapperContent = await Bun.file('./scripts/cli-wrapper.cjs').text()

  writeFileSync(join(outDir, 'install.cjs'), installCjsContent)
  chmodSync(join(outDir, 'install.cjs'), 0o644)
  console.log('[publish-bin] install.cjs generated')

  writeFileSync(join(outDir, 'cli-wrapper.cjs'), cliWrapperContent)
  chmodSync(join(outDir, 'cli-wrapper.cjs'), 0o644)
  console.log('[publish-bin] cli-wrapper.cjs generated')

  // Create bin/ola-cc.js — the actual CLI entry point
  // Tries native binary (copied by postinstall) first, falls back to JS bundle from optionalDependencies
  const binJsPath = join(outDir, 'bin', 'ola-cc.js')
  const binJsContent = `#!/usr/bin/env node
'use strict'
var path = require('path')
var fs = require('fs')
var childProcess = require('child_process')
var pkgDir = path.dirname(__dirname)
var binDir = path.join(pkgDir, 'bin')
var nativeBin = process.platform === 'win32' ? path.join(binDir, 'ola-cc.exe') : path.join(binDir, 'ola-cc')
if (fs.existsSync(nativeBin)) {
  try { childProcess.execFileSync(nativeBin, process.argv.slice(2), { stdio: 'inherit' }); process.exit(0) }
  catch (err) { if (err.code !== 'ENOENT') process.exit(err.status || 1) }
}
// Try JS bundle in the same bin directory (for JS bundle platforms like darwin-x64)
var localJs = path.join(binDir, 'cli.mjs')
if (fs.existsSync(localJs)) { childProcess.execFileSync(process.execPath, [localJs].concat(process.argv.slice(2)), { stdio: 'inherit' }); process.exit(0) }
// Fall back to JS bundle from optionalDependencies platform package
try {
  var platKey = process.platform + '-' + process.arch
  var platPkgName = '${packageName}-' + platKey
  var platPkg = require.resolve(platPkgName + '/package.json')
  var platDir = path.dirname(platPkg)
  // Try native binary from platform package first (postinstall may not have run)
  var platBinFile = process.platform === 'win32' ? 'ola-cc.exe' : 'ola-cc'
  var platBin = path.join(platDir, platBinFile)
  if (fs.existsSync(platBin)) { childProcess.execFileSync(platBin, process.argv.slice(2), { stdio: 'inherit' }); process.exit(0) }
  // Then JS bundle
  var js = path.join(platDir, 'cli.mjs')
  if (fs.existsSync(js)) { childProcess.execFileSync(process.execPath, [js].concat(process.argv.slice(2)), { stdio: 'inherit' }); process.exit(0) }
} catch (_) {}
console.error('Error: ola-cc not installed for this platform.')
process.exit(1)
`
  writeFileSync(binJsPath, binJsContent)
  chmodSync(binJsPath, 0o755)
  console.log('[publish-bin] bin/ola-cc.js created')

  // Generate wrapper package.json
  const wrapperPkg = {
    name: packageName,
    version: publishVersion,
    description: 'Ola CC - AI coding assistant in your terminal',
    license: 'SEE LICENSE IN LICENSE.md',
    type: 'commonjs',
    bin: {
      'ola-cc': './bin/ola-cc.js',
    },
    scripts: {
      postinstall: 'node install.cjs',
      prepublishOnly: 'node -e "if (!process.env.AUTHORIZED) { console.error(\'ERROR: Direct publishing is not allowed.\\nPlease see the release workflow documentation to publish this package.\'); process.exit(1); }"',
    },
    repository: {
      type: 'git',
      url: 'https://github.com/zyzheal/ola-cc.git',
    },
    engines: {
      node: '>=18.0.0',
    },
    dependencies: {},
    optionalDependencies: {
      [`${packageName}-darwin-arm64`]: publishVersion,
      [`${packageName}-darwin-x64`]: publishVersion,
      [`${packageName}-linux-x64`]: publishVersion,
      [`${packageName}-linux-arm64`]: publishVersion,
      [`${packageName}-linux-x64-musl`]: publishVersion,
      [`${packageName}-linux-arm64-musl`]: publishVersion,
      [`${packageName}-win32-x64`]: publishVersion,
      [`${packageName}-win32-arm64`]: publishVersion,
    },
    files: [
      'bin/ola-cc.js',
      'install.cjs',
      'cli-wrapper.cjs',
      'sdk-tools.d.ts',
      'README.md',
      'LICENSE.md',
    ],
  }

  writeFileSync(
    join(outDir, 'package.json'),
    JSON.stringify(wrapperPkg, null, 2) + '\n',
  )
  console.log('[publish-bin] Wrapper package.json generated')

  // Copy static files if not already present
  const staticFiles = ['sdk-tools.d.ts', 'README.md', 'LICENSE.md']
  for (const file of staticFiles) {
    const src = join(outDir, file)
    if (!existsSync(src)) {
      // Try to copy from source locations
      try {
        if (file === 'sdk-tools.d.ts') {
          cpSync('sdk-tools.d.ts', src)
        } else if (file === 'README.md') {
          cpSync('scripts/README-publish.md', src)
        } else if (file === 'LICENSE.md') {
          cpSync('LICENSE.md', src)
        }
        console.log(`[publish-bin] ${file} copied`)
      } catch {
        writeFileSync(src, `${file} - placeholder\n`)
        console.log(`[publish-bin] ${file} generated (placeholder)`)
      }
    }
  }

  console.log('[publish-bin] Wrapper package built')
  console.log(`  Output: ${outDir}/`)
  console.log(`  To publish: cd ${outDir} && npm publish`)
}

// ─── Build Platform Binary Packages ────────────────────────
function buildBinPackages() {
  const binOutDir = './dist/publish-bin'
  mkdirSync(binOutDir, { recursive: true })

  // Allow platform override for cross-compilation (e.g. darwin-x64 on darwin-arm64 runner)
  const currentPlatform = process.env.BUILD_PUBLISH_BIN_PLATFORM || process.platform
  const currentArch = process.env.BUILD_PUBLISH_BIN_ARCH || process.arch
  const isMusl = detectMusl()
  const currentKey = currentPlatform === 'linux'
    ? `linux-${currentArch}${isMusl ? '-musl' : ''}`
    : `${currentPlatform}-${currentArch}`

  // Only build the current platform's package (cross-compilation not supported)
  const currentPlatformInfo = PLATFORMS.find(p => p.key === currentKey)
  if (!currentPlatformInfo) {
    console.error(`[publish-bin] Unsupported platform: ${currentKey}`)
    return
  }

  const platformDir = join(binOutDir, currentKey)
  mkdirSync(platformDir, { recursive: true })

  // macOS x64: use JS bundle (cross-compilation not supported by bun --compile)
  // All other platforms: compile native binary
  const isMacOSX64 = currentPlatform === 'darwin' && currentArch === 'x64'

  if (isMacOSX64) {
    buildJsPackage(platformDir, currentKey, currentArch, currentPlatform)
  } else {
    // macOS arm64/Linux/Windows: compile native binary
    const compiledBinary = compileBinary()
    if (!compiledBinary) {
      console.error('[publish-bin] Failed to compile binary, skipping platform packages')
      return
    }

    // Copy compiled binary
    const destBinary = join(platformDir, currentPlatformInfo.binName)
    copyFileSync(compiledBinary, destBinary)
    chmodSync(destBinary, 0o755)

    // Copy platform-specific ripgrep binary
    // The compiled binary uses builtin mode (not embedded), so it needs rg from vendor/
    const rgVendorSrc = join(process.cwd(), 'src', 'utils', 'vendor', 'ripgrep')
    const rgPlatformDir = currentPlatform === 'linux'
      ? `${currentArch}-${currentPlatform}${isMusl ? '-musl' : ''}`
      : `${currentArch}-${currentPlatform}`

    // Map to vendor directory naming convention
    // vendor/ripgrep uses: arm64-darwin, x64-darwin, x64-win32
    // but linux musl uses: aarch64-unknown-linux-gnu, x86_64-unknown-linux-musl
    const rgVendorMap: Record<string, string> = {
      'arm64-darwin': 'arm64-darwin',
      'x64-darwin': 'x64-darwin',
      'arm64-linux': 'aarch64-unknown-linux-gnu',
      'x64-linux': 'x64-linux-gnu', // fallback, may not exist
      'arm64-linux-musl': 'aarch64-unknown-linux-gnu', // same gnu binary works
      'x64-linux-musl': 'x86_64-unknown-linux-musl',
      'arm64-win32': 'arm64-win32', // hypothetical
      'x64-win32': 'x64-win32',
    }
    const rgDirName = rgVendorMap[rgPlatformDir] || rgPlatformDir
    const rgSrcDir = join(rgVendorSrc, rgDirName)

    if (existsSync(rgSrcDir)) {
      const rgDestDir = join(platformDir, 'vendor', 'ripgrep', rgDirName)
      mkdirSync(rgDestDir, { recursive: true })

      const rgBinName = currentPlatform === 'win32' ? 'rg.exe' : 'rg'
      const rgSrcBin = join(rgSrcDir, rgBinName)
      const rgDestBin = join(rgDestDir, rgBinName)

      if (existsSync(rgSrcBin)) {
        copyFileSync(rgSrcBin, rgDestBin)
        chmodSync(rgDestBin, 0o755)
        console.log(`[publish-bin] Copied ripgrep: ${rgDirName}/${rgBinName}`)
      } else {
        console.warn(`[publish-bin] Warning: ripgrep binary not found at ${rgSrcBin}`)
      }
    } else {
      console.warn(`[publish-bin] Warning: ripgrep vendor dir not found: ${rgSrcDir}`)
    }

    // Generate platform package.json
    const platformPkg = {
      name: `${packageName}-${currentKey}`,
      version: publishVersion,
      description: `Ola CC native binary for ${currentKey}`,
      license: 'SEE LICENSE IN LICENSE.md',
      os: [currentPlatform],
      cpu: [currentArch],
      files: [
        currentPlatformInfo.binName,
        'vendor/', // include ripgrep
      ],
    }

    // Fix os/cpu fields for musl
    if (currentKey.includes('musl')) {
      platformPkg.os = ['linux']
      platformPkg.cpu = [currentKey.includes('x64') ? 'x64' : 'arm64']
      platformPkg.libc = ['musl']
    }

    writeFileSync(
      join(platformDir, 'package.json'),
      JSON.stringify(platformPkg, null, 2) + '\n',
    )

    const binSize = Bun.file(destBinary).size
    console.log(`[publish-bin] Platform package: ${currentKey}`)
    console.log(`  Output: ${platformDir}/`)
    console.log(`  Binary: ${(binSize / 1024 / 1024).toFixed(2)} MB`)
    console.log(`  To publish: cd ${platformDir} && npm publish`)
  }

  // Generate helper script for building all platforms
  generateBuildAllsScript()
}

// ─── JS Bundle Package (for platforms without native compilation) ─────
function buildJsPackage(platformDir: string, currentKey: string, currentArch: string, plat: string) {
  const cliBundleSrc = join(process.cwd(), 'dist', 'publish', 'cli.mjs')

  if (!existsSync(cliBundleSrc)) {
    console.error('[publish-bin] cli.mjs not found. Run `bun run build:publish` first.')
    return
  }

  const cliBundleDest = join(platformDir, 'cli.mjs')
  copyFileSync(cliBundleSrc, cliBundleDest)
  const bundleSize = Bun.file(cliBundleDest).size
  console.log(`[publish-bin] JS bundle (${currentKey}): ${(bundleSize / 1024 / 1024).toFixed(2)} MB`)

  const osName = plat === 'darwin' ? 'darwin' : plat === 'win32' ? 'win32' : 'linux'
  const platformPkg = {
    name: `${packageName}-${currentKey}`,
    version: publishVersion,
    description: `Ola CC (Node.js bundle) for ${currentKey}`,
    license: 'SEE LICENSE IN LICENSE.md',
    os: [osName],
    cpu: [currentArch],
    bin: {
      'ola-cc': './cli.mjs',
    },
    files: [
      'cli.mjs',
    ],
  }

  writeFileSync(
    join(platformDir, 'package.json'),
    JSON.stringify(platformPkg, null, 2) + '\n',
  )

  console.log(`[publish-bin] Platform package: ${currentKey} (JS bundle)`)
  console.log(`  Output: ${platformDir}/`)
  console.log(`  To publish: cd ${platformDir} && npm publish`)
}

function generateBuildAllsScript() {
  const binOutDir = './dist/publish-bin'
  const script = `#!/bin/bash
# Build all platform binary packages
# Run this on each target platform (or CI matrix) to compile binaries

set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Ola CC Binary Distribution Builder ==="
echo ""

# Build the current platform's binary package
cd "$ROOT_DIR"
bun run ./scripts/build-publish-bin.ts --only-bin

echo ""
echo "=== Build Complete ==="
echo ""
echo "Publish all packages:"
echo "  npm publish dist/publish/"
echo "  npm publish dist/publish-bin/darwin-arm64/"
echo "  npm publish dist/publish-bin/darwin-x64/"
echo "  npm publish dist/publish-bin/linux-x64/"
echo "  npm publish dist/publish-bin/linux-arm64/"
echo "  npm publish dist/publish-bin/linux-x64-musl/"
echo "  npm publish dist/publish-bin/linux-arm64-musl/"
echo "  npm publish dist/publish-bin/win32-x64/"
echo "  npm publish dist/publish-bin/win32-arm64/"
`

  writeFileSync(join(binOutDir, 'build-all.sh'), script)
  chmodSync(join(binOutDir, 'build-all.sh'), 0o755)
  console.log('[publish-bin] build-all.sh generated')
}

// ─── Main ──────────────────────────────────────────────────
if (onlyWrapper) {
  await buildWrapper()
} else if (onlyBin) {
  buildBinPackages()
} else {
  console.log('[publish-bin] Building binary distribution...')
  console.log('')

  // Step 1: Build wrapper package
  await buildWrapper()
  console.log('')

  // Step 2: Build platform binary packages
  buildBinPackages()

  console.log('')
  console.log('=== Binary Distribution Build Complete ===')
  console.log('')
  console.log('Wrapper package:  dist/publish/')
  console.log('Binary packages:  dist/publish-bin/')
  console.log('')
  console.log('To publish wrapper:')
  console.log('  cd dist/publish && npm publish')
  console.log('')
  console.log('To publish binary packages:')
  console.log('  cd dist/publish-bin/<platform> && npm publish')
  console.log('')
  console.log('Note: Build binary packages on each target platform for native compilation.')
}
