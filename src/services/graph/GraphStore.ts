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

export type EdgeType =
  | 'calls' | 'imports' | 'contains' | 'data'
  | 'inherits' | 'implements' | 'exports'
  | 'type_of' | 'returns' | 'instantiates'
  | 'overrides' | 'decorates'
  | 'control' // fallback

export interface EdgeMeta {
  type: EdgeType
  weight: number
  confidence?: number
  sourceLine?: number
  sourceColumn?: number
  provenance?: string
  metadata?: Record<string, unknown>
}

export interface NodeMetadata {
  // 核心标识
  id: string
  name: string
  kind: string
  qualified_name?: string

  // 位置信息
  file: string
  line: number
  end_line?: number
  start_column?: number
  end_column?: number

  // 语言信息
  language?: string

  // 文档信息
  signature?: string
  docstring?: string

  // 访问控制
  visibility?: 'public' | 'private' | 'protected' | 'internal'
  is_exported?: boolean

  // 类型修饰
  is_async?: boolean
  is_static?: boolean
  is_abstract?: boolean

  // 高级特性
  decorators?: string[]
  type_parameters?: string[]

  // 元信息
  updated_at?: number
  provenance?: string

  // Grok 语义字段
  layer?: string
  domain?: string

  // 社区/执行流 (来自三项目增强)
  community_id?: number
  process_ids?: string[]
}

export interface FileRecord {
  path: string
  content_hash: string
  language: string
  size: number
  modified_at: number
  indexed_at: number
  node_count: number
  errors?: string
}

export interface GraphData {
  adjacency: Map<string, Map<string, EdgeMeta[]>>
  reverse: Map<string, Map<string, EdgeMeta[]>>
  nodeMeta: Map<string, NodeMetadata>
  files: Map<string, FileRecord>
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
  private _cachedSize: { nodes: number; edges: number } | null = null

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
   * Copy-on-write: 加载到临时结构，成功后原子交换，避免并发算法看到空数据
   */
  async reload(): Promise<GraphData> {
    const tmpAdj = new Map<string, Map<string, EdgeMeta[]>>()
    const tmpRev = new Map<string, Map<string, EdgeMeta[]>>()
    const tmpMeta = new Map<string, NodeMetadata>()

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
      await this.loadCodegraphTo(codegraphDbPath, tmpAdj, tmpRev, tmpMeta)
    }

    if (hasGrok) {
      this.loadGrokTo(grokJsonPath, tmpAdj, tmpRev, tmpMeta)
    }

    // Copy-on-write: 替换引用（JS 单线程下引用赋值是瞬时的）
    // 并发算法持有的旧 Map 引用不受影响，直到它们重新读取 this.adjacency
    ;(this as { adjacency: typeof this.adjacency }).adjacency = tmpAdj
    ;(this as { reverse: typeof this.reverse }).reverse = tmpRev
    ;(this as { nodeMeta: typeof this.nodeMeta }).nodeMeta = tmpMeta

    this.loaded = true
    this._cachedSize = null
    return { adjacency: this.adjacency, reverse: this.reverse, nodeMeta: this.nodeMeta }
  }

  /**
   * 标记为脏（IncrementalSync 检测到变更时调用）
   */
  markDirty(): void {
    this.loaded = false
    this._cachedSize = null
  }

  private clear(): void {
    this.adjacency.clear()
    this.reverse.clear()
    this.nodeMeta.clear()
    this._cachedSize = null
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

  private addEdgeTo(
    from: string, to: string, type: EdgeMeta['type'], weight: number,
    adj: Map<string, Map<string, EdgeMeta[]>>,
    rev: Map<string, Map<string, EdgeMeta[]>>,
  ): void {
    let fromMap = adj.get(from)
    if (!fromMap) { fromMap = new Map(); adj.set(from, fromMap) }
    let edges = fromMap.get(to)
    if (!edges) { edges = []; fromMap.set(to, edges) }
    const existing = edges.find(e => e.type === type)
    if (existing) { existing.weight = Math.max(existing.weight, weight) }
    else { edges.push({ type, weight }) }

    let toReverse = rev.get(to)
    if (!toReverse) { toReverse = new Map(); rev.set(to, toReverse) }
    let revEdges = toReverse.get(from)
    if (!revEdges) { revEdges = []; toReverse.set(from, revEdges) }
    const existingRev = revEdges.find(e => e.type === type)
    if (existingRev) { existingRev.weight = Math.max(existingRev.weight, weight) }
    else { revEdges.push({ type, weight }) }
  }

  private async loadCodegraphTo(
    dbPath: string,
    adj: Map<string, Map<string, EdgeMeta[]>>,
    rev: Map<string, Map<string, EdgeMeta[]>>,
    meta: Map<string, NodeMetadata>,
  ): Promise<void> {
    let db: Database
    try {
      db = new Database(dbPath, { readonly: true })
    } catch (e) {
      for (let i = 0; i < 3; i++) {
        await sleep(100 * Math.pow(2, i))
        try { db = new Database(dbPath, { readonly: true }); break }
        catch {
          if (i === 2) throw new GraphStoreError('SQLITE_BUSY', 'codegraph.db 被锁定（可能正在索引），请稍后重试。', 'codegraph_init')
        }
      }
    }
    try {
      const nodes = db!.query('SELECT id, kind, name, qualified_name, file_path, start_line, signature FROM nodes').all() as Array<{
        id: string; kind: string; name: string; qualified_name: string; file_path: string; start_line: number; signature: string | null
      }>
      for (const node of nodes) {
        meta.set(node.id, {
          id: node.id, name: node.name, kind: node.kind,
          file: node.file_path, line: node.start_line,
          signature: node.signature ?? undefined, qualified_name: node.qualified_name,
        })
      }
      const edges = db!.query('SELECT source, target, kind FROM edges').all() as Array<{
        source: string; target: string; kind: string
      }>
      for (const edge of edges) {
        this.addEdgeTo(edge.source, edge.target, mapCodegraphEdgeKind(edge.kind), 1, adj, rev)
      }
    } finally { db!.close() }
  }

  private loadGrokTo(
    jsonPath: string,
    adj: Map<string, Map<string, EdgeMeta[]>>,
    rev: Map<string, Map<string, EdgeMeta[]>>,
    meta: Map<string, NodeMetadata>,
  ): void {
    let raw: string
    try { raw = readFileSync(jsonPath, 'utf-8') }
    catch (e) { logForDebugging(`[GraphStore] Failed to read ${jsonPath}: ${e}`); return }

    let data: { nodes?: GrokNode[]; edges?: GrokEdge[] }
    try { data = JSON.parse(raw) }
    catch (e) {
      throw new GraphStoreError('JSON_PARSE_ERROR', `知识图谱 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`, 'grok_generate')
    }
    if (!data.nodes || !data.edges) { logForDebugging('[GraphStore] Grok JSON missing nodes or edges'); return }

    for (const node of data.nodes) {
      const key = `${node.file}:${node.name}`
      const existing = meta.get(key)
      if (existing) {
        existing.layer = node.layer || existing.layer
        existing.domain = node.domain || existing.domain
      } else {
        meta.set(key, {
          id: key, name: node.name, kind: node.kind,
          file: node.file, line: node.line,
          signature: node.signature, layer: node.layer, domain: node.domain,
        })
      }
    }
    for (const edge of data.edges) {
      this.addEdgeTo(edge.from, edge.to, mapGrokEdgeType(edge.type), 1, adj, rev)
    }
  }

  private addEdge(from: string, to: string, type: EdgeMeta['type'], weight: number): void {
    this._cachedSize = null
    // 正向
    let fromMap = this.adjacency.get(from)
    if (!fromMap) {
      fromMap = new Map()
      this.adjacency.set(from, fromMap)
    }
    let edges = fromMap.get(to)
    if (!edges) {
      edges = []
      fromMap.set(to, edges)
    }
    // 同类型边去重，保留最高权重
    const existing = edges.find(e => e.type === type)
    if (existing) {
      existing.weight = Math.max(existing.weight, weight)
    } else {
      edges.push({ type, weight })
    }

    // 反向
    let toReverse = this.reverse.get(to)
    if (!toReverse) {
      toReverse = new Map()
      this.reverse.set(to, toReverse)
    }
    let revEdges = toReverse.get(from)
    if (!revEdges) {
      revEdges = []
      toReverse.set(from, revEdges)
    }
    const existingRev = revEdges.find(e => e.type === type)
    if (existingRev) {
      existingRev.weight = Math.max(existingRev.weight, weight)
    } else {
      revEdges.push({ type, weight })
    }
  }

  /**
   * 获取节点的出边（每条目标边返回 EdgeMeta[]）
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
   * 获取节点的入邻居 ID 列表
   */
  getInNeighborIds(nodeId: string): string[] {
    return [...this.getInEdges(nodeId).keys()]
  }

  /**
   * 获取节点的出邻居 ID 列表
   */
  getOutNeighborIds(nodeId: string): string[] {
    return [...this.getOutEdges(nodeId).keys()]
  }

  /**
   * 获取节点的加权出度（可排除指定边类型）
   */
  getWeightedOutDegree(nodeId: string, excludeTypes?: string[]): number {
    const edgeMap = this.adjacency.get(nodeId)
    if (!edgeMap) return 0
    let sum = 0
    for (const [, edges] of edgeMap) {
      for (const meta of edges) {
        if (excludeTypes?.includes(meta.type)) continue
        sum += meta.weight
      }
    }
    return sum
  }

  /**
   * 获取节点元数据
   */
  getNode(nodeId: string): NodeMetadata | undefined {
    return this.nodeMeta.get(nodeId)
  }

  /**
   * 图规模
   */
  get size(): { nodes: number; edges: number } {
    if (this._cachedSize) return this._cachedSize
    let edgeCount = 0
    for (const map of this.adjacency.values()) {
      edgeCount += map.size
    }
    this._cachedSize = { nodes: this.nodeMeta.size, edges: edgeCount }
    return this._cachedSize
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
