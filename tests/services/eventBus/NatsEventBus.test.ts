// tests/services/eventBus/NatsEventBus.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { NatsEventBus } from '../../../src/services/eventBus/NatsEventBus.js'
import type { EventBusEvent } from '../../../src/services/eventBus/types.js'
import { DEFAULT_NATS_CONFIG } from '../../../src/services/eventBus/types.js'

describe('NatsEventBus', () => {
  let eventBus: NatsEventBus

  beforeEach(() => {
    eventBus = new NatsEventBus(DEFAULT_NATS_CONFIG)
  })

  afterEach(async () => {
    try {
      await eventBus.disconnect()
    } catch {
      // Ignore disconnect errors in tests
    }
  })

  it('should initialize with disconnected status', () => {
    expect(eventBus.status).toBe('disconnected')
  })

  it('should fail to connect when no server available', async () => {
    await expect(eventBus.connect()).rejects.toThrow()
    expect(eventBus.status).toBe('error')
  })

  it('should queue events when disconnected', async () => {
    const event: EventBusEvent = {
      uuid: 'test-uuid',
      session_id: 'test-session',
      timestamp: Date.now(),
      type: 'system',
      subtype: 'task_started',
      task_id: 'test-task',
      description: 'Test task',
    }
    // Before connect, publish should queue the event
    const result = await eventBus.publish(event)
    expect(result.success).toBe(true) // Queued for later delivery
  })

  it('should build correct subject string', () => {
    const eventBusInternal = eventBus as any
    const subject = eventBusInternal.buildSubject('task_started')
    expect(subject).toContain('claude.')
    expect(subject).toContain('task_started')
  })
})
