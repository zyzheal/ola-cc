import { detectFileEncoding } from './file.js'
import { getFsImplementation } from './fsOperations.js'

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  mtime: number
}

/**
 * A simple in-memory cache for file contents with automatic invalidation based on modification time.
 * This eliminates redundant file reads in FileEditTool operations.
 */
class FileReadCache {
  private cache = new Map<string, CachedFileData>()
  private readonly maxCacheSize = 1000
  private readonly maxTotalBytes = 50 * 1024 * 1024 // 50MB total cache cap
  private readonly maxEntryBytes = 1 * 1024 * 1024 // 1MB per-entry cap
  private currentTotalBytes = 0

  /**
   * Reads a file with caching. Returns both content and encoding.
   * Cache key includes file path and modification time for automatic invalidation.
   */
  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()

    // Get file stats for cache invalidation
    let stats
    try {
      stats = fs.statSync(filePath)
    } catch (error) {
      // File was deleted, remove from cache and re-throw
      this.cache.delete(filePath)
      throw error
    }

    const cacheKey = filePath
    const cachedData = this.cache.get(cacheKey)

    // Check if we have valid cached data
    if (cachedData && cachedData.mtime === stats.mtimeMs) {
      return {
        content: cachedData.content,
        encoding: cachedData.encoding,
      }
    }

    // Cache miss or stale data - read the file
    const encoding = detectFileEncoding(filePath)
    const content = fs
      .readFileSync(filePath, { encoding })
      .replaceAll('\r\n', '\n')

    // Skip caching entries that exceed per-entry byte limit
    const entryBytes = Buffer.byteLength(content, 'utf8')
    if (entryBytes > this.maxEntryBytes) {
      return { content, encoding }
    }

    // Update cache and track byte size
    const oldEntry = this.cache.get(cacheKey)
    const oldEntryBytes = oldEntry ? Buffer.byteLength(oldEntry.content, 'utf8') : 0
    this.cache.set(cacheKey, {
      content,
      encoding,
      mtime: stats.mtimeMs,
    })
    this.currentTotalBytes = this.currentTotalBytes - oldEntryBytes + entryBytes

    // Evict oldest entries if cache exceeds count or byte limits
    this.evictIfNeeded()

    return { content, encoding }
  }

  /**
   * Evicts oldest entries until both count and byte limits are satisfied.
   */
  private evictIfNeeded(): void {
    const evictedByBytes = this.currentTotalBytes > this.maxTotalBytes
    const evictedByCount = this.cache.size > this.maxCacheSize
    if (!evictedByBytes && !evictedByCount) return

    let evictedCount = 0
    let bytesFreed = 0
    while (
      this.cache.size > this.maxCacheSize ||
      this.currentTotalBytes > this.maxTotalBytes
    ) {
      const firstKey = this.cache.keys().next().value
      if (!firstKey) break
      const entry = this.cache.get(firstKey)
      if (entry) {
        const entryBytes = Buffer.byteLength(entry.content, 'utf8')
        this.currentTotalBytes -= entryBytes
        bytesFreed += entryBytes
      }
      this.cache.delete(firstKey)
      evictedCount++
    }
    // Clamp to zero (floating-point subtraction can drift negative)
    if (this.currentTotalBytes < 0) {
      this.currentTotalBytes = 0
    }

    // Log eviction events for observability
    if (evictedCount > 0) {
      const trigger = evictedByBytes ? 'byte_limit' : 'count_limit'
      // eslint-disable-next-line no-console
      console.debug(
        `[FileReadCache] evicted ${evictedCount} entries (~${(bytesFreed / 1024).toFixed(1)}KB freed), trigger=${trigger}, remaining=${this.cache.size} entries / ${(this.currentTotalBytes / 1024 / 1024).toFixed(1)}MB`,
      )
    }
  }

  /**
   * Clears the entire cache. Useful for testing or memory management.
   */
  clear(): void {
    this.cache.clear()
    this.currentTotalBytes = 0
  }

  /**
   * Removes a specific file from the cache.
   */
  invalidate(filePath: string): void {
    const entry = this.cache.get(filePath)
    if (entry) {
      this.currentTotalBytes -= Buffer.byteLength(entry.content, 'utf8')
      if (this.currentTotalBytes < 0) this.currentTotalBytes = 0
    }
    this.cache.delete(filePath)
  }

  /**
   * Gets cache statistics for debugging/monitoring.
   */
  getStats(): {
    size: number
    totalBytes: number
    maxTotalBytes: number
    maxEntryBytes: number
    utilizationPercent: number
    entries: string[]
  } {
    return {
      size: this.cache.size,
      totalBytes: this.currentTotalBytes,
      maxTotalBytes: this.maxTotalBytes,
      maxEntryBytes: this.maxEntryBytes,
      utilizationPercent: Math.round(
        (this.currentTotalBytes / this.maxTotalBytes) * 100,
      ),
      entries: Array.from(this.cache.keys()),
    }
  }
}

// Export a singleton instance
export const fileReadCache = new FileReadCache()
