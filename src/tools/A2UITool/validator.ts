/**
 * A2UIValidator — Dual validation (structural + state machine)
 *
 * Structural: component whitelist, unique IDs, valid data bindings, action whitelist.
 * State machine: valid Surface lifecycle transitions.
 */

import type {
  A2UIMessage,
  A2UIComponent,
  CatalogConfig,
  ValidationError,
  ValidationResult,
} from './types.js'
import { Catalog } from './catalog.js'
import { SurfaceStateMachine } from './surfaceStateMachine.js'

// ─── Structural Validation Rules ───

interface ValidationRule {
  name: string
  validate: (
    msg: A2UIMessage,
    catalog: CatalogConfig,
    seenIds: Set<string>,
  ) => ValidationError | null
}

const componentInCatalog: ValidationRule = {
  name: 'component_in_catalog',
  validate(msg, catalog) {
    const update = extractSurfaceUpdate(msg)
    if (!update) return null
    for (const { component } of update.components) {
      if (!catalog.components.some((c) => c.type === component.type)) {
        return {
          rule: 'component_in_catalog',
          message: `Component type '${component.type}' is not in catalog '${catalog.id}'`,
          path: `component.type=${component.type}`,
        }
      }
    }
    return null
  },
}

const uniqueComponentId: ValidationRule = {
  name: 'unique_component_id',
  validate(msg, _catalog, seenIds) {
    const update = extractSurfaceUpdate(msg)
    if (!update) return null
    for (const { id } of update.components) {
      if (seenIds.has(id)) {
        return {
          rule: 'unique_component_id',
          message: `Duplicate component id '${id}'`,
          path: `component.id=${id}`,
        }
      }
      seenIds.add(id)
    }
    return null
  },
}

const actionInWhitelist: ValidationRule = {
  name: 'action_in_whitelist',
  validate(msg, catalog) {
    const update = extractSurfaceUpdate(msg)
    if (!update) return null
    for (const { component } of update.components) {
      if (!component.actions) continue
      const def = catalog.components.find((c) => c.type === component.type)
      if (!def?.actions) continue
      for (const action of component.actions) {
        if (!def.actions.includes(action)) {
          return {
            rule: 'action_in_whitelist',
            message: `Action '${action}' not allowed for component '${component.type}'. Allowed: ${def.actions.join(', ')}`,
            path: `component.actions`,
          }
        }
      }
    }
    return null
  },
}

const rules: ValidationRule[] = [
  componentInCatalog,
  uniqueComponentId,
  actionInWhitelist,
]

// ─── Helper ───

function extractSurfaceUpdate(msg: A2UIMessage): { surfaceId?: string; components: Array<{ id: string; component: A2UIComponent }> } | null {
  if ('surfaceUpdate' in msg) return msg.surfaceUpdate
  return null
}

function extractMessageType(msg: A2UIMessage): string {
  if ('surfaceUpdate' in msg) return 'surfaceUpdate'
  if ('dataModelUpdate' in msg) return 'dataModelUpdate'
  if ('beginRendering' in msg) return 'beginRendering'
  if ('deleteSurface' in msg) return 'deleteSurface'
  return 'unknown'
}

function extractSurfaceId(msg: A2UIMessage, defaultId: string): string {
  if ('surfaceUpdate' in msg) return msg.surfaceUpdate.surfaceId || defaultId
  if ('dataModelUpdate' in msg) return msg.dataModelUpdate.surfaceId || defaultId
  if ('deleteSurface' in msg) return msg.deleteSurface.surfaceId
  return defaultId
}

// ─── Combined Validator ───

export class A2UIValidator {
  constructor(
    private catalog: Catalog,
    private stateMachine: SurfaceStateMachine,
  ) {}

  validate(messages: A2UIMessage[], defaultSurfaceId: string): ValidationResult {
    const allErrors: ValidationError[] = []
    const seenIds = new Set<string>()

    // 1. Structural validation
    for (const msg of messages) {
      const catalogConfig = this.catalog.get('default')
      for (const rule of rules) {
        const error = rule.validate(msg, catalogConfig, seenIds)
        if (error) allErrors.push(error)
      }
    }

    // 2. State machine validation (incremental: apply transitions as we go)
    for (const msg of messages) {
      const surfaceId = extractSurfaceId(msg, defaultSurfaceId)
      const messageType = extractMessageType(msg)
      const stateResult = this.stateMachine.validate(surfaceId, messageType)
      if (!stateResult.valid) {
        allErrors.push({
          rule: 'state_machine',
          message: stateResult.error!,
        })
      } else {
        this.stateMachine.transition(surfaceId, messageType)
      }
    }

    return { valid: allErrors.length === 0, errors: allErrors }
  }
}
