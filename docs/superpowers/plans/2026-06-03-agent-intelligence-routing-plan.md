# Agent Intelligence & Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Agent Intelligence subsystem (11 capabilities) and Agent/Smart Routing system, porting from oh-my-claudecode and openclaude into ola-cc.

**Architecture:** Agent Intelligence adds 11 capabilities (RateLimitWait, CodebaseMap, Factcheck, MagicKeywords, DelegationEnforcer, ContextInjector, AgentSummary, SnipCompact, FrustrationDetection, AgentRouting, SmartRouting) gated by compile-time feature flags. Agent Routing adds per-agent model selection with provider isolation via `client.ts` providerOverride. Smart Routing adds complexity-based model selection. All modules use `feature()` guards for dead code elimination when disabled.

**Tech Stack:** TypeScript, Bun, Zod, feature() compile-time gates, tmux (for RateLimitWait), Ink (for FrustrationDetection UI)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/services/rate-limit-wait/daemon.ts` | RateLimitWaitDaemon pollLoop + recovery |
| Create | `src/services/rate-limit-wait/rateLimitChecker.ts` | Rate limit status detection |
| Create | `src/services/rate-limit-wait/tmuxScanner.ts` | Tmux pane scanning for blocked sessions |
| Create | `src/services/codebase-map/codebaseMap.ts` | Directory walker + formatter |
| Create | `src/services/factcheck/factcheck.ts` | Claim detection + gate checking |
| Create | `src/services/magic-keywords/magicKeywords.ts` | Pattern matching + prompt enhancement |
| Create | `src/services/delegation-enforcer/delegationEnforcer.ts` | Model normalization + delegation decisions |
| Create | `src/services/context-injector/contextInjector.ts` | Codebase context injection into prompts |
| Create | `src/services/agent-summary/agentSummary.ts` | Agent execution summary generation |
| Create | `src/services/snip-compact/snipCompact.ts` | Lightweight per-tool compaction |
| Create | `src/services/frustration-detection/frustrationDetection.ts` | Repeated failure + loop pattern detection |
| Create | `src/services/agent-routing/agentRouting.ts` | Per-agent model + provider routing |
| Create | `src/services/agent-routing/smartRouting.ts` | Complexity-based model selection |
| Modify | `src/tools/AgentTool/AgentTool.tsx` | Integrate routing + delegation + feature flag guard |
| Modify | `src/tools/AgentTool/runAgent.ts` | Pass providerOverride to API client |
| Modify | `src/utils/settings/types.ts` | Add agentModels/agentRouting Zod schemas (gated by feature flag) |
| Modify | `src/services/api/client.ts` | Add providerOverride branch before standard provider detection |
| Modify | `scripts/build.ts` | Register 11 feature flags |
| Modify | `src/constants/prompts.ts` | Inject codebase context |
| Test | `src/services/**/*.test.ts` | All tests |

---

### Task 1: RateLimitWaitDaemon

**Files:**
- Create: `src/services/rate-limit-wait/daemon.ts`
- Create: `src/services/rate-limit-wait/rateLimitChecker.ts`
- Create: `src/services/rate-limit-wait/tmuxScanner.ts`
- Test: `src/services/rate-limit-wait/daemon.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/rate-limit-wait/daemon.test.ts
import { describe, test, expect, mock } from "bun:test"
import { RateLimitWaitDaemonImpl } from "./daemon"

describe("RateLimitWaitDaemon", () => {
  test("start/stop lifecycle", async () => {
    const daemon = new RateLimitWaitDaemonImpl()
    const checker = mock(() => Promise.resolve({ isLimited: false, retryAfterSeconds: null, limitType: null, detectedAt: Date.now() }))

    await daemon.start({
      pollIntervalMs: 100,
      maxWaitMs: 1000,
      tmuxEnabled: false,
      confidenceThreshold: 0.6,
      retryAfterFallback: true,
      maxRetries: 3,
    }, checker)

    expect(daemon.getStatus().running).toBe(true)
    await daemon.stop()
    expect(daemon.getStatus().running).toBe(false)
  })

  test("detects rate limit and waits", async () => {
    const daemon = new RateLimitWaitDaemonImpl()
    let callCount = 0
    const checker = mock(() => {
      callCount++
      return Promise.resolve({
        isLimited: callCount <= 1,
        retryAfterSeconds: callCount <= 1 ? 0.1 : null,
        limitType: callCount <= 1 ? "minute" as const : null,
        detectedAt: Date.now(),
      })
    })

    await daemon.start({
      pollIntervalMs: 50,
      maxWaitMs: 1000,
      tmuxEnabled: false,
      confidenceThreshold: 0.6,
      retryAfterFallback: true,
      maxRetries: 3,
    }, checker)

    // Wait for recovery
    await new Promise((r) => setTimeout(r, 300))
    const status = daemon.getStatus()
    expect(status.currentLimit).toBeNull()
    await daemon.stop()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/rate-limit-wait/daemon.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/rate-limit-wait/rateLimitChecker.ts
export interface RateLimitStatus {
  isLimited: boolean
  retryAfterSeconds: number | null
  limitType: "minute" | "hour" | "day" | "weekly" | null
  detectedAt: number
}

export interface RateLimitWaitConfig {
  pollIntervalMs: number
  maxWaitMs: number
  tmuxEnabled: boolean
  confidenceThreshold: number
  retryAfterFallback: boolean
  maxRetries: number
}

const RATE_LIMIT_PATTERNS = [
  { pattern: /rate.limit.*minute/i, type: "minute" as const },
  { pattern: /rate.limit.*hour/i, type: "hour" as const },
  { pattern: /rate.limit.*day/i, type: "day" as const },
  { pattern: /rate.limit.*week/i, type: "weekly" as const },
]

export function parseRateLimitFromOutput(output: string): RateLimitStatus {
  for (const { pattern, type } of RATE_LIMIT_PATTERNS) {
    if (pattern.test(output)) {
      const retryMatch = output.match(/retry.*?(\d+)\s*(?:second|minute)/i)
      const retryAfter = retryMatch ? parseInt(retryMatch[1]) : 60
      return { isLimited: true, retryAfterSeconds: retryAfter, limitType: type, detectedAt: Date.now() }
    }
  }
  return { isLimited: false, retryAfterSeconds: null, limitType: null, detectedAt: Date.now() }
}
```

```typescript
// src/services/rate-limit-wait/tmuxScanner.ts
export interface TmuxPaneInfo {
  paneId: string
  confidence: number
  hasClaudeCode: boolean
  hasRateLimitMessage: boolean
  isBlocked: boolean
}

export async function scanTmuxPanes(threshold: number): Promise<TmuxPaneInfo[]> {
  try {
    const proc = Bun.spawn(["tmux", "list-panes", "-a", "-F", "#{pane_id}:#{pane_current_command}"])
    const output = await new Response(proc.stdout).text()
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [paneId, command] = line.split(":")
        const hasClaudeCode = /claude|node|bun/.test(command || "")
        return {
          paneId,
          confidence: hasClaudeCode ? 0.8 : 0.2,
          hasClaudeCode,
          hasRateLimitMessage: false,
          isBlocked: false,
        }
      })
      .filter((p) => p.confidence >= threshold)
  } catch {
    return []
  }
}
```

```typescript
// src/services/rate-limit-wait/daemon.ts
import type { RateLimitWaitConfig, RateLimitStatus } from "./rateLimitChecker"

export class RateLimitWaitDaemonImpl {
  private running = false
  private currentLimit: RateLimitStatus | null = null
  private abortController: AbortController | null = null
  private pollLoopPromise: Promise<void> | null = null

  async start(
    config: RateLimitWaitConfig,
    checker: () => Promise<RateLimitStatus>,
  ): Promise<void> {
    this.running = true
    this.abortController = new AbortController()
    // Fire-and-forget: pollLoop runs in the background, start() returns immediately.
    // This prevents blocking the caller and allows tests to proceed.
    this.pollLoopPromise = this.pollLoop(config, checker, this.abortController.signal)
      .catch((err) => {
        if (this.running) {
          console.error("[RateLimitWaitDaemon] pollLoop error:", err)
        }
      })
  }

  async stop(): Promise<void> {
    this.running = false
    this.abortController?.abort()
    // Wait for the poll loop to finish its current iteration
    if (this.pollLoopPromise) {
      await this.pollLoopPromise
      this.pollLoopPromise = null
    }
  }

  getStatus(): { running: boolean; currentLimit: RateLimitStatus | null } {
    return { running: this.running, currentLimit: this.currentLimit }
  }

  private async pollLoop(
    config: RateLimitWaitConfig,
    checker: () => Promise<RateLimitStatus>,
    signal: AbortSignal,
  ): Promise<void> {
    while (this.running && !signal.aborted) {
      const status = await checker()
      this.currentLimit = status.isLimited ? status : null

      if (status.isLimited && status.retryAfterSeconds) {
        const waitMs = Math.min(status.retryAfterSeconds * 1000, config.maxWaitMs)
        await new Promise((r) => setTimeout(r, waitMs))
      } else {
        await new Promise((r) => setTimeout(r, config.pollIntervalMs))
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/rate-limit-wait/daemon.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/rate-limit-wait/
git commit -m "feat(agent-intel): add RateLimitWaitDaemon with tmux pane scanning"
```

---

### Task 2: CodebaseMap Generator

**Files:**
- Create: `src/services/codebase-map/codebaseMap.ts`
- Test: `src/services/codebase-map/codebaseMap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/codebase-map/codebaseMap.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { generateCodebaseMap } from "./codebaseMap"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"

const TEST_DIR = join(import.meta.dir, "__test_map")

describe("CodebaseMap", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "src"), { recursive: true })
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export const x = 1")
    writeFileSync(join(TEST_DIR, "src", "utils.ts"), "export function helper() {}")
    writeFileSync(join(TEST_DIR, "package.json"), '{"name":"test"}')
  })
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })

  test("generates map with file tree and exports", async () => {
    const map = await generateCodebaseMap(TEST_DIR, { maxDepth: 3 })
    expect(map).toContain("index.ts")
    expect(map).toContain("utils.ts")
    expect(map).toContain("package.json")
  })

  test("respects maxDepth", async () => {
    const map = await generateCodebaseMap(TEST_DIR, { maxDepth: 1 })
    expect(map).toContain("src/")
    expect(map).not.toContain("index.ts")
  })

  test("excludes node_modules", async () => {
    mkdirSync(join(TEST_DIR, "node_modules"), { recursive: true })
    writeFileSync(join(TEST_DIR, "node_modules", "dep.js"), "")
    const map = await generateCodebaseMap(TEST_DIR, { maxDepth: 3 })
    expect(map).not.toContain("dep.js")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/codebase-map/codebaseMap.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/services/codebase-map/codebaseMap.ts
import { readdirSync, statSync, existsSync } from "fs"
import { join, relative } from "path"

interface MapOptions {
  maxDepth: number
  excludeDirs?: string[]
}

const DEFAULT_EXCLUDE = ["node_modules", ".git", ".omc", "dist", "build", "__pycache__"]

export async function generateCodebaseMap(
  rootDir: string,
  options: MapOptions = { maxDepth: 3 },
): Promise<string> {
  const exclude = new Set([...DEFAULT_EXCLUDE, ...(options.excludeDirs || [])])
  const lines: string[] = []

  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > options.maxDepth) return
    const entries = readdirSync(dir)
      .filter((e) => !exclude.has(e))
      .sort((a, b) => {
        const aIsDir = statSync(join(dir, a)).isDirectory()
        const bIsDir = statSync(join(dir, b)).isDirectory()
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
        return a.localeCompare(b)
      })

    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const rel = relative(rootDir, fullPath)
      const isDir = statSync(fullPath).isDirectory()
      if (isDir) {
        lines.push(`${prefix}${entry}/`)
        walk(fullPath, depth + 1, prefix + "  ")
      } else {
        lines.push(`${prefix}${entry}`)
      }
    }
  }

  walk(rootDir, 0, "")
  return lines.join("\n")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/codebase-map/codebaseMap.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/codebase-map/
git commit -m "feat(agent-intel): add CodebaseMap generator with depth control"
```

---

### Task 3: Factcheck Guard

**Files:**
- Create: `src/services/factcheck/factcheck.ts`
- Test: `src/services/factcheck/factcheck.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/factcheck/factcheck.test.ts
import { describe, test, expect } from "bun:test"
import { detectClaims, checkGate } from "./factcheck"

describe("FactcheckGuard", () => {
  test("detects code change claims", () => {
    const claims = detectClaims("I updated the auth module to support OAuth2.")
    expect(claims.length).toBeGreaterThan(0)
    expect(claims[0].type).toBe("codeChange")
  })

  test("detects API call claims", () => {
    const claims = detectClaims("The function calls the GitHub API to fetch user data.")
    expect(claims.some((c) => c.type === "apiCall")).toBe(true)
  })

  test("checkGate passes with high confidence", () => {
    const result = checkGate({ type: "codeChange", claim: "updated auth", confidence: 0.9 })
    expect(result.passed).toBe(true)
  })

  test("checkGate fails with low confidence", () => {
    const result = checkGate({ type: "fileOperation", claim: "deleted config", confidence: 0.5 })
    expect(result.passed).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/factcheck/factcheck.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/services/factcheck/factcheck.ts
interface Claim {
  type: "codeChange" | "apiCall" | "fileOperation" | "configChange"
  claim: string
  confidence: number
}

interface GateResult {
  passed: boolean
  reason: string
}

const CLAIM_PATTERNS: Array<{ type: Claim["type"]; patterns: RegExp[]; threshold: number }> = [
  { type: "codeChange", patterns: [/updated?/i, /modified?/i, /changed?/i, /refactor/i], threshold: 0.8 },
  { type: "apiCall", patterns: [/call(s|ed)?/i, /fetch(es|ed)?/i, /request(s|ed)?/i, /api/i], threshold: 0.85 },
  { type: "fileOperation", patterns: [/creat(ed?|ing)/i, /delet(ed?|ing)/i, /renam(ed?|ing)/i, /mov(ed?|ing)/i], threshold: 0.9 },
  { type: "configChange", patterns: [/config/i, /setting/i, /env/i, /environment/i], threshold: 0.85 },
]

export function detectClaims(text: string): Claim[] {
  const claims: Claim[] = []
  for (const { type, patterns, threshold } of CLAIM_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        claims.push({ type, claim: text.match(pattern)?.[0] || "", confidence: threshold })
        break
      }
    }
  }
  return claims
}

const GATES: Record<string, number> = {
  codeChange: 0.8,
  apiCall: 0.85,
  fileOperation: 0.9,
  configChange: 0.85,
}

export function checkGate(claim: Claim): GateResult {
  const threshold = GATES[claim.type] || 0.8
  const passed = claim.confidence >= threshold
  return { passed, reason: passed ? "confidence meets threshold" : `confidence ${claim.confidence} < threshold ${threshold}` }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/factcheck/factcheck.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/factcheck/
git commit -m "feat(agent-intel): add FactcheckGuard with claim detection and gate checking"
```

---

### Task 4: Magic Keywords Engine

**Files:**
- Create: `src/services/magic-keywords/magicKeywords.ts`
- Test: `src/services/magic-keywords/magicKeywords.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/magic-keywords/magicKeywords.test.ts
import { describe, test, expect } from "bun:test"
import { detectMagicKeywords, buildEnhancedPrompt } from "./magicKeywords"

describe("MagicKeywords", () => {
  test("detects 'use best practices' keyword", () => {
    const matches = detectMagicKeywords("Please use best practices for this implementation.")
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].keyword).toBe("best practices")
  })

  test("detects 'production ready' keyword", () => {
    const matches = detectMagicKeywords("Make this production ready.")
    expect(matches.some((m) => m.keyword === "production ready")).toBe(true)
  })

  test("buildEnhancedPrompt appends keyword context", () => {
    const enhanced = buildEnhancedPrompt("Do the thing.", [{ keyword: "best practices", context: "Apply SOLID principles and clean code patterns." }])
    expect(enhanced).toContain("Do the thing.")
    expect(enhanced).toContain("SOLID")
  })

  test("returns empty for no matches", () => {
    const matches = detectMagicKeywords("Hello world")
    expect(matches).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/magic-keywords/magicKeywords.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/services/magic-keywords/magicKeywords.ts
interface MagicKeywordMatch {
  keyword: string
  context: string
  index: number
}

const KEYWORDS: Array<{ pattern: RegExp; context: string }> = [
  { pattern: /best\s+practices?/i, context: "Apply SOLID principles, clean code patterns, and established design patterns." },
  { pattern: /production\s+ready/i, context: "Include error handling, logging, monitoring hooks, graceful degradation, and security hardening." },
  { pattern: /clean\s+code/i, context: "Follow single responsibility, meaningful names, small functions, and DRY principles." },
  { pattern: /type\s*safe/i, context: "Use strict TypeScript types, no any, proper generics, and Zod validation." },
  { pattern: /well\s+tested/i, context: "Aim for >80% coverage, test edge cases, use TDD, include integration tests." },
]

export function detectMagicKeywords(text: string): MagicKeywordMatch[] {
  const matches: MagicKeywordMatch[] = []
  for (const { pattern, context } of KEYWORDS) {
    const m = pattern.exec(text)
    if (m) {
      matches.push({ keyword: m[0].toLowerCase(), context, index: m.index })
    }
  }
  return matches
}

export function buildEnhancedPrompt(original: string, matches: MagicKeywordMatch[]): string {
  if (matches.length === 0) return original
  const contextBlock = matches.map((m) => `- ${m.keyword}: ${m.context}`).join("\n")
  return `${original}\n\n## Enhanced Context\n${contextBlock}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/magic-keywords/magicKeywords.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/magic-keywords/
git commit -m "feat(agent-intel): add MagicKeywords engine with pattern matching"
```

---

### Task 5: Agent Routing (Per-Agent Model Selection)

**Files:**
- Create: `src/services/agent-routing/agentRouting.ts`
- Test: `src/services/agent-routing/agentRouting.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/agent-routing/agentRouting.test.ts
import { describe, test, expect } from "bun:test"
import { resolveAgentRunModelRouting, normalizeKey } from "./agentRouting"

describe("AgentRouting", () => {
  test("resolves by agent name", () => {
    const result = resolveAgentRunModelRouting({
      agentName: "code-reviewer",
      settings: {
        agentModels: { "sonnet-provider": { base_url: "https://api.test.com", api_key: "sk-test" } },
        agentRouting: { "code-reviewer": "sonnet-provider" },
      },
    })
    expect(result.providerOverride).toBeDefined()
    expect(result.providerOverride!.base_url).toBe("https://api.test.com")
  })

  test("falls back to default", () => {
    const result = resolveAgentRunModelRouting({
      agentName: "unknown-agent",
      settings: {
        agentModels: {},
        agentRouting: { default: "anthropic" },
      },
    })
    expect(result.mainLoopModel).toBe("anthropic")
  })

  test("normalizes keys (lowercase, strip hyphens)", () => {
    expect(normalizeKey("Code-Reviewer")).toBe("codereviewer")
    expect(normalizeKey("MY_AGENT")).toBe("myagent")
  })

  test("toolSpecifiedModel takes highest priority", () => {
    const result = resolveAgentRunModelRouting({
      toolSpecifiedModel: "opus",
      agentName: "code-reviewer",
      settings: {
        agentModels: {},
        agentRouting: { "code-reviewer": "haiku" },
      },
    })
    expect(result.mainLoopModel).toBe("opus")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/agent-routing/agentRouting.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/services/agent-routing/agentRouting.ts
interface AgentModelConfig {
  base_url: string
  api_key: string
}

interface RoutingSettings {
  agentModels: Record<string, AgentModelConfig>
  agentRouting: Record<string, string>
}

interface RoutingResult {
  mainLoopModel: string | null
  providerOverride?: AgentModelConfig
}

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "")
}

/** Resolve API key from config, supporting env-var references */
function resolveApiKey(config: AgentModelConfig): string {
  // api_key_env takes precedence
  if (config.api_key_env) {
    const envKey = process.env[config.api_key_env]
    if (envKey) return envKey
    console.warn(`[AgentRouting] Env var ${config.api_key_env} not set, falling back to api_key`)
  }
  // Support $ENV_VAR_NAME syntax in api_key field
  if (config.api_key.startsWith("$")) {
    const envName = config.api_key.slice(1)
    const envVal = process.env[envName]
    if (envVal) return envVal
    console.warn(`[AgentRouting] Env var ${envName} not set, using api_key as literal`)
  }
  return config.api_key
}

export function resolveAgentRunModelRouting(params: {
  toolSpecifiedModel?: string
  agentName?: string
  subagentType?: string
  settings: RoutingSettings
}): RoutingResult {
  const { toolSpecifiedModel, agentName, subagentType, settings } = params
  const routing = settings.agentRouting || {}
  const models = settings.agentModels || {}

  // Priority chain: toolSpecifiedModel > agentName > subagentType > "default" > null
  const candidates = [toolSpecifiedModel, agentName, subagentType, "default"].filter(Boolean) as string[]

  for (const candidate of candidates) {
    const normalized = normalizeKey(candidate)
    for (const [routeKey, routeValue] of Object.entries(routing)) {
      if (normalizeKey(routeKey) === normalized) {
        const modelConfig = models[routeValue]
        if (modelConfig) {
          // Resolve API key (supports env-var references)
          const resolved: AgentModelConfig = {
            ...modelConfig,
            api_key: resolveApiKey(modelConfig),
          }
          return { mainLoopModel: routeValue, providerOverride: resolved }
        }
        return { mainLoopModel: routeValue }
      }
    }
  }

  return { mainLoopModel: null }
}

export const PROVIDER_ENV_VARS_TO_CLEAR_FOR_OVERRIDE = [
  "CLAUDE_CODE_USE_OPENAI", "OPENAI_MODEL", "OPENAI_BASE_URL", "OPENAI_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_PROFILE",
  "CLAUDE_CODE_USE_VERTEX", "GOOGLE_CLOUD_PROJECT",
  "CLAUDE_CODE_USE_FOUNDRY", "AZURE_FOUNDRY_ENDPOINT",
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/agent-routing/agentRouting.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/agent-routing/
git commit -m "feat(agent-routing): add per-agent model selection with priority chain"
```

---

### Task 6: Smart Routing (Complexity-Based Model Selection)

**Files:**
- Create: `src/services/agent-routing/smartRouting.ts`
- Test: `src/services/agent-routing/smartRouting.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/agent-routing/smartRouting.test.ts
import { describe, test, expect } from "bun:test"
import { isSimpleMessage, estimateWordCount, routeByComplexity } from "./smartRouting"

describe("SmartRouting", () => {
  test("isSimpleMessage detects short messages", () => {
    expect(isSimpleMessage("hello", { simpleMaxChars: 160, simpleMaxWords: 28 })).toBe(true)
    expect(isSimpleMessage("a".repeat(200), { simpleMaxChars: 160, simpleMaxWords: 28 })).toBe(false)
  })

  test("estimateWordCount handles CJK characters", () => {
    expect(estimateWordCount("你好世界")).toBe(4)
    expect(estimateWordCount("hello world")).toBe(2)
    expect(estimateWordCount("hello 你好")).toBe(3) // 2 English + 1 CJK char (boundary)
  })

  test("routeByComplexity returns simpleModel for short messages", () => {
    const result = routeByComplexity("fix typo", {
      simpleModel: "haiku",
      strongModel: "sonnet",
      simpleMaxChars: 160,
      simpleMaxWords: 28,
    })
    expect(result).toBe("haiku")
  })

  test("routeByComplexity returns strongModel for complex messages", () => {
    const result = routeByComplexity("refactor the authentication system to support OAuth2 with PKCE flow and implement token refresh", {
      simpleModel: "haiku",
      strongModel: "sonnet",
      simpleMaxChars: 160,
      simpleMaxWords: 28,
    })
    expect(result).toBe("sonnet")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/agent-routing/smartRouting.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/services/agent-routing/smartRouting.ts
interface SmartRoutingConfig {
  simpleModel: string
  strongModel: string
  simpleMaxChars: number
  simpleMaxWords: number
}

export function estimateWordCount(text: string): number {
  let count = 0
  for (const char of text) {
    // CJK Unified Ideographs range
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(char)) {
      count++
    }
  }
  // Non-CJK parts by whitespace
  const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ")
  count += nonCjk.split(/\s+/).filter(Boolean).length
  return count
}

export function isSimpleMessage(text: string, config: { simpleMaxChars: number; simpleMaxWords: number }): boolean {
  if (text.length > config.simpleMaxChars) return false
  if (estimateWordCount(text) > config.simpleMaxWords) return false
  return true
}

export function routeByComplexity(text: string, config: SmartRoutingConfig): string {
  return isSimpleMessage(text, config) ? config.simpleModel : config.strongModel
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/agent-routing/smartRouting.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/agent-routing/smartRouting.ts src/services/agent-routing/smartRouting.test.ts
git commit -m "feat(agent-routing): add Smart Routing with CJK word count and complexity detection"
```

---

### Task 7: Delegation Enforcer & Context Injector

> **NOTE on DelegationEnforcer vs Smart Routing:**
> These two systems operate at **different levels** and are **complementary, not contradictory**:
>
> | Aspect | DelegationEnforcer (Task 7) | Smart Routing (Task 6) |
> |--------|---------------------------|----------------------|
> | **Level** | Agent-level (sub-agent dispatch) | Message-level (main loop model) |
> | **Input** | `taskComplexity` (simple/medium/complex) — semantic classification based on prompt length heuristics | `isSimpleMessage` (char/word thresholds) — statistical classification |
> | **Decision** | Should this task be delegated to a cheaper sub-agent? | Which model should handle this message in the main loop? |
> | **When** | At AgentTool dispatch time (before spawning sub-agent) | At query time (before sending to API) |
> | **Scope** | Only applies when `AgentTool` is invoked | Applies to every user message |
>
> They can both be enabled simultaneously: Smart Routing selects the main-loop model per-message, while DelegationEnforcer further optimizes sub-agent model selection within AgentTool.

**Files:**
- Create: `src/services/delegation-enforcer/delegationEnforcer.ts`
- Create: `src/services/context-injector/contextInjector.ts`
- Test: `src/services/delegation-enforcer/delegationEnforcer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/delegation-enforcer/delegationEnforcer.test.ts
import { describe, test, expect } from "bun:test"
import { shouldDelegate, resolveDelegationModel } from "./delegationEnforcer"
import { injectCodebaseContext } from "./contextInjector"

describe("DelegationEnforcer", () => {
  test("delegates simple tasks to cheap model", () => {
    const result = shouldDelegate({ taskComplexity: "simple", agentName: "helper" })
    expect(result.delegate).toBe(true)
    expect(result.targetTier).toBe("low")
  })

  test("does not delegate complex tasks", () => {
    const result = shouldDelegate({ taskComplexity: "complex", agentName: "architect" })
    expect(result.delegate).toBe(false)
  })

  test("resolveDelegationModel maps tiers", () => {
    expect(resolveDelegationModel("low")).toBe("haiku")
    expect(resolveDelegationModel("normal")).toBe("sonnet")
    expect(resolveDelegationModel("high")).toBe("opus")
  })
})

describe("ContextInjector", () => {
  test("injects codebase context into prompt", () => {
    const result = injectCodebaseContext("Fix the bug.", { codebaseMap: "src/\n  index.ts", maxTokens: 1000 })
    expect(result).toContain("Fix the bug.")
    expect(result).toContain("[CODEBASE_CONTEXT]")
    expect(result).toContain("index.ts")
  })

  test("truncates when exceeding maxTokens", () => {
    const longMap = "x".repeat(5000)
    const result = injectCodebaseContext("task", { codebaseMap: longMap, maxTokens: 100 })
    expect(result.length).toBeLessThan(longMap.length + 200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/delegation-enforcer/delegationEnforcer.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/services/delegation-enforcer/delegationEnforcer.ts
interface DelegationInput {
  taskComplexity: "simple" | "medium" | "complex"
  agentName: string
}

interface DelegationResult {
  delegate: boolean
  targetTier: "low" | "normal" | "high"
}

export function shouldDelegate(input: DelegationInput): DelegationResult {
  if (input.taskComplexity === "simple") {
    return { delegate: true, targetTier: "low" }
  }
  if (input.taskComplexity === "medium") {
    return { delegate: true, targetTier: "normal" }
  }
  return { delegate: false, targetTier: "high" }
}

export function resolveDelegationModel(tier: "low" | "normal" | "high"): string {
  const map = { low: "haiku", normal: "sonnet", high: "opus" }
  return map[tier]
}
```

```typescript
// src/services/context-injector/contextInjector.ts
interface InjectOptions {
  codebaseMap: string
  maxTokens: number
}

export function injectCodebaseContext(prompt: string, options: InjectOptions): string {
  const { codebaseMap, maxTokens } = options
  // Rough estimate: 1 token ≈ 4 chars
  const maxChars = maxTokens * 4
  const truncated = codebaseMap.length > maxChars
    ? codebaseMap.slice(0, maxChars) + "\n... (truncated)"
    : codebaseMap

  return `${prompt}\n\n[CODEBASE_CONTEXT]\n${truncated}\n[/CODEBASE_CONTEXT]`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/delegation-enforcer/delegationEnforcer.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/delegation-enforcer/ src/services/context-injector/
git commit -m "feat(agent-intel): add DelegationEnforcer and ContextInjector"
```

---

### Task 8: Frustration Detection

**Files:**
- Create: `src/services/frustration-detection/frustrationDetection.ts`
- Test: `src/services/frustration-detection/frustrationDetection.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/frustration-detection/frustrationDetection.test.ts
import { describe, test, expect } from "bun:test"
import { detectFrustration, type FrustrationSignal } from "./frustrationDetection"

describe("FrustrationDetection", () => {
  test("detects repeated failures", () => {
    const signals = detectFrustration({
      recentToolResults: [
        { success: false, tool: "Bash" },
        { success: false, tool: "Bash" },
        { success: false, tool: "Bash" },
      ],
      userMessages: [],
    })
    expect(signals.some((s) => s.type === "repeatedFailure")).toBe(true)
    expect(signals.find((s) => s.type === "repeatedFailure")?.severity).toBe("high")
  })

  test("detects user frustration keywords", () => {
    const signals = detectFrustration({
      recentToolResults: [],
      userMessages: ["this is not working at all", "why is this broken"],
    })
    expect(signals.some((s) => s.type === "userLanguage")).toBe(true)
  })

  test("returns empty for normal operation", () => {
    const signals = detectFrustration({
      recentToolResults: [
        { success: true, tool: "Read" },
        { success: true, tool: "Edit" },
      ],
      userMessages: ["please fix the bug"],
    })
    expect(signals).toHaveLength(0)
  })

  test("detects loop pattern (same tool repeated)", () => {
    const signals = detectFrustration({
      recentToolResults: [
        { success: true, tool: "Bash" },
        { success: true, tool: "Bash" },
        { success: true, tool: "Bash" },
        { success: true, tool: "Bash" },
        { success: true, tool: "Bash" },
      ],
      userMessages: [],
    })
    expect(signals.some((s) => s.type === "loopPattern")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/frustration-detection/frustrationDetection.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/services/frustration-detection/frustrationDetection.ts
export interface FrustrationSignal {
  type: "repeatedFailure" | "userLanguage" | "loopPattern" | "stall"
  severity: "low" | "medium" | "high"
  message: string
  evidence: string[]
}

interface DetectionInput {
  recentToolResults: Array<{ success: boolean; tool: string }>
  userMessages: string[]
}

const FRUSTRATION_KEYWORDS = [
  /not working/i,
  /broken/i,
  /why.*(fail|error|broken)/i,
  /still.*(not|doesn't|won't)/i,
  /keep.*(getting|failing|erroring)/i,
  /this is (wrong|bad|terrible|awful)/i,
  /frustrated/i,
  /give up/i,
]

const LOOP_THRESHOLD = 5
const FAILURE_THRESHOLD = 3

export function detectFrustration(input: DetectionInput): FrustrationSignal[] {
  const signals: FrustrationSignal[] = []

  // 1. Repeated failures
  const recentFailures = input.recentToolResults.filter((r) => !r.success)
  if (recentFailures.length >= FAILURE_THRESHOLD) {
    signals.push({
      type: "repeatedFailure",
      severity: recentFailures.length >= FAILURE_THRESHOLD + 2 ? "high" : "medium",
      message: `${recentFailures.length} consecutive tool failures detected`,
      evidence: recentFailures.map((r) => r.tool),
    })
  }

  // 2. User frustration keywords
  const frustrationHits: string[] = []
  for (const msg of input.userMessages) {
    for (const pattern of FRUSTRATION_KEYWORDS) {
      if (pattern.test(msg)) {
        frustrationHits.push(msg.slice(0, 80))
        break
      }
    }
  }
  if (frustrationHits.length > 0) {
    signals.push({
      type: "userLanguage",
      severity: frustrationHits.length >= 2 ? "high" : "medium",
      message: `Frustration detected in user messages`,
      evidence: frustrationHits,
    })
  }

  // 3. Loop pattern (same tool repeated many times)
  const toolCounts = new Map<string, number>()
  for (const result of input.recentToolResults) {
    toolCounts.set(result.tool, (toolCounts.get(result.tool) || 0) + 1)
  }
  for (const [tool, count] of toolCounts) {
    if (count >= LOOP_THRESHOLD) {
      signals.push({
        type: "loopPattern",
        severity: count >= LOOP_THRESHOLD + 3 ? "high" : "medium",
        message: `Tool "${tool}" called ${count} times — possible loop`,
        evidence: [tool],
      })
    }
  }

  return signals
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/frustration-detection/frustrationDetection.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/frustration-detection/
git commit -m "feat(agent-intel): add FrustrationDetection with repeated failure and loop pattern detection"
```

---

### Task 9: Integration (AgentSummary + SnipCompact + Feature Flags + AgentTool + client.ts + settings schema)

**Files:**
- Create: `src/services/agent-summary/agentSummary.ts`
- Create: `src/services/snip-compact/snipCompact.ts`
- Modify: `scripts/build.ts` — register 11 feature flags
- Modify: `src/utils/settings/types.ts` — add agentModels/agentRouting Zod schemas
- Modify: `src/services/api/client.ts` — add providerOverride branch
- Modify: `src/tools/AgentTool/AgentTool.tsx` — integrate routing + delegation + feature flag guard

- [ ] **Step 1: Create AgentSummary**

```typescript
// src/services/agent-summary/agentSummary.ts
import { feature } from "bun:bundle"

interface AgentSummaryInput {
  agentName: string
  tasks: string[]
  duration: number
  success: boolean
}

export function generateAgentSummary(input: AgentSummaryInput): string {
  if (!feature("AGENT_SUMMARY")) return ""
  const status = input.success ? "completed successfully" : "failed"
  const taskList = input.tasks.map((t, i) => `  ${i + 1}. ${t}`).join("\n")
  return `## Agent: ${input.agentName}\nStatus: ${status}\nDuration: ${(input.duration / 1000).toFixed(1)}s\nTasks:\n${taskList}`
}
```

- [ ] **Step 2: Create SnipCompact**

```typescript
// src/services/snip-compact/snipCompact.ts
import { feature } from "bun:bundle"

interface SnipResult {
  originalTokens: number
  compactedTokens: number
  savings: number
}

export function snipCompact(messages: Array<{ role: string; content: string }>): {
  messages: Array<{ role: string; content: string }>
  result: SnipResult
} {
  if (!feature("SNIP_COMPACT")) {
    return { messages, result: { originalTokens: 0, compactedTokens: 0, savings: 0 } }
  }
  const original = messages.reduce((sum, m) => sum + m.content.length, 0)
  const compacted = messages.map((m) => {
    if (m.role === "tool" && m.content.length > 2000) {
      return { ...m, content: m.content.slice(0, 2000) + "\n... (snipped)" }
    }
    return m
  })
  const after = compacted.reduce((sum, m) => sum + m.content.length, 0)
  return {
    messages: compacted,
    result: {
      originalTokens: Math.ceil(original / 4),
      compactedTokens: Math.ceil(after / 4),
      savings: 1 - after / original,
    },
  }
}
```

- [ ] **Step 3: Register feature flags in build.ts**

```typescript
// In scripts/build.ts, add to fullExperimentalFeatures array:
"RATE_LIMIT_WAIT",
"CODEBASE_MAP",
"FACTCHECK_GUARD",
"MAGIC_KEYWORDS",
"DELEGATION_ENFORCER",
"CONTEXT_INJECTOR",
"AGENT_SUMMARY",
"SNIP_COMPACT",
"AGENT_ROUTING",
"SMART_ROUTING",
"FRUSTRATION_DETECTION",
```

- [ ] **Step 4: Add Zod schemas for agentModels/agentRouting to settings/types.ts**

Insert before the `.passthrough()` closing of `SettingsSchema` (currently at line ~1098 in `src/utils/settings/types.ts`):

```typescript
// In src/utils/settings/types.ts, inside SettingsSchema object, add before .passthrough():

      // --- Agent Intelligence & Routing ---
      ...(feature("AGENT_ROUTING")
        ? {
            agentModels: z
              .record(
                z.string(),
                z.object({
                  base_url: z.string().url().describe("API base URL for this provider"),
                  api_key: z
                    .string()
                    .describe(
                      "API key for this provider. " +
                        "For security, use env var references: '$ENV_VAR_NAME' (e.g., '$MY_API_KEY'). " +
                        "The runtime resolves '$...' prefixed values from process.env automatically. " +
                        "Plaintext keys are supported but discouraged.",
                    ),
                  api_key_env: z
                    .string()
                    .optional()
                    .describe(
                      "Alternative to api_key: name of environment variable containing the key. " +
                        "Takes precedence over api_key when both are set. " +
                        "Example: 'MY_PROVIDER_API_KEY' reads from process.env.MY_PROVIDER_API_KEY.",
                    ),
                  provider: z
                    .enum(["anthropic", "openai", "bedrock", "vertex"])
                    .optional()
                    .describe("Provider type hint for client selection"),
                }),
              )
              .optional()
              .describe(
                "Named model provider configs for agent routing. " +
                  'Keys are provider names (e.g., "sonnet-provider"), values are connection details. ' +
                  "SECURITY: Prefer api_key_env over api_key to avoid storing secrets in settings.json.",
              ),
            agentRouting: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                'Maps agent names to provider names. E.g., { "code-reviewer": "sonnet-provider", "default": "anthropic" }. ' +
                  "Agent name matching is case-insensitive with hyphens/underscores stripped.",
              ),
          }
        : {}),
```

- [ ] **Step 5: Add providerOverride branch to client.ts**

Insert in `src/services/api/client.ts` at the top of `getAnthropicClient()`, **before** the `isEnvTruthy(process.env.OLA_CC_USE_BEDROCK)` check (line ~181):

```typescript
// In src/services/api/client.ts, inside getAnthropicClient(), before the Bedrock check:

  // --- Agent Routing: provider override ---
  // When agent routing resolves a custom provider, override the env-based client selection.
  // This is checked BEFORE the standard provider detection (Bedrock/Vertex/Foundry/OpenAI)
  // so that per-agent provider isolation works correctly.
  const providerOverride = (fetchOverride as any)?.__providerOverride as
    | { base_url: string; api_key: string; provider?: string }
    | undefined

  if (providerOverride) {
    const overrideProvider = providerOverride.provider || "openai"
    logForDebugging(
      `[API:agent-routing] Using provider override: ${overrideProvider}, base_url=${providerOverride.base_url}`,
    )

    if (overrideProvider === "anthropic") {
      // Direct Anthropic API with custom endpoint
      const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
        apiKey: providerOverride.api_key,
        baseURL: providerOverride.base_url,
        ...ARGS,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      }
      return new Anthropic(clientConfig)
    }

    // Default: treat as OpenAI-compatible endpoint
    const openaiArgs: ShimClientOptions = {
      apiKey: providerOverride.api_key,
      maxRetries,
      model,
      baseURL: providerOverride.base_url,
      ...(resolvedFetch && { fetch: resolvedFetch }),
    }
    return createOpenAICompatibleShimClient(openaiArgs) as unknown as Anthropic
  }
```

- [ ] **Step 6: Integrate routing + delegation into AgentTool.tsx**

Insert in `src/tools/AgentTool/AgentTool.tsx` **after** the `getAgentModel()` call at line ~629, **before** the `logForDebugging` call:

```typescript
// In src/tools/AgentTool/AgentTool.tsx, after line 629 (getAgentModel call), before logForDebugging:

    // --- Agent Intelligence Routing ---
    // If AGENT_ROUTING feature is enabled, resolve per-agent model + provider override.
    // This can change resolvedAgentModel and inject a providerOverride for client.ts.
    let agentRoutingProviderOverride: { base_url: string; api_key: string; provider?: string } | undefined
    if (feature("AGENT_ROUTING")) {
      try {
        const { resolveAgentRunModelRouting } = await import("../../services/agent-routing/agentRouting.js")
        const settings = getInitialSettings()
        const routingResult = resolveAgentRunModelRouting({
          toolSpecifiedModel: isForkPath ? undefined : model,
          agentName: selectedAgent.agentType,
          settings: {
            agentModels: (settings as any).agentModels || {},
            agentRouting: (settings as any).agentRouting || {},
          },
        })
        if (routingResult.mainLoopModel) {
          resolvedAgentModel = routingResult.mainLoopModel
          logForDebugging(`[AgentTool] Routing override: ${selectedAgent.agentType} -> ${routingResult.mainLoopModel}`)
        }
        if (routingResult.providerOverride) {
          agentRoutingProviderOverride = routingResult.providerOverride
        }
      } catch (err) {
        logForDebugging(`[AgentTool] Agent routing error (non-fatal): ${errorMessage(err)}`)
      }
    }

    // --- Delegation Enforcer ---
    // If DELEGATION_ENFORCER feature is enabled, check whether this task should be delegated
    // to a cheaper model based on complexity heuristics.
    if (feature("DELEGATION_ENFORCER")) {
      try {
        const { shouldDelegate, resolveDelegationModel } = await import("../../services/delegation-enforcer/delegationEnforcer.js")
        const delegation = shouldDelegate({
          taskComplexity: prompt.length < 200 ? "simple" : prompt.length < 1000 ? "medium" : "complex",
          agentName: selectedAgent.agentType,
        })
        if (delegation.delegate) {
          const cheapModel = resolveDelegationModel(delegation.targetTier)
          logForDebugging(`[AgentTool] Delegation: ${selectedAgent.agentType} -> ${cheapModel} (tier: ${delegation.targetTier})`)
          resolvedAgentModel = cheapModel
        }
      } catch (err) {
        logForDebugging(`[AgentTool] Delegation enforcer error (non-fatal): ${errorMessage(err)}`)
      }
    }
```

Then, in `runAgent.ts`, pass the `providerOverride` to the query engine. Add after the `resolvedAgentModel` assignment (line ~406):

```typescript
// In src/tools/AgentTool/runAgent.ts, after getAgentModel() call:

  // Pass providerOverride through to the API client if agent routing resolved one.
  // The providerOverride is attached to the fetch function as a hidden property
  // so client.ts can pick it up without changing the public API surface.
  const agentRoutingProviderOverride = (override as any)?.providerOverride as
    | { base_url: string; api_key: string; provider?: string }
    | undefined

  if (agentRoutingProviderOverride && feature("AGENT_ROUTING")) {
    logForDebugging(`[runAgent] Provider override: ${agentRoutingProviderOverride.base_url}`)
  }
```

- [ ] **Step 6b: Add FrustrationDetection integration to query.ts**

Insert in `src/query.ts` inside the main query loop, after tool execution results are processed:

```typescript
// In src/query.ts, after tool results are collected, before next model call:
const frustrationModule = feature("FRUSTRATION_DETECTION")
  ? (await import("./services/frustration-detection/frustrationDetection.js"))
  : null

if (frustrationModule) {
  const signals = frustrationModule.detectFrustration({
    recentToolResults: toolResults.slice(-10),
    userMessages: messages.filter(m => m.role === "user").slice(-5),
    toolCallHistory: toolCallLog.slice(-20),
  })
  if (signals.length > 0) {
    // Inject frustration context into next model call as system hint
    const hint = signals.map(s => s.message).join("; ")
    logForDebugging(`[Frustration] ${hint}`)
  }
}
```

- [ ] **Step 6c: Add SnipCompact integration to compact.ts**

Insert in `src/services/compact/compact.ts` inside the compaction flow, before the main compaction logic:

```typescript
// In compact.ts, early in the compaction flow:
const snipModule = feature("SNIP_COMPACT")
  ? (await import("./snip-compact/snipCompact.js"))
  : null

if (snipModule) {
  const { messages: snipped, result } = snipModule.snipCompact(messages)
  if (result.savings > 0) {
    messages = snipped
    logForDebugging(`[SnipCompact] Saved ${result.savings * 100}% tokens`)
  }
}
```

- [ ] **Step 6d: Inject codebase context into prompts.ts**

Modify `src/constants/prompts.ts` to inject codebase map context when CODEBASE_MAP feature is enabled:

```typescript
// In src/constants/prompts.ts, in the system prompt construction:
const codebaseMapModule = feature("CODEBASE_MAP")
  ? (await import("../services/codebase-map/codebaseMap.js"))
  : null

// If enabled, append codebase map to system prompt:
if (codebaseMapModule) {
  const map = codebaseMapModule.generateCodebaseMap(process.cwd())
  systemPrompt += `\n\n## Project Structure\n${map}`
}
```

- [ ] **Step 6e: Clean up provider env vars in client.ts**

In `src/services/api/client.ts`, after the providerOverride branch resolves, clear conflicting env vars:

```typescript
// In client.ts, after providerOverride is applied:
if (providerOverride) {
  // Clear standard provider env vars to prevent client selection conflicts
  for (const envVar of PROVIDER_ENV_VARS_TO_CLEAR_FOR_OVERRIDE) {
    delete process.env[envVar]
  }
}
```

Import `PROVIDER_ENV_VARS_TO_CLEAR_FOR_OVERRIDE` from `src/services/agent-routing/agentRouting.js`.

- [ ] **Step 7: Run all tests**

Run: `bun test src/services/rate-limit-wait/ src/services/codebase-map/ src/services/factcheck/ src/services/magic-keywords/ src/services/delegation-enforcer/ src/services/context-injector/ src/services/agent-routing/ src/services/frustration-detection/`
Expected: All tests PASS

- [ ] **Step 8: Verify build with flags disabled**

Run: `bun run build:dev`
Expected: Builds successfully with all feature flags disabled (dead code eliminated)

- [ ] **Step 9: Commit**

```bash
git add src/services/agent-summary/ src/services/snip-compact/ \
  src/utils/settings/types.ts src/services/api/client.ts \
  src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/runAgent.ts \
  scripts/build.ts
git commit -m "feat(agent-intel): integrate all 11 capabilities with feature flags, settings schema, provider override, and AgentTool routing"
```

---

## Verification Checklist

After completing all tasks, verify:

1. `bun test src/services/rate-limit-wait/` — pass
2. `bun test src/services/codebase-map/` — pass
3. `bun test src/services/factcheck/` — pass
4. `bun test src/services/magic-keywords/` — pass
5. `bun test src/services/delegation-enforcer/` — pass
6. `bun test src/services/context-injector/` — pass
7. `bun test src/services/agent-routing/` — pass (agentRouting + smartRouting)
8. `bun test src/services/frustration-detection/` — pass
9. `bun run build:dev` — builds with all flags disabled (dead code eliminated)
10. All 11 feature flags registered in `scripts/build.ts` fullExperimentalFeatures
11. `src/utils/settings/types.ts` — `agentModels`/`agentRouting` schemas present under `AGENT_ROUTING` gate
12. `src/services/api/client.ts` — providerOverride branch present before Bedrock/Vertex detection
13. `src/tools/AgentTool/AgentTool.tsx` — routing + delegation integration present under feature flag guards
14. `start()` in RateLimitWaitDaemon returns immediately (fire-and-forget pollLoop)

---

## Cross-Plan Coordination: query.ts

This plan's Task 9 (FrustrationDetection) modifies `src/query.ts`. Other plans also modify the same file. See the **Cross-Plan Coordination: query.ts** section in `2026-06-03-performance-optimization-plan.md` for the full modification map and recommended merge order.

**This plan's insertion point:**

| Task | Region | Insertion Point |
|------|--------|-----------------|
| Task 9 (Frustration) | Tool results processing | After tool results collected, before next model call |

**Merge order**: Apply P10 changes LAST (after P4, P7, P6 changes). FrustrationDetection is purely additive (feature-gated dynamic import + conditional call) and operates in a distinct region (after tool results, before next model call). No conflict expected with other plans' insertion points.
