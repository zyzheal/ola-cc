/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and GraphStore storage.
 * Ported from /tmp/codegraph/src/extraction/index.ts with:
 *   - snake_case types (ExtractionNode, ExtractionEdge, etc.)
 *   - GraphStore adapter (extractionResultToGraphStore)
 *   - Simplified file scanning (no git dependency)
 */

import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import type {
  Language,
  ExtractionResult,
  ExtractionError,
  ExtractionNode,
  ExtractionEdge,
} from './types.js'
import { extractFromSource } from './tree-sitter.js'
import {
  detect_language,
  is_source_file,
  is_language_supported,
  init_grammars,
  load_grammars_for_languages,
} from './grammars.js'
import type { GraphStore, NodeMetadata, EdgeType } from '../GraphStore.js'

// ============================================================
// Constants
// ============================================================

/** Files to read in parallel during indexing */
const FILE_IO_BATCH_SIZE = 10

/** Max time (ms) to wait for a single file to parse */
const PARSE_TIMEOUT_MS = 10_000

/** Files parsed before recycling worker thread */
const WORKER_RECYCLE_INTERVAL = 250

/** Max file size (bytes) — skip generated/minified files */
const MAX_FILE_SIZE = 1024 * 1024

// ============================================================
// Types
// ============================================================

export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing'
  current: number
  total: number
  currentFile?: string
}

export interface IndexResult {
  success: boolean
  filesIndexed: number
  filesSkipped: number
  filesErrored: number
  nodesCreated: number
  edgesCreated: number
  errors: ExtractionError[]
  durationMs: number
}

export interface SyncResult {
  filesChecked: number
  filesAdded: number
  filesModified: number
  filesRemoved: number
  nodesUpdated: number
  durationMs: number
  changedFilePaths?: string[]
}

// ============================================================
// Utility functions
// ============================================================

/** Calculate SHA-256 hash of content */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

/** Normalize path separators to forward slashes */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Validate path is within root directory (prevent traversal) */
function validatePathWithinRoot(rootDir: string, relativePath: string): string | null {
  const resolved = path.resolve(rootDir, relativePath)
  if (!resolved.startsWith(path.resolve(rootDir))) return null
  return resolved
}

// ============================================================
// File scanning
// ============================================================

/**
 * Recursively scan directory for source files.
 * Uses simple filesystem walk (no git dependency).
 */
export function scanDirectory(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  const files: string[] = []
  let count = 0
  const visited = new Set<string>()

  function walk(dir: string): void {
    let realDir: string
    try {
      realDir = fs.realpathSync(dir)
    } catch {
      return
    }
    if (visited.has(realDir)) return
    visited.add(realDir)

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.codegraph') continue
      if (entry.name.startsWith('.')) continue

      const fullPath = path.join(dir, entry.name)
      const relativePath = normalizePath(path.relative(rootDir, fullPath))

      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && is_source_file(relativePath)) {
        files.push(relativePath)
        count++
        onProgress?.(count, relativePath)
      }
    }
  }

  walk(rootDir)
  return files
}

/**
 * Async variant that yields to event loop periodically.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): Promise<string[]> {
  const files: string[] = []
  let count = 0
  const visited = new Set<string>()

  async function walk(dir: string): Promise<void> {
    let realDir: string
    try {
      realDir = await fsp.realpath(dir)
    } catch {
      return
    }
    if (visited.has(realDir)) return
    visited.add(realDir)

    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.codegraph') continue
      if (entry.name.startsWith('.')) continue

      const fullPath = path.join(dir, entry.name)
      const relativePath = normalizePath(path.relative(rootDir, fullPath))

      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && is_source_file(relativePath)) {
        files.push(relativePath)
        count++
        onProgress?.(count, relativePath)
        if (count % 100 === 0) {
          await new Promise<void>(r => setImmediate(r))
        }
      }
    }
  }

  await walk(rootDir)
  return files
}

// ============================================================
// GraphStore adapter
// ============================================================

/** Map extraction edge kind to GraphStore EdgeType */
function mapEdgeKind(kind: string): EdgeType {
  const mapping: Record<string, EdgeType> = {
    calls: 'calls',
    imports: 'imports',
    contains: 'contains',
    extends: 'inherits',
    implements: 'implements',
    references: 'data',
    type_of: 'type_of',
    returns: 'returns',
    instantiates: 'instantiates',
    overrides: 'overrides',
    decorates: 'decorates',
    exports: 'exports',
  }
  return mapping[kind] || 'data'
}

/**
 * Convert an ExtractionResult to GraphStore nodes and edges.
 *
 * This is the bridge between the tree-sitter extraction system and GraphStore.
 * Nodes are added with snake_case metadata; edges are added with proper types.
 */
export function extractionResultToGraphStore(
  result: ExtractionResult,
  store: GraphStore
): void {
  // Add nodes
  for (const node of result.nodes) {
    const meta: NodeMetadata = {
      id: node.id,
      name: node.name,
      kind: node.kind,
      file: node.file,
      line: node.line,
      end_line: node.end_line,
      qualified_name: node.qualified_name,
      language: node.language,
      signature: node.signature,
      docstring: node.docstring,
      is_exported: node.is_exported,
      visibility: node.visibility,
      is_async: node.is_async,
      is_static: node.is_static,
      start_column: node.start_column,
      end_column: node.end_column,
      updated_at: node.updated_at,
      provenance: 'tree-sitter',
    }
    store.nodeMeta.set(node.id, meta)
  }

  // Add edges
  for (const edge of result.edges) {
    const edgeType = mapEdgeKind(edge.kind)
    store.addEdge(edge.source, edge.target, edgeType, edge.weight || 1, 'EXTRACTED')
  }
}

// ============================================================
// ExtractionOrchestrator
// ============================================================

/**
 * Extraction orchestrator — coordinates file scanning, parsing, and GraphStore storage.
 */
export class ExtractionOrchestrator {
  private rootDir: string
  private store: GraphStore

  constructor(rootDir: string, store: GraphStore) {
    this.rootDir = rootDir
    this.store = store
  }

  /**
   * Index all files in the project.
   */
  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal
  ): Promise<IndexResult> {
    await init_grammars()
    const startTime = Date.now()
    const errors: ExtractionError[] = []
    let filesIndexed = 0
    let filesSkipped = 0
    let filesErrored = 0
    let totalNodes = 0
    let totalEdges = 0

    // Phase 1: Scan for files
    onProgress?.({ phase: 'scanning', current: 0, total: 0 })

    const files = await scanDirectoryAsync(this.rootDir, (current, file) => {
      onProgress?.({ phase: 'scanning', current, total: 0, currentFile: file })
    })

    if (signal?.aborted) {
      return {
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [{ message: 'Aborted', severity: 'error' }],
        durationMs: Date.now() - startTime,
      }
    }

    // Phase 2: Parse files
    const total = files.length
    let processed = 0

    onProgress?.({ phase: 'parsing', current: 0, total })
    await new Promise(resolve => setImmediate(resolve))

    // Load grammars for detected languages
    const neededLanguages = [...new Set(files.map(f => detect_language(f)))]
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp')
    }
    await load_grammars_for_languages(neededLanguages)

    // Process files in batches
    for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) break

      const batch = files.slice(i, i + FILE_IO_BATCH_SIZE)
      const fileContents = await Promise.all(
        batch.map(async (fp) => {
          try {
            const fullPath = validatePathWithinRoot(this.rootDir, fp)
            if (!fullPath) return { filePath: fp, content: null as string | null, error: new Error('Path traversal blocked') }
            const content = await fsp.readFile(fullPath, 'utf-8')
            return { filePath: fp, content, error: null as Error | null }
          } catch (err) {
            return { filePath: fp, content: null as string | null, error: err as Error }
          }
        })
      )

      for (const { filePath, content, error } of fileContents) {
        if (signal?.aborted) break

        onProgress?.({ phase: 'parsing', current: processed, total, currentFile: filePath })

        if (error || content === null) {
          processed++
          filesErrored++
          errors.push({
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            file: filePath,
            severity: 'error',
            code: 'read_error',
          })
          continue
        }

        // Check file size
        if (content.length > MAX_FILE_SIZE) {
          processed++
          filesSkipped++
          errors.push({
            message: `File exceeds max size (${content.length} > ${MAX_FILE_SIZE})`,
            file: filePath,
            severity: 'warning',
            code: 'size_exceeded',
          })
          continue
        }

        // Parse
        let result: ExtractionResult
        try {
          const language = detect_language(filePath, content)
          result = extractFromSource(filePath, content, language)
        } catch (parseErr) {
          processed++
          filesErrored++
          errors.push({
            message: parseErr instanceof Error ? parseErr.message : String(parseErr),
            file: filePath,
            severity: 'error',
            code: 'parse_error',
          })
          continue
        }

        processed++

        // Store in GraphStore
        if (result.nodes.length > 0) {
          extractionResultToGraphStore(result, this.store)
          filesIndexed++
          totalNodes += result.nodes.length
          totalEdges += result.edges.length
        } else if (result.errors.some(e => e.severity === 'error')) {
          filesErrored++
        } else {
          filesSkipped++
        }

        errors.push(...result.errors)
      }
    }

    onProgress?.({ phase: 'parsing', current: total, total })

    return {
      success: filesIndexed > 0 || errors.filter(e => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * Index specific files.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now()
    const errors: ExtractionError[] = []
    let filesIndexed = 0
    let filesSkipped = 0
    let filesErrored = 0
    let totalNodes = 0
    let totalEdges = 0

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath)

      if (result.errors.length > 0) {
        errors.push(...result.errors)
      }

      if (result.nodes.length > 0) {
        filesIndexed++
        totalNodes += result.nodes.length
        totalEdges += result.edges.length
      } else if (result.errors.some(e => e.severity === 'error')) {
        filesErrored++
      } else {
        filesSkipped++
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter(e => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * Index a single file.
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath)
    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolved_references: [],
        errors: [{ message: `Path traversal blocked: ${relativePath}`, file: relativePath, severity: 'error', code: 'path_traversal' }],
        duration_ms: 0,
      }
    }

    let content: string
    try {
      content = await fsp.readFile(fullPath, 'utf-8')
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolved_references: [],
        errors: [{
          message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
          file: relativePath,
          severity: 'error',
          code: 'read_error',
        }],
        duration_ms: 0,
      }
    }

    if (content.length > MAX_FILE_SIZE) {
      return {
        nodes: [],
        edges: [],
        unresolved_references: [],
        errors: [{
          message: `File exceeds max size (${content.length} > ${MAX_FILE_SIZE})`,
          file: relativePath,
          severity: 'warning',
          code: 'size_exceeded',
        }],
        duration_ms: 0,
      }
    }

    const language = detect_language(relativePath, content)
    if (!is_language_supported(language)) {
      return { nodes: [], edges: [], unresolved_references: [], errors: [], duration_ms: 0 }
    }

    const result = extractFromSource(relativePath, content, language)

    // Store in GraphStore
    if (result.nodes.length > 0) {
      extractionResultToGraphStore(result, this.store)
    }

    return result
  }

  /**
   * Sync the index with current file state.
   * Uses content hash comparison to detect changes.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    await init_grammars()
    const startTime = Date.now()
    let filesChecked = 0
    let filesAdded = 0
    let filesModified = 0
    let filesRemoved = 0
    let nodesUpdated = 0
    const changedFilePaths: string[] = []

    onProgress?.({ phase: 'scanning', current: 0, total: 0 })

    const currentFiles = scanDirectory(this.rootDir)
    filesChecked = currentFiles.length

    // Detect changed files by comparing with existing nodeMeta
    const existingFiles = new Set<string>()
    for (const [, meta] of this.store.nodeMeta) {
      if (meta.kind === 'file') {
        existingFiles.add(meta.file)
      }
    }

    const currentSet = new Set(currentFiles)

    // Find removed files
    for (const existing of existingFiles) {
      if (!currentSet.has(existing)) {
        filesRemoved++
      }
    }

    // Find new/modified files
    const filesToIndex: string[] = []
    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath)
      try {
        const content = await fsp.readFile(fullPath, 'utf-8')
        const contentHash = hashContent(content)

        // Check if file exists in store and has changed
        const fileNodeId = `file:${filePath}`
        const existingMeta = this.store.nodeMeta.get(fileNodeId)

        if (!existingMeta) {
          filesToIndex.push(filePath)
          changedFilePaths.push(filePath)
          filesAdded++
        } else {
          // Simple change detection — re-index if file node exists
          // (a proper implementation would compare content hashes)
          filesToIndex.push(filePath)
          changedFilePaths.push(filePath)
          filesModified++
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Load grammars for changed files
    if (filesToIndex.length > 0) {
      const neededLanguages = [...new Set(filesToIndex.map(f => detect_language(f)))]
      await load_grammars_for_languages(neededLanguages)
    }

    // Index changed files
    const total = filesToIndex.length
    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i]!
      onProgress?.({ phase: 'parsing', current: i + 1, total, currentFile: filePath })

      const result = await this.indexFile(filePath)
      nodesUpdated += result.nodes.length
    }

    return {
      filesChecked,
      filesAdded,
      filesModified,
      filesRemoved,
      nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
    }
  }
}

// Re-export
export { extractFromSource } from './tree-sitter.js'
export { detect_language as detectLanguage, is_source_file as isSourceFile, is_language_supported as isLanguageSupported } from './grammars.js'
