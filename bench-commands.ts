#!/usr/bin/env bun
/**
 * Benchmark: command suggestion generation performance
 * Uses synthetic commands to avoid needing API keys
 */

process.env.NODE_ENV = 'test'

const { generateCommandSuggestions } = await import('./src/utils/suggestions/commandSuggestions.js')

// Create synthetic commands
function makeCommands(count: number): any[] {
  const cmds: any[] = []

  // Built-in commands (local type)
  const builtinNames = ['help', 'compact', 'config', 'clear', 'copy', 'diff', 'doctor',
    'status', 'init', 'mcp', 'model', 'resume', 'skills', 'tasks', 'vim',
    'theme', 'usage', 'upgrade', 'version', 'login', 'logout', 'review',
    'branch', 'commit', 'push', 'memory', 'stats', 'cost', 'session',
    'keybindings', 'install-github-app', 'install-slack-app', 'feedback',
    'auth', 'share', 'rename', 'teleport', 'output-style', 'remote-env',
    'tag', 'color', 'effort', 'statusline', 'btw', 'chrome', 'desktop',
    'ide', 'mobile', 'onboarding', 'terminal-setup', 'release-notes',
    'pr_comments', 'show-all-tools', 'exit', 'rewind', 'security-review',
    'bughunter', 'backfill-sessions', 'break-cache', 'heap-dump',
    'fast', 'files', 'goal', 'good-claude', 'ctx_viz', 'context',
    'advisor', 'agents', 'sessions', 'verbose', 'add-dir', 'config',
    'context-noninteractive', 'extra-usage', 'rate-limit-options', 'plugin']

  for (const name of builtinNames) {
    cmds.push({
      type: 'local',
      name,
      description: `Built-in ${name} command for testing`,
      isHidden: false,
    })
  }

  // Plugin/prompt commands
  for (let i = 0; i < count; i++) {
    cmds.push({
      type: 'prompt',
      name: `skill-${i}`,
      description: `Plugin skill number ${i} for testing purposes`,
      isHidden: false,
      source: 'plugin',
      pluginInfo: { pluginManifest: { name: `test-plugin-${i % 5}` } },
      contentLength: Math.floor(Math.random() * 10000),
      progressMessage: 'working',
    })
  }

  return cmds
}

async function bench(label: string, fn: () => void, iterations: number = 5) {
  // Cold run
  const coldStart = performance.now()
  fn()
  const coldTime = performance.now() - coldStart
  console.log(`  Cold: ${coldTime.toFixed(1)}ms`)

  // Warm runs
  const times: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    times.push(performance.now() - start)
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const max = Math.max(...times)
  console.log(`  Warm: avg=${avg.toFixed(1)}ms max=${max.toFixed(1)}ms (${iterations} runs)`)
}

async function runBenchmark(count: number) {
  const cmds = makeCommands(count)
  console.log(`\n=== ${cmds.length} commands (${cmds.filter((c: any) => c.type === 'prompt').length} prompt) ===`)

  await bench('"/" (empty query)', () => {
    generateCommandSuggestions('/', cmds)
  })

  await bench('"/a"', () => {
    generateCommandSuggestions('/a', cmds)
  })

  await bench('"/com"', () => {
    generateCommandSuggestions('/com', cmds)
  })

  await bench('"/skill-"', () => {
    generateCommandSuggestions('/skill-', cmds)
  })

  await bench('"/skill-42"', () => {
    generateCommandSuggestions('/skill-42', cmds)
  })
}

await runBenchmark(0)    // Just built-ins
await runBenchmark(20)   // 20 skills
await runBenchmark(50)   // 50 skills
await runBenchmark(100)  // 100 skills
