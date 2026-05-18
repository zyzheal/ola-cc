import type { AgentId } from '../../types/ids.js'

/**
 * Message sent between agents.
 */
export type AgentMessage = {
  /** Unique message ID */
  id: string
  /** Sender agent ID */
  from: AgentId
  /** Target agent ID (or '*' for broadcast) */
  to: AgentId | '*'
  /** Message type for routing/handling */
  type: 'result' | 'status' | 'error' | 'data'
  /** Payload */
  payload: Record<string, unknown>
  /** Timestamp */
  timestamp: number
  /** Optional correlation ID for request/response patterns */
  correlationId?: string
}

/**
 * Subscription callback for a channel.
 */
type ChannelCallback = (message: AgentMessage) => void

/**
 * EventChannel provides pub/sub communication between agents.
 *
 * Agents can publish to and subscribe from named channels, enabling
 * direct agent-to-agent communication without parent relay.
 */
export class EventChannel {
  private name: string
  private subscribers = new Map<string, ChannelCallback>()

  constructor(name: string) {
    this.name = name
  }

  /**
   * Subscribe to this channel. Returns an unsubscribe function.
   */
  subscribe(id: string, callback: ChannelCallback): () => void {
    this.subscribers.set(id, callback)
    return () => this.subscribers.delete(id)
  }

  /**
   * Publish a message to all subscribers.
   */
  publish(message: AgentMessage): void {
    for (const [, callback] of this.subscribers) {
      try {
        callback(message)
      } catch {
        // Subscriber errors should not break the channel
      }
    }
  }

  get channelName(): string {
    return this.name
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }
}

/**
 * AgentMessageRouter manages inter-agent communication.
 *
 * Architecture:
 * - Direct messages: point-to-point between two agents
 * - Channels: pub/sub for fan-out patterns
 * - Barrier: sync point for fan-in patterns
 *
 * Usage:
 * 1. Parent creates router
 * 2. Spawn agents with router reference
 * 3. Agents send messages via router.send()
 * 4. Parent or other agents receive via subscribe
 */
export class AgentMessageRouter {
  private channels = new Map<string, EventChannel>()
  private directQueues = new Map<AgentId, AgentMessage[]>()

  /**
   * Get or create a named channel.
   */
  getChannel(name: string): EventChannel {
    let channel = this.channels.get(name)
    if (!channel) {
      channel = new EventChannel(name)
      this.channels.set(name, channel)
    }
    return channel
  }

  /**
   * Send a direct message to a specific agent (queued for pickup).
   */
  send(message: AgentMessage): void {
    if (message.to === '*') {
      // Broadcast to all direct queues
      for (const [, queue] of this.directQueues) {
        queue.push(message)
      }
      // Also publish to 'broadcast' channel
      this.getChannel('broadcast').publish(message)
      return
    }

    // Direct delivery
    let queue = this.directQueues.get(message.to)
    if (!queue) {
      queue = []
      this.directQueues.set(message.to, queue)
    }
    queue.push(message)
  }

  /**
   * Poll for messages destined to a specific agent.
   */
  pollMessages(target: AgentId): AgentMessage[] {
    const queue = this.directQueues.get(target)
    if (!queue || queue.length === 0) return []

    const messages = [...queue]
    queue.length = 0
    return messages
  }

  /**
   * Create a barrier sync point. All agents must arrive before release.
   */
  createBarrier(agentCount: number): BarrierSync {
    return new BarrierSync(agentCount)
  }

  /**
   * Create a result aggregator for fan-in patterns.
   */
  createResultAggregator(expectedCount: number): ResultAggregator {
    return new ResultAggregator(expectedCount)
  }

  /**
   * Clean up all channels and queues.
   */
  destroy(): void {
    this.channels.clear()
    this.directQueues.clear()
  }
}

/**
 * BarrierSync: synchronization primitive for fan-in patterns.
 * All N agents must call arrive() before the promise resolves.
 */
export class BarrierSync {
  private count: number
  private total: number
  private resolve: (() => void) | null = null
  private promise: Promise<void>

  constructor(total: number) {
    this.total = total
    this.count = 0
    this.promise = new Promise(resolve => {
      this.resolve = resolve
    })
  }

  /**
   * Signal that an agent has reached the barrier.
   */
  arrive(): Promise<void> {
    this.count++
    if (this.count >= this.total && this.resolve) {
      this.resolve()
    }
    return this.promise
  }

  /**
   * Wait for all agents to arrive.
   */
  wait(): Promise<void> {
    return this.promise
  }
}

/**
 * ResultAggregator: collects results from N agents and triggers when complete.
 */
export class ResultAggregator {
  private results = new Map<AgentId, unknown>()
  private expected: number
  private resolve: ((results: Map<AgentId, unknown>) => void) | null = null
  private promise: Promise<Map<AgentId, unknown>>

  constructor(expected: number) {
    this.expected = expected
    this.promise = new Promise(resolve => {
      this.resolve = resolve
    })
  }

  /**
   * Submit a result from an agent.
   */
  submit(agentId: AgentId, result: unknown): void {
    this.results.set(agentId, result)
    if (this.results.size >= this.expected && this.resolve) {
      this.resolve(this.results)
    }
  }

  /**
   * Wait for all expected results.
   */
  waitForAll(): Promise<Map<AgentId, unknown>> {
    return this.promise
  }

  /**
   * Get current results snapshot (may be incomplete).
   */
  get currentResults(): ReadonlyMap<AgentId, unknown> {
    return this.results
  }
}

/**
 * Generate a unique message ID.
 */
let _msgCounter = 0
function generateMessageId(): string {
  return `agent-msg-${Date.now()}-${++_msgCounter}`
}

/**
 * Create an AgentMessage with auto-generated ID and timestamp.
 */
export function createAgentMessage(
  from: AgentId,
  to: AgentId | '*',
  type: AgentMessage['type'],
  payload: Record<string, unknown>,
  correlationId?: string,
): AgentMessage {
  return {
    id: generateMessageId(),
    from,
    to,
    type,
    payload,
    timestamp: Date.now(),
    correlationId,
  }
}

// Session-scoped singleton for default router
let _defaultRouter: AgentMessageRouter | null = null

export function getDefaultRouter(): AgentMessageRouter {
  if (!_defaultRouter) {
    _defaultRouter = new AgentMessageRouter()
  }
  return _defaultRouter
}

export function resetDefaultRouter(): void {
  _defaultRouter = null
}
