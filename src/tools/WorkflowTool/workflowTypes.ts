import type { AgentId } from '../../types/ids.js'

/**
 * Stage types supported by the declarative workflow engine.
 */
export type StageType =
  | 'fan_out'       // Run multiple agents in parallel
  | 'join'          // Wait for all previous parallel agents to finish
  | 'pipeline'      // Chain agents sequentially (output → input)
  | 'conditional'   // Branch based on condition result
  | 'sequential'    // Run agents in order without data passing

/**
 * Single stage in a workflow DAG.
 */
export type WorkflowStage = {
  /** Unique stage ID within the workflow */
  id: string
  /** Stage execution type */
  type: StageType
  /** Agent spec to spawn (for fan_out, pipeline, sequential) */
  agent?: {
    subagent_type?: string
    prompt: string
    description?: string
    model?: string
    max_budget_usd?: number
    max_tokens?: number
    timeout_seconds?: number
  }
  /** Multiple agent specs (for fan_out) */
  agents?: Array<{
    id: string
    subagent_type?: string
    prompt: string
    description?: string
    model?: string
  }>
  /** Condition expression (for conditional stages) */
  condition?: string
  /** Stages to run if condition is true */
  then?: string[]
  /** Stages to run if condition is false */
  else?: string[]
  /** Stage IDs this stage depends on */
  depends_on?: string[]
}

/**
 * Declarative workflow definition.
 */
export type WorkflowDefinition = {
  /** Workflow name */
  name: string
  /** Ordered list of stages */
  stages: WorkflowStage[]
}

/**
 * Result of a single stage execution.
 */
export type StageResult = {
  stageId: string
  status: 'completed' | 'failed' | 'skipped' | 'timed_out'
  output?: string
  agentId?: AgentId
  error?: string
  durationMs: number
}

/**
 * Complete workflow execution result.
 */
export type WorkflowResult = {
  workflowName: string
  status: 'completed' | 'failed' | 'partial'
  stageResults: Map<string, StageResult>
  totalDurationMs: number
}

/**
 * Workflow execution error.
 */
export class WorkflowError extends Error {
  constructor(
    message: string,
    public stageId?: string,
    public cause?: Error,
  ) {
    super(message)
    this.name = 'WorkflowError'
  }
}

/**
 * Validates a workflow definition for structural correctness.
 *
 * Checks:
 * - All stage IDs are unique
 * - All dependencies reference existing stages
 * - No circular dependencies
 * - Stage type has required fields
 */
export function validateWorkflow(workflow: WorkflowDefinition): string[] {
  const errors: string[] = []
  const stageIds = new Set<string>()

  for (const stage of workflow.stages) {
    // Unique ID check
    if (stageIds.has(stage.id)) {
      errors.push(`Duplicate stage ID: ${stage.id}`)
    }
    stageIds.add(stage.id)

    // Type-specific validation
    switch (stage.type) {
      case 'fan_out':
        if (!stage.agents || stage.agents.length === 0) {
          errors.push(`Stage ${stage.id}: fan_out requires 'agents' array`)
        }
        break
      case 'pipeline':
      case 'sequential':
        if (!stage.agent && !stage.agents) {
          errors.push(`Stage ${stage.id}: ${stage.type} requires 'agent' or 'agents'`)
        }
        break
      case 'conditional':
        if (!stage.condition) {
          errors.push(`Stage ${stage.id}: conditional requires 'condition'`)
        }
        break
    }

    // Dependency validation
    if (stage.depends_on) {
      for (const dep of stage.depends_on) {
        if (!stageIds.has(dep) && !workflow.stages.some(s => s.id === dep)) {
          errors.push(`Stage ${stage.id}: dependency '${dep}' does not exist`)
        }
      }
    }
  }

  // Circular dependency detection via DFS
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function hasCycle(stageId: string): boolean {
    if (inStack.has(stageId)) return true
    if (visited.has(stageId)) return false

    visited.add(stageId)
    inStack.add(stageId)

    const stage = workflow.stages.find(s => s.id === stageId)
    if (stage?.depends_on) {
      for (const dep of stage.depends_on) {
        if (hasCycle(dep)) return true
      }
    }

    inStack.delete(stageId)
    return false
  }

  for (const stage of workflow.stages) {
    if (hasCycle(stage.id)) {
      errors.push(`Circular dependency detected involving stage: ${stage.id}`)
      break
    }
  }

  return errors
}

/**
 * Compute topological execution order for parallel scheduling.
 * Returns groups of stages that can run in parallel.
 */
export function computeExecutionOrder(
  workflow: WorkflowDefinition,
): WorkflowStage[][] {
  const stageMap = new Map(workflow.stages.map(s => [s.id, s]))
  const inDegree = new Map<string, number>()
  const groups: WorkflowStage[][] = []

  // Initialize in-degrees
  for (const stage of workflow.stages) {
    const depCount = stage.depends_on?.length ?? 0
    inDegree.set(stage.id, depCount)
  }

  // Kahn's algorithm with level tracking
  const remaining = new Set(workflow.stages.map(s => s.id))

  while (remaining.size > 0) {
    // Find all stages with no remaining dependencies
    const ready: WorkflowStage[] = []
    for (const id of remaining) {
      const stage = stageMap.get(id)!
      const deps = stage.depends_on ?? []
      if (deps.every(dep => !remaining.has(dep))) {
        ready.push(stage)
      }
    }

    if (ready.length === 0) {
      // Should not happen if validation passed (no cycles)
      break
    }

    groups.push(ready)
    for (const stage of ready) {
      remaining.delete(stage.id)
    }
  }

  return groups
}
