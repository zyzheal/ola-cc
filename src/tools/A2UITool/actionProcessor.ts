/**
 * ActionProcessor — Action-to-Conversation Bridge
 *
 * Bridges browser user interactions back to the agent conversation.
 * Stores pending actions and provides them to the agent on next tool call.
 */

import type { A2UIAction } from './types.js'

export interface ProcessedAction {
  surfaceId: string
  componentId: string
  actionType: string
  payload: Record<string, unknown>
  timestamp: number
  summary: string
}

export class ActionProcessor {
  private pendingActions: Map<string, A2UIAction[]> = new Map()
  private processedCount = 0
  private maxPendingPerSurface: number

  constructor(maxPendingPerSurface = 100) {
    this.maxPendingPerSurface = maxPendingPerSurface
  }

  /**
   * Called when a new action arrives from the browser
   */
  onActionReceived(action: A2UIAction): void {
    const actions = this.pendingActions.get(action.surfaceId) || []
    if (actions.length >= this.maxPendingPerSurface) {
      actions.shift() // LRU eviction
    }
    actions.push(action)
    this.pendingActions.set(action.surfaceId, actions)
    this.processedCount++
  }

  /**
   * Consume all pending actions for a surface (called by agent)
   */
  consumeActions(surfaceId: string): ProcessedAction[] {
    const actions = this.pendingActions.get(surfaceId) || []
    this.pendingActions.delete(surfaceId)

    return actions.map((a) => ({
      surfaceId: a.surfaceId,
      componentId: a.componentId,
      actionType: a.actionType,
      payload: a.payload,
      timestamp: a.timestamp,
      summary: this.summarizeAction(a),
    }))
  }

  /**
   * Check if there are pending actions for a surface
   */
  hasPendingActions(surfaceId: string): boolean {
    const actions = this.pendingActions.get(surfaceId)
    return !!actions && actions.length > 0
  }

  /**
   * Get count of pending actions for a surface
   */
  getPendingCount(surfaceId: string): number {
    return this.pendingActions.get(surfaceId)?.length || 0
  }

  /**
   * Get total processed action count
   */
  get totalProcessed(): number {
    return this.processedCount
  }

  /**
   * Clear all pending actions
   */
  clear(): void {
    this.pendingActions.clear()
  }

  /**
   * Generate human-readable summary of an action
   */
  private summarizeAction(action: A2UIAction): string {
    const { componentId, actionType, payload } = action

    switch (actionType) {
      case 'onClick':
        return `User clicked ${componentId}`
      case 'onChange':
        return `User changed ${componentId} value to: ${JSON.stringify(payload.value)}`
      case 'onSubmit':
        return `User submitted form on ${componentId}`
      default:
        return `User triggered ${actionType} on ${componentId}`
    }
  }
}
