#!/usr/bin/env bun
/**
 * 发布构建脚本
 *
 * 输出结构:
 *   dist/publish/
 *   ├── cli.js              # JS bundle (~10MB, 跨平台)
 *   ├── package.json        # 干净的发布用 package.json
 *   ├── README.md           # 使用文档 + 配置示例
 *   ├── LICENSE.md
 *   ├── sdk-tools.d.ts      # TypeScript 类型定义
 *   └── vendor/             # 可选原生依赖 (.node 文件)
 */

import { mkdirSync, cpSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const compile = args.includes('--compile')
const dev = args.includes('--dev')
const publish = args.includes('--publish')
const binaryMode = args.includes('--binary')

// Binary distribution mode: redirect to build-publish-bin.ts
if (binaryMode) {
  console.log('[publish] Redirecting to binary build mode...')
  const result = Bun.spawnSync({
    cmd: ['bun', 'run', './scripts/build-publish-bin.ts', ...args.filter(a => a !== '--binary')],
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(result.exitCode ?? 1)
}

// ─── Feature Flags ───────────────────────────────────────────
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

// ─── Output Directory ────────────────────────────────────────
const outDir = './dist/publish'
mkdirSync(outDir, { recursive: true })
mkdirSync(join(outDir, 'vendor'), { recursive: true })

// ─── Externals (optional native/SDK deps, NOT bundled) ──────
const externals = [
  // SDK providers (optional)
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/vertex-sdk',
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-sts',
  '@azure/identity',
  // OTLP exporters (optional, for observability)
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
  // Native addons (optional, platform-specific)
  'audio-capture-napi',
  'image-processor-napi',
  'modifiers-napi',
  'node-pty',
  'sharp',
  'turndown',
  'url-handler-napi',
  // Don't externalize common dependencies - bundle them
  // 'ws' - should be bundled
]

// ─── Build JS Bundle ────────────────────────────────────────
const publishVersion = pkg.version
const outfile = join(outDir, 'cli.js')
const buildTime = new Date().toISOString()
const version = publishVersion

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
]

for (const ext of externals) cmd.push('--external', ext)
for (const feature of features) cmd.push(`--feature=${feature}`)

// Define macros
const defines: Record<string, string> = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  'process.env.CCR_FORCE_BUNDLE': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'This reconstructed source snapshot does not include Anthropic internal issue routing.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify('https://github.com/anthropics/claude-code'),
}
for (const [key, value] of Object.entries(defines)) cmd.push('--define', `${key}=${value}`)

console.log(`[publish-build] Building JS bundle with ${features.length} features...`)
const proc = Bun.spawnSync({ cmd, cwd: process.cwd(), stdout: 'inherit', stderr: 'inherit' })

if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1)

// Add shebang and bun:* polyfill for Node.js compatibility
let cliContent = await Bun.file(outfile).text()

// Inject bun:bundle polyfill for feature() function
// This provides a stub that returns false for all feature checks in Node.js runtime
const bunPolyfill = `// Bun bundle feature polyfill for Node.js
const __BUN_FEATURE_FALLBACK__ = () => false;
globalThis.feature = globalThis.feature || __BUN_FEATURE_FALLBACK__;
`

// Prepend polyfill and shebang (shebang must be first line)
cliContent = '#!/usr/bin/env node\n' + bunPolyfill + cliContent

// Remove any duplicate shebang from original content
cliContent = cliContent.replace(/(#!\/usr\/bin\/env node\r?\n)(#!\/usr\/bin\/env node\r?\n)/, '$1')

await Bun.write(outfile, cliContent)

const size = Bun.file(outfile).size
console.log(`[publish-build] cli.js: ${(size / 1024 / 1024).toFixed(2)} MB`)

// ─── Generate publish package.json ──────────────────────────
const publishPkg = {
  name: '@zyzheal/ola-cc',
  version: publishVersion,
  description: 'Claude Code - AI coding assistant in your terminal',
  license: 'SEE LICENSE IN LICENSE.md',
  type: 'module',
  bin: {
    'ola-cc': './cli.js',
  },
  repository: {
    type: 'git',
    url: 'https://github.com/zyzheal/ola-cc.git',
  },
  engines: {
    bun: '>=1.3.5',
    node: '>=18.0.0',
  },
  dependencies: {
    'ws': '^8.18.0',
  },
  optionalDependencies: {
    sharp: '*',
  },
  files: [
    'cli.js',
    'sdk-tools.d.ts',
    'vendor/',
    'README.md',
    'LICENSE.md',
  ],
}

writeFileSync(
  join(outDir, 'package.json'),
  JSON.stringify(publishPkg, null, 2) + '\n',
)
console.log('[publish-build] package.json generated')

// ─── Copy static files ──────────────────────────────────────
// README.md (from scripts/README-publish.md)
try {
  cpSync('scripts/README-publish.md', join(outDir, 'README.md'))
  console.log('[publish-build] README.md generated')
} catch {
  console.warn('[publish-build] README-publish.md not found, skipping')
}

// LICENSE.md
try {
  cpSync('LICENSE.md', join(outDir, 'LICENSE.md'))
  console.log('[publish-build] LICENSE.md copied')
} catch {
  writeFileSync(join(outDir, 'LICENSE.md'), 'MIT License - See project LICENSE for details\n')
  console.log('[publish-build] LICENSE.md generated (placeholder)')
}

// sdk-tools.d.ts
try {
  cpSync('sdk-tools.d.ts', join(outDir, 'sdk-tools.d.ts'))
  console.log('[publish-build] sdk-tools.d.ts copied')
} catch {
  writeFileSync(join(outDir, 'sdk-tools.d.ts'), '// Type definitions for Claude Code SDK tools\n')
  console.log('[publish-build] sdk-tools.d.ts generated (placeholder)')
}

// ─── Copy vendor files ─────────────────────────────────────
let vendorCount = 0

// 1. ripgrep binaries (multi-platform) — runtime loads from
//    vendor/ripgrep/{arch-platform}/rg  (see src/utils/ripgrep.ts:58-62)
const ripgrepDir = 'src/utils/vendor/ripgrep'
try {
  const destRipgrepDir = join(outDir, 'vendor', 'ripgrep')
  mkdirSync(destRipgrepDir, { recursive: true })
  const platforms = Bun.spawnSync({ cmd: ['ls', ripgrepDir], stdout: 'pipe' }).stdout.toString().trim().split('\n').filter(Boolean)
  for (const platform of platforms) {
    const srcPlatform = join(ripgrepDir, platform)
    const destPlatform = join(destRipgrepDir, platform)
    mkdirSync(destPlatform, { recursive: true })
    const files = Bun.spawnSync({ cmd: ['ls', srcPlatform], stdout: 'pipe' }).stdout.toString().trim().split('\n').filter(Boolean)
    // Only copy the rg binary (or rg.exe on Windows)
    const rgFile = files.find(f => f === 'rg' || f === 'rg.exe')
    if (rgFile) {
      cpSync(join(srcPlatform, rgFile), join(destPlatform, rgFile))
      vendorCount++
      console.log(`[publish-build] vendor/ripgrep/${platform}/${rgFile}`)
    }
  }
} catch {
  console.warn('[publish-build] ripgrep not found, skipping')
}

// 2. Seccomp filter files (Linux sandbox) — arm64 + x64
//    Used by @anthropic-ai/sandbox-runtime for Linux container security.
//    Runtime reads from vendor/seccomp/{arch}/apply-seccomp + unix-block.bpf
const seccompDir = 'node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp'
try {
  const destSeccompDir = join(outDir, 'vendor', 'seccomp')
  mkdirSync(destSeccompDir, { recursive: true })
  const seccompArchs = Bun.spawnSync({ cmd: ['ls', seccompDir], stdout: 'pipe' }).stdout.toString().trim().split('\n').filter(Boolean)
  for (const arch of seccompArchs) {
    const srcArch = join(seccompDir, arch)
    const destArch = join(destSeccompDir, arch)
    mkdirSync(destArch, { recursive: true })
    const files = Bun.spawnSync({ cmd: ['ls', srcArch], stdout: 'pipe' }).stdout.toString().trim().split('\n').filter(Boolean)
    for (const f of files) {
      cpSync(join(srcArch, f), join(destArch, f))
      vendorCount++
      console.log(`[publish-build] vendor/seccomp/${arch}/${f}`)
    }
  }
} catch {
  console.warn('[publish-build] seccomp files not found, skipping')
}

// 3. Native addons (.node files) — flatten to vendor/ root
const seenFiles = new Set<string>()
const vendorSearchDirs = ['shims', 'node_modules']
for (const dir of vendorSearchDirs) {
  try {
    const entries = Bun.spawnSync({ cmd: ['find', dir, '-name', '*.node'], stdout: 'pipe' })
    if (entries.exitCode === 0) {
      const files = new TextDecoder().decode(entries.stdout).trim().split('\n').filter(Boolean)
      for (const f of files) {
        const baseName = f.split('/').pop()!
        if (seenFiles.has(baseName)) continue
        seenFiles.add(baseName)
        const dest = join(outDir, 'vendor', baseName)
        cpSync(f, dest)
        vendorCount++
        console.log(`[publish-build] vendor/${baseName}`)
      }
    }
  } catch { /* skip */ }
}

// ─── Summary ────────────────────────────────────────────────
console.log('')
console.log('=== Publish Package ===')
console.log(`Output: ${outDir}/`)
console.log(`cli.js: ${(size / 1024 / 1024).toFixed(2)} MB`)
console.log(`Features: ${features.length}`)
console.log(`Vendor files: ${vendorCount}`)
console.log('')
console.log('To publish:')
console.log(`  cd ${outDir}`)
console.log('  npm publish --dry-run    # 预览')
console.log('  npm publish              # 发布')
