/**
 * StructuralFingerprint — 文件结构哈希 (F-21)
 *
 * 从 codegraph.db 计算每个文件的 AST 结构哈希，检测需要图重建的变更。
 *
 * 设计:
 *   - 数据源: codegraph.db nodes/edges (bun:sqlite)
 *   - 哈希输入: {name, kind, signature, start_line, end_line} + sorted outgoing edges
 *   - 持久化: .codegraph/fingerprints.json
 *   - delta: 比较 current vs persisted，返回 added/removed/changed
 */

import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'

// ============================================================
// Types
// ============================================================

export interface FileFingerprint {
  file: string
  hash: string
  nodeCount: number
  edgeCount: number
  lastModified: number
}

export interface FileChange {
  file: string
  oldHash: string
  newHash: string
  changeType: 'structure_changed' | 'lines_only' | 'unchanged'
}

export interface FingerprintDelta {
  added: string[]
  removed: string[]
  changed: FileChange[]
}

// codegraph.db row types
interface DbNode {
  id: string
  kind: string
  name: string
  file_path: string
  start_line: number
  end_line: number
  signature: string | null
}

interface DbEdge {
  source: string
  target: string
  kind: string
}

// ============================================================
// StructuralFingerprint
// ============================================================

export class StructuralFingerprint {
  private readonly dbPath: string
  private readonly persistPath: string

  constructor(private readonly projectRoot: string) {
    this.dbPath = resolve(projectRoot, '.codegraph', 'codegraph.db')
    this.persistPath = resolve(projectRoot, '.codegraph', 'fingerprints.json')
  }

  /**
   * 计算 codegraph.db 中所有文件的指纹
   */
  async compute(): Promise<Map<string, FileFingerprint>> {
    if (!existsSync(this.dbPath)) {
      return new Map()
    }

    const { nodes, edges } = this.loadDb()
    return this.computeFingerprints(nodes, edges)
  }

  /**
   * 从 .codegraph/fingerprints.json 加载已持久化的指纹
   */
  loadPersisted(): Map<string, FileFingerprint> {
    if (!existsSync(this.persistPath)) {
      return new Map()
    }

    try {
      const raw = readFileSync(this.persistPath, 'utf-8')
      const arr = JSON.parse(raw) as FileFingerprint[]
      return new Map(arr.map((f) => [f.file, f]))
    } catch {
      return new Map()
    }
  }

  /**
   * 持久化指纹到 .codegraph/fingerprints.json
   */
  save(fingerprints: Map<string, FileFingerprint>): void {
    const dir = dirname(this.persistPath)
    mkdirSync(dir, { recursive: true })

    const arr = Array.from(fingerprints.values())
    writeFileSync(this.persistPath, JSON.stringify(arr, null, 2), 'utf-8')
  }

  /**
   * 比较 current vs persisted，返回 delta
   */
  async delta(): Promise<FingerprintDelta> {
    const current = await this.compute()
    const persisted = this.loadPersisted()

    const added: string[] = []
    const removed: string[] = []
    const changed: FileChange[] = []

    // 检测新增和变更
    for (const [file, cur] of current) {
      const old = persisted.get(file)
      if (!old) {
        added.push(file)
      } else if (old.hash !== cur.hash) {
        changed.push({
          file,
          oldHash: old.hash,
          newHash: cur.hash,
          changeType: 'structure_changed',
        })
      }
    }

    // 检测删除
    for (const file of persisted.keys()) {
      if (!current.has(file)) {
        removed.push(file)
      }
    }

    return { added, removed, changed }
  }

  // ----------------------------------------------------------
  // 内部方法
  // ----------------------------------------------------------

  private loadDb(): { nodes: DbNode[]; edges: DbEdge[] } {
    const db = new Database(this.dbPath, { readonly: true })
    try {
      const nodes = db
        .query(
          'SELECT id, kind, name, file_path, start_line, end_line, signature FROM nodes',
        )
        .all() as DbNode[]

      const edges = db
        .query('SELECT source, target, kind FROM edges')
        .all() as DbEdge[]

      return { nodes, edges }
    } finally {
      db.close()
    }
  }

  private computeFingerprints(
    nodes: DbNode[],
    edges: DbEdge[],
  ): Map<string, FileFingerprint> {
    // 按文件分组节点
    const fileNodes = new Map<string, DbNode[]>()
    for (const node of nodes) {
      const list = fileNodes.get(node.file_path) ?? []
      list.push(node)
      fileNodes.set(node.file_path, list)
    }

    // 按文件分组边（source 节点所在的文件）
    const nodeToFile = new Map<string, string>()
    for (const node of nodes) {
      nodeToFile.set(node.id, node.file_path)
    }

    const fileEdges = new Map<string, DbEdge[]>()
    for (const edge of edges) {
      const file = nodeToFile.get(edge.source)
      if (file) {
        const list = fileEdges.get(file) ?? []
        list.push(edge)
        fileEdges.set(file, list)
      }
    }

    // 计算每个文件的哈希
    const result = new Map<string, FileFingerprint>()
    const mtime = Date.now()

    for (const [file, fNodes] of fileNodes) {
      const fEdges = fileEdges.get(file) ?? []
      const hash = this.hashFile(fNodes, fEdges)

      result.set(file, {
        file,
        hash,
        nodeCount: fNodes.length,
        edgeCount: fEdges.length,
        lastModified: mtime,
      })
    }

    return result
  }

  private hashFile(nodes: DbNode[], edges: DbEdge[]): string {
    const hash = createHash('sha256')

    // 节点: 按 id 排序，输入 {name, kind, signature, start_line, end_line}
    const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id))
    for (const n of sortedNodes) {
      hash.update(
        JSON.stringify({
          name: n.name,
          kind: n.kind,
          signature: n.signature ?? '',
          start_line: n.start_line,
          end_line: n.end_line,
        }),
      )
    }

    // 边: 按 source+target+kind 排序
    const sortedEdges = [...edges].sort((a, b) => {
      const ka = `${a.source}::${a.target}::${a.kind}`
      const kb = `${b.source}::${b.target}::${b.kind}`
      return ka.localeCompare(kb)
    })
    for (const e of sortedEdges) {
      hash.update(`${e.source}->${e.target}:${e.kind}`)
    }

    return hash.digest('hex')
  }
}
