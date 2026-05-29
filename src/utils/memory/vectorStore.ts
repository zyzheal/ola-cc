/**
 * VectorStore — 内存向量存储
 *
 * 轻量级向量存储，支持余弦相似度搜索。
 * 适用于中小规模（<1000 文档）场景，无需外部依赖。
 *
 * 特性：
 * - O(n) 暴力搜索（1000 文档 <5ms）
 * - 支持增量添加/删除
 * - 内存高效：Float32Array 存储
 */

import { cosineSimilarity } from './embedding'

export interface VectorEntry {
  docId: string
  vector: Float32Array
}

export interface VectorSearchResult {
  docId: string
  score: number
}

export class VectorStore {
  private entries: Map<string, Float32Array> = new Map()

  /**
   * 添加文档向量
   */
  add(docId: string, vector: Float32Array): void {
    this.entries.set(docId, vector)
  }

  /**
   * 删除文档向量
   */
  remove(docId: string): void {
    this.entries.delete(docId)
  }

  /**
   * 检查文档是否存在
   */
  has(docId: string): boolean {
    return this.entries.has(docId)
  }

  /**
   * 获取文档数量
   */
  get size(): number {
    return this.entries.size
  }

  /**
   * 清空所有向量
   */
  clear(): void {
    this.entries.clear()
  }

  /**
   * 余弦相似度搜索（暴力扫描）
   *
   * @param queryVector 查询向量
   * @param topK 返回前 K 个结果
   * @returns 按相似度降序排列的结果
   */
  search(queryVector: Float32Array, topK: number = 10): VectorSearchResult[] {
    const results: VectorSearchResult[] = []

    for (const [docId, vector] of this.entries) {
      const score = cosineSimilarity(queryVector, vector)
      results.push({ docId, score })
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  /**
   * 获取所有文档 ID
   */
  getDocIds(): string[] {
    return [...this.entries.keys()]
  }
}
