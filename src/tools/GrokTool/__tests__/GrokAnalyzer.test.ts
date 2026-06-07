/**
 * GrokAnalyzer 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokAnalyzer.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve } from 'path'
import { GrokAnalyzer, AGENT_SYSTEM_PROMPTS } from '../GrokAnalyzer.js'
import { GrokError } from '../GrokManager.js'

const TEST_DIR = resolve('/tmp', `grok-analyzer-test-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ============================================
// AGENT_SYSTEM_PROMPTS
// ============================================

describe('AGENT_SYSTEM_PROMPTS', () => {
  it('should have all expected prompt keys', () => {
    expect(AGENT_SYSTEM_PROMPTS.scanner).toBeDefined()
    expect(AGENT_SYSTEM_PROMPTS.analyzer).toBeDefined()
    expect(AGENT_SYSTEM_PROMPTS.architecture).toBeDefined()
    expect(AGENT_SYSTEM_PROMPTS.tour).toBeDefined()
    expect(AGENT_SYSTEM_PROMPTS.review).toBeDefined()
  })

  it('scanner prompt should mention discovering files', () => {
    expect(AGENT_SYSTEM_PROMPTS.scanner).toContain('Discover all source files')
  })

  it('analyzer prompt should mention symbols', () => {
    expect(AGENT_SYSTEM_PROMPTS.analyzer).toContain('symbols')
  })
})

// ============================================
// discoverFiles
// ============================================

describe('discoverFiles', () => {
  it('should discover source files in directory', async () => {
    writeFileSync(resolve(TEST_DIR, 'index.ts'), 'export const x = 1')
    writeFileSync(resolve(TEST_DIR, 'utils.js'), 'module.exports = {}')
    writeFileSync(resolve(TEST_DIR, 'readme.md'), '# Hello')
    writeFileSync(resolve(TEST_DIR, 'image.png'), 'binary')  // should be excluded

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const files = await analyzer.discoverFiles()

    expect(files.length).toBe(3)
    expect(files.some(f => f.endsWith('index.ts'))).toBe(true)
    expect(files.some(f => f.endsWith('utils.js'))).toBe(true)
    expect(files.some(f => f.endsWith('readme.md'))).toBe(true)
    expect(files.some(f => f.endsWith('image.png'))).toBe(false)
  })

  it('should exclude node_modules and .git', async () => {
    mkdirSync(resolve(TEST_DIR, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(resolve(TEST_DIR, '.git'), { recursive: true })
    writeFileSync(resolve(TEST_DIR, 'node_modules', 'pkg', 'index.ts'), '')
    writeFileSync(resolve(TEST_DIR, '.git', 'config'), '')
    writeFileSync(resolve(TEST_DIR, 'src.ts'), '')

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const files = await analyzer.discoverFiles()

    expect(files.length).toBe(1)
    expect(files[0]).toContain('src.ts')
  })

  it('should respect scope parameter', async () => {
    mkdirSync(resolve(TEST_DIR, 'src'), { recursive: true })
    mkdirSync(resolve(TEST_DIR, 'test'), { recursive: true })
    writeFileSync(resolve(TEST_DIR, 'src', 'main.ts'), '')
    writeFileSync(resolve(TEST_DIR, 'test', 'spec.ts'), '')

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const files = await analyzer.discoverFiles(undefined, 'src')

    expect(files.length).toBe(1)
    expect(files[0]).toContain('main.ts')
  })

  it('should throw INVALID_SCOPE for path outside project root', async () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)

    await expect(analyzer.discoverFiles(undefined, '../../etc')).rejects.toThrow(GrokError)
  })

  it('should return empty array for empty directory', async () => {
    const emptyDir = resolve(TEST_DIR, 'empty')
    mkdirSync(emptyDir)

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const files = await analyzer.discoverFiles(undefined, 'empty')

    expect(files.length).toBe(0)
  })
})

// ============================================
// detectChanges
// ============================================

describe('detectChanges', () => {
  it('should detect added files', () => {
    writeFileSync(resolve(TEST_DIR, 'new.ts'), 'content')

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const changes = analyzer.detectChanges(
      [resolve(TEST_DIR, 'new.ts')],
      {}
    )

    expect(changes.added.length).toBe(1)
    expect(changes.changed.length).toBe(0)
    expect(changes.removed.length).toBe(0)
  })

  it('should detect removed files', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const changes = analyzer.detectChanges(
      [],
      { [resolve(TEST_DIR, 'deleted.ts')]: { hash: 'abc', size: 100 } }
    )

    expect(changes.removed.length).toBe(1)
  })

  it('should detect changed files by hash', () => {
    const testFile = resolve(TEST_DIR, 'changed.ts')
    writeFileSync(testFile, 'new content')

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const changes = analyzer.detectChanges(
      [testFile],
      { [testFile]: { hash: 'different_hash', size: 100 } }
    )

    expect(changes.changed.length).toBe(1)
  })

  it('should detect unchanged files', () => {
    const testFile = resolve(TEST_DIR, 'same.ts')
    writeFileSync(testFile, 'same content')

    // Compute the actual fingerprint
    const { computeFileFingerprint } = require('../GrokAssembler.js')
    const fp = computeFileFingerprint(testFile)

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const changes = analyzer.detectChanges(
      [testFile],
      { [testFile]: fp }
    )

    expect(changes.unchanged.length).toBe(1)
    expect(changes.changed.length).toBe(0)
  })

  it('should handle mixed changes', () => {
    const keep = resolve(TEST_DIR, 'keep.ts')
    const remove = resolve(TEST_DIR, 'remove.ts')
    writeFileSync(keep, 'keep content')

    const analyzer = new GrokAnalyzer(TEST_DIR)
    const changes = analyzer.detectChanges(
      [keep],
      { [remove]: { hash: 'abc', size: 10 } }
    )

    expect(changes.added.length).toBe(1)
    expect(changes.removed.length).toBe(1)
  })
})

// ============================================
// parseAnalysisResult
// ============================================

describe('parseAnalysisResult', () => {
  it('should parse valid JSON array', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const result = analyzer.parseAnalysisResult('[{"name":"foo"}]')

    expect(result.length).toBe(1)
    expect(result[0].name).toBe('foo')
  })

  it('should parse single JSON object into array', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const result = analyzer.parseAnalysisResult('{"name":"bar"}')

    expect(result.length).toBe(1)
    expect(result[0].name).toBe('bar')
  })

  it('should strip markdown code fences', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const result = analyzer.parseAnalysisResult('```json\n[{"x":1}]\n```')

    expect(result.length).toBe(1)
    expect(result[0].x).toBe(1)
  })

  it('should return empty array for invalid JSON', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const result = analyzer.parseAnalysisResult('not json at all')

    expect(result.length).toBe(0)
  })
})

// ============================================
// sanitizeFilePath
// ============================================

describe('sanitizeFilePath', () => {
  it('should wrap path in backticks', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const result = analyzer.sanitizeFilePath('src/main.ts')

    expect(result).toBe('`src/main.ts`')
  })

  it('should escape internal backticks', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const result = analyzer.sanitizeFilePath('src/file`name.ts')

    expect(result).toBe('`src/file\\`name.ts`')
  })
})

// ============================================
// Model routing (getModelForTask)
// ============================================

describe('getModelForTask', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['OLA_CC_GROK_MODEL', 'OLA_CC_GROK_MODEL_FAST', 'ANTHROPIC_MODEL', 'OLA_CC_MODEL_SONNET']) {
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

  it('should return primary model by default', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    // Before getClient() is called, model is the default
    expect(analyzer.getModelForTask('primary')).toBe('claude-sonnet-4-20250514')
  })

  it('should return fast model (same as primary by default)', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    expect(analyzer.getModelForTask('fast')).toBe('claude-sonnet-4-20250514')
  })

  it('should default to primary when no taskType given', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    expect(analyzer.getModelForTask()).toBe('claude-sonnet-4-20250514')
  })

  it('should use OLA_CC_GROK_MODEL for primary after getClient()', () => {
    process.env.OLA_CC_GROK_MODEL = 'claude-opus-4-20250514'
    process.env.OLA_CC_GROK_MODEL_FAST = 'claude-haiku-4-20250514'
    const analyzer = new GrokAnalyzer(TEST_DIR)
    // Trigger getClient() to populate model/modelFast
    analyzer.discoverFiles()  // This calls getClient indirectly via analyzeFilesBatch
    // Actually, getClient is private. We can test via runPipelineStep or by accessing internals.
    // Use (analyzer as any) to trigger getClient
    ;(analyzer as any).getClient()
    expect(analyzer.getModelForTask('primary')).toBe('claude-opus-4-20250514')
    expect(analyzer.getModelForTask('fast')).toBe('claude-haiku-4-20250514')
  })

  it('should fallback fast model to primary when OLA_CC_GROK_MODEL_FAST not set', () => {
    process.env.OLA_CC_GROK_MODEL = 'custom-model'
    const analyzer = new GrokAnalyzer(TEST_DIR)
    ;(analyzer as any).getClient()
    expect(analyzer.getModelForTask('fast')).toBe('custom-model')
  })

  it('should prefer OLA_CC_GROK_MODEL over ANTHROPIC_MODEL', () => {
    process.env.OLA_CC_GROK_MODEL = 'grok-primary'
    process.env.ANTHROPIC_MODEL = 'anthropic-default'
    const analyzer = new GrokAnalyzer(TEST_DIR)
    ;(analyzer as any).getClient()
    expect(analyzer.getModelForTask('primary')).toBe('grok-primary')
  })
})

// ============================================
// buildFileAnalyzerPrompt
// ============================================

describe('buildFileAnalyzerPrompt', () => {
  it('should include file paths in prompt', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const prompt = analyzer.buildFileAnalyzerPrompt(['src/a.ts', 'src/b.ts'])

    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('src/b.ts')
    expect(prompt).toContain('Analyze the following files')
  })

  it('should handle empty file list', () => {
    const analyzer = new GrokAnalyzer(TEST_DIR)
    const prompt = analyzer.buildFileAnalyzerPrompt([])

    expect(prompt).toContain('Analyze the following files')
  })
})
