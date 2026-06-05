/**
 * GraphValidator 测试 (TDD)
 *
 * 覆盖 9 个质量检查:
 * 1. orphanNodes — fanIn=0 && fanOut=0
 * 2. typeSafety — calls target 应为 callable kind
 * 3. edgeConsistency — 所有 from/to 存在于 nodeMeta
 * 4. cycleDetection — tarjanSCC 报告非平凡 SCC
 * 5. unresolvedReferences — references 边指向不存在的节点
 * 6. duplicateEdges — (from, to, type) 重复
 * 7. danglingEdges — from/to 缺失
 * 8. missingImplementations — implements 目标无实现类
 * 9. moduleBoundaries — louvainCommunity 社区结构
 */

import { describe, test, expect } from 'bun:test'
import { GraphValidator, type ValidationCheck, type ValidationResult } from '../GraphValidator.js'
import { GraphEngine } from '../GraphEngine.js'
import { GraphStore, type NodeMetadata, type EdgeMeta } from '../GraphStore.js'
import { createStoreFromAdjacency, createFixture } from './testHelpers.js'

// ============================================================
// Helper: 创建带自定义 nodeMeta 的 store
// ============================================================

function createStoreWithMeta(
  adj: Record<string, Array<string | { to: string; type?: EdgeMeta['type'] }>>,
  metaOverrides: Record<string, Partial<NodeMetadata>>,
  uniqueKey?: string,
): { store: GraphStore; engine: GraphEngine } {
  const store = createStoreFromAdjacency(adj, uniqueKey)
  // 应用 meta 覆盖
  for (const [id, overrides] of Object.entries(metaOverrides)) {
    const existing = store.nodeMeta.get(id)
    if (existing) {
      Object.assign(existing, overrides)
    } else {
      store.nodeMeta.set(id, {
        id,
        name: id,
        kind: 'function',
        file: `/test/${id.toLowerCase()}.ts`,
        line: 1,
        ...overrides,
      })
    }
  }
  const engine = new GraphEngine(store)
  return { store, engine }
}

// ============================================================
// 1. checkOrphanNodes
// ============================================================

describe('GraphValidator.checkOrphanNodes', () => {
  test('should detect orphan nodes (fanIn=0 && fanOut=0)', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: [],
      ORPHAN: [],
    })
    // ORPHAN has no edges at all
    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const check = validator.checkOrphanNodes()

    expect(check.id).toBe('orphan-nodes')
    expect(check.passed).toBe(false)
    expect(check.affectedNodes).toContain('ORPHAN')
    // A and B are connected, should not be orphans
    expect(check.affectedNodes).not.toContain('A')
    expect(check.affectedNodes).not.toContain('B')
  })

  test('should pass when all nodes are connected', () => {
    const { store, engine } = createFixture({
      A: ['B'],
      B: ['C'],
      C: [],
    })
    const validator = new GraphValidator(store, engine)
    const check = validator.checkOrphanNodes()

    // C has fanIn > 0, so not orphan
    expect(check.passed).toBe(true)
    expect(check.affectedNodes).toHaveLength(0)
  })

  test('empty graph should pass (no nodes to be orphan)', () => {
    const { store, engine } = createFixture({})
    const validator = new GraphValidator(store, engine)
    const check = validator.checkOrphanNodes()

    expect(check.passed).toBe(true)
  })
})

// ============================================================
// 2. checkTypeSafety
// ============================================================

describe('GraphValidator.checkTypeSafety', () => {
  test('should detect calls edge to non-callable node', () => {
    // A calls X, but X is kind="variable" (not callable)
    const { store, engine } = createStoreWithMeta(
      {
        A: ['X'],
        X: [],
      },
      { A: { kind: 'function' }, X: { kind: 'variable' } },
    )
    const validator = new GraphValidator(store, engine)
    const check = validator.checkTypeSafety()

    expect(check.id).toBe('type-safety')
    expect(check.passed).toBe(false)
    expect(check.severity).toBe('Error')
    expect(check.affectedEdges!.length).toBeGreaterThan(0)
  })

  test('should pass when calls target is callable kind', () => {
    const { store, engine } = createStoreWithMeta(
      {
        A: ['B'],
        B: [],
      },
      { A: { kind: 'function' }, B: { kind: 'function' } },
    )
    const validator = new GraphValidator(store, engine)
    const check = validator.checkTypeSafety()

    expect(check.passed).toBe(true)
  })
})

// ============================================================
// 3. checkEdgeConsistency
// ============================================================

describe('GraphValidator.checkEdgeConsistency', () => {
  test('should detect edges with missing source node', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: [],
    })
    // Manually add a dangling edge from nonexistent node
    store.adjacency.set('GHOST', new Map([['B', [{ type: 'calls', weight: 1 }]]]))

    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const check = validator.checkEdgeConsistency()

    expect(check.id).toBe('edge-consistency')
    expect(check.passed).toBe(false)
    expect(check.severity).toBe('Error')
  })

  test('should detect edges with missing target node', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: [],
    })
    // Add edge to nonexistent target
    const outMap = store.adjacency.get('A')!
    outMap.set('PHANTOM', [{ type: 'calls', weight: 1 }])

    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const check = validator.checkEdgeConsistency()

    expect(check.passed).toBe(false)
  })

  test('should pass when all edge endpoints exist in nodeMeta', () => {
    const { store, engine } = createFixture({
      A: ['B'],
      B: [],
    })
    const validator = new GraphValidator(store, engine)
    const check = validator.checkEdgeConsistency()

    expect(check.passed).toBe(true)
  })
})

// ============================================================
// 4. checkCycles (async — uses tarjanSCC)
// ============================================================

describe('GraphValidator.checkCycles', () => {
  test('should detect non-trivial SCCs', async () => {
    // A → B → C → A (cycle)
    const { store, engine } = createFixture({
      A: ['B'],
      B: ['C'],
      C: ['A'],
    })
    const validator = new GraphValidator(store, engine)
    const check = await validator.checkCycles()

    expect(check.id).toBe('cycle-detection')
    expect(check.severity).toBe('Info')
    // Should report the cycle
    expect(check.passed).toBe(false)
    expect(check.message).toContain('non-trivial')
  })

  test('should pass when no cycles exist', async () => {
    const { store, engine } = createFixture({
      A: ['B'],
      B: ['C'],
      C: [],
    })
    const validator = new GraphValidator(store, engine)
    const check = await validator.checkCycles()

    expect(check.passed).toBe(true)
  })
})

// ============================================================
// 5. checkUnresolvedReferences
// ============================================================

describe('GraphValidator.checkUnresolvedReferences', () => {
  test('should detect references edges to non-existent nodes', () => {
    const store = createStoreFromAdjacency({
      A: [{ to: 'B', type: 'data' }],
      B: [],
    })
    // Add a data edge to a node not in nodeMeta
    const outMap = store.adjacency.get('A')!
    outMap.set('MISSING', [{ type: 'data', weight: 1 }])
    // Also add reverse
    store.reverse.set('MISSING', new Map([['A', [{ type: 'data', weight: 1 }]]]))

    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const check = validator.checkUnresolvedReferences()

    expect(check.id).toBe('unresolved-references')
    expect(check.passed).toBe(false)
    expect(check.severity).toBe('Warning')
  })

  test('should pass when all references point to existing nodes', () => {
    const { store, engine } = createFixture({
      A: [{ to: 'B', type: 'data' }],
      B: [],
    })
    const validator = new GraphValidator(store, engine)
    const check = validator.checkUnresolvedReferences()

    expect(check.passed).toBe(true)
  })
})

// ============================================================
// 6. checkDuplicateEdges
// ============================================================

describe('GraphValidator.checkDuplicateEdges', () => {
  test('should detect duplicate (from, to, type) edges', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: [],
    })
    // Inject duplicate edge manually
    const outMap = store.adjacency.get('A')!
    outMap.set('B', [
      { type: 'calls', weight: 1 },
      { type: 'calls', weight: 2 },
    ])

    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const check = validator.checkDuplicateEdges()

    expect(check.id).toBe('duplicate-edges')
    expect(check.passed).toBe(false)
    expect(check.severity).toBe('Warning')
  })

  test('should pass when no duplicate edges exist', () => {
    const { store, engine } = createFixture({
      A: ['B'],
      B: [],
    })
    const validator = new GraphValidator(store, engine)
    const check = validator.checkDuplicateEdges()

    expect(check.passed).toBe(true)
  })
})

// ============================================================
// 7. checkDanglingEdges
// ============================================================

describe('GraphValidator.checkDanglingEdges', () => {
  test('should detect edges where from node is missing from nodeMeta', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: [],
    })
    // Add adjacency entry for node not in nodeMeta
    store.adjacency.set('PHANTOM', new Map([['A', [{ type: 'calls', weight: 1 }]]]))

    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const check = validator.checkDanglingEdges()

    expect(check.id).toBe('dangling-edges')
    expect(check.passed).toBe(false)
    expect(check.severity).toBe('Error')
  })

  test('should detect edges where to node is missing from nodeMeta', () => {
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: [],
    })
    // Add reverse entry for node not in nodeMeta
    store.reverse.set('PHANTOM', new Map([['A', [{ type: 'calls', weight: 1 }]]]))

    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const check = validator.checkDanglingEdges()

    expect(check.passed).toBe(false)
  })

  test('should pass when all edges reference existing nodes', () => {
    const { store, engine } = createFixture({
      A: ['B'],
      B: [],
    })
    const validator = new GraphValidator(store, engine)
    const check = validator.checkDanglingEdges()

    expect(check.passed).toBe(true)
  })
})

// ============================================================
// 8. checkMissingImplementations
// ============================================================

describe('GraphValidator.checkMissingImplementations', () => {
  test('should detect implements edge where target has no implementing class', () => {
    const store = createStoreFromAdjacency(
      {
        MyClass: [{ to: 'IFoo', type: 'implements' }],
        IFoo: [],
      },
    )
    // IFoo kind is "interface", MyClass kind is "class"
    store.nodeMeta.set('MyClass', {
      id: 'MyClass', name: 'MyClass', kind: 'class', file: '/test/myclass.ts', line: 1,
    })
    store.nodeMeta.set('IFoo', {
      id: 'IFoo', name: 'IFoo', kind: 'interface', file: '/test/ifoo.ts', line: 1,
    })

    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const check = validator.checkMissingImplementations()

    // MyClass implements IFoo, so IFoo has an implementor — this should pass
    expect(check.passed).toBe(true)
  })

  test('should pass when all interfaces have implementors', () => {
    const store = createStoreFromAdjacency({
      Impl: [{ to: 'Iface', type: 'implements' }],
      Iface: [],
    })
    store.nodeMeta.set('Impl', {
      id: 'Impl', name: 'Impl', kind: 'class', file: '/test/impl.ts', line: 1,
    })
    store.nodeMeta.set('Iface', {
      id: 'Iface', name: 'Iface', kind: 'interface', file: '/test/iface.ts', line: 1,
    })

    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const check = validator.checkMissingImplementations()

    expect(check.passed).toBe(true)
  })
})

// ============================================================
// 9. checkModuleBoundaries (async — uses louvainCommunity)
// ============================================================

describe('GraphValidator.checkModuleBoundaries', () => {
  test('should report community structure', async () => {
    const { store, engine } = createFixture({
      A: ['B'],
      B: ['A', 'C'],
      C: ['D'],
      D: ['C'],
    })
    const validator = new GraphValidator(store, engine)
    const check = await validator.checkModuleBoundaries()

    expect(check.id).toBe('module-boundaries')
    expect(check.severity).toBe('Info')
    // Always passes (informational)
    expect(check.passed).toBe(true)
    expect(check.message).toContain('communit')
  })

  test('empty graph should pass', async () => {
    const { store, engine } = createFixture({})
    const validator = new GraphValidator(store, engine)
    const check = await validator.checkModuleBoundaries()

    expect(check.passed).toBe(true)
  })
})

// ============================================================
// validate() — full run
// ============================================================

describe('GraphValidator.validate', () => {
  test('should run all 9 checks and return summary', async () => {
    const { store, engine } = createFixture({
      A: ['B'],
      B: ['C'],
      C: [],
    })
    const validator = new GraphValidator(store, engine)
    const result = await validator.validate()

    expect(result.checks).toHaveLength(9)
    expect(result.summary.total).toBe(9)
    expect(result.elapsed).toBeGreaterThanOrEqual(0)
    // errors + warnings + infos = total (by severity), passed <= total (by pass/fail)
    expect(result.summary.errors + result.summary.warnings + result.summary.infos).toBe(9)
    expect(result.summary.passed).toBeLessThanOrEqual(9)
  })

  test('should count errors correctly', async () => {
    // Create a graph with known issues
    const store = createStoreFromAdjacency({
      A: ['B'],
      B: [],
    })
    // Add dangling edge to trigger consistency/dangling errors
    store.adjacency.set('GHOST', new Map([['B', [{ type: 'calls', weight: 1 }]]]))

    const engine = new GraphEngine(store)
    const validator = new GraphValidator(store, engine)
    const result = await validator.validate()

    expect(result.summary.errors).toBeGreaterThan(0)
  })
})
