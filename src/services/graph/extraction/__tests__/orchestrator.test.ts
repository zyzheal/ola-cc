/**
 * ExtractionOrchestrator tests
 *
 * Tests the orchestrator and extractionResultToGraphStore adapter.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test'
import { ExtractionOrchestrator, extractionResultToGraphStore, hashContent, scanDirectory } from '../index.js'
import { extractFromSource } from '../tree-sitter.js'
import { init_grammars, load_grammars_for_languages } from '../grammars.js'
import type { GraphStore, NodeMetadata, EdgeType, EdgeMeta, EdgeConfidence } from '../../GraphStore.js'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

/**
 * Minimal mock GraphStore for testing.
 */
function createMockGraphStore(): GraphStore {
  const nodeMeta = new Map<string, NodeMetadata>()
  const adjacency = new Map<string, Map<string, EdgeMeta[]>>()
  const reverse = new Map<string, Map<string, EdgeMeta[]>>()

  const store = {
    nodeMeta,
    adjacency,
    reverse,
    addEdge(from: string, to: string, type: EdgeType, weight: number, confidence?: EdgeConfidence) {
      const edgeMeta: EdgeMeta = { type, weight, confidence }
      let fromMap = adjacency.get(from)
      if (!fromMap) {
        fromMap = new Map()
        adjacency.set(from, fromMap)
      }
      const existing = fromMap.get(to)
      if (!existing) {
        fromMap.set(to, [edgeMeta])
      } else {
        existing.push(edgeMeta)
      }
      // Reverse
      let toMap = reverse.get(to)
      if (!toMap) {
        toMap = new Map()
        reverse.set(to, toMap)
      }
      const existingRev = toMap.get(from)
      if (!existingRev) {
        toMap.set(from, [edgeMeta])
      } else {
        existingRev.push(edgeMeta)
      }
    },
  } as unknown as GraphStore

  return store
}

describe('extractionResultToGraphStore', () => {
  beforeAll(async () => {
    await init_grammars()
    await load_grammars_for_languages(['typescript', 'python'])
  })

  test('adds nodes to store.nodeMeta', () => {
    const store = createMockGraphStore()
    const result = extractFromSource('test.ts', `
export function hello(): void {
  console.log('world')
}
`, 'typescript')

    extractionResultToGraphStore(result, store)

    // Should have nodes in the store
    expect(store.nodeMeta.size).toBeGreaterThan(0)

    // Find the function node
    const funcNode = [...store.nodeMeta.values()].find(n => n.kind === 'function' && n.name === 'hello')
    expect(funcNode).toBeDefined()
    expect(funcNode!.file).toBe('test.ts')
    expect(funcNode!.is_exported).toBe(true)
    expect(funcNode!.provenance).toBe('tree-sitter')
  })

  test('adds edges to store via addEdge', () => {
    const store = createMockGraphStore()
    const result = extractFromSource('test.ts', `
class Foo {
  bar(): void {}
}
`, 'typescript')

    extractionResultToGraphStore(result, store)

    // Should have edges in the adjacency map
    expect(store.adjacency.size).toBeGreaterThan(0)
  })
})

describe('hashContent', () => {
  test('returns consistent hash for same content', () => {
    const hash1 = hashContent('hello world')
    const hash2 = hashContent('hello world')
    expect(hash1).toBe(hash2)
    expect(hash1.length).toBe(64) // SHA-256 hex
  })

  test('returns different hash for different content', () => {
    const hash1 = hashContent('hello')
    const hash2 = hashContent('world')
    expect(hash1).not.toBe(hash2)
  })
})

describe('scanDirectory', () => {
  test('finds source files in a directory', () => {
    // Create a temp directory with some files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-test-'))
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'const x = 1')
    fs.writeFileSync(path.join(tmpDir, 'test.py'), 'x = 1')
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Test')

    try {
      const files = scanDirectory(tmpDir)
      expect(files).toContain('test.ts')
      expect(files).toContain('test.py')
      expect(files).not.toContain('readme.md') // Not a source file
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  test('skips hidden directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-test-'))
    fs.mkdirSync(path.join(tmpDir, '.hidden'))
    fs.writeFileSync(path.join(tmpDir, '.hidden', 'secret.ts'), 'const x = 1')
    fs.writeFileSync(path.join(tmpDir, 'visible.ts'), 'const x = 1')

    try {
      const files = scanDirectory(tmpDir)
      expect(files).toContain('visible.ts')
      expect(files).not.toContain('.hidden/secret.ts')
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })
})

describe('ExtractionOrchestrator', () => {
  let store: GraphStore
  let tmpDir: string

  beforeEach(() => {
    store = createMockGraphStore()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'))
  })

  test('indexFile parses a single file', async () => {
    const filePath = path.join(tmpDir, 'hello.ts')
    fs.writeFileSync(filePath, `
export function greet(name: string): string {
  return "Hello " + name
}
`)

    const orchestrator = new ExtractionOrchestrator(tmpDir, store)
    const result = await orchestrator.indexFile('hello.ts')

    expect(result.nodes.length).toBeGreaterThan(0)
    expect(result.errors.filter(e => e.severity === 'error').length).toBe(0)

    const funcNode = result.nodes.find(n => n.kind === 'function' && n.name === 'greet')
    expect(funcNode).toBeDefined()
    expect(funcNode!.file).toBe('hello.ts')
  })

  test('indexFile stores results in GraphStore', async () => {
    const filePath = path.join(tmpDir, 'world.ts')
    fs.writeFileSync(filePath, `
class World {
  hello(): void {}
}
`)

    const orchestrator = new ExtractionOrchestrator(tmpDir, store)
    await orchestrator.indexFile('world.ts')

    // Nodes should be in the store
    expect(store.nodeMeta.size).toBeGreaterThan(0)

    const classNode = [...store.nodeMeta.values()].find(n => n.kind === 'class' && n.name === 'World')
    expect(classNode).toBeDefined()
  })

  test('indexAll scans and indexes all files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1')
    fs.writeFileSync(path.join(tmpDir, 'b.py'), 'y = 2')

    const orchestrator = new ExtractionOrchestrator(tmpDir, store)
    const result = await orchestrator.indexAll()

    expect(result.filesIndexed).toBeGreaterThanOrEqual(2)
    expect(result.nodesCreated).toBeGreaterThan(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('indexAll handles empty directory', async () => {
    const orchestrator = new ExtractionOrchestrator(tmpDir, store)
    const result = await orchestrator.indexAll()

    expect(result.filesIndexed).toBe(0)
    expect(result.success).toBe(true)
  })

  test('indexFile handles path traversal', async () => {
    const orchestrator = new ExtractionOrchestrator(tmpDir, store)
    const result = await orchestrator.indexFile('../../../etc/passwd')

    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]!.code).toBe('path_traversal')
  })

  test('indexFile handles nonexistent file', async () => {
    const orchestrator = new ExtractionOrchestrator(tmpDir, store)
    const result = await orchestrator.indexFile('nonexistent.ts')

    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]!.code).toBe('read_error')
  })
})
