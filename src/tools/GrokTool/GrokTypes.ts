// src/tools/GrokTool/GrokTypes.ts
// Shared types, error classes, and constants for Grok modules

// ============================================================
// Types
// ============================================================

export interface GrokGenerateOptions {
  path?: string           // 扫描路径，默认项目根目录
  language?: string       // 输出语言，默认 'en'
  scope?: string          // 子目录范围
  incremental?: boolean   // 增量更新，默认 true
  onProgress?: (stage: string, progress: number) => void  // 进度回调
}

export interface GrokGenerateResult {
  status: 'success' | 'partial' | 'failed'
  nodeCount: number
  edgeCount: number
  domainCount: number
  filePath: string        // knowledge-graph.json 路径
  errors?: GrokError[]    // 部分失败时的错误列表
}

export interface GrokChatResult {
  answer: string
  sources: { file: string; line: number; relevance: number }[]
}

export interface GrokGraphStatus {
  exists: boolean
  nodeCount?: number
  edgeCount?: number
  lastUpdated?: string
  stale?: boolean
}

// 图谱数据类型（替代 any）
export interface GraphNode {
  id: string
  name: string
  kind: string
  file: string
  line: number
  signature: string
  summary: string
  layer: string
  domain: string
}

export interface GraphEdge {
  from: string
  to: string
  type: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  metadata: {
    lastUpdated: string
    fileCount: number
    languages: string[]
    frameworks: string[]
    layers: string[]
    uncovered: number
    tour: unknown[]
    review: unknown
    language: string
    errors: { code: string; stage: string; message: string }[]
    fingerprints: Record<string, { hash: string; size: number }>
  }
}

// ============================================================
// Error Classes
// ============================================================

export class GrokError extends Error {
  constructor(
    public code: string,
    public stage: string,
    message: string,
    public recoverable: boolean,
    public suggestion?: string
  ) {
    super(message)
    this.name = 'GrokError'
  }
}

// 错误类型与建议
export const ERROR_SUGGESTIONS: Record<string, string> = {
  'PARSE_TIMEOUT': '文件过大，建议 --exclude 排除或拆分文件',
  'LLM_RATE_LIMIT': 'API 限流，建议等待 60s 后重试',
  'LLM_TOKEN_BUDGET': 'Token 预算耗尽，建议 --scope 缩小范围',
  'GRAPH_INVALID': '图谱数据损坏，建议 /grok --full 重新生成',
  'SOURCE_CLONE_FAILED': '源码克隆失败，检查网络连接后重试',
  'NO_DATA_SOURCE': '图谱数据未就绪，请使用 Grep/Glob 工具进行文本搜索，或执行 codegraph_init / grok_generate 初始化图谱。',
}
