import { EventEmitter as NodeEventEmitter } from 'events'
import { Event } from './event.js'
import { routeEventToNats, type SdkEvent } from '../../utils/sdkEventQueue.js'

// Events to forward to NATS
const EVENTS_TO_ROUTE = [
  'task-started',
  'task-progress',
  'task-notification',
  'session-state-changed',
  'goal-created',
  'goal-completed',
  'tool-executed',
]

/** Common shape for Ink events that are routed to NATS */
interface InkRoutableEvent {
  taskId?: string
  description?: string
}

// Similar to node's builtin EventEmitter, but is also aware of our `Event`
// class, and so `emit` respects `stopImmediatePropagation()`.
export class EventEmitter extends NodeEventEmitter {
  constructor() {
    super()
    // Disable the default maxListeners warning. In React, many components
    // can legitimately listen to the same event (e.g., useInput hooks).
    // The default limit of 10 causes spurious warnings.
    this.setMaxListeners(0)
  }

  override emit(type: string | symbol, ...args: unknown[]): boolean {
    // Delegate to node for `error`, since it's not treated like a normal event
    if (type === 'error') {
      return super.emit(type, ...args)
    }

    const listeners = this.rawListeners(type)

    if (listeners.length === 0) {
      return false
    }

    const ccEvent = args[0] instanceof Event ? args[0] : null

    // Forward to NATS if applicable (fire-and-forget)
    if (typeof type === 'string' && EVENTS_TO_ROUTE.includes(type)) {
      const inkEvent = args[0] as InkRoutableEvent | null
      const natsEvent = {
        type: 'system' as const,
        subtype: type.replace(/-/g, '_') as SdkEvent['subtype'],
        task_id: inkEvent?.taskId ?? '',
        description: inkEvent?.description ?? '',
      } satisfies { type: 'system'; subtype: string; task_id: string; description: string }
      routeEventToNats(natsEvent as SdkEvent).catch((err) => { console.error('[ink:emitter] NATS event routing failed:', err); })
    }

    for (const listener of listeners) {
      listener.apply(this, args)

      if (ccEvent?.didStopImmediatePropagation()) {
        break
      }
    }

    return true
  }
}
