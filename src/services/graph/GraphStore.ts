/**
 * GraphStore — 统一图存储层
 *
 * 从 codegraph.db (SQLite) 和 knowledge-graph.json (Grok) 加载数据，
 * 合并为统一的加权邻接表表示。
 *
 * 设计文档: docs/superpowers/specs/2026-06-05-codegraph-grok-enhancement-design.md §2.2
 */

import { Database } from 'bun:sqlite'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { logForDebugging } from '../../utils/debug.js'

// ============================================================
// Types (aligned with design doc §2.3)
// ============================================================

export interface EdgeMeta {
  type: 'calls' | 'imports' | 'data' | 'control' | 'inherits' | 'implements' | 'contains'
  weight: number
}

export interface NodeMetadata {
  id: string
  name: string
  kind: string
  file: string
  line: number
  signature?: string
  qualified_name?: string
  layer?: string
  domain?: string
}

export interface GraphData {
  adjacency: Map<string, Map<string, EdgeMeta[]>>
  reverse: Map<string, Map<string, EdgeMeta[]>>
  nodeMeta: Map<string, NodeMetadata>
}

// ============================================================
// Edge type mapping (design doc §2.2 v8)
// ============================================================

const CODEGRAPH_EDGE_MAP: Record<string, EdgeMeta['type']> = {
  calls: 'calls',
  imports: 'imports',
  contains: 'contains',
  references: 'data',
  extends: 'inherits',
  implements: 'implements',
  instantiates: 'calls',
}

const GROK_EDGE_MAP: Record<string, EdgeMeta['type']> = {
  depends: 'imports',
  relates: 'control',
}

function mapCodegraphEdgeKind(kind: string): EdgeMeta['type'] {
  return CODEGRAPH_EDGE_MAP[kind] ?? 'control'
}

function mapGrokEdgeType(type: string): EdgeMeta['type'] {
  return GROK_EDGE_MAP[type] ?? 'control'
}

// ============================================================
// GraphStore
// ============================================================

export class GraphStore {
  private static instances = new Map<string, GraphStore>()

  public readonly adjacency = new Map<string, Map<string, EdgeMeta[]>>()
  public readonly reverse = new Map<string, Map<string, EdgeMeta[]>>()
  public readonly nodeMeta = new Map<string, NodeMetadata>()

  private loaded = false

  private constructor(private readonly projectRoot: string) {}

  /**
   * 获取 per-projectRoot 单例实例
   */
  static getInstance(projectRoot: string): GraphStore {
    let instance = GraphStore.instances.get(projectRoot)
    if (!instance) {
      instance = new GraphStore(projectRoot)
      GraphStore.instances.set(projectRoot, instance)
    }
    return instance
  }

  /**
   * 加载数据源（惰性，首次调用时执行）
   */
  async load(): Promise<GraphData> {
    if (this.loaded) {
      return { adjacency: this.adjacency, reverse: this.reverse, nodeMeta: this.nodeMeta }
    }

    const codegraphDbPath = resolve(this.projectRoot, '.codegraph', 'codegraph.db')
    const grokJsonPath = resolve(this.projectRoot, '.understand-anything', 'knowledge-graph.json')

    const hasCodegraph = existsSync(codegraphDbPath)
    const hasGrok = existsSync(grokJsonPath)

    if (!hasCodegraph && !hasGrok) {
      throw new GraphStoreError(
        'NO_DATA_SOURCE',
        '两个数据源都不存在。请先执行 codegraph_init 或 grok_generate。',
        'codegraph_init / grok_generate',
      )
    }

    if (hasCodegraph) {
      await this.loadCodegraph(codegraphDbPath)
    }

    if (hasGrok) {
      this.loadGrok(grokJsonPath)
    }

    this.loaded = true
    return { adjacency: this.adjacency, reverse: this.reverse, nodeMeta: this.nodeMeta }
  }

  /**
   * 强制重新加载（IncrementalSync 检测到 dirty 时调用）
   */
  async reload(): Promise<GraphData> {
    this.clear()
    this.loaded = false
    return this.load()
  }

  /**
   * 标记为脏（IncrementalSync 检测到变更时调用）
   */
  markDirty(): void {
    this.loaded = false
  }

  private clear(): void {
    this.adjacency.clear()
    this.reverse.clear()
    this.nodeMeta.clear()
  }

  // ----------------------------------------------------------
  // codegraph.db 加载 (bun:sqlite)
  // ----------------------------------------------------------

  private async loadCodegraph(dbPath: string): Promise<void> {
    let db: Database
    try {
      db = new Database(dbPath, { readonly: true })
    } catch (e) {
      // WAL 锁冲突重试：3 次，指数退避 100ms/200ms/400ms
      for (let i = 0; i < 3; i++) {
        await sleep(100 * Math.pow(2, i))
        try {
          db = new Database(dbPath, { readonly: true })
          break
        } catch {
          if (i === 2) {
            throw new GraphStoreError(
              'SQLITE_BUSY',
              'codegraph.db 被锁定（可能正在索引），请稍后重试。',
              'codegraph_init',
            )
          }
        }
      }
    }

    try {
      // 加载 nodes
      const nodes = db!.query('SELECT id, kind, name, qualified_name, file_path, start_line, signature FROM nodes').all() as Array<{
        id: string
        kind: string
        name: string
        qualified_name: string
        file_path: string
        start_line: number
        signature: string | null
      }>

      for (const node of nodes) {
        const meta: NodeMetadata = {
          id: node.id,
          name: node.name,
          kind: node.kind,
          file: node.file_path,
          line: node.start_line,
          signature: node.signature ?? undefined,
          qualified_name: node.qualified_name,
        }
        this.nodeMeta.set(node.id, meta)
      }

      // 加载 edges
      const edges = db!.query('SELECT source, target, kind FROM edges').all() as Array<{
        source: string
        target: string
        kind: string
      }>

      for (const edge of edges) {
        const edgeType = mapCodegraphEdgeKind(edge.kind)
        this.addEdge(edge.source, edge.target, edgeType, 1)
      }
    } finally {
      db!.close()
    }
  }

  // ----------------------------------------------------------
  // knowledge-graph.json 加载
  // ----------------------------------------------------------

  private loadGrok(jsonPath: string): void {
    let raw: string
    try {
      raw = readFileSync(jsonPath, 'utf-8')
    } catch (e) {
      logForDebugging(`[GraphStore] Failed to read ${jsonPath}: ${e}`)
      return
    }

    let data: { nodes?: GrokNode[]; edges?: GrokEdge[] }
    try {
      data = JSON.parse(raw)
    } catch (e) {
      throw new GraphStoreError(
        'JSON_PARSE_ERROR',
        `知识图谱 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
        'grok_generate',
      )
    }

    if (!data.nodes || !data.edges) {
      logForDebugging('[GraphStore] Grok JSON missing nodes or edges')
      return
    }

    // 加载 Grok nodes（合并到已有 nodeMeta）
    for (const node of data.nodes) {
      const key = `${node.file}:${node.name}`
      const existing = this.nodeMeta.get(key)

      if (existing) {
        // 合并：语义字段以 Grok 为准
        existing.layer = node.layer || existing.layer
        existing.domain = node.domain || existing.domain
      } else {
        // Grok 独有节点
        this.nodeMeta.set(key, {
          id: key,
          name: node.name,
          kind: node.kind,
          file: node.file,
          line: node.line,
          signature: node.signature,
          layer: node.layer,
          domain: node.domain,
        })
      }
    }

    // 加载 Grok edges（合并到已有 adjacency）
    for (const edge of data.edges) {
      const edgeType = mapGrokEdgeType(edge.type)
      this.addEdge(edge.from, edge.to, edgeType, 1)
    }
  }

  // ----------------------------------------------------------
  // Adjacency helpers
  // ----------------------------------------------------------

  private addEdge(from: string, to: string, type: EdgeMeta['type'], weight: number): void {
    const edgeMeta: EdgeMeta = { type, weight }

    // 正向
    let fromMap = this.adjacency.get(from)
    if (!fromMap) {
      fromMap = new Map()
      this.adjacency.set(from, fromMap)
    }
    const existing = fromMap.get(to)
    if (!existing) {
      fromMap.set(to, [edgeMeta])
    } else {
      // 检查是否已有同类型边
      const sameType = existing.find(e => e.type === type)
      if (sameType) {
        // 同类型边去重，保留最高权重
        sameType.weight = Math.max(sameType.weight, weight)
      } else {
        // 不同类型边追加到数组
        existing.push(edgeMeta)
      }
    }

    // 反向
    let toReverse = this.reverse.get(to)
    if (!toReverse) {
      toReverse = new Map()
      this.reverse.set(to, toReverse)
    }
    const existingRev = toReverse.get(from)
    if (!existingRev) {
      toReverse.set(from, [edgeMeta])
    } else {
      const sameTypeRev = existingRev.find(e => e.type === type)
      if (sameTypeRev) {
        sameTypeRev.weight = Math.max(sameTypeRev.weight, weight)
      } else {
        existingRev.push(edgeMeta)
      }
    }
  }

  /**
   * 获取节点的出边
   */
  getOutEdges(nodeId: string): Map<string, EdgeMeta[]> {
    return this.adjacency.get(nodeId) ?? new Map()
  }

  /**
   * 获取节点的入边
   */
  getInEdges(nodeId: string): Map<string, EdgeMeta[]> {
    return this.reverse.get(nodeId) ?? new Map()
  }

  /**
   * 获取节点元数据
   */
  getNode(nodeId: string): NodeMetadata | undefined {
    return this.nodeMeta.get(nodeId)
  }

  /**
   * 兼容性辅助：获取单个边类型（返回第一个匹配的边）
   */
  getEdge(from: string, to: string, type?: string): EdgeMeta | undefined {
    const edges = this.adjacency.get(from)?.get(to)
    if (!edges) return undefined
    if (type) return edges.find(e => e.type === type)
    return edges[0]
  }

  /**
   * 兼容性辅助：获取所有边（展平数组）
   */
  getAllOutEdges(nodeId: string): Array<{ target: string; edge: EdgeMeta }> {
    const result: Array<{ target: string; edge: EdgeMeta }> = []
    const outMap = this.adjacency.get(nodeId)
    if (!outMap) return result
    for (const [target, edges] of outMap) {
      for (const edge of edges) {
        result.push({ target, edge })
      }
    }
    return result
  }

  /**
   * 兼容性辅助：获取所有入边（展平数组）
   */
  getAllInEdges(nodeId: string): Array<{ source: string; edge: EdgeMeta }> {
    const result: Array<{ source: string; edge: EdgeMeta }> = []
    const inMap = this.reverse.get(nodeId)
    if (!inMap) return result
    for (const [source, edges] of inMap) {
      for (const edge of edges) {
        result.push({ source, edge })
      }
    }
    return result
  }

  /**
   * 图规模
   */
  get size(): { nodes: number; edges: number } {
    let edgeCount = 0
    for (const map of this.adjacency.values()) {
      for (const edges of map.values()) {
        edgeCount += edges.length
      }
    }
    return { nodes: this.nodeMeta.size, edges: edgeCount }
  }

  /**
   * 判断是否已加载
   */
  get isLoaded(): boolean {
    return this.loaded
  }
}

// ============================================================
// Grok JSON types
// ============================================================

interface GrokNode {
  id: string
  name: string
  kind: string
  file: string
  line: number
  signature?: string
  layer?: string
  domain?: string
}

interface GrokEdge {
  from: string
  to: string
  type: string
}

// ============================================================
// Error
// ============================================================

export class GraphStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message)
    this.name = 'GraphStoreError'
  }
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
