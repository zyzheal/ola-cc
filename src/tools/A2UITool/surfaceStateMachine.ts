/**
 * SurfaceStateMachine — Surface lifecycle management
 *
 * Tracks the state of each Surface and validates transitions.
 * Prevents invalid message sequences (e.g., dataModelUpdate before beginRendering).
 */

import type { SurfaceState } from './types.js'

const VALID_TRANSITIONS: Record<string, SurfaceState[]> = {
  'nonexistent → surfaceUpdate': ['created'],
  'created → surfaceUpdate': ['created'],
  'created → beginRendering': ['rendering'],
  'created → deleteSurface': ['deleted'],
  'rendering → dataModelUpdate': ['interactive'],
  'rendering → surfaceUpdate': ['rendering'],
  'rendering → deleteSurface': ['deleted'],
  'interactive → dataModelUpdate': ['interactive'],
  'interactive → surfaceUpdate': ['interactive'],
  'interactive → deleteSurface': ['deleted'],
  'deleted → surfaceUpdate': ['created'],
}

export class SurfaceStateMachine {
  private states: Map<string, SurfaceState> = new Map()

  getState(surfaceId: string): SurfaceState {
    return this.states.get(surfaceId) || 'nonexistent'
  }

  validate(surfaceId: string, messageType: string): { valid: boolean; error?: string } {
    const currentState = this.getState(surfaceId)
    const transitionKey = `${currentState} → ${messageType}`
    const validTargets = VALID_TRANSITIONS[transitionKey]

    if (!validTargets) {
      return {
        valid: false,
        error: `Invalid transition: ${currentState} → ${messageType} for surface '${surfaceId}'`,
      }
    }
    return { valid: true }
  }

  transition(surfaceId: string, messageType: string): void {
    const currentState = this.getState(surfaceId)
    const transitionKey = `${currentState} → ${messageType}`
    const validTargets = VALID_TRANSITIONS[transitionKey]
    if (validTargets && validTargets.length > 0) {
      this.states.set(surfaceId, validTargets[0])
    }
  }

  create(surfaceId: string): void {
    this.states.set(surfaceId, 'created')
  }

  delete(surfaceId: string): void {
    this.states.set(surfaceId, 'deleted')
  }

  reset(): void {
    this.states.clear()
  }
}
