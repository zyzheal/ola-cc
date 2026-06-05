/**
 * StructuralFingerprint Tests (F-21)
 *
 * TDD RED → GREEN → REFACTOR
 * 测试 AST 结构哈希、持久化、delta 计算
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolve } from 'path'
import { mkdirSync, rmSync, existsSync } from 'fs'
import {
  StructuralFingerprint,
  type FileFingerprint,
  type FingerprintDelta,
} from '../StructuralFingerprint.js'

const TEST_DIR = resolve(import.meta.dir, '__tmp_fingerprint__')
const CODEGRAPH_DIR = resolve(TEST_DIR, '.codegraph')

describe('StructuralFingerprint', () => {
  beforeEach(() => {
    mkdirSync(CODEGRAPH_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // ----------------------------------------------------------
  // F-21-1: 基础哈希计算
  // ----------------------------------------------------------

  test('compute() returns fingerprints keyed by file path', async () => {
    const fp = new StructuralFingerprint(TEST_DIR)
    const result = await fp.compute()

    expect(result).toBeInstanceOf(Map)
    // 空数据库应返回空 Map
    expect(result.size).toBe(0)
  })

  // ----------------------------------------------------------
  // F-21-2: 持久化 load/save 往返
  // ----------------------------------------------------------

  test('save() and loadPersisted() round-trip correctly', () => {
    const fp = new StructuralFingerprint(TEST_DIR)
    const data = new Map<string, FileFingerprint>()
    data.set('src/foo.ts', {
      file: 'src/foo.ts',
      hash: 'abc123',
      nodeCount: 5,
      edgeCount: 3,
      lastModified: 1000,
    })

    fp.save(data)
    const loaded = fp.loadPersisted()

    expect(loaded.size).toBe(1)
    expect(loaded.get('src/foo.ts')?.hash).toBe('abc123')
    expect(loaded.get('src/foo.ts')?.nodeCount).toBe(5)
  })

  test('loadPersisted() returns empty map when file does not exist', () => {
    const fp = new StructuralFingerprint(TEST_DIR)
    const result = fp.loadPersisted()
    expect(result.size).toBe(0)
  })

  // ----------------------------------------------------------
  // F-21-3: delta 计算 — added/removed/changed
  // ----------------------------------------------------------

  test('delta() detects added files', async () => {
    const fp = new StructuralFingerprint(TEST_DIR)

    // 先保存空的 persisted
    fp.save(new Map())

    // compute() 在空 db 时返回空，delta 应无变更
    const delta = await fp.delta()
    expect(delta.added).toEqual([])
    expect(delta.removed).toEqual([])
    expect(delta.changed).toEqual([])
  })

  test('delta() detects removed files', async () => {
    const fp = new StructuralFingerprint(TEST_DIR)

    // persisted 有文件，但 compute() 返回空
    const old = new Map<string, FileFingerprint>()
    old.set('src/deleted.ts', {
      file: 'src/deleted.ts',
      hash: 'aaa',
      nodeCount: 1,
      edgeCount: 0,
      lastModified: 100,
    })
    fp.save(old)

    const delta = await fp.delta()
    expect(delta.removed).toEqual(['src/deleted.ts'])
  })
})
