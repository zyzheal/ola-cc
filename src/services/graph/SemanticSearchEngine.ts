/**
 * SemanticSearchEngine — Embedding-based semantic search
 *
 * Combines FTS5 text search, BM25 scoring, and vector similarity
 * using 3-way RRF fusion for high-quality code search.
 *
 * F-106: SemanticSearchEngine
 */

import type { Database } from 'bun:sqlite'
import type { FtsSearch, SearchResult } from './FtsSearch.js'
import type { GraphStore, NodeMetadata } from './GraphStore.js'

// ============================================================
// Embedding Provider Interface
// ============================================================

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

/**
 * MockEmbeddingProvider — Deterministic random vectors for testing.
 *
 * Uses mulberry32 PRNG for reproducible results.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  private seed: number
  private dimensions: number

  constructor(seed = 42, dimensions = 128) {
    this.seed = seed
    this.dimensions = dimensions
  }

  async embed(text: string): Promise<number[]> {
    return this.generateVector(text)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.generateVector(t))
  }

  /**
   * Generate a deterministic vector from text using mulberry32 PRNG.
   * Same text always produces the same vector.
   */
  private generateVector(text: string): number[] {
    // Hash the text to get a seed
    let hash = 0
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i)
      hash = ((hash << 5) - hash + ch) | 0
    }

    // Combine with base seed
    const rng = this.mulberry32((this.seed + hash) >>> 0)

    // Generate normalized vector
    const vec = new Array(this.dimensions)
    let norm = 0
    for (let i = 0; i < this.dimensions; i++) {
      vec[i] = rng() * 2 - 1  // [-1, 1]
      norm += vec[i] * vec[i]
    }

    // Normalize to unit vector
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] /= norm
      }
    }

    return vec
  }

  /** mulberry32 PRNG — fast, deterministic 32-bit generator */
  private mulberry32(seed: number): () => number {
    let s = seed
    return () => {
      s = (s + 0x6d2b79f5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
}

// ============================================================
// SQLiteVectorStore
// ============================================================

export class SQLiteVectorStore {
  private dimensions: number

  constructor(
    private db: Database,
    dimensions = 128,
  ) {
    this.dimensions = dimensions
  }

  /**
   * Create vectors table for storing embeddings.
   */
  createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        dimensions INTEGER NOT NULL
      )
    `)
  }

  /**
   * Store or update an embedding.
   */
  upsert(id: string, embedding: number[]): void {
    const blob = this.floatArrayToBlob(embedding)
    this.db.prepare(
      'INSERT OR REPLACE INTO vectors (id, embedding, dimensions) VALUES (?, ?, ?)'
    ).run(id, blob, embedding.length)
  }

  /**
   * Batch upsert embeddings.
   */
  upsertBatch(entries: Array<{ id: string; embedding: number[] }>): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO vectors (id, embedding, dimensions) VALUES (?, ?, ?)'
    )
    const upsertMany = this.db.transaction((items: Array<{ id: string; embedding: number[] }>) => {
      for (const item of items) {
        stmt.run(item.id, this.floatArrayToBlob(item.embedding), item.embedding.length)
      }
    })
    upsertMany(entries)
  }

  /**
   * K-nearest-neighbor search using cosine distance.
   * distance = 1 - dot(a,b) / (|a| * |b|)
   */
  knn(query: number[], k: number): Array<{ id: string; distance: number }> {
    const rows = this.db.query('SELECT id, embedding, dimensions FROM vectors').all() as Array<{
      id: string; embedding: ArrayBuffer; dimensions: number
    }>

    const results: Array<{ id: string; distance: number }> = []
    const queryNorm = this.vectorNorm(query)

    for (const row of rows) {
      const vec = this.blobToFloatArray(row.embedding, row.dimensions)
      const distance = this.cosineDistance(query, vec, queryNorm)
      results.push({ id: row.id, distance })
    }

    // Sort by distance ascending (most similar first)
    results.sort((a, b) => a.distance - b.distance)
    return results.slice(0, k)
  }

  /**
   * Get total vector count.
   */
  get count(): number {
    const row = this.db.query('SELECT COUNT(*) as cnt FROM vectors').get() as { cnt: number }
    return row.cnt
  }

  /**
   * Convert Float64Array to Buffer for SQLite BLOB storage.
   */
  private floatArrayToBlob(arr: number[]): Buffer {
    const buf = Buffer.alloc(arr.length * 8)
    for (let i = 0; i < arr.length; i++) {
      buf.writeDoubleLE(arr[i], i * 8)
    }
    return buf
  }

  /**
   * Convert BLOB back to Float64Array.
   */
  private blobToFloatArray(blob: ArrayBuffer, dimensions: number): number[] {
    const buf = Buffer.from(blob)
    const result = new Array(dimensions)
    for (let i = 0; i < dimensions; i++) {
      result[i] = buf.readDoubleLE(i * 8)
    }
    return result
  }

  /**
   * Compute cosine distance: 1 - dot(a,b) / (|a| * |b|)
   */
  private cosineDistance(a: number[], b: number[], aNorm?: number): number {
    if (a.length !== b.length) return 1

    let dot = 0
    let bNormSq = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      bNormSq += b[i] * b[i]
    }

    const normA = aNorm ?? Math.sqrt(a.reduce((s, v) => s + v * v, 0))
    const normB = Math.sqrt(bNormSq)

    if (normA === 0 || normB === 0) return 1

    return 1 - dot / (normA * normB)
  }

  private vectorNorm(a: number[]): number {
    return Math.sqrt(a.reduce((s, v) => s + v * v, 0))
  }
}

// ============================================================
// SemanticSearchEngine
// ============================================================

export class SemanticSearchEngine {
  constructor(
    private fts: FtsSearch,
    private vectorStore: SQLiteVectorStore,
    private embedding: EmbeddingProvider,
    private store: GraphStore,
  ) {}

  /**
   * Index all nodes: compute embeddings and store in vector store.
   */
  async indexAll(): Promise<void> {
    const nodes = [...this.store.nodeMeta.values()]
    const texts = nodes.map(n => this.nodeToText(n))
    const embeddings = await this.embedding.embedBatch(texts)

    const entries = nodes.map((n, i) => ({ id: n.id, embedding: embeddings[i] }))
    this.vectorStore.upsertBatch(entries)
  }

  /**
   * Search with 3-way RRF fusion: FTS5 + BM25 + Semantic vector similarity.
   */
  async searchByText(query: string, limit = 20): Promise<SearchResult[]> {
    const k = 60 // RRF constant

    // Signal 1: FTS5 text search
    const ftsResults = this.fts.search(query, limit * 3)
    const ftsRank = new Map<string, number>()
    ftsResults.forEach((r, i) => ftsRank.set(r.id, i + 1))

    // Signal 2: BM25 weighted search
    const bm25Results = this.fts.searchWithBM25(query, limit * 3)
    const bm25Rank = new Map<string, number>()
    bm25Results.forEach((r, i) => bm25Rank.set(r.id, i + 1))

    // Signal 3: Semantic vector search
    const queryEmbedding = await this.embedding.embed(query)
    const vectorResults = this.vectorStore.knn(queryEmbedding, limit * 3)
    const vectorRank = new Map<string, number>()
    vectorResults.forEach((r, i) => vectorRank.set(r.id, i + 1))

    // Collect all unique IDs
    const allIds = new Set<string>([
      ...ftsRank.keys(),
      ...bm25Rank.keys(),
      ...vectorRank.keys(),
    ])

    // Compute RRF scores
    const resultMap = new Map<string, SearchResult>()

    for (const id of allIds) {
      let score = 0

      const fR = ftsRank.get(id)
      if (fR !== undefined) score += 1 / (k + fR)

      const bR = bm25Rank.get(id)
      if (bR !== undefined) score += 1 / (k + bR)

      const vR = vectorRank.get(id)
      if (vR !== undefined) score += 1 / (k + vR)

      const meta = this.store.getNode(id)
      if (meta) {
        resultMap.set(id, {
          id,
          name: meta.name,
          kind: meta.kind,
          file: meta.file,
          line: meta.line,
          score,
        })
      } else {
        const src = ftsResults.find(r => r.id === id)
        if (src) resultMap.set(id, { ...src, score })
      }
    }

    return [...resultMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * Convert a node to text representation for embedding.
   */
  private nodeToText(node: NodeMetadata): string {
    const parts = [node.name, node.kind]
    if (node.qualified_name) parts.push(node.qualified_name)
    if (node.signature) parts.push(node.signature)
    if (node.docstring) parts.push(node.docstring)
    return parts.join(' ')
  }
}
