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

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const onlyWrapper = args.includes('--only-wrapper')
const onlyBin = args.includes('--only-bin')

// ─── Version ───────────────────────────────────────────────
const publishVersion = pkg.version
const packageName = '@zyzheal/ola-cc'

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

  const defines: Record<string, string> = {
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
  for (const [key, value] of Object.entries(defines)) cmd.push('--define', `${key}=${value}`)

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
function buildWrapper() {
  const outDir = './dist/publish'
  mkdirSync(outDir, { recursive: true })
  mkdirSync(join(outDir, 'bin'), { recursive: true })

  // Copy wrapper scripts
  const wrapperDir = new URL('.', import.meta.url).pathname
  // cli-wrapper.cjs and install.cjs are in dist/publish already, copy from there
  const srcWrapperDir = join(process.cwd(), 'dist', 'publish')

  // Create placeholder bin
  const placeholderBin = join(outDir, 'bin', 'ola-cc.exe')
  if (!existsSync(placeholderBin)) {
    writeFileSync(placeholderBin, `#!/bin/sh\necho "Error: ola-cc native binary not installed."\necho "Run the postinstall script: node install.cjs"\nexit 1\n`)
    chmodSync(placeholderBin, 0o755)
  }

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
      prepare: 'node -e "if (!process.env.AUTHORIZED) { console.error(\'ERROR: Direct publishing is not allowed.\\nPlease see the release workflow documentation to publish this package.\'); process.exit(1); }"',
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
      'bin/ola-cc.exe',
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

  // Compile binary for current platform (this is what we can build locally)
  const compiledBinary = compileBinary()
  if (!compiledBinary) {
    console.error('[publish-bin] Failed to compile binary, skipping platform packages')
    return
  }

  // Determine current platform key
  const currentPlatform = process.platform
  const currentArch = process.arch
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

  // Copy compiled binary
  const destBinary = join(platformDir, currentPlatformInfo.binName)
  copyFileSync(compiledBinary, destBinary)
  chmodSync(destBinary, 0o755)

  // Generate platform package.json
  const platformPkg = {
    name: `${packageName}-${currentKey}`,
    version: publishVersion,
    description: `Ola CC native binary for ${currentKey}`,
    license: 'SEE LICENSE IN LICENSE.md',
    os: [currentPlatform === 'linux-x64-musl' || currentPlatform === 'linux-arm64-musl' ? 'linux' : currentPlatform],
    cpu: [currentArch === 'x64-musl' || currentArch === 'arm64-musl'
      ? currentArch.split('-')[0]
      : currentArch],
    files: [
      currentPlatformInfo.binName,
    ],
  }

  // Fix os/cpu fields for musl
  if (currentKey.includes('musl')) {
    platformPkg.os = ['linux']
    platformPkg.cpu = [currentKey.includes('x64') ? 'x64' : 'arm64']
    platformPkg.libc = ['musl']
  } else {
    platformPkg.os = [currentPlatform]
    platformPkg.cpu = [currentArch]
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

  // Generate helper script for building all platforms
  generateBuildAllsScript()
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
  buildWrapper()
} else if (onlyBin) {
  buildBinPackages()
} else {
  console.log('[publish-bin] Building binary distribution...')
  console.log('')

  // Step 1: Build wrapper package
  buildWrapper()
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
