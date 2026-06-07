/**
 * CodegraphManager — 100% 内置 CodeGraph 管理层
 *
 * 纯 TypeScript 实现，零 CLI 依赖。
 * 使用 ExtractionOrchestrator + GraphStore + GraphEngine + FtsSearch + CodegraphWriter。
 *
 * 替代原 CLI 调用链：
 *   init → ExtractionOrchestrator.indexAll() + CodegraphWriter.persist()
 *   sync → ExtractionOrchestrator.sync() + CodegraphWriter.updateFiles()
 *   search → FtsSearch + RrfSearch
 *   callers/callees → GraphStore.getInEdges()/getOutEdges()
 *   impact → GraphEngine.bfs() + backwardReachability()
 *   status → CodegraphWriter.getStats()
 *   files → GraphStore.fileRecords
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { GraphStore as GraphStoreType } from '../../services/graph/GraphStore.js'
import type { GraphEngine as GraphEngineType } from '../../services/graph/GraphEngine.js'
import type { FtsSearch as FtsSearchType } from '../../services/graph/FtsSearch.js'
import type { RrfSearch as RrfSearchType } from '../../services/graph/RrfSearch.js'
import type { CodegraphWriter as CodegraphWriterType } from '../../services/graph/CodegraphWriter.js'
import type { ExtractionOrchestrator as ExtractionOrchestratorType } from '../../services/graph/extraction/index.js'

// ============================================================
// Types
// ============================================================

export interface CodegraphResult {
  ok: boolean
  stdout: string
  stderr: string
}

// ============================================================
// Lazy-loaded singletons
// ============================================================

let _store: GraphStoreType | null = null
let _engine: GraphEngineType | null = null
let _fts: FtsSearchType | null = null
let _rrf: RrfSearchType | null = null
let _writer: CodegraphWriterType | null = null
let _orchestrator: ExtractionOrchestratorType | null = null
let _lastProjectRoot: string | null = null
const _initPromises = new Map<string, Promise<void>>()

function _clearCachedInstances(): void {
  _store = null
  _engine = null
  _fts = null
  _writer = null
  _orchestrator = null
  _lastProjectRoot = null
}

async function getStore(projectRoot: string): Promise<GraphStoreType> {
  // Clear cached instances if projectRoot changed
  if (_lastProjectRoot && _lastProjectRoot !== projectRoot) {
    _clearCachedInstances()
  }
  _lastProjectRoot = projectRoot
  if (!_store) {
    const { GraphStore } = await import('../../services/graph/GraphStore.js')
    _store = GraphStore.getInstance(projectRoot)
  }
  return _store
}

async function getEngine(store: GraphStoreType, projectRoot: string): Promise<GraphEngineType> {
  // Clear cached instances if projectRoot changed
  if (_lastProjectRoot && _lastProjectRoot !== projectRoot) {
    _clearCachedInstances()
  }
  _lastProjectRoot = projectRoot
  if (!_engine) {
    const { GraphEngine } = await import('../../services/graph/GraphEngine.js')
    _engine = new GraphEngine(store)
  }
  return _engine
}

async function getWriter(projectRoot: string): Promise<CodegraphWriterType> {
  if (!_writer) {
    const { CodegraphWriter } = await import('../../services/graph/CodegraphWriter.js')
    _writer = new CodegraphWriter(projectRoot)
  }
  return _writer
}

async function getOrchestrator(projectRoot: string, store: GraphStoreType): Promise<ExtractionOrchestratorType> {
  if (!_orchestrator) {
    const { ExtractionOrchestrator } = await import('../../services/graph/extraction/index.js')
    _orchestrator = new ExtractionOrchestrator(projectRoot, store)
  }
  return _orchestrator
}

async function getFts(projectRoot: string, store: GraphStoreType): Promise<FtsSearchType> {
  if (!_fts) {
    const { FtsSearch } = await import('../../services/graph/FtsSearch.js')
    // FtsSearch uses its own database (separate from codegraph.db)
    // to avoid bun:sqlite FTS5 content table modification issues
    const dbPath = join(projectRoot, '.codegraph', 'fts-search.db')
    _fts = new FtsSearch(dbPath)
    _fts.createIndex()
    _fts.indexNodes(store)
  }
  return _fts
}

async function getRrf(store: GraphStoreType, fts: FtsSearchType): Promise<RrfSearchType> {
  if (!_rrf) {
    const { RrfSearch } = await import('../../services/graph/RrfSearch.js')
    _rrf = new RrfSearch(fts, store)
  }
  return _rrf
}

// ============================================================
// 日志工具
// ============================================================

function logInfo(message: string): void {
  console.log(`[codegraph] ${message}`)
}

function logWarn(message: string, error?: unknown): void {
  const suffix = error instanceof Error ? `: ${error.message}` : ''
  console.warn(`[codegraph] WARNING: ${message}${suffix}`)
}

// ============================================================
// 公开 API
// ============================================================

export function isCodegraphInitialized(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.codegraph', 'codegraph.db'))
}

/** Freshness threshold: 30 minutes */
export const FRESH_THRESHOLD_MS = 30 * 60 * 1000

/** Track last sync time per project */
const lastSyncTimes = new Map<string, number>()

/**
 * Get milliseconds since last sync for a project.
 * Returns null if never synced.
 */
export function getLastSyncAge(projectRoot: string): number | null {
  const lastSync = lastSyncTimes.get(projectRoot)
  if (lastSync == null) {
    // Try to read from .codegraph/db.mtime file
    const mtimeFile = join(projectRoot, '.codegraph', 'db.mtime')
    if (existsSync(mtimeFile)) {
      try {
        const mtime = parseInt(readFileSync(mtimeFile, 'utf-8').trim(), 10)
        if (!isNaN(mtime)) {
          lastSyncTimes.set(projectRoot, mtime)
          return Date.now() - mtime
        }
      } catch { /* ignore */ }
    }
    return null
  }
  return Date.now() - lastSync
}

/**
 * Ensure codegraph database is ready.
 * If not initialized, runs full extraction + persist.
 */
export async function ensureReady(projectRoot: string): Promise<{ initialized: boolean }> {
  if (!isCodegraphInitialized(projectRoot)) {
    // Per-project flight lock: prevent concurrent init for same project
    const existing = _initPromises.get(projectRoot)
    if (existing) {
      await existing
      return { initialized: true }
    }

    const initPromise = (async () => {
      const store = await getStore(projectRoot)
      const orchestrator = await getOrchestrator(projectRoot, store)
      const writer = await getWriter(projectRoot)

      writer.createDatabase()
      const result = await orchestrator.indexAll()

      if (result.filesIndexed > 0) {
        await store.load()
        writer.persist(store)
        lastSyncTimes.set(projectRoot, Date.now())
        logInfo(`Init complete: ${result.filesIndexed} files, ${result.nodesCreated} nodes, ${result.edgesCreated} edges in ${result.durationMs}ms`)
      } else {
        throw new Error(`CodeGraph 初始化失败: ${result.errors.map(e => e.message).join('; ')}`)
      }
    })().finally(() => { _initPromises.delete(projectRoot) })

    _initPromises.set(projectRoot, initPromise)
    await initPromise
  }

  return { initialized: true }
}

/**
 * Initialize project: extract all files and persist to codegraph.db.
 */
export async function initProject(projectRoot: string): Promise<CodegraphResult> {
  try {
    const store = await getStore(projectRoot)
    const orchestrator = await getOrchestrator(projectRoot, store)
    const writer = await getWriter(projectRoot)

    writer.createDatabase()
    const result = await orchestrator.indexAll()

    if (result.filesIndexed > 0) {
      await store.load()
      writer.persist(store)
      lastSyncTimes.set(projectRoot, Date.now())
      logInfo(`Init complete: ${result.filesIndexed} files, ${result.nodesCreated} nodes, ${result.edgesCreated} edges in ${result.durationMs}ms`)
      return {
        ok: true,
        stdout: JSON.stringify({
          filesIndexed: result.filesIndexed,
          nodesCreated: result.nodesCreated,
          edgesCreated: result.edgesCreated,
          durationMs: result.durationMs,
        }),
        stderr: result.errors.length > 0 ? result.errors.map(e => e.message).join('\n') : '',
      }
    }

    return {
      ok: false,
      stdout: '',
      stderr: `Init failed: no files indexed. ${result.errors.map(e => e.message).join('; ')}`,
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: `Init error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Get context for a query: search + BFS neighborhood.
 */
export async function getContext(projectRoot: string, query: string, options?: { maxNodes?: number; format?: string }): Promise<CodegraphResult> {
  try {
    await ensureReady(projectRoot)
    const store = await getStore(projectRoot)
    await store.load()
    const fts = await getFts(projectRoot, store)
    const rrf = await getRrf(store, fts)
    const engine = await getEngine(store, projectRoot)

    const maxNodes = options?.maxNodes ?? 20

    // Search for relevant nodes
    const searchResults = rrf.search(query, Math.min(maxNodes, 10))

    // BFS from top results to get neighborhood
    const contextNodes: Array<{ id: string; name: string; kind: string; file: string; line: number; depth: number }> = []
    const visited = new Set<string>()

    for (const result of searchResults) {
      if (contextNodes.length >= maxNodes) break
      if (visited.has(result.id)) continue

      const traversal = engine.bfs(result.id, 2)
      for (const nodeId of traversal.nodes) {
        if (contextNodes.length >= maxNodes) break
        if (visited.has(nodeId)) continue
        visited.add(nodeId)

        const meta = store.getNode(nodeId)
        if (meta) {
          contextNodes.push({
            id: nodeId,
            name: meta.name,
            kind: meta.kind,
            file: meta.file,
            line: meta.line,
            depth: traversal.depth.get(nodeId) ?? 0,
          })
        }
      }
    }

    return {
      ok: true,
      stdout: JSON.stringify({ nodes: contextNodes, query }),
      stderr: '',
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: `Context error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Search nodes by query string.
 */
export async function searchNodes(projectRoot: string, query: string, options?: { limit?: number; kind?: string }): Promise<CodegraphResult> {
  try {
    await ensureReady(projectRoot)
    const store = await getStore(projectRoot)
    await store.load()
    const fts = await getFts(projectRoot, store)

    const limit = options?.limit ?? 20
    let results

    if (options?.kind) {
      results = fts.searchByKind(query, options.kind, limit)
    } else {
      const rrf = await getRrf(store, fts)
      results = rrf.search(query, limit)
    }

    return {
      ok: true,
      stdout: JSON.stringify(results),
      stderr: '',
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: `Search error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Get callers of a symbol (nodes that call this symbol).
 */
export async function getCallers(projectRoot: string, symbol: string, options?: { limit?: number }): Promise<CodegraphResult> {
  try {
    await ensureReady(projectRoot)
    const store = await getStore(projectRoot)
    await store.load()

    const nodeId = store.findByName(symbol)
    if (!nodeId) {
      return {
        ok: false,
        stdout: '',
        stderr: `Symbol not found: ${symbol}`,
      }
    }

    const limit = options?.limit ?? 50
    const inEdges = store.getInEdges(nodeId)
    const callers: Array<{ id: string; name: string; kind: string; file: string; line: number; edgeType: string }> = []

    for (const [sourceId, edges] of inEdges) {
      if (callers.length >= limit) break
      const meta = store.getNode(sourceId)
      if (meta) {
        callers.push({
          id: sourceId,
          name: meta.name,
          kind: meta.kind,
          file: meta.file,
          line: meta.line,
          edgeType: edges[0]?.type ?? 'unknown',
        })
      }
    }

    return {
      ok: true,
      stdout: JSON.stringify({ symbol, callers }),
      stderr: '',
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: `Callers error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Get callees of a symbol (nodes that this symbol calls).
 */
export async function getCallees(projectRoot: string, symbol: string, options?: { limit?: number }): Promise<CodegraphResult> {
  try {
    await ensureReady(projectRoot)
    const store = await getStore(projectRoot)
    await store.load()

    const nodeId = store.findByName(symbol)
    if (!nodeId) {
      return {
        ok: false,
        stdout: '',
        stderr: `Symbol not found: ${symbol}`,
      }
    }

    const limit = options?.limit ?? 50
    const outEdges = store.getOutEdges(nodeId)
    const callees: Array<{ id: string; name: string; kind: string; file: string; line: number; edgeType: string }> = []

    for (const [targetId, edges] of outEdges) {
      if (callees.length >= limit) break
      const meta = store.getNode(targetId)
      if (meta) {
        callees.push({
          id: targetId,
          name: meta.name,
          kind: meta.kind,
          file: meta.file,
          line: meta.line,
          edgeType: edges[0]?.type ?? 'unknown',
        })
      }
    }

    return {
      ok: true,
      stdout: JSON.stringify({ symbol, callees }),
      stderr: '',
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: `Callees error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Get impact analysis: forward (BFS) + backward reachability.
 */
export async function getImpact(projectRoot: string, symbol: string, depth?: number): Promise<CodegraphResult> {
  try {
    await ensureReady(projectRoot)
    const store = await getStore(projectRoot)
    await store.load()
    const engine = await getEngine(store, projectRoot)

    const nodeId = store.findByName(symbol)
    if (!nodeId) {
      return {
        ok: false,
        stdout: '',
        stderr: `Symbol not found: ${symbol}`,
      }
    }

    const maxDepth = depth ?? 3

    // Forward impact (BFS)
    const forward = engine.bfs(nodeId, maxDepth)

    // Backward reachability (who depends on this)
    const backward = engine.backwardReachability(nodeId)

    // Build impact nodes with metadata
    const forwardNodes = forward.nodes.map(id => {
      const meta = store.getNode(id)
      return {
        id,
        name: meta?.name ?? id,
        kind: meta?.kind ?? 'unknown',
        file: meta?.file ?? '',
        line: meta?.line ?? 0,
        depth: forward.depth.get(id) ?? 0,
      }
    })

    const backwardNodes = backward.reachable.map(id => {
      const meta = store.getNode(id)
      return {
        id,
        name: meta?.name ?? id,
        kind: meta?.kind ?? 'unknown',
        file: meta?.file ?? '',
        line: meta?.line ?? 0,
      }
    })

    return {
      ok: true,
      stdout: JSON.stringify({
        symbol,
        forward: { nodeCount: forwardNodes.length, nodes: forwardNodes },
        backward: { nodeCount: backwardNodes.length, nodes: backwardNodes },
      }),
      stderr: '',
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: `Impact error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Get codegraph database status.
 */
export async function getStatus(projectRoot: string): Promise<CodegraphResult> {
  try {
    if (!isCodegraphInitialized(projectRoot)) {
      return { ok: true, stdout: JSON.stringify({ initialized: false }), stderr: '' }
    }

    const writer = await getWriter(projectRoot)
    const stats = writer.getStats()

    return {
      ok: true,
      stdout: JSON.stringify({
        initialized: true,
        ...stats,
      }),
      stderr: '',
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: `Status error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Get file list from codegraph.
 */
export async function getFiles(projectRoot: string, options?: { maxDepth?: number; format?: string }): Promise<CodegraphResult> {
  try {
    await ensureReady(projectRoot)
    const store = await getStore(projectRoot)
    await store.load()

    const files: Array<{ path: string; language: string; nodeCount: number; lineCount: number }> = []

    for (const [filePath, record] of store.fileRecords) {
      files.push({
        path: filePath,
        language: record.language,
        nodeCount: record.nodeCount,
        lineCount: record.lineCount,
      })
    }

    return {
      ok: true,
      stdout: JSON.stringify({ files, count: files.length }),
      stderr: '',
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: `Files error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Sync: detect changed files and update codegraph.db incrementally.
 */
export async function sync(projectRoot: string): Promise<CodegraphResult> {
  try {
    const store = await getStore(projectRoot)
    const orchestrator = await getOrchestrator(projectRoot, store)
    const writer = await getWriter(projectRoot)

    const result = await orchestrator.sync()

    if (result.changedFilePaths && result.changedFilePaths.length > 0) {
      await store.load()
      writer.updateFiles(store, result.changedFilePaths)
      lastSyncTimes.set(projectRoot, Date.now())
      logInfo(`Sync complete: ${result.filesChecked} checked, ${result.filesAdded} added, ${result.filesModified} modified, ${result.filesRemoved} removed`)
    } else {
      lastSyncTimes.set(projectRoot, Date.now())
      logInfo(`Sync complete: ${result.filesChecked} checked, no changes`)
    }

    return {
      ok: true,
      stdout: JSON.stringify(result),
      stderr: '',
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: `Sync error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Reset cached singletons (for testing).
 */
export function resetCache(): void {
  _store = null
  _engine = null
  _fts = null
  _rrf = null
  _writer = null
  _orchestrator = null
  _initPromises.clear()
}
