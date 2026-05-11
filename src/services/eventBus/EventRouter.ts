// src/services/eventBus/EventRouter.ts

import { randomUUID } from 'crypto'
import type { SdkEvent } from '../../utils/sdkEventQueue.js'
import { NatsEventBus } from './NatsEventBus.js'
import type {
  EventBusEvent,
  EventBusPublishResult,
  NatsConfig,
} from './types.js'

type EventRouterConfig = {
  natsConfig: NatsConfig
  enableNats: boolean
  sessionId: string
}

export type RouteResult = EventBusPublishResult & {
  usedFallback: boolean
}

export type RouterStatus = {
  natsStatus: string
  queuedEvents: number
  natsEnabled: boolean
}

export class EventRouter {
  private natsBus: NatsEventBus | null = null
  private memoryQueue: (SdkEvent & { uuid: string; session_id: string })[] = []
  private sessionId: string
  private enableNats: boolean
  private initialized = false

  constructor(config: EventRouterConfig) {
    this.sessionId = config.sessionId
    this.enableNats = config.enableNats

    if (config.enableNats) {
      this.natsBus = new NatsEventBus(config.natsConfig)
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    if (this.natsBus) {
      try {
        await this.natsBus.connect()
      } catch {
        // NATS unavailable, will use memory queue fallback
        this.enableNats = false
        this.natsBus = null
      }
    }

    this.initialized = true
  }

  async routeEvent(event: EventBusEvent): Promise<RouteResult> {
    const enrichedEvent = {
      ...event,
      uuid: event.uuid || randomUUID(),
      session_id: event.session_id || this.sessionId,
      timestamp: Date.now(),
    }

    // Try NATS first (only if initialized and connected)
    if (this.enableNats && this.natsBus && this.initialized) {
      const result = await this.natsBus.publish(enrichedEvent)
      if (result.success) {
        return { success: true, usedFallback: false }
      }
    }

    // Fallback to memory queue
    this.memoryQueue.push({
      ...enrichedEvent,
      uuid: enrichedEvent.uuid,
      session_id: enrichedEvent.session_id,
    })

    return { success: true, usedFallback: true }
  }

  drainMemoryQueue(): Array<SdkEvent & { uuid: string; session_id: string }> {
    const events = [...this.memoryQueue]
    this.memoryQueue = []
    return events
  }

  getStatus(): RouterStatus {
    return {
      natsStatus: this.natsBus?.status || 'disabled',
      queuedEvents: this.memoryQueue.length,
      natsEnabled: this.enableNats,
    }
  }

  async shutdown(): Promise<void> {
    if (this.natsBus) {
      await this.natsBus.disconnect()
    }
  }
}
