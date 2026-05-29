import { BM25, type BM25Result } from '../../utils/memory/bm25'
import { VectorStore } from '../../utils/memory/vectorStore'
import { embedText, embedBatch, isEmbeddingAvailable } from '../../utils/memory/embedding'
import { vectorAnchoredFusion } from '../../utils/memory/rrf'
import * as fs from 'fs'
import * as path from 'path'

// EVOLUTION.* 结构化日志
const logger = {
  info: (meta: Record<string, unknown>, msg: string) => {
    if (process.env.OLA_CC_DEBUG_EVOLUTION === 'true') {
      console.log(`[EVOLUTION] ${msg}`, JSON.stringify(meta))
    }
  },
  warn: (meta: Record<string, unknown>, msg: string) => {
    console.warn(`[EVOLUTION] ${msg}`, JSON.stringify(meta))
  },
  error: (meta: Record<string, unknown>, msg: string) => {
    console.error(`[EVOLUTION] ${msg}`, JSON.stringify(meta))
  },
}

export interface HybridSearchResult {
  docId: string
  score: number
  source: 'bm25' | 'vector' | 'hybrid'
}

export class MemoryIndex {
  private bm25: BM25
  private vectorStore: VectorStore
  private memoryDir: string
  private indexReady: boolean = false
  private vectorReady: boolean = false
  private indexVersion: number = 0
  private indexing: boolean = false
  private pendingFiles: Set<string> = new Set()
  /** 文档内容缓存（用于向量索引） */
  private docContents: Map<string, string> = new Map()

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir
    this.bm25 = new BM25()
    this.vectorStore = new VectorStore()
  }

  async indexAll(): Promise<void> {
    if (this.indexing) return
    this.indexing = true
    try {
      // 检查目录是否存在
      try {
        await fs.promises.access(this.memoryDir, fs.constants.F_OK)
      } catch {
        logger.warn(
          { code: 'EVOLUTION.MEMORY.DIR_NOT_FOUND', memoryDir: this.memoryDir },
          `Memory directory not found: ${this.memoryDir}`,
        )
        return
      }

      const files = (await fs.promises.readdir(this.memoryDir))
        .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')

      // Phase 1: BM25 索引（同步，快速）
      for (const file of files) {
        const content = await fs.promises.readFile(path.join(this.memoryDir, file), 'utf-8')
        this.bm25.addDocument(file, content)
        this.docContents.set(file, content)
      }
      this.indexReady = true
      this.indexVersion++

      // Phase 2: 向量索引（异步，可能较慢）
      await this.buildVectorIndex(files)

      // replay pending files accumulated during indexing
      for (const pending of this.pendingFiles) {
        this.indexFile(pending)
      }
      this.pendingFiles.clear()
    } catch (err: unknown) {
      logger.warn(
        { code: 'EVOLUTION.MEMORY.INDEX_FAILED', memoryDir: this.memoryDir, error: String(err) },
        'Memory index initialization failed',
      )
    } finally {
      this.indexing = false
    }
  }

  /**
   * 构建向量索引
   */
  private async buildVectorIndex(files: string[]): Promise<void> {
    const available = await isEmbeddingAvailable()
    if (!available) {
      logger.info(
        { code: 'EVOLUTION.MEMORY.VECTOR_UNAVAILABLE' },
        'Embedding model not available, using BM25 only',
      )
      return
    }

    const contents = files.map(f => this.docContents.get(f) ?? '')
    const vectors = await embedBatch(contents)

    for (let i = 0; i < files.length; i++) {
      if (vectors[i]) {
        this.vectorStore.add(files[i], vectors[i]!)
      }
    }

    this.vectorReady = true
    logger.info(
      { code: 'EVOLUTION.MEMORY.VECTOR_INDEXED', count: files.length },
      `Vector index built for ${files.length} documents`,
    )
  }

  indexFile(filePath: string): void {
    if (this.indexing) {
      this.pendingFiles.add(filePath)
      return
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    const docId = path.basename(filePath)
    this.bm25.addDocument(docId, content)
    this.docContents.set(docId, content)
    this.indexVersion++

    // 异步更新向量索引（不阻塞）
    if (this.vectorReady) {
      embedText(content).then(vector => {
        if (vector) this.vectorStore.add(docId, vector)
      }).catch(() => { /* ignore */ })
    }
  }

  removeFile(filePath: string): void {
    const docId = path.basename(filePath)
    this.bm25.removeDocument(docId)
    this.vectorStore.remove(docId)
    this.docContents.delete(docId)
    this.indexVersion++
  }

  /**
   * 混合搜索：BM25 + 向量融合
   *
   * 当向量索引可用时，使用 vectorAnchoredFusion 融合两路结果；
   * 否则降级为纯 BM25 搜索。
   */
  async search(query: string, topK: number = 5): Promise<{ results: HybridSearchResult[]; degraded: boolean }> {
    if (!this.indexReady) return { results: [], degraded: true }

    // BM25 搜索（始终可用）
    const bm25Results = this.bm25.search(query, topK * 2)
    const bm25Scores = new Map(bm25Results.map(r => [r.docId, r.score]))

    // 向量搜索（可选）
    if (this.vectorReady) {
      const queryVector = await embedText(query)
      if (queryVector) {
        const vecResults = this.vectorStore.search(queryVector, topK * 2)
        const vecScores = new Map(vecResults.map(r => [r.docId, r.score]))

        // 融合
        const fused = vectorAnchoredFusion(vecScores, bm25Scores, 0.7, 60)
        return {
          results: fused.slice(0, topK).map(r => ({
            docId: r.docId,
            score: r.score,
            source: 'hybrid' as const,
          })),
          degraded: false,
        }
      }
    }

    // 降级：纯 BM25
    return {
      results: bm25Results.slice(0, topK).map(r => ({
        docId: r.docId,
        score: r.score,
        source: 'bm25' as const,
      })),
      degraded: false,
    }
  }

  getStats(): { totalDocuments: number; totalTerms: number; vectorDocuments: number; vectorReady: boolean } {
    return {
      totalDocuments: (this.bm25 as any).docCount ?? 0,
      totalTerms: (this.bm25 as any).idfCache?.size ?? 0,
      vectorDocuments: this.vectorStore.size,
      vectorReady: this.vectorReady,
    }
  }
}
