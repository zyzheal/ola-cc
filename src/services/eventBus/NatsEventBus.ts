// src/services/eventBus/NatsEventBus.ts

import { connect, type NatsConnection, type Subscription } from 'nats'
import type {
  EventBusEvent,
  EventBusStatus,
  IEventBus,
  EventBusPublishResult,
  EventBusSubscribeHandler,
  NatsConfig,
} from './types.js'

// Will be replaced with real session ID at runtime
function getSessionIdForSubject(): string {
  try {
    const { getSessionId } = require('../../bootstrap/state.js')
    return getSessionId() || 'default'
  } catch {
    return 'default'
  }
}

export class NatsEventBus implements IEventBus {
  private config: NatsConfig
  private connection: NatsConnection | null = null
  private subscriptions: Map<string, Subscription> = new Map()
  private _status: EventBusStatus = 'disconnected'
  private eventQueue: EventBusEvent[] = []
  private reconnectCount = 0

  constructor(config: NatsConfig) {
    this.config = config
  }

  get status(): EventBusStatus {
    return this._status
  }

  async connect(): Promise<void> {
    if (this._status === 'connected') return

    this._status = 'connecting'

    try {
      this.connection = await connect({
        servers: this.config.serverUrl,
        timeout: this.config.connectTimeout / 1000,
        reconnectTimeWait: this.config.reconnectInterval,
        maxReconnectAttempts: this.config.maxReconnectAttempts,
      })

      this._status = 'connected'
      this.reconnectCount = 0

      // Flush queued events
      await this.flushQueue()

      // Setup reconnection handler
      this.connection.closed()
        .then(() => { this._status = 'disconnected' })
        .catch(() => { this._status = 'error' })

    } catch (error) {
      this._status = 'error'
      throw error
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await Promise.all(
        Array.from(this.subscriptions.values()).map(s => s.unsubscribe())
      )
      this.subscriptions.clear()
      await this.connection.close()
      this.connection = null
    }
    this._status = 'disconnected'
  }

  async publish(event: EventBusEvent): Promise<EventBusPublishResult> {
    if (!this.connection || this._status !== 'connected') {
      // Queue event for later delivery
      this.eventQueue.push(event)
      return { success: true } // Queued, not an error
    }

    try {
      const subject = this.buildSubject(event.subtype)
      const data = JSON.stringify(event)
      this.connection.publish(subject, new TextEncoder().encode(data))
      return { success: true }
    } catch (error) {
      this.eventQueue.push(event)
      return { success: false, error: String(error) }
    }
  }

  async subscribe(subject: string, handler: EventBusSubscribeHandler): Promise<void> {
    if (!this.connection) {
      throw new Error('Not connected')
    }

    const fullSubject = this.buildSubject(subject)
    const subscription = this.connection.subscribe(fullSubject, {
      callback: (_err, msg) => {
        try {
          const data = new TextDecoder().decode(msg.data)
          const event = JSON.parse(data) as EventBusEvent
          handler(event)
        } catch (err) {
          console.error('Failed to parse NATS event:', err)
        }
      },
    })

    this.subscriptions.set(subject, subscription)
  }

  async unsubscribe(subject: string): Promise<void> {
    const subscription = this.subscriptions.get(subject)
    if (subscription) {
      subscription.unsubscribe()
      this.subscriptions.delete(subject)
    }
  }

  private buildSubject(eventType: string): string {
    const sessionId = getSessionIdForSubject()
    return `claude.${sessionId}.${eventType}`
  }

  private async flushQueue(): Promise<void> {
    if (!this.connection) return

    const events = [...this.eventQueue]
    this.eventQueue = []

    for (const event of events) {
      try {
        const subject = this.buildSubject(event.subtype)
        const data = JSON.stringify(event)
        this.connection.publish(subject, new TextEncoder().encode(data))
      } catch {
        this.eventQueue.push(event)
      }
    }
  }
}
