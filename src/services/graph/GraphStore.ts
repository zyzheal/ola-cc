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

import { resolve } from 'path'
import { LRUCache } from './LRUCache.js'
import { CodegraphDbAdapter, GrokJsonAdapter } from './DataSourceAdapter.js'
import { GraphLoader, addEdgeToMaps } from './GraphLoader.js'

// ============================================================
// Types (aligned with design doc §2.3)
// ============================================================

export type EdgeType =
  | 'calls' | 'imports' | 'data' | 'control' | 'inherits' | 'implements'
  | 'contains' | 'exports' | 'type_of' | 'returns' | 'instantiates' | 'overrides'
  | 'decorates'
  // P1 edge types (F-53)
  | 'subscribes' | 'publishes' | 'middleware' | 'flow_step' | 'cross_domain'
  // P2 edge types (F-97-P2)
  | 'reads' | 'writes' | 'tests' | 'configures' | 'deploys' | 'monitors'
  | 'validates' | 'transforms' | 'caches' | 'queues' | 'notifies'
  // P3 edge types (F-97-P2)
  | 'serializes' | 'deserializes' | 'encrypts' | 'decrypts' | 'compresses'
  | 'logs' | 'metrics' | 'traces' | 'authenticates' | 'authorizes' | 'rate_limits'

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
// GraphStore
// ============================================================

export class GraphStore {
  private static instances = new Map<string, GraphStore>()

  public readonly adjacency = new Map<string, Map<string, EdgeMeta[]>>()
  public readonly reverse = new Map<string, Map<string, EdgeMeta[]>>()
  public readonly nodeMeta = new Map<string, NodeMetadata>()
  public readonly fileRecords = new Map<string, FileRecord>()  // F-54
  /** name/qualified_name → nodeId(s) 索引（doLoad 后自动构建，冲突时存储数组） */
  private readonly nameIndex = new Map<string, string | string[]>()
  /** 存在同名冲突的短名称集合（findByName 对这些名称返回 undefined） */
  private readonly ambiguousNames = new Set<string>()

  /** F-57: LRU 缓存用于高频节点访问 */
  private nodeCache = new LRUCache<string, NodeMetadata>(1000)

  private loaded = false
  private needsReloadFlag = false
  private loadingPromise: Promise<GraphData> | null = null
  private _loadedAt = 0
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
   * 删除 per-projectRoot 单例实例（测试清理用）
   */
  static deleteInstance(projectRoot: string): void {
    GraphStore.instances.delete(projectRoot)
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
   * Uses DataSourceAdapter for availability checking (F-95).
   * Delegates to GraphLoader for all loading/parsing/indexing.
   */
  private async doLoad(): Promise<GraphData> {
    // F-95: Use adapters for availability checking
    const codegraphAdapter = new CodegraphDbAdapter(this.projectRoot)
    const grokAdapter = new GrokJsonAdapter(this.projectRoot)

    const hasCodegraph = codegraphAdapter.isAvailable()
    const hasGrok = grokAdapter.isAvailable()

    if (!hasCodegraph && !hasGrok) {
      throw new GraphStoreError(
        'NO_DATA_SOURCE',
        '两个数据源都不存在。CodegraphTool/GrokTool 会自动初始化，或使用 Grep/Glob 工具进行文本搜索。',
        'codegraph_init / grok_generate / Grep / Glob',
      )
    }

    const loader = new GraphLoader(
      this.projectRoot,
      this.nodeMeta,
      this.adjacency,
      this.reverse,
      this.fileRecords,
    )

    // Phase 1b: fileKeyToId bridge — build during codegraph load, use in grok load
    let fileKeyToId: Map<string, string> | null = null

    if (hasCodegraph) {
      const codegraphDbPath = resolve(this.projectRoot, '.codegraph', 'codegraph.db')
      fileKeyToId = await loader.loadCodegraph(codegraphDbPath)
    }

    if (hasGrok) {
      const grokJsonPath = resolve(this.projectRoot, '.understand-anything', 'knowledge-graph.json')
      loader.loadGrok(grokJsonPath, fileKeyToId)
    }

    // Phase 4: Load non-code file parsers
    loader.loadParsers()

    // Re-export chain tracking: derive 'exports' edges from imports + export metadata
    await loader.extractReExports()

    // Build name/qualified_name → nodeId index
    await loader.buildNameIndex(this.nameIndex, this.ambiguousNames)

    this.loaded = true
    this.needsReloadFlag = false
    this._loadedAt = Date.now()
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
    this._cachedSize = null
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

  /**
   * Ensure the graph store is ready to use.
   * If allowStaleDb is true, will use existing DB even if CLI is unavailable.
   */
  async ensureReady(options?: { allowStaleDb?: boolean }): Promise<{
    ready: boolean
    stale: boolean
    lastSync?: number
    message?: string
  }> {
    try {
      if (this.isLoaded) return { ready: true, stale: false }
      await this.load()
      return { ready: true, stale: false }
    } catch (error) {
      if (options?.allowStaleDb && (this.adjacency.size > 0 || this.nodeMeta.size > 0)) {
        return {
          ready: true,
          stale: true,
          lastSync: this._loadedAt,
          message: 'Using existing index. Some data may be outdated.',
        }
      }
      return { ready: false, stale: false, message: String(error) }
    }
  }

  /**
   * Timestamp of last successful load (epoch ms).
   */
  get loadedAt(): number {
    return this._loadedAt
  }

  private clear(): void {
    this.adjacency.clear()
    this.reverse.clear()
    this.nodeMeta.clear()
    this.fileRecords.clear()
    this.nodeCache.clear()
    this.nameIndex.clear()
    this.ambiguousNames.clear()
    this.suffixIndex = null
  }

  // ----------------------------------------------------------
  // Re-export chain tracking (delegates to GraphLoader)
  // ----------------------------------------------------------

  /**
   * 从 imports 边 + 节点导出元数据推导 exports 边。
   *
   * 规则: 若节点 A 有 imports 边指向 B，且 B 的 is_exported=true 或 kind 包含 'export'，
   *       则创建 exports 边 A→B（A re-export 了 B 的符号）。
   *
   * 在 doLoad() 的两个数据源加载完毕后调用。
   */
  async extractReExports(): Promise<void> {
    const loader = new GraphLoader(
      this.projectRoot,
      this.nodeMeta,
      this.adjacency,
      this.reverse,
      this.fileRecords,
    )
    await loader.extractReExports()
  }

  // ----------------------------------------------------------
  // Adjacency helpers
  // ----------------------------------------------------------

  /** 添加边（公开给 CallbackSynthesizer 等内部模块使用） */
  addEdge(from: string, to: string, type: EdgeType, weight: number, confidence?: EdgeConfidence): void {
    addEdgeToMaps(this.adjacency, this.reverse, from, to, type, weight, confidence)
    this._cachedSize = null
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
   * 更新节点的 domain 字段（用于 enrichGraph 内存同步）
   */
  updateNodeDomain(nodeId: string, domain: string): void {
    const node = this.nodeMeta.get(nodeId)
    if (node) {
      node.domain = domain
      this.nodeCache.delete(nodeId) // 清除 LRU 缓存以反映更新
    }
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
   * 按 name 或 qualified_name 查找节点 ID（O(1) 索引查找）
   * 短名称存在同名冲突时返回 undefined（需用 qualified_name 精确查找）
   */
  findByName(name: string): string | undefined {
    if (this.ambiguousNames.has(name)) return undefined
    const entry = this.nameIndex.get(name)
    if (Array.isArray(entry)) return entry[0]
    return entry
  }

  /**
   * 按名称查找所有匹配的节点 ID（含歧义情况，O(1) 索引查找）
   */
  findAllByName(name: string): string[] {
    const entry = this.nameIndex.get(name)
    if (!entry) return []
    if (Array.isArray(entry)) return entry
    return [entry]
  }

  // ----------------------------------------------------------
  // 节点引用解析（支持多种格式：全ID、name、file:name、basename:name）
  // ----------------------------------------------------------

  /** 懒构建的路径后缀索引：suffix:name → nodeId（歧义时为 __AMBIGUOUS__） */
  private suffixIndex: Map<string, string> | null = null

  private buildSuffixIndex(): Map<string, string> {
    if (this.suffixIndex) return this.suffixIndex
    const index = new Map<string, string>()
    const ambiguous = new Set<string>()

    for (const [id, meta] of this.nodeMeta) {
      // 注册全路径
      const fullKey = `${meta.file}:${meta.name}`
      if (!index.has(fullKey)) index.set(fullKey, id)

      // 注册路径后缀（最多 3 级）
      const parts = meta.file.split('/')
      for (let i = 1; i <= Math.min(parts.length, 3); i++) {
        const suffix = parts.slice(-i).join('/')
        const key = `${suffix}:${meta.name}`
        if (index.has(key) && index.get(key) !== id) {
          ambiguous.add(key)
        } else {
          index.set(key, id)
        }
      }
    }

    // 标记歧义键
    for (const key of ambiguous) {
      index.set(key, '__AMBIGUOUS__')
    }

    this.suffixIndex = index
    return index
  }

  /**
   * 解析节点引用 — 支持多种格式
   * - 精确 ID: "src/auth.ts:login"
   * - 名称: "login"（唯一时匹配）
   * - file:name: "auth.ts:login"（路径后缀匹配）
   * @returns nodeId 或 null（无法解析时）
   */
  resolveNodeReference(ref: string): string | null {
    if (!ref) return null

    // 1. 精确 ID
    if (this.nodeMeta.has(ref)) return ref

    // 2. 名称索引（name / qualified_name）
    if (!this.ambiguousNames.has(ref)) {
      const entry = this.nameIndex.get(ref)
      if (typeof entry === 'string') return entry
    }

    // 3. file:name 路径后缀匹配
    const suffixIndex = this.buildSuffixIndex()
    const bySuffix = suffixIndex.get(ref)
    if (bySuffix && bySuffix !== '__AMBIGUOUS__') return bySuffix

    // 4. 唯一名称回退
    const nameEntry = this.nameIndex.get(ref)
    if (Array.isArray(nameEntry) && nameEntry.length === 1) return nameEntry[0]

    return null
  }

  /**
   * 使后缀索引失效（nodeMeta 变更后调用）
   */
  invalidateSuffixIndex(): void {
    this.suffixIndex = null
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
    if (this._cachedSize) return this._cachedSize
    let edgeCount = 0
    for (const map of this.adjacency.values()) {
      for (const edges of map.values()) {
        edgeCount += edges.length
      }
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
