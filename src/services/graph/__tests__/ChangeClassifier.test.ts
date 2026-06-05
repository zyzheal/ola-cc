/**
 * ChangeClassifier Tests (F-22)
 *
 * TDD RED → GREEN → REFACTOR
 * 测试 4 种变更类型的分类逻辑
 */

import { describe, test, expect } from 'bun:test'
import {
  ChangeClassifier,
  type NodeSnapshot,
  type EdgeSnapshot,
  type ClassificationResult,
} from '../ChangeClassifier.js'

const classifier = new ChangeClassifier()

// ============================================================
// Helper: 创建快照
// ============================================================

function node(overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    id: 'node1',
    name: 'foo',
    kind: 'function',
    startLine: 1,
    endLine: 10,
    ...overrides,
  }
}

function edge(overrides: Partial<EdgeSnapshot> = {}): EdgeSnapshot {
  return {
    from: 'node1',
    to: 'node2',
    kind: 'calls',
    ...overrides,
  }
}

// ============================================================
// F-22-1: 签名变更 → signature_change
// ============================================================

describe('ChangeClassifier', () => {
  test('signature change → signature_change', () => {
    const old = [node({ id: '1', signature: 'foo(a: number)' })]
    const now = [node({ id: '1', signature: 'foo(a: string)' })]

    const result = classifier.classify('src/foo.ts', old, now, [], [])
    expect(result.changeType).toBe('signature_change')
    expect(result.requiresRebuild).toBe(true)
  })

  // ----------------------------------------------------------
  // F-22-2: 实现变更 → implementation_change
  // ----------------------------------------------------------

  test('line-only change → implementation_change', () => {
    const old = [node({ id: '1', startLine: 1, endLine: 10 })]
    const now = [node({ id: '1', startLine: 1, endLine: 15 })]

    const result = classifier.classify('src/foo.ts', old, now, [], [])
    expect(result.changeType).toBe('implementation_change')
    expect(result.requiresRebuild).toBe(false)
  })

  // ----------------------------------------------------------
  // F-22-3: import 变更 → import_change
  // ----------------------------------------------------------

  test('import edge added → import_change', () => {
    const nodes = [node({ id: '1' })]
    const oldEdges: EdgeSnapshot[] = []
    const newEdges = [edge({ from: '1', to: '2', kind: 'imports' })]

    const result = classifier.classify('src/foo.ts', nodes, nodes, oldEdges, newEdges)
    expect(result.changeType).toBe('import_change')
    expect(result.requiresRebuild).toBe(false)
  })

  // ----------------------------------------------------------
  // F-22-4: 注释变更 → comment_change
  // ----------------------------------------------------------

  test('docstring-only change → comment_change', () => {
    const old = [node({ id: '1', docstring: 'old doc' })]
    const now = [node({ id: '1', docstring: 'new doc' })]

    const result = classifier.classify('src/foo.ts', old, now, [], [])
    expect(result.changeType).toBe('comment_change')
    expect(result.requiresRebuild).toBe(false)
  })

  // ----------------------------------------------------------
  // F-22-5: 无变更 → unchanged (返回 implementation_change 但 requiresRebuild=false)
  // ----------------------------------------------------------

  test('identical snapshots → no changes detected', () => {
    const nodes = [node({ id: '1' })]
    const edges = [edge()]

    const result = classifier.classify('src/foo.ts', nodes, nodes, edges, edges)
    expect(result.requiresRebuild).toBe(false)
    expect(result.affectedNodes).toEqual([])
  })

  // ----------------------------------------------------------
  // F-22-6: 优先级 — signature > import > implementation > comment
  // ----------------------------------------------------------

  test('mixed changes → returns highest priority type', () => {
    const old = [node({ id: '1', signature: 'foo()', docstring: 'old' })]
    const now = [node({ id: '1', signature: 'bar()', docstring: 'new', endLine: 20 })]

    // signature 变更 + docstring 变更 + line 变更 → signature_change 优先
    const result = classifier.classify('src/foo.ts', old, now, [], [])
    expect(result.changeType).toBe('signature_change')
  })

  // ----------------------------------------------------------
  // F-22-7: call edge added → signature_change (非 import)
  // ----------------------------------------------------------

  test('call edge added → signature_change', () => {
    const nodes = [node({ id: '1' })]
    const newEdges = [edge({ from: '1', to: '2', kind: 'calls' })]

    const result = classifier.classify('src/foo.ts', nodes, nodes, [], newEdges)
    expect(result.changeType).toBe('signature_change')
    expect(result.requiresRebuild).toBe(true)
  })

  // ----------------------------------------------------------
  // F-22-8: 新增节点 → signature_change
  // ----------------------------------------------------------

  test('node added → signature_change', () => {
    const old = [node({ id: '1' })]
    const now = [node({ id: '1' }), node({ id: '2', name: 'bar' })]

    const result = classifier.classify('src/foo.ts', old, now, [], [])
    expect(result.changeType).toBe('signature_change')
    expect(result.affectedNodes).toContain('2')
  })

  // ----------------------------------------------------------
  // F-22-9: 删除节点 → signature_change
  // ----------------------------------------------------------

  test('node removed → signature_change', () => {
    const old = [node({ id: '1' }), node({ id: '2', name: 'bar' })]
    const now = [node({ id: '1' })]

    const result = classifier.classify('src/foo.ts', old, now, [], [])
    expect(result.changeType).toBe('signature_change')
    expect(result.affectedNodes).toContain('2')
  })
})
