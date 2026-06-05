/**
 * FtsSearch — FTS5 Full-Text Search + BM25 Scoring
 *
 * Uses bun:sqlite FTS5 virtual table for fast full-text search
 * over GraphStore nodes. Supports BM25 multi-signal column weighting.
 *
 * F-60: FTS5 Search Integration
 * F-61: BM25 Multi-signal Scoring
 */

import { Database } from 'bun:sqlite'
import type { GraphStore, NodeMetadata } from './GraphStore.js'

// ============================================================
// Types
// ============================================================

export interface SearchResult {
  id: string
  name: string
  kind: string
  file: string
  line: number
  score: number
  highlights?: string[]
}

// ============================================================
// FtsSearch
// ============================================================

export class FtsSearch {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode=WAL')
  }

  /**
   * Create FTS5 virtual table for node search.
   * Uses external content mode referencing a shadow nodes table.
   */
  createIndex(): void {
    // Shadow table to store node data (FTS5 content table)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT DEFAULT '',
        signature TEXT DEFAULT '',
        docstring TEXT DEFAULT '',
        kind TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL
      )
    `)

    // FTS5 virtual table with column weights
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        id, name, qualified_name, signature, docstring, kind, file,
        content='nodes', content_rowid='rowid'
      )
    `)

    // Triggers to keep FTS in sync with content table
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, id, name, qualified_name, signature, docstring, kind, file)
        VALUES (new.rowid, new.id, new.name, new.qualified_name, new.signature, new.docstring, new.kind, new.file);
      END
    `)

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, signature, docstring, kind, file)
        VALUES ('delete', old.rowid, old.id, old.name, old.qualified_name, old.signature, old.docstring, old.kind, old.file);
      END
    `)

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, signature, docstring, kind, file)
        VALUES ('delete', old.rowid, old.id, old.name, old.qualified_name, old.signature, old.docstring, old.kind, old.file);
        INSERT INTO nodes_fts(rowid, id, name, qualified_name, signature, docstring, kind, file)
        VALUES (new.rowid, new.id, new.name, new.qualified_name, new.signature, new.docstring, new.kind, new.file);
      END
    `)
  }

  /**
   * Index all nodes from a GraphStore into the FTS table.
   */
  indexNodes(store: GraphStore): void {
    const insert = this.db.prepare(
      'INSERT INTO nodes (id, name, qualified_name, signature, docstring, kind, file, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )

    const insertMany = this.db.transaction((nodes: NodeMetadata[]) => {
      for (const node of nodes) {
        insert.run(
          node.id,
          node.name,
          node.qualified_name ?? '',
          node.signature ?? '',
          node.docstring ?? '',
          node.kind,
          node.file,
          node.line,
        )
      }
    })

    insertMany([...store.nodeMeta.values()])
  }

  /**
   * Search with prefix matching (e.g. "get*" matches "getData", "getUser").
   */
  search(query: string, limit = 20): SearchResult[] {
    // Escape special FTS5 characters and add prefix matching
    const sanitized = this.sanitizeQuery(query)
    if (!sanitized) return []

    // JOIN with nodes table to get the line column (not in FTS5 virtual table)
    const rows = this.db.query(`
      SELECT n.id, n.name, n.kind, n.file, n.line, fts.rank
      FROM nodes_fts fts
      JOIN nodes n ON n.rowid = fts.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `).all(sanitized, limit) as Array<{
      id: string; name: string; kind: string; file: string; line: number; rank: number
    }>

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      score: -r.rank, // FTS5 rank is negative (lower = better), invert for intuitive scoring
    }))
  }

  /**
   * Search filtered by node kind.
   */
  searchByKind(query: string, kind: string, limit = 20): SearchResult[] {
    const sanitized = this.sanitizeQuery(query)
    if (!sanitized) return []

    const rows = this.db.query(`
      SELECT n.id, n.name, n.kind, n.file, n.line, fts.rank
      FROM nodes_fts fts
      JOIN nodes n ON n.rowid = fts.rowid
      WHERE nodes_fts MATCH ? AND n.kind = ?
      ORDER BY fts.rank
      LIMIT ?
    `).all(sanitized, kind, limit) as Array<{
      id: string; name: string; kind: string; file: string; line: number; rank: number
    }>

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      score: -r.rank,
    }))
  }

  /**
   * Search with BM25 scoring using column weights.
   *
   * Column weights (higher = more important):
   *   name: 10, qualified_name: 5, signature: 3, docstring: 1
   */
  searchWithBM25(query: string, limit = 20): SearchResult[] {
    const sanitized = this.sanitizeQuery(query)
    if (!sanitized) return []

    // FTS5 bm25() function with column weights
    // Column order: id(0), name(1), qualified_name(2), signature(3), docstring(4), kind(5), file(6)
    const rows = this.db.query(`
      SELECT n.id, n.name, n.kind, n.file, n.line,
        bm25(nodes_fts, 0.0, 10.0, 5.0, 3.0, 1.0, 0.0, 0.0) as score
      FROM nodes_fts fts
      JOIN nodes n ON n.rowid = fts.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(sanitized, limit) as Array<{
      id: string; name: string; kind: string; file: string; line: number; score: number
    }>

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      score: -r.score, // bm25 returns negative scores; invert
    }))
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close()
  }

  /**
   * Sanitize query for FTS5: escape special chars, add prefix matching.
   */
  private sanitizeQuery(query: string): string {
    // Remove FTS5 special characters: " AND OR NOT NEAR ( ) *
    const cleaned = query.replace(/["*()]/g, ' ').trim()
    if (!cleaned) return ''

    // Split into terms and add prefix wildcard to each
    const terms = cleaned.split(/\s+/).filter(t => t.length > 0)
    if (terms.length === 0) return ''

    // Prefix match: each term gets * suffix
    return terms.map(t => `"${t}"*`).join(' AND ')
  }
}
