/**
 * QueryCache — Prepared Statement 缓存层 (F-56)
 *
 * 为 bun:sqlite 的重复查询提供 prepared statement 缓存，
 * 避免每次查询都重新解析 SQL。
 *
 * 设计文档: Phase Z2 — Query Optimization
 */

import { Database } from 'bun:sqlite'
import type { NodeMetadata, EdgeType } from './GraphStore.js'

// ============================================================
// Types
// ============================================================

interface CachedEdge {
  target: string
  kind: string
}

// ============================================================
// QueryCache
// ============================================================

export class QueryCache {
  private statements = new Map<string, ReturnType<Database['query']>>()
  private closed = false

  constructor(private db: Database) {}

  /**
   * 获取或创建 prepared statement（惰性缓存）
   */
  prepare(sql: string): ReturnType<Database['query']> {
    if (this.closed) {
      throw new Error('QueryCache is closed')
    }

    let stmt = this.statements.get(sql)
    if (!stmt) {
      stmt = this.db.query(sql)
      this.statements.set(sql, stmt)
    }
    return stmt
  }

  /**
   * 批量获取节点元数据（WHERE id IN (...)）
   * 大批量自动分块，每块最多 500 个 ID
   */
  getNodesByIds(ids: string[], existingColumns?: string[]): NodeMetadata[] {
    if (ids.length === 0) return []

    const columns = existingColumns ?? this.getColumns('nodes')
    const selectClause = columns.join(', ')
    const CHUNK_SIZE = 500
    const results: NodeMetadata[] = []

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(', ')
      const sql = `SELECT ${selectClause} FROM nodes WHERE id IN (${placeholders})`
      const stmt = this.prepare(sql)
      const rows = stmt.all(...chunk) as Array<Record<string, unknown>>

      for (const row of rows) {
        results.push(this.rowToNodeMeta(row))
      }
    }

    return results
  }

  /**
   * 按文件路径获取节点
   */
  getNodesByFile(filePath: string, existingColumns?: string[]): NodeMetadata[] {
    const columns = existingColumns ?? this.getColumns('nodes')
    const selectClause = columns.join(', ')
    const sql = `SELECT ${selectClause} FROM nodes WHERE file_path = ?`
    const stmt = this.prepare(sql)
    const rows = stmt.all(filePath) as Array<Record<string, unknown>>
    return rows.map(row => this.rowToNodeMeta(row))
  }

  /**
   * 按源节点获取出边
   */
  getEdgesBySource(sourceId: string): CachedEdge[] {
    const sql = 'SELECT target, kind FROM edges WHERE source = ?'
    const stmt = this.prepare(sql)
    return stmt.all(sourceId) as CachedEdge[]
  }

  /**
   * 按目标节点获取入边
   */
  getEdgesByTarget(targetId: string): CachedEdge[] {
    const sql = 'SELECT source, kind FROM edges WHERE target = ?'
    const stmt = this.prepare(sql)
    return stmt.all(targetId) as CachedEdge[]
  }

  /**
   * 获取表的列名列表
   */
  getColumns(table: string): string[] {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`)
    }
    const sql = `PRAGMA table_info(${table})`
    const rows = this.db.query(sql).all() as Array<{ name: string }>
    return rows.map(r => r.name)
  }

  /**
   * 关闭所有 prepared statements 和数据库连接
   */
  close(): void {
    this.closed = true
    this.statements.clear()
  }

  /**
   * 缓存的 statement 数量
   */
  get cacheSize(): number {
    return this.statements.size
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private rowToNodeMeta(row: Record<string, unknown>): NodeMetadata {
    const meta: NodeMetadata = {
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as string,
      file: (row.file_path ?? '') as string,
      line: (row.start_line ?? 0) as number,
    }

    if (row.signature != null) meta.signature = row.signature as string
    if (row.qualified_name != null) meta.qualified_name = row.qualified_name as string
    if (row.end_line != null) meta.end_line = row.end_line as number
    if (row.docstring != null) meta.docstring = row.docstring as string
    if (row.language != null) meta.language = row.language as string
    if (row.visibility != null) meta.visibility = row.visibility as string
    if (row.is_exported != null) meta.is_exported = !!row.is_exported
    if (row.is_async != null) meta.is_async = !!row.is_async
    if (row.is_static != null) meta.is_static = !!row.is_static
    if (row.is_abstract != null) meta.is_abstract = !!row.is_abstract
    if (row.start_column != null) meta.start_column = row.start_column as number
    if (row.end_column != null) meta.end_column = row.end_column as number
    if (row.decorators != null) meta.decorators = parseJsonArray(row.decorators as string)
    if (row.type_parameters != null) meta.type_parameters = parseJsonArray(row.type_parameters as string)
    if (row.updated_at != null) meta.updated_at = row.updated_at as number
    if (row.provenance != null) meta.provenance = row.provenance as string

    return meta
  }
}

// ============================================================
// Helpers
// ============================================================

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
