/**
 * A2UI Protocol Type Definitions
 *
 * Defines the 4 Server→Client message types, component structure,
 * catalog configuration, actions, validation, and tool I/O types.
 */

// ─── A2UI Protocol Messages (4 Server→Client message types) ───

export type A2UIMessage =
  | { surfaceUpdate: SurfaceUpdate }
  | { dataModelUpdate: DataModelUpdate }
  | { beginRendering: BeginRendering }
  | { deleteSurface: DeleteSurface }

export interface SurfaceUpdate {
  surfaceId?: string
  components: Array<{ id: string; component: A2UIComponent }>
}

export interface DataModelUpdate {
  surfaceId?: string
  contents: Record<string, unknown>
}

export interface BeginRendering {
  root: string
  catalog?: string
}

export interface DeleteSurface {
  surfaceId: string
}

// ─── A2UI Component ───

export interface A2UIComponent {
  type: string
  props: Record<string, unknown>
  children?: string[]
  actions?: string[]
}

// ─── Catalog Configuration ───

export interface CatalogComponentDef {
  type: string
  props: Record<string, { type: string; required?: boolean; default?: unknown }>
  actions?: string[]
}

export interface CatalogConfig {
  id: string
  components: CatalogComponentDef[]
}

// ─── Action Types ───

export interface A2UIAction {
  surfaceId: string
  actionId: string
  componentId: string
  actionType: string
  payload: Record<string, unknown>
  timestamp: number
}

export type ActionCallback = (action: A2UIAction) => Promise<{ status: string; actionId: string }>

// ─── Validation ───

export interface ValidationError {
  rule: string
  message: string
  path?: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

// ─── Surface State Machine ───

export type SurfaceState = 'nonexistent' | 'created' | 'rendering' | 'interactive' | 'deleted'

// ─── Circuit Breaker ───

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerConfig {
  failureThreshold: number
  resetTimeoutMs: number
  halfOpenMaxAttempts: number
}

// ─── Tool I/O ───

export interface A2UIInput {
  a2ui_messages: A2UIMessage[]
  catalog_id?: string
  surface_id?: string
  theme?: 'light' | 'dark'
  title?: string
}

export interface A2UIOutput {
  surface_id: string
  file_path: string
  component_count: number
  action_port: number
  status: 'rendered' | 'degraded' | 'failed'
}

// ─── Action Server Config ───

export interface ActionServerConfig {
  port: number
  host: string
  maxBodySize: number
}
