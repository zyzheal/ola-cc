/**
 * GraphLoader — loading pipeline for GraphStore
 *
 * Extracts SQLite loading, JSON loading, re-export resolution,
 * non-code file parsing, and index building from GraphStore.
 *
 * Design: takes references to GraphStore's data maps and mutates them directly.
 * This preserves all existing behavior while separating concerns.
 */

import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
import { join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { createDefaultRegistry } from './parsers/index.js'
import { parseReExports } from './resolution/reExportParser.js'
import type {
  EdgeType, EdgeConfidence, EdgeMeta, NodeMetadata, FileRecord,
} from './GraphStore.js'
import { GraphStoreError } from './GraphStore.js'

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
  // P2 edge types (F-97-P2)
  reads: 'reads',
  writes: 'writes',
  tests: 'tests',
  configures: 'configures',
  deploys: 'deploys',
  monitors: 'monitors',
  validates: 'validates',
  transforms: 'transforms',
  caches: 'caches',
  queues: 'queues',
  notifies: 'notifies',
  // P3 edge types (F-97-P2)
  serializes: 'serializes',
  deserializes: 'deserializes',
  encrypts: 'encrypts',
  decrypts: 'decrypts',
  compresses: 'compresses',
  logs: 'logs',
  metrics: 'metrics',
  traces_edge: 'traces',    // 'traces' reserved for verb form
  authenticates: 'authenticates',
  authorizes: 'authorizes',
  rate_limits: 'rate_limits',
}

const GROK_EDGE_MAP: Record<string, EdgeType> = {
  depends: 'imports',
  relates: 'control',
}

export function mapCodegraphEdgeKind(kind: string): EdgeType {
  return CODEGRAPH_EDGE_MAP[kind] ?? 'control'
}

export function mapGrokEdgeType(type: string): EdgeType {
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
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`)
  }
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  const existing = new Set(rows.map(r => r.name))
  return DESIRED_NODE_COLUMNS.filter(col => existing.has(col))
}

// ============================================================
// Standalone addEdge utility
// ============================================================

/**
 * Add an edge to adjacency and reverse maps.
 * Shared between GraphStore.addEdge and GraphLoader.
 */
export function addEdgeToMaps(
  adjacency: Map<string, Map<string, EdgeMeta[]>>,
  reverse: Map<string, Map<string, EdgeMeta[]>>,
  from: string, to: string, type: EdgeType, weight: number, confidence?: EdgeConfidence,
): void {
  const edgeMeta: EdgeMeta = { type, weight, confidence }

  // 正向
  let fromMap = adjacency.get(from)
  if (!fromMap) {
    fromMap = new Map()
    adjacency.set(from, fromMap)
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
  let toReverse = reverse.get(to)
  if (!toReverse) {
    toReverse = new Map()
    reverse.set(to, toReverse)
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
// GraphLoader
// ============================================================

export class GraphLoader {
  constructor(
    private projectRoot: string,
    private nodeMeta: Map<string, NodeMetadata>,
    private adjacency: Map<string, Map<string, EdgeMeta[]>>,
    private reverse: Map<string, Map<string, EdgeMeta[]>>,
    private fileRecords: Map<string, FileRecord>,
  ) {}

  private addEdge(from: string, to: string, type: EdgeType, weight: number, confidence?: EdgeConfidence): void {
    addEdgeToMaps(this.adjacency, this.reverse, from, to, type, weight, confidence)
  }

  // ----------------------------------------------------------
  // codegraph.db 加载 (bun:sqlite) — Phase 1b: schema-aware
  // ----------------------------------------------------------

  async loadCodegraph(dbPath: string): Promise<Map<string, string>> {
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

  loadGrok(jsonPath: string, fileKeyToId: Map<string, string> | null): void {
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
  // Phase 4: Non-code file parsers
  // ----------------------------------------------------------

  /**
   * Parse non-code files (Dockerfile, CI, YAML, JSON, etc.) and merge
   * extracted nodes/edges into the graph.
   */
  loadParsers(): void {
    try {
      const registry = createDefaultRegistry()
      const results = registry.parseAll(this.projectRoot)

      let totalNodes = 0
      let totalEdges = 0

      for (const result of results) {
        for (const node of result.nodes) {
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

  // ----------------------------------------------------------
  // Re-export chain tracking
  // ----------------------------------------------------------

  /**
   * 从 imports 边 + 节点导出元数据推导 exports 边。
   *
   * 规则: 若节点 A 有 imports 边指向 B，且 B 的 is_exported=true 或 kind 包含 'export'，
   *       则创建 exports 边 A→B（A re-export 了 B 的符号）。
   */
  extractReExports(): void {
    let reExportCount = 0

    // Pass 1: adjacency-based derivation (original logic)
    // If node A has imports edge to B and B is exported, create exports edge A→B
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

    // Pass 2: source-level re-export parsing (Phase 6e)
    // Parse actual re-export statements from file content to create
    // more accurate exports edges based on `export { ... } from '...'`
    for (const [filePath, record] of this.fileRecords) {
      const language = record.language
      if (!language) continue

      let content: string
      try {
        const absPath = join(this.projectRoot, filePath)
        content = readFileSync(absPath, 'utf-8')
      } catch {
        continue
      }

      const reExports = parseReExports(content, language)
      if (reExports.length === 0) continue

      // Build a lookup of nodes in this file for the source module
      for (const reExport of reExports) {
        const sourceFile = this.resolveReExportSource(filePath, reExport.source)
        if (!sourceFile) continue

        if (reExport.kind === 'wildcard') {
          // For wildcard re-exports, find all exported nodes in the source file
          for (const [nodeId, meta] of this.nodeMeta) {
            if (meta.file === sourceFile && (meta.is_exported === true || meta.kind.includes('export'))) {
              const fromNodeId = this.findFileNodeId(filePath)
              if (fromNodeId && !this.edgeExists(fromNodeId, nodeId, 'exports')) {
                this.addEdge(fromNodeId, nodeId, 'exports', 1)
                reExportCount++
              }
            }
          }
        } else if (reExport.kind === 'named') {
          // For named re-exports, find the specific node by original name
          for (const [nodeId, meta] of this.nodeMeta) {
            if (meta.file === sourceFile && meta.name === reExport.originalName) {
              const fromNodeId = this.findFileNodeId(filePath)
              if (fromNodeId && !this.edgeExists(fromNodeId, nodeId, 'exports')) {
                this.addEdge(fromNodeId, nodeId, 'exports', 1)
                reExportCount++
              }
            }
          }
        }
      }
    }

    if (reExportCount > 0) {
      logForDebugging(`[GraphStore] extractReExports: derived ${reExportCount} exports edge(s)`)
    }
  }

  // ----------------------------------------------------------
  // Index building
  // ----------------------------------------------------------

  /**
   * F-54: Build fileRecords from nodeMeta
   */
  buildFileRecords(): void {
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

  /**
   * 构建 name/qualified_name → nodeId(s) 索引，检测同名冲突
   */
  buildNameIndex(nameIndex: Map<string, string | string[]>, ambiguousNames: Set<string>): void {
    // Phase 1: 收集每个短名称对应的所有节点
    const nameToIds = new Map<string, string[]>()
    for (const [nodeId, meta] of this.nodeMeta) {
      if (meta.name) {
        const ids = nameToIds.get(meta.name)
        if (ids) ids.push(nodeId)
        else nameToIds.set(meta.name, [nodeId])
      }
    }
    // Phase 2: 标记冲突的短名称，并存储冲突数组到索引
    for (const [name, ids] of nameToIds) {
      if (ids.length > 1) {
        ambiguousNames.add(name)
        nameIndex.set(name, ids)  // 存储数组，findAllByName O(1) 返回
      } else {
        nameIndex.set(name, ids[0])  // 唯一名称存储单值
      }
    }
    // Phase 3: 构建 qualified_name 索引（始终精确）
    for (const [nodeId, meta] of this.nodeMeta) {
      if (meta.qualified_name && !nameIndex.has(meta.qualified_name)) {
        nameIndex.set(meta.qualified_name, nodeId)
      }
    }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

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
      // P2 mappings from parsers
      case 'reads': return 'reads'
      case 'writes': return 'writes'
      case 'tests': return 'tests'
      case 'configures': return 'configures'
      case 'deploys': return 'deploys'
      case 'monitors': return 'monitors'
      case 'validates': return 'validates'
      case 'transforms': return 'transforms'
      case 'caches': return 'caches'
      case 'queues': return 'queues'
      case 'notifies': return 'notifies'
      // P3 mappings from parsers
      case 'serializes': return 'serializes'
      case 'deserializes': return 'deserializes'
      case 'encrypts': return 'encrypts'
      case 'decrypts': return 'decrypts'
      case 'compresses': return 'compresses'
      case 'logs': return 'logs'
      case 'metrics': return 'metrics'
      case 'traces_edge': return 'traces'
      case 'authenticates': return 'authenticates'
      case 'authorizes': return 'authorizes'
      case 'rate_limits': return 'rate_limits'
      default: return 'control'
    }
  }

  /**
   * Resolve a re-export source path relative to the importing file.
   * Returns the resolved file path if it exists in fileRecords.
   */
  private resolveReExportSource(fromFile: string, source: string): string | null {
    // Try direct match with common extensions
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']
    const dir = fromFile.includes('/') ? fromFile.substring(0, fromFile.lastIndexOf('/')) : ''

    for (const ext of extensions) {
      const candidate = source + ext
      // Try as-is
      if (this.fileRecords.has(candidate)) return candidate
      // Try stripping leading ./
      const stripped = candidate.startsWith('./') ? candidate.substring(2) : candidate
      if (this.fileRecords.has(stripped)) return stripped
      // Try relative to fromFile's directory (normalized)
      if (dir) {
        const joined = dir + '/' + stripped
        // Normalize: resolve ./ and ../ segments
        const normalized = this.normalizePath(joined)
        if (this.fileRecords.has(normalized)) return normalized
      }
    }
    return null
  }

  /**
   * Normalize a relative path by resolving . and .. segments.
   */
  private normalizePath(p: string): string {
    const parts = p.split('/')
    const result: string[] = []
    for (const part of parts) {
      if (part === '.' || part === '') continue
      if (part === '..') {
        result.pop()
      } else {
        result.push(part)
      }
    }
    return result.join('/')
  }

  /**
   * Find the first node ID belonging to a file (used as proxy for the file itself).
   */
  private findFileNodeId(filePath: string): string | null {
    for (const [, meta] of this.nodeMeta) {
      if (meta.file === filePath) return meta.id
    }
    return null
  }

  /**
   * Check if an edge of a given type already exists between two nodes.
   */
  private edgeExists(from: string, to: string, type: EdgeType): boolean {
    const outMap = this.adjacency.get(from)
    if (!outMap) return false
    const edges = outMap.get(to)
    if (!edges) return false
    return edges.some(e => e.type === type)
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
