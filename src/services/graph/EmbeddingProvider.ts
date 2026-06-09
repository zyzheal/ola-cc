/**
 * EmbeddingProvider — 向量嵌入提供者
 *
 * 可插拔的 embedding 生成层，支持：
 * - OpenAI text-embedding-3-small/large
 * - Cohere embed-v3
 * - 本地 ONNX 模型 (future)
 * - Mock (测试用)
 *
 * 来源: UA SemanticSearchEngine 缺失层补全
 */

import type { EmbeddingProvider } from "./SemanticSearch.js"

// ─── OpenAI Embedding Provider ────────────────────────────────────

interface OpenAIEmbeddingConfig {
  apiKey?: string
  model?: string
  baseUrl?: string
  dimensions?: number
  batchSize?: number
}

/**
 * OpenAI embedding provider.
 * Supports text-embedding-3-small (1536d) and text-embedding-3-large (3072d).
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string
  private model: string
  private baseUrl: string
  private dims: number
  private batchSize: number

  constructor(config: OpenAIEmbeddingConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? ""
    this.model = config.model ?? "text-embedding-3-small"
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1"
    this.dims = config.dimensions ?? 1536
    this.batchSize = config.batchSize ?? 100

    if (!this.apiKey) {
      throw new Error("OpenAI API key required. Set OPENAI_API_KEY env var or pass apiKey in config.")
    }
  }

  name(): string {
    return `openai/${this.model}`
  }

  dimension(): number {
    return this.dims
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text])
    return results[0]
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = []

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.dims,
        }),
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`OpenAI embedding API error: ${response.status} ${body}`)
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>
      }

      // Sort by index to maintain order
      const sorted = data.data.sort((a, b) => a.index - b.index)
      for (const item of sorted) {
        allEmbeddings.push(item.embedding)
      }
    }

    return allEmbeddings
  }
}

// ─── Cohere Embedding Provider ────────────────────────────────────

interface CohereEmbeddingConfig {
  apiKey?: string
  model?: string
  baseUrl?: string
  inputType?: "search_document" | "search_query"
  batchSize?: number
}

/**
 * Cohere embedding provider.
 * Supports embed-v3 (1024d).
 */
export class CohereEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string
  private model: string
  private baseUrl: string
  private inputType: "search_document" | "search_query"
  private batchSize: number

  constructor(config: CohereEmbeddingConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.COHERE_API_KEY ?? ""
    this.model = config.model ?? "embed-v3"
    this.baseUrl = config.baseUrl ?? "https://api.cohere.com/v1"
    this.inputType = config.inputType ?? "search_document"
    this.batchSize = config.batchSize ?? 96 // Cohere limit

    if (!this.apiKey) {
      throw new Error("Cohere API key required. Set COHERE_API_KEY env var or pass apiKey in config.")
    }
  }

  name(): string {
    return `cohere/${this.model}`
  }

  dimension(): number {
    return 1024
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text])
    return results[0]
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = []

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const response = await fetch(`${this.baseUrl}/embed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          texts: batch,
          input_type: this.inputType,
          embedding_types: ["float"],
        }),
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Cohere embedding API error: ${response.status} ${body}`)
      }

      const data = (await response.json()) as {
        embeddings: { float: number[][] }
      }

      for (const vec of data.embeddings.float) {
        allEmbeddings.push(vec)
      }
    }

    return allEmbeddings
  }
}

// ─── Local Embedding Provider (stub for future ONNX) ─────────────

/**
 * Local embedding provider using ONNX Runtime.
 * TODO: Implement with all-MiniLM-L6-v2 (22M params, 384d, 80MB)
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  name(): string {
    return "local/minilm-l6-v2"
  }

  dimension(): number {
    return 384
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error("LocalEmbeddingProvider not yet implemented. Use OpenAI or Cohere instead.")
  }

  async embedBatch(_texts: string[]): Promise<number[][]> {
    throw new Error("LocalEmbeddingProvider not yet implemented. Use OpenAI or Cohere instead.")
  }
}

// ─── Mock Embedding Provider (for testing) ────────────────────────

/**
 * Mock embedding provider for testing.
 * Generates deterministic vectors based on text hash.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  private dims: number

  constructor(dimensions: number = 384) {
    this.dims = dimensions
  }

  name(): string {
    return `mock/${this.dims}d`
  }

  dimension(): number {
    return this.dims
  }

  async embed(text: string): Promise<number[]> {
    return this.generateDeterministic(text)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.generateDeterministic(t))
  }

  private generateDeterministic(text: string): number[] {
    // Simple hash-based deterministic vector generation
    const vec = new Array(this.dims).fill(0)
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i)
      vec[i % this.dims] += charCode / 128
    }
    // Normalize to unit vector
    let mag = 0
    for (const v of vec) mag += v * v
    mag = Math.sqrt(mag)
    if (mag > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= mag
    }
    return vec
  }
}

// ─── Factory ──────────────────────────────────────────────────────

/**
 * Create an EmbeddingProvider from environment variables.
 * Priority: OPENAI_API_KEY > COHERE_API_KEY > mock
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIEmbeddingProvider()
  }
  if (process.env.COHERE_API_KEY) {
    return new CohereEmbeddingProvider()
  }
  // Fallback to mock for development/testing
  return new MockEmbeddingProvider()
}
