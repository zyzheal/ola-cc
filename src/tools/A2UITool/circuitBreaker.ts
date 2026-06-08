/**
 * CircuitBreaker — Failure detection and degradation
 *
 * Three states: CLOSED (normal) → OPEN (tripped) → HALF_OPEN (testing).
 * After N consecutive failures, the circuit opens and degrades to markdown.
 * After a timeout, it enters half-open and allows one probe request.
 */

import type { CircuitBreakerConfig, CircuitState } from './types.js'

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private lastFailureTime = 0
  private config: CircuitBreakerConfig

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = 'half-open'
        return false
      }
      return true
    }
    return false
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed'
    }
    this.failureCount = 0
  }

  recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()
    if (this.state === 'half-open') {
      this.state = 'open'
      return
    }
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open'
    }
  }

  getState(): CircuitState {
    // Trigger timeout check
    this.isOpen()
    return this.state
  }

  reset(): void {
    this.state = 'closed'
    this.failureCount = 0
    this.lastFailureTime = 0
  }
}
