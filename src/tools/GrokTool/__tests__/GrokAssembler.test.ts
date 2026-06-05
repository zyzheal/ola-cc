/**
 * GrokAssembler 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokAssembler.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { GrokAssembler, computeFileFingerprint } from '../GrokAssembler.js'
import type { GraphNode, GraphEdge, GraphData } from '../GrokManager.js'
import { GrokError } from '../GrokManager.js'

const TEST_DIR = resolve('/tmp', `grok-assembler-test-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ============================================
// computeFileFingerprint
// ============================================

describe('computeFileFingerprint', () => {
  it('should return hash and size for existing file', () => {
    const testFile = resolve(TEST_DIR, 'test.ts')
    writeFileSync(testFile, 'hello world')

    const fp = computeFileFingerprint(testFile)

    expect(fp).not.toBeNull()
    expect(fp!.hash).toBeDefined()
    expect(fp!.hash.length).toBe(16)
    expect(fp!.size).toBe(11) // 'hello world' is 11 bytes
  })

  it('should return null for non-existent file', () => {
    const fp = computeFileFingerprint(resolve(TEST_DIR, 'nonexistent.ts'))
    expect(fp).toBeNull()
  })

  it('should produce different hashes for different content', () => {
    const file1 = resolve(TEST_DIR, 'a.ts')
    const file2 = resolve(TEST_DIR, 'b.ts')
    writeFileSync(file1, 'content A')
    writeFileSync(file2, 'content B')

    const fp1 = computeFileFingerprint(file1)
    const fp2 = computeFileFingerprint(file2)

    expect(fp1!.hash).not.toBe(fp2!.hash)
  })

  it('should produce same hash for same content', () => {
    const file1 = resolve(TEST_DIR, 'a.ts')
    const file2 = resolve(TEST_DIR, 'b.ts')
    writeFileSync(file1, 'same content')
    writeFileSync(file2, 'same content')

    const fp1 = computeFileFingerprint(file1)
    const fp2 = computeFileFingerprint(file2)

    expect(fp1!.hash).toBe(fp2!.hash)
    expect(fp1!.size).toBe(fp2!.size)
  })
})

// ============================================
// extractNewNodes
// ============================================

describe('extractNewNodes', () => {
  let assembler: GrokAssembler

  beforeEach(() => {
    assembler = new GrokAssembler(TEST_DIR)
  })

  it('should extract nodes and edges from analysis results', () => {
    const results = [
      {
        symbols: [
          { name: 'foo', kind: 'function', file: 'src/foo.ts', line: 10, signature: 'function foo()', summary: 'does foo' },
          { name: 'Bar', kind: 'class', file: 'src/bar.ts', line: 20, signature: 'class Bar', summary: 'a bar class' },
        ],
        relationships: [
          { from: 'src/foo.ts:foo', to: 'src/bar.ts:Bar', type: 'uses' },
        ],
      },
    ]

    const { newNodes, newEdges } = assembler.extractNewNodes(results, new Set())

    expect(newNodes.length).toBe(2)
    expect(newNodes[0].name).toBe('foo')
    expect(newNodes[0].kind).toBe('function')
    expect(newNodes[0].file).toBe('src/foo.ts')
    expect(newNodes[0].line).toBe(10)
    expect(newEdges.length).toBe(1)
    expect(newEdges[0].type).toBe('uses')
  })

  it('should deduplicate node IDs', () => {
    const results = [
      { symbols: [{ name: 'foo', kind: 'fn', file: 'a.ts', line: 1, signature: '', summary: '' }] },
      { symbols: [{ name: 'foo', kind: 'fn', file: 'a.ts', line: 1, signature: '', summary: '' }] },
    ]

    const { newNodes } = assembler.extractNewNodes(results, new Set())

    expect(newNodes.length).toBe(2)
    expect(newNodes[0].id).not.toBe(newNodes[1].id)
    expect(newNodes[1].id).toContain('#1')
  })

  it('should handle empty results', () => {
    const { newNodes, newEdges } = assembler.extractNewNodes([], new Set())

    expect(newNodes.length).toBe(0)
    expect(newEdges.length).toBe(0)
  })

  it('should handle missing fields gracefully', () => {
    const results = [{ symbols: [{ name: 'x' }] }]

    const { newNodes } = assembler.extractNewNodes(results, new Set())

    expect(newNodes.length).toBe(1)
    expect(newNodes[0].kind).toBe('symbol')
    expect(newNodes[0].file).toBe('')
  })
})

// ============================================
// deduplicateEdges
// ============================================

describe('deduplicateEdges', () => {
  let assembler: GrokAssembler

  beforeEach(() => {
    assembler = new GrokAssembler(TEST_DIR)
  })

  it('should remove duplicate edges', () => {
    const nodes: GraphNode[] = [
      { id: 'a', name: 'a', kind: 'fn', file: '', line: 0, signature: '', summary: '', layer: '', domain: '' },
      { id: 'b', name: 'b', kind: 'fn', file: '', line: 0, signature: '', summary: '', layer: '', domain: '' },
    ]
    const edges: GraphEdge[] = [
      { from: 'a', to: 'b', type: 'calls' },
      { from: 'a', to: 'b', type: 'calls' },
      { from: 'a', to: 'b', type: 'uses' },
    ]

    const result = assembler.deduplicateEdges(nodes, edges)

    expect(result.length).toBe(2)
  })

  it('should remove edges with missing endpoints', () => {
    const nodes: GraphNode[] = [
      { id: 'a', name: 'a', kind: 'fn', file: '', line: 0, signature: '', summary: '', layer: '', domain: '' },
    ]
    const edges: GraphEdge[] = [
      { from: 'a', to: 'b', type: 'calls' },  // b doesn't exist
      { from: '', to: 'a', type: 'calls' },    // empty from
    ]

    const result = assembler.deduplicateEdges(nodes, edges)

    expect(result.length).toBe(0)
  })

  it('should keep valid unique edges', () => {
    const nodes: GraphNode[] = [
      { id: 'a', name: 'a', kind: 'fn', file: '', line: 0, signature: '', summary: '', layer: '', domain: '' },
      { id: 'b', name: 'b', kind: 'fn', file: '', line: 0, signature: '', summary: '', layer: '', domain: '' },
    ]
    const edges: GraphEdge[] = [
      { from: 'a', to: 'b', type: 'calls' },
      { from: 'b', to: 'a', type: 'imports' },
    ]

    const result = assembler.deduplicateEdges(nodes, edges)

    expect(result.length).toBe(2)
  })
})

// ============================================
// assignLayersAndDeps
// ============================================

describe('assignLayersAndDeps', () => {
  let assembler: GrokAssembler

  beforeEach(() => {
    assembler = new GrokAssembler(TEST_DIR)
  })

  it('should assign layers to nodes based on file paths', () => {
    const nodes: GraphNode[] = [
      { id: 'a', name: 'a', kind: 'fn', file: 'src/api/handler.ts', line: 0, signature: '', summary: '', layer: '', domain: '' },
      { id: 'b', name: 'b', kind: 'fn', file: 'src/service/user.ts', line: 0, signature: '', summary: '', layer: '', domain: '' },
    ]
    const edges: GraphEdge[] = []
    const archResult = {
      layers: [
        { name: 'API', modules: ['api'] },
        { name: 'Service', modules: ['service'] },
      ],
      dependencies: [],
    }

    const { domains } = assembler.assignLayersAndDeps(archResult, nodes, edges)

    expect(nodes[0].layer).toBe('API')
    expect(nodes[1].layer).toBe('Service')
    expect(domains.size).toBe(2)
    expect(domains.has('API')).toBe(true)
  })

  it('should add dependency edges from architecture result', () => {
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    const archResult = {
      layers: [],
      dependencies: [
        { from: 'moduleA', to: 'moduleB', type: 'imports' },
      ],
    }

    assembler.assignLayersAndDeps(archResult, nodes, edges)

    expect(edges.length).toBe(1)
    expect(edges[0].from).toBe('moduleA')
    expect(edges[0].type).toBe('imports')
  })

  it('should handle empty architecture result', () => {
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []

    const { domains, layers } = assembler.assignLayersAndDeps({}, nodes, edges)

    expect(domains.size).toBe(0)
    expect(layers.length).toBe(0)
  })
})

// ============================================
// mergeIncrementalNodes
// ============================================

describe('mergeIncrementalNodes', () => {
  let assembler: GrokAssembler

  beforeEach(() => {
    assembler = new GrokAssembler(TEST_DIR)
  })

  it('should remove nodes from changed and removed files', () => {
    const existingGraph = {
      nodes: [
        { id: 'a', name: 'a', kind: 'fn', file: 'old.ts', line: 0, signature: '', summary: '', layer: '', domain: '' },
        { id: 'b', name: 'b', kind: 'fn', file: 'keep.ts', line: 0, signature: '', summary: '', layer: '', domain: '' },
      ],
      edges: [
        { from: 'a', to: 'b', type: 'calls' },
      ],
      metadata: {} as any,
    }
    const changes = { changed: ['old.ts'], added: [], removed: [] }
    const analysisResults = [
      { symbols: [{ name: 'a2', file: 'old.ts' }] },
    ]

    const { nodes, edges } = assembler.mergeIncrementalNodes(existingGraph as any, changes, analysisResults)

    // old.ts should be removed (changed file with new analysis)
    expect(nodes.length).toBe(1)
    expect(nodes[0].file).toBe('keep.ts')
    // edge from removed node should also be removed
    expect(edges.length).toBe(0)
  })

  it('should keep nodes from unchanged files', () => {
    const existingGraph = {
      nodes: [
        { id: 'a', name: 'a', kind: 'fn', file: 'unchanged.ts', line: 0, signature: '', summary: '', layer: '', domain: '' },
      ],
      edges: [],
      metadata: {} as any,
    }
    const changes = { changed: [], added: [], removed: ['deleted.ts'] }
    const analysisResults = []

    const { nodes } = assembler.mergeIncrementalNodes(existingGraph as any, changes, analysisResults)

    expect(nodes.length).toBe(1)
    expect(nodes[0].file).toBe('unchanged.ts')
  })
})

// ============================================
// assembleGraph
// ============================================

describe('assembleGraph', () => {
  let assembler: GrokAssembler

  beforeEach(() => {
    assembler = new GrokAssembler(TEST_DIR)
  })

  it('should assemble graph from analysis results', () => {
    const testFile = resolve(TEST_DIR, 'test.ts')
    writeFileSync(testFile, 'export function hello() {}')

    const scannerResult = { languages: ['typescript'], frameworks: [] }
    const analysisResults = [
      {
        symbols: [{ name: 'hello', kind: 'function', file: testFile, line: 1, signature: 'function hello()', summary: 'says hello' }],
        relationships: [],
      },
    ]
    const archResult = { layers: [], dependencies: [] }
    const tourResult = { tours: [] }
    const reviewResult = { valid: true, issues: [], suggestions: [] }

    const result = assembler.assembleGraph(
      [testFile], scannerResult, analysisResults, archResult,
      tourResult, reviewResult, 'en', []
    )

    expect(result.status).toBe('success')
    expect(result.nodeCount).toBe(1)
    expect(result.edgeCount).toBe(0)
    expect(result.filePath).toContain('knowledge-graph.json')

    // Verify file was written
    expect(existsSync(result.filePath)).toBe(true)
    const saved = JSON.parse(readFileSync(result.filePath, 'utf-8'))
    expect(saved.nodes.length).toBe(1)
    expect(saved.nodes[0].name).toBe('hello')
  })

  it('should return partial status when errors present', () => {
    const result = assembler.assembleGraph(
      [], {}, [], {}, {}, {}, 'en',
      [new GrokError('TEST', 'test', 'test error', true)]
    )

    expect(result.status).toBe('partial')
    expect(result.errors).toBeDefined()
    expect(result.errors!.length).toBe(1)
  })

  it('should handle incremental merge with existing graph', () => {
    const existingGraph: GraphData = {
      nodes: [
        { id: 'old.ts:old', name: 'old', kind: 'fn', file: 'old.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
      ],
      edges: [],
      metadata: {
        lastUpdated: new Date().toISOString(),
        fileCount: 1,
        languages: [],
        frameworks: [],
        layers: [],
        uncovered: 0,
        tour: [],
        review: {},
        language: 'en',
        errors: [],
        fingerprints: {},
      },
    }
    const changes = { changed: ['old.ts'], added: [], removed: [] }
    const analysisResults = [
      { symbols: [{ name: 'new', kind: 'fn', file: 'old.ts', line: 1, signature: '', summary: '' }], relationships: [] },
    ]

    const result = assembler.assembleGraph(
      ['old.ts'], {}, analysisResults, {}, {}, {}, 'en', [],
      existingGraph, changes
    )

    expect(result.status).toBe('success')
    expect(result.nodeCount).toBe(1)
  })
})

// ============================================
// saveGraph
// ============================================

describe('saveGraph', () => {
  it('should create directory and write graph file atomically', () => {
    const assembler = new GrokAssembler(TEST_DIR)
    const graphData: GraphData = {
      nodes: [],
      edges: [],
      metadata: {
        lastUpdated: new Date().toISOString(),
        fileCount: 0,
        languages: [],
        frameworks: [],
        layers: [],
        uncovered: 0,
        tour: [],
        review: {},
        language: 'en',
        errors: [],
        fingerprints: {},
      },
    }

    const filePath = assembler.saveGraph(graphData)

    expect(existsSync(filePath)).toBe(true)
    expect(filePath).toContain('knowledge-graph.json')

    const saved = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(saved.nodes).toEqual([])
    expect(saved.edges).toEqual([])
  })
})
