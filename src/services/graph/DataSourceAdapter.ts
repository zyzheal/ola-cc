/**
 * DataSourceAdapter — 统一数据源适配器接口 (F-95)
 *
 * 为 codegraph.db 和 Grok JSON 提供统一的加载接口，
 * 使 GraphStore.load() 可以通过适配器模式扩展新数据源。
 *
 * 设计文档: docs/superpowers/specs/2026-06-05-codegraph-grok-enhancement-design.md
 */

import { existsSync } from 'fs'
import { resolve } from 'path'

/** Raw node data from a data source */
export interface RawNode {
  id: string
  name: string
  kind: string
  file: string
  line: number
  [key: string]: unknown
}

/** Raw edge data from a data source */
export interface RawEdge {
  from: string
  to: string
  type: string
  weight: number
  [key: string]: unknown
}

/** Load result from a data source adapter */
export interface LoadResult {
  nodes: RawNode[]
  edges: RawEdge[]
}

/**
 * DataSourceAdapter interface — all data sources implement this.
 */
export interface DataSourceAdapter {
  /** Human-readable name for logging */
  readonly name: string

  /** Check if this data source is available (file exists, DB accessible, etc.) */
  isAvailable(): boolean

  /** Load nodes and edges from the data source */
  load(): Promise<LoadResult>
}

/**
 * CodegraphDbAdapter — loads from .codegraph/codegraph.db (bun:sqlite)
 */
export class CodegraphDbAdapter implements DataSourceAdapter {
  readonly name = 'codegraph-db'

  constructor(private readonly projectRoot: string) {}

  isAvailable(): boolean {
    return existsSync(resolve(this.projectRoot, '.codegraph', 'codegraph.db'))
  }

  async load(): Promise<LoadResult> {
    const { Database } = await import('bun:sqlite')
    const { resolve } = await import('path')
    const dbPath = resolve(this.projectRoot, '.codegraph', 'codegraph.db')

    let db: InstanceType<typeof Database>
    try {
      db = new Database(dbPath, { readonly: true })
    } catch (e) {
      // WAL lock retry: 3 attempts, exponential backoff
      for (let i = 0; i < 3; i++) {
        await new Promise<void>(r => setTimeout(r, 100 * Math.pow(2, i)))
        try {
          db = new Database(dbPath, { readonly: true })
          break
        } catch {
          if (i === 2) throw e
        }
      }
    }

    try {
      // Schema-aware column detection
      const rows = db!.query(`PRAGMA table_info(nodes)`).all() as Array<{ name: string }>
      const existingCols = new Set(rows.map(r => r.name))

      const desiredCols = [
        'id', 'kind', 'name', 'qualified_name', 'file_path', 'start_line',
        'end_line', 'signature', 'docstring', 'language', 'visibility',
        'is_exported', 'is_async', 'is_static', 'is_abstract',
        'start_column', 'end_column', 'decorators', 'type_parameters',
        'updated_at', 'provenance',
      ]
      const cols = desiredCols.filter(c => existingCols.has(c))
      const selectClause = cols.map(c => c === 'start_line' ? 'start_line' : c).join(', ')

      const nodeRows = db!.query(`SELECT ${selectClause} FROM nodes`).all() as Array<Record<string, unknown>>
      const nodes: RawNode[] = nodeRows.map(row => ({
        id: row.id as string,
        name: row.name as string,
        kind: row.kind as string,
        file: (row.file_path ?? '') as string,
        line: (row.start_line ?? 0) as number,
        ...Object.fromEntries(cols.filter(c => !['id', 'kind', 'name', 'file_path', 'start_line'].includes(c)).map(c => [c === 'file_path' ? 'file' : c === 'start_line' ? 'line' : c, row[c]])),
      }))

      const edgeRows = db!.query('SELECT source, target, kind FROM edges').all() as Array<{
        source: string; target: string; kind: string
      }>
      const edges: RawEdge[] = edgeRows.map(e => ({
        from: e.source,
        to: e.target,
        type: e.kind,
        weight: 1,
      }))

      return { nodes, edges }
    } finally {
      db!.close()
    }
  }
}

/**
 * GrokJsonAdapter — loads from .understand-anything/knowledge-graph.json
 */
export class GrokJsonAdapter implements DataSourceAdapter {
  readonly name = 'grok-json'

  constructor(private readonly projectRoot: string) {}

  isAvailable(): boolean {
    return existsSync(resolve(this.projectRoot, '.understand-anything', 'knowledge-graph.json'))
  }

  async load(): Promise<LoadResult> {
    const { readFileSync } = await import('fs')
    const jsonPath = resolve(this.projectRoot, '.understand-anything', 'knowledge-graph.json')

    const raw = readFileSync(jsonPath, 'utf-8')
    const data = JSON.parse(raw) as { nodes?: RawNode[]; edges?: Array<{ from: string; to: string; type: string }> }

    return {
      nodes: (data.nodes ?? []).map(n => ({
        id: n.id,
        name: n.name,
        kind: n.kind,
        file: n.file,
        line: n.line,
        layer: n.layer,
        domain: n.domain,
        signature: n.signature,
      })),
      edges: (data.edges ?? []).map(e => ({
        from: e.from,
        to: e.to,
        type: e.type,
        weight: 1,
      })),
    }
  }
}
