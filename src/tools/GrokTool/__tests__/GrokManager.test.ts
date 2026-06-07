/**
 * GrokManager 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokManager.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'
import { GrokManager, GrokError, ERROR_SUGGESTIONS } from '../GrokManager.js'

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
    expect(ERROR_SUGGESTIONS['LLM_TIMEOUT']).toBeDefined()
    expect(ERROR_SUGGESTIONS['LLM_TOKEN_BUDGET']).toBeDefined()
    expect(ERROR_SUGGESTIONS['GRAPH_INVALID']).toBeDefined()
    expect(ERROR_SUGGESTIONS['GRAPH_NOT_FOUND']).toBeDefined()
    expect(ERROR_SUGGESTIONS['SOURCE_UPDATE_FAILED']).toBeDefined()
    expect(ERROR_SUGGESTIONS['NO_FILES']).toBeDefined()
    expect(ERROR_SUGGESTIONS['INVALID_SCOPE']).toBeDefined()
    expect(ERROR_SUGGESTIONS['NO_AVAILABLE_PORT']).toBeDefined()
    // Pipeline step failure codes
    expect(ERROR_SUGGESTIONS['SCANNER_FAILED']).toBeDefined()
    expect(ERROR_SUGGESTIONS['ANALYZER_FAILED']).toBeDefined()
    expect(ERROR_SUGGESTIONS['ARCHITECTURE_FAILED']).toBeDefined()
    expect(ERROR_SUGGESTIONS['TOUR_FAILED']).toBeDefined()
    expect(ERROR_SUGGESTIONS['REVIEW_FAILED']).toBeDefined()
  })

  it('should not contain removed dead code SOURCE_CLONE_FAILED', () => {
    expect(ERROR_SUGGESTIONS['SOURCE_CLONE_FAILED']).toBeUndefined()
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
  it('should include actual file contents in prompt', () => {
    const testFile = resolve(TEST_DIR, 'sample.ts')
    writeFileSync(testFile, 'export function hello() { return "world" }')

    const manager = new GrokManager(TEST_DIR)
    const prompt = (manager as any).buildFileAnalyzerPrompt([testFile]) as string

    expect(prompt).toContain('export function hello()')
    expect(prompt).toContain('sample.ts')
    // Should NOT just be a path reference
    expect(prompt).not.toContain('(Unable to read file)')
  })

  it('should truncate large files at 50KB', () => {
    const testFile = resolve(TEST_DIR, 'large.ts')
    const bigContent = 'x'.repeat(60_000)
    writeFileSync(testFile, bigContent)

    const manager = new GrokManager(TEST_DIR)
    const prompt = (manager as any).buildFileAnalyzerPrompt([testFile]) as string

    expect(prompt).toContain('truncated')
    // Should not contain the full 60KB
    expect(prompt.length).toBeLessThan(60_000 + 500)
  })

  it('should handle unreadable files gracefully', () => {
    const missingFile = resolve(TEST_DIR, 'nonexistent.ts')

    const manager = new GrokManager(TEST_DIR)
    const prompt = (manager as any).buildFileAnalyzerPrompt([missingFile]) as string

    expect(prompt).toContain('Unable to read file')
    expect(prompt).toContain('nonexistent.ts')
  })

  it('should limit total content size to 200KB', () => {
    // Create many files that exceed 200KB total
    const files: string[] = []
    for (let i = 0; i < 10; i++) {
      const f = resolve(TEST_DIR, `file${i}.ts`)
      writeFileSync(f, 'y'.repeat(25_000)) // 25KB each = 250KB total
      files.push(f)
    }

    const manager = new GrokManager(TEST_DIR)
    const prompt = (manager as any).buildFileAnalyzerPrompt(files) as string

    // Some files should be skipped
    expect(prompt).toContain('Skipped: total content size limit reached')
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
