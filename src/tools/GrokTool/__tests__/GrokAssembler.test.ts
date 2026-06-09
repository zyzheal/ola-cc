/**
 * GrokAssembler 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokAssembler.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { GrokAssembler, computeFileFingerprint, normalizeKind, validateGraphNode, validateGraphEdge, validateGraphData } from '../GrokAssembler.js'
import type { ReviewResult } from '../GrokAssembler.js'
import type { GraphNode, GraphEdge, GraphData } from '../GrokTypes.js'
import { GrokError } from '../GrokTypes.js'

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

    const result = assembler.assembleGraph({
      files: [testFile], scannerResult, analysisResults, architectureResult: archResult,
      tourResult, reviewResult, language: 'en', errors: []
    })

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
    const result = assembler.assembleGraph({
      files: [], scannerResult: {}, analysisResults: [], architectureResult: {},
      tourResult: {}, reviewResult: {}, language: 'en',
      errors: [new GrokError('TEST', 'test', 'test error', true)]
    })

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

    const result = assembler.assembleGraph({
      files: ['old.ts'], scannerResult: {}, analysisResults, architectureResult: {},
      tourResult: {}, reviewResult: {}, language: 'en', errors: [],
      existingGraph, changes
    })

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

// ============================================
// normalizeKind — LLM kind 变体映射
// ============================================

describe('normalizeKind', () => {
  it('should map fn → function', () => {
    expect(normalizeKind('fn')).toBe('function')
  })

  it('should map proc → procedure', () => {
    expect(normalizeKind('proc')).toBe('procedure')
  })

  it('should map const → constant', () => {
    expect(normalizeKind('const')).toBe('constant')
  })

  it('should map class_method → method', () => {
    expect(normalizeKind('class_method')).toBe('method')
  })

  it('should map iface → interface', () => {
    expect(normalizeKind('iface')).toBe('interface')
  })

  it('should map enum_type → enum', () => {
    expect(normalizeKind('enum_type')).toBe('enum')
  })

  it('should pass through canonical kinds unchanged', () => {
    expect(normalizeKind('function')).toBe('function')
    expect(normalizeKind('class')).toBe('class')
    expect(normalizeKind('interface')).toBe('interface')
    expect(normalizeKind('enum')).toBe('enum')
  })

  it('should be case-insensitive', () => {
    expect(normalizeKind('FN')).toBe('function')
    expect(normalizeKind('Class_Method')).toBe('method')
  })

  it('should return original string for unknown kinds', () => {
    expect(normalizeKind('widget')).toBe('widget')
    expect(normalizeKind('')).toBe('symbol')
  })
})

// ============================================
// Zod Validation — validateGraphNode / validateGraphEdge / validateGraphData
// ============================================

describe('Zod validation', () => {
  describe('validateGraphNode', () => {
    it('should accept a valid node', () => {
      const node = { id: 'a.ts:foo', name: 'foo', kind: 'function', file: 'a.ts', line: 1, signature: 'fn()', summary: 'test', layer: '', domain: '' }
      const result = validateGraphNode(node)
      expect(result.success).toBe(true)
      expect(result.data!.kind).toBe('function')
    })

    it('should normalize kind on valid node', () => {
      const node = { id: 'a.ts:foo', name: 'foo', kind: 'fn', file: 'a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' }
      const result = validateGraphNode(node)
      expect(result.success).toBe(true)
      expect(result.data!.kind).toBe('function')
    })

    it('should reject node with missing required fields', () => {
      const node = { name: 'foo', kind: 'function' }
      const result = validateGraphNode(node)
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('should reject node with wrong types', () => {
      const node = { id: 123, name: 'foo', kind: 'function', file: 'a.ts', line: 'not-a-number', signature: '', summary: '', layer: '', domain: '' }
      const result = validateGraphNode(node)
      expect(result.success).toBe(false)
    })
  })

  describe('validateGraphEdge', () => {
    it('should accept a valid edge', () => {
      const edge = { from: 'a.ts:foo', to: 'b.ts:bar', type: 'calls' }
      const result = validateGraphEdge(edge)
      expect(result.success).toBe(true)
    })

    it('should reject edge with missing fields', () => {
      const edge = { from: 'a.ts:foo' }
      const result = validateGraphEdge(edge)
      expect(result.success).toBe(false)
    })

    it('should reject edge with wrong types', () => {
      const edge = { from: 123, to: 'b.ts:bar', type: 'calls' }
      const result = validateGraphEdge(edge)
      expect(result.success).toBe(false)
    })
  })

  describe('validateGraphData', () => {
    it('should accept valid graph data', () => {
      const data = {
        nodes: [
          { id: 'a.ts:foo', name: 'foo', kind: 'function', file: 'a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
        ],
        edges: [
          { from: 'a.ts:foo', to: 'a.ts:foo', type: 'calls' },
        ],
      }
      const result = validateGraphData(data)
      expect(result.success).toBe(true)
      expect(result.validNodes).toBe(1)
      expect(result.validEdges).toBe(1)
      expect(result.invalidNodes).toBe(0)
      expect(result.invalidEdges).toBe(0)
    })

    it('should skip invalid nodes and keep valid ones', () => {
      const data = {
        nodes: [
          { id: 'a.ts:foo', name: 'foo', kind: 'function', file: 'a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
          { name: 'bad' }, // missing required fields
        ],
        edges: [],
      }
      const result = validateGraphData(data)
      expect(result.success).toBe(true)
      expect(result.validNodes).toBe(1)
      expect(result.invalidNodes).toBe(1)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('should skip invalid edges and keep valid ones', () => {
      const data = {
        nodes: [
          { id: 'a.ts:foo', name: 'foo', kind: 'fn', file: 'a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
        ],
        edges: [
          { from: 'a.ts:foo', to: 'a.ts:foo', type: 'calls' },
          { from: 'a.ts:foo' }, // missing 'to' and 'type'
        ],
      }
      const result = validateGraphData(data)
      expect(result.validEdges).toBe(1)
      expect(result.invalidEdges).toBe(1)
    })

    it('should report low pass rate warning', () => {
      const data = {
        nodes: [
          { id: 'a', name: 'a', kind: 'fn', file: 'a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
          { name: 'bad1' },
          { name: 'bad2' },
          { name: 'bad3' },
          { name: 'bad4' },
        ],
        edges: [],
      }
      const result = validateGraphData(data)
      expect(result.passRate).toBeLessThan(0.8)
      expect(result.warnings.length).toBeGreaterThan(0)
    })
  })
})

// ============================================
// assembleReview — ID 规范化 + 去重 + 边完整性
// ============================================

describe('assembleReview', () => {
  let assembler: GrokAssembler

  beforeEach(() => {
    assembler = new GrokAssembler(TEST_DIR)
  })

  it('should normalize IDs by stripping #counter suffixes', () => {
    const nodes: GraphNode[] = [
      { id: 'a.ts:foo#1', name: 'foo', kind: 'function', file: 'a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
      { id: 'b.ts:bar#2', name: 'bar', kind: 'function', file: 'b.ts', line: 2, signature: '', summary: '', layer: '', domain: '' },
    ]
    const edges: GraphEdge[] = []

    const { nodes: result, review } = assembler.assembleReview(nodes, edges)

    expect(result[0].id).toBe('a.ts:foo')
    expect(result[1].id).toBe('b.ts:bar')
    expect(review.normalizedIds).toBe(2)
  })

  it('should remove duplicate nodes by {file, name} preferring richer metadata', () => {
    const nodes: GraphNode[] = [
      { id: 'a.ts:foo', name: 'foo', kind: 'function', file: 'a.ts', line: 1, signature: 'old', summary: 'old', layer: '', domain: '' },
      { id: 'a.ts:foo', name: 'foo', kind: 'method', file: 'a.ts', line: 10, signature: 'new', summary: 'new', layer: 'service', domain: 'auth' },
    ]
    const edges: GraphEdge[] = []

    const { nodes: result, review } = assembler.assembleReview(nodes, edges)

    expect(result.length).toBe(1)
    expect(result[0].signature).toBe('new')
    expect(result[0].layer).toBe('service')
    expect(review.duplicatesRemoved).toBe(1)
    expect(review.beforeNodes).toBe(2)
    expect(review.afterNodes).toBe(1)
  })

  it('should remove dangling edges referencing non-existent nodes', () => {
    const nodes: GraphNode[] = [
      { id: 'a.ts:foo', name: 'foo', kind: 'function', file: 'a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
    ]
    const edges: GraphEdge[] = [
      { from: 'a.ts:foo', to: 'b.ts:missing', type: 'calls' },
      { from: 'c.ts:gone', to: 'a.ts:foo', type: 'imports' },
    ]

    const { edges: result, review } = assembler.assembleReview(nodes, edges)

    expect(result.length).toBe(0)
    expect(review.danglingEdgesRemoved).toBe(2)
  })

  it('should keep valid edges', () => {
    const nodes: GraphNode[] = [
      { id: 'a.ts:foo', name: 'foo', kind: 'function', file: 'a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
      { id: 'b.ts:bar', name: 'bar', kind: 'function', file: 'b.ts', line: 2, signature: '', summary: '', layer: '', domain: '' },
    ]
    const edges: GraphEdge[] = [
      { from: 'a.ts:foo', to: 'b.ts:bar', type: 'calls' },
    ]

    const { edges: result, review } = assembler.assembleReview(nodes, edges)

    expect(result.length).toBe(1)
    expect(review.danglingEdgesRemoved).toBe(0)
  })

  it('should report correct before/after counts', () => {
    const nodes: GraphNode[] = [
      { id: 'a.ts:foo#1', name: 'foo', kind: 'fn', file: 'a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
      { id: 'a.ts:foo#2', name: 'foo', kind: 'fn', file: 'a.ts', line: 5, signature: 'dup', summary: '', layer: '', domain: '' },
      { id: 'b.ts:bar', name: 'bar', kind: 'fn', file: 'b.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
    ]
    const edges: GraphEdge[] = [
      { from: 'a.ts:foo', to: 'b.ts:bar', type: 'calls' },
      { from: 'a.ts:foo', to: 'c.ts:missing', type: 'uses' },
    ]

    const { nodes: resultNodes, edges: resultEdges, review } = assembler.assembleReview(nodes, edges)

    expect(review.beforeNodes).toBe(3)
    expect(review.afterNodes).toBe(resultNodes.length)
    expect(review.beforeEdges).toBe(2)
    expect(review.afterEdges).toBe(resultEdges.length)
    expect(review.normalizedIds).toBeGreaterThanOrEqual(2)
    expect(review.duplicatesRemoved).toBeGreaterThanOrEqual(1)
    expect(review.danglingEdgesRemoved).toBe(1)
  })

  it('should handle empty inputs', () => {
    const { nodes, edges, review } = assembler.assembleReview([], [])

    expect(nodes).toEqual([])
    expect(edges).toEqual([])
    expect(review.beforeNodes).toBe(0)
    expect(review.afterNodes).toBe(0)
    expect(review.duplicatesRemoved).toBe(0)
    expect(review.danglingEdgesRemoved).toBe(0)
    expect(review.normalizedIds).toBe(0)
  })

  it('should remap edge endpoints when dedup removes nodes (regression: 0 edges bug)', () => {
    // Simulates the real scenario: GraphStore node + LLM node for same file:name
    // LLM edges reference the LLM node ID, but dedup keeps GraphStore node (better metadata)
    const nodes: GraphNode[] = [
      // GraphStore node (has layer/domain — higher score)
      { id: 'src/svc/user.ts:createUser', name: 'createUser', kind: 'function', file: 'src/svc/user.ts', line: 10, signature: '(): User', summary: 'Creates a user', layer: 'service', domain: 'auth' },
      // LLM node (no layer/domain — lower score, will be deduped)
      { id: 'src/svc/user.ts:createUser#1', name: 'createUser', kind: 'function', file: 'src/svc/user.ts', line: 10, signature: '', summary: '', layer: '', domain: '' },
      // Target node
      { id: 'src/svc/db.ts:saveUser', name: 'saveUser', kind: 'function', file: 'src/svc/db.ts', line: 20, signature: '(): void', summary: '', layer: 'data', domain: '' },
    ]
    // Edge references the LLM node ID (will be removed by dedup)
    const edges: GraphEdge[] = [
      { from: 'src/svc/user.ts:createUser#1', to: 'src/svc/db.ts:saveUser', type: 'calls' },
    ]

    const { nodes: resultNodes, edges: resultEdges, review } = assembler.assembleReview(nodes, edges)

    // Dedup should keep the richer node
    expect(resultNodes.length).toBe(2)
    expect(resultNodes.find(n => n.id === 'src/svc/user.ts:createUser')?.layer).toBe('service')

    // Edge should be remapped to the kept node — NOT dropped as dangling
    expect(resultEdges.length).toBe(1)
    expect(resultEdges[0].from).toBe('src/svc/user.ts:createUser')
    expect(resultEdges[0].to).toBe('src/svc/db.ts:saveUser')
    expect(review.duplicatesRemoved).toBe(1)
    expect(review.danglingEdgesRemoved).toBe(0)
  })

  it('should resolve short name references in deduplicateEdges', () => {
    const nodes: GraphNode[] = [
      { id: 'src/a.ts:foo', name: 'foo', kind: 'function', file: 'src/a.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
      { id: 'src/b.ts:bar', name: 'bar', kind: 'function', file: 'src/b.ts', line: 1, signature: '', summary: '', layer: '', domain: '' },
    ]
    // Edges use short names (as LLM often returns)
    const edges: GraphEdge[] = [
      { from: 'foo', to: 'bar', type: 'calls' },
      { from: 'a.ts:foo', to: 'b.ts:bar', type: 'imports' },
    ]

    const result = assembler.deduplicateEdges(nodes, edges)

    expect(result.length).toBe(2)
    expect(result[0].from).toBe('src/a.ts:foo')
    expect(result[0].to).toBe('src/b.ts:bar')
    expect(result[1].from).toBe('src/a.ts:foo')
    expect(result[1].to).toBe('src/b.ts:bar')
  })
})
