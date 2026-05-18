import { createHash } from 'crypto'
import { LRUCache } from 'lru-cache'

/**
 * Cached result from a tool invocation.
 */
export type CachedToolResult = {
  /** Stringified tool output */
  output: string
  /** Timestamp when result was cached */
  cachedAt: number
  /** File paths this result depends on (for invalidation) */
  dependsOn: string[]
  /** Whether this entry is same-turn dedup only (not disk-backed) */
  ephemeral: boolean
}

/**
 * LRU cache for read-only tool results.
 *
 * Benefits:
 * - Same-turn dedup: identical tool calls in one turn hit cache
 * - Cross-turn cache: Read/Glob/Grep results cached until file changes
 *
 * Invalidation:
 * - File mutations clear file-dependent entries
 * - Ephemeral entries cleared per turn
 */
export class ToolResultCache {
  private cache: LRUCache<string, CachedToolResult>

  constructor(opts?: { maxEntries?: number; maxAgeMs?: number }) {
    const maxEntries = opts?.maxEntries ?? 500
    const maxAgeMs = opts?.maxAgeMs ?? 30 * 60 * 1000 // 30min default

    this.cache = new LRUCache<string, CachedToolResult>({
      max: maxEntries,
      ttl: maxAgeMs,
      sizeCalculation: value => Math.max(1, Buffer.byteLength(value.output)),
      maxSize: 50 * 1024 * 1024, // 50MB
    })
  }

  /**
   * Build a cache key from tool name + input params.
   */
  static makeKey(toolName: string, input: Record<string, unknown>): string {
    const payload = `${toolName}:${JSON.stringify(input)}`
    return createHash('sha256').update(payload).digest('hex').slice(0, 16)
  }

  /**
   * Look up a cached result. Returns undefined on miss or stale entry.
   */
  get(key: string): CachedToolResult | undefined {
    return this.cache.get(key)
  }

  /**
   * Store a tool result in the cache.
   */
  set(key: string, result: Omit<CachedToolResult, 'cachedAt'>): void {
    this.cache.set(key, { ...result, cachedAt: Date.now() })
  }

  /**
   * Invalidate all entries that depend on any of the given file paths.
   * Call this after any file mutation (Edit, Write, Bash write ops).
   */
  invalidateFiles(paths: string[]): void {
    if (paths.length === 0) return
    const normalized = new Set(paths.map(p => normalizePath(p)))
    for (const [key, entry] of this.cache.entries()) {
      if (entry.dependsOn.some(dep => normalized.has(normalizePath(dep)))) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Clear all ephemeral (same-turn) entries. Call at end of each turn.
   */
  clearEphemeral(): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.ephemeral) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Full cache clear (for testing).
   */
  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize
  }

  /**
   * Get stats for diagnostics.
   */
  stats() {
    return {
      size: this.cache.size,
      calculatedSize: this.cache.calculatedSize,
      max: this.cache.max,
      maxSize: this.cache.maxSize,
    }
  }
}

// Session-scoped singleton
let _toolResultCache: ToolResultCache | null = null

export function getToolResultCache(): ToolResultCache {
  if (!_toolResultCache) {
    _toolResultCache = new ToolResultCache()
  }
  return _toolResultCache
}

export function resetToolResultCache(): void {
  _toolResultCache = null
}

/**
 * Normalize a file path for consistent cache key comparison.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}
