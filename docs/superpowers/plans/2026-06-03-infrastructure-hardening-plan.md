# Infrastructure Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 12 infrastructure hardening features that improve ola-cc's robustness, observability, and developer experience.

**Architecture:** Each feature is an independent module gated by its own feature flag (`OLA_CC_` prefix). Features are ordered by dependency: standalone modules first (Tasks 1-4), then modules that depend on existing ola-cc infrastructure (Tasks 5-7), finally feature flag registration (Task 8). MiniMax Provider (Task 7) integrates into the existing API client provider selection pattern.

**Tech Stack:** TypeScript, Bun, Zod, feature() compile-time gates, Ink (terminal UI), LSP (for passive feedback)

### Feature Gate Integration Pattern

Every module created by this plan MUST use `feature()` compile-time gates at its integration point in the consumer file (query.ts, setup.ts, compact.ts, etc.). The pattern is:

```typescript
// In the consumer file (e.g., src/query.ts):
const sanitizerModule = feature('OLA_CC_EMPTY_MSG_SANITIZER')
  ? (await import('./services/message-sanitizer/emptyMessageSanitizer.js'))
  : null

// Usage:
if (sanitizerModule) {
  messages = sanitizerModule.sanitizeMessages(messages)
}
```

This ensures dead-code elimination when the flag is OFF. Each Task's Step 6 (integration) must use this pattern.

### Hot-spot File Merge Strategy: query.ts

Tasks 1, 2, 4, and 5 all modify `src/query.ts`. To prevent merge conflicts, each task targets a **distinct insertion region**:

| Task | Region | Insertion Point | Code Block |
|------|--------|-----------------|------------|
| Task 1 (Sanitizer) | API call preparation | Before `const apiMessages = messagesForQuery` | `sanitizeMessages(messages)` |
| Task 1 (Normalizer) | Tool execution | Before `const result = await tool.call(args)` | `normalizeToolArgs(args, schema)` |
| Task 2 (LSP Feedback) | User message processing | After user message is added to conversation | `collectDiagnostics()` + inject to message |
| Task 4 (Usage Reminder) | Tool result handling | After tool execution succeeds | `reminder.recordCall(toolName)` |
| Task 5 (Post-Sampling) | Model response handling | After model response is received | `executePostSamplingHooks(response)` |

**Merge order:** Task 1 → Task 2 → Task 4 → Task 5 (each modifies a non-overlapping region).

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Enhance | `src/services/lsp/passiveFeedback.ts` | LSP diagnostic injection into conversation (existing 328 LOC) |
| Create | `src/services/tool-normalization/toolArgNormalizer.ts` | Tool argument schema validation + normalization |
| Create | `src/utils/model/minimaxModels.ts` | MiniMax model list and selection |
| Create | `src/services/api/minimaxClient.ts` | MiniMax API adapter |
| Modify | `src/services/api/client.ts` | Add MiniMax provider branch |
| Create | `src/services/agent-memory/persistentMemoryStore.ts` | Three-scope agent memory persistence |
| Create | `src/services/compact/preCompactCheckpoint.ts` | Save conversation state before compact |
| Create | `src/services/message-sanitizer/emptyMessageSanitizer.ts` | Inject placeholders into empty messages |
| Create | `src/services/env-detection/nonInteractiveEnv.ts` | Detect CI/headless environments |
| Create | `src/services/usage-reminder/usageReminder.ts` | Tool call frequency monitoring |
| Create | `src/services/file-watcher/fileChangedWatcher.ts` | Watch files for external changes |
| Create | `src/services/post-sampling/postSamplingHook.ts` | Post-response hooks |
| Create | `src/services/session-history/sessionHistorySearch.ts` | JSONL transcript search with time range filtering |
| Create | `src/services/benchmarking/modelBenchmark.ts` | Model performance benchmarking |
| Create | `src/commands/search/search.ts` | /search command entry point |
| Create | `src/commands/benchmark/benchmark.ts` | /benchmark command entry point |
| Modify | `scripts/build.ts` | Register 12 feature flags with OLA_CC_ prefix |
| Modify | `src/query.ts` | Integrate sanitizer, LSP feedback, tool normalization, usage reminder |
| Modify | `src/setup.ts` | Integrate non-interactive env detection, file watcher |
| Modify | `src/services/compact/compact.ts` | Integrate pre-compact checkpoint |
| Modify | `src/tools/AgentTool/` | Integrate persistent memory store |
| Test | `src/services/**/*.test.ts` | All tests |

---

### Task 1: Empty Message Sanitizer & Tool Argument Normalization

**Files:**
- Create: `src/services/message-sanitizer/emptyMessageSanitizer.ts`
- Create: `src/services/tool-normalization/toolArgNormalizer.ts`
- Test: `src/services/message-sanitizer/emptyMessageSanitizer.test.ts`
- Test: `src/services/tool-normalization/toolArgNormalizer.test.ts`

- [ ] **Step 1: Write the failing test for Empty Message Sanitizer**

```typescript
// src/services/message-sanitizer/emptyMessageSanitizer.test.ts
import { describe, test, expect } from "bun:test"
import { sanitizeMessages, PLACEHOLDER } from "./emptyMessageSanitizer"

describe("EmptyMessageSanitizer", () => {
  test("injects placeholder into empty string content", () => {
    const messages = [
      { role: "user" as const, content: "" },
    ]
    const result = sanitizeMessages(messages)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe(PLACEHOLDER)
  })

  test("injects placeholder into whitespace-only content", () => {
    const messages = [
      { role: "user" as const, content: "   " },
    ]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe(PLACEHOLDER)
  })

  test("injects placeholder into empty array content", () => {
    const messages = [
      { role: "assistant" as const, content: [] },
    ]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toEqual([{ type: "text", text: PLACEHOLDER }])
  })

  test("injects placeholder when array has no non-empty text blocks", () => {
    const messages = [
      { role: "user" as const, content: [
        { type: "tool_result", tool_use_id: "1", content: "" },
      ]},
    ]
    const result = sanitizeMessages(messages)
    const content = result[0].content as Array<{ type: string; text?: string }>
    expect(content.some((b) => b.type === "text" && b.text === PLACEHOLDER)).toBe(true)
  })

  test("preserves non-empty messages unchanged", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "world" },
    ]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe("hello")
    expect(result[1].content).toBe("world")
  })

  test("preserves system messages unchanged", () => {
    const messages = [
      { role: "system" as const, content: "" },
    ]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe("") // system messages are not sanitized
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/message-sanitizer/emptyMessageSanitizer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/message-sanitizer/emptyMessageSanitizer.ts
export const PLACEHOLDER = "[empty message — no content provided]"

interface Message {
  role: "user" | "assistant" | "system"
  content: string | Array<{ type: string; text?: string; content?: string; tool_use_id?: string }>
}

export function sanitizeMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "user" && msg.role !== "assistant") return msg

    const content = msg.content
    if (typeof content === "string" && content.trim() === "") {
      return { ...msg, content: PLACEHOLDER }
    }
    if (Array.isArray(content) && content.length === 0) {
      return { ...msg, content: [{ type: "text", text: PLACEHOLDER }] }
    }
    if (Array.isArray(content)) {
      const hasNonEmpty = content.some(
        (block) => block.type === "text" && (block as { text?: string }).text?.trim() !== ""
      )
      if (!hasNonEmpty) {
        return { ...msg, content: [...content, { type: "text", text: PLACEHOLDER }] }
      }
    }
    return msg
  })
}
```

- [ ] **Step 4: Write the failing test for Tool Argument Normalization**

```typescript
// src/services/tool-normalization/toolArgNormalizer.test.ts
import { describe, test, expect } from "bun:test"
import { normalizeToolArgs, detectParamType } from "./toolArgNormalizer"

describe("ToolArgNormalizer", () => {
  test("normalizes string to number when schema expects number", () => {
    const result = normalizeToolArgs({ count: "5" }, { count: { type: "number" } })
    expect(result.count).toBe(5)
  })

  test("normalizes comma-separated string to array", () => {
    const result = normalizeToolArgs({ files: "a.ts,b.ts,c.ts" }, { files: { type: "array" } })
    expect(result.files).toEqual(["a.ts", "b.ts", "c.ts"])
  })

  test("normalizes JSON string to object", () => {
    const result = normalizeToolArgs({ config: '{"key":"value"}' }, { config: { type: "object" } })
    expect(result.config).toEqual({ key: "value" })
  })

  test("detectParamType infers types", () => {
    expect(detectParamType("42")).toBe("number")
    expect(detectParamType("true")).toBe("boolean")
    expect(detectParamType('{"a":1}')).toBe("object")
    expect(detectParamType("a,b,c")).toBe("array")
    expect(detectParamType("hello")).toBe("string")
  })
})
```

- [ ] **Step 5: Write implementation**

```typescript
// src/services/tool-normalization/toolArgNormalizer.ts
export function detectParamType(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number"
  if (value === "true" || value === "false") return "boolean"
  if (value.startsWith("{") && value.endsWith("}")) return "object"
  if (value.startsWith("[") && value.endsWith("]")) return "array"
  if (value.includes(",")) return "array"
  return "string"
}

export function normalizeToolArgs(
  args: Record<string, unknown>,
  schema: Record<string, { type: string }>,
): Record<string, unknown> {
  const result = { ...args }
  for (const [key, expected] of Object.entries(schema)) {
    const value = result[key]
    if (value === undefined || value === null) continue
    if (typeof value !== "string") continue

    switch (expected.type) {
      case "number":
        const num = Number(value)
        if (!isNaN(num)) result[key] = num
        break
      case "boolean":
        if (value === "true") result[key] = true
        else if (value === "false") result[key] = false
        break
      case "array":
        if (value.startsWith("[") && value.endsWith("]")) {
          try { result[key] = JSON.parse(value) } catch {}
        } else if (value.includes(",")) {
          result[key] = value.split(",").map((s) => s.trim())
        }
        break
      case "object":
        if (value.startsWith("{")) {
          try { result[key] = JSON.parse(value) } catch {}
        }
        break
    }
  }
  return result
}
```

- [ ] **Step 6: Integration — wire into query.ts**

Read `src/query.ts` and add the following integration points using feature() gates:

```typescript
// At the top of queryLoop() or the main query function, add dynamic imports:
const sanitizerModule = feature('OLA_CC_EMPTY_MSG_SANITIZER')
  ? (await import('./services/message-sanitizer/emptyMessageSanitizer.js'))
  : null
const normalizerModule = feature('OLA_CC_TOOL_ARG_NORMALIZATION')
  ? (await import('./services/tool-normalization/toolArgNormalizer.js'))
  : null
```

Then at the insertion points defined in the Merge Strategy table:
1. Before API call: `if (sanitizerModule) messages = sanitizerModule.sanitizeMessages(messages)`
2. Before tool execution: `if (normalizerModule) args = normalizerModule.normalizeToolArgs(args, schema)`

- [ ] **Step 7: Run all tests**

Run: `bun test src/services/message-sanitizer/ src/services/tool-normalization/`
Expected: PASS (8 tests)

- [ ] **Step 8: Commit**

```bash
git add src/services/message-sanitizer/ src/services/tool-normalization/ src/query.ts
git commit -m "feat(infra): add EmptyMessageSanitizer and ToolArgNormalizer with query.ts integration"
```

---

### Task 2: LSP Passive Feedback

> **NOTE**: `src/services/lsp/passiveFeedback.ts` already exists (328 LOC). This task **enhances** the existing file with new capabilities — do NOT overwrite the existing implementation.

**Files:**
- Enhance: `src/services/lsp/passiveFeedback.ts` (existing 328 LOC — add new exports alongside existing code)
- Create: `src/services/lsp/passiveFeedback.test.ts`

- [ ] **Step 1: Read existing implementation**

Run: `Read src/services/lsp/passiveFeedback.ts` to understand the current exports and patterns before adding new code.

- [ ] **Step 2: Write the failing test**

```typescript
// src/services/lsp/passiveFeedback.test.ts
import { describe, test, expect } from "bun:test"
import { collectDiagnostics, formatDiagnosticsAsAttachment } from "./passiveFeedback"

describe("LspPassiveFeedback", () => {
  test("collectDiagnostics filters by severity", () => {
    const diagnostics = [
      { file: "a.ts", line: 1, column: 1, severity: "error" as const, message: "err", source: "ts" },
      { file: "a.ts", line: 2, column: 1, severity: "hint" as const, message: "hint", source: "ts" },
    ]
    const config = {
      severityFilter: ["error"],
      maxDiagnosticsPerMessage: 10,
      injectionMode: "attachment" as const,
      ignoredSources: [],
    }
    const result = collectDiagnostics(diagnostics, config)
    expect(result).toHaveLength(1)
    expect(result[0].severity).toBe("error")
  })

  test("collectDiagnostics filters by ignored sources", () => {
    const diagnostics = [
      { file: "a.ts", line: 1, column: 1, severity: "error" as const, message: "err", source: "eslint" },
    ]
    const config = {
      severityFilter: ["error"],
      maxDiagnosticsPerMessage: 10,
      injectionMode: "attachment" as const,
      ignoredSources: ["eslint"],
    }
    const result = collectDiagnostics(diagnostics, config)
    expect(result).toHaveLength(0)
  })

  test("formatDiagnosticsAsAttachment produces readable output", () => {
    const diagnostics = [
      { file: "src/index.ts", line: 10, column: 5, severity: "error" as const, message: "Type 'string' is not assignable to type 'number'", source: "typescript" },
    ]
    const output = formatDiagnosticsAsAttachment(diagnostics)
    expect(output).toContain("src/index.ts")
    expect(output).toContain("line 10")
    expect(output).toContain("Type 'string'")
  })

  test("respects maxDiagnosticsPerMessage", () => {
    const diagnostics = Array.from({ length: 20 }, (_, i) => ({
      file: "a.ts", line: i, column: 1, severity: "error" as const, message: `err ${i}`, source: "ts",
    }))
    const config = {
      severityFilter: ["error"],
      maxDiagnosticsPerMessage: 5,
      injectionMode: "attachment" as const,
      ignoredSources: [],
    }
    const result = collectDiagnostics(diagnostics, config)
    expect(result).toHaveLength(5)
  })
})
```

- [ ] **Step 3: Add new exports to existing file**

Read the existing `src/services/lsp/passiveFeedback.ts` and **append** the new functions alongside existing exports. Do NOT replace or modify existing functions. Add the following new exports:

```typescript
// Append to src/services/lsp/passiveFeedback.ts (do not replace existing code)
export interface LspPassiveFeedbackConfig {
  severityFilter: ("error" | "warning" | "information" | "hint")[]
  maxDiagnosticsPerMessage: number
  injectionMode: "attachment" | "system"
  ignoredSources: string[]
}

export function collectDiagnostics(
  diagnostics: LspDiagnostic[],
  config: LspPassiveFeedbackConfig,
): LspDiagnostic[] {
  return diagnostics
    .filter((d) => config.severityFilter.includes(d.severity))
    .filter((d) => !config.ignoredSources.includes(d.source))
    .slice(0, config.maxDiagnosticsPerMessage)
}

export function formatDiagnosticsAsAttachment(diagnostics: LspDiagnostic[]): string {
  if (diagnostics.length === 0) return ""
  const lines = diagnostics.map(
    (d) => `  ${d.file}:${d.line}:${d.column} [${d.severity}] ${d.message} (${d.source})`,
  )
  return `## LSP Diagnostics\n${lines.join("\n")}`
}
```

- [ ] **Step 4: Integration — wire into query.ts**

Read `src/query.ts` and add the following integration points using feature() gate:

```typescript
// Dynamic import with feature gate:
const lspFeedbackModule = feature('OLA_CC_LSP_PASSIVE_FEEDBACK')
  ? (await import('./services/lsp/passiveFeedback.js'))
  : null
```

Then at the LSP Feedback insertion point (after user message processing):
1. `if (lspFeedbackModule) { const diag = await lspFeedbackModule.collectDiagnostics(...); ... }`
2. Append formatted diagnostics as an attachment to the user message before sending to API

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/services/lsp/passiveFeedback.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/services/lsp/passiveFeedback.ts src/services/lsp/passiveFeedback.test.ts src/query.ts
git commit -m "feat(infra): enhance LSP passive feedback with severity filtering and query.ts integration"
```

---

### Task 3: Pre-Compact Checkpoint & Non-Interactive Env Detection

**Files:**
- Create: `src/services/compact/preCompactCheckpoint.ts`
- Create: `src/services/env-detection/nonInteractiveEnv.ts`
- Test: `src/services/compact/preCompactCheckpoint.test.ts`
- Test: `src/services/env-detection/nonInteractiveEnv.test.ts`

- [ ] **Step 1: Write the failing test for Pre-Compact Checkpoint**

```typescript
// src/services/compact/preCompactCheckpoint.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { savePreCompactCheckpoint, loadPreCompactCheckpoint } from "./preCompactCheckpoint"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

const TEST_DIR = join(import.meta.dir, "__test_checkpoint")

describe("PreCompactCheckpoint", () => {
  beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })

  test("saves and loads full checkpoint with all fields", () => {
    const state = {
      sessionId: "sess-123",
      activeMode: "autopilot",
      todoSummary: [{ id: "t1", text: "fix bug", status: "pending" }],
      wisdom: [{ key: "pattern-a", content: "always check null" }],
      backgroundTasks: [{ id: "bg1", name: "lint", status: "running", progress: 50 }],
      messageCount: 10,
    }
    savePreCompactCheckpoint(TEST_DIR, state)
    const loaded = loadPreCompactCheckpoint(TEST_DIR)
    expect(loaded).not.toBeNull()
    expect(loaded!.sessionId).toBe("sess-123")
    expect(loaded!.activeMode).toBe("autopilot")
    expect(loaded!.todoSummary).toHaveLength(1)
    expect(loaded!.todoSummary[0].text).toBe("fix bug")
    expect(loaded!.wisdom).toHaveLength(1)
    expect(loaded!.backgroundTasks[0].progress).toBe(50)
    expect(loaded!.messageCount).toBe(10)
    expect(loaded!.sizeBytes).toBeGreaterThan(0)
    expect(loaded!.timestamp).toBeGreaterThan(0)
  })

  test("returns null when no checkpoint exists", () => {
    expect(loadPreCompactCheckpoint(TEST_DIR)).toBeNull()
  })

  test("defaults activeMode to none when not provided", () => {
    const state = {
      sessionId: "sess-456",
      todoSummary: [],
      wisdom: [],
      backgroundTasks: [],
      messageCount: 0,
    }
    savePreCompactCheckpoint(TEST_DIR, state)
    const loaded = loadPreCompactCheckpoint(TEST_DIR)
    expect(loaded!.activeMode).toBe("none")
  })
})
```

- [ ] **Step 2: Write the failing test for Non-Interactive Env**

```typescript
// src/services/env-detection/nonInteractiveEnv.test.ts
import { describe, test, expect } from "bun:test"
import { isNonInteractive } from "./nonInteractiveEnv"

describe("NonInteractiveEnv", () => {
  test("detects CI environment", () => {
    process.env.CI = "true"
    expect(isNonInteractive()).toBe(true)
    delete process.env.CI
  })

  test("detects GITHUB_ACTIONS", () => {
    process.env.GITHUB_ACTIONS = "true"
    expect(isNonInteractive()).toBe(true)
    delete process.env.GITHUB_ACTIONS
  })

  test("returns false in interactive terminal", () => {
    // In test environment, TTY detection may vary
    const result = isNonInteractive()
    expect(typeof result).toBe("boolean")
  })
})
```

- [ ] **Step 3: Write implementations**

```typescript
// src/services/compact/preCompactCheckpoint.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"

interface PreCompactCheckpoint {
  timestamp: number
  sessionId: string
  activeMode: string
  todoSummary: Array<{ id: string; text: string; status: string }>
  wisdom: Array<{ key: string; content: string }>
  backgroundTasks: Array<{ id: string; name: string; status: string; progress?: number }>
  messageCount: number
  sizeBytes: number
}

interface CheckpointInput {
  sessionId: string
  activeMode?: string
  todoSummary: Array<{ id: string; text: string; status: string }>
  wisdom: Array<{ key: string; content: string }>
  backgroundTasks: Array<{ id: string; name: string; status: string; progress?: number }>
  messageCount: number
}

export function savePreCompactCheckpoint(directory: string, state: CheckpointInput): PreCompactCheckpoint {
  const dir = join(directory, ".claude", "checkpoints")
  mkdirSync(dir, { recursive: true })

  const checkpoint: PreCompactCheckpoint = {
    timestamp: Date.now(),
    sessionId: state.sessionId,
    activeMode: state.activeMode ?? "none",
    todoSummary: state.todoSummary,
    wisdom: state.wisdom,
    backgroundTasks: state.backgroundTasks,
    messageCount: state.messageCount,
    sizeBytes: 0,
  }

  const serialized = JSON.stringify(checkpoint, null, 2)
  checkpoint.sizeBytes = serialized.length
  // Re-serialize with correct sizeBytes
  writeFileSync(join(dir, `pre-compact-${checkpoint.timestamp}.json`), JSON.stringify(checkpoint, null, 2))
  return checkpoint
}

export function loadPreCompactCheckpoint(directory: string): PreCompactCheckpoint | null {
  const dir = join(directory, ".claude", "checkpoints")
  if (!existsSync(dir)) return null
  // Find the most recent checkpoint file
  const { readdirSync } = require("fs")
  const files = readdirSync(dir).filter((f: string) => f.startsWith("pre-compact-") && f.endsWith(".json")).sort().reverse()
  if (files.length === 0) return null
  return JSON.parse(readFileSync(join(dir, files[0]), "utf-8"))
}
```

```typescript
// src/services/env-detection/nonInteractiveEnv.ts
const CI_ENV_VARS = [
  "CI", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL", "CIRCLECI",
  "TRAVIS", "BUILDKITE", "CODEBUILD_BUILD_ID", "TF_BUILD",
]

export function isNonInteractive(): boolean {
  // Check CI environment variables
  for (const envVar of CI_ENV_VARS) {
    if (process.env[envVar]) return true
  }
  // Check if stdin is a TTY
  if (!process.stdin.isTTY) return true
  return false
}

export function applyNonInteractiveDefaults(): { skipPermissions: boolean; autoApprove: boolean } {
  return isNonInteractive()
    ? { skipPermissions: true, autoApprove: true }
    : { skipPermissions: false, autoApprove: false }
}
```

- [ ] **Step 4: Integration — wire into compact.ts and setup.ts**

For Pre-Compact Checkpoint (compact.ts):
```typescript
const checkpointModule = feature('OLA_CC_PRE_COMPACT_CHECKPOINT')
  ? (await import('./preCompactCheckpoint.js'))
  : null
// At the beginning of compact flow, before compression:
if (checkpointModule) checkpointModule.savePreCompactCheckpoint(sessionDir, state)
```

For Non-Interactive Env (setup.ts):
```typescript
const envModule = feature('OLA_CC_NON_INTERACTIVE_ENV')
  ? (await import('./services/env-detection/nonInteractiveEnv.js'))
  : null
// Early in setup: if (envModule) envModule.applyNonInteractiveEnv()
```

- [ ] **Step 5: Run all tests**

Run: `bun test src/services/compact/preCompactCheckpoint.test.ts src/services/env-detection/nonInteractiveEnv.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/services/compact/preCompactCheckpoint.ts src/services/compact/preCompactCheckpoint.test.ts src/services/env-detection/ src/services/compact/compact.ts src/setup.ts
git commit -m "feat(infra): add PreCompactCheckpoint and NonInteractiveEnv with compact.ts/setup.ts integration"
```

---

### Task 4: Agent Usage Reminder & File Change Watcher

**Files:**
- Create: `src/services/usage-reminder/usageReminder.ts`
- Create: `src/services/file-watcher/fileChangedWatcher.ts`
- Test: `src/services/usage-reminder/usageReminder.test.ts`
- Test: `src/services/file-watcher/fileChangedWatcher.test.ts`

- [ ] **Step 1: Write the failing test for Usage Reminder**

```typescript
// src/services/usage-reminder/usageReminder.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { UsageReminder } from "./usageReminder"

describe("UsageReminder", () => {
  let reminder: UsageReminder

  beforeEach(() => {
    reminder = new UsageReminder({
      monitoredTools: ["Grep", "Glob", "WebSearch"],
      threshold: 3,
      messageTemplate: "You've used {{toolName}} {{count}} times. Consider delegating to an agent.",
      cooldownSeconds: 60,
      disableInSubagent: true,
    })
  })

  test("triggers reminder after threshold consecutive calls", () => {
    expect(reminder.recordCall("Grep")).toBeNull()
    expect(reminder.recordCall("Grep")).toBeNull()
    const msg = reminder.recordCall("Grep")
    expect(msg).toContain("Grep")
    expect(msg).toContain("3")
  })

  test("does not trigger for unmonitored tools", () => {
    for (let i = 0; i < 10; i++) {
      expect(reminder.recordCall("Read")).toBeNull()
    }
  })

  test("resets counter when different tool is called", () => {
    reminder.recordCall("Grep")
    reminder.recordCall("Glob") // different tool resets Grep counter
    expect(reminder.recordCall("Grep")).toBeNull() // only 1 call, not 3
  })

  test("respects cooldown period", () => {
    for (let i = 0; i < 3; i++) reminder.recordCall("Grep")
    const first = reminder.recordCall("Grep") // triggers (4th call)
    // During cooldown, no new reminders
    for (let i = 0; i < 5; i++) {
      expect(reminder.recordCall("Grep")).toBeNull()
    }
  })

  test("disableInSubagent suppresses reminders", () => {
    reminder.setSubagent(true)
    for (let i = 0; i < 10; i++) {
      expect(reminder.recordCall("Grep")).toBeNull()
    }
  })

  test("re-enables after subagent exits", () => {
    reminder.setSubagent(true)
    for (let i = 0; i < 5; i++) reminder.recordCall("Grep")
    reminder.setSubagent(false)
    // Counter was tracked but suppressed; now triggers
    const msg = reminder.recordCall("Grep")
    expect(msg).not.toBeNull()
  })
})
```

- [ ] **Step 2: Write the failing test for File Change Watcher**

```typescript
// src/services/file-watcher/fileChangedWatcher.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { snapshotFiles, detectChanges } from "./fileChangedWatcher"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"

const TEST_DIR = join(import.meta.dir, "__test_watcher")

describe("FileChangedWatcher", () => {
  beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })

  test("snapshotFiles captures file hashes", async () => {
    writeFileSync(join(TEST_DIR, "a.ts"), "content a")
    const snapshot = await snapshotFiles([join(TEST_DIR, "a.ts")])
    expect(snapshot.size).toBe(1)
    expect(snapshot.has(join(TEST_DIR, "a.ts"))).toBe(true)
  })

  test("detectChanges identifies modified files", async () => {
    const path = join(TEST_DIR, "a.ts")
    writeFileSync(path, "original")
    const before = await snapshotFiles([path])
    writeFileSync(path, "modified")
    const after = await snapshotFiles([path])
    const changes = detectChanges(before, after)
    expect(changes).toContain(path)
  })

  test("detectChanges returns empty for unchanged files", async () => {
    const path = join(TEST_DIR, "a.ts")
    writeFileSync(path, "same")
    const before = await snapshotFiles([path])
    const after = await snapshotFiles([path])
    const changes = detectChanges(before, after)
    expect(changes).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Write implementations**

```typescript
// src/services/usage-reminder/usageReminder.ts
interface UsageReminderConfig {
  monitoredTools: string[]
  threshold: number
  messageTemplate: string
  cooldownSeconds: number
  disableInSubagent: boolean
}

export class UsageReminder {
  private config: UsageReminderConfig
  private counters: Map<string, number> = new Map()
  private lastReminderTime: Map<string, number> = new Map()
  private isSubagent = false

  constructor(config: UsageReminderConfig) {
    this.config = config
  }

  setSubagent(isSubagent: boolean): void {
    this.isSubagent = isSubagent
  }

  recordCall(toolName: string): string | null {
    if (!this.config.monitoredTools.includes(toolName)) {
      return null
    }

    // Track consecutive calls: increment if same tool, reset if different
    const prevTool = Array.from(this.counters.entries()).find(([_, c]) => c > 0)?.[0]
    if (prevTool && prevTool !== toolName) {
      this.counters.clear()
    }

    const count = (this.counters.get(toolName) ?? 0) + 1
    this.counters.set(toolName, count)

    // Check threshold
    if (count < this.config.threshold) return null

    // Check subagent suppression
    if (this.config.disableInSubagent && this.isSubagent) return null

    // Check cooldown
    const lastTime = this.lastReminderTime.get(toolName) ?? 0
    const cooldownMs = this.config.cooldownSeconds * 1000
    if (Date.now() - lastTime < cooldownMs) return null

    // Trigger reminder
    this.lastReminderTime.set(toolName, Date.now())
    return this.config.messageTemplate
      .replace("{{toolName}}", toolName)
      .replace("{{count}}", String(count))
  }
}
```

```typescript
// src/services/file-watcher/fileChangedWatcher.ts
import { readFileSync, statSync } from "fs"
import { createHash } from "crypto"

type FileHash = string

export async function snapshotFiles(paths: string[]): Promise<Map<string, FileHash>> {
  const snapshot = new Map<string, FileHash>()
  for (const path of paths) {
    try {
      const content = readFileSync(path)
      const hash = createHash("sha256").update(content).digest("hex")
      snapshot.set(path, hash)
    } catch {
      // File may not exist
    }
  }
  return snapshot
}

export function detectChanges(
  before: Map<string, FileHash>,
  after: Map<string, FileHash>,
): string[] {
  const changes: string[] = []
  for (const [path, hash] of after) {
    const prevHash = before.get(path)
    if (prevHash !== hash) changes.push(path)
  }
  return changes
}
```

- [ ] **Step 4: Integration — wire into query.ts and setup.ts**

For UsageReminder (query.ts, at the Usage Reminder insertion point):
```typescript
const usageReminderModule = feature('OLA_CC_AGENT_USAGE_REMINDER')
  ? (await import('./services/usage-reminder/usageReminder.js'))
  : null
// Create instance once, then after each tool call:
if (usageReminderModule) { reminder.recordCall(toolName) }
```

For File Change Watcher (setup.ts):
```typescript
const fileWatcherModule = feature('OLA_CC_FILE_CHANGE_WATCHER')
  ? (await import('./services/file-watcher/fileChangedWatcher.js'))
  : null
// Initialize at session start, register dispose() in cleanup
```

- [ ] **Step 5: Run all tests**

Run: `bun test src/services/usage-reminder/ src/services/file-watcher/`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/services/usage-reminder/ src/services/file-watcher/ src/query.ts src/setup.ts
git commit -m "feat(infra): add UsageReminder and FileChangedWatcher with query.ts/setup.ts integration"
```

---

### Task 5: Persistent Agent Memory Store & Post-Sampling Hook

**Files:**
- Create: `src/services/agent-memory/persistentMemoryStore.ts`
- Create: `src/services/post-sampling/postSamplingHook.ts`
- Test: `src/services/agent-memory/persistentMemoryStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/agent-memory/persistentMemoryStore.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { PersistentMemoryStore } from "./persistentMemoryStore"
import { rmSync, mkdirSync } from "fs"
import { join } from "path"

const TEST_DIR = join(import.meta.dir, "__test_memory")

describe("PersistentMemoryStore", () => {
  beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }) })

  test("writes and reads entry in project scope", async () => {
    const store = new PersistentMemoryStore(TEST_DIR)
    await store.write("project", "key1", { content: "value1", tags: ["tag1"], source: "manual" })
    const entry = await store.read("project", "key1")
    expect(entry).not.toBeUndefined()
    expect(entry!.content).toBe("value1")
    expect(entry!.tags).toContain("tag1")
    expect(entry!.source).toBe("manual")
    expect(entry!.createdAt).toBeGreaterThan(0)
    expect(entry!.updatedAt).toBeGreaterThan(0)
  })

  test("returns undefined for missing keys", async () => {
    const store = new PersistentMemoryStore(TEST_DIR)
    expect(await store.read("project", "missing")).toBeUndefined()
  })

  test("supports three scopes (user, project, local)", async () => {
    const store = new PersistentMemoryStore(TEST_DIR)
    await store.write("user", "pref", { content: "dark mode", tags: ["ui"], source: "manual" })
    await store.write("project", "rule", { content: "use bun", tags: ["build"], source: "auto-extract" })
    await store.write("local", "temp", { content: "debug info", tags: [], source: "consolidation" })

    expect((await store.read("user", "pref"))!.content).toBe("dark mode")
    expect((await store.read("project", "rule"))!.source).toBe("auto-extract")
    expect((await store.read("local", "temp"))!.content).toBe("debug info")
  })

  test("list returns MemoryIndex entries", async () => {
    const store = new PersistentMemoryStore(TEST_DIR)
    await store.write("project", "a", { content: "alpha", tags: ["t1"], source: "manual" })
    await store.write("project", "b", { content: "beta", tags: ["t2"], source: "manual" })
    const index = await store.list("project")
    expect(index).toHaveLength(2)
    expect(index.map((i) => i.key)).toContain("a")
    expect(index.map((i) => i.key)).toContain("b")
  })

  test("delete removes entry silently if missing", async () => {
    const store = new PersistentMemoryStore(TEST_DIR)
    await store.delete("project", "nonexistent") // should not throw
    await store.write("project", "k", { content: "v", tags: [], source: "manual" })
    await store.delete("project", "k")
    expect(await store.read("project", "k")).toBeUndefined()
  })

  test("persists across instances", async () => {
    const store1 = new PersistentMemoryStore(TEST_DIR)
    await store1.write("project", "key1", { content: "value1", tags: [], source: "manual" })

    const store2 = new PersistentMemoryStore(TEST_DIR)
    const entry = await store2.read("project", "key1")
    expect(entry!.content).toBe("value1")
  })

  test("supports remote memory dir via CLAUDE_CODE_REMOTE_MEMORY_DIR", async () => {
    const remoteDir = join(TEST_DIR, "remote-mount")
    mkdirSync(remoteDir, { recursive: true })
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = remoteDir
    try {
      const store = new PersistentMemoryStore(TEST_DIR)
      await store.write("user", "remote-key", { content: "remote-value", tags: [], source: "manual" })
      const entry = await store.read("user", "remote-key")
      expect(entry!.content).toBe("remote-value")
    } finally {
      delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/agent-memory/persistentMemoryStore.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/services/agent-memory/persistentMemoryStore.ts
// Uses fs/promises for consistency with async method signatures
import { readFile, writeFile, mkdir, readdir, unlink, stat } from "fs/promises"
import { join } from "path"

type Scope = "user" | "project" | "local"

interface MemoryEntry {
  content: string
  createdAt: number
  updatedAt: number
  tags: string[]
  source: "auto-extract" | "manual" | "consolidation"
}

interface MemoryIndex {
  key: string
  summary: string
  updatedAt: number
  tags: string[]
}

export class PersistentMemoryStore {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  private getScopeDir(scope: Scope): string {
    if (scope === "user") {
      const remoteDir = process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
      // Note: remote dir existence check is async, done in the calling method
      if (remoteDir) return join(remoteDir, "agent-memory")
      return join(this.baseDir, ".claude", "agent-memory")
    }
    if (scope === "local") return join(this.baseDir, ".claude", "local", "agent-memory")
    return join(this.baseDir, ".claude", "agent-memory")
  }

  private getEntryPath(scope: Scope, key: string): string {
    return join(this.getScopeDir(scope), `${key}.json`)
  }

  /** Check if a path exists (async) */
  private async pathExists(p: string): Promise<boolean> {
    try { await stat(p); return true } catch { return false }
  }

  async read(scope: Scope, key: string): Promise<MemoryEntry | undefined> {
    const path = this.getEntryPath(scope, key)
    if (!(await this.pathExists(path))) return undefined
    try {
      return JSON.parse(await readFile(path, "utf-8"))
    } catch {
      return undefined
    }
  }

  async write(scope: Scope, key: string, entry: Omit<MemoryEntry, "createdAt" | "updatedAt">): Promise<void> {
    const dir = this.getScopeDir(scope)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${key}.json`)
    const now = Date.now()
    const existing = await this.read(scope, key)
    const fullEntry: MemoryEntry = {
      ...entry,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await writeFile(path, JSON.stringify(fullEntry, null, 2))
  }

  async list(scope: Scope): Promise<MemoryIndex[]> {
    const dir = this.getScopeDir(scope)
    if (!(await this.pathExists(dir))) return []
    const files = await readdir(dir)
    const results: MemoryIndex[] = []
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      try {
        const entry: MemoryEntry = JSON.parse(await readFile(join(dir, f), "utf-8"))
        results.push({
          key: f.slice(0, -5),
          summary: entry.content.slice(0, 100),
          updatedAt: entry.updatedAt,
          tags: entry.tags,
        })
      } catch {
        // skip malformed files
      }
    }
    return results
  }

  async delete(scope: Scope, key: string): Promise<void> {
    const path = this.getEntryPath(scope, key)
    if (await this.pathExists(path)) await unlink(path)
  }
}
```

```typescript
// src/services/post-sampling/postSamplingHook.ts
type HookFn = (response: string, context: { turnCount: number }) => Promise<string | null>

const hooks: HookFn[] = []

export function registerPostSamplingHook(hook: HookFn): void {
  hooks.push(hook)
}

export async function executePostSamplingHooks(
  response: string,
  context: { turnCount: number },
): Promise<string | null> {
  for (const hook of hooks) {
    const result = await hook(response, context)
    if (result) return result
  }
  return null
}
```

- [ ] **Step 4: Integration — wire into AgentTool and query.ts**

For PersistentMemoryStore (AgentTool/):
```typescript
const memoryModule = feature('OLA_CC_PERSISTENT_AGENT_MEMORY')
  ? (await import('../services/agent-memory/persistentMemoryStore.js'))
  : null
// Initialize store in agent setup, agents call store.read/write
```

For PostSamplingHook (query.ts, at the Post-Sampling insertion point):
```typescript
const postSamplingModule = feature('OLA_CC_POST_SAMPLING_HOOK')
  ? (await import('./services/post-sampling/postSamplingHook.js'))
  : null
// After model response: if (postSamplingModule) postSamplingModule.executePostSamplingHooks(ctx)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/services/agent-memory/persistentMemoryStore.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add src/services/agent-memory/ src/services/post-sampling/ src/tools/AgentTool/ src/query.ts
git commit -m "feat(infra): add PersistentMemoryStore and PostSamplingHook with AgentTool/query.ts integration"
```

---

### Task 6: Session History Search & Model Benchmarking

**Files:**
- Create: `src/services/session-history/sessionHistorySearch.ts`
- Create: `src/services/benchmarking/modelBenchmark.ts`
- Test: `src/services/session-history/sessionHistorySearch.test.ts`

- [ ] **Step 1: Write the failing test for Session History Search**

```typescript
// src/services/session-history/sessionHistorySearch.test.ts
import { describe, test, expect } from "bun:test"
import { parseSessionJsonl, searchSessions, parseTimeRange } from "./sessionHistorySearch"

describe("SessionHistorySearch", () => {
  test("parseSessionJsonl parses JSONL transcript lines", () => {
    const jsonl = [
      '{"role":"user","content":"fix the auth bug"}',
      '{"role":"assistant","content":"I will fix the auth bug"}',
      '{"role":"user","content":"also add dark mode"}',
    ].join("\n")
    const messages = parseSessionJsonl(jsonl)
    expect(messages).toHaveLength(3)
    expect(messages[0].role).toBe("user")
    expect(messages[0].content).toBe("fix the auth bug")
  })

  test("parseSessionJsonl handles malformed lines gracefully", () => {
    const jsonl = '{"role":"user","content":"ok"}\nNOT JSON\n{"role":"assistant","content":"hi"}'
    const messages = parseSessionJsonl(jsonl)
    expect(messages).toHaveLength(2) // skips malformed line
  })

  test("searchSessions finds matching sessions with snippets", () => {
    const sessions = [
      { sessionId: "s1", projectPath: "/proj", timestamp: 1000, messages: [{ role: "user", content: "fix the auth bug" }] },
      { sessionId: "s2", projectPath: "/proj", timestamp: 2000, messages: [{ role: "user", content: "add dark mode" }] },
    ]
    const results = searchSessions(sessions, { pattern: "auth", limit: 10 })
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe("s1")
    expect(results[0].matches[0].snippet).toContain("auth")
  })

  test("searchSessions filters by time range", () => {
    const sessions = [
      { sessionId: "s1", projectPath: "/proj", timestamp: Date.now() - 86400000 * 10, messages: [{ role: "user", content: "old session" }] },
      { sessionId: "s2", projectPath: "/proj", timestamp: Date.now() - 3600000, messages: [{ role: "user", content: "recent session" }] },
    ]
    const results = searchSessions(sessions, { pattern: "session", timeRange: { from: "7d" }, limit: 10 })
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe("s2")
  })

  test("searchSessions filters by projectPath", () => {
    const sessions = [
      { sessionId: "s1", projectPath: "/proj-a", timestamp: 1000, messages: [{ role: "user", content: "task in project a" }] },
      { sessionId: "s2", projectPath: "/proj-b", timestamp: 1000, messages: [{ role: "user", content: "task in project b" }] },
    ]
    const results = searchSessions(sessions, { pattern: "task", projectPath: "/proj-a", limit: 10 })
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe("s1")
  })

  test("parseTimeRange parses relative time strings", () => {
    const range = parseTimeRange("7d")
    expect(range.from).toBeGreaterThan(Date.now() - 86400000 * 8)
    expect(range.from).toBeLessThan(Date.now() - 86400000 * 6)
  })

  test("searchSessions returns empty for no match", () => {
    const sessions = [
      { sessionId: "s1", projectPath: "/proj", timestamp: 1000, messages: [{ role: "user", content: "hello" }] },
    ]
    const results = searchSessions(sessions, { pattern: "nonexistent", limit: 10 })
    expect(results).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Write the failing test for Model Benchmarking**

```typescript
// src/services/benchmarking/modelBenchmark.test.ts
import { describe, test, expect, mock } from "bun:test"
import { benchmarkModel, formatBenchmarkResult } from "./modelBenchmark"

describe("ModelBenchmark", () => {
  test("benchmarkModel measures latency and tokens", async () => {
    // Mock API client that returns predictable results
    const mockClient = {
      query: mock(async () => ({
        text: "Hello world response",
        usage: { inputTokens: 10, outputTokens: 5 },
      })),
    }
    const result = await benchmarkModel("test-model", "Hello", { iterations: 1, client: mockClient as any })
    expect(result.model).toBe("test-model")
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.inputTokens).toBe(10)
    expect(result.outputTokens).toBe(5)
    expect(result.costEstimate).toBeGreaterThanOrEqual(0)
  })

  test("benchmarkModel runs multiple iterations and averages", async () => {
    let callCount = 0
    const mockClient = {
      query: mock(async () => {
        callCount++
        return {
          text: `Response ${callCount}`,
          usage: { inputTokens: 10, outputTokens: 5 + callCount },
        }
      }),
    }
    const result = await benchmarkModel("test-model", "Hello", { iterations: 3, client: mockClient as any })
    expect(callCount).toBe(3)
    expect(result.iterations).toBe(3)
    expect(result.avgLatencyMs).toBeGreaterThanOrEqual(0)
  })

  test("formatBenchmarkResult produces readable output", () => {
    const result = {
      model: "test-model",
      latencyMs: 150,
      inputTokens: 100,
      outputTokens: 50,
      costEstimate: 0.001,
      iterations: 1,
      avgLatencyMs: 150,
    }
    const output = formatBenchmarkResult(result)
    expect(output).toContain("test-model")
    expect(output).toContain("150")
    expect(output).toContain("token")
  })
})
```

- [ ] **Step 3: Write implementation for Session History Search**

```typescript
// src/services/session-history/sessionHistorySearch.ts
import { readFileSync, readdirSync, existsSync } from "fs"
import { join } from "path"

interface SessionMessage {
  role: string
  content: string
}

interface SessionEntry {
  sessionId: string
  projectPath: string
  timestamp: number
  messages: SessionMessage[]
}

interface SearchQuery {
  pattern: string
  timeRange?: { from?: string; to?: string }
  projectPath?: string
  includeWorktrees?: boolean
  limit: number
}

interface SearchResult {
  sessionId: string
  projectPath: string
  timestamp: number
  matches: Array<{ role: string; snippet: string; lineIndex: number }>
  score: number
}

/** Parse a JSONL transcript file into session messages */
export function parseSessionJsonl(jsonl: string): SessionMessage[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as SessionMessage
      } catch {
        return null
      }
    })
    .filter((m): m is SessionMessage => m !== null && typeof m.role === "string")
}

/** Parse relative time strings like "30m", "2h", "7d" into absolute timestamps */
export function parseTimeRange(range: string): { from: number; to: number } {
  const match = range.match(/^(\d+)(m|h|d)$/)
  if (!match) return { from: 0, to: Date.now() }
  const amount = parseInt(match[1])
  const unit = match[2]
  const multipliers: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 }
  const ms = amount * (multipliers[unit] ?? 60000)
  return { from: Date.now() - ms, to: Date.now() }
}

/** Search across session transcripts */
export function searchSessions(sessions: SessionEntry[], query: SearchQuery): SearchResult[] {
  const regex = new RegExp(query.pattern, "i")
  const timeFilter = query.timeRange?.from ? parseTimeRange(query.timeRange.from) : null

  const results: SearchResult[] = []

  for (const session of sessions) {
    // Time range filter
    if (timeFilter && session.timestamp < timeFilter.from) continue

    // Project path filter
    if (query.projectPath && !session.projectPath.startsWith(query.projectPath)) continue

    const matches: SearchResult["matches"] = []
    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i]
      if (regex.test(msg.content)) {
        const idx = msg.content.search(regex)
        const start = Math.max(0, idx - 50)
        const end = Math.min(msg.content.length, idx + query.pattern.length + 50)
        matches.push({
          role: msg.role,
          snippet: msg.content.slice(start, end),
          lineIndex: i,
        })
      }
    }

    if (matches.length > 0) {
      results.push({
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        timestamp: session.timestamp,
        matches,
        score: matches.length,
      })
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, query.limit)
}
```

```typescript
// src/services/benchmarking/modelBenchmark.ts
interface BenchmarkResult {
  model: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  costEstimate: number
  iterations: number
  avgLatencyMs: number
  timedOut: number  // count of iterations that exceeded timeoutMs
}

interface BenchmarkOptions {
  iterations?: number
  timeoutMs?: number  // per-iteration timeout (default: 30000ms)
  client?: { query: (prompt: string, model: string) => Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> }
}

/** Estimate cost based on token counts (rough Anthropic pricing) */
function estimateCost(inputTokens: number, outputTokens: number): number {
  const inputCostPer1M = 3.0   // $3 per 1M input tokens (Sonnet-tier)
  const outputCostPer1M = 15.0 // $15 per 1M output tokens
  return (inputTokens * inputCostPer1M + outputTokens * outputCostPer1M) / 1_000_000
}

export async function benchmarkModel(
  model: string,
  testPrompt: string,
  options?: BenchmarkOptions,
): Promise<BenchmarkResult> {
  const iterations = options?.iterations ?? 1
  const timeoutMs = options?.timeoutMs ?? 30000
  const client = options?.client
  const latencies: number[] = []
  let totalInput = 0
  let totalOutput = 0
  let timedOut = 0

  for (let i = 0; i < iterations; i++) {
    const start = Date.now()
    if (client) {
      // Timeout strategy: AbortController with per-iteration timeout
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        // Pass signal if client supports it; otherwise race with timeout
        const result = await Promise.race([
          client.query(testPrompt, model),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () =>
              reject(new Error(`Benchmark iteration ${i + 1} timed out after ${timeoutMs}ms`))
            )
          }),
        ])
        clearTimeout(timer)
        const latency = Date.now() - start
        latencies.push(latency)
        totalInput += result.usage.inputTokens
        totalOutput += result.usage.outputTokens
      } catch (err) {
        clearTimeout(timer)
        if (err instanceof Error && err.message.includes("timed out")) {
          timedOut++
          latencies.push(timeoutMs) // record timeout as max latency
        } else {
          throw err
        }
      }
    } else {
      // Without a client, measure overhead only (for testing)
      latencies.push(Date.now() - start)
      totalInput += Math.ceil(testPrompt.length / 4)
      totalOutput += 0
    }
  }

  const avgLatency = latencies.reduce((a, b) => a + b, 0) / iterations
  const avgInput = Math.round(totalInput / iterations)
  const avgOutput = Math.round(totalOutput / iterations)

  return {
    model,
    latencyMs: latencies[0],
    inputTokens: avgInput,
    outputTokens: avgOutput,
    costEstimate: estimateCost(avgInput, avgOutput),
    iterations,
    avgLatencyMs: avgLatency,
    timedOut,
  }
}

export function formatBenchmarkResult(result: BenchmarkResult): string {
  const lines = [
    `## Benchmark: ${result.model}`,
    `- Latency: ${result.latencyMs}ms (avg: ${result.avgLatencyMs.toFixed(0)}ms over ${result.iterations} iterations)`,
    `- Tokens: ${result.inputTokens} input / ${result.outputTokens} output`,
    `- Estimated cost: $${result.costEstimate.toFixed(6)}`,
  ]
  return lines.join("\n")
}
```

- [ ] **Step 4: Integration — add /search and /benchmark commands**

For Session History Search:
1. Create `src/commands/search/search.ts` — a new `/search` slash command that accepts a query string and optional time range
2. The command reads JSONL transcript files from `~/.claude/projects/` and calls `searchSessions()` to find matches
3. Display results with session ID, timestamp, and matching snippets

For Model Benchmarking:
1. Create `src/commands/benchmark/benchmark.ts` — a new `/benchmark` slash command that accepts a model name and optional prompt
2. The command calls `benchmarkModel()` with the current API client and displays latency, tokens, and cost

- [ ] **Step 5: Run all tests**

Run: `bun test src/services/session-history/sessionHistorySearch.test.ts src/services/benchmarking/modelBenchmark.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Commit**

```bash
git add src/services/session-history/ src/services/benchmarking/ src/commands/search/ src/commands/benchmark/
git commit -m "feat(infra): add SessionHistorySearch and ModelBenchmark with /search and /benchmark commands"
```

---

### Task 7: MiniMax Provider Integration

**Files:**
- Create: `src/utils/model/minimaxModels.ts`
- Create: `src/services/api/minimaxClient.ts`
- Modify: `src/services/api/client.ts` — add `CLAUDE_CODE_USE_MINIMAX` provider branch
- Test: `src/utils/model/minimaxModels.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/utils/model/minimaxModels.test.ts
import { describe, test, expect } from "bun:test"
import { MINIMAX_MODELS, getMinimaxModel, isMinimaxModel } from "./minimaxModels"

describe("MiniMaxModels", () => {
  test("MINIMAX_MODELS contains M2/M2.5/M3 models", () => {
    const names = MINIMAX_MODELS.map((m) => m.id)
    expect(names).toContain("minimax-m2")
    expect(names).toContain("minimax-m2.5")
    expect(names).toContain("minimax-m3")
  })

  test("getMinimaxModel returns model config", () => {
    const model = getMinimaxModel("minimax-m2")
    expect(model).not.toBeNull()
    expect(model!.provider).toBe("minimax")
    expect(model!.contextWindow).toBeGreaterThan(0)
  })

  test("isMinimaxModel detects MiniMax model names", () => {
    expect(isMinimaxModel("minimax-m2")).toBe(true)
    expect(isMinimaxModel("minimax-m3")).toBe(true)
    expect(isMinimaxModel("claude-3-opus")).toBe(false)
    expect(isMinimaxModel("gpt-4")).toBe(false)
  })

  test("getMinimaxModel returns null for unknown models", () => {
    expect(getMinimaxModel("minimax-unknown")).toBeNull()
  })
})
```

- [ ] **Step 2: Write implementation**

```typescript
// src/utils/model/minimaxModels.ts
interface MinimaxModelConfig {
  id: string
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  inputPricePer1M: number
  outputPricePer1M: number
}

export const MINIMAX_MODELS: MinimaxModelConfig[] = [
  {
    id: "minimax-m2",
    displayName: "MiniMax M2",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputPricePer1M: 1.0,
    outputPricePer1M: 5.0,
  },
  {
    id: "minimax-m2.5",
    displayName: "MiniMax M2.5",
    contextWindow: 256000,
    maxOutputTokens: 16384,
    inputPricePer1M: 2.0,
    outputPricePer1M: 8.0,
  },
  {
    id: "minimax-m3",
    displayName: "MiniMax M3",
    contextWindow: 512000,
    maxOutputTokens: 32768,
    inputPricePer1M: 4.0,
    outputPricePer1M: 16.0,
  },
]

const MODEL_MAP = new Map(MINIMAX_MODELS.map((m) => [m.id, m]))

export function getMinimaxModel(id: string): MinimaxModelConfig | null {
  return MODEL_MAP.get(id) ?? null
}

export function isMinimaxModel(id: string): boolean {
  return id.startsWith("minimax-")
}
```

- [ ] **Step 3: Write MiniMax API client (reuse OpenAI adapter)**

> **NOTE**: MiniMax uses an OpenAI-compatible API format (`/v1/chat/completions`). Instead of creating a separate client, reuse the existing `createOpenAICompatibleShimClient` from `src/services/api/openai.ts`. This avoids code duplication and inherits all existing OpenAI adapter features (retry, error handling, streaming).

```typescript
// src/services/api/minimaxClient.ts
// MiniMax is OpenAI-compatible — reuse the existing OpenAI shim client
import { createOpenAICompatibleShimClient } from "./openai"
import { isMinimaxModel, getMinimaxModel } from "../../utils/model/minimaxModels"

interface MinimaxClientConfig {
  apiKey: string
  baseUrl: string  // e.g. "https://api.minimax.chat"
}

export function createMinimaxClient(config: MinimaxClientConfig) {
  // Delegate to the existing OpenAI-compatible shim
  return createOpenAICompatibleShimClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    // MiniMax uses the same /v1/chat/completions endpoint as OpenAI
    modelAdapter: (model: string) => {
      const modelConfig = getMinimaxModel(model)
      if (!modelConfig) throw new Error(`Unknown MiniMax model: ${model}`)
      return modelConfig.id
    },
  })
}
```

- [ ] **Step 4: Integration — add provider branch to client.ts**

Read `src/services/api/client.ts` and add a `CLAUDE_CODE_USE_MINIMAX` branch in the provider selection logic using feature() gate:

```typescript
// In client.ts, inside the provider selection chain:
if (feature('OLA_CC_MINIMAX_PROVIDER') && isEnvTruthy(process.env.CLAUDE_CODE_USE_MINIMAX)) {
  const { createMinimaxClient } = await import('./minimaxClient.js')
  return createMinimaxClient({ apiKey: process.env.MINIMAX_API_KEY!, model })
}
```

- [ ] **Step 5: Run tests**

Run: `bun test src/utils/model/minimaxModels.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/utils/model/minimaxModels.ts src/utils/model/minimaxModels.test.ts src/services/api/minimaxClient.ts src/services/api/client.ts
git commit -m "feat(infra): add MiniMax provider with M2/M2.5/M3 model support"
```

---

### Task 8: Feature Flags Registration

**Files:**
- Modify: `scripts/build.ts`

- [ ] **Step 1: Add feature flags (with OLA_CC_ prefix per design doc)**

```typescript
// In scripts/build.ts, add to experimentalFeatures array:
"OLA_CC_LSP_PASSIVE_FEEDBACK",
"OLA_CC_TOOL_ARG_NORMALIZATION",
"OLA_CC_MINIMAX_PROVIDER",
"OLA_CC_PERSISTENT_AGENT_MEMORY",
"OLA_CC_PRE_COMPACT_CHECKPOINT",
"OLA_CC_EMPTY_MSG_SANITIZER",
"OLA_CC_NON_INTERACTIVE_ENV",
"OLA_CC_AGENT_USAGE_REMINDER",
"OLA_CC_FILE_CHANGE_WATCHER",
"OLA_CC_POST_SAMPLING_HOOK",
"OLA_CC_SESSION_HISTORY_SEARCH",
"OLA_CC_MODEL_BENCHMARKING",
```

- [ ] **Step 2: Run all tests**

Run: `bun test src/services/message-sanitizer/ src/services/tool-normalization/ src/services/lsp/ src/services/compact/ src/services/env-detection/ src/services/usage-reminder/ src/services/file-watcher/ src/services/agent-memory/ src/services/post-sampling/ src/services/session-history/ src/services/benchmarking/ src/utils/model/`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add scripts/build.ts
git commit -m "feat(infra): register 12 infrastructure feature flags with OLA_CC_ prefix"
```

---

## Verification Checklist

After completing all tasks, verify:

1. All 13 feature tests pass (12 features + MiniMax provider)
2. `bun run build:dev` — builds with all flags disabled
3. All 12 feature flags registered in build.ts with `OLA_CC_` prefix
4. Each feature module has clear interfaces matching design doc
5. Integration points verified:
   - `src/query.ts` — EmptyMessageSanitizer, LSP feedback, ToolArgNormalizer, UsageReminder, PostSamplingHook
   - `src/setup.ts` — NonInteractiveEnv, FileWatcher
   - `src/services/compact/compact.ts` — PreCompactCheckpoint
   - `src/services/api/client.ts` — MiniMax provider branch
   - `src/tools/AgentTool/` — PersistentMemoryStore
6. MiniMax provider: M2/M2.5/M3 models registered, `CLAUDE_CODE_USE_MINIMAX` env var works
7. PersistentMemoryStore: three scopes (user/project/local) CRUD + remote mount
8. EmptyMessageSanitizer: injects placeholders (not filters/deletes)
9. PreCompactCheckpoint: saves activeMode/todoSummary/wisdom/backgroundTasks
10. UsageReminder: tool call frequency monitoring with cooldown + subagent suppression
11. SessionHistorySearch: JSONL parsing + time range filtering (30m/2h/7d)
12. modelBenchmark: actual API calls (not placeholder), multi-iteration support

---

## Cross-Plan Coordination: query.ts

This plan's Tasks 1, 2, 4, 5 modify `src/query.ts`. Other plans also modify the same file. See the **Cross-Plan Coordination: query.ts** section in `2026-06-03-performance-optimization-plan.md` for the full modification map and recommended merge order.

**This plan's insertion points (non-overlapping):**

| Task | Region | Insertion Point |
|------|--------|-----------------|
| Task 1 (Sanitizer) | API call preparation | Before `const apiMessages = messagesForQuery` |
| Task 1 (Normalizer) | Tool execution | Before `const result = await tool.call(args)` |
| Task 2 (LSP Feedback) | User message processing | After user message added to conversation |
| Task 4 (Usage Reminder) | Tool result handling | After tool execution succeeds |
| Task 5 (Post-Sampling) | Model response handling | After model response received |

**Merge order**: Apply P7 changes AFTER P4 Task 3 (counter instantiation) but BEFORE P6 Task 2.10 (Langfuse spans) and P10 Task 9 (FrustrationDetection). All changes are feature-gated with `feature()` + dynamic imports.
