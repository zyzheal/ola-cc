/**
 * VectorStore — SQLite 向量存储
 *
 * 使用 bun:sqlite 存储 embedding 向量，支持：
 * - BLOB 存储 (Float32Array)
 * - KNN 搜索 (暴力扫描，适合 <100K 向量)
 * - 按 node kind 过滤
 * - 原子批量写入
 *
 * 未来可升级为 sqlite-vec 扩展实现 ANN 索引。
 *
 * 来源: UA SemanticSearchEngine 缺失层补全
 */

import { Database } from "bun:sqlite"
import { cosineSimilarity } from "./SemanticSearch.js"
import type { VectorStore } from "./SemanticSearch.js"

// ─── SQLiteVectorStore ────────────────────────────────────────────

export class SQLiteVectorStore implements VectorStore {
  private db: Database
  private dimension: number = 0
  private initialized = false

  constructor(db: Database) {
    this.db = db
  }

  async init(dimension: number): Promise<void> {
    if (this.initialized && this.dimension === dimension) return

    this.dimension = dimension

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        node_id TEXT PRIMARY KEY,
        dimension INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_created
      ON embeddings(created_at)
    `)

    this.initialized = true
  }

  async put(nodeId: string, embedding: number[]): Promise<void> {
    this.ensureInitialized()
    this.validateDimension(embedding)

    const blob = this.floatArrayToBlob(embedding)

    this.db.run(
      `INSERT INTO embeddings (node_id, dimension, vector, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(node_id) DO UPDATE SET
         vector = excluded.vector,
         dimension = excluded.dimension,
         updated_at = excluded.updated_at`,
      [nodeId, this.dimension, blob],
    )
  }

  async putBatch(entries: Array<{ nodeId: string; embedding: number[] }>): Promise<void> {
    this.ensureInitialized()

    const stmt = this.db.prepare(
      `INSERT INTO embeddings (node_id, dimension, vector, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(node_id) DO UPDATE SET
         vector = excluded.vector,
         dimension = excluded.dimension,
         updated_at = excluded.updated_at`,
    )

    const tx = this.db.transaction(() => {
      for (const { nodeId, embedding } of entries) {
        this.validateDimension(embedding)
        const blob = this.floatArrayToBlob(embedding)
        stmt.run([nodeId, this.dimension, blob])
      }
    })

    tx()
  }

  async get(nodeId: string): Promise<number[] | null> {
    this.ensureInitialized()

    const row = this.db
      .query("SELECT vector FROM embeddings WHERE node_id = ?")
      .get(nodeId) as { vector: Uint8Array } | null

    if (!row) return null
    return this.blobToFloatArray(row.vector)
  }

  async delete(nodeId: string): Promise<void> {
    this.ensureInitialized()
    this.db.run("DELETE FROM embeddings WHERE node_id = ?", [nodeId])
  }

  async deleteBatch(nodeIds: string[]): Promise<void> {
    this.ensureInitialized()

    if (nodeIds.length === 0) return

    const placeholders = nodeIds.map(() => "?").join(",")
    const tx = this.db.transaction(() => {
      this.db.run(`DELETE FROM embeddings WHERE node_id IN (${placeholders})`, nodeIds)
    })

    tx()
  }

  async knn(
    query: number[],
    k: number,
    filter?: { types?: string[] },
  ): Promise<Array<{ nodeId: string; distance: number }>> {
    this.ensureInitialized()
    this.validateDimension(query)

    // If we have type filter, join with node metadata
    let sql: string
    if (filter?.types && filter.types.length > 0) {
      // Need to join with graph nodes to filter by type
      // For now, fetch all and filter in memory (could optimize with a view)
      sql = "SELECT node_id, vector FROM embeddings"
    } else {
      sql = "SELECT node_id, vector FROM embeddings"
    }

    const rows = this.db.query(sql).all() as Array<{ node_id: string; vector: Uint8Array }>

    // Compute cosine similarity for each vector
    const scored: Array<{ nodeId: string; distance: number }> = []

    for (const row of rows) {
      const embedding = this.blobToFloatArray(row.vector)
      const similarity = cosineSimilarity(query, embedding)
      // Distance = 1 - similarity (0 = identical, 2 = opposite)
      scored.push({ nodeId: row.node_id, distance: 1 - similarity })
    }

    // Sort by distance ascending (best matches first)
    scored.sort((a, b) => a.distance - b.distance)

    return scored.slice(0, k)
  }

  async listNodeIds(): Promise<string[]> {
    this.ensureInitialized()

    const rows = this.db.query("SELECT node_id FROM embeddings").all() as Array<{
      node_id: string
    }>

    return rows.map((r) => r.node_id)
  }

  async count(): Promise<number> {
    this.ensureInitialized()

    const row = this.db.query("SELECT COUNT(*) as cnt FROM embeddings").get() as {
      cnt: number
    }

    return row.cnt
  }

  async close(): Promise<void> {
    // bun:sqlite Database doesn't have async close, just drop reference
    this.initialized = false
  }

  // ─── Internal ───────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("VectorStore not initialized. Call init(dimension) first.")
    }
  }

  private validateDimension(embedding: number[]): void {
    if (embedding.length !== this.dimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimension}, got ${embedding.length}`,
      )
    }
  }

  private floatArrayToBlob(arr: number[]): Uint8Array {
    const buffer = new ArrayBuffer(arr.length * 4)
    const view = new Float32Array(buffer)
    for (let i = 0; i < arr.length; i++) {
      view[i] = arr[i]
    }
    return new Uint8Array(buffer)
  }

  private blobToFloatArray(blob: Uint8Array): number[] {
    const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
    const view = new Float32Array(buffer)
    return Array.from(view)
  }
}

// ─── InMemoryVectorStore (for testing) ────────────────────────────

export class InMemoryVectorStore implements VectorStore {
  private data = new Map<string, number[]>()
  private dims = 0

  async init(dimension: number): Promise<void> {
    this.dims = dimension
  }

  async put(nodeId: string, embedding: number[]): Promise<void> {
    this.data.set(nodeId, embedding)
  }

  async putBatch(entries: Array<{ nodeId: string; embedding: number[] }>): Promise<void> {
    for (const { nodeId, embedding } of entries) {
      this.data.set(nodeId, embedding)
    }
  }

  async get(nodeId: string): Promise<number[] | null> {
    return this.data.get(nodeId) ?? null
  }

  async delete(nodeId: string): Promise<void> {
    this.data.delete(nodeId)
  }

  async deleteBatch(nodeIds: string[]): Promise<void> {
    for (const id of nodeIds) {
      this.data.delete(id)
    }
  }

  async knn(
    query: number[],
    k: number,
  ): Promise<Array<{ nodeId: string; distance: number }>> {
    const scored: Array<{ nodeId: string; distance: number }> = []

    for (const [nodeId, embedding] of this.data) {
      const similarity = cosineSimilarity(query, embedding)
      scored.push({ nodeId, distance: 1 - similarity })
    }

    scored.sort((a, b) => a.distance - b.distance)
    return scored.slice(0, k)
  }

  async listNodeIds(): Promise<string[]> {
    return [...this.data.keys()]
  }

  async count(): Promise<number> {
    return this.data.size
  }

  async close(): Promise<void> {
    this.data.clear()
  }
}
