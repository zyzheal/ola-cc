import { describe, test, expect, beforeEach } from 'bun:test'
import { CircuitBreaker } from '../circuitBreaker.js'

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker

  beforeEach(() => {
    breaker = new CircuitBreaker()
  })

  test('should start in closed state', () => {
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.getState()).toBe('closed')
  })

  test('should open after 3 consecutive failures', () => {
    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(false)

    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(false)

    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(true)
    expect(breaker.getState()).toBe('open')
  })

  test('should reset failure count on success', () => {
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordSuccess()

    // Should need 3 more failures to open
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(false)
  })

  test('should transition to half-open after timeout', async () => {
    const shortTimeoutBreaker = new CircuitBreaker({ resetTimeoutMs: 100 })

    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()
    expect(shortTimeoutBreaker.isOpen()).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(shortTimeoutBreaker.isOpen()).toBe(false)
    expect(shortTimeoutBreaker.getState()).toBe('half-open')
  })

  test('should close on success in half-open state', async () => {
    const shortTimeoutBreaker = new CircuitBreaker({ resetTimeoutMs: 100 })

    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(shortTimeoutBreaker.getState()).toBe('half-open')

    shortTimeoutBreaker.recordSuccess()
    expect(shortTimeoutBreaker.getState()).toBe('closed')
  })

  test('should reopen on failure in half-open state', async () => {
    const shortTimeoutBreaker = new CircuitBreaker({ resetTimeoutMs: 100 })

    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(shortTimeoutBreaker.getState()).toBe('half-open')

    shortTimeoutBreaker.recordFailure()
    expect(shortTimeoutBreaker.getState()).toBe('open')
  })

  test('should reset completely', () => {
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(true)

    breaker.reset()
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.getState()).toBe('closed')
  })

  test('should respect custom failure threshold', () => {
    const customBreaker = new CircuitBreaker({ failureThreshold: 5 })

    for (let i = 0; i < 4; i++) {
      customBreaker.recordFailure()
      expect(customBreaker.isOpen()).toBe(false)
    }

    customBreaker.recordFailure()
    expect(customBreaker.isOpen()).toBe(true)
  })
})
