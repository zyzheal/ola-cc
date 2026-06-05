/**
 * RollbackManager 测试
 *
 * 使用临时目录避免污染项目文件系统。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { RollbackManager } from '../RollbackManager.js'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

// ============================================================
// Test fixtures
// ============================================================

let tempDir: string

function makeTempDir(): string {
  const dir = join(tmpdir(), `rollback-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeKnowledgeGraph(dir: string, nodes: string[], edges: Array<{ from: string; to: string }>) {
  const uaDir = join(dir, '.understand-anything')
  mkdirSync(uaDir, { recursive: true })
  const kgPath = join(uaDir, 'knowledge-graph.json')
  writeFileSync(kgPath, JSON.stringify({ nodes: nodes.map(n => ({ id: n })), edges }, null, 2))
}

// ============================================================
// Tests
// ============================================================

describe('RollbackManager', () => {
  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('createRollback', () => {
    test('creates backup file and metadata', () => {
      writeKnowledgeGraph(tempDir, ['A', 'B'], [{ from: 'A', to: 'B' }])
      const manager = new RollbackManager(tempDir)

      const point = manager.createRollback('test backup')

      expect(point.tag).toBeTruthy()
      expect(point.description).toBe('test backup')
      expect(point.nodeCount).toBe(2)
      expect(point.edgeCount).toBe(1)
      expect(point.timestamp).toBeGreaterThan(0)

      // 备份文件应存在
      const backupDir = join(tempDir, '.understand-anything', 'backups')
      expect(existsSync(join(backupDir, `knowledge-graph.${point.tag}.json`))).toBe(true)
      expect(existsSync(join(backupDir, `knowledge-graph.${point.tag}.meta.json`))).toBe(true)
    })

    test('throws when knowledge-graph.json does not exist', () => {
      const manager = new RollbackManager(tempDir)

      expect(() => manager.createRollback('no file')).toThrow('knowledge-graph.json not found')
    })

    test('creates backups directory if missing', () => {
      writeKnowledgeGraph(tempDir, ['A'], [])
      const manager = new RollbackManager(tempDir)

      const point = manager.createRollback('create dir')

      const backupDir = join(tempDir, '.understand-anything', 'backups')
      expect(existsSync(backupDir)).toBe(true)
    })
  })

  describe('listRollbacks', () => {
    test('returns empty array when no backups exist', () => {
      writeKnowledgeGraph(tempDir, ['A'], [])
      const manager = new RollbackManager(tempDir)

      expect(manager.listRollbacks()).toEqual([])
    })

    test('returns rollbacks sorted by timestamp descending', () => {
      writeKnowledgeGraph(tempDir, ['A', 'B'], [])
      const manager = new RollbackManager(tempDir)

      const p1 = manager.createRollback('first')
      // 确保时间戳不同
      const p2 = manager.createRollback('second')

      const rollbacks = manager.listRollbacks()

      expect(rollbacks.length).toBe(2)
      // 最新的在前
      expect(rollbacks[0].timestamp).toBeGreaterThanOrEqual(rollbacks[1].timestamp)
    })

    test('skips corrupted meta files', () => {
      writeKnowledgeGraph(tempDir, ['A'], [])
      const manager = new RollbackManager(tempDir)

      manager.createRollback('valid')

      // 写入损坏的元数据
      const backupDir = join(tempDir, '.understand-anything', 'backups')
      writeFileSync(join(backupDir, 'knowledge-graph.corrupt.meta.json'), 'not json')

      const rollbacks = manager.listRollbacks()
      expect(rollbacks.length).toBe(1)
      expect(rollbacks[0].description).toBe('valid')
    })
  })

  describe('rollback', () => {
    test('restores graph to backup state', () => {
      writeKnowledgeGraph(tempDir, ['A', 'B', 'C'], [{ from: 'A', to: 'B' }])
      const manager = new RollbackManager(tempDir)

      const point = manager.createRollback('original')

      // 修改当前图
      writeKnowledgeGraph(tempDir, ['X', 'Y', 'Z', 'W'], [{ from: 'X', to: 'Y' }])

      // 回滚
      const result = manager.rollback(point.tag)
      expect(result).toBe(true)

      // 验证回滚后的数据
      const kgPath = join(tempDir, '.understand-anything', 'knowledge-graph.json')
      const restored = JSON.parse(readFileSync(kgPath, 'utf-8'))
      expect(restored.nodes.length).toBe(3)
    })

    test('creates safety backup before rollback', () => {
      writeKnowledgeGraph(tempDir, ['A'], [])
      const manager = new RollbackManager(tempDir)

      const point = manager.createRollback('v1')
      writeKnowledgeGraph(tempDir, ['B', 'C'], [])
      manager.rollback(point.tag)

      // 应该有 pre-rollback 安全备份
      const rollbacks = manager.listRollbacks()
      const safetyBackup = rollbacks.find(r => r.tag.startsWith('pre-rollback-'))
      expect(safetyBackup).toBeDefined()
    })

    test('returns false for non-existent tag', () => {
      writeKnowledgeGraph(tempDir, ['A'], [])
      const manager = new RollbackManager(tempDir)

      expect(manager.rollback('nonexistent')).toBe(false)
    })
  })

  describe('deleteRollback', () => {
    test('removes backup and metadata files', () => {
      writeKnowledgeGraph(tempDir, ['A'], [])
      const manager = new RollbackManager(tempDir)

      const point = manager.createRollback('to delete')
      expect(manager.deleteRollback(point.tag)).toBe(true)

      const rollbacks = manager.listRollbacks()
      expect(rollbacks.length).toBe(0)
    })

    test('returns false for non-existent tag', () => {
      writeKnowledgeGraph(tempDir, ['A'], [])
      const manager = new RollbackManager(tempDir)

      expect(manager.deleteRollback('nonexistent')).toBe(false)
    })
  })

  describe('prune', () => {
    test('keeps only maxKeep most recent rollbacks', () => {
      writeKnowledgeGraph(tempDir, ['A'], [])
      const manager = new RollbackManager(tempDir)

      // 创建 5 个回滚点
      for (let i = 0; i < 5; i++) {
        manager.createRollback(`backup ${i}`)
      }

      expect(manager.listRollbacks().length).toBe(5)

      const pruned = manager.prune(3)

      expect(pruned).toBe(2)
      expect(manager.listRollbacks().length).toBe(3)
    })

    test('returns 0 when no pruning needed', () => {
      writeKnowledgeGraph(tempDir, ['A'], [])
      const manager = new RollbackManager(tempDir)

      manager.createRollback('only one')

      expect(manager.prune(10)).toBe(0)
      expect(manager.listRollbacks().length).toBe(1)
    })
  })
})
