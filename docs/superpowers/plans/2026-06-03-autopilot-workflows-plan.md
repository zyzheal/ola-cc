# Autopilot Pipeline & Dynamic Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 4-stage Autopilot Pipeline and Dynamic Workflows system, porting from oh-my-claudecode and claude-code-best into ola-cc.

**Architecture:** Autopilot uses a prompt-driven orchestrator with 4 pluggable PipelineStageAdapters (ralplan/execution/ralph/qa). Dynamic Workflows uses a Markdown/YAML DSL parsed into step sequences, executed by an LLM-driven engine with approval gates.

**Tech Stack:** TypeScript, Bun, Zod schemas, Ink (terminal UI), feature() compile-time gates

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/services/autopilot/pipeline-types.ts` | PipelineStageId, PipelineConfig, PipelineStageAdapter, PipelineTracking, PipelineRole, ExecutionTier types |
| Create | `src/services/autopilot/modelResolver.ts` | resolveStageModel() + STAGE_DEFAULT_MODELS + TIER_MODELS — dynamic model selection via getAgentModel() |
| Create | `src/services/autopilot/pipeline.ts` | State machine: initPipeline, advanceStage, stage adapters |
| Create | `src/services/autopilot/enforcement.ts` | checkAutopilot(), checkAutopilotLegacy(), legacy alias routing |
| Create | `src/services/autopilot/adapters/ralplan.ts` | RALPLAN adapter: consensus planning prompt with Task() sub-agent calls |
| Create | `src/services/autopilot/adapters/execution.ts` | EXECUTION adapter: tier-based agent dispatch via resolveStageModel() |
| Create | `src/services/autopilot/adapters/ralph.ts` | RALPH adapter: 3-dimension parallel verification with sub-agents |
| Create | `src/services/autopilot/adapters/qa.ts` | QA adapter: sequential build/lint/test sub-agents |
| Create | `src/services/autopilot/adapters/index.ts` | ALL_ADAPTERS export |
| Create | `src/services/autopilot/boulderState.ts` | readBoulderState, writeBoulderState, appendSessionId |
| Create | `src/services/autopilot/continuationEnforcement.ts` | Hook + system prompt + completion signal detection |
| Create | `src/services/workflows/workflowEngine.ts` | Markdown parser, step sequencer, execution loop |
| Exists | `src/tools/WorkflowTool/` | WorkflowTool already implemented (YAML workflow engine with fan-out/join/pipeline/conditional) |
| Create | `src/services/workflows/runRecord.ts` | JSONL persistence: .claude/workflow-runs/*.json |
| Create | `src/services/workflows/errorRecovery.ts` | Retry/rollback/timeout + on_failure hook |
| Create | `src/services/workflows/migration.ts` | Legacy DAG JSON → workflow Markdown converter with topological sort |
| Create | `src/commands/autopilot/index.ts` | /autopilot PromptCommand handler |
| Modify | `src/commands/workflows/index.ts` | /workflow PromptCommand (replace existing placeholder) |
| Skip | `src/tools.ts` | WorkflowTool already registered |
| Skip | `src/commands.ts` | /workflows already registered |
| Modify | `scripts/build.ts` | Add AUTOPILOT_PIPELINE, BOULDER_STATE, CONTINUATION_ENFORCEMENT, WORKFLOW_SCRIPTS to fullExperimentalFeatures |
| Test | `src/services/autopilot/*.test.ts` | Autopilot tests |
| Test | `src/services/workflows/*.test.ts` | Workflow tests |

### WorkflowTool vs workflowEngine — Relationship

The existing `src/tools/WorkflowTool/` and the new `src/services/workflows/workflowEngine.ts` serve **different purposes** and coexist:

| Aspect | WorkflowTool (existing) | workflowEngine (new) |
|--------|------------------------|---------------------|
| **Format** | YAML-only workflow definitions | Markdown/YAML hybrid DSL |
| **Execution** | Tool-based (model calls `WorkflowTool` as a tool) | Command-based (`/workflow start <file>`) |
| **Features** | fan-out, join, pipeline, conditional branching | Sequential steps with approval gates |
| **Use case** | Complex multi-branch automation | Simple linear task sequences |
| **Entry point** | `src/tools/WorkflowTool/` (registered in tools.ts) | `src/services/workflows/` (driven by /workflow command) |

**Coordination:** The `/workflow` command can delegate to WorkflowTool for YAML files that use fan-out/join features, while handling simple Markdown workflows directly via workflowEngine. The `migration.ts` module converts legacy DAG JSON into the Markdown format for backward compatibility.

**Delegation Logic (in `/workflow start` command):**
```typescript
// In src/commands/workflows/index.ts — the "start" subcommand:
async function handleStart(workflowPath: string) {
  const content = readFileSync(workflowPath, "utf-8")
  const isYaml = workflowPath.endsWith(".yaml") || workflowPath.endsWith(".yml")

  if (isYaml) {
    // Delegate to existing WorkflowTool for YAML files (supports fan-out/join/pipeline/conditional)
    // WorkflowTool is registered in src/tools.ts and handles YAML natively
    // The command builds a tool-call prompt that invokes WorkflowTool with the YAML content
    return [{
      type: "text",
      text: `Execute this YAML workflow using the WorkflowTool:\n\n${content}\n\nUse the workflow tool to run this workflow definition.`
    }]
  }

  // For .md files: use workflowEngine (sequential steps with approval gates)
  const def = parseWorkflowFile(content)
  const record = createRunRecord(process.cwd(), def.name, {})
  // ... build step-by-step prompt as shown in Task 8 Step 3
}
```

**Key distinction:**
- `.yaml`/`.yml` files → `WorkflowTool` (tool-based, model calls it as a tool, supports fan-out/join)
- `.md` files → `workflowEngine` (command-based, sequential steps with approval gates)
- Legacy `.json` DAG files → `migration.ts` converts to `.md` format first

---

### Task 1: Pipeline Types & State Machine

**Files:**
- Create: `src/services/autopilot/pipeline-types.ts`
- Create: `src/services/autopilot/pipeline.ts`
- Test: `src/services/autopilot/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/autopilot/pipeline.test.ts
import { describe, test, expect } from "bun:test"
import { initPipeline, advanceStage } from "./pipeline"

describe("Pipeline", () => {
  test("initPipeline creates initial state with ralplan stage", () => {
    const state = initPipeline("/tmp/test", "build a todo app", "session-1")
    expect(state).not.toBeNull()
    expect(state!.stages).toHaveLength(4)
    expect(state!.stages[0].id).toBe("ralplan")
    expect(state!.stages[0].status).toBe("active")
    expect(state!.stages[1].status).toBe("pending")
  })

  test("advanceStage moves to next stage on completion signal", () => {
    const state = initPipeline("/tmp/test", "idea", "session-1")!
    state.stages[0].status = "complete"
    const next = advanceStage(state)
    expect(next.stage.id).toBe("execution")
    expect(next.stage.status).toBe("active")
  })

  test("advanceStage returns null when all stages complete", () => {
    const state = initPipeline("/tmp/test", "idea", "session-1")!
    for (const s of state.stages) s.status = "complete"
    const next = advanceStage(state)
    expect(next).toBeNull()
  })

  test("initPipeline respects PipelineConfig skip options", () => {
    const state = initPipeline("/tmp/test", "idea", "session-1", {
      verification: false,
      qa: { enabled: false },
    })
    expect(state!.stages.find(s => s.id === "ralph")!.status).toBe("skipped")
    expect(state!.stages.find(s => s.id === "qa")!.status).toBe("skipped")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/autopilot/pipeline.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/autopilot/pipeline-types.ts
import type { ModelAlias } from '../../utils/model/aliases.js'

export type PipelineStageId = "ralplan" | "execution" | "ralph" | "qa"
export type PipelineStageStatus = "pending" | "active" | "complete" | "failed" | "skipped" | "cancelled"
export type PipelineRole = "planning" | "execution" | "verification" | "qa" | "fix-deep"
export type ExecutionTier = "low" | "normal" | "high"

export interface PipelineStageState {
  id: PipelineStageId
  status: PipelineStageStatus
  startedAt?: number
  completedAt?: number
  error?: string
  attempts: number
}

export interface PipelineTracking {
  stages: PipelineStageState[]
  currentStageIndex: number
  sessionId: string
  directory: string
  idea: string
  createdAt: number
  updatedAt: number
}

export interface PipelineConfig {
  verification: { engine: "ralph"; maxIterations: number } | false
  qa: { enabled: boolean; maxRetries: number }
  execution: { tier: ExecutionTier }
  maxTotalStages: number
  /** User-specified model overrides per pipeline role. Overrides take precedence over defaults. */
  stageModels?: Partial<Record<PipelineRole, ModelAlias | string>>
}

export interface PipelineStageAdapter {
  id: PipelineStageId
  name: string
  completionSignal: string
  shouldSkip(config: PipelineConfig): boolean
  getPrompt(context: { idea: string; directory: string }): string
  onEnter?(state: PipelineTracking): void
  onExit?(state: PipelineTracking): void
}

export const DEPRECATED_MODE_ALIASES: Record<string, string> = {
  ultrawork: "autopilot",
  ultrapilot: "autopilot",
}
```

```typescript
// src/services/autopilot/modelResolver.ts
import { getAgentModel } from '../../utils/model/agent.js'
import { getRuntimeMainLoopModel } from '../../utils/model/model.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import type { PipelineRole, ExecutionTier, PipelineConfig } from './pipeline-types.js'

/** Stage default model mapping — NOT hardcoded model IDs, just aliases.
 *  These are resolved through getAgentModel() which handles:
 *  - Non-Claude parent models (qwen/llama/gemini): auto-inherit parent
 *  - Bedrock cross-region prefix inheritance
 *  - OLA_CC_SUBAGENT_MODEL override
 *  - aliasMatchesParentTier (same tier = same exact model)
 */
const STAGE_DEFAULT_MODELS: Record<PipelineRole, ModelAlias> = {
  planning: 'opus',       // Planning requires strong reasoning
  execution: 'sonnet',    // Execution balances speed and quality
  verification: 'sonnet', // Verification uses medium reasoning
  qa: 'haiku',            // QA is lightweight checks
  'fix-deep': 'opus',     // Deep fix requires strong reasoning
}

const TIER_MODELS: Record<ExecutionTier, ModelAlias> = {
  low: 'haiku',    // Simple file operations, formatting
  normal: 'sonnet', // Standard feature implementation
  high: 'opus',    // Architectural changes, complex logic
}

/**
 * Dynamically resolve the model for a pipeline stage.
 *
 * Priority: config.stageModels > env var > default alias > getAgentModel(inherit)
 *
 * Key protection: when parent is a non-Claude model (qwen/llama/gemini),
 * getAgentModel() at L84 already ensures all Claude aliases auto-inherit
 * the parent model — no unsupported model calls will happen.
 */
export function resolveStageModel(
  role: PipelineRole,
  tier?: ExecutionTier,
  config?: PipelineConfig,
  parentModel?: string,
): string {
  // 1. User-specified config override (highest priority)
  const userOverride = config?.stageModels?.[role]
  if (userOverride) return userOverride

  // 2. Environment variable override
  const envKey = `OLA_CC_AUTOPILOT_MODEL_${role.toUpperCase().replace('-', '_')}`
  if (process.env[envKey]) return process.env[envKey]!

  // 3. Default alias mapping (tier only for execution stage)
  const defaultAlias = tier ? TIER_MODELS[tier] : STAGE_DEFAULT_MODELS[role]

  // 4. Resolve through getAgentModel() (handles all edge cases)
  return getAgentModel(undefined, parentModel ?? getRuntimeMainLoopModel(), defaultAlias)
}
```

```typescript
// src/services/autopilot/pipeline.ts
import type {
  PipelineStageId,
  PipelineConfig,
  PipelineTracking,
  PipelineStageState,
} from "./pipeline-types"

const STAGE_ORDER: PipelineStageId[] = ["ralplan", "execution", "ralph", "qa"]

const DEFAULT_CONFIG: PipelineConfig = {
  verification: { engine: "ralph", maxIterations: 100 },
  qa: { enabled: true, maxRetries: 3 },
  execution: { tier: "normal" },
  maxTotalStages: 4,
}

export function initPipeline(
  directory: string,
  idea: string,
  sessionId: string,
  configOverrides?: Partial<PipelineConfig>,
): PipelineTracking | null {
  const config = { ...DEFAULT_CONFIG, ...configOverrides }
  const stages: PipelineStageState[] = STAGE_ORDER.map((id) => ({
    id,
    status: "pending" as const,
    attempts: 0,
  }))

  // Apply skip config
  if (config.verification === false) {
    const ralph = stages.find((s) => s.id === "ralph")!
    ralph.status = "skipped"
  }
  if (config.qa && !config.qa.enabled) {
    const qa = stages.find((s) => s.id === "qa")!
    qa.status = "skipped"
  }

  // Find first non-skipped stage
  const firstActive = stages.find((s) => s.status !== "skipped")
  if (!firstActive) return null
  firstActive.status = "active"
  firstActive.startedAt = Date.now()

  return {
    stages,
    currentStageIndex: stages.indexOf(firstActive),
    sessionId,
    directory,
    idea,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function advanceStage(
  state: PipelineTracking,
): { stage: PipelineStageState; index: number } | null {
  const current = state.stages[state.currentStageIndex]
  if (current.status !== "complete") return null

  // Find next non-skipped stage
  for (let i = state.currentStageIndex + 1; i < state.stages.length; i++) {
    const next = state.stages[i]
    if (next.status === "skipped") continue
    next.status = "active"
    next.startedAt = Date.now()
    state.currentStageIndex = i
    state.updatedAt = Date.now()
    return { stage: next, index: i }
  }
  return null
}
```

- [ ] **Step 3.5: Write enforcement.ts with legacy alias routing**

```typescript
// src/services/autopilot/enforcement.ts
import { DEPRECATED_MODE_ALIASES } from "./pipeline-types"
import { initPipeline } from "./pipeline"
import type { PipelineTracking } from "./pipeline-types"

/**
 * Check if a command is a legacy autopilot alias (ultrawork, ultrapilot).
 * Returns the resolved command name or null if not a legacy alias.
 */
export function checkAutopilotLegacy(commandName: string): string | null {
  const normalized = commandName.toLowerCase().trim()
  return DEPRECATED_MODE_ALIASES[normalized] ?? null
}

/**
 * Route a legacy autopilot command to the new pipeline.
 * Returns the pipeline state if successfully initialized, or an error message.
 */
export function routeLegacyAutopilot(
  commandName: string,
  idea: string,
  directory: string,
  sessionId: string,
): { state: PipelineTracking | null; deprecationWarning: string } {
  const resolved = checkAutopilotLegacy(commandName)
  if (!resolved) {
    return { state: null, deprecationWarning: "" }
  }
  const state = initPipeline(directory, idea, sessionId)
  return {
    state,
    deprecationWarning: `Warning: /${commandName} is deprecated. Use /autopilot instead.`,
  }
}

/**
 * Check if autopilot is available (runtime check, independent of feature flag).
 */
export function checkAutopilot(): boolean {
  // Runtime availability check — always true in current implementation
  // Future: check license, config, etc.
  return true
}
```

- [ ] **Step 3.6: Write enforcement.test.ts**

```typescript
// src/services/autopilot/enforcement.test.ts
import { describe, test, expect } from "bun:test"
import { checkAutopilotLegacy, routeLegacyAutopilot, checkAutopilot } from "./enforcement"

describe("Enforcement", () => {
  test("checkAutopilotLegacy resolves ultrawork to autopilot", () => {
    expect(checkAutopilotLegacy("ultrawork")).toBe("autopilot")
  })

  test("checkAutopilotLegacy resolves ultrapilot to autopilot", () => {
    expect(checkAutopilotLegacy("ultrapilot")).toBe("autopilot")
  })

  test("checkAutopilotLegacy is case-insensitive", () => {
    expect(checkAutopilotLegacy("ULTRAWORK")).toBe("autopilot")
    expect(checkAutopilotLegacy("UltraPilot")).toBe("autopilot")
  })

  test("checkAutopilotLegacy returns null for non-legacy commands", () => {
    expect(checkAutopilotLegacy("autopilot")).toBeNull()
    expect(checkAutopilotLegacy("help")).toBeNull()
    expect(checkAutopilotLegacy("")).toBeNull()
  })

  test("routeLegacyAutopilot returns pipeline state for legacy alias", () => {
    const result = routeLegacyAutopilot("ultrawork", "build a CLI", "/tmp", "s1")
    expect(result.state).not.toBeNull()
    expect(result.state!.idea).toBe("build a CLI")
    expect(result.deprecationWarning).toContain("ultrawork")
    expect(result.deprecationWarning).toContain("deprecated")
  })

  test("routeLegacyAutopilot returns null state for non-legacy command", () => {
    const result = routeLegacyAutopilot("autopilot", "build a CLI", "/tmp", "s1")
    expect(result.state).toBeNull()
    expect(result.deprecationWarning).toBe("")
  })

  test("checkAutopilot returns true (runtime availability)", () => {
    expect(checkAutopilot()).toBe(true)
  })
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/autopilot/pipeline.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/autopilot/pipeline-types.ts src/services/autopilot/pipeline.ts src/services/autopilot/enforcement.ts src/services/autopilot/pipeline.test.ts
git commit -m "feat(autopilot): add pipeline types, state machine, and legacy alias routing"
```

---

### Task 2: Stage Adapters (4 adapters)

**Files:**
- Create: `src/services/autopilot/adapters/ralplan.ts`
- Create: `src/services/autopilot/adapters/execution.ts`
- Create: `src/services/autopilot/adapters/ralph.ts`
- Create: `src/services/autopilot/adapters/qa.ts`
- Create: `src/services/autopilot/adapters/index.ts`
- Test: `src/services/autopilot/adapters/adapters.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/autopilot/adapters/adapters.test.ts
import { describe, test, expect } from "bun:test"
import { ALL_ADAPTERS } from "./index"
import type { PipelineConfig } from "../pipeline-types"

describe("Stage Adapters", () => {
  test("ALL_ADAPTERS exports 4 adapters in order", () => {
    expect(ALL_ADAPTERS).toHaveLength(4)
    expect(ALL_ADAPTERS.map((a) => a.id)).toEqual(["ralplan", "execution", "ralph", "qa"])
  })

  test("ralplan adapter produces consensus planning prompt", () => {
    const adapter = ALL_ADAPTERS[0]
    const prompt = adapter.getPrompt({ idea: "build a CLI", directory: "/tmp" })
    expect(prompt).toContain("RALPLAN")
    expect(prompt).toContain("spec.md")
    expect(prompt).toContain("plan.md")
  })

  test("ralph adapter skips when verification is false", () => {
    const adapter = ALL_ADAPTERS[2]
    expect(adapter.shouldSkip({ verification: false } as PipelineConfig)).toBe(true)
    expect(adapter.shouldSkip({ verification: { engine: "ralph", maxIterations: 10 } } as PipelineConfig)).toBe(false)
  })

  test("execution adapter selects tier from config", () => {
    const adapter = ALL_ADAPTERS[1]
    const prompt = adapter.getPrompt({ idea: "test", directory: "/tmp" })
    expect(prompt).toContain("EXECUTION")
  })

  test("each adapter has PIPELINE_<STAGE>_COMPLETE signal", () => {
    for (const adapter of ALL_ADAPTERS) {
      expect(adapter.completionSignal).toBe(`PIPELINE_${adapter.id.toUpperCase()}_COMPLETE`)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/autopilot/adapters/adapters.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/autopilot/adapters/ralplan.ts
import type { PipelineStageAdapter, PipelineConfig } from "../pipeline-types"
import { resolveStageModel } from "../modelResolver"

export const ralplanAdapter: PipelineStageAdapter = {
  id: "ralplan",
  name: "Consensus Planning",
  completionSignal: "PIPELINE_RALPLAN_COMPLETE",
  shouldSkip: () => false,
  getPrompt: ({ idea, directory }) => `
## PIPELINE STAGE: RALPLAN (Consensus Planning)
Your task: Expand the idea into a detailed spec and implementation plan using consensus-driven planning.

### Part 1: Idea Expansion (Spec Creation)
Use the AgentTool to spawn a sub-agent with model resolveStageModel('planning') to expand "${idea}" into a detailed spec:
- Requirements, constraints, and acceptance criteria
- Save to: ${directory}/.omc/autopilot/spec.md

### Part 2: Consensus Planning
Use the AgentTool to spawn a sub-agent with model resolveStageModel('planning') to create an implementation plan:
- Task breakdown with dependencies and effort estimates
- Save to: ${directory}/.omc/autopilot/plan.md

### Part 3: Review
Use the AgentTool to spawn a sub-agent with model resolveStageModel('planning') to review both documents for completeness and correctness.

Signal when all 3 parts complete: PIPELINE_RALPLAN_COMPLETE
`,
}
```

```typescript
// src/services/autopilot/adapters/execution.ts
import type { PipelineStageAdapter, PipelineConfig } from "../pipeline-types"

/** Map config tier to model alias via resolveStageModel (not hardcoded) */
function tierToModel(tier: "low" | "normal" | "high", config?: PipelineConfig, parentModel?: string): string {
  return resolveStageModel('execution', tier, config, parentModel)
}

export const executionAdapter: PipelineStageAdapter = {
  id: "execution",
  name: "Code Execution",
  completionSignal: "PIPELINE_EXECUTION_COMPLETE",
  shouldSkip: () => false,
  getPrompt: ({ idea, directory }) => `
## PIPELINE STAGE: EXECUTION
Your task: Implement the plan from ${directory}/.omc/autopilot/plan.md.

For each task in the plan, use the AgentTool to spawn a sub-agent:
- Model: Use resolveStageModel('execution', tier) — tier determined by task complexity
- Each sub-agent should: read the task description, implement the code, run tests, mark complete
- Tasks with dependencies must wait for prerequisites to finish

### Tier-Based Agent Dispatch (Dynamic Model Selection)
- **Tier LOW**: resolveStageModel('execution', 'low') → default haiku (simple CRUD, config, formatting)
- **Tier NORMAL**: resolveStageModel('execution', 'normal') → default sonnet (business logic, API, refactors)
- **Tier HIGH**: resolveStageModel('execution', 'high') → default opus (architecture, security, cross-cutting)
- **Non-Claude parent**: all tiers inherit parent model automatically via getAgentModel()

Signal when all tasks are done: PIPELINE_EXECUTION_COMPLETE
`,
}
```

```typescript
// src/services/autopilot/adapters/ralph.ts
import type { PipelineStageAdapter, PipelineConfig } from "../pipeline-types"
import { resolveStageModel } from "../modelResolver"

export const ralphAdapter: PipelineStageAdapter = {
  id: "ralph",
  name: "Three-Dimension Verification",
  completionSignal: "PIPELINE_RALPH_COMPLETE",
  shouldSkip: (config: PipelineConfig) => config.verification === false,
  getPrompt: ({ directory }) => `
## PIPELINE STAGE: RALPH (Verification)
Your task: Verify the implementation in ${directory} across 3 dimensions using parallel sub-agents.

Spawn 3 sub-agents in parallel using the AgentTool, each with model resolveStageModel('verification'):

1. **Functional Verification**: Sub-agent checks feature completeness against ${directory}/.omc/autopilot/spec.md, acceptance criteria coverage
2. **Security Verification**: Sub-agent checks OWASP Top 10, input validation, injection vulnerabilities
3. **Quality Verification**: Sub-agent checks code organization, design patterns, test coverage

Each sub-agent outputs APPROVED or REJECTED with detailed reasons.

After all 3 complete:
- If all APPROVED, signal: PIPELINE_RALPH_COMPLETE
- If any REJECTED, use resolveStageModel('fix-deep') to spawn a fix sub-agent that addresses the issues, then re-verify
- Max iterations: check PipelineConfig.verification.maxIterations
`,
}
```

```typescript
// src/services/autopilot/adapters/qa.ts
import type { PipelineStageAdapter } from "../pipeline-types"
import { resolveStageModel } from "../modelResolver"

export const qaAdapter: PipelineStageAdapter = {
  id: "qa",
  name: "Quality Assurance",
  completionSignal: "PIPELINE_QA_COMPLETE",
  shouldSkip: (config) => config.qa && !config.qa.enabled,
  getPrompt: ({ directory }) => `
## PIPELINE STAGE: QA
Your task: Run build, lint, and test suite in ${directory} using sub-agents.

Use the AgentTool to spawn sub-agents sequentially (each depends on the previous passing):

1. **Build**: Sub-agent (model resolveStageModel('qa')) runs build and fixes compilation errors
2. **Lint**: Sub-agent (model resolveStageModel('qa')) runs linter and fixes warnings
3. **Test**: Sub-agent (model resolveStageModel('qa')) runs tests and fixes failures

If any step fails after maxRetries (from PipelineConfig.qa.maxRetries), use resolveStageModel('fix-deep') for a deep-dive fix sub-agent.

Signal when all pass: PIPELINE_QA_COMPLETE
`,
}
```

```typescript
// src/services/autopilot/adapters/index.ts
import type { PipelineStageAdapter } from "../pipeline-types"
import { ralplanAdapter } from "./ralplan"
import { executionAdapter } from "./execution"
import { ralphAdapter } from "./ralph"
import { qaAdapter } from "./qa"

export const ALL_ADAPTERS: PipelineStageAdapter[] = [
  ralplanAdapter,
  executionAdapter,
  ralphAdapter,
  qaAdapter,
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/autopilot/adapters/adapters.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/autopilot/adapters/
git commit -m "feat(autopilot): add 4 stage adapters with prompts and skip logic"
```

---

### Task 3: Boulder State Persistence

**Files:**
- Create: `src/services/autopilot/boulderState.ts`
- Test: `src/services/autopilot/boulderState.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/autopilot/boulderState.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { readBoulderState, writeBoulderState, appendSessionId } from "./boulderState"
import { mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"

const TEST_DIR = join(import.meta.dir, "__test_boulder")

describe("BoulderState", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test("readBoulderState returns null when no boulder.json", () => {
    expect(readBoulderState(TEST_DIR)).toBeNull()
  })

  test("writeBoulderState creates boulder.json atomically", () => {
    const state = {
      active_plan: join(TEST_DIR, "plan.md"),
      started_at: Date.now(),
      session_ids: ["s1"],
      plan_name: "test-plan",
      active: true,
      updatedAt: Date.now(),
    }
    const ok = writeBoulderState(TEST_DIR, state)
    expect(ok).toBe(true)
    expect(existsSync(join(TEST_DIR, ".omc", "boulder.json"))).toBe(true)
  })

  test("appendSessionId adds session to existing state", () => {
    const state = {
      active_plan: join(TEST_DIR, "plan.md"),
      started_at: Date.now(),
      session_ids: ["s1"],
      plan_name: "test-plan",
      active: true,
      updatedAt: Date.now(),
    }
    writeBoulderState(TEST_DIR, state)
    const updated = appendSessionId(TEST_DIR, "s2")
    expect(updated!.session_ids).toContain("s1")
    expect(updated!.session_ids).toContain("s2")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/autopilot/boulderState.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/autopilot/boulderState.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"

export interface BoulderState {
  active_plan: string
  started_at: number
  session_ids: string[]
  plan_name: string
  active: boolean
  updatedAt: number
  metadata?: Record<string, unknown>
}

function getBoulderPath(directory: string): string {
  return join(directory, ".omc", "boulder.json")
}

export function readBoulderState(directory: string): BoulderState | null {
  const path = getBoulderPath(directory)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BoulderState
  } catch {
    return null
  }
}

export function writeBoulderState(directory: string, state: BoulderState): boolean {
  try {
    const dir = join(directory, ".omc")
    mkdirSync(dir, { recursive: true })
    const path = getBoulderPath(directory)
    const tmp = path + ".tmp"
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    // Atomic rename (same filesystem)
    const { renameSync } = require("fs")
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

export function appendSessionId(directory: string, sessionId: string): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state) return null
  if (!state.session_ids.includes(sessionId)) {
    state.session_ids.push(sessionId)
  }
  state.updatedAt = Date.now()
  writeBoulderState(directory, state)
  return state
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/autopilot/boulderState.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/autopilot/boulderState.ts src/services/autopilot/boulderState.test.ts
git commit -m "feat(autopilot): add Boulder State persistence with atomic writes"
```

---

### Task 4: Continuation Enforcement

**Files:**
- Create: `src/services/autopilot/continuationEnforcement.ts`
- Test: `src/services/autopilot/continuationEnforcement.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/autopilot/continuationEnforcement.test.ts
import { describe, test, expect } from "bun:test"
import { detectCompletionSignals, continuationSystemPromptAddition } from "./continuationEnforcement"

describe("ContinuationEnforcement", () => {
  test("detects explicit completion claim", () => {
    const result = detectCompletionSignals("All tasks are complete and tests pass.")
    expect(result.claimed).toBe(true)
    expect(result.confidence).toBe("high")
  })

  test("does not trigger on partial progress", () => {
    const result = detectCompletionSignals("I've completed step 1, moving on to step 2.")
    expect(result.claimed).toBe(false)
  })

  test("system prompt addition contains NEVER STOPS", () => {
    expect(continuationSystemPromptAddition).toContain("NEVER STOPS")
  })

  test("detects uncertain completion", () => {
    const result = detectCompletionSignals("I think this might be done?")
    expect(result.confidence).toBe("low")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/autopilot/continuationEnforcement.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/autopilot/continuationEnforcement.ts
interface CompletionSignalResult {
  claimed: boolean
  confidence: "high" | "medium" | "low"
  reason: string
}

const HIGH_CONFIDENCE_PATTERNS = [
  /all\s+tasks?\s+(are|is)\s+complete/i,
  /everything\s+(is\s+)?done/i,
  /implementation\s+(is\s+)?complete/i,
  /all\s+tests?\s+pass/i,
]

const UNCERTAIN_PATTERNS = [
  /might\s+be\s+done/i,
  /think\s+(this\s+)?is\s+(done|complete)/i,
  /seems\s+(like\s+)?(done|complete)/i,
]

export function detectCompletionSignals(response: string): CompletionSignalResult {
  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    if (pattern.test(response)) {
      return { claimed: true, confidence: "high", reason: response.match(pattern)![0] }
    }
  }
  for (const pattern of UNCERTAIN_PATTERNS) {
    if (pattern.test(response)) {
      return { claimed: true, confidence: "low", reason: response.match(pattern)![0] }
    }
  }
  return { claimed: false, confidence: "low", reason: "" }
}

export const continuationSystemPromptAddition = `
## Continuation Enforcement

THE BOULDER NEVER STOPS. You must continue working until ALL tasks are complete,
ALL tests pass, and the implementation is verified. Do not stop prematurely.

If you encounter errors, fix them. If tests fail, investigate and repair.
Only signal completion when everything is truly done.
`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/autopilot/continuationEnforcement.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/autopilot/continuationEnforcement.ts src/services/autopilot/continuationEnforcement.test.ts
git commit -m "feat(autopilot): add continuation enforcement with completion signal detection"
```

---

### Task 5: Dynamic Workflow Engine

**Files:**
- Create: `src/services/workflows/workflowEngine.ts`
- Create: `src/services/workflows/workflowTool.ts`
- Test: `src/services/workflows/workflowEngine.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/workflows/workflowEngine.test.ts
import { describe, test, expect } from "bun:test"
import { parseWorkflowFile, executeWorkflowStep } from "./workflowEngine"

describe("WorkflowEngine", () => {
  test("parses YAML frontmatter + markdown body", () => {
    const content = `---
name: deploy
description: "Deploy pipeline"
permissions:
  bash: "allow"
  file_edit: "ask"
---
# Deploy Pipeline

## Step 1: Build
Run \`npm run build\`.

## Step 2: Test
Run \`npm test\`.
`
    const result = parseWorkflowFile(content)
    expect(result.name).toBe("deploy")
    expect(result.permissions.bash).toBe("allow")
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].title).toBe("Build")
    expect(result.steps[1].title).toBe("Test")
  })

  test("handles [requires approval] marker", () => {
    const content = `---
name: deploy
---
## Step 1: Deploy
[requires approval]
Deploy to production.
`
    const result = parseWorkflowFile(content)
    expect(result.steps[0].requiresApproval).toBe(true)
  })

  test("handles depends_on in frontmatter", () => {
    const content = `---
name: deploy
steps:
  - id: 1
    title: Build
  - id: 2
    title: Test
    depends_on: [1]
---
## Step 1: Build
Build it.
## Step 2: Test
Test it.
`
    const result = parseWorkflowFile(content)
    expect(result.steps[1].dependsOn).toEqual([1])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/workflows/workflowEngine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/workflows/workflowEngine.ts
interface WorkflowStep {
  id: number
  title: string
  body: string
  requiresApproval: boolean
  dependsOn: number[]
}

interface AutopilotWorkflowDefinition {
  name: string
  description?: string
  permissions: Record<string, "allow" | "ask" | "deny">
  steps: WorkflowStep[]
}

export function parseWorkflowFile(content: string): AutopilotWorkflowDefinition {
  // Split YAML frontmatter from body
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error("Invalid workflow format: missing YAML frontmatter")

  const [, yamlStr, body] = match
  const frontmatter = parseSimpleYaml(yamlStr)

  // Parse steps from markdown
  const stepRegex = /## Step (\d+): (.+?)\n([\s\S]*?)(?=## Step \d+:|$)/g
  const steps: WorkflowStep[] = []
  let m
  while ((m = stepRegex.exec(body)) !== null) {
    const stepBody = m[3].trim()
    const yamlStep = (frontmatter.steps || []).find(
      (s: { id: number }) => s.id === parseInt(m[1]),
    )
    steps.push({
      id: parseInt(m[1]),
      title: m[2].trim(),
      body: stepBody.replace(/\[requires approval\]\n?/g, "").trim(),
      requiresApproval: /\[requires approval\]/i.test(stepBody),
      dependsOn: yamlStep?.depends_on || (steps.length > 0 ? [steps[steps.length - 1].id] : []),
    })
  }

  return {
    name: frontmatter.name || "unnamed",
    description: frontmatter.description,
    permissions: frontmatter.permissions || {},
    steps,
  }
}

function parseSimpleYaml(str: string): Record<string, unknown> {
  // Minimal YAML parser for flat key-value and nested objects
  const result: Record<string, unknown> = {}
  const lines = str.split("\n")
  let currentKey = ""
  let currentObj: Record<string, unknown> = result

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/)
    if (kvMatch) {
      const [, key, value] = kvMatch
      if (value === "") {
        currentKey = key
        currentObj[key] = {}
        currentObj = currentObj[key] as Record<string, unknown>
      } else if (value.startsWith('"') || value.startsWith("'")) {
        currentObj[key] = value.slice(1, -1)
      } else if (value === "true" || value === "false") {
        currentObj[key] = value === "true"
      } else if (!isNaN(Number(value))) {
        currentObj[key] = Number(value)
      } else {
        currentObj[key] = value
      }
    } else {
      // Reset to root for nested sections
      currentObj = result
    }
  }
  return result
}

export async function executeWorkflowStep(
  step: WorkflowStep,
  _directory: string,
): Promise<{ success: boolean; output: string }> {
  // Placeholder — actual execution dispatches to LLM
  return { success: true, output: `Executed step ${step.id}: ${step.title}` }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/workflows/workflowEngine.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/workflows/workflowEngine.ts src/services/workflows/workflowEngine.test.ts
git commit -m "feat(workflows): add Markdown/YAML workflow parser and step engine"
```

---

### Task 6: Run Record Persistence

**Files:**
- Create: `src/services/workflows/runRecord.ts`
- Test: `src/services/workflows/runRecord.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/workflows/runRecord.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createRunRecord, updateRunRecord, getRunRecord, listRunRecords } from "./runRecord"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

const TEST_DIR = join(import.meta.dir, "__test_runs")

describe("RunRecord", () => {
  beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })

  test("createRunRecord returns initial record", () => {
    const record = createRunRecord(TEST_DIR, "deploy", { env: "prod" })
    expect(record.workflowName).toBe("deploy")
    expect(record.status).toBe("running")
    expect(record.variables.env).toBe("prod")
    expect(record.steps).toHaveLength(0)
  })

  test("updateRunRecord appends step result", () => {
    const record = createRunRecord(TEST_DIR, "deploy", {})
    updateRunRecord(TEST_DIR, record.id, { stepId: 1, status: "complete", output: "ok" })
    const updated = getRunRecord(TEST_DIR, record.id)
    expect(updated!.steps).toHaveLength(1)
    expect(updated!.steps[0].status).toBe("complete")
  })

  test("listRunRecords returns all records", () => {
    createRunRecord(TEST_DIR, "a", {})
    createRunRecord(TEST_DIR, "b", {})
    const list = listRunRecords(TEST_DIR)
    expect(list).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/workflows/runRecord.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/workflows/runRecord.ts
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"

interface StepResult {
  stepId: number
  status: "complete" | "failed" | "skipped"
  output: string
  timestamp: number
}

interface RunRecord {
  id: string
  workflowName: string
  status: "running" | "complete" | "failed" | "cancelled"
  variables: Record<string, string>
  steps: StepResult[]
  createdAt: number
  updatedAt: number
}

function getRunsDir(baseDir: string): string {
  return join(baseDir, ".claude", "workflow-runs")
}

function getRecordPath(baseDir: string, id: string): string {
  return join(getRunsDir(baseDir), `${id}.json`)
}

export function createRunRecord(
  baseDir: string,
  workflowName: string,
  variables: Record<string, string>,
): RunRecord {
  const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const record: RunRecord = {
    id,
    workflowName,
    status: "running",
    variables,
    steps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const dir = getRunsDir(baseDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(getRecordPath(baseDir, id), JSON.stringify(record, null, 2))
  return record
}

export function updateRunRecord(
  baseDir: string,
  id: string,
  step: { stepId: number; status: StepResult["status"]; output: string },
): void {
  const record = getRunRecord(baseDir, id)
  if (!record) return
  record.steps.push({ ...step, timestamp: Date.now() })
  record.updatedAt = Date.now()
  writeFileSync(getRecordPath(baseDir, id), JSON.stringify(record, null, 2))
}

export function getRunRecord(baseDir: string, id: string): RunRecord | null {
  const path = getRecordPath(baseDir, id)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf-8"))
}

export function listRunRecords(baseDir: string): RunRecord[] {
  const dir = getRunsDir(baseDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")))
    .sort((a, b) => b.createdAt - a.createdAt)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/workflows/runRecord.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/workflows/runRecord.ts src/services/workflows/runRecord.test.ts
git commit -m "feat(workflows): add Run Record JSONL persistence"
```

---

### Task 7: Error Recovery & Migration

**Files:**
- Create: `src/services/workflows/errorRecovery.ts`
- Create: `src/services/workflows/migration.ts`
- Test: `src/services/workflows/errorRecovery.test.ts`
- Test: `src/services/workflows/migration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/workflows/errorRecovery.test.ts
import { describe, test, expect } from "bun:test"
import { classifyError, shouldRetry, getRetryDelay } from "./errorRecovery"

describe("ErrorRecovery", () => {
  test("classifies network errors as retryable", () => {
    expect(classifyError(new Error("ECONNRESET"))).toBe("retryable")
    expect(classifyError(new Error("ETIMEDOUT"))).toBe("retryable")
  })

  test("classifies auth errors as fatal", () => {
    expect(classifyError(new Error("401 Unauthorized"))).toBe("fatal")
  })

  test("shouldRetry respects maxRetries", () => {
    expect(shouldRetry("retryable", 0, 3)).toBe(true)
    expect(shouldRetry("retryable", 3, 3)).toBe(false)
  })

  test("getRetryDelay uses exponential backoff", () => {
    expect(getRetryDelay(0)).toBe(1000)
    expect(getRetryDelay(1)).toBe(2000)
    expect(getRetryDelay(2)).toBe(4000)
  })
})
```

- [ ] **Step 1.5: Write migration test**

```typescript
// src/services/workflows/migration.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { convertDagToWorkflow } from "./migration"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"

const TEST_DIR = join(import.meta.dir, "__test_migration")

describe("Migration", () => {
  beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })

  test("convertDagToWorkflow produces valid workflow markdown", () => {
    const dag = {
      name: "test-dag",
      nodes: [
        { id: "a", task: "Build", dependencies: [] },
        { id: "b", task: "Test", dependencies: ["a"] },
        { id: "c", task: "Deploy", dependencies: ["b"] },
      ],
    }
    const dagPath = join(TEST_DIR, "test.json")
    writeFileSync(dagPath, JSON.stringify(dag))
    const result = convertDagToWorkflow(dagPath)
    expect(result).toContain("name: test-dag")
    expect(result).toContain("## Step 1: Build")
    expect(result).toContain("## Step 2: Test")
    expect(result).toContain("## Step 3: Deploy")
    expect(result).toContain("depends_on: [1]")
  })

  test("convertDagToWorkflow throws on missing file", () => {
    expect(() => convertDagToWorkflow("/nonexistent.json")).toThrow("not found")
  })

  test("topological sort handles diamond dependency", () => {
    const dag = {
      name: "diamond",
      nodes: [
        { id: "a", task: "A", dependencies: [] },
        { id: "b", task: "B", dependencies: ["a"] },
        { id: "c", task: "C", dependencies: ["a"] },
        { id: "d", task: "D", dependencies: ["b", "c"] },
      ],
    }
    const dagPath = join(TEST_DIR, "diamond.json")
    writeFileSync(dagPath, JSON.stringify(dag))
    const result = convertDagToWorkflow(dagPath)
    // A must come before B and C; D must come after both
    const step1 = result.indexOf("## Step 1: A")
    const step4 = result.indexOf("## Step 4: D")
    expect(step1).toBeLessThan(step4)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/workflows/errorRecovery.test.ts src/services/workflows/migration.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/workflows/errorRecovery.ts
type ErrorClass = "retryable" | "fatal" | "transient"

const RETRYABLE_PATTERNS = [/ECONNRESET/i, /ETIMEDOUT/i, /ECONNREFUSED/i, /503/, /429/]
const FATAL_PATTERNS = [/401/i, /403/i, /invalid_api_key/i]

export function classifyError(error: Error): ErrorClass {
  const msg = error.message
  for (const p of FATAL_PATTERNS) if (p.test(msg)) return "fatal"
  for (const p of RETRYABLE_PATTERNS) if (p.test(msg)) return "retryable"
  return "transient"
}

export function shouldRetry(errorClass: ErrorClass, attempt: number, maxRetries: number): boolean {
  if (errorClass === "fatal") return false
  return attempt < maxRetries
}

export function getRetryDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30000)
}
```

```typescript
// src/services/workflows/migration.ts
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs"
import { join, basename } from "path"

interface DagNode {
  id: string
  task: string
  dependencies: string[]
}

interface DagDefinition {
  name: string
  nodes: DagNode[]
}

/**
 * Parse a legacy DAG JSON file and convert to workflow Markdown format.
 * Legacy DAG format: { name, nodes: [{ id, task, dependencies }] }
 * Output: Markdown with YAML frontmatter + sequential steps.
 */
export function convertDagToWorkflow(dagPath: string): string {
  if (!existsSync(dagPath)) {
    throw new Error(`DAG file not found: ${dagPath}`)
  }
  const raw = readFileSync(dagPath, "utf-8")
  const dag: DagDefinition = JSON.parse(raw)

  // Topological sort to determine step order
  const sorted = topologicalSort(dag.nodes)

  // Build workflow markdown
  const stepsYaml = sorted
    .map((node, i) => {
      const deps = node.dependencies.length > 0
        ? `    depends_on: [${node.dependencies.map(d => sorted.findIndex(n => n.id === d) + 1).filter(x => x > 0).join(", ")}]`
        : ""
      return `  - id: ${i + 1}\n    title: ${node.task}${deps ? "\n" + deps : ""}`
    })
    .join("\n")

  const stepsMd = sorted
    .map((node, i) => `## Step ${i + 1}: ${node.task}\n${node.task}`)
    .join("\n\n")

  return `---
name: ${dag.name ?? basename(dagPath, ".json")}
steps:
${stepsYaml}
---
# ${dag.name ?? "Migrated Workflow"}

${stepsMd}
`
}

function topologicalSort(nodes: DagNode[]): DagNode[] {
  const visited = new Set<string>()
  const result: DagNode[] = []
  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  function visit(id: string) {
    if (visited.has(id)) return
    visited.add(id)
    const node = nodeMap.get(id)
    if (!node) return
    for (const dep of node.dependencies) {
      visit(dep)
    }
    result.push(node)
  }

  for (const node of nodes) {
    visit(node.id)
  }
  return result
}

/**
 * Batch-convert all DAG files in a directory to workflow scripts.
 */
export function migrateDagDirectory(dagDir: string, outputDir: string): string[] {
  if (!existsSync(dagDir)) return []
  const files = readdirSync(dagDir).filter(f => f.endsWith(".json"))
  const converted: string[] = []
  for (const file of files) {
    try {
      const content = convertDagToWorkflow(join(dagDir, file))
      const outName = file.replace(/\.json$/, ".workflow.md")
      const outPath = join(outputDir, outName)
      writeFileSync(outPath, content)
      converted.push(outPath)
    } catch {
      // Skip invalid DAG files
    }
  }
  return converted
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/workflows/errorRecovery.test.ts src/services/workflows/migration.test.ts`
Expected: PASS (7 tests: 4 errorRecovery + 3 migration)

- [ ] **Step 5: Commit**

```bash
git add src/services/workflows/errorRecovery.ts src/services/workflows/errorRecovery.test.ts src/services/workflows/migration.ts
git commit -m "feat(workflows): add error recovery with exponential backoff and DAG migration"
```

---

### Task 8: Feature Flags & Command Registration

**Files:**
- Modify: `scripts/build.ts` — add AUTOPILOT_PIPELINE, BOULDER_STATE, CONTINUATION_ENFORCEMENT, WORKFLOW_SCRIPTS to fullExperimentalFeatures
- Create: `src/commands/autopilot/index.ts` — /autopilot PromptCommand
- Modify: `src/commands/workflows/index.ts` — /workflow PromptCommand (replace placeholder)
- Skip: `src/commands.ts` — /workflows already registered
- Skip: `src/tools.ts` — WorkflowTool already registered

- [ ] **Step 1: Add feature flags to build.ts**

```typescript
// In scripts/build.ts, add to fullExperimentalFeatures array (around line 14):
const fullExperimentalFeatures = [
  // ... existing entries ...
  "AUTOPILOT_PIPELINE",
  "BOULDER_STATE",
  "CONTINUATION_ENFORCEMENT",
  "WORKFLOW_SCRIPTS",
  // ... existing entries ...
]
```

- [ ] **Step 2: Create /autopilot command**

ola-cc 的 Command 类型是 `CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)`。`/autopilot` 需要将用户输入的 idea 注入 prompt 让主 agent 执行 pipeline，因此使用 PromptCommand 模式（参考 `/compact`、`/workflows` 等现有命令）。

```typescript
// src/commands/autopilot/index.ts
import type { Command } from "../../commands.js"
import { feature } from "bun:bundle"

const autopilot = {
  type: "prompt",
  name: "autopilot",
  description: "Start or manage the autopilot pipeline (4-stage: ralplan -> execution -> ralph -> qa)",
  contentLength: 0,
  source: "builtin" as const,
  isEnabled: () => feature("AUTOPILOT_PIPELINE"),
  progressMessage: "initializing autopilot pipeline",
  argumentHint: "<idea description>",
  async getPromptForCommand(args: string): Promise<import("@anthropic-ai/sdk/resources/index.mjs").ContentBlockParam[]> {
    const idea = args.trim()
    if (!idea) {
      return [{ type: "text", text: "Usage: /autopilot <idea description>\nProvide a description of what you want to build." }]
    }
    const { initPipeline } = await import("../../services/autopilot/pipeline")
    const { ALL_ADAPTERS } = await import("../../services/autopilot/adapters/index")
    const state = initPipeline(process.cwd(), idea, "current")
    if (!state) {
      return [{ type: "text", text: "Failed to initialize autopilot pipeline. All stages may be disabled." }]
    }
    // Build prompt from the active stage adapter
    const activeStage = state.stages.find(s => s.status === "active")
    const adapter = ALL_ADAPTERS.find(a => a.id === activeStage?.id)
    const stagePrompt = adapter?.getPrompt({ idea, directory: process.cwd() }) ?? ""
    return [{
      type: "text",
      text: `# Autopilot Pipeline Started\n\nIdea: ${idea}\n\nActive stage: ${activeStage?.id ?? "none"}\n\n${stagePrompt}\n\n## Continuation Enforcement\nTHE BOULDER NEVER STOPS. You must continue working until ALL tasks are complete, ALL tests pass, and the implementation is verified. Do not stop prematurely.\n\nWhen a stage is complete, output its completion signal (e.g. PIPELINE_RALPLAN_COMPLETE) and I will advance to the next stage.`,
    }]
  },
} satisfies Command

export default autopilot
```

- [ ] **Step 3: Create /workflow command**

注意：`src/commands/workflows/index.ts` 已存在一个占位实现。此处更新其内容为完整的 PromptCommand，而非创建新文件。

```typescript
// src/commands/workflows/index.ts — 替换现有占位实现
import type { Command } from "../../commands.js"
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/index.mjs"

const workflows = {
  type: "prompt",
  name: "workflows",
  description: "Manage dynamic workflows (start, list, status, cancel)",
  contentLength: 0,
  source: "builtin" as const,
  isEnabled: () => true,
  progressMessage: "loading workflow engine",
  argumentHint: "<start|list|status|cancel> [args]",
  async getPromptForCommand(args: string): Promise<ContentBlockParam[]> {
    const [subcommand, ...rest] = args.trim().split(/\s+/)
    switch (subcommand) {
      case "start": {
        const workflowPath = rest[0]
        if (!workflowPath) {
          return [{ type: "text", text: "Usage: /workflow start <path-to-workflow.md>\nProvide a path to a workflow definition file." }]
        }
        const { parseWorkflowFile } = await import("../../services/workflows/workflowEngine")
        const { createRunRecord } = await import("../../services/workflows/runRecord")
        const { readFileSync, existsSync } = await import("fs")
        if (!existsSync(workflowPath)) {
          return [{ type: "text", text: `Workflow file not found: ${workflowPath}` }]
        }
        const content = readFileSync(workflowPath, "utf-8")
        const def = parseWorkflowFile(content)
        const record = createRunRecord(process.cwd(), def.name, {})
        return [{
          type: "text",
          text: `# Workflow: ${def.name}\n\n${def.description ?? ""}\n\nRun ID: ${record.id}\n\n## Steps\n${def.steps.map((s, i) => `${i + 1}. **${s.title}**${s.requiresApproval ? " [requires approval]" : ""}${s.dependsOn.length > 0 ? ` (depends on: ${s.dependsOn.join(", ")})` : ""}\n${s.body}`).join("\n\n")}\n\nExecute each step in order. For steps with [requires approval], pause and ask for user confirmation before proceeding.`,
        }]
      }
      case "list": {
        const { listRunRecords } = await import("../../services/workflows/runRecord")
        const records = listRunRecords(process.cwd())
        if (records.length === 0) {
          return [{ type: "text", text: "No workflow runs found." }]
        }
        return [{
          type: "text",
          text: `# Workflow Runs\n\n${records.map(r => `- **${r.workflowName}** (${r.id}): ${r.status} — ${r.steps.length} steps`).join("\n")}`,
        }]
      }
      case "status": {
        const runId = rest[0]
        if (!runId) {
          return [{ type: "text", text: "Usage: /workflow status <run-id>" }]
        }
        const { getRunRecord } = await import("../../services/workflows/runRecord")
        const record = getRunRecord(process.cwd(), runId)
        if (!record) {
          return [{ type: "text", text: `Run not found: ${runId}` }]
        }
        return [{
          type: "text",
          text: `# Workflow Status: ${record.workflowName}\n\nRun ID: ${record.id}\nStatus: ${record.status}\n\n## Steps\n${record.steps.map(s => `- Step ${s.stepId}: ${s.status} — ${s.output}`).join("\n")}`,
        }]
      }
      default:
        return [{ type: "text", text: "Usage: /workflow <start|list|status|cancel> [args]\n\nSubcommands:\n- start <path> — Start a workflow from a .md file\n- list — List all workflow runs\n- status <run-id> — Show status of a run\n- cancel <run-id> — Cancel a running workflow" }]
    }
  },
} satisfies Command

export default workflows
```

- [ ] **Step 4: Run tests for all autopilot + workflow modules**

Run: `bun test src/services/autopilot/ src/services/workflows/`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/build.ts src/commands/autopilot/index.ts src/commands/workflows/index.ts
git commit -m "feat(autopilot-workflows): add feature flags, /autopilot command, and /workflow command"
```

---

## Verification Checklist

After completing all tasks, verify:

1. `bun test src/services/autopilot/` — all autopilot tests pass
2. `bun test src/services/workflows/` — all workflow tests pass
3. `bun run build:dev` — builds successfully with flags disabled
4. Feature flags are registered in build.ts
5. Commands are registered in commands.ts
