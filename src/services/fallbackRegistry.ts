/**
 * Unified service fallback registry.
 *
 * Provides a standardized pattern for services to define primary implementations
 * with ordered fallback chains, retry policies, and timeout controls.
 *
 * Usage:
 *   const result = await executeWithFallback(eventBusStrategy)
 */

import { logError } from '../utils/log.js'

export type FallbackStrategy<T> = {
  /** Human-readable name for logging and metrics */
  name: string
  /** Primary (preferred) implementation */
  primary: () => Promise<T>
  /** Ordered fallback implementations, tried sequentially after primary fails */
  fallbacks: Array<{
    name: string
    execute: () => Promise<T>
    /** Whether to retry this fallback if it fails (usually false) */
    shouldRetry: boolean
  }>
  /** Maximum retries for the primary before falling through */
  maxRetries: number
  /** Timeout in milliseconds for each attempt */
  timeoutMs: number
}

/**
 * Execute a fallback strategy, trying the primary first then each fallback in order.
 * Returns the result of the first successful attempt.
 * Throws only when all attempts (primary + fallbacks) have exhausted.
 */
export async function executeWithFallback<T>(
  strategy: FallbackStrategy<T>,
): Promise<T> {
  // Try primary
  let primaryAttempts = 0
  while (primaryAttempts <= strategy.maxRetries) {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`${strategy.name} timeout after ${strategy.timeoutMs}ms`)),
          strategy.timeoutMs,
        )
      })
      return await Promise.race([strategy.primary(), timeoutPromise])
    } catch (primaryError) {
      primaryAttempts++
      if (primaryAttempts <= strategy.maxRetries) {
        // Retry primary
        continue
      }
      // Primary exhausted — log and fall through
      logError(primaryError)
    }
  }

  // Try each fallback in order
  for (const fallback of strategy.fallbacks) {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`${fallback.name} timeout after ${strategy.timeoutMs}ms`)),
          strategy.timeoutMs,
        )
      })
      const result = await Promise.race([fallback.execute(), timeoutPromise])
      return result
    } catch (fallbackError) {
      logError(fallbackError)
      if (!fallback.shouldRetry) {
        continue
      }
      // Retry once
      try {
        return await fallback.execute()
      } catch (retryError) {
        logError(retryError)
      }
    }
  }

  throw new Error(
    `All fallbacks exhausted for "${strategy.name}": primary + ${strategy.fallbacks.map(f => f.name).join(', ')} all failed`,
  )
}

// ─── Predefined strategies ────────────────────────────────────────────────

/**
 * EventBus fallback template: NATS → in-memory queue.
 * Wire to your actual event bus initialization code.
 */
export function eventBusStrategy(): FallbackStrategy<unknown> {
  return {
    name: 'event-bus',
    primary: async () => {
      const { NatsEventBus } = await import('./eventBus/NatsEventBus.js')
      const { getNatsConfig } = await import('./eventBus/config.js')
      const config = getNatsConfig()
      return new NatsEventBus(config)
    },
    fallbacks: [
      {
        name: 'memory-queue',
        execute: async () => ({ type: 'memory-queue' }),
        shouldRetry: false,
      },
    ],
    maxRetries: 0,
    timeoutMs: 5000,
  }
}
