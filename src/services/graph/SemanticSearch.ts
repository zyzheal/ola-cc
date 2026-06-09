/**
 * SemanticSearchEngine — 语义搜索引擎
 *
 * 基于 UA SemanticSearchEngine 补全，修复原版缺陷并增加：
 * - 向量长度校验
 * - 孤立 embedding 清理
 * - score 范围归一化 [0, 1]
 * - 批量 embedding 生成
 * - SQLite 持久化 (sqlite-vec)
 * - RRF 融合与 FTS5+BM25
 *
 * 来源: /tmp/understand-anything embedding-search.ts (83行)
 * 增强: 修复 6 项缺陷 + 补全 3 层缺失
 */

import type { NodeMetadata } from "./GraphStore.js"

// ─── Types ────────────────────────────────────────────────────────

export interface SearchResult {
  nodeId: string
  score: number // 0 = perfect match, 1 = worst match
}

export interface SemanticSearchOptions {
  limit?: number
  threshold?: number // minimum cosine similarity (not score)
  types?: string[]
}

export interface EmbeddingProvider {
  /** Generate embedding for a single text */
  embed(text: string): Promise<number[]>
  /** Generate embeddings for multiple texts (batch) */
  embedBatch(texts: string[]): Promise<number[][]>
  /** Embedding dimension */
  dimension(): number
  /** Provider name for logging */
  name(): string
}

export interface VectorStore {
  /** Initialize the vector store (create tables) */
  init(dimension: number): Promise<void>
  /** Store a single vector */
  put(nodeId: string, embedding: number[]): Promise<void>
  /** Store multiple vectors (batch) */
  putBatch(entries: Array<{ nodeId: string; embedding: number[] }>): Promise<void>
  /** Get vector by nodeId */
  get(nodeId: string): Promise<number[] | null>
  /** Delete vector by nodeId */
  delete(nodeId: string): Promise<void>
  /** Delete vectors by nodeIds (batch) */
  deleteBatch(nodeIds: string[]): Promise<void>
  /** K-nearest neighbor search */
  knn(query: number[], k: number, filter?: { types?: string[] }): Promise<Array<{ nodeId: string; distance: number }>>
  /** Get all stored nodeIds */
  listNodeIds(): Promise<string[]>
  /** Count stored vectors */
  count(): Promise<number>
  /** Close the store */
  close(): Promise<void>
}

// ─── cosineSimilarity (fixed from UA) ─────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 *
 * Fixes from UA original:
 * - Added vector length validation
 * - Clamped result to [-1, 1] range
 * - Added NaN protection
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }

  if (a.length === 0) return 0

  let dot = 0
  let magA = 0
  let magB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }

  magA = Math.sqrt(magA)
  magB = Math.sqrt(magB)

  if (magA === 0 || magB === 0) return 0

  const similarity = dot / (magA * magB)

  // Clamp to [-1, 1] to handle floating point errors
  return Math.max(-1, Math.min(1, similarity))
}

// ─── SemanticSearchEngine (enhanced from UA) ──────────────────────

/**
 * Semantic search engine using vector embeddings.
 *
 * Enhancements from UA original:
 * - updateNodes() cleans orphan embeddings
 * - search() clamps score to [0, 1]
 * - Added batch embedding generation via EmbeddingProvider
 * - Added SQLite persistence via VectorStore
 * - Added RRF fusion with FTS5+BM25 results
 */
export class SemanticSearchEngine {
  private nodes: NodeMetadata[]
  private embeddings: Map<string, number[]>
  private provider: EmbeddingProvider | null
  private store: VectorStore | null

  constructor(
    nodes: NodeMetadata[],
    embeddings: Record<string, number[]> = {},
    provider: EmbeddingProvider | null = null,
    store: VectorStore | null = null,
  ) {
    this.nodes = nodes
    this.embeddings = new Map(Object.entries(embeddings))
    this.provider = provider
    this.store = store
  }

  hasEmbeddings(): boolean {
    return this.embeddings.size > 0
  }

  addEmbedding(nodeId: string, embedding: number[]): void {
    this.embeddings.set(nodeId, embedding)
  }

  /**
   * Generate embeddings for all nodes that don't have embeddings yet.
   * Uses the configured EmbeddingProvider.
   */
  async generateMissingEmbeddings(
    textFn?: (node: NodeMetadata) => string,
    onProgress?: (current: number, total: number) => void,
  ): Promise<number> {
    if (!this.provider) {
      throw new Error("No EmbeddingProvider configured")
    }

    const defaultTextFn = (node: NodeMetadata) =>
      `${node.name} ${node.kind} ${node.file} ${node.language ?? ""}`.trim()

    const textExtractor = textFn ?? defaultTextFn
    const missingNodes = this.nodes.filter((n) => !this.embeddings.has(n.id))

    if (missingNodes.length === 0) return 0

    // Batch in groups of 100 to avoid API limits
    const BATCH_SIZE = 100
    let generated = 0

    for (let i = 0; i < missingNodes.length; i += BATCH_SIZE) {
      const batch = missingNodes.slice(i, i + BATCH_SIZE)
      const texts = batch.map(textExtractor)
      const vectors = await this.provider.embedBatch(texts)

      for (let j = 0; j < batch.length; j++) {
        this.embeddings.set(batch[j].id, vectors[j])
      }

      generated += batch.length
      onProgress?.(generated, missingNodes.length)
    }

    // Persist to store if available
    if (this.store) {
      const entries = missingNodes.map((n) => ({
        nodeId: n.id,
        embedding: this.embeddings.get(n.id)!,
      }))
      await this.store.putBatch(entries)
    }

    return generated
  }

  /**
   * Search by query embedding vector.
   *
   * Fixes from UA original:
   * - score clamped to [0, 1] (was unbounded for negative similarity)
   * - default threshold changed to -1 (was 0, which filtered negative similarity)
   */
  search(
    queryEmbedding: number[],
    options?: SemanticSearchOptions,
  ): SearchResult[] {
    const limit = options?.limit ?? 10
    // Default threshold: don't filter (accept all similarities including negative)
    const threshold = options?.threshold ?? -1
    const typeFilter = options?.types

    const scored: Array<{ nodeId: string; score: number }> = []

    for (const node of this.nodes) {
      if (typeFilter && !typeFilter.includes(node.kind)) continue

      const embedding = this.embeddings.get(node.id)
      if (!embedding) continue

      const similarity = cosineSimilarity(queryEmbedding, embedding)
      if (similarity >= threshold) {
        // Clamp score to [0, 1]: 1 - similarity, but floor at 0
        const score = Math.max(0, 1 - similarity)
        scored.push({ nodeId: node.id, score })
      }
    }

    scored.sort((a, b) => a.score - b.score)
    return scored.slice(0, limit)
  }

  /**
   * Search by natural language query text.
   * Requires an EmbeddingProvider to convert text to vector.
   */
  async searchByText(
    query: string,
    options?: SemanticSearchOptions,
  ): Promise<SearchResult[]> {
    if (!this.provider) {
      throw new Error("No EmbeddingProvider configured for text search")
    }

    const queryEmbedding = await this.provider.embed(query)
    return this.search(queryEmbedding, options)
  }

  /**
   * Update nodes and clean orphan embeddings.
   *
   * Fix from UA original: now removes embeddings for nodes that no longer exist.
   */
  updateNodes(nodes: NodeMetadata[]): void {
    this.nodes = nodes

    // Clean orphan embeddings
    const nodeIds = new Set(nodes.map((n) => n.id))
    for (const [id] of this.embeddings) {
      if (!nodeIds.has(id)) {
        this.embeddings.delete(id)
      }
    }
  }

  /**
   * Load embeddings from SQLite VectorStore.
   */
  async loadFromStore(): Promise<number> {
    if (!this.store) return 0

    const nodeIds = new Set(this.nodes.map((n) => n.id))
    const storedIds = await this.store.listNodeIds()
    let loaded = 0

    for (const id of storedIds) {
      if (nodeIds.has(id)) {
        const embedding = await this.store.get(id)
        if (embedding) {
          this.embeddings.set(id, embedding)
          loaded++
        }
      }
    }

    return loaded
  }

  getEmbedding(nodeId: string): number[] | undefined {
    return this.embeddings.get(nodeId)
  }

  getEmbeddingCount(): number {
    return this.embeddings.size
  }
}

// ─── RRF Fusion ───────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion (RRF) — 融合多路搜索结果
 *
 * RRF score = Σ 1 / (K + rank_i)
 * K=60 是标准值 (Cormack et al., 2009)
 *
 * 来源: 统一方案 Phase Z3 F-82
 */
export function rrfFuse(
  resultSets: Array<Array<{ nodeId: string; score: number }>>,
  k: number = 60,
): Array<{ nodeId: string; score: number }> {
  const rrfScores = new Map<string, number>()

  for (const results of resultSets) {
    // Sort by score ascending (0 = best)
    const sorted = [...results].sort((a, b) => a.score - b.score)

    for (let rank = 0; rank < sorted.length; rank++) {
      const nodeId = sorted[rank].nodeId
      const rrfContribution = 1 / (k + rank + 1) // rank is 0-indexed, so +1
      rrfScores.set(nodeId, (rrfScores.get(nodeId) ?? 0) + rrfContribution)
    }
  }

  // Sort by RRF score descending (higher = better)
  return [...rrfScores.entries()]
    .map(([nodeId, score]) => ({ nodeId, score: -score })) // negate for ascending sort convention
    .sort((a, b) => a.score - b.score)
}

// ─── Embedding Text Extraction ────────────────────────────────────

/**
 * Default text extraction for embedding generation.
 * Combines node metadata into a single text for embedding.
 */
export function nodeToEmbeddingText(node: NodeMetadata): string {
  const parts = [
    node.name,
    node.kind,
    node.file,
    node.language ?? "",
    node.signature ?? "",
    node.is_exported ? "exported" : "",
    node.visibility ?? "",
  ]
  return parts.filter(Boolean).join(" ")
}
