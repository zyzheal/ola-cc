/**
 * QueryCache 测试 (F-56)
 *
 * 使用临时 SQLite 数据库验证 prepared statement 缓存和批量查询。
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { QueryCache } from '../QueryCache.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync, existsSync } from 'fs'

describe('QueryCache', () => {
  let dbPath: string
  let db: Database
  let cache: QueryCache

  beforeEach(() => {
    dbPath = join(tmpdir(), `querycache-test-${Date.now()}.db`)
    db = new Database(dbPath)

    // 创建测试表
    db.run(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        signature TEXT,
        qualified_name TEXT,
        language TEXT,
        visibility TEXT,
        is_exported INTEGER,
        is_async INTEGER,
        is_static INTEGER
      )
    `)

    db.run(`
      CREATE TABLE edges (
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL
      )
    `)

    // 插入测试数据
    db.run(`INSERT INTO nodes (id, name, kind, file_path, start_line, signature, qualified_name)
            VALUES ('n1', 'Foo', 'class', 'src/foo.ts', 1, 'class Foo', 'src.Foo')`)
    db.run(`INSERT INTO nodes (id, name, kind, file_path, start_line, signature, qualified_name)
            VALUES ('n2', 'Bar', 'method', 'src/foo.ts', 10, 'bar(): void', 'src.Foo.bar')`)
    db.run(`INSERT INTO nodes (id, name, kind, file_path, start_line, signature, qualified_name)
            VALUES ('n3', 'Baz', 'function', 'src/baz.ts', 1, 'baz(x: number)', 'src.baz')`)

    db.run(`INSERT INTO edges (source, target, kind) VALUES ('n1', 'n2', 'calls')`)
    db.run(`INSERT INTO edges (source, target, kind) VALUES ('n1', 'n3', 'imports')`)
    db.run(`INSERT INTO edges (source, target, kind) VALUES ('n2', 'n3', 'calls')`)

    cache = new QueryCache(db)
  })

  afterEach(() => {
    cache.close()
    db.close()
    if (existsSync(dbPath)) unlinkSync(dbPath)
  })

  describe('prepare', () => {
    it('缓存 prepared statement', () => {
      const sql = 'SELECT * FROM nodes WHERE id = ?'
      const stmt1 = cache.prepare(sql)
      const stmt2 = cache.prepare(sql)
      expect(stmt1).toBe(stmt2) // 同一引用
      expect(cache.cacheSize).toBe(1)
    })

    it('不同 SQL 创建不同 statement', () => {
      cache.prepare('SELECT * FROM nodes WHERE id = ?')
      cache.prepare('SELECT * FROM edges WHERE source = ?')
      expect(cache.cacheSize).toBe(2)
    })

    it('关闭后 prepare 抛出错误', () => {
      cache.close()
      expect(() => cache.prepare('SELECT 1')).toThrow('QueryCache is closed')
    })
  })

  describe('getNodesByIds', () => {
    it('批量获取存在的节点', () => {
      const nodes = cache.getNodesByIds(['n1', 'n2'])
      expect(nodes).toHaveLength(2)
      expect(nodes[0].id).toBe('n1')
      expect(nodes[0].name).toBe('Foo')
      expect(nodes[1].id).toBe('n2')
      expect(nodes[1].name).toBe('Bar')
    })

    it('不存在的 ID 被跳过', () => {
      const nodes = cache.getNodesByIds(['n1', 'nonexistent', 'n3'])
      expect(nodes).toHaveLength(2)
      expect(nodes.map(n => n.id)).toEqual(['n1', 'n3'])
    })

    it('空数组返回空结果', () => {
      const nodes = cache.getNodesByIds([])
      expect(nodes).toHaveLength(0)
    })

    it('节点元数据完整映射', () => {
      const nodes = cache.getNodesByIds(['n1'])
      expect(nodes[0]).toEqual({
        id: 'n1',
        name: 'Foo',
        kind: 'class',
        file: 'src/foo.ts',
        line: 1,
        signature: 'class Foo',
        qualified_name: 'src.Foo',
      })
    })

    it('大批量分块处理（超过 CHUNK_SIZE=500）', () => {
      // 插入大量节点
      const insertStmt = db.prepare('INSERT INTO nodes (id, name, kind, file_path, start_line) VALUES (?, ?, ?, ?, ?)')
      for (let i = 100; i < 700; i++) {
        insertStmt.run(`bulk_${i}`, `Node${i}`, 'function', 'src/bulk.ts', i)
      }

      const ids = Array.from({ length: 600 }, (_, i) => `bulk_${i + 100}`)
      const nodes = cache.getNodesByIds(ids)
      expect(nodes).toHaveLength(600)
    })
  })

  describe('getNodesByFile', () => {
    it('获取指定文件的节点', () => {
      const nodes = cache.getNodesByFile('src/foo.ts')
      expect(nodes).toHaveLength(2)
      expect(nodes.map(n => n.name).sort()).toEqual(['Bar', 'Foo'])
    })

    it('不存在的文件返回空数组', () => {
      const nodes = cache.getNodesByFile('nonexistent.ts')
      expect(nodes).toHaveLength(0)
    })
  })

  describe('getEdgesBySource', () => {
    it('获取源节点的出边', () => {
      const edges = cache.getEdgesBySource('n1')
      expect(edges).toHaveLength(2)
      expect(edges.map(e => e.target).sort()).toEqual(['n2', 'n3'])
    })

    it('不存在的源节点返回空数组', () => {
      const edges = cache.getEdgesBySource('nonexistent')
      expect(edges).toHaveLength(0)
    })
  })

  describe('getEdgesByTarget', () => {
    it('获取目标节点的入边', () => {
      const edges = cache.getEdgesByTarget('n3')
      expect(edges).toHaveLength(2)
      expect(edges.map(e => e.source).sort()).toEqual(['n1', 'n2'])
    })
  })

  describe('getColumns', () => {
    it('获取表的列名', () => {
      const columns = cache.getColumns('nodes')
      expect(columns).toContain('id')
      expect(columns).toContain('name')
      expect(columns).toContain('kind')
      expect(columns).toContain('file_path')
      expect(columns).toContain('start_line')
    })
  })
})
