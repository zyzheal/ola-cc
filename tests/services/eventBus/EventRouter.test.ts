// tests/services/eventBus/EventRouter.test.ts

import { describe, it, expect, beforeEach } from 'bun:test'
import { EventRouter } from '../../../src/services/eventBus/EventRouter.js'
import type { EventBusEvent } from '../../../src/services/eventBus/types.js'
import { DEFAULT_NATS_CONFIG } from '../../../src/services/eventBus/types.js'

describe('EventRouter', () => {
  let router: EventRouter

  beforeEach(() => {
    router = new EventRouter({
      natsConfig: DEFAULT_NATS_CONFIG,
      enableNats: true,
      sessionId: 'test-session',
    })
  })

  it('should route events to memory queue when NATS is unavailable', async () => {
    const event: EventBusEvent = {
      uuid: crypto.randomUUID(),
      session_id: 'test-session',
      timestamp: Date.now(),
      type: 'system',
      subtype: 'task_started',
      task_id: 'test-task',
      description: 'Test task',
    }

    const result = await router.routeEvent(event)
    // Should succeed via fallback to memory queue
    expect(result.success).toBe(true)
    expect(result.usedFallback).toBe(true)
  })

  it('should drain events from memory queue', () => {
    const events = router.drainMemoryQueue()
    expect(Array.isArray(events)).toBe(true)
  })

  it('should report NATS status', () => {
    const status = router.getStatus()
    expect(status).toHaveProperty('natsStatus')
    expect(status).toHaveProperty('queuedEvents')
    expect(status).toHaveProperty('natsEnabled')
  })

  it('should disable NATS when connection fails during initialize', async () => {
    await router.initialize()
    const status = router.getStatus()
    expect(status.natsEnabled).toBe(false)
    expect(status.natsStatus).toBe('disabled')
  })

  it('should enforce memory queue size limit', async () => {
    // Fill queue beyond limit by routing many events
    for (let i = 0; i < 5005; i++) {
      await router.routeEvent({
        uuid: crypto.randomUUID(),
        session_id: 'test-session',
        timestamp: Date.now(),
        type: 'system',
        subtype: 'task_progress',
        task_id: `task-${i}`,
        description: `Task ${i}`,
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
      })
    }

    const drained = router.drainMemoryQueue()
    // Should have capped at MAX_MEMORY_QUEUE_SIZE
    expect(drained.length).toBeLessThanOrEqual(5000)
  })
})
