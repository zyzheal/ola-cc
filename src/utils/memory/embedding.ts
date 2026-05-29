/**
 * EmbeddingService — 本地向量嵌入服务
 *
 * 使用 @xenova/transformers 的 all-MiniLM-L6-v2 模型（~80MB），
 * 本地运行，无需 API 调用。
 *
 * 特性：
 * - 模型懒加载（首次 embed 时才下载/加载）
 * - 批量嵌入支持
 * - 降级：模型不可用时返回 null（MemoryIndex 回退到纯 BM25）
 */

type EmbeddingVector = Float32Array

interface PipelineInstance {
  (text: string, options?: { pooling?: string; normalize?: boolean }): Promise<{ data: Float32Array }>
}

let pipelineCache: PipelineInstance | null = null
let loadPromise: Promise<PipelineInstance | null> | null = null

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2'
const EMBEDDING_DIM = 384

/**
 * 获取嵌入 pipeline（懒加载，单例）
 */
async function getPipeline(modelName?: string): Promise<PipelineInstance | null> {
  if (pipelineCache) return pipelineCache
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    try {
      const { pipeline } = await import('@xenova/transformers')
      const pipe = await pipeline('feature-extraction', modelName ?? DEFAULT_MODEL)
      pipelineCache = pipe as unknown as PipelineInstance
      return pipelineCache
    } catch {
      // 模型下载失败或环境不支持
      loadPromise = null
      return null
    }
  })()

  return loadPromise
}

/**
 * 将文本转换为向量
 *
 * @returns Float32Array 或 null（模型不可用时降级）
 */
export async function embedText(text: string, modelName?: string): Promise<EmbeddingVector | null> {
  const pipe = await getPipeline(modelName)
  if (!pipe) return null

  try {
    const output = await pipe(text, { pooling: 'mean', normalize: true })
    return output.data
  } catch {
    return null
  }
}

/**
 * 批量嵌入（逐条处理，避免 OOM）
 */
export async function embedBatch(
  texts: string[],
  modelName?: string,
): Promise<(EmbeddingVector | null)[]> {
  const pipe = await getPipeline(modelName)
  if (!pipe) return texts.map(() => null)

  const results: (EmbeddingVector | null)[] = []
  for (const text of texts) {
    try {
      const output = await pipe(text, { pooling: 'mean', normalize: true })
      results.push(output.data)
    } catch {
      results.push(null)
    }
  }
  return results
}

/**
 * 检查嵌入模型是否可用
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  const pipe = await getPipeline()
  return pipe !== null
}

/**
 * 获取嵌入维度
 */
export function getEmbeddingDim(): number {
  return EMBEDDING_DIM
}

/**
 * 计算两个向量的余弦相似度
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
