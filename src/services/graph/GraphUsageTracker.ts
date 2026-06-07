/**
 * GraphUsageTracker — tracks graph tool usage patterns for PostToolUse hook
 *
 * Records what operations are used, tracks success/failure,
 * and provides usage statistics. Singleton keyed by projectRoot.
 *
 * Design: circular buffer of last 100 entries, all methods synchronous and fast.
 */

// ============================================================
// Types
// ============================================================

export interface UsageEntry {
  toolName: string        // 'codegraph' or 'grok'
  operation: string       // e.g. 'codegraph_search'
  timestamp: number       // Date.now()
  success: boolean
  duration: number        // ms
  query?: string          // the query/symbol if any
}

export interface UsageStats {
  totalCalls: number
  successRate: number
  avgDuration: number
  topOperations: Array<{ operation: string; count: number }>
  recentErrors: Array<{ operation: string; error: string; timestamp: number }>
}

// ============================================================
// Constants
// ============================================================

const BUFFER_SIZE = 100

// ============================================================
// GraphUsageTracker
// ============================================================

export class GraphUsageTracker {
  private static instances = new Map<string, GraphUsageTracker>()

  private buffer: UsageEntry[] = []
  private writeIndex = 0
  private isFull = false
  private errors: Array<{ operation: string; error: string; timestamp: number }> = []

  private constructor(private readonly projectRoot: string) {}

  /**
   * Get or create singleton instance for a project root
   */
  static getInstance(projectRoot: string): GraphUsageTracker {
    let instance = GraphUsageTracker.instances.get(projectRoot)
    if (!instance) {
      instance = new GraphUsageTracker(projectRoot)
      GraphUsageTracker.instances.set(projectRoot, instance)
    }
    return instance
  }

  /**
   * Reset the singleton map (for testing)
   */
  static resetAll(): void {
    GraphUsageTracker.instances.clear()
  }

  /**
   * Record a tool usage event
   */
  recordUsage(entry: UsageEntry): void {
    if (this.isFull) {
      this.buffer[this.writeIndex] = entry
    } else {
      this.buffer.push(entry)
      if (this.buffer.length === BUFFER_SIZE) {
        this.isFull = true
      }
    }

    // Track errors for recentErrors
    if (!entry.success) {
      this.errors.push({
        operation: entry.operation,
        error: entry.query ?? 'unknown error',
        timestamp: entry.timestamp,
      })
      // Keep only last 10 errors
      if (this.errors.length > 10) {
        this.errors = this.errors.slice(-10)
      }
    }

    this.writeIndex = (this.writeIndex + 1) % BUFFER_SIZE
  }

  /**
   * Get aggregated usage statistics
   */
  getStats(): UsageStats {
    const entries = this.getEntries()
    if (entries.length === 0) {
      return {
        totalCalls: 0,
        successRate: 0,
        avgDuration: 0,
        topOperations: [],
        recentErrors: [],
      }
    }

    let successCount = 0
    let totalDuration = 0
    const opCounts = new Map<string, number>()

    for (const entry of entries) {
      if (entry.success) successCount++
      totalDuration += entry.duration
      opCounts.set(entry.operation, (opCounts.get(entry.operation) ?? 0) + 1)
    }

    const topOperations = [...opCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([operation, count]) => ({ operation, count }))

    return {
      totalCalls: entries.length,
      successRate: successCount / entries.length,
      avgDuration: totalDuration / entries.length,
      topOperations,
      recentErrors: this.errors.slice(-5),
    }
  }

  /**
   * Get recent operations, most recent first
   */
  getRecentOperations(limit?: number): UsageEntry[] {
    const entries = this.getEntries()
    entries.reverse()
    return limit ? entries.slice(0, limit) : entries
  }

  /**
   * Get frequently co-occurring operation pairs (consecutive entries)
   * Returns [opA, opB, count] sorted by count descending
   */
  getFrequentPairs(): Array<[string, string, number]> {
    const entries = this.getEntries()
    if (entries.length < 2) return []

    const pairCounts = new Map<string, number>()

    for (let i = 0; i < entries.length - 1; i++) {
      const key = `${entries[i].operation}->${entries[i + 1].operation}`
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
    }

    return [...pairCounts.entries()]
      .map(([key, count]) => {
        const [a, b] = key.split('->')
        return [a, b, count] as [string, string, number]
      })
      .sort((a, b) => b[2] - a[2])
  }

  /**
   * Reset all data (for testing)
   */
  reset(): void {
    this.buffer = []
    this.writeIndex = 0
    this.isFull = false
    this.errors = []
  }

  // ============================================================
  // Internal
  // ============================================================

  /**
   * Get entries in chronological order (oldest first)
   */
  private getEntries(): UsageEntry[] {
    if (!this.isFull) {
      return [...this.buffer]
    }
    // When buffer is full, entries are stored in circular order
    // The writeIndex points to the oldest entry
    return [
      ...this.buffer.slice(this.writeIndex),
      ...this.buffer.slice(0, this.writeIndex),
    ]
  }
}
