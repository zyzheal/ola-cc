import { BM25, type BM25Result } from '../../utils/memory/bm25'
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

export class MemoryIndex {
  private bm25: BM25
  private memoryDir: string
  private indexReady: boolean = false
  private indexVersion: number = 0
  private indexing: boolean = false
  private pendingFiles: Set<string> = new Set()

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir
    this.bm25 = new BM25()
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
      for (const file of files) {
        const content = await fs.promises.readFile(path.join(this.memoryDir, file), 'utf-8')
        this.bm25.addDocument(file, content)
      }
      this.indexReady = true
      this.indexVersion++
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

  indexFile(filePath: string): void {
    if (this.indexing) {
      this.pendingFiles.add(filePath)
      return
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    const docId = path.basename(filePath)
    this.bm25.addDocument(docId, content)
    this.indexVersion++
  }

  removeFile(filePath: string): void {
    this.bm25.removeDocument(path.basename(filePath))
    this.indexVersion++
  }

  search(query: string, topK: number = 5): { results: BM25Result[]; degraded: boolean } {
    if (!this.indexReady) return { results: [], degraded: true }
    return { results: this.bm25.search(query, topK), degraded: false }
  }

  getStats(): { totalDocuments: number; totalTerms: number } {
    return {
      totalDocuments: (this.bm25 as any).docCount ?? 0,
      totalTerms: (this.bm25 as any).idfCache?.size ?? 0,
    }
  }
}
