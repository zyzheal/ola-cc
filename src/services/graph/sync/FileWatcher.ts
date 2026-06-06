/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers debounced sync
 * operations to keep the code graph up-to-date.
 *
 * Uses Node's built-in `fs.watch` directly with a per-platform strategy:
 *   - macOS / Windows: a SINGLE recursive `fs.watch(root, {recursive:true})` — O(1) descriptors
 *   - Linux: per-directory inotify watches with a cap — O(directories)
 *
 * Excluded trees (node_modules/, dist/, .git/, ...) are filtered via a
 * built-in ignore matcher and source-file extension check.
 */

import { watch, readdirSync, statSync, type FSWatcher } from 'fs'
import { join, relative, resolve } from 'path'
import { logForDebugging } from '../../../utils/debug.js'
import { watchDisabledReason } from './watchPolicy.js'

// ============================================================
// Helpers
// ============================================================

/** Source file extensions we care about. */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.php', '.swift', '.dart', '.lua', '.zig',
])

/** Check if a file path looks like a source file by extension. */
export function isSourceFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return false
  return SOURCE_EXTENSIONS.has(filePath.slice(dot).toLowerCase())
}

/** Default directories/patterns to always ignore. */
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  'dist',
  'build',
  '.git',
  '.codegraph',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  'vendor',
]

/** Simple ignore matcher — checks if a relative path matches ignored patterns. */
export class SimpleIgnoreMatcher {
  private readonly patterns: string[]

  constructor(patterns: string[] = DEFAULT_IGNORE_PATTERNS) {
    this.patterns = patterns
  }

  /** Returns true if `relPath` should be ignored. */
  ignores(relPath: string): boolean {
    // Normalize to forward slashes
    const normalized = relPath.replace(/\\/g, '/')
    const segments = normalized.split('/')
    for (const seg of segments) {
      if (this.patterns.includes(seg)) return true
    }
    return false
  }
}

function supportsRecursiveWatch(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

const DEFAULT_MAX_DIR_WATCHES = 50_000

function maxDirWatches(): number {
  const raw = process.env.OLA_CC_MAX_DIR_WATCHES
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw)
    if (n > 0) return n
  }
  return DEFAULT_MAX_DIR_WATCHES
}

// ============================================================
// Types
// ============================================================

export interface WatchOptions {
  /** Debounce delay in milliseconds. Default: 2000ms */
  debounceMs?: number
  /** Callback when a sync completes. */
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void
  /** Callback when a sync errors. */
  onSyncError?: (error: Error) => void
  /** Test-only: install no OS-level fs.watch. */
  inertForTests?: boolean
}

export class LockUnavailableError extends Error {
  constructor(message = 'Graph file lock unavailable; another process is writing') {
    super(message)
    this.name = 'LockUnavailableError'
  }
}

export interface PendingFile {
  path: string
  firstSeenMs: number
  lastSeenMs: number
  indexing: boolean
}

// ============================================================
// FileWatcher
// ============================================================

export class FileWatcher {
  private recursiveWatcher: FSWatcher | null = null
  private dirWatchers = new Map<string, FSWatcher>()
  private dirCapWarned = false
  private inert = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingFiles = new Map<string, { firstSeenMs: number; lastSeenMs: number }>()
  private syncStartedMs = 0
  private syncing = false
  private stopped = false
  private ready = false
  private readyWaiters: Array<() => void> = []
  private ignoreMatcher: SimpleIgnoreMatcher | null = null

  private readonly projectRoot: string
  private readonly debounceMs: number
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>
  private readonly onSyncComplete?: WatchOptions['onSyncComplete']
  private readonly onSyncError?: WatchOptions['onSyncError']
  private readonly inertForTests: boolean

  constructor(
    projectRoot: string,
    syncFn: () => Promise<{ filesChanged: number; durationMs: number }>,
    options: WatchOptions = {},
  ) {
    this.projectRoot = projectRoot
    this.syncFn = syncFn
    this.debounceMs = options.debounceMs ?? 2000
    this.onSyncComplete = options.onSyncComplete
    this.onSyncError = options.onSyncError
    this.inertForTests = options.inertForTests ?? false
  }

  /** Start watching for file changes. Returns true if watching started. */
  start(): boolean {
    if (this.recursiveWatcher || this.dirWatchers.size > 0 || this.inert) return true
    this.stopped = false

    const disabledReason = watchDisabledReason(this.projectRoot)
    if (disabledReason) {
      logForDebugging(`File watcher disabled: ${disabledReason}`)
      return false
    }

    this.ignoreMatcher = new SimpleIgnoreMatcher()

    try {
      if (this.inertForTests) {
        this.inert = true
      } else if (supportsRecursiveWatch()) {
        this.startRecursive()
      } else {
        this.startPerDirectory()
      }

      this.pendingFiles.clear()
      this.ready = true
      for (const cb of this.readyWaiters) cb()
      this.readyWaiters.length = 0

      logForDebugging(
        `File watcher started: root=${this.projectRoot} debounce=${this.debounceMs}ms ` +
        `mode=${this.inertForTests ? 'inert' : supportsRecursiveWatch() ? 'recursive' : 'per-directory'}`,
      )
      return true
    } catch (err) {
      logForDebugging(`Could not start file watcher: ${String(err)}`)
      this.stop()
      return false
    }
  }

  /** macOS/Windows: one recursive watcher for the whole tree. */
  private startRecursive(): void {
    this.recursiveWatcher = watch(
      this.projectRoot,
      { recursive: true, persistent: true },
      (_event, filename) => {
        if (this.stopped || filename == null) return
        this.handleChange(normalizePath(String(filename)))
      },
    )
    this.recursiveWatcher.on('error', (err: unknown) => {
      logForDebugging(`File watcher error: ${String(err)}`)
    })
  }

  /** Linux: walk the (non-ignored) tree and watch each directory. */
  private startPerDirectory(): void {
    this.watchTree(this.projectRoot, false)
  }

  private watchTree(dir: string, markExisting: boolean): void {
    if (this.dirWatchers.has(dir)) return
    if (this.dirWatchers.size >= maxDirWatches()) {
      if (!this.dirCapWarned) {
        this.dirCapWarned = true
        logForDebugging(`File watcher hit directory-watch cap (${maxDirWatches()})`)
      }
      return
    }

    let w: FSWatcher
    try {
      w = watch(dir, { persistent: true }, (_event, filename) =>
        this.handleDirEvent(dir, filename),
      )
    } catch {
      return
    }
    w.on('error', () => this.unwatchDir(dir))
    this.dirWatchers.set(dir, w)

    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (this.shouldIgnoreDir(child)) continue
        this.watchTree(child, markExisting)
      } else if (markExisting && entry.isFile()) {
        this.handleChange(normalizePath(relative(this.projectRoot, child)))
      }
    }
  }

  private handleDirEvent(dir: string, filename: string | Buffer | null): void {
    if (this.stopped || filename == null) return
    const full = join(dir, String(filename))

    try {
      if (statSync(full).isDirectory()) {
        if (!this.shouldIgnoreDir(full)) this.watchTree(full, true)
        return
      }
    } catch {
      // deleted/inaccessible
    }

    this.handleChange(normalizePath(relative(this.projectRoot, full)))
  }

  private handleChange(rel: string): void {
    if (!rel || rel === '.' || rel.startsWith('..')) return
    if (this.isAlwaysIgnored(rel)) return
    if (this.ignoreMatcher && this.ignoreMatcher.ignores(rel)) return
    if (!isSourceFile(rel)) return

    logForDebugging(`File change detected: ${rel}`)
    if (this.ready) {
      const now = Date.now()
      const existing = this.pendingFiles.get(rel)
      this.pendingFiles.set(rel, {
        firstSeenMs: existing?.firstSeenMs ?? now,
        lastSeenMs: now,
      })
    }
    this.scheduleSync()
  }

  private unwatchDir(dir: string): void {
    const w = this.dirWatchers.get(dir)
    if (w) {
      try { w.close() } catch { /* already closed */ }
      this.dirWatchers.delete(dir)
    }
  }

  private isAlwaysIgnored(rel: string): boolean {
    return (
      rel === '.codegraph' || rel.startsWith('.codegraph/') ||
      rel === '.git' || rel.startsWith('.git/')
    )
  }

  private shouldIgnoreDir(dirPath: string): boolean {
    const rel = normalizePath(relative(this.projectRoot, dirPath))
    if (!rel || rel === '.' || rel.startsWith('..')) return false
    if (this.isAlwaysIgnored(rel)) return true
    if (!this.ignoreMatcher) return false
    return this.ignoreMatcher.ignores(rel + '/')
  }

  /** Stop watching for file changes. */
  stop(): void {
    this.stopped = true

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.recursiveWatcher) {
      try { this.recursiveWatcher.close() } catch { /* already closed */ }
      this.recursiveWatcher = null
    }
    for (const w of this.dirWatchers.values()) {
      try { w.close() } catch { /* already closed */ }
    }
    this.dirWatchers.clear()
    this.dirCapWarned = false
    this.inert = false

    this.pendingFiles.clear()
    this.ready = false
    this.ignoreMatcher = null
    logForDebugging('File watcher stopped')
  }

  /** Test-only: feed a synthetic change through the pipeline. */
  ingestEventForTests(relPath: string): void {
    this.handleChange(normalizePath(relPath))
  }

  /** Whether the watcher is currently active. */
  isActive(): boolean {
    return (this.recursiveWatcher !== null || this.dirWatchers.size > 0 || this.inert) && !this.stopped
  }

  /** Resolves once the watch set has been installed. */
  waitUntilReady(timeoutMs = 10000): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.readyWaiters.indexOf(handler)
        if (idx >= 0) this.readyWaiters.splice(idx, 1)
        reject(new Error(`FileWatcher.waitUntilReady timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const handler = () => { clearTimeout(t); resolve() }
      this.readyWaiters.push(handler)
    })
  }

  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.flush()
    }, this.debounceMs)
  }

  private async flush(): Promise<void> {
    if (this.syncing || this.stopped) return

    this.syncStartedMs = Date.now()
    this.syncing = true

    try {
      const result = await this.syncFn()
      for (const [filePath, info] of this.pendingFiles) {
        if (info.lastSeenMs <= this.syncStartedMs) {
          this.pendingFiles.delete(filePath)
        }
      }
      this.onSyncComplete?.(result)
    } catch (err) {
      if (err instanceof LockUnavailableError) {
        logForDebugging(`Watch sync skipped: file lock unavailable (pending=${this.pendingFiles.size})`)
      } else {
        const error = err instanceof Error ? err : new Error(String(err))
        logForDebugging(`Watch sync failed: ${error.message}`)
        this.onSyncError?.(error)
      }
    } finally {
      this.syncing = false
      if (this.pendingFiles.size > 0 && !this.stopped) {
        this.scheduleSync()
      }
    }
  }

  /** Snapshot of files seen since the last successful sync. */
  getPendingFiles(): PendingFile[] {
    const result: PendingFile[] = []
    for (const [filePath, info] of this.pendingFiles) {
      result.push({
        path: filePath,
        firstSeenMs: info.firstSeenMs,
        lastSeenMs: info.lastSeenMs,
        indexing: this.syncing && this.syncStartedMs >= info.lastSeenMs,
      })
    }
    return result
  }
}

/** Normalize path to forward slashes. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}
