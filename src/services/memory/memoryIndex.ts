import { BM25, type BM25Result } from '../../utils/memory/bm25'
import * as fs from 'fs'
import * as path from 'path'

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
