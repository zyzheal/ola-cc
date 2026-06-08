/**
 * CodegraphWriter — 持久化 GraphStore 到 SQLite (codegraph.db)
 *
 * 替代 codegraph CLI 的 init/sync 功能，纯 TypeScript 实现。
 * 创建与 CLI 兼容的 schema（21 列 nodes + 3 列 edges + FTS5）。
 */

import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import type { GraphStore, NodeMetadata, EdgeMeta, EdgeType } from './GraphStore.js'

// ============================================================
// Reverse edge type mapping (EdgeType → codegraph kind string)
// ============================================================

const EDGE_TYPE_TO_KIND: Record<EdgeType, string> = {
  calls: 'calls',
  imports: 'imports',
  contains: 'contains',
  data: 'references',
  inherits: 'extends',
  implements: 'implements',
  exports: 'exports',
  type_of: 'type_of',
  returns: 'returns',
  instantiates: 'instantiates',
  overrides: 'overrides',
  decorates: 'decorates',
  control: 'relates',
  subscribes: 'subscribes',
  publishes: 'publishes',
  middleware: 'middleware',
  flow_step: 'flow_step',
  cross_domain: 'cross_domain',
  reads: 'reads',
  writes: 'writes',
  tests: 'tests',
  configures: 'configures',
  deploys: 'deploys',
  monitors: 'monitors',
  validates: 'validates',
  transforms: 'transforms',
  caches: 'caches',
  queues: 'queues',
  notifies: 'notifies',
  serializes: 'serializes',
  deserializes: 'deserializes',
  encrypts: 'encrypts',
  decrypts: 'decrypts',
  compresses: 'compresses',
  logs: 'logs',
  metrics: 'metrics',
  traces: 'traces_edge',
  authenticates: 'authenticates',
  authorizes: 'authorizes',
  rate_limits: 'rate_limits',
}

// ============================================================
// Schema SQL
// ============================================================

const CREATE_NODES_TABLE = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT DEFAULT '',
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER,
  signature TEXT,
  docstring TEXT,
  language TEXT,
  visibility TEXT,
  is_exported INTEGER DEFAULT 0,
  is_async INTEGER DEFAULT 0,
  is_static INTEGER DEFAULT 0,
  is_abstract INTEGER DEFAULT 0,
  start_column INTEGER,
  end_column INTEGER,
  decorators TEXT,
  type_parameters TEXT,
  updated_at INTEGER,
  provenance TEXT
)`

const CREATE_EDGES_TABLE = `
CREATE TABLE IF NOT EXISTS edges (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL
)`

const CREATE_EDGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source)
`

const CREATE_EDGES_TARGET_INDEX = `
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target)
`

// FTS5 uses a shadow content table with subset of columns
// Table name 'nodes' matches FtsSearch expectations
const CREATE_FTS_SHADOW = `
CREATE TABLE IF NOT EXISTS nodes_fts_content (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT DEFAULT '',
  signature TEXT DEFAULT '',
  docstring TEXT DEFAULT '',
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL
)`

const CREATE_FTS_VIRTUAL = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id, name, qualified_name, signature, docstring, kind, file,
  content='nodes_fts_content', content_rowid='rowid'
)`

const CREATE_FTS_TRIGGER_AI = `
CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes_fts_content BEGIN
  INSERT INTO nodes_fts(rowid, id, name, qualified_name, signature, docstring, kind, file)
  VALUES (new.rowid, new.id, new.name, new.qualified_name, new.signature, new.docstring, new.kind, new.file);
END`

const CREATE_FTS_TRIGGER_AD = `
CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes_fts_content BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, signature, docstring, kind, file)
  VALUES ('delete', old.rowid, old.id, old.name, old.qualified_name, old.signature, old.docstring, old.kind, old.file);
END`

const CREATE_FTS_TRIGGER_AU = `
CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes_fts_content BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, signature, docstring, kind, file)
  VALUES ('delete', old.rowid, old.id, old.name, old.qualified_name, old.signature, old.docstring, old.kind, old.file);
  INSERT INTO nodes_fts(rowid, id, name, qualified_name, signature, docstring, kind, file)
  VALUES (new.rowid, new.id, new.name, new.qualified_name, new.signature, new.docstring, new.kind, new.file);
END`

// ============================================================
// Types
// ============================================================

export interface PersistResult {
  nodesWritten: number
  edgesWritten: number
  durationMs: number
}

// ============================================================
// CodegraphWriter
// ============================================================

export class CodegraphWriter {
  private dbPath: string
  private mtimePath: string

  constructor(private readonly projectRoot: string) {
    this.dbPath = resolve(projectRoot, '.codegraph', 'codegraph.db')
    this.mtimePath = resolve(projectRoot, '.codegraph', 'db.mtime')
  }

  /**
   * Create codegraph.db with full schema + FTS5 tables.
   */
  createDatabase(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true })
    const db = new Database(this.dbPath)
    try {
      db.exec('PRAGMA journal_mode=WAL')
      db.exec(CREATE_NODES_TABLE)
      db.exec(CREATE_EDGES_TABLE)
      db.exec(CREATE_EDGES_INDEX)
      db.exec(CREATE_EDGES_TARGET_INDEX)
      db.exec(CREATE_FTS_SHADOW)
      db.exec(CREATE_FTS_VIRTUAL)
      db.exec(CREATE_FTS_TRIGGER_AI)
      db.exec(CREATE_FTS_TRIGGER_AD)
      db.exec(CREATE_FTS_TRIGGER_AU)
    } finally {
      db.close()
    }
  }

  /**
   * Full persist: write all nodes + edges from GraphStore to codegraph.db.
   * Uses transaction for atomicity.
   */
  persist(store: GraphStore): PersistResult {
    const start = Date.now()
    mkdirSync(dirname(this.dbPath), { recursive: true })
    const db = new Database(this.dbPath)
    try {
      db.exec('PRAGMA journal_mode=WAL')
      db.exec(CREATE_NODES_TABLE)
      db.exec(CREATE_EDGES_TABLE)
      db.exec(CREATE_EDGES_INDEX)
      db.exec(CREATE_EDGES_TARGET_INDEX)
      db.exec(CREATE_FTS_SHADOW)
      db.exec(CREATE_FTS_VIRTUAL)
      db.exec(CREATE_FTS_TRIGGER_AI)
      db.exec(CREATE_FTS_TRIGGER_AD)
      db.exec(CREATE_FTS_TRIGGER_AU)

      // Clear existing data
      db.exec('DELETE FROM edges')
      db.exec('DELETE FROM nodes_fts_content')
      db.exec('DELETE FROM nodes')

      // Drop FTS triggers before bulk insert (bun:sqlite FTS5 blocks direct content table modification)
      db.exec('DROP TRIGGER IF EXISTS nodes_fts_ai')
      db.exec('DROP TRIGGER IF EXISTS nodes_fts_ad')
      db.exec('DROP TRIGGER IF EXISTS nodes_fts_au')

      // Insert nodes
      const insertNode = db.prepare(`
        INSERT INTO nodes (id, kind, name, qualified_name, file_path, start_line,
          end_line, signature, docstring, language, visibility,
          is_exported, is_async, is_static, is_abstract,
          start_column, end_column, decorators, type_parameters, updated_at, provenance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      // Insert FTS shadow nodes
      const insertFtsNode = db.prepare(`
        INSERT INTO nodes_fts_content (id, name, qualified_name, signature, docstring, kind, file, line)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)

      // Insert edges
      const insertEdge = db.prepare('INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)')

      let nodesWritten = 0
      let edgesWritten = 0

      const doPersist = db.transaction(() => {
        for (const [, meta] of store.nodeMeta) {
          insertNode.run(
            meta.id, meta.kind, meta.name,
            meta.qualified_name ?? '', meta.file, meta.line,
            meta.end_line ?? null, meta.signature ?? null, meta.docstring ?? null,
            meta.language ?? null, meta.visibility ?? null,
            meta.is_exported ? 1 : 0, meta.is_async ? 1 : 0,
            meta.is_static ? 1 : 0, meta.is_abstract ? 1 : 0,
            meta.start_column ?? null, meta.end_column ?? null,
            meta.decorators ? JSON.stringify(meta.decorators) : null,
            meta.type_parameters ? JSON.stringify(meta.type_parameters) : null,
            meta.updated_at ?? null, meta.provenance ?? 'builtin',
          )
          insertFtsNode.run(
            meta.id, meta.name, meta.qualified_name ?? '',
            meta.signature ?? '', meta.docstring ?? '',
            meta.kind, meta.file, meta.line,
          )
          nodesWritten++
        }

        for (const [sourceId, targets] of store.adjacency) {
          for (const [targetId, edges] of targets) {
            for (const edge of edges) {
              const kind = EDGE_TYPE_TO_KIND[edge.type] ?? edge.type
              insertEdge.run(sourceId, targetId, kind)
              edgesWritten++
            }
          }
        }
      })

      doPersist()

      // Rebuild FTS index from shadow table content
      db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`)

      // Recreate triggers for future incremental updates
      db.exec(CREATE_FTS_TRIGGER_AI)
      db.exec(CREATE_FTS_TRIGGER_AD)
      db.exec(CREATE_FTS_TRIGGER_AU)

      // Write mtime for freshness tracking
      writeFileSync(this.mtimePath, String(Date.now()), 'utf-8')

      return { nodesWritten, edgesWritten, durationMs: Date.now() - start }
    } finally {
      db.close()
    }
  }

  /**
   * Incremental persist: update only nodes/edges for changed files.
   */
  updateFiles(store: GraphStore, filePaths: string[]): PersistResult {
    const start = Date.now()
    const db = new Database(this.dbPath)
    try {
      db.exec('PRAGMA journal_mode=WAL')

      // Drop FTS triggers before bulk insert (bun:sqlite FTS5 blocks direct content table modification)
      db.exec('DROP TRIGGER IF EXISTS nodes_fts_ai')
      db.exec('DROP TRIGGER IF EXISTS nodes_fts_ad')
      db.exec('DROP TRIGGER IF EXISTS nodes_fts_au')

      const deleteNodesByFile = db.prepare('DELETE FROM nodes WHERE file_path = ?')
      const deleteFtsByFile = db.prepare('DELETE FROM nodes_fts_content WHERE file = ?')
      const deleteEdgesByFile = db.prepare(`
        DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)
          OR target IN (SELECT id FROM nodes WHERE file_path = ?)
      `)

      const insertNode = db.prepare(`
        INSERT INTO nodes (id, kind, name, qualified_name, file_path, start_line,
          end_line, signature, docstring, language, visibility,
          is_exported, is_async, is_static, is_abstract,
          start_column, end_column, decorators, type_parameters, updated_at, provenance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const insertFtsNode = db.prepare(`
        INSERT INTO nodes_fts_content (id, name, qualified_name, signature, docstring, kind, file, line)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const insertEdge = db.prepare('INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)')

      let nodesWritten = 0
      let edgesWritten = 0

      const doUpdate = db.transaction(() => {
        for (const filePath of filePaths) {
          // Delete old data for this file
          deleteEdgesByFile.run(filePath, filePath)
          deleteFtsByFile.run(filePath)
          deleteNodesByFile.run(filePath)

          // Insert new nodes for this file
          for (const [, meta] of store.nodeMeta) {
            if (meta.file !== filePath) continue
            insertNode.run(
              meta.id, meta.kind, meta.name,
              meta.qualified_name ?? '', meta.file, meta.line,
              meta.end_line ?? null, meta.signature ?? null, meta.docstring ?? null,
              meta.language ?? null, meta.visibility ?? null,
              meta.is_exported ? 1 : 0, meta.is_async ? 1 : 0,
              meta.is_static ? 1 : 0, meta.is_abstract ? 1 : 0,
              meta.start_column ?? null, meta.end_column ?? null,
              meta.decorators ? JSON.stringify(meta.decorators) : null,
              meta.type_parameters ? JSON.stringify(meta.type_parameters) : null,
              meta.updated_at ?? null, meta.provenance ?? 'builtin',
            )
            insertFtsNode.run(
              meta.id, meta.name, meta.qualified_name ?? '',
              meta.signature ?? '', meta.docstring ?? '',
              meta.kind, meta.file, meta.line,
            )
            nodesWritten++
          }

          // Insert edges where source is in this file
          for (const [sourceId, targets] of store.adjacency) {
            const sourceNode = store.getNode(sourceId)
            if (!sourceNode || sourceNode.file !== filePath) continue
            for (const [targetId, edges] of targets) {
              for (const edge of edges) {
                const kind = EDGE_TYPE_TO_KIND[edge.type] ?? edge.type
                insertEdge.run(sourceId, targetId, kind)
                edgesWritten++
              }
            }
          }
        }
      })

      doUpdate()

      // Rebuild FTS index from shadow table content
      db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`)

      // Recreate triggers for future incremental updates
      db.exec(CREATE_FTS_TRIGGER_AI)
      db.exec(CREATE_FTS_TRIGGER_AD)
      db.exec(CREATE_FTS_TRIGGER_AU)

      // Update mtime
      writeFileSync(this.mtimePath, String(Date.now()), 'utf-8')

      return { nodesWritten, edgesWritten, durationMs: Date.now() - start }
    } finally {
      db.close()
    }
  }

  /**
   * Rebuild FTS5 index from scratch.
   */
  rebuildFts(store: GraphStore): void {
    const db = new Database(this.dbPath)
    try {
      db.exec('PRAGMA journal_mode=WAL')
      // Drop and recreate FTS tables
      db.exec('DROP TRIGGER IF EXISTS nodes_fts_ai')
      db.exec('DROP TRIGGER IF EXISTS nodes_fts_ad')
      db.exec('DROP TRIGGER IF EXISTS nodes_fts_au')
      db.exec('DROP TABLE IF EXISTS nodes_fts')
      db.exec('DROP TABLE IF EXISTS nodes_fts_content')

      db.exec(CREATE_FTS_SHADOW)
      db.exec(CREATE_FTS_VIRTUAL)
      db.exec(CREATE_FTS_TRIGGER_AI)
      db.exec(CREATE_FTS_TRIGGER_AD)
      db.exec(CREATE_FTS_TRIGGER_AU)

      const insertFts = db.prepare(`
        INSERT INTO nodes_fts_content (id, name, qualified_name, signature, docstring, kind, file, line)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const doRebuild = db.transaction(() => {
        for (const [, meta] of store.nodeMeta) {
          insertFts.run(
            meta.id, meta.name, meta.qualified_name ?? '',
            meta.signature ?? '', meta.docstring ?? '',
            meta.kind, meta.file, meta.line,
          )
        }
      })

      doRebuild()
    } finally {
      db.close()
    }
  }

  /**
   * Get database statistics.
   */
  getStats(): { nodeCount: number; edgeCount: number; fileCount: number; lastModified: number } {
    try {
      const db = new Database(this.dbPath, { readonly: true })
      try {
        const nodeCount = (db.query('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c
        const edgeCount = (db.query('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c
        const fileCount = (db.query('SELECT COUNT(DISTINCT file_path) as c FROM nodes').get() as { c: number }).c
        let lastModified = 0
        try {
          lastModified = Number(statSync(this.mtimePath).mtimeMs)
        } catch { /* no mtime file */ }
        return { nodeCount, edgeCount, fileCount, lastModified }
      } finally {
        db.close()
      }
    } catch {
      return { nodeCount: 0, edgeCount: 0, fileCount: 0, lastModified: 0 }
    }
  }
}
