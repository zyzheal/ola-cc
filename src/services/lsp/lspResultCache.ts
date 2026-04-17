import { jsonStringify } from '../../utils/slowOperations.js'

/**
 * Cache key for LSP results.
 * Combines file path, LSP method, and position to uniquely identify a query.
 * Format: filePath::method::line:char (positioned) or filePath::method (global)
 */
type CacheKey = string

/**
 * Cached LSP result with metadata for eviction.
 */
type CacheEntry = {
  result: string // JSON-serialized to prevent mutation of cached objects
  timestamp: number
}

/**
 * LSP result cache with TTL-based expiration, LRU eviction, and in-flight dedup.
 *
 * Caches LSP query results (goToDefinition, hover, references, etc.) to avoid
 * redundant round-trips to LSP subprocesses. This is especially valuable when:
 * - The model repeatedly queries the same position within a single turn
 * - Multiple parallel agents query the same file/position concurrently
 *
 * Design decisions:
 * - Results are JSON-serialized on store to prevent mutation of cached objects
 *   by downstream code (formatResult, etc.). Each get() returns a fresh copy.
 * - In-flight request deduplication: when multiple agents concurrently query
 *   the same cache key, only ONE LSP request is issued. Others await the same
 *   Promise. This eliminates duplicate RPC calls under parallel agent execution.
 * - TTL of 5 minutes: short enough to avoid stale data across edit cycles,
 *   long enough to cover the common re-query pattern within a single turn.
 * - Max 500 entries with batch eviction (10% on overflow): prevents thrashing.
 * - Max 500KB per entry: prevents a single large result (e.g. workspaceSymbol)
 *   from dominating cache memory. At 500 entries × 500KB = 250MB theoretical max,
 *   but typical entries are < 50KB so practical max is ~25MB.
 * - LRU via Map insertion order: delete+re-insert moves entry to end (MRU).
 *   Eviction always removes from the beginning (LRU end).
 * - O(N) scan on invalidateFile: for N=500, this is ~500 string ops = < 1ms.
 *   No secondary index needed.
 */
class LspResultCache {
  private cache = new Map<CacheKey, CacheEntry>()
  // In-flight dedup: maps cache key → Promise that resolves when LSP request completes.
  // When multiple agents concurrently request the same key, they all await the same
  // Promise. The Promise is removed from this map once it resolves or rejects.
  private pendingRequests = new Map<CacheKey, Promise<unknown>>()
  // Invalidation generation counter — prevents stale factory results from
  // re-caching after invalidateFile has been called. Each invalidation bumps
  // the counter; factory functions capture the current generation and only
  // cache their result if the generation hasn't changed.
  private invalidationGen = 0
  private readonly maxEntries = 500
  private readonly ttlMs = 5 * 60 * 1000 // 5 minutes — short enough for agent edit cycles

  /**
   * Build a cache key from the operation parameters.
   */
  makeKey(
    filePath: string,
    method: string,
    position?: { line: number; character: number },
  ): CacheKey {
    if (position !== undefined) {
      return `${filePath}::${method}::${position.line}:${position.character}`
    }
    return `${filePath}::${method}`
  }

  /**
   * Get a cached result if available and not expired.
   * Returns undefined on cache miss or expiry.
   */
  get<T>(key: CacheKey): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    // TTL check — expired entries are removed immediately
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      return undefined
    }

    // Move to end for LRU ordering (most-recently-used)
    this.cache.delete(key)
    this.cache.set(key, entry)

    return JSON.parse(entry.result) as T
  }

  /**
   * Get a cached result, or fetch it using the provided factory function.
   * This method provides in-flight request deduplication: when multiple agents
   * concurrently call getOrFetch with the same key, only ONE factory call is
   * executed, and all callers await the same Promise.
   *
   * @param key - Cache key
   * @param factory - Async function to execute on cache miss
   * @returns Cached or freshly-fetched result
   */
  async getOrFetch<T>(
    key: CacheKey,
    factory: () => Promise<T | undefined>,
  ): Promise<T | undefined> {
    // Check cache first
    const cached = this.get<T>(key)
    if (cached !== undefined) {
      return cached
    }

    // Check for in-flight request
    const pending = this.pendingRequests.get(key)
    if (pending !== undefined) {
      return pending as Promise<T | undefined>
    }

    // Capture the current invalidation generation so we can detect if
    // the file was edited while the factory was running. If the generation
    // changed, we skip caching the stale result.
    const genAtStart = this.invalidationGen

    // Create new request and register for dedup.
    // Both .then and .catch clean up the pending entry to prevent
    // "stuck" promises on factory rejection.
    const promise = factory()
      .then(result => {
        this.pendingRequests.delete(key)
        // Only cache if the file wasn't invalidated while we were fetching
        if (result !== undefined && this.invalidationGen === genAtStart) {
          this.set(key, result)
        }
        return result
      })
      .catch(err => {
        this.pendingRequests.delete(key)
        throw err
      })

    this.pendingRequests.set(key, promise)
    return promise
  }

  /**
   * Store a result in the cache.
   * JSON-serializes the result to prevent mutation of cached objects.
   * Evicts 10% of oldest entries if at capacity to avoid thrashing.
   * Skips caching for results whose serialized size exceeds 500KB.
   */
  set<T>(key: CacheKey, result: T): void {
    // Batch evict oldest entries when near capacity to avoid per-insert thrashing
    if (this.cache.size >= this.maxEntries) {
      const evictCount = Math.ceil(this.maxEntries * 0.1)
      const keys = this.cache.keys()
      for (let i = 0; i < evictCount; i++) {
        const k = keys.next().value
        if (k) {
          this.cache.delete(k)
        }
      }
    }

    let serialized: string
    try {
      serialized = jsonStringify(result)
    } catch {
      // Unserializable result (circular refs, BigInt, etc.) — skip caching
      return
    }

    // Skip caching oversized results — max 500KB per entry
    const MAX_ENTRY_SIZE = 500 * 1024
    if (serialized.length > MAX_ENTRY_SIZE) {
      return
    }

    this.cache.set(key, {
      result: serialized,
      timestamp: Date.now(),
    })
  }

  /**
   * Invalidate all cache entries for a given file path.
   * Call this when a file is edited to avoid serving stale results.
   * Also cancels any in-flight requests for that file.
   * Bumps the invalidation generation to prevent late factory results
   * from re-caching stale data.
   */
  invalidateFile(filePath: string): void {
    this.invalidationGen++
    const prefix = `${filePath}::`
    for (const key of this.cache.keys()) {
      if (key === filePath || key.startsWith(prefix)) {
        this.cache.delete(key)
      }
    }
    // Also cancel in-flight requests for this file
    for (const key of this.pendingRequests.keys()) {
      if (key === filePath || key.startsWith(prefix)) {
        this.pendingRequests.delete(key)
      }
    }
  }

  /**
   * Clear the entire cache and pending requests.
   * Bumps the invalidation generation to prevent late factory results
   * from re-caching after a full clear.
   */
  clear(): void {
    this.invalidationGen++
    this.cache.clear()
    this.pendingRequests.clear()
  }

  /**
   * Get cache statistics for debugging.
   */
  getStats(): { size: number; pending: number } {
    return {
      size: this.cache.size,
      pending: this.pendingRequests.size,
    }
  }
}

// Export a singleton instance
export const lspResultCache = new LspResultCache()
