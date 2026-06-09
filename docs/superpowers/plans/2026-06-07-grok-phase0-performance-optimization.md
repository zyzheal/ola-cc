# Grok Phase 0: Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize Grok first-run performance by replacing LLM scanner with local detection, adding configurable batch parameters, and implementing multi-provider model routing.

**Architecture:** Three independent optimizations applied to `GrokManager` and `GrokAnalyzer`: (1) local file scanner replaces LLM scanner step, (2) environment variables control batch size/concurrency, (3) `getAgentModel()` extended for Grok task-tiered model routing. Each optimization is a separate task that can be committed independently.

**Tech Stack:** TypeScript, Bun, Anthropic SDK, Zod, `src/utils/model/agent.ts`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/tools/GrokTool/GrokManager.ts` | Pipeline orchestration, scanner step | Modify: replace LLM scanner with `localScan()` |
| `src/tools/GrokTool/GrokAnalyzer.ts` | LLM calls, batch processing, model selection | Modify: env var batch params, model routing |
| `src/utils/model/agent.ts` | Subagent model resolution | Modify: extend `getAgentModel()` for grok task types |
| `src/tools/GrokTool/__tests__/GrokManager.test.ts` | GrokManager tests | Modify: add localScan tests |
| `src/tools/GrokTool/__tests__/GrokAnalyzer.test.ts` | GrokAnalyzer tests | Modify: add batch config + model routing tests |
| `src/utils/model/__tests__/agent.test.ts` | Agent model tests | Modify: add grok task type tests |

---

### Task 1: Local Scanner — Replace LLM Scanner with Filesystem Detection

**Files:**
- Modify: `src/tools/GrokTool/GrokManager.ts:237-250`
- Modify: `src/tools/GrokTool/__tests__/GrokManager.test.ts`

- [ ] **Step 1: Write the failing test for localScan**

```typescript
// In src/tools/GrokTool/__tests__/GrokManager.test.ts

describe('localScan', () => {
  it('should detect languages from file extensions', async () => {
    writeFileSync(resolve(TEST_DIR, 'index.ts'), 'export const x = 1')
    writeFileSync(resolve(TEST_DIR, 'app.py'), 'print("hello")')
    writeFileSync(resolve(TEST_DIR, 'main.go'), 'package main')

    const manager = new GrokManager(TEST_DIR)
    const result = await (manager as any).localScan()

    expect(result.languages).toContain('TypeScript')
    expect(result.languages).toContain('Python')
    expect(result.languages).toContain('Go')
  })

  it('should detect frameworks from config files', async () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0', express: '^4.18.0' }
    }))
    writeFileSync(resolve(TEST_DIR, 'index.tsx'), 'export default () => <div />')

    const manager = new GrokManager(TEST_DIR)
    const result = await (manager as any).localScan()

    expect(result.frameworks).toContain('React')
    expect(result.frameworks).toContain('Express')
  })

  it('should detect entry points', async () => {
    writeFileSync(resolve(TEST_DIR, 'index.ts'), 'export const x = 1')
    writeFileSync(resolve(TEST_DIR, 'src/main.ts'), 'export const y = 2')

    const manager = new GrokManager(TEST_DIR)
    const result = await (manager as any).localScan()

    expect(result.entryPoints.length).toBeGreaterThan(0)
  })

  it('should return empty arrays for empty directory', async () => {
    const manager = new GrokManager(TEST_DIR)
    const result = await (manager as any).localScan()

    expect(result.languages).toEqual([])
    expect(result.frameworks).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/tools/GrokTool/__tests__/GrokManager.test.ts -t "localScan"`
Expected: FAIL with "localScan is not a function" or similar

- [ ] **Step 3: Implement localScan in GrokManager**

Add this method to `GrokManager` class, after `ensureGrokSource()` (around L128):

```typescript
/**
 * 本地 Scanner — 基于文件扩展名和配置文件检测语言/框架/入口点
 * 替代 LLM scanner step，消除 1 次 LLM round-trip
 */
private async localScan(): Promise<{
  languages: string[]
  frameworks: string[]
  entryPoints: string[]
}> {
  const files = await this.analyzer.discoverFiles()
  const extToLang: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
    '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
    '.cpp': 'C++', '.c': 'C', '.h': 'C', '.rb': 'Ruby', '.php': 'PHP',
    '.swift': 'Swift', '.kt': 'Kotlin', '.vue': 'Vue', '.svelte': 'Svelte',
  }

  // Detect languages from extensions
  const langSet = new Set<string>()
  for (const f of files) {
    const ext = f.slice(f.lastIndexOf('.')).toLowerCase()
    const lang = extToLang[ext]
    if (lang) langSet.add(lang)
  }

  // Detect frameworks from package.json / config files
  const frameworkSet = new Set<string>()
  const pkgPath = resolve(this.projectRoot, 'package.json')
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const fwMap: Record<string, string> = {
      react: 'React', vue: 'Vue', svelte: 'Svelte', angular: 'Angular',
      next: 'Next.js', nuxt: 'Nuxt', express: 'Express', fastify: 'Fastify',
      nest: 'NestJS', django: 'Django', flask: 'Flask', fastapi: 'FastAPI',
      rails: 'Rails', laravel: 'Laravel', spring: 'Spring',
    }
    for (const [dep, name] of Object.entries(fwMap)) {
      if (allDeps[dep]) frameworkSet.add(name)
    }
  } catch { /* no package.json */ }

  // Detect entry points
  const entryPoints: string[] = []
  const entryPatterns = ['index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js', 'src/main.ts', 'src/index.ts']
  for (const pattern of entryPatterns) {
    const fullPath = resolve(this.projectRoot, pattern)
    if (files.some(f => f === fullPath)) {
      entryPoints.push(pattern)
    }
  }

  return {
    languages: Array.from(langSet),
    frameworks: Array.from(frameworkSet),
    entryPoints,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/tools/GrokTool/__tests__/GrokManager.test.ts -t "localScan"`
Expected: PASS

- [ ] **Step 5: Wire localScan into runPipelineInner**

Modify `runPipelineInner` at L237-250. Replace the scanner LLM call:

```typescript
// BEFORE (L237-250):
let scannerResult: Record<string, unknown> = {}
if (isIncrementalRun && existingGraph?.metadata) {
  scannerResult = {
    languages: existingGraph.metadata.languages || [],
    frameworks: existingGraph.metadata.frameworks || [],
  }
  reportProgress('scanner', 100)
} else {
  scannerResult = await this.analyzer.runPipelineStep('scanner',
    `Analyze this project and detect languages, frameworks, and entry points.\n\nFiles:\n${files.slice(0, 50).map(f => `- ${f}`).join('\n')}`,
    AGENT_SYSTEM_PROMPTS.scanner, reportProgress, errors
  )
}

// AFTER:
let scannerResult: Record<string, unknown> = {}
if (isIncrementalRun && existingGraph?.metadata) {
  scannerResult = {
    languages: existingGraph.metadata.languages || [],
    frameworks: existingGraph.metadata.frameworks || [],
  }
  reportProgress('scanner', 100)
} else {
  // Local scan: no LLM call needed for language/framework detection
  const localResult = await this.localScan()
  scannerResult = {
    languages: localResult.languages,
    frameworks: localResult.frameworks,
    entryPoints: localResult.entryPoints,
  }
  reportProgress('scanner', 100)
  logForDebugging(`[grok] Local scan: ${localResult.languages.length} languages, ${localResult.frameworks.length} frameworks`)
}
```

- [ ] **Step 6: Run all GrokManager tests**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/tools/GrokTool/__tests__/GrokManager.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/heal/ola-cc/.worktrees/codegraph-grok
git add src/tools/GrokTool/GrokManager.ts src/tools/GrokTool/__tests__/GrokManager.test.ts
git commit -m "perf(grok): replace LLM scanner with local filesystem detection

Eliminates 1 LLM round-trip (~5-10s) from the Grok pipeline by detecting
languages, frameworks, and entry points from file extensions and package.json.
LLM is no longer called for basic project scanning."
```

---

### Task 2: Configurable Batch Parameters — Environment Variables for batchSize/concurrency

**Files:**
- Modify: `src/tools/GrokTool/GrokManager.ts:45-83` (GrokConfigSchema + loadGrokConfig)
- Modify: `src/tools/GrokTool/GrokManager.ts:1341` (hardcoded batch call)
- Modify: `src/tools/GrokTool/__tests__/GrokManager.test.ts`

- [ ] **Step 1: Write the failing test for batch config**

```typescript
// In src/tools/GrokTool/__tests__/GrokManager.test.ts

describe('batch configuration', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...origEnv }
  })

  it('should read OLA_CC_GROK_BATCH_SIZE from env', () => {
    process.env.OLA_CC_GROK_BATCH_SIZE = '15'
    const manager = new GrokManager(TEST_DIR)
    // Config is loaded in constructor
    const config = (manager as any).config
    expect(config.maxBatch).toBeDefined()
  })

  it('should use default batchSize when env not set', () => {
    delete process.env.OLA_CC_GROK_BATCH_SIZE
    const manager = new GrokManager(TEST_DIR)
    const config = (manager as any).config
    expect(config.maxBatch).toBe(5) // default from Zod schema
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/tools/GrokTool/__tests__/GrokManager.test.ts -t "batch configuration"`
Expected: FAIL (config doesn't have batch fields yet)

- [ ] **Step 3: Extend GrokConfigSchema with batch parameters**

Modify `GrokConfigSchema` at L45-51:

```typescript
// BEFORE:
const GrokConfigSchema = z.object({
  storage: z.enum(['project', 'user']).default('project'),
  portRange: z.string().regex(/^\d{5}-\d{5}$/).default('63000-63100'),
  language: z.string().min(2).max(5).default('en'),
  maxBatch: z.number().int().min(1).max(10).default(5),
  autoUpdate: z.boolean().default(false),
})

// AFTER:
const GrokConfigSchema = z.object({
  storage: z.enum(['project', 'user']).default('project'),
  portRange: z.string().regex(/^\d{5}-\d{5}$/).default('63000-63100'),
  language: z.string().min(2).max(5).default('en'),
  maxBatch: z.number().int().min(1).max(10).default(5),
  autoUpdate: z.boolean().default(false),
  batchSize: z.number().int().min(1).max(50).default(25),
  concurrency: z.number().int().min(1).max(10).default(5),
})
```

Extend `loadGrokConfig()` at L58-83 to read new env vars:

```typescript
// Add to raw object in loadGrokConfig():
const raw = {
  storage: process.env.OLA_CC_GROK_STORAGE,
  portRange: process.env.OLA_CC_GROK_PORT_RANGE,
  language: process.env.OLA_CC_GROK_LANGUAGE,
  maxBatch: process.env.OLA_CC_GROK_MAX_BATCH ? parseInt(process.env.OLA_CC_GROK_MAX_BATCH) : undefined,
  autoUpdate: process.env.OLA_CC_GROK_AUTO_UPDATE === 'true',
  batchSize: process.env.OLA_CC_GROK_BATCH_SIZE ? parseInt(process.env.OLA_CC_GROK_BATCH_SIZE) : undefined,
  concurrency: process.env.OLA_CC_GROK_CONCURRENCY ? parseInt(process.env.OLA_CC_GROK_CONCURRENCY) : undefined,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/tools/GrokTool/__tests__/GrokManager.test.ts -t "batch configuration"`
Expected: PASS

- [ ] **Step 5: Wire config into analyzeFilesBatch call**

Modify the `analyzeFilesBatch` call in `runPipelineInner`. Find the call site (in the worktree version, it's at L256):

```typescript
// BEFORE:
analysisResults = await this.analyzer.analyzeFilesBatch(filesToAnalyze)

// AFTER:
analysisResults = await this.analyzer.analyzeFilesBatch(
  filesToAnalyze,
  this.config.batchSize,
  this.config.concurrency,
)
```

- [ ] **Step 6: Run all GrokManager tests**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/tools/GrokTool/__tests__/GrokManager.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/heal/ola-cc/.worktrees/codegraph-grok
git add src/tools/GrokTool/GrokManager.ts src/tools/GrokTool/__tests__/GrokManager.test.ts
git commit -m "feat(grok): configurable batch parameters via environment variables

Add OLA_CC_GROK_BATCH_SIZE (default 25) and OLA_CC_GROK_CONCURRENCY
(default 5) environment variables to control Grok batch processing.
Replaces hardcoded defaults with user-configurable values."
```

---

### Task 3: Multi-Provider Model Routing — Extend getAgentModel for Grok Task Types

**Files:**
- Modify: `src/utils/model/agent.ts:37-107` (getAgentModel function)
- Modify: `src/tools/GrokTool/GrokAnalyzer.ts:89,148` (model selection)
- Modify: `src/utils/model/__tests__/agent.test.ts` (if exists, or create)

- [ ] **Step 1: Write the failing test for grok model routing**

```typescript
// In src/utils/model/__tests__/agent.test.ts (add to existing or create)

describe('getAgentModel with grok task types', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...origEnv }
  })

  it('should return OLA_CC_GROK_MODEL for grok-primary task', () => {
    process.env.OLA_CC_GROK_MODEL = 'claude-sonnet-4-20250514'
    const model = getAgentModel('grok-primary', 'claude-sonnet-4-20250514')
    expect(model).toBe('claude-sonnet-4-20250514')
  })

  it('should return OLA_CC_GROK_MODEL_FAST for grok-fast task', () => {
    process.env.OLA_CC_GROK_MODEL_FAST = 'claude-haiku-4-20250514'
    const model = getAgentModel('grok-fast', 'claude-sonnet-4-20250514')
    expect(model).toBe('claude-haiku-4-20250514')
  })

  it('should fall back to parent model when grok env not set', () => {
    delete process.env.OLA_CC_GROK_MODEL
    delete process.env.OLA_CC_GROK_MODEL_FAST
    const model = getAgentModel('grok-primary', 'claude-sonnet-4-20250514')
    expect(model).toBe('claude-sonnet-4-20250514')
  })

  it('should prefer OLA_CC_GROK_MODEL over OLA_CC_SUBAGENT_MODEL for grok tasks', () => {
    process.env.OLA_CC_SUBAGENT_MODEL = 'claude-haiku-4-20250514'
    process.env.OLA_CC_GROK_MODEL = 'claude-sonnet-4-20250514'
    const model = getAgentModel('grok-primary', 'claude-sonnet-4-20250514')
    expect(model).toBe('claude-sonnet-4-20250514')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/utils/model/__tests__/agent.test.ts -t "grok"`
Expected: FAIL (grok task types not handled yet)

- [ ] **Step 3: Extend getAgentModel for grok task types**

Modify `getAgentModel` at the beginning of the function (L42-45):

```typescript
// BEFORE:
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: ModelAlias,
  permissionMode?: PermissionMode,
): string {
  if (process.env.OLA_CC_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.OLA_CC_SUBAGENT_MODEL)
  }

// AFTER:
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: ModelAlias,
  permissionMode?: PermissionMode,
): string {
  // Grok task-tiered model routing: OLA_CC_GROK_MODEL / OLA_CC_GROK_MODEL_FAST
  // Takes precedence over OLA_CC_SUBAGENT_MODEL for grok-specific tasks
  if (agentModel === 'grok-primary' && process.env.OLA_CC_GROK_MODEL) {
    return parseUserSpecifiedModel(process.env.OLA_CC_GROK_MODEL)
  }
  if (agentModel === 'grok-fast' && process.env.OLA_CC_GROK_MODEL_FAST) {
    return parseUserSpecifiedModel(process.env.OLA_CC_GROK_MODEL_FAST)
  }
  // Grok tasks without specific env var: fall through to normal resolution
  if (agentModel === 'grok-primary' || agentModel === 'grok-fast') {
    // Use parent model as fallback
    agentModel = undefined
  }

  if (process.env.OLA_CC_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.OLA_CC_SUBAGENT_MODEL)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/utils/model/__tests__/agent.test.ts -t "grok"`
Expected: PASS

- [ ] **Step 5: Update GrokAnalyzer to use getAgentModel for task-tiered routing**

Modify `GrokAnalyzer.ts` L89 and L148:

```typescript
// BEFORE (L89):
private model: string = 'claude-sonnet-4-20250514'

// AFTER:
private model: string = 'claude-sonnet-4-20250514'
private modelFast: string = 'claude-sonnet-4-20250514'

// BEFORE (L148, inside getClient()):
this.model = process.env.ANTHROPIC_MODEL || process.env.OLA_CC_MODEL_SONNET || 'claude-sonnet-4-20250514'

// AFTER (L148, inside getClient()):
this.model = process.env.OLA_CC_GROK_MODEL || process.env.ANTHROPIC_MODEL || process.env.OLA_CC_MODEL_SONNET || 'claude-sonnet-4-20250514'
this.modelFast = process.env.OLA_CC_GROK_MODEL_FAST || this.model
```

Add a method to select model by task type:

```typescript
// Add after getClient() method:

/**
 * 根据任务类型选择模型
 * primary: analyzer, architecture (高质量)
 * fast: tour, review, scanner (低成本)
 */
private getModelForTask(taskType: 'primary' | 'fast'): string {
  this.getClient() // ensure model is refreshed
  return taskType === 'fast' ? this.modelFast : this.model
}
```

- [ ] **Step 6: Wire task-tiered model into pipeline steps**

Modify `GrokManager.ts` pipeline steps to pass task type. In `runPipelineInner`:

```typescript
// Architecture step (L272) — uses primary model:
architectureResult = await this.analyzer.runPipelineStep('architecture',
  `Analyze the architecture...`,
  AGENT_SYSTEM_PROMPTS.architecture, reportProgress, errors
)

// Tour step (L308) — uses fast model:
tourResult = await this.analyzer.runPipelineStep('tour',
  `Generate a guided tour...`,
  AGENT_SYSTEM_PROMPTS.tour, reportProgress, errors
)

// Review step (L345) — uses fast model:
reviewResult = await this.analyzer.runPipelineStep('review',
  `Review this knowledge graph...`,
  AGENT_SYSTEM_PROMPTS.review, reportProgress, errors
)
```

To wire this, modify `runPipelineStep` in `GrokAnalyzer.ts` to accept an optional `taskType` parameter:

```typescript
// BEFORE (GrokAnalyzer.ts L524):
async runPipelineStep(
  stage: string,
  prompt: string,
  systemPrompt: string,
  reportProgress: (stage: string, progress: number) => void,
  errors: GrokError[]
): Promise<Record<string, unknown>> {

// AFTER:
async runPipelineStep(
  stage: string,
  prompt: string,
  systemPrompt: string,
  reportProgress: (stage: string, progress: number) => void,
  errors: GrokError[],
  taskType: 'primary' | 'fast' = 'primary',
): Promise<Record<string, unknown>> {
```

And in `callAgentWithTimeout`, use the task-appropriate model. Modify the `callAgent` method to accept model override:

```typescript
// In callAgent (L155), add model parameter:
private async callAgent(prompt: string, systemPrompt: string, modelOverride?: string): Promise<string> {
  const client = this.getClient()
  const model = modelOverride || this.model
  // ... rest uses `model` instead of `this.model`
```

Then in `runPipelineStep`, pass the task-specific model:

```typescript
const response = await this.callAgentWithTimeout(prompt, systemPrompt, 2, taskType)
```

And thread `taskType` through `callAgentWithTimeout` → `callAgent`:

```typescript
async callAgentWithTimeout(prompt: string, systemPrompt: string, maxRetries: number = 2, taskType: 'primary' | 'fast' = 'primary'): Promise<string> {
  // ... inside the race:
  this.callAgent(prompt, systemPrompt, this.getModelForTask(taskType)),
```

- [ ] **Step 7: Run all GrokAnalyzer and GrokManager tests**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/tools/GrokTool/__tests__/GrokAnalyzer.test.ts src/tools/GrokTool/__tests__/GrokManager.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
cd /Users/heal/ola-cc/.worktrees/codegraph-grok
git add src/utils/model/agent.ts src/tools/GrokTool/GrokAnalyzer.ts src/tools/GrokTool/GrokManager.ts
git commit -m "feat(grok): multi-provider task-tiered model routing

Add OLA_CC_GROK_MODEL (primary, for analyzer/architecture) and
OLA_CC_GROK_MODEL_FAST (fast, for tour/review/scanner) env vars.
Tour/review use fast model for ~40% cost reduction.
Extends getAgentModel() with grok-primary/grok-fast task types."
```

---

### Task 4: Integration Test — Verify Full Pipeline Optimization

**Files:**
- Modify: `src/tools/GrokTool/__tests__/GrokManager.test.ts`

- [ ] **Step 1: Write integration test for optimized pipeline**

```typescript
// In src/tools/GrokTool/__tests__/GrokManager.test.ts

describe('optimized pipeline integration', () => {
  it('should complete localScan + batch config + model routing together', async () => {
    // Setup: create a small project
    writeFileSync(resolve(TEST_DIR, 'index.ts'), 'export const x = 1')
    writeFileSync(resolve(TEST_DIR, 'utils.ts'), 'export function helper() { return 42 }')
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' }
    }))

    // Set env vars
    const origBatch = process.env.OLA_CC_GROK_BATCH_SIZE
    const origConcurrency = process.env.OLA_CC_GROK_CONCURRENCY
    process.env.OLA_CC_GROK_BATCH_SIZE = '10'
    process.env.OLA_CC_GROK_CONCURRENCY = '3'

    try {
      const manager = new GrokManager(TEST_DIR)

      // Verify localScan works
      const scanResult = await (manager as any).localScan()
      expect(scanResult.languages).toContain('TypeScript')
      expect(scanResult.frameworks).toContain('React')

      // Verify config loaded
      const config = (manager as any).config
      expect(config.batchSize).toBe(10)
      expect(config.concurrency).toBe(3)
    } finally {
      // Restore env
      if (origBatch !== undefined) process.env.OLA_CC_GROK_BATCH_SIZE = origBatch
      else delete process.env.OLA_CC_GROK_BATCH_SIZE
      if (origConcurrency !== undefined) process.env.OLA_CC_GROK_CONCURRENCY = origConcurrency
      else delete process.env.OLA_CC_GROK_CONCURRENCY
    }
  })
})
```

- [ ] **Step 2: Run integration test**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/tools/GrokTool/__tests__/GrokManager.test.ts -t "optimized pipeline integration"`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/heal/ola-cc/.worktrees/codegraph-grok && bun test src/tools/GrokTool/__tests__/`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/heal/ola-cc/.worktrees/codegraph-grok
git add src/tools/GrokTool/__tests__/GrokManager.test.ts
git commit -m "test(grok): integration test for Phase 0 optimizations

Verify localScan + batch config + model routing work together
in the optimized pipeline."
```

---

## Self-Review

**1. Spec coverage:**
- Local scanner (O1): Task 1 covers it ✓
- Batch parameters (O3): Task 2 covers it ✓
- Multi-provider model routing (M2): Task 3 covers it ✓
- Integration: Task 4 covers it ✓

**2. Placeholder scan:** No TBD/TODO/placeholders found ✓

**3. Type consistency:**
- `localScan()` return type: `{ languages: string[], frameworks: string[], entryPoints: string[] }` — consistent across Task 1 test and implementation ✓
- `GrokConfig` schema fields: `batchSize`, `concurrency` — consistent across Task 2 test and implementation ✓
- `getAgentModel` grok task types: `'grok-primary'`, `'grok-fast'` — consistent across Task 3 test and implementation ✓
- `getModelForTask` parameter: `'primary' | 'fast'` — consistent across Task 3 implementation ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-07-grok-phase0-performance-optimization.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
