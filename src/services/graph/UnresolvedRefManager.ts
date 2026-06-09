/**
 * UnresolvedRefManager — Track and resolve dangling references
 *
 * Manages references in the codebase that point to symbols not yet
 * in the graph (imports, calls, type uses). Attempts to resolve them
 * as the graph grows.
 *
 * F-62: UnresolvedReference Interface
 */

import type { Database } from 'bun:sqlite'
import type { GraphStore } from './GraphStore.js'

// ============================================================
// Types
// ============================================================

export interface UnresolvedReference {
  fromNode: string
  fromFile: string
  toName: string
  toFile?: string
  kind: string  // 'import' | 'call' | 'type_use'
  line: number
  resolved: boolean
  resolvedTo?: string
}

// ============================================================
// UnresolvedRefManager
// ============================================================

export class UnresolvedRefManager {
  private refs: UnresolvedReference[] = []

  constructor(private store: GraphStore) {}

  /**
   * Load unresolved references from codegraph.db.
   *
   * Reads from the `unresolved_references` table if it exists,
   * otherwise scans edges for dangling targets.
   */
  loadFromDb(db: Database): void {
    // Try to read from unresolved_references table
    try {
      const rows = db.query(
        'SELECT source_id, source_file, target_name, target_file, kind, line FROM unresolved_references'
      ).all() as Array<{
        source_id: string; source_file: string; target_name: string;
        target_file: string | null; kind: string; line: number
      }>

      for (const row of rows) {
        const ref: UnresolvedReference = {
          fromNode: row.source_id,
          fromFile: row.source_file,
          toName: row.target_name,
          toFile: row.target_file ?? undefined,
          kind: row.kind,
          line: row.line,
          resolved: false,
        }

        // Check if already resolvable
        const resolved = this.tryResolveOne(ref)
        if (resolved) {
          ref.resolved = true
          ref.resolvedTo = resolved
        }

        this.refs.push(ref)
      }
    } catch {
      // Table may not exist; that's fine — we'll scan edges instead
      this.loadFromEdges()
    }
  }

  /**
   * Scan graph edges for unresolved targets (nodes referenced but not in nodeMeta).
   */
  loadFromEdges(): void {
    for (const [fromId, outMap] of this.store.adjacency) {
      const fromMeta = this.store.getNode(fromId)
      if (!fromMeta) continue

      for (const [toId] of outMap) {
        // Check if target node exists in graph
        const toMeta = this.store.getNode(toId)
        if (!toMeta) {
          // This is a dangling edge — the target is unresolved
          this.refs.push({
            fromNode: fromId,
            fromFile: fromMeta.file,
            toName: toId.includes(':') ? toId.split(':').pop()! : toId,
            kind: 'import',
            line: fromMeta.line,
            resolved: false,
          })
        }
      }
    }
  }

  /**
   * Attempt to resolve all unresolved references using current graph state.
   * @returns count of newly resolved references
   */
  resolve(): number {
    let newlyResolved = 0

    for (const ref of this.refs) {
      if (ref.resolved) continue

      const resolved = this.tryResolveOne(ref)
      if (resolved) {
        ref.resolved = true
        ref.resolvedTo = resolved
        newlyResolved++
      }
    }

    return newlyResolved
  }

  /**
   * Get all unresolved (not yet resolved) references.
   */
  getUnresolved(): UnresolvedReference[] {
    return this.refs.filter(r => !r.resolved)
  }

  /**
   * Get all references (both resolved and unresolved).
   */
  getAll(): UnresolvedReference[] {
    return [...this.refs]
  }

  /**
   * Get unresolved references for a specific file.
   */
  getUnresolvedByFile(filePath: string): UnresolvedReference[] {
    return this.refs.filter(r => !r.resolved && r.fromFile === filePath)
  }

  /**
   * Add a reference manually (for testing or runtime tracking).
   */
  addRef(ref: UnresolvedReference): void {
    this.refs.push(ref)
  }

  /**
   * Total reference count.
   */
  get size(): number {
    return this.refs.length
  }

  /**
   * Try to resolve a single reference by searching nodeMeta.
   * @returns resolved node ID or null
   */
  private tryResolveOne(ref: UnresolvedReference): string | null {
    const toName = ref.toName

    // Strategy 1: Exact ID match
    if (this.store.getNode(toName)) return toName

    // Strategy 2: Search by qualified_name
    for (const [id, meta] of this.store.nodeMeta) {
      if (meta.qualified_name === toName) return id
    }

    // Strategy 3: Search by name (if toFile provided, restrict to that file)
    for (const [id, meta] of this.store.nodeMeta) {
      if (meta.name === toName) {
        if (!ref.toFile || meta.file === ref.toFile) {
          return id
        }
      }
    }

    // Strategy 4: file:name key match
    if (ref.toFile) {
      const fileKey = `${ref.toFile}:${toName}`
      if (this.store.getNode(fileKey)) return fileKey
    }

    return null
  }
}
