import { chmodSync, existsSync, mkdirSync, rmSync } from 'fs'
import { dirname } from 'path'

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const compile = args.includes('--compile')
const dev = args.includes('--dev')
const publish = args.includes('--publish')

const fullExperimentalFeatures = [
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'AWAY_SUMMARY',
  'BASH_CLASSIFIER',
  'BRIDGE_MODE',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'CACHED_MICROCOMPACT',
  'CCR_AUTO_CONNECT',
  'CCR_MIRROR',
  'CCR_REMOTE_SETUP',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'EXTRACT_MEMORIES',
  'HISTORY_PICKER',
  'HOOK_PROMPTS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'LODESTONE',
  'MCP_RICH_OUTPUT',
  'MESSAGE_ACTIONS',
  'NATIVE_CLIPBOARD_IMAGE',
  'NEW_INIT',
  'POWERSHELL_AUTO_MODE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'QUICK_SEARCH',
  'SHOT_STATS',
  'TEAMMEM',
  'TOKEN_BUDGET',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
  'ULTRAPLAN',
  'ULTRATHINK',
  'UNATTENDED_RETRY',
  'VERIFICATION_AGENT',
  'VOICE_MODE',
] as const

function runCommand(cmd: string[]): string | null {
  const proc = Bun.spawnSync({
    cmd,
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    return null
  }

  return new TextDecoder().decode(proc.stdout).trim() || null
}

function getDevVersion(baseVersion: string): string {
  const timestamp = new Date().toISOString()
  const date = timestamp.slice(0, 10).replaceAll('-', '')
  const time = timestamp.slice(11, 19).replaceAll(':', '')
  const sha = runCommand(['git', 'rev-parse', '--short=8', 'HEAD']) ?? 'unknown'
  return `${baseVersion}-dev.${date}.t${time}.sha${sha}`
}

function getVersionChangelog(): string {
  return (
    runCommand(['git', 'log', '--format=%h %s', '-20']) ??
    'Local development build'
  )
}

const defaultFeatures = [
  // Core features
  'VOICE_MODE',
  'BUDDY',
  'AGENT_TRIGGERS',
  // Prompt & UX improvements (all 100% implemented)
  'QUICK_SEARCH',       // Global ripgrep search + FuzzyPicker
  'MESSAGE_ACTIONS',    // Message edit/copy/expand/collapse toolbar
  'HOOK_PROMPTS',       // Hook prompt injection in REPL
  'NEW_INIT',           // 8-stage initialization flow
  'TOKEN_BUDGET',       // Token budget tracking + progress bar
  'ULTRATHINK',         // Deep thinking mode + keyword detection
  // Security & reliability
  'TREE_SITTER_BASH',   // tree-sitter AST parsing of bash commands
  'BASH_CLASSIFIER',    // AI classification of bash command safety
  'POWERSHELL_AUTO_MODE', // PowerShell auto-mode support
  'UNATTENDED_RETRY',   // Unattended retry with exponential backoff
  // Collaboration & remote
  'LODESTONE',          // Deep link URI handling (10+ terminals)
  'COMPACTION_REMINDERS', // Context compaction reminders
  'SHOT_STATS',         // API retry distribution stats
  // Memory & context (require OAuth backend)
  'EXTRACT_MEMORIES',   // Auto memory extraction (forked agent)
  'TEAMMEM',            // Team memory sync system
]
const featureSet = new Set(defaultFeatures)
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature-set' && args[i + 1]) {
    if (args[i + 1] === 'dev-full') {
      for (const feature of fullExperimentalFeatures) {
        featureSet.add(feature)
      }
    }
    i += 1
    continue
  }
  if (arg === '--feature-set=dev-full') {
    for (const feature of fullExperimentalFeatures) {
      featureSet.add(feature)
    }
    continue
  }
  if (arg === '--feature' && args[i + 1]) {
    featureSet.add(args[i + 1]!)
    i += 1
    continue
  }
  if (arg.startsWith('--feature=')) {
    featureSet.add(arg.slice('--feature='.length))
  }
}
const features = [...featureSet]

const outfile = publish
  ? './dist/publish/cli.mjs'
  : compile
    ? dev
      ? './dist/cli-dev'
      : './dist/cli'
    : dev
      ? './cli-dev'
      : './cli'
const buildTime = new Date().toISOString()
const version = dev ? getDevVersion(pkg.version) : pkg.version

// Delete existing output to ensure a clean build
if (existsSync(outfile)) {
  rmSync(outfile, { force: true })
}

mkdirSync(dirname(outfile), { recursive: true })

const externals = publish
  ? [
      // For npm publish build, externalize optional native deps
      // NOTE: @ant/* shim packages are NOT externalized — they must be bundled
      // because they only ship .ts source files, not compiled .js
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
      'sharp',
      'turndown',
      'url-handler-napi',
      'bun:*',
    ]
  : [
      '@ant/*',
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
      'sharp',
      'turndown',
      'url-handler-napi',
    ]

const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  ...(dev
    ? { 'process.env.NODE_ENV': JSON.stringify('development') }
    : {}),
  ...(dev
    ? {
        'process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD': JSON.stringify('true'),
      }
    : {}),
  'process.env.CCR_FORCE_BUNDLE': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'This reconstructed source snapshot does not include Anthropic internal issue routing.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(
    dev ? getVersionChangelog() : 'https://github.com/anthropics/claude-code',
  ),
} as const

const cmd = [
  'bun',
  'build',
  './src/entrypoints/cli.tsx',
  ...(!publish ? ['--compile'] : []),
  '--target',
  publish ? 'node' : 'bun',
  '--format',
  'esm',
  '--outfile',
  outfile,
  '--minify',
  ...(publish ? [] : ['--bytecode']),
  '--packages',
  'bundle',
  '--conditions',
  publish ? 'node' : 'bun',
  ...(publish ? ['--external', 'bun:*'] : []),
  '--lazy',
]

for (const external of externals) {
  cmd.push('--external', external)
}

for (const feature of features) {
  cmd.push(`--feature=${feature}`)
}

for (const [key, value] of Object.entries(defines)) {
  cmd.push('--define', `${key}=${value}`)
}

const proc = Bun.spawnSync({
  cmd,
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    // Disable bundler cache for publish builds to ensure fresh output
    ...(publish && { BUN_DISABLE_CACHE: '1' }),
  },
})

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1)
}

// For publish build, add shebang and bun:bundle polyfill for Node.js compatibility
if (publish && existsSync(outfile)) {
  let cliContent = await Bun.file(outfile).text()

  // Inject bun:bundle polyfill for feature() function
  const bunPolyfill = `// Bun bundle feature polyfill for Node.js
const __BUN_FEATURE_FALLBACK__ = () => false;
globalThis.feature = globalThis.feature || __BUN_FEATURE_FALLBACK__;
`

  // Prepend shebang and polyfill (shebang must be first line)
  cliContent = '#!/usr/bin/env node\n' + bunPolyfill + cliContent

  // Remove any duplicate shebang from original content
  cliContent = cliContent.replace(/(#!\/usr\/bin\/env node\r?\n)(#!\/usr\/bin\/env node\r?\n)/, '$1')

  await Bun.write(outfile, cliContent)

  const size = Bun.file(outfile).size
  console.log(`Publish build: ${(size / 1024 / 1024).toFixed(2)} MB`)
}

if (existsSync(outfile)) {
  chmodSync(outfile, 0o755)
}

console.log(`Built ${outfile}`)
