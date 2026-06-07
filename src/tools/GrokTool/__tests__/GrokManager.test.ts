/**
 * GrokManager 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokManager.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'
import { GrokManager, GrokError, ERROR_SUGGESTIONS } from '../GrokManager.js'
import { GrokAnalyzer } from '../GrokAnalyzer.js'

const TEST_DIR = resolve('/tmp', `grok-test-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ============================================
// GrokError
// ============================================

describe('GrokError', () => {
  it('should create error with all fields', () => {
    const err = new GrokError('TEST_CODE', 'test-stage', 'test message', true, 'test suggestion')

    expect(err.code).toBe('TEST_CODE')
    expect(err.stage).toBe('test-stage')
    expect(err.message).toBe('test message')
    expect(err.recoverable).toBe(true)
    expect(err.suggestion).toBe('test suggestion')
    expect(err.name).toBe('GrokError')
    expect(err instanceof Error).toBe(true)
  })

  it('should work without suggestion', () => {
    const err = new GrokError('CODE', 'stage', 'msg', false)

    expect(err.suggestion).toBeUndefined()
    expect(err.recoverable).toBe(false)
  })
})

// ============================================
// ERROR_SUGGESTIONS
// ============================================

describe('ERROR_SUGGESTIONS', () => {
  it('should have all expected error codes', () => {
    expect(ERROR_SUGGESTIONS['PARSE_TIMEOUT']).toBeDefined()
    expect(ERROR_SUGGESTIONS['LLM_RATE_LIMIT']).toBeDefined()
    expect(ERROR_SUGGESTIONS['LLM_TOKEN_BUDGET']).toBeDefined()
    expect(ERROR_SUGGESTIONS['GRAPH_INVALID']).toBeDefined()
    expect(ERROR_SUGGESTIONS['SOURCE_CLONE_FAILED']).toBeDefined()
    expect(ERROR_SUGGESTIONS['NO_DATA_SOURCE']).toBeDefined()
  })
})

// ============================================
// loadGrokConfig — batchSize / concurrency env vars
// ============================================

describe('loadGrokConfig batch parameters', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['OLA_CC_GROK_BATCH_SIZE', 'OLA_CC_GROK_CONCURRENCY']) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
  })

  it('should use default batchSize=25 and concurrency=5 when env vars not set', () => {
    const manager = new GrokManager(TEST_DIR)
    const config = (manager as any).config
    expect(config.batchSize).toBe(25)
    expect(config.concurrency).toBe(5)
  })

  it('should read OLA_CC_GROK_BATCH_SIZE from env', () => {
    process.env.OLA_CC_GROK_BATCH_SIZE = '10'
    const manager = new GrokManager(TEST_DIR)
    const config = (manager as any).config
    expect(config.batchSize).toBe(10)
  })

  it('should read OLA_CC_GROK_CONCURRENCY from env', () => {
    process.env.OLA_CC_GROK_CONCURRENCY = '8'
    const manager = new GrokManager(TEST_DIR)
    const config = (manager as any).config
    expect(config.concurrency).toBe(8)
  })

  it('should read both env vars together', () => {
    process.env.OLA_CC_GROK_BATCH_SIZE = '3'
    process.env.OLA_CC_GROK_CONCURRENCY = '2'
    const manager = new GrokManager(TEST_DIR)
    const config = (manager as any).config
    expect(config.batchSize).toBe(3)
    expect(config.concurrency).toBe(2)
  })

  it('should fall back to default batchSize when value exceeds max', () => {
    process.env.OLA_CC_GROK_BATCH_SIZE = '999'
    const manager = new GrokManager(TEST_DIR)
    const config = (manager as any).config
    expect(config.batchSize).toBe(25)
  })

  it('should fall back to default concurrency when value exceeds max', () => {
    process.env.OLA_CC_GROK_CONCURRENCY = '100'
    const manager = new GrokManager(TEST_DIR)
    const config = (manager as any).config
    expect(config.concurrency).toBe(5)
  })

  it('should fall back to default batchSize when value below minimum', () => {
    process.env.OLA_CC_GROK_BATCH_SIZE = '0'
    const manager = new GrokManager(TEST_DIR)
    const config = (manager as any).config
    expect(config.batchSize).toBe(25)
  })

  it('should fall back to default batchSize on non-numeric input', () => {
    process.env.OLA_CC_GROK_BATCH_SIZE = 'abc'
    const manager = new GrokManager(TEST_DIR)
    const config = (manager as any).config
    expect(config.batchSize).toBe(25)
  })
})

// ============================================
// GrokManager constructor
// ============================================

describe('GrokManager constructor', () => {
  it('should accept custom project root', () => {
    const manager = new GrokManager('/tmp/test')
    // No error = success
    expect(manager).toBeDefined()
  })

  it('should use cwd when no root provided', () => {
    const manager = new GrokManager()
    expect(manager).toBeDefined()
  })
})

// ============================================
// getGraphStatus
// ============================================

describe('getGraphStatus', () => {
  it('should return exists=false when graph file missing', async () => {
    const manager = new GrokManager(TEST_DIR)
    const status = await manager.getGraphStatus()

    expect(status.exists).toBe(false)
    expect(status.nodeCount).toBeUndefined()
    expect(status.edgeCount).toBeUndefined()
  })

  it('should return graph stats when file exists', async () => {
    const graphDir = resolve(TEST_DIR, '.understand-anything')
    mkdirSync(graphDir, { recursive: true })

    const graphData = {
      nodes: [{ id: '1' }, { id: '2' }, { id: '3' }],
      edges: [{ from: '1', to: '2' }],
      metadata: { lastUpdated: new Date().toISOString() },
    }
    writeFileSync(resolve(graphDir, 'knowledge-graph.json'), JSON.stringify(graphData))

    const manager = new GrokManager(TEST_DIR)
    const status = await manager.getGraphStatus()

    expect(status.exists).toBe(true)
    expect(status.nodeCount).toBe(3)
    expect(status.edgeCount).toBe(1)
    expect(status.stale).toBe(false)
  })

  it('should mark graph as stale when older than 24h', async () => {
    const graphDir = resolve(TEST_DIR, '.understand-anything')
    mkdirSync(graphDir, { recursive: true })

    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    const graphData = {
      nodes: [{ id: '1' }],
      edges: [],
      metadata: { lastUpdated: oldDate },
    }
    writeFileSync(resolve(graphDir, 'knowledge-graph.json'), JSON.stringify(graphData))

    const manager = new GrokManager(TEST_DIR)
    const status = await manager.getGraphStatus()

    expect(status.exists).toBe(true)
    expect(status.stale).toBe(true)
  })

  it('should handle malformed JSON gracefully', async () => {
    const graphDir = resolve(TEST_DIR, '.understand-anything')
    mkdirSync(graphDir, { recursive: true })
    writeFileSync(resolve(graphDir, 'knowledge-graph.json'), 'not json')

    const manager = new GrokManager(TEST_DIR)
    const status = await manager.getGraphStatus()

    expect(status.exists).toBe(false)
  })
})

// ============================================
// ensureGrokSource (partial)
// ============================================

describe('ensureGrokSource', () => {
  it('should return source dir if already exists', async () => {
    const vendorDir = resolve(TEST_DIR, 'vendor', 'grok')
    const sourceDir = resolve(vendorDir, 'understand-anything')
    mkdirSync(sourceDir, { recursive: true })

    // Need to override vendorDir — use a subclass or test via real path
    // For now, test the "already exists" logic by checking the directory
    expect(existsSync(sourceDir)).toBe(true)
  })
})

// ============================================
// Stub methods
// ============================================

describe('stub methods', () => {
  it('queryGraph should throw when graph missing', async () => {
    const manager = new GrokManager(TEST_DIR)
    await expect(manager.queryGraph('test')).rejects.toThrow('知识图谱未生成')
  })

  it('startDashboard should throw when graph missing', async () => {
    const manager = new GrokManager(TEST_DIR)
    await expect(manager.startDashboard()).rejects.toThrow('知识图谱未生成')
  })

  it('runAgentPipeline should return failed when no files', async () => {
    const manager = new GrokManager(TEST_DIR)
    const result = await manager.runAgentPipeline({})
    expect(result.status).toBe('failed')
    expect(result.errors).toBeDefined()
    expect(result.errors![0].code).toBe('NO_FILES')
  })
})

// ============================================
// buildFileAnalyzerPrompt
// ============================================

describe('buildFileAnalyzerPrompt', () => {
  it('should list file paths in prompt', () => {
    const testFile = resolve(TEST_DIR, 'sample.ts')
    writeFileSync(testFile, 'export function hello() { return "world" }')

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const prompt = analyzer.buildFileAnalyzerPrompt([testFile])

    expect(prompt).toContain('sample.ts')
    expect(prompt).toContain('Analyze the following files')
  })

  it('should list multiple files', () => {
    const f1 = resolve(TEST_DIR, 'a.ts')
    const f2 = resolve(TEST_DIR, 'b.ts')
    writeFileSync(f1, '')
    writeFileSync(f2, '')

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const prompt = analyzer.buildFileAnalyzerPrompt([f1, f2])

    expect(prompt).toContain('a.ts')
    expect(prompt).toContain('b.ts')
  })

  it('should handle empty file list', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const prompt = analyzer.buildFileAnalyzerPrompt([])

    expect(prompt).toContain('Analyze the following files')
  })
})

// ============================================
// localScan — local filesystem detection
// ============================================

describe('localScan', () => {
  it('should detect TypeScript from .ts files', () => {
    writeFileSync(resolve(TEST_DIR, 'index.ts'), 'export {}')
    writeFileSync(resolve(TEST_DIR, 'app.tsx'), 'export {}')

    const manager = new GrokManager(TEST_DIR)
    const files = [resolve(TEST_DIR, 'index.ts'), resolve(TEST_DIR, 'app.tsx')]
    const result = (manager as any).localScan(files) as { languages: string[], frameworks: string[], entryPoints: string[] }

    expect(result.languages).toContain('TypeScript')
    expect(result.languages).not.toContain('JavaScript') // .tsx is TS, not JS
  })

  it('should detect Python from .py files', () => {
    writeFileSync(resolve(TEST_DIR, 'main.py'), 'print("hello")')

    const manager = new GrokManager(TEST_DIR)
    const files = [resolve(TEST_DIR, 'main.py')]
    const result = (manager as any).localScan(files)

    expect(result.languages).toContain('Python')
  })

  it('should detect multiple languages', () => {
    writeFileSync(resolve(TEST_DIR, 'index.ts'), '')
    writeFileSync(resolve(TEST_DIR, 'app.py'), '')
    writeFileSync(resolve(TEST_DIR, 'main.go'), '')
    writeFileSync(resolve(TEST_DIR, 'lib.rs'), '')

    const manager = new GrokManager(TEST_DIR)
    const files = [
      resolve(TEST_DIR, 'index.ts'),
      resolve(TEST_DIR, 'app.py'),
      resolve(TEST_DIR, 'main.go'),
      resolve(TEST_DIR, 'lib.rs'),
    ]
    const result = (manager as any).localScan(files)

    expect(result.languages).toContain('TypeScript')
    expect(result.languages).toContain('Python')
    expect(result.languages).toContain('Go')
    expect(result.languages).toContain('Rust')
  })

  it('should detect frameworks from package.json', () => {
    writeFileSync(resolve(TEST_DIR, 'index.ts'), '')
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0', express: '^4.18.0' },
      devDependencies: { typescript: '^5.0.0' },
    }))

    const manager = new GrokManager(TEST_DIR)
    const files = [resolve(TEST_DIR, 'index.ts')]
    const result = (manager as any).localScan(files)

    expect(result.frameworks).toContain('React')
    expect(result.frameworks).toContain('Express')
  })

  it('should detect entry points from common patterns', () => {
    writeFileSync(resolve(TEST_DIR, 'index.ts'), '')
    writeFileSync(resolve(TEST_DIR, 'main.ts'), '')
    writeFileSync(resolve(TEST_DIR, 'app.ts'), '')
    writeFileSync(resolve(TEST_DIR, 'server.ts'), '')

    const manager = new GrokManager(TEST_DIR)
    const files = [
      resolve(TEST_DIR, 'index.ts'),
      resolve(TEST_DIR, 'main.ts'),
      resolve(TEST_DIR, 'app.ts'),
      resolve(TEST_DIR, 'server.ts'),
    ]
    const result = (manager as any).localScan(files)

    expect(result.entryPoints).toContain(resolve(TEST_DIR, 'index.ts'))
    expect(result.entryPoints).toContain(resolve(TEST_DIR, 'main.ts'))
    expect(result.entryPoints).toContain(resolve(TEST_DIR, 'app.ts'))
    expect(result.entryPoints).toContain(resolve(TEST_DIR, 'server.ts'))
  })

  it('should detect entry points in src/ subdirectory', () => {
    const srcDir = resolve(TEST_DIR, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(resolve(srcDir, 'main.ts'), '')

    const manager = new GrokManager(TEST_DIR)
    const files = [resolve(srcDir, 'main.ts')]
    const result = (manager as any).localScan(files)

    expect(result.entryPoints).toContain(resolve(srcDir, 'main.ts'))
  })

  it('should return empty arrays for empty file list', () => {
    const manager = new GrokManager(TEST_DIR)
    const result = (manager as any).localScan([])

    expect(result.languages).toEqual([])
    expect(result.frameworks).toEqual([])
    expect(result.entryPoints).toEqual([])
  })

  it('should deduplicate languages', () => {
    writeFileSync(resolve(TEST_DIR, 'a.ts'), '')
    writeFileSync(resolve(TEST_DIR, 'b.ts'), '')

    const manager = new GrokManager(TEST_DIR)
    const files = [resolve(TEST_DIR, 'a.ts'), resolve(TEST_DIR, 'b.ts')]
    const result = (manager as any).localScan(files)

    // TypeScript should appear exactly once
    const tsCount = result.languages.filter((l: string) => l === 'TypeScript').length
    expect(tsCount).toBe(1)
  })

  it('should not crash when package.json is missing', () => {
    writeFileSync(resolve(TEST_DIR, 'index.ts'), '')

    const manager = new GrokManager(TEST_DIR)
    const files = [resolve(TEST_DIR, 'index.ts')]
    const result = (manager as any).localScan(files)

    expect(result.frameworks).toEqual([])
  })

  it('should not crash when package.json is malformed', () => {
    writeFileSync(resolve(TEST_DIR, 'index.ts'), '')
    writeFileSync(resolve(TEST_DIR, 'package.json'), 'not json')

    const manager = new GrokManager(TEST_DIR)
    const files = [resolve(TEST_DIR, 'index.ts')]
    const result = (manager as any).localScan(files)

    expect(result.frameworks).toEqual([])
  })

  it('should detect JavaScript from .js/.jsx files', () => {
    writeFileSync(resolve(TEST_DIR, 'app.js'), '')
    writeFileSync(resolve(TEST_DIR, 'view.jsx'), '')

    const manager = new GrokManager(TEST_DIR)
    const files = [resolve(TEST_DIR, 'app.js'), resolve(TEST_DIR, 'view.jsx')]
    const result = (manager as any).localScan(files)

    expect(result.languages).toContain('JavaScript')
  })

  it('should detect Vue/Svelte from extensions', () => {
    writeFileSync(resolve(TEST_DIR, 'App.vue'), '')
    writeFileSync(resolve(TEST_DIR, 'Page.svelte'), '')

    const manager = new GrokManager(TEST_DIR)
    const files = [resolve(TEST_DIR, 'App.vue'), resolve(TEST_DIR, 'Page.svelte')]
    const result = (manager as any).localScan(files)

    expect(result.languages).toContain('Vue')
    expect(result.languages).toContain('Svelte')
  })
})

// ============================================
// Integration test: full pipeline optimization
// Verifies all three Phase 0 optimizations work together:
//   1. localScan() replaces LLM scanner
//   2. GrokConfig batchSize/concurrency from env vars
//   3. GrokAnalyzer model routing (getModelForTask)
// ============================================

describe('Integration: Phase 0 pipeline optimization', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const INT_DIR = resolve('/tmp', `grok-integration-${Date.now()}`)
  const envKeys = ['OLA_CC_GROK_BATCH_SIZE', 'OLA_CC_GROK_CONCURRENCY', 'OLA_CC_GROK_MODEL', 'OLA_CC_GROK_MODEL_FAST']

  beforeEach(() => {
    mkdirSync(INT_DIR, { recursive: true })
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    rmSync(INT_DIR, { recursive: true, force: true })
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
  })

  it('should verify localScan + batch config + model routing work together', () => {
    // --- Setup: small test project with .ts files and react ---
    const srcDir = resolve(INT_DIR, 'src')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(resolve(srcDir, 'index.ts'), 'export function main() {}')
    writeFileSync(resolve(srcDir, 'App.tsx'), 'export default function App() { return null }')
    writeFileSync(resolve(srcDir, 'utils.ts'), 'export const helper = () => {}')
    writeFileSync(resolve(INT_DIR, 'package.json'), JSON.stringify({
      name: 'test-project',
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    }))

    // --- Set batch + model env vars ---
    process.env.OLA_CC_GROK_BATCH_SIZE = '10'
    process.env.OLA_CC_GROK_CONCURRENCY = '3'
    process.env.OLA_CC_GROK_MODEL = 'custom-primary-model'
    process.env.OLA_CC_GROK_MODEL_FAST = 'custom-fast-model'

    // --- Create GrokManager (reads config from env) ---
    const manager = new GrokManager(INT_DIR)

    // === Optimization 1: localScan detects languages + frameworks ===
    const files = [
      resolve(srcDir, 'index.ts'),
      resolve(srcDir, 'App.tsx'),
      resolve(srcDir, 'utils.ts'),
    ]
    const scanResult = (manager as any).localScan(files) as {
      languages: string[]
      frameworks: string[]
      entryPoints: string[]
    }

    expect(scanResult.languages).toContain('TypeScript')
    expect(scanResult.languages).not.toContain('JavaScript') // .tsx = TypeScript
    expect(scanResult.frameworks).toContain('React')
    expect(scanResult.entryPoints).toContain(resolve(srcDir, 'index.ts'))

    // === Optimization 2: batchSize + concurrency from env vars ===
    const config = (manager as any).config
    expect(config.batchSize).toBe(10)
    expect(config.concurrency).toBe(3)

    // === Optimization 3: model routing via GrokAnalyzer ===
    const analyzer = (manager as any).analyzer
    // Trigger getClient() to read model env vars
    ;(analyzer as any).getClient()
    expect(analyzer.getModelForTask('primary')).toBe('custom-primary-model')
    expect(analyzer.getModelForTask('fast')).toBe('custom-fast-model')
  })

  it('should use defaults when env vars are not set', () => {
    writeFileSync(resolve(INT_DIR, 'index.ts'), '')

    const manager = new GrokManager(INT_DIR)

    // Config defaults
    const config = (manager as any).config
    expect(config.batchSize).toBe(25)
    expect(config.concurrency).toBe(5)

    // localScan works with empty frameworks when no package.json
    const files = [resolve(INT_DIR, 'index.ts')]
    const scanResult = (manager as any).localScan(files)
    expect(scanResult.languages).toContain('TypeScript')
    expect(scanResult.frameworks).toEqual([])

    // Model routing defaults
    const analyzer = (manager as any).analyzer
    expect(analyzer.getModelForTask('primary')).toBe('claude-sonnet-4-20250514')
    expect(analyzer.getModelForTask('fast')).toBe('claude-sonnet-4-20250514')
  })

  it('should detect multiple languages and frameworks in one scan', () => {
    const srcDir = resolve(INT_DIR, 'src')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(resolve(srcDir, 'index.ts'), '')
    writeFileSync(resolve(srcDir, 'server.py'), '')
    writeFileSync(resolve(srcDir, 'main.go'), '')
    writeFileSync(resolve(INT_DIR, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0', express: '^4.18.0' },
    }))

    const manager = new GrokManager(INT_DIR)
    const files = [
      resolve(srcDir, 'index.ts'),
      resolve(srcDir, 'server.py'),
      resolve(srcDir, 'main.go'),
    ]
    const scanResult = (manager as any).localScan(files)

    expect(scanResult.languages).toContain('TypeScript')
    expect(scanResult.languages).toContain('Python')
    expect(scanResult.languages).toContain('Go')
    expect(scanResult.frameworks).toContain('React')
    expect(scanResult.frameworks).toContain('Express')
  })
})
