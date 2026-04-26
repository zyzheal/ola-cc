/**
 * Global registry for cleanup functions that should run during graceful shutdown.
 * This module is separate from gracefulShutdown.ts to avoid circular dependencies.
 */

// Global registry for cleanup functions
const cleanupFunctions = new Set<() => Promise<void>>()

/**
 * Register a cleanup function to run during graceful shutdown.
 * @param cleanupFn - Function to run during cleanup (can be sync or async)
 * @returns Unregister function that removes the cleanup handler
 */
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn) // Return unregister function
}

/**
 * Run all registered cleanup functions.
 * Used internally by gracefulShutdown.
 *
 * Each cleanup function is executed once and then removed from the registry.
 * This prevents double-execution on repeated shutdown signals and bounds the
 * Set size to zero after shutdown completes (no memory leak in daemon mode).
 * Failures in one cleanup function are logged but do not prevent others
 * from running.
 */
export async function runCleanupFunctions(): Promise<void> {
  const fns = Array.from(cleanupFunctions)
  cleanupFunctions.clear() // One-shot: remove all so repeated shutdown signals don't re-run

  const results = await Promise.allSettled(fns.map(fn => fn()))
  const rejections = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  for (const r of rejections) {
    console.error('Cleanup function failed:', r.reason)
  }
}
