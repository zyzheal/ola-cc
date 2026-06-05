/**
 * GraphStore — 统一图存储层
 *
 * 从 codegraph.db (SQLite) 和 knowledge-graph.json (Grok) 加载数据，
 * 合并为统一的加权邻接表表示。
 *
 * 设计文档: docs/superpowers/specs/2026-06-05-codegraph-grok-enhancement-design.md §2.2
 *
 * Phase 1b changes:
 * - EdgeType expansion: 7 → 12+1 (exports, type_of, returns, instantiates, overrides, decorates)
 * - Schema validation: PRAGMA table_info before SELECT, graceful handling of missing columns
 * - fileKeyToId identity bridge: Grok nodes merge with codegraph by file:name
 * - New public API: getOutNeighborIds, getInNeighborIds, getEdgeBetween, getOutDegree, getInDegree, getWeightedOutDegree
 * - loadingPromise concurrent lock: concurrent load() calls share same promise
 * - NodeMetadata extended fields: end_line, docstring, language, visibility, is_exported, is_async, is_static, is_abstract
 */

import { Database } from 'bun:sqlite'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { createDefaultRegistry } from './parsers/index.js'
import { LRUCache } from './LRUCache.js'
import { QueryCache } from './QueryCache.js'

// ============================================================
// Types (aligned with design doc §2.3)
// ============================================================

export type EdgeType =
  | 'calls' | 'imports' | 'data' | 'control' | 'inherits' | 'implements'
  | 'contains' | 'exports' | 'type_of' | 'returns' | 'instantiates' | 'overrides'
  | 'decorates'
  // P1 edge types (F-53)
  | 'subscribes' | 'publishes' | 'middleware' | 'flow_step' | 'cross_domain'

export type EdgeConfidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'

export interface EdgeMeta {
  type: EdgeType
  weight: number
  confidence?: EdgeConfidence   // F-85
  metadata?: Record<string, unknown>
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
  // Phase 1b extended fields (from codegraph.db)
  end_line?: number
  docstring?: string
  language?: string
  visibility?: string
  is_exported?: boolean
  is_async?: boolean
  is_static?: boolean
  is_abstract?: boolean
  // Phase Z1: full 21-field spec (F-52)
  start_column?: number
  end_column?: number
  decorators?: string[]
  type_parameters?: string[]
  updated_at?: number
  provenance?: string
}

export interface GraphData {
  adjacency: Map<string, Map<string, EdgeMeta[]>>
  reverse: Map<string, Map<string, EdgeMeta[]>>
  nodeMeta: Map<string, NodeMetadata>
}

/** F-54: File-level tracking record */
export interface FileRecord {
  path: string
  language: string
  size: number
  lineCount: number
  nodeCount: number
  contentHash: string
  lastModified: number
}

// ============================================================
// Edge type mapping (Phase 1b: expanded to 12+1)
// ============================================================

const CODEGRAPH_EDGE_MAP: Record<string, EdgeType> = {
  calls: 'calls',
  imports: 'imports',
  contains: 'contains',
  references: 'data',
  extends: 'inherits',
  implements: 'implements',
  exports: 'exports',
  type_of: 'type_of',
  returns: 'returns',
  instantiates: 'instantiates',
  overrides: 'overrides',
  decorates: 'decorates',
  // P1 edge types (F-53 / EdgeType P1)
  subscribes: 'subscribes',
  publishes: 'publishes',
  middleware: 'middleware',
  flow_step: 'flow_step',
  cross_domain: 'cross_domain',
}

const GROK_EDGE_MAP: Record<string, EdgeType> = {
  depends: 'imports',
  relates: 'control',
}

function mapCodegraphEdgeKind(kind: string): EdgeType {
  return CODEGRAPH_EDGE_MAP[kind] ?? 'control'
}

function mapGrokEdgeType(type: string): EdgeType {
  return GROK_EDGE_MAP[type] ?? 'control'
}

// ============================================================
// Schema-aware column resolution
// ============================================================

/** All columns we want to SELECT from nodes table (if they exist) — 21 fields (F-52) */
const DESIRED_NODE_COLUMNS = [
  'id', 'kind', 'name', 'qualified_name', 'file_path', 'start_line',
  'end_line', 'signature', 'docstring', 'language', 'visibility',
  'is_exported', 'is_async', 'is_static', 'is_abstract',
  'start_column', 'end_column', 'decorators', 'type_parameters',
  'updated_at', 'provenance',
] as const

/**
 * Query PRAGMA table_info to get existing columns, then return
 * the intersection with DESIRED_NODE_COLUMNS.
 */
function getExistingColumns(db: Database, table: string): string[] {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  const existing = new Set(rows.map(r => r.name))
  return DESIRED_NODE_COLUMNS.filter(col => existing.has(col))
}

// ============================================================
// GraphStore
// ============================================================

export class GraphStore {
  private static instances = new Map<string, GraphStore>()

  public readonly adjacency = new Map<string, Map<string, EdgeMeta[]>>()
  public readonly reverse = new Map<string, Map<string, EdgeMeta[]>>()
  public readonly nodeMeta = new Map<string, NodeMetadata>()
  public readonly fileRecords = new Map<string, FileRecord>()  // F-54

  /** F-57: LRU 缓存用于高频节点访问 */
  private nodeCache = new LRUCache<string, NodeMetadata>(1000)

  private loaded = false
  private needsReloadFlag = false
  private loadingPromise: Promise<GraphData> | null = null

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
   * Concurrent lock: multiple calls share the same loading promise.
   */
  async load(): Promise<GraphData> {
    if (this.loaded) {
      return { adjacency: this.adjacency, reverse: this.reverse, nodeMeta: this.nodeMeta }
    }

    if (this.loadingPromise) {
      return this.loadingPromise
    }

    this.loadingPromise = this.doLoad().catch(err => {
      // Clear loading promise on any error so next call retries
      this.loadingPromise = null
      throw err
    })
    return this.loadingPromise
  }

  /**
   * Actual loading logic (called once, shared via loadingPromise).
   */
  private async doLoad(): Promise<GraphData> {
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

    // Phase 1b: fileKeyToId bridge — build during codegraph load, use in grok load
    let fileKeyToId: Map<string, string> | null = null

    if (hasCodegraph) {
      fileKeyToId = await this.loadCodegraph(codegraphDbPath)
    }

    if (hasGrok) {
      this.loadGrok(grokJsonPath, fileKeyToId)
    }

    // Phase 4: Load non-code file parsers
    this.loadParsers(this.projectRoot)

    // Re-export chain tracking: derive 'exports' edges from imports + export metadata
    this.extractReExports()

    this.loaded = true
    this.needsReloadFlag = false
    return { adjacency: this.adjacency, reverse: this.reverse, nodeMeta: this.nodeMeta }
  }

  /**
   * 强制重新加载（IncrementalSync 检测到 dirty 时调用）
   */
  async reload(): Promise<GraphData> {
    this.clear()
    this.loaded = false
    this.needsReloadFlag = false
    this.loadingPromise = null
    return this.load()
  }

  /**
   * 标记为脏（IncrementalSync 检测到变更时调用）
   */
  markDirty(): void {
    this.loaded = false
    this.needsReloadFlag = true
    this.loadingPromise = null
  }

  /**
   * 是否需要重新加载（dirty 状态）
   */
  get needsReload(): boolean {
    return this.needsReloadFlag
  }

  /**
   * 获取当前数据（即使已过期）
   * 用于降级模式：即使数据不新鲜，也返回已加载的内容
   */
  getStale(): GraphData | null {
    if (this.nodeMeta.size === 0) return null
    return { adjacency: this.adjacency, reverse: this.reverse, nodeMeta: this.nodeMeta }
  }

  private clear(): void {
    this.adjacency.clear()
    this.reverse.clear()
    this.nodeMeta.clear()
    this.fileRecords.clear()
    this.nodeCache.clear()
  }

  // ----------------------------------------------------------
  // codegraph.db 加载 (bun:sqlite) — Phase 1b: schema-aware
  // ----------------------------------------------------------

  private async loadCodegraph(dbPath: string): Promise<Map<string, string>> {
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

    // Phase 1b: fileKeyToId bridge
    const fileKeyToId = new Map<string, string>()

    try {
      // Phase 1b: Schema-aware column selection
      const columns = getExistingColumns(db!, 'nodes')
      const selectClause = columns.map(c => c === 'start_line' ? 'start_line' : c).join(', ')

      const nodes = db!.query(`SELECT ${selectClause} FROM nodes`).all() as Array<Record<string, unknown>>

      for (const row of nodes) {
        const id = row.id as string
        const meta: NodeMetadata = {
          id,
          name: row.name as string,
          kind: row.kind as string,
          file: (row.file_path ?? '') as string,
          line: (row.start_line ?? 0) as number,
          signature: (row.signature as string) ?? undefined,
          qualified_name: (row.qualified_name as string) ?? undefined,
        }

        // Phase 1b: Extended fields (only set if column exists)
        if (row.end_line != null) meta.end_line = row.end_line as number
        if (row.docstring != null) meta.docstring = row.docstring as string
        if (row.language != null) meta.language = row.language as string
        if (row.visibility != null) meta.visibility = row.visibility as string
        if (row.is_exported != null) meta.is_exported = !!row.is_exported
        if (row.is_async != null) meta.is_async = !!row.is_async
        if (row.is_static != null) meta.is_static = !!row.is_static
        if (row.is_abstract != null) meta.is_abstract = !!row.is_abstract
        // Phase Z1: Full 21-field spec (F-52)
        if (row.start_column != null) meta.start_column = row.start_column as number
        if (row.end_column != null) meta.end_column = row.end_column as number
        if (row.decorators != null) meta.decorators = parseJsonArray(row.decorators as string)
        if (row.type_parameters != null) meta.type_parameters = parseJsonArray(row.type_parameters as string)
        if (row.updated_at != null) meta.updated_at = row.updated_at as number
        if (row.provenance != null) meta.provenance = row.provenance as string

        this.nodeMeta.set(id, meta)

        // Build file:name → codegraph id index
        const fileKey = `${meta.file}:${meta.name}`
        fileKeyToId.set(fileKey, id)
      }

      // 加载 edges
      const edges = db!.query('SELECT source, target, kind FROM edges').all() as Array<{
        source: string
        target: string
        kind: string
      }>

      for (const edge of edges) {
        const edgeType = mapCodegraphEdgeKind(edge.kind)
        this.addEdge(edge.source, edge.target, edgeType, 1, 'EXTRACTED')
      }

      // F-54: Build fileRecords from node data
      this.buildFileRecords()
    } finally {
      db!.close()
    }

    return fileKeyToId
  }

  // ----------------------------------------------------------
  // knowledge-graph.json 加载 — Phase 1b: fileKeyToId merge
  // ----------------------------------------------------------

  private loadGrok(jsonPath: string, fileKeyToId: Map<string, string> | null): void {
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

    // Phase 1b: Merge Grok nodes with codegraph nodes using fileKeyToId bridge
    for (const node of data.nodes) {
      const fileKey = `${node.file}:${node.name}`
      const codegraphId = fileKeyToId?.get(fileKey)

      if (codegraphId) {
        // Merge: add semantic fields to existing codegraph node
        const existing = this.nodeMeta.get(codegraphId)
        if (existing) {
          existing.layer = node.layer || existing.layer
          existing.domain = node.domain || existing.domain
        }
      } else {
        // Grok-only node: store with file:name key
        this.nodeMeta.set(fileKey, {
          id: fileKey,
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

    // 加载 Grok edges（合并到已有 adjacency）— AMBIGUOUS confidence (F-85)
    for (const edge of data.edges) {
      const edgeType = mapGrokEdgeType(edge.type)
      // Resolve edge endpoints: try fileKeyToId for codegraph merge
      const fromId = fileKeyToId?.get(edge.from) ?? edge.from
      const toId = fileKeyToId?.get(edge.to) ?? edge.to
      this.addEdge(fromId, toId, edgeType, 1, 'AMBIGUOUS')
    }
  }

  // ----------------------------------------------------------
  // Re-export chain tracking
  // ----------------------------------------------------------

  /**
   * 从 imports 边 + 节点导出元数据推导 exports 边。
   *
   * 规则: 若节点 A 有 imports 边指向 B，且 B 的 is_exported=true 或 kind 包含 'export'，
   *       则创建 exports 边 A→B（A re-export 了 B 的符号）。
   *
   * 在 doLoad() 的两个数据源加载完毕后调用。
   */
  extractReExports(): void {
    let reExportCount = 0

    for (const [from, outMap] of this.adjacency) {
      for (const [to, edges] of outMap) {
        const hasImports = edges.some(e => e.type === 'imports')
        if (!hasImports) continue

        const targetMeta = this.nodeMeta.get(to)
        if (!targetMeta) continue

        // 检查目标节点是否是导出的符号
        const isExported = targetMeta.is_exported === true
          || targetMeta.kind.includes('export')

        if (isExported) {
          // 创建 exports 边（如果尚不存在）
          const existingExports = edges.find(e => e.type === 'exports')
          if (!existingExports) {
            this.addEdge(from, to, 'exports', 1)
            reExportCount++
          }
        }
      }
    }

    if (reExportCount > 0) {
      logForDebugging(`[GraphStore] extractReExports: derived ${reExportCount} exports edge(s)`)
    }
  }

  // ----------------------------------------------------------
  // Phase 4: Non-code file parsers
  // ----------------------------------------------------------

  /**
   * Parse non-code files (Dockerfile, CI, YAML, JSON, etc.) and merge
   * extracted nodes/edges into the graph.
   */
  private loadParsers(projectRoot: string): void {
    try {
      const registry = createDefaultRegistry()
      const results = registry.parseAll(projectRoot)

      let totalNodes = 0
      let totalEdges = 0

      for (const result of results) {
        for (const node of result.nodes) {
          const parserEdgeType: EdgeMeta['type'] = 'control'
          this.nodeMeta.set(node.id, {
            id: node.id,
            name: node.name,
            kind: node.kind,
            file: node.file,
            line: node.line,
            ...node.metadata as Record<string, unknown>,
          })
          totalNodes++
        }

        for (const edge of result.edges) {
          // Map parser edge types to GraphStore edge types — INFERRED confidence (F-85)
          const edgeType = this.mapParserEdgeType(edge.type)
          this.addEdge(edge.from, edge.to, edgeType, 1, 'INFERRED')
          totalEdges++
        }
      }

      if (results.length > 0) {
        logForDebugging(`[GraphStore] loadParsers: ${results.length} files, ${totalNodes} nodes, ${totalEdges} edges`)
      }
    } catch (e) {
      // Parser errors are non-fatal — log and continue
      logForDebugging(`[GraphStore] loadParsers failed (non-fatal): ${e}`)
    }
  }

  /**
   * Map parser edge type strings to GraphStore EdgeMeta types.
   */
  private mapParserEdgeType(type: string): EdgeType {
    switch (type) {
      case 'uses': return 'control'
      case 'depends': return 'imports'
      case 'triggers': return 'control'
      case 'references': return 'data'
      case 'contains': return 'contains'
      case 'exposes': return 'control'
      case 'defines': return 'contains'
      case 'executes': return 'control'
      case 'extends': return 'inherits'
      case 'indexes': return 'data'
      case 'has_field': return 'contains'
      case 'has_column': return 'contains'
      case 'has_rpc': return 'contains'
      case 'accepts': return 'data'
      case 'returns': return 'data'
      default: return 'control'
    }
  }

  // ----------------------------------------------------------
  // Adjacency helpers
  // ----------------------------------------------------------

  private addEdge(from: string, to: string, type: EdgeType, weight: number, confidence?: EdgeConfidence): void {
    const edgeMeta: EdgeMeta = { type, weight, confidence }

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
   * 获取节点元数据（F-57: LRU 缓存加速高频访问）
   */
  getNode(nodeId: string): NodeMetadata | undefined {
    // 先查 LRU 缓存
    const cached = this.nodeCache.get(nodeId)
    if (cached) return cached

    // 再查主存储
    const node = this.nodeMeta.get(nodeId)
    if (node) {
      this.nodeCache.set(nodeId, node)
    }
    return node
  }

  /**
   * F-58: 批量获取节点元数据（返回 Map 保持 O(1) 查找）
   */
  getNodesByIds(ids: string[]): Map<string, NodeMetadata> {
    const result = new Map<string, NodeMetadata>()
    for (const id of ids) {
      const node = this.getNode(id)
      if (node) {
        result.set(id, node)
      }
    }
    return result
  }

  /**
   * F-57: 获取 LRU 缓存命中率（用于性能监控）
   */
  get nodeCacheStats(): { hits: number; misses: number; hitRate: number; size: number } {
    return { ...this.nodeCache.stats, size: this.nodeCache.size }
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

  // ----------------------------------------------------------
  // Phase 1b: New public API methods
  // ----------------------------------------------------------

  /**
   * Get unique outgoing neighbor IDs for a node.
   */
  getOutNeighborIds(nodeId: string): string[] {
    const outMap = this.adjacency.get(nodeId)
    if (!outMap) return []
    return [...outMap.keys()]
  }

  /**
   * Get unique incoming neighbor IDs for a node.
   */
  getInNeighborIds(nodeId: string): string[] {
    const inMap = this.reverse.get(nodeId)
    if (!inMap) return []
    return [...inMap.keys()]
  }

  /**
   * Get all edges between two nodes (in either direction combined, but typically from→to).
   */
  getEdgeBetween(from: string, to: string): EdgeMeta[] {
    return this.adjacency.get(from)?.get(to) ?? []
  }

  /**
   * Get out-degree (number of unique outgoing edges).
   */
  getOutDegree(nodeId: string): number {
    const outMap = this.adjacency.get(nodeId)
    if (!outMap) return 0
    let count = 0
    for (const edges of outMap.values()) {
      count += edges.length
    }
    return count
  }

  /**
   * Get in-degree (number of unique incoming edges).
   */
  getInDegree(nodeId: string): number {
    const inMap = this.reverse.get(nodeId)
    if (!inMap) return 0
    let count = 0
    for (const edges of inMap.values()) {
      count += edges.length
    }
    return count
  }

  /**
   * Get weighted out-degree (sum of weights of outgoing edges).
   * Optionally exclude specific edge types.
   */
  getWeightedOutDegree(nodeId: string, excludeTypes?: string[]): number {
    const outMap = this.adjacency.get(nodeId)
    if (!outMap) return 0
    let total = 0
    for (const edges of outMap.values()) {
      for (const edge of edges) {
        if (!excludeTypes || !excludeTypes.includes(edge.type)) {
          total += edge.weight
        }
      }
    }
    return total
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

  // ----------------------------------------------------------
  // F-54: Build fileRecords from nodeMeta
  // ----------------------------------------------------------

  private buildFileRecords(): void {
    const fileMap = new Map<string, { nodeCount: number; maxLine: number; language?: string }>()

    for (const node of this.nodeMeta.values()) {
      if (!node.file) continue
      const entry = fileMap.get(node.file)
      if (entry) {
        entry.nodeCount++
        if (node.line > entry.maxLine) entry.maxLine = node.line
        if (node.end_line && node.end_line > entry.maxLine) entry.maxLine = node.end_line
        if (node.language && !entry.language) entry.language = node.language
      } else {
        fileMap.set(node.file, {
          nodeCount: 1,
          maxLine: node.end_line ?? node.line,
          language: node.language,
        })
      }
    }

    for (const [path, info] of fileMap) {
      this.fileRecords.set(path, {
        path,
        language: info.language ?? 'unknown',
        size: 0,         // size requires filesystem stat — left as 0 for DB-only load
        lineCount: info.maxLine,
        nodeCount: info.nodeCount,
        contentHash: '',  // hash requires file read — left empty for DB-only load
        lastModified: 0,  // requires filesystem stat
      })
    }
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
// Helpers
// ============================================================

/** Parse a JSON array string, returning empty array on failure */
function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
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
