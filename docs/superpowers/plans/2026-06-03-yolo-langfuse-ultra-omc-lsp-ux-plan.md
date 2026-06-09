# Implementation Plan: YOLO Classifier + Langfuse + Ultra Series + OMC + LSP Tools + UX Enhancements

**Date**: 2026-06-03
**Status**: Plan Ready
**Design Docs**: 6 specs (yolo-classifier, langfuse-tracing, ultra-series, oh-my-claudecode, lsp-tools, ux-enhancements)
**Estimated Total LOC**: ~8,500+
**Task Count**: 10 Tasks, 62 Steps

---

## Task Dependency Graph

```
Task 1: YOLO Classifier (sideQuery + caching + integration)
  └── depends on: existing sideQuery.ts, Tool.toAutoClassifierInput()

Task 2: Langfuse Tracing (client + sanitize + OTel)
  └── depends on: npm deps (@langfuse/otel, @opentelemetry/sdk-trace-base)
  └── note: yoloClassifier CAN optionally use Langfuse span for tracing, but Task 1 is fully functional without it (optional enhancement, not a dependency)

Task 3: Ultra Series — Effort xhigh + Ultrathink fix
  └── depends on: nothing (standalone)

Task 4: Ultra Series — Ultraplan prompts + UI
  └── depends on: existing cleanupRegistry, GrowthBook

Task 5: OMC — Ralph PRD System
  └── depends on: nothing (standalone)

Task 6: OMC — Learner Auto-Skill + Path Safety
  └── depends on: skill system, checkPathSafetyForAutoEdit

Task 7: LSP Tools — Manager + withLspClient + 12 tools
  └── depends on: existing services/lsp/ infrastructure (LSPClient, LSPServerManager)

Task 8: UX — HUD Status Bar
  └── depends on: nothing (standalone)

Task 9: UX — Multi-Platform Notifications
  └── depends on: existing notifier.ts

Task 10: UX — Wiki Knowledge Layer
  └── depends on: nothing (standalone)
```

---

## Task 1: YOLO Classifier — sideQuery + Caching + Classifier Integration

**Goal**: Implement auto-mode safety classifier with sideQuery channel, result caching, and permission flow integration.
**New files**: 2 | **Modified files**: 3 | **Estimated LOC**: ~1,200
**New files detail**: `classifierCache.ts` (Step 1.2), `classifyWithRetry.ts` (Step 1.3)
**References**:
- `src/utils/sideQuery.ts` — existing sideQuery implementation (reuse)
- `src/utils/permissions/permissions.ts:59-63` — existing TRANSCRIPT_CLASSIFIER feature gate
- `src/utils/permissions/yoloClassifier.ts` — existing stub (partial)
- `src/utils/permissions/classifierShared.ts` — existing shared utilities
- `src/utils/permissions/bashClassifier.ts` — existing stub (partial)
- `src/Tool.ts:653` — existing `toAutoClassifierInput()` method on Tool interface
- `src/utils/permissions/yolo-classifier-prompts/` — existing prompt templates

### Step 1.1: Create ClassifierInput types and shared constants
**File**: `src/utils/permissions/classifierShared.ts` (modify existing)
**Action**: Add `ClassifierInput` interface and `YOLO_CLASSIFIER_TOOL_NAME` constant to existing file
**LOC**: ~30
**Test**: `bun test src/utils/permissions/classifierShared.test.ts`
```typescript
// Add to existing classifierShared.ts:
export interface ClassifierInput {
  toolName: string
  toolDescription: string
  inputSummary: string        // truncated to 500 chars
  riskFactors: string[]       // extracted risk markers
  contextSummary: string      // last 3 messages summary
}

export const YOLO_CLASSIFIER_TOOL_NAME = 'yolo_classifier'
export const CLASSIFIER_INPUT_MAX_LENGTH = 500
```

### Step 1.2: Create classifier result cache
**File**: `src/utils/permissions/classifierCache.ts` (new)
**Action**: Implement Map-based cache with 60s TTL, `getCacheKey()` using stable hash
**LOC**: ~60
**Test**: `bun test src/utils/permissions/classifierCache.test.ts`
```typescript
// Key functions:
export function getCacheKey(toolName: string, input: ClassifierInput): string
export function getCachedResult(key: string): YoloClassifierResult | null
export function setCachedResult(key: string, result: YoloClassifierResult): void
export function clearClassifierCache(): void
```

### Step 1.3: Create classifyWithRetry wrapper
**File**: `src/utils/permissions/classifyWithRetry.ts` (new)
**Action**: Implement retry wrapper with exponential backoff (100ms, 200ms, 400ms), 5s timeout
**LOC**: ~80
**Test**: `bun test src/utils/permissions/classifyWithRetry.test.ts`
- Uses existing `sideQuery()` from `src/utils/sideQuery.ts`
- Mock sideQuery in tests to verify retry behavior
- Verify timeout abort via AbortController

### Step 1.4: Implement buildTranscriptEntries
**File**: `src/utils/permissions/yoloClassifier.ts` (modify existing)
**Action**: Add `buildTranscriptEntries()` function that extracts user text + assistant tool_use, excludes assistant text
**LOC**: ~50
**Test**: `bun test src/utils/permissions/yoloClassifier.test.ts`
- Extract user text messages
- Extract assistant tool_use blocks
- Exclude assistant text (prevent prompt injection)

### Step 1.5: Implement buildYoloSystemPrompt
**File**: `src/utils/permissions/yoloClassifier.ts` (modify existing)
**Action**: Assemble system prompt from base prompt + permissions template + user allow/deny rules
**LOC**: ~80
**Test**: `bun test src/utils/permissions/yoloClassifier.test.ts`
- Loads existing prompt templates from `yolo-classifier-prompts/`
- Integrates permission rules from context
- Handles CLAUDE.md cache loop breaking

### Step 1.6: Implement classifyYoloAction main function
**File**: `src/utils/permissions/yoloClassifier.ts` (modify existing)
**Action**: Main classifier function combining transcript building, prompt assembly, sideQuery call, response parsing
**LOC**: ~120
**Test**: `bun test src/utils/permissions/yoloClassifier.test.ts`
- Wire: buildTranscriptEntries → toCompact → buildYoloSystemPrompt → classifyWithRetry
- Return `YoloClassifierResult` with shouldBlock/reason/model/usage/durationMs

### Step 1.7: Implement selectClassifierMode
**File**: `src/utils/permissions/yoloClassifier.ts` (modify existing)
**Action**: Runtime mode selection logic (single-stage vs two-stage)
**LOC**: ~30
**Test**: `bun test src/utils/permissions/yoloClassifier.test.ts`
```typescript
function selectClassifierMode(toolCount: number): 'single' | 'two-stage'
```

### Step 1.8: Wire classifier into permission flow
**File**: `src/utils/permissions/permissions.ts` (modify existing)
**Action**: In `hasPermissionsToUseToolInner()`, when auto/bypass mode, call `classifyWithCache()` before auto-approving
**LOC**: ~40
**Test**: `bun test src/utils/permissions/permissions.test.ts`
- Check existing `classifierDecisionModule` import pattern (line 59-63)
- Add classifyWithCache call in the auto-mode branch
- If shouldBlock → prompt user; if !shouldBlock → auto-approve

### Step 1.9: Add TRANSCRIPT_CLASSIFIER feature flag
**File**: `scripts/build.ts` (modify existing)
**Action**: Add `'TRANSCRIPT_CLASSIFIER'` to `fullExperimentalFeatures` array (it's referenced in code but not in the build features list)
**Impact analysis**: `feature('TRANSCRIPT_CLASSIFIER')` is used in **90+ locations** across the codebase (main.tsx: 9 uses, permissions.ts: 6, permissionSetup.ts: 12, PromptInput.tsx: 6, REPL.tsx: 4, bashPermissions.ts: 3, AgentTool.tsx: 2, etc.). Without registration, all these code paths are dead-code-eliminated in non-dev-full builds, meaning:
  - Auto mode (`mode: 'auto'`) is completely non-functional in production builds
  - The entire YOLO classifier permission flow is stripped
  - Auto-mode opt-in dialogs, AFK mode beta header, and classifier approval tracking are all removed
  - This is a **silent regression** — no runtime error, just missing functionality
**LOC**: ~2
**Test**: Verify `feature('TRANSCRIPT_CLASSIFIER')` returns true in dev-full builds; verify auto-mode permission flow is functional after build

---

## Task 2: Langfuse Tracing — Client + Sanitize + OTel Integration

**Goal**: Implement Langfuse OpenTelemetry tracing with 3-layer data sanitization.
**New files**: 4 | **Modified files**: 4 | **Estimated LOC**: ~800
**References**:
- `src/services/api/claude.ts` — API call recording integration point
- `src/services/tools/toolExecution.ts` — tool execution recording
- `src/QueryEngine.ts` — trace lifecycle
- `src/query.ts` — batch span management
- `scripts/build.ts` — feature flag registration

### Step 2.1: Install dependencies
**Action**: Add `@langfuse/otel`, `@langfuse/tracing`, `@opentelemetry/sdk-trace-base` to package.json
**LOC**: ~3 (package.json changes)
**Test**: `bun install` succeeds without peer dependency conflicts
```bash
bun add @langfuse/otel @langfuse/tracing @opentelemetry/sdk-trace-base
```

### Step 2.2: Create sanitize.ts — 3-layer data redaction
**File**: `src/services/langfuse/sanitize.ts` (new)
**Action**: Implement sanitizeGlobal (home dir → `~`), sanitizeToolInput (sensitive keys → `[REDACTED]`), sanitizeToolOutput (per-tool-type truncation)
**LOC**: ~120
**Test**: `bun test src/services/langfuse/sanitize.test.ts`
- sanitizeGlobal: home dir replacement + API key redaction
- sanitizeToolInput: api_key/token/secret/password → `[REDACTED]`
- sanitizeToolOutput: FileRead→redacted, Bash→500 char truncation, Config→full redaction
- Uses `escapeRegex` from `src/utils/regex.ts` for safe regex construction

### Step 2.3: Create client.ts — SDK init and lifecycle
**File**: `src/services/langfuse/client.ts` (new)
**Action**: Implement isLangfuseEnabled(), initLangfuse(), flushLangfuse(), shutdownLangfuse(), getLangfuseProcessor()
**LOC**: ~100
**Test**: `bun test src/services/langfuse/client.test.ts`
- isLangfuseEnabled: checks LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY + feature flag
- initLangfuse: creates LangfuseSpanProcessor with sanitizeGlobal mask, BasicTracerProvider
- All functions are no-op when disabled (zero overhead)
- Env vars: LANGFUSE_BASE_URL, LANGFUSE_FLUSH_AT, LANGFUSE_FLUSH_INTERVAL, LANGFUSE_EXPORT_MODE, LANGFUSE_TIMEOUT
```typescript
// Key test cases for client.test.ts:
describe('isLangfuseEnabled', () => {
  it('returns false when LANGFUSE_PUBLIC_KEY is missing', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY
    expect(isLangfuseEnabled()).toBe(false)
  })
  it('returns true when both keys present and feature enabled', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test'
    process.env.LANGFUSE_SECRET_KEY = 'sk-test'
    // mock feature('LANGFUSE_TRACING') === true
    expect(isLangfuseEnabled()).toBe(true)
  })
})
describe('initLangfuse', () => {
  it('returns null when disabled (zero overhead)', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY
    expect(initLangfuse()).toBeNull()
  })
})
describe('flushLangfuse / shutdownLangfuse', () => {
  it('are no-ops when not initialized', async () => {
    await expect(flushLangfuse()).resolves.toBeUndefined()
    await expect(shutdownLangfuse()).resolves.toBeUndefined()
  })
})
```

### Step 2.4: Create convert.ts — Message format conversion
**File**: `src/services/langfuse/convert.ts` (new)
**Action**: Implement convertMessagesToLangfuse(), convertToolsToLangfuse(), convertOutputToLangfuse()
**LOC**: ~150
**Test**: `bun test src/services/langfuse/convert.test.ts`
- tool_use → tool_calls[], tool_result → standalone {role:'tool'}
- thinking/redacted_thinking → {type:'thinking', thinking:string}
- image → [image], document → [document: filename]
```typescript
// Key test cases for convert.test.ts:
describe('convertMessagesToLangfuse', () => {
  it('converts tool_use to tool_calls array', () => {
    const input = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } }] }]
    const result = convertMessagesToLangfuse(input)
    expect(result[0].tool_calls).toEqual([{ id: 'tu1', name: 'bash', arguments: '{"command":"ls"}' }])
  })
  it('converts tool_result to standalone tool role message', () => {
    const input = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt' }] }]
    const result = convertMessagesToLangfuse(input)
    expect(result[0]).toEqual({ role: 'tool', content: 'file.txt', tool_call_id: 'tu1' })
  })
  it('converts thinking blocks to thinking type', () => {
    const input = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning...' }] }]
    const result = convertMessagesToLangfuse(input)
    expect(result[0].content).toContainEqual({ type: 'thinking', thinking: 'reasoning...' })
  })
})
describe('convertToolsToLangfuse', () => {
  it('converts tool schemas to Langfuse format', () => {
    const tools = [{ name: 'bash', description: 'Run commands', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }]
    const result = convertToolsToLangfuse(tools)
    expect(result[0]).toEqual({ name: 'bash', description: 'Run commands', parameters: tools[0].input_schema })
  })
})
```

### Step 2.5: Create tracing.ts — Trace/Generation/Span management
**File**: `src/services/langfuse/tracing.ts` (new)
**Action**: Implement createTrace(), recordLLMObservation(), recordToolObservation(), createToolBatchSpan(), endToolBatchSpan(), createSubagentTrace(), endTrace()
**LOC**: ~180
**Test**: `bun test src/services/langfuse/tracing.test.ts`
- Root trace with asType:'agent'
- Session/user ID propagation via otelSpan.setAttribute
- Cache token merging (cache_read + cache_creation + input → total input)
- All functions return null when Langfuse not enabled
```typescript
// Key test cases for tracing.test.ts:
describe('createTrace', () => {
  it('returns null when Langfuse not enabled', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY
    expect(createTrace({ sessionId: 's1', userId: 'u1' })).toBeNull()
  })
  it('creates root trace with session/user attributes', () => {
    // mock isLangfuseEnabled() === true
    const trace = createTrace({ sessionId: 's1', userId: 'u1' })
    expect(trace).not.toBeNull()
    expect(trace.setAttribute).toHaveBeenCalledWith('session.id', 's1')
    expect(trace.setAttribute).toHaveBeenCalledWith('user.id', 'u1')
  })
})
describe('recordLLMObservation', () => {
  it('merges cache tokens into total input', () => {
    const usage = { cache_read: 100, cache_creation: 50, input: 200, output: 300 }
    const result = recordLLMObservation({ model: 'claude-4-opus', messages: [], usage })
    // total input = 100 + 50 + 200 = 350
    expect(result.usage.input).toBe(350)
  })
})
describe('recordToolObservation', () => {
  it('returns null when disabled', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY
    expect(recordToolObservation({ name: 'bash', input: '{}', output: 'ok', durationMs: 100, status: 'success' })).toBeNull()
  })
})
```

### Step 2.6: Add LANGFUSE_TRACING feature flag
**File**: `scripts/build.ts` (modify existing)
**Action**: Add `'LANGFUSE_TRACING'` to `fullExperimentalFeatures` array
**LOC**: ~1
**Test**: Verify build with `--feature=LANGFUSE_TRACING`

### Step 2.7: Integrate into API call recording
**File**: `src/services/api/claude.ts` (modify existing)
**Action**: In `streamMessage()` (the main streaming function), after the stream completes and usage is calculated (~line 1483 area where TRANSCRIPT_CLASSIFIER is already gated), add a conditional call to `recordLLMObservation()` with model, converted messages, usage, and metadata.
**LOC**: ~15
**Test**: `bun test src/services/api/claude.test.ts`
- Guard with `feature('LANGFUSE_TRACING') && isLangfuseEnabled()`
- Pass model, messages (converted via `convertMessagesToLangfuse()`), usage, metadata
- Verify no side effects when feature disabled

### Step 2.8: Integrate into tool execution recording
**File**: `src/services/tools/toolExecution.ts` (modify existing)
**Action**: In `executeToolCall()` (the main tool execution function, ~line 1139 area where TRANSCRIPT_CLASSIFIER is already gated), after tool execution completes, add a conditional call to `recordToolObservation()` with tool name, sanitized input/output (via `sanitizeToolInput()`/`sanitizeToolOutput()`), duration, and status.
**LOC**: ~15
**Test**: `bun test src/services/tools/toolExecution.test.ts`
- Guard with feature flag + isLangfuseEnabled()
- Pass tool name, sanitized input/output, duration, status
- Verify no side effects when feature disabled

### Step 2.9: Integrate into QueryEngine trace lifecycle
**File**: `src/QueryEngine.ts` (modify existing)
**Action**: In `runConversationLoop()` (the main conversation orchestrator), call `createTrace()` at the start of the loop with sessionId/userId from session context, and call `endTrace()` in the finally block with output and status.
**LOC**: ~15
**Test**: `bun test src/QueryEngine.test.ts`
- createTrace at session init with sessionId, userId
- endTrace at session end with output, status
- Verify trace is created even if conversation errors out

### Step 2.10: Integrate batch span in query.ts
**File**: `src/query.ts` (modify existing)
**Action**: In `processToolCalls()` (the parallel tool execution function), wrap the `Promise.all()` call with `createToolBatchSpan()` before and `endToolBatchSpan()` after, passing the tool call count and results.
**LOC**: ~10
**Test**: `bun test src/query.test.ts`
- Verify batch span is created with correct tool count
- Verify batch span ends with aggregated results

---

## Task 3: Ultra Series — Effort xhigh + Ultrathink Fix

**Goal**: Add xhigh effort level, fix opus-4-7 support, fix missing import.
**New files**: 0 | **Modified files**: 5 | **Estimated LOC**: ~80
**References**:
- `src/utils/effort.ts` — effort system (line 13, 23, 55, 97, 204, 226)
- `src/utils/thinking.ts` — thinking support (line 96, 113-144)
- `src/constants/figures.ts` — effort symbols (line 10-13)
- `src/components/EffortIndicator.ts` — effort UI (line 27-42)
- `src/entrypoints/sdk/runtimeTypes.ts:1` — EffortLevel type definition

### Step 3.1: Add xhigh to EffortLevel type
**File**: `src/entrypoints/sdk/runtimeTypes.ts` (modify existing)
**Action**: Change `EffortLevel` from `'low' | 'medium' | 'high' | string` to `'low' | 'medium' | 'high' | 'xhigh' | string`
**LOC**: ~1
**Test**: TypeScript compilation passes; all switch-cases that handle EffortLevel are flagged if missing xhigh

### Step 3.2: Add EFFORT_XHIGH constant
**File**: `src/constants/figures.ts` (modify existing)
**Action**: Add `export const EFFORT_XHIGH = '\u25ce'` (◎) after EFFORT_HIGH
**LOC**: ~1
**Test**: `bun test src/constants/figures.test.ts` (if exists) or verify import resolves

### Step 3.3: Add xhigh to EFFORT_LEVELS and update effort functions
**File**: `src/utils/effort.ts` (modify existing)
**Action**:
1. Add `'xhigh'` to EFFORT_LEVELS array (line 13)
2. Add `case 'xhigh'` to `toPersistableEffort()` (line 97)
3. Add `case 'xhigh'` to `convertEffortValueToLevel()` (line 204)
4. Add `case 'xhigh'` to `getEffortLevelDescription()` (line 226) — description: "Enhanced reasoning with extended analysis (Opus 4.7+)"
5. Add `'opus-4-7'` to `modelSupportsEffort()` allowlist (line 33)
6. Add `'opus-4-7'` to `modelSupportsMaxEffort()` allowlist (line 60)
7. **BUG FIX**: Add `import { resolveAntModel } from './model/antModels.js'` to effort.ts — same bug as thinking.ts (Step 3.6). `resolveAntModel` is called at lines 63 and 292 but never imported. This causes `ReferenceError` when `USER_TYPE === 'ant'` and model is an ant model.
**LOC**: ~20
**Test**: `bun test src/utils/effort.test.ts`
- Verify xhigh is in EFFORT_LEVELS
- Verify modelSupportsEffort('opus-4-7') returns true
- Verify modelSupportsMaxEffort('opus-4-7') returns true
- Verify toPersistableEffort('xhigh') returns 'xhigh' for ants
- Verify convertEffortValueToLevel('xhigh') returns 'xhigh'
- Verify getEffortLevelDescription('xhigh') returns non-empty string

### Step 3.4: Add EFFORT_XHIGH case to EffortIndicator
**File**: `src/components/EffortIndicator.ts` (modify existing)
**Action**: Import EFFORT_XHIGH, add `case 'xhigh': return EFFORT_XHIGH` in effortLevelToSymbol()
**LOC**: ~5
**Test**: `bun test src/components/EffortIndicator.test.ts`
- Verify effortLevelToSymbol('xhigh') returns '◎'

### Step 3.5: Add opus-4-7 to adaptive thinking allowlist
**File**: `src/utils/thinking.ts` (modify existing)
**Action**: Add `'opus-4-7'` to `modelSupportsAdaptiveThinking()` allowlist (line 120)
**LOC**: ~1
**Test**: `bun test src/utils/thinking.test.ts`
- Verify modelSupportsAdaptiveThinking('opus-4-7') returns true

### Step 3.6: Fix missing resolveAntModel import
**File**: `src/utils/thinking.ts` (modify existing)
**Action**: Add `import { resolveAntModel } from './model/antModels.js'` (referenced at line 96 but not imported)
**LOC**: ~1
**Test**: `bun test src/utils/thinking.test.ts`
- Verify modelSupportsThinking() no longer throws ReferenceError for ant models

### Step 3.7: Update effort help text
**File**: `src/commands/effort/effort.tsx` (modify existing)
**Action**: Add xhigh to the help text display
**LOC**: ~5
**Test**: `bun test src/commands/effort/effort.test.tsx`

---

## Task 4: Ultra Series — Ultraplan Prompt Templates + UI

**Goal**: Implement Ultraplan prompt templates with GrowthBook selection and UI components.
**New files**: 4 | **Modified files**: 1 | **Estimated LOC**: ~350
**References**:
- `src/utils/cleanupRegistry.ts` — existing cleanup system
- `src/services/analytics/growthbook.ts` — feature value retrieval
- `src/commands/ultraplan.tsx` — existing ultraplan command (if exists)

### Step 4.1: Create prompt.ts with template selection
**File**: `src/utils/ultraplan/prompt.ts` (new)
**Action**: Implement getPlanTemplate() + buildPlanPrompt() with 3 templates (simple_plan, visual_plan, three_subagents_with_critique)
**LOC**: ~120
**Test**: `bun test src/utils/ultraplan/prompt.test.ts`
- getPlanTemplate returns GrowthBook value, defaults to 'simple_plan'
- buildPlanPrompt combines template + context
- Each template contains expected keywords

### Step 4.2: Replace prompt.txt content
**File**: `src/utils/ultraplan/prompt.txt` (modify existing)
**Action**: Replace placeholder "Ultraplan is unavailable..." with actual simple_plan prompt content
**LOC**: ~10
**Test**: Verify file content is non-empty and contains planning instructions

### Step 4.3: Create UltraplanChoiceDialog component
**File**: `src/components/ultraplan/UltraplanChoiceDialog.tsx` (new)
**Action**: React/Ink component for choosing between plan templates
**LOC**: ~80
**Test**: `bun test src/components/ultraplan/UltraplanChoiceDialog.test.tsx`
- Renders 3 template options
- Selecting an option calls onSelect callback
- Shows template descriptions

### Step 4.4: Create UltraplanLaunchDialog component
**File**: `src/components/ultraplan/UltraplanLaunchDialog.tsx` (new)
**Action**: React/Ink component for configuring and launching ultraplan
**LOC**: ~80
**Test**: `bun test src/components/ultraplan/UltraplanLaunchDialog.test.tsx`
- Shows selected template info
- Has "Launch" and "Cancel" buttons
- Calls onLaunch with configuration

### Step 4.5: Extend cleanupRegistry for ultraplan
**File**: `src/utils/cleanupRegistry.ts` (modify existing)
**Action**: Add ultraplan-specific cleanup registration for cancel scenarios
**LOC**: ~20
**Test**: `bun test src/utils/cleanupRegistry.test.ts`
- Register ultraplan cleanup handler
- Verify cleanup is called on cancel

### Step 4.6: Create ultrareviewPreflight.ts
**File**: `src/services/api/ultrareviewPreflight.ts` (new)
**Action**: Pre-checks for remote review: CCR connectivity, quota, PR/branch access
**LOC**: ~60
**Test**: `bun test src/services/api/ultrareviewPreflight.test.ts`
- Mock CCR service responses
- Verify pass/fail detection
- Verify error messages are descriptive

---

## Task 5: OMC — Ralph PRD System

**Goal**: Implement PRD-based task management with parsing, progress memory, and 3-mode verification.
**New files**: 5 | **Modified files**: 0 | **Estimated LOC**: ~780
**References**:
- `src/Tool.ts` — Tool interface (buildTool pattern)
- `src/tools/AgentTool/` — existing tool pattern

### Step 5.1: Create RalphTool types
**File**: `src/tools/RalphTool/types.ts` (new)
**Action**: Define PRD, UserStory, FileChange, PRDParseResult, ProgressState, UserStoryProgress, VerificationResult, VerificationIssue, CriticMode interfaces
**LOC**: ~80
**Test**: TypeScript compilation passes

### Step 5.2: Implement PRD parser
**File**: `src/tools/RalphTool/prd.ts` (new)
**Action**: Implement parsePRD(), extractUserStories(), validatePRD()
**LOC**: ~150
**Test**: `bun test src/tools/RalphTool/prd.test.ts`
- parsePRD: reads markdown file, returns structured PRD
- extractUserStories: recognizes `## User Story:`, `- [ ]`, `- [x]` patterns
- validatePRD: checks project name, branch, at least 1 story, each story has criteria
- Test with sample PRD markdown files

### Step 5.3: Implement progress memory
**File**: `src/tools/RalphTool/progress.ts` (new)
**Action**: Implement atomicWriteProgress(), readProgress(), updateStoryProgress()
**LOC**: ~200
**Test**: `bun test src/tools/RalphTool/progress.test.ts`
- atomicWriteProgress: write to tmp → rename (crash-safe)
- readProgress: parse "## Codebase Patterns" + "## User Story:" sections
- updateStoryProgress: update specific story, preserve others
- Test crash recovery (partial write → rename completes)

### Step 5.4: Implement verifier
**File**: `src/tools/RalphTool/verifier.ts` (new)
**Action**: Implement verify() with 3 critic modes (architect/critic/codex), verifyAll(), RALPH_APPROVED_REGEX
**LOC**: ~250
**Test**: `bun test src/tools/RalphTool/verifier.test.ts`
- RALPH_APPROVED_REGEX matches `<ralph-approved>`, `<ralph-approved reason="...">`, `<ralph-approved/>`
- verify: each mode has different system prompt focus
- verifyAll: all 3 must approve for overall approval
- Test with mock responses containing/missing approval tags

### Step 5.5: Create RalphTool entry point
**File**: `src/tools/RalphTool/index.ts` (new)
**Action**: Implement RalphTool with buildTool(), subcommands: parse/status/update/verify
**LOC**: ~100
**Test**: `bun test src/tools/RalphTool/index.test.ts`
- Tool name is 'ralph'
- Subcommand dispatch works correctly
- Each subcommand returns expected result format

---

## Task 6: OMC — Learner Auto-Skill + Path Safety

**Goal**: Implement pattern detection from conversations and auto-generation of reusable skills.
**New files**: 3 | **Modified files**: 0 | **Estimated LOC**: ~650
**References**:
- `src/utils/permissions/filesystem.ts` — checkPathSafetyForAutoEdit (path safety)
- `src/tools/SkillTool/` — existing skill system

### Step 6.1: Create pattern detector
**File**: `src/hooks/learner/detector.ts` (new)
**Action**: Implement 5 pattern types (problem-solution, fix-pattern, workaround, discovery, configuration) with EN/ZH regex
**LOC**: ~300
**Test**: `bun test src/hooks/learner/detector.test.ts`
- Test each pattern type with EN and ZH sample text
- Verify confidence scoring (0-1)
- Verify language detection
- Verify context extraction

### Step 6.2: Create auto-learner with scoring
**File**: `src/hooks/learner/auto-learner.ts` (new)
**Action**: Implement scorePattern(), totalScore(), session cache dedup, generateSkill()
**LOC**: ~200
**Test**: `bun test src/hooks/learner/auto-learner.test.ts`
- scorePattern: 5 factors (specificity 0-20, clarity 0-25, reusability 0-20, frequency 0-15, richness 0-20)
- totalScore: sum of factors, threshold >= 60
- isDuplicate: session-level dedup via normalized hash
- generateSkill: produces markdown with trigger/problem/solution/context/tags

### Step 6.3: Create validator with quality gates
**File**: `src/hooks/learner/validator.ts` (new)
**Action**: Implement quality gates: dedup check, min length, format check, path safety via checkPathSafetyForAutoEdit
**LOC**: ~150
**Test**: `bun test src/hooks/learner/validator.test.ts`
- Verify generated skill path passes checkPathSafetyForAutoEdit
- Verify minimum content length (50 chars)
- Verify markdown format (has # heading, ## sections)
- Verify output path is under `~/.ola-cc/skills/`

---

## Task 7: LSP Tools — Manager + withLspClient + 12 Tools

**Goal**: Create 12 individual LSP tools using existing LSP infrastructure with withLspClient wrapper.
**New files**: 3 | **Modified files**: 1 | **Estimated LOC**: ~545
**References**:
- `src/services/lsp/manager.ts` — existing LSP server manager (getLspServerManager)
- `src/services/lsp/LSPClient.ts` — existing LSP client (createLSPClient, sendRequest)
- `src/services/lsp/LSPServerManager.ts` — existing manager (sendRequest, ensureServerStarted)
- `src/tools/LSPTool/LSPTool.ts` — existing single LSP tool (reference for patterns)
- `src/tools/LSPTool/formatters.ts` — existing result formatters

**LspTools/ vs LSPTool/ Coexistence Strategy**:
- Existing `src/tools/LSPTool/` (6 files: LSPTool.ts, formatters.ts, prompt.ts, schemas.ts, symbolContext.ts, UI.tsx) is a single monolithic tool that bundles all LSP operations into one tool with subcommands.
- New `src/tools/LspTools/` creates 12 individual tools (one per LSP operation) for better model discoverability and progressive disclosure.
- **Coexistence**: Both directories coexist during migration. `LSPTool/` remains functional as-is. `LspTools/` is gated behind `OLA_CC_LSP_TOOLS` env var (default off).
- **Reuse**: `LspTools/` reuses existing `LSPTool/formatters.ts` for result formatting and `src/services/lsp/` infrastructure (LSPClient, LSPServerManager).
- **Future migration**: Once `LspTools/` is stable, `LSPTool/` can be deprecated and removed. Document deprecation in `LSPTool/LSPTool.ts` header when `LspTools/` is enabled.

### Step 7.1: Create LSP tool types
**File**: `src/tools/LspTools/types.ts` (new)
**Action**: Define LspToolInput interfaces for all 12 tools
**LOC**: ~60
**Test**: TypeScript compilation passes

### Step 7.2: Create withLspClient wrapper and 12 tool definitions
**File**: `src/tools/LspTools/tools.ts` (new)
**Action**: Implement withLspClient() wrapper + 12 tool definitions (lsp_hover, lsp_goto_definition, lsp_find_references, lsp_document_symbols, lsp_workspace_symbols, lsp_diagnostics, lsp_rename, lsp_format, lsp_code_actions, lsp_completion, lsp_signature_help, lsp_folding_range)
**LOC**: ~280
**Test**: `bun test src/tools/LspTools/tools.test.ts`
- withLspClient: routes to correct LSP server via getLspServerManager
- Each tool: schema validation, correct LSP method called
- Error handling: "No LSP server available" when server not found
- Reuse existing formatters from `src/tools/LSPTool/formatters.ts`

### Step 7.3: Register LSP tools in tools.ts
**File**: `src/tools.ts` (modify existing)
**Action**: Import and add lspTools array to getAllBaseTools()
**LOC**: ~10
**Test**: `bun test src/tools.test.ts`
- Verify all 12 LSP tools appear in getAllBaseTools()
- Verify tools have `isLsp: true` flag

### Step 7.4: Add feature flag gate
**File**: `src/tools/LspTools/tools.ts` (modify existing from step 7.2)
**Action**: Gate tool registration behind `OLA_CC_LSP_TOOLS` env var check
**LOC**: ~10
**Test**: `bun test src/tools/LspTools/tools.test.ts`
- When OOLA_CC_LSP_TOOLS=0, lspTools array is empty
- When OLA_CC_LSP_TOOLS=1, lspTools has 12 tools

---

## Task 8: UX — HUD Status Bar

**Goal**: Implement configurable HUD status bar with 5 presets and 12+ elements.
**New files**: 7 | **Modified files**: 1 | **Estimated LOC**: ~800
**References**:
- `src/components/Stats.tsx` — existing stats panel (add HUD tab)
- `src/state/AppState.ts` — state store for HUD data

### Step 8.1: Create HUD types
**File**: `src/hud/types.ts` (new)
**Action**: Define StatusLineConfig, StatusLineElement, HudRenderContext interfaces
**LOC**: ~50
**Test**: TypeScript compilation passes

### Step 8.2: Create HUD element renderers
**File**: `src/hud/elements/` directory (new, ~10 files)
**Action**: Implement renderers for: context-window, rate-limit-5h, rate-limit-7d, rate-limit-monthly, active-agent-count, active-tool-count, active-skill-count, todo-count, session-duration, session-health, last-prompt-time, custom-rate-limit
**LOC**: ~400
**Test**: `bun test src/hud/elements/*.test.ts`
- Each renderer: input data → formatted string
- context-window: progress bar with percentage
- rate limits: formatted time remaining
- counts: numeric display

**Element renderer pattern** — each element is a pure function:

```typescript
// src/hud/elements/types.ts
export interface HudElementRenderer {
  id: string
  label: string  // i18n key
  render: (data: HudData, width: number) => string
}

export interface HudData {
  contextWindowUsed: number
  contextWindowMax: number
  rateLimits: { fiveHour?: number; sevenDay?: number; monthly?: number }
  activeAgentCount: number
  activeToolCount: number
  activeSkillCount: number
  todoCount: number
  sessionDurationMs: number
  sessionHealth: 'good' | 'warning' | 'critical'
  lastPromptTime?: number
}

// src/hud/elements/contextWindow.ts
import type { HudElementRenderer, HudData } from './types'

export const contextWindowElement: HudElementRenderer = {
  id: 'context-window',
  label: 'hud.contextWindow',
  render(data: HudData, width: number): string {
    const pct = Math.round((data.contextWindowUsed / data.contextWindowMax) * 100)
    const barWidth = Math.max(10, Math.min(30, width - 20))
    const filled = Math.round((pct / 100) * barWidth)
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled)
    return `${bar} ${pct}%`
  },
}

// src/hud/elements/rateLimit.ts
export const rateLimitElement = (period: '5h' | '7d' | 'monthly') => ({
  id: `rate-limit-${period}`,
  label: `hud.rateLimit.${period}`,
  render(data: HudData): string {
    const key = period === '5h' ? 'fiveHour' : period === '7d' ? 'sevenDay' : 'monthly'
    const remaining = data.rateLimits[key]
    if (remaining === undefined) return 'N/A'
    if (remaining <= 0) return 'LIMITED'
    const hours = Math.floor(remaining / 3600000)
    const mins = Math.floor((remaining % 3600000) / 60000)
    return hours > 0 ? `${hours}h${mins}m` : `${mins}m`
  },
})

// src/hud/elements/sessionDuration.ts
export const sessionDurationElement: HudElementRenderer = {
  id: 'session-duration',
  label: 'hud.sessionDuration',
  render(data: HudData): string {
    const secs = Math.floor(data.sessionDurationMs / 1000)
    const mins = Math.floor(secs / 60)
    const hours = Math.floor(mins / 60)
    if (hours > 0) return `${hours}h${mins % 60}m`
    return `${mins}m${secs % 60}s`
  },
}

// src/hud/elements/count.ts — generic count element factory
export const countElement = (id: string, label: string, getValue: (data: HudData) => number) => ({
  id,
  label,
  render(data: HudData): string {
    return String(getValue(data))
  },
})
```

**Test** for element renderers:

```typescript
// src/hud/elements/contextWindow.test.ts
import { describe, test, expect } from 'bun:test'
import { contextWindowElement } from './contextWindow'

describe('contextWindowElement', () => {
  test('renders progress bar with percentage', () => {
    const data = { contextWindowUsed: 50000, contextWindowMax: 200000 } as any
    const result = contextWindowElement.render(data, 80)
    expect(result).toContain('25%')
    expect(result).toContain('\u2588')
  })
  test('renders 100% when full', () => {
    const data = { contextWindowUsed: 200000, contextWindowMax: 200000 } as any
    const result = contextWindowElement.render(data, 80)
    expect(result).toContain('100%')
  })
})
```

### Step 8.3: Create HUD presets
**File**: `src/hud/presets.ts` (new)
**Action**: Define 5 presets: minimal, focused, full, opencode, dense
**LOC**: ~80
**Test**: `bun test src/hud/presets.test.ts`
- Each preset has valid element list
- minimal has ≤ 3 elements, full has ≥ 10

### Step 8.4: Create truncation logic
**File**: `src/hud/truncation.ts` (new)
**Action**: Implement truncateToWidth() with 3 strategies: ellipsis, wrap, hide
**LOC**: ~100
**Test**: `bun test src/hud/truncation.test.ts`
- Text shorter than maxWidth passes through
- ellipsis: truncates with "..."
- wrap: splits into multiple lines
- hide: returns empty string

### Step 8.5: Create locale strings
**File**: `src/hud/locale.ts` (new)
**Action**: i18n strings for zh/en
**LOC**: ~50
**Test**: `bun test src/hud/locale.test.ts`
- All element names have zh and en translations

### Step 8.6: Create HUD parser
**File**: `src/hud/parser.ts` (new)
**Action**: Implement parseStatuslineInput() that collects element data and renders
**LOC**: ~120
**Test**: `bun test src/hud/parser.test.ts`
- Parses config and renders each element
- Returns HudRenderContext with terminalWidth, elements map, locale

### Step 8.7: Create useHudData React hook
**File**: `src/hooks/useHudData.ts` (new)
**Action**: React hook that reads AppState and returns HudRenderContext
**LOC**: ~50
**Test**: `bun test src/hooks/useHudData.test.ts`
- Reads from AppState store
- Refreshes at configured interval
- Returns latest context

---

## Task 9: UX — Multi-Platform Notifications

**Goal**: Implement notification dispatcher with 5 platform adapters and reply injection.
**New files**: 9 | **Modified files**: 2 | **Estimated LOC**: ~900
**References**:
- `src/services/notifier.ts` — existing terminal-only notification (add remote dispatch)
- `src/hooks/notifs/` — existing notification hooks

### Step 9.1: Create notification types
**File**: `src/services/notifications/types.ts` (new)
**Action**: Define NotificationConfig, NotificationPlatform, platform configs, NotificationEvent
**LOC**: ~80
**Test**: TypeScript compilation passes

### Step 9.2: Create template engine
**File**: `src/services/notifications/templateEngine.ts` (new)
**Action**: Implement renderTemplate() with variable interpolation
**LOC**: ~100
**Test**: `bun test src/services/notifications/templateEngine.test.ts`
- Renders event templates with data variables
- Handles missing variables gracefully

### Step 9.3: Create platform adapters
**Files**: `src/services/notifications/platforms/` (5 files)
**Action**: Implement adapters for: discord.ts, telegram.ts, slack.ts, webhook.ts, cli.ts
**LOC**: ~480 (120+100+120+80+60)
**Test**: `bun test src/services/notifications/platforms/*.test.ts`
- Discord: webhook POST with embed format
- Telegram: bot API sendMessage
- Slack: webhook POST with blocks format
- Webhook: generic HTTP with configurable method/headers
- CLI: spawn custom command with message arg

**Platform adapter interface** — all adapters implement this contract:

```typescript
// src/services/notifications/platforms/types.ts
export interface PlatformAdapter {
  name: string
  isConfigured(): boolean
  send(message: NotificationMessage): Promise<boolean>
}

export interface NotificationMessage {
  title: string
  body: string
  level: 'info' | 'warning' | 'error'
  metadata?: Record<string, string>
}

// src/services/notifications/platforms/discord.ts
import type { PlatformAdapter, NotificationMessage } from './types'

export class DiscordAdapter implements PlatformAdapter {
  name = 'discord'
  constructor(private webhookUrl: string) {}

  isConfigured(): boolean {
    return !!this.webhookUrl
  }

  async send(message: NotificationMessage): Promise<boolean> {
    const colorMap = { info: 0x5865f2, warning: 0xfee75c, error: 0xed4245 }
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: message.title,
          description: message.body,
          color: colorMap[message.level],
          timestamp: new Date().toISOString(),
        }],
      }),
    })
    return response.ok
  }
}

// src/services/notifications/platforms/telegram.ts
import type { PlatformAdapter, NotificationMessage } from './types'

export class TelegramAdapter implements PlatformAdapter {
  name = 'telegram'
  constructor(private botToken: string, private chatId: string) {}

  isConfigured(): boolean {
    return !!this.botToken && !!this.chatId
  }

  async send(message: NotificationMessage): Promise<boolean> {
    const text = `*${message.title}*\n${message.body}`
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'Markdown' }),
    })
    return response.ok
  }
}

// src/services/notifications/platforms/webhook.ts
import type { PlatformAdapter, NotificationMessage } from './types'

export class WebhookAdapter implements PlatformAdapter {
  name = 'webhook'
  constructor(
    private url: string,
    private method: string = 'POST',
    private headers: Record<string, string> = {},
  ) {}

  isConfigured(): boolean {
    return !!this.url
  }

  async send(message: NotificationMessage): Promise<boolean> {
    const response = await fetch(this.url, {
      method: this.method,
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(message),
    })
    return response.ok
  }
}
```

### Step 9.4: Create central dispatcher
**File**: `src/services/notifications/dispatcher.ts` (new)
**Action**: Implement NotificationDispatcher with dispatch(), shouldDispatch() (4-level verbosity)
**LOC**: ~150
**Test**: `bun test src/services/notifications/dispatcher.test.ts`
- minimal: only session-start, session-end, ask-user-question
- normal: everything except session-idle
- verbose/debug: all events
- Parallel dispatch to all enabled platforms

### Step 9.5: Create reply injection bridge
**File**: `src/services/notifications/replyInjection.ts` (new)
**Action**: Implement ReplyInjectionBridge with waitForReply(), onReply()
**LOC**: ~100
**Test**: `bun test src/services/notifications/replyInjection.test.ts`
- waitForReply: returns promise that resolves on onReply
- Timeout after 5 minutes returns null
- Multiple concurrent waits supported

### Step 9.6: Create notification profiles
**File**: `src/services/notifications/profiles.ts` (new)
**Action**: Profile management for notification configurations
**LOC**: ~70
**Test**: `bun test src/services/notifications/profiles.test.ts`

### Step 9.7: Integrate with existing notifier
**File**: `src/services/notifier.ts` (modify existing)
**Action**: Add sendRemoteNotification() called from existing sendNotification()
**LOC**: ~20
**Test**: `bun test src/services/notifier.test.ts`
- sendNotification still works for terminal
- sendRemoteNotification delegates to dispatcher when config present
- Backward compatible: no behavior change when no remote config

---

## Task 10: UX — Wiki Knowledge Layer

**Goal**: Implement wiki knowledge system with 7 MCP tools, markdown parsing, and auto-index.
**New files**: 7 | **Modified files**: 0 | **Estimated LOC**: ~700
**References**:
- `src/tools/` — existing tool pattern (buildTool)
- `src/services/singularity/` — ASAEF integration point

### Step 10.1: Create wiki types
**File**: `src/tools/WikiTools/types.ts` (new)
**Action**: Define WikiPage, WikiCategory, WikiIndex interfaces
**LOC**: ~50
**Test**: TypeScript compilation passes

```typescript
// src/tools/WikiTools/types.ts
export interface WikiPage {
  path: string           // relative to .wiki/, e.g. "architecture/overview.md"
  title: string          // extracted from first # heading
  category: string       // derived from directory path, e.g. "architecture"
  tags: string[]         // extracted from frontmatter or inline tags
  confidence: "high" | "medium" | "low"
  lastModified: number   // Unix timestamp ms
  content: string        // raw markdown content
  references: string[]   // paths of pages this page links to
}

export interface WikiCategory {
  name: string
  pageCount: number
  lastUpdated: number
}

export interface WikiIndex {
  version: number
  pages: Map<string, WikiPage>  // keyed by path
  categories: Map<string, WikiCategory>
  buildTimestamp: number
}

export interface WikiSearchResult {
  page: WikiPage
  score: number
  matchedFields: string[]  // "title" | "content" | "tags"
}
```

### Step 10.2: Create wiki markdown parser
**File**: `src/tools/WikiTools/wikiParser.ts` (new)
**Action**: Implement parseWikiMarkdown(), detectConfidence(), extractPageRefs()
**LOC**: ~80
**Test**: `bun test src/tools/WikiTools/wikiParser.test.ts`
- Parses markdown with confidence markers
- Detects high/medium/low confidence from content
- Extracts page references from markdown links

```typescript
// src/tools/WikiTools/wikiParser.ts
import type { WikiPage } from "./types"

const CONFIDENCE_PATTERNS = {
  high: /\b(confirmed|verified|definitely|certain|proven)\b/i,
  medium: /\b(likely|probably|appears|seems|expected)\b/i,
  low: /\b(uncertain|maybe|possibly|unknown|speculation)\b/i,
}

export function parseWikiMarkdown(
  relativePath: string,
  content: string,
  lastModified: number,
): WikiPage {
  const title = extractTitle(content)
  const category = relativePath.includes("/")
    ? relativePath.split("/").slice(0, -1).join("/")
    : "root"
  const tags = extractTags(content)
  const confidence = detectConfidence(content)
  const references = extractPageRefs(content)

  return { path: relativePath, title, category, tags, confidence, lastModified, content, references }
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : "Untitled"
}

function extractTags(content: string): string[] {
  // Frontmatter tags: ---\ntags: [a, b]\n---
  const frontmatter = content.match(/^---\n[\s\S]*?tags:\s*\[([^\]]+)\][\s\S]*?\n---/)
  if (frontmatter) {
    return frontmatter[1].split(",").map((t) => t.trim().toLowerCase())
  }
  // Inline tags: #tag
  const inlineTags = content.match(/(?:^|\s)#([a-z][a-z0-9-]*)/gm)
  return inlineTags ? inlineTags.map((t) => t.trim().replace("#", "")) : []
}

export function detectConfidence(content: string): "high" | "medium" | "low" {
  const lowMatches = (content.match(CONFIDENCE_PATTERNS.low) || []).length
  if (lowMatches > 0) return "low"
  const mediumMatches = (content.match(CONFIDENCE_PATTERNS.medium) || []).length
  if (mediumMatches > 2) return "medium"
  return "high"
}

export function extractPageRefs(content: string): string[] {
  // Match [[wiki-link]] and [text](relative-path.md)
  const wikiLinks = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1])
  const mdLinks = [...content.matchAll(/\[[^\]]*\]\(([^)]+\.md)\)/g)].map((m) => m[1])
  return [...new Set([...wikiLinks, ...mdLinks])]
}
```

### Step 10.3: Create wiki index manager
**File**: `src/tools/WikiTools/wikiIndex.ts` (new)
**Action**: Implement loadWikiIndex(), updateWikiIndex(), rebuildIndex()
**LOC**: ~80
**Test**: `bun test src/tools/WikiTools/wikiIndex.test.ts`
- Loads index from .wiki/ directory
- Updates index when page added/modified
- Rebuilds index from scratch

```typescript
// src/tools/WikiTools/wikiIndex.ts
import { readdir, readFile, stat, mkdir } from "fs/promises"
import { join, extname, relative } from "path"
import type { WikiIndex, WikiPage } from "./types"
import { parseWikiMarkdown } from "./wikiParser"

const WIKI_DIR = ".wiki"
const INDEX_FILE = ".wiki-index.json"

export async function loadWikiIndex(projectRoot: string): Promise<WikiIndex> {
  const wikiRoot = join(projectRoot, WIKI_DIR)
  try {
    const raw = await readFile(join(wikiRoot, INDEX_FILE), "utf-8")
    const data = JSON.parse(raw)
    return {
      version: data.version,
      pages: new Map(Object.entries(data.pages)),
      categories: new Map(Object.entries(data.categories)),
      buildTimestamp: data.buildTimestamp,
    }
  } catch {
    return rebuildIndex(projectRoot)
  }
}

export async function saveWikiIndex(projectRoot: string, index: WikiIndex): Promise<void> {
  const wikiRoot = join(projectRoot, WIKI_DIR)
  await mkdir(wikiRoot, { recursive: true })
  const data = {
    version: index.version,
    pages: Object.fromEntries(index.pages),
    categories: Object.fromEntries(index.categories),
    buildTimestamp: index.buildTimestamp,
  }
  await writeFile(join(wikiRoot, INDEX_FILE), JSON.stringify(data, null, 2))
}

export async function rebuildIndex(projectRoot: string): Promise<WikiIndex> {
  const wikiRoot = join(projectRoot, WIKI_DIR)
  const index: WikiIndex = {
    version: 1,
    pages: new Map(),
    categories: new Map(),
    buildTimestamp: Date.now(),
  }
  try {
    await collectPages(wikiRoot, wikiRoot, index)
  } catch {
    // .wiki/ doesn't exist yet — return empty index
  }
  return index
}

async function collectPages(root: string, dir: string, index: WikiIndex): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectPages(root, fullPath, index)
    } else if (extname(entry.name) === ".md") {
      const relPath = relative(root, fullPath)
      const content = await readFile(fullPath, "utf-8")
      const stats = await stat(fullPath)
      const page = parseWikiMarkdown(relPath, content, stats.mtimeMs)
      index.pages.set(relPath, page)
      // Update category
      const cat = index.categories.get(page.category) || { name: page.category, pageCount: 0, lastUpdated: 0 }
      cat.pageCount++
      cat.lastUpdated = Math.max(cat.lastUpdated, page.lastModified)
      index.categories.set(page.category, cat)
    }
  }
}
```

### Step 10.4: Create WikiIngestTool
**File**: `src/tools/WikiTools/WikiIngestTool.ts` (new)
**Action**: Smart knowledge ingestion with auto-merge (no overwrite), confidence detection
**LOC**: ~150
**Test**: `bun test src/tools/WikiTools/WikiIngestTool.test.ts`
- New page: creates file + updates index
- Existing page: merges content (preserves old paragraphs)
- Auto-detects confidence level

```typescript
// src/tools/WikiTools/WikiIngestTool.ts
import { z } from "zod"
import { readFile, writeFile, mkdir } from "fs/promises"
import { join, dirname } from "path"
import { Tool } from "../../Tool"
import { loadWikiIndex, saveWikiIndex } from "./wikiIndex"
import { parseWikiMarkdown, detectConfidence } from "./wikiParser"

const inputSchema = z.object({
  path: z.string().describe("Relative path within .wiki/, e.g. 'architecture/api-design.md'"),
  content: z.string().describe("Markdown content to ingest"),
  mergeStrategy: z.enum(["append", "replace", "smart"]).default("smart")
    .describe("'smart' preserves existing paragraphs and appends new ones"),
})

export const WikiIngestTool: Tool = {
  name: "wiki_ingest",
  description: "Ingest knowledge into the wiki. Smart merge preserves existing content.",
  inputSchema,
  async call(input, ctx) {
    const { path, content, mergeStrategy } = input
    const projectRoot = ctx.cwd || process.cwd()
    const wikiRoot = join(projectRoot, ".wiki")
    const filePath = join(wikiRoot, path)
    const index = await loadWikiIndex(projectRoot)

    let finalContent: string
    const existing = index.pages.get(path)

    if (existing && mergeStrategy === "smart") {
      finalContent = smartMerge(existing.content, content)
    } else if (existing && mergeStrategy === "append") {
      finalContent = existing.content + "\n\n---\n\n" + content
    } else {
      finalContent = content
    }

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, finalContent, "utf-8")

    // Update index
    const page = parseWikiMarkdown(path, finalContent, Date.now())
    index.pages.set(path, page)
    await saveWikiIndex(projectRoot, index)

    const action = existing ? "merged" : "created"
    return `Wiki page ${action}: ${path} (confidence: ${page.confidence}, category: ${page.category})`
  },
}

function smartMerge(oldContent: string, newContent: string): string {
  const oldParagraphs = new Set(oldContent.split("\n\n").map((p) => p.trim()).filter(Boolean))
  const newParagraphs = newContent.split("\n\n").map((p) => p.trim()).filter(Boolean)
  const added: string[] = []
  for (const para of newParagraphs) {
    if (!oldParagraphs.has(para)) {
      added.push(para)
    }
  }
  if (added.length === 0) return oldContent
  return oldContent + "\n\n<!-- merged -->\n\n" + added.join("\n\n")
}
```

### Step 10.5: Create WikiQueryTool
**File**: `src/tools/WikiTools/WikiQueryTool.ts` (new)
**Action**: Keyword search with BM25-like scoring (title*3 + content + tag*2)
**LOC**: ~100
**Test**: `bun test src/tools/WikiTools/WikiQueryTool.test.ts`
- Scores pages by keyword match in title/content/tags
- Respects category filter
- Returns top N results sorted by score

```typescript
// src/tools/WikiTools/WikiQueryTool.ts
import { z } from "zod"
import { Tool } from "../../Tool"
import { loadWikiIndex } from "./wikiIndex"
import type { WikiSearchResult, WikiPage } from "./types"

const inputSchema = z.object({
  query: z.string().describe("Search query (space-separated keywords)"),
  category: z.string().optional().describe("Filter by category"),
  limit: z.number().default(5).describe("Max results to return"),
})

export const WikiQueryTool: Tool = {
  name: "wiki_query",
  description: "Search wiki pages by keyword with BM25-like scoring.",
  inputSchema,
  async call(input, ctx) {
    const { query, category, limit } = input
    const projectRoot = ctx.cwd || process.cwd()
    const index = await loadWikiIndex(projectRoot)
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)

    const results: WikiSearchResult[] = []
    for (const [, page] of index.pages) {
      if (category && page.category !== category) continue
      const score = scorePage(page, keywords)
      if (score > 0) {
        results.push({
          page,
          score,
          matchedFields: getMatchedFields(page, keywords),
        })
      }
    }

    results.sort((a, b) => b.score - a.score)
    const top = results.slice(0, limit)

    if (top.length === 0) return "No wiki pages matched the query."

    return top
      .map((r, i) =>
        `${i + 1}. **${r.page.title}** (${r.page.path}) — score: ${r.score.toFixed(1)}\n` +
        `   category: ${r.page.category}, confidence: ${r.page.confidence}\n` +
        `   matched: ${r.matchedFields.join(", ")}`
      )
      .join("\n\n")
  },
}

function scorePage(page: WikiPage, keywords: string[]): number {
  let score = 0
  const titleLower = page.title.toLowerCase()
  const contentLower = page.content.toLowerCase()
  const tagsLower = page.tags.map((t) => t.toLowerCase())

  for (const kw of keywords) {
    // Title match: weight 3
    if (titleLower.includes(kw)) score += 3
    // Content match: weight 1
    const contentMatches = contentLower.split(kw).length - 1
    score += Math.min(contentMatches, 5) // cap at 5 occurrences
    // Tag match: weight 2
    if (tagsLower.some((t) => t.includes(kw))) score += 2
  }
  return score
}

function getMatchedFields(page: WikiPage, keywords: string[]): string[] {
  const fields: string[] = []
  const titleLower = page.title.toLowerCase()
  const contentLower = page.content.toLowerCase()
  const tagsLower = page.tags.map((t) => t.toLowerCase())
  for (const kw of keywords) {
    if (titleLower.includes(kw) && !fields.includes("title")) fields.push("title")
    if (contentLower.includes(kw) && !fields.includes("content")) fields.push("content")
    if (tagsLower.some((t) => t.includes(kw)) && !fields.includes("tags")) fields.push("tags")
  }
  return fields
}
```

### Step 10.6: Create WikiLintTool
**File**: `src/tools/WikiTools/WikiLintTool.ts` (new)
**Action**: Health check: orphan pages, stale content (>30 days), contradiction detection
**LOC**: ~120
**Test**: `bun test src/tools/WikiTools/WikiLintTool.test.ts`
- Detects orphan pages (not referenced by others)
- Detects stale pages (>30 days since lastModified)
- Detects contradictions within same category

```typescript
// src/tools/WikiTools/WikiLintTool.ts
import { z } from "zod"
import { Tool } from "../../Tool"
import { loadWikiIndex } from "./wikiIndex"
import type { WikiPage } from "./types"

const inputSchema = z.object({
  category: z.string().optional().describe("Limit lint to specific category"),
  staleDays: z.number().default(30).describe("Days before a page is considered stale"),
})

interface LintIssue {
  type: "orphan" | "stale" | "contradiction"
  severity: "warning" | "info"
  page: string
  message: string
}

export const WikiLintTool: Tool = {
  name: "wiki_lint",
  description: "Health check wiki for orphan pages, stale content, and contradictions.",
  inputSchema,
  async call(input, ctx) {
    const { category, staleDays } = input
    const projectRoot = ctx.cwd || process.cwd()
    const index = await loadWikiIndex(projectRoot)
    const issues: LintIssue[] = []
    const now = Date.now()
    const staleThreshold = staleDays * 24 * 60 * 60 * 1000

    // Build reverse reference map
    const referencedBy = new Map<string, Set<string>>()
    for (const [, page] of index.pages) {
      for (const ref of page.references) {
        if (!referencedBy.has(ref)) referencedBy.set(ref, new Set())
        referencedBy.get(ref)!.add(page.path)
      }
    }

    for (const [, page] of index.pages) {
      if (category && page.category !== category) continue

      // Orphan check: no other page references this one
      if (!referencedBy.has(page.path) || referencedBy.get(page.path)!.size === 0) {
        issues.push({
          type: "orphan",
          severity: "warning",
          page: page.path,
          message: `Page "${page.title}" is not referenced by any other page`,
        })
      }

      // Stale check
      if (now - page.lastModified > staleThreshold) {
        const daysOld = Math.floor((now - page.lastModified) / (24 * 60 * 60 * 1000))
        issues.push({
          type: "stale",
          severity: "info",
          page: page.path,
          message: `Page "${page.title}" is ${daysOld} days old (threshold: ${staleDays})`,
        })
      }
    }

    // Contradiction detection: pages in same category with opposing keywords
    const categoryPages = new Map<string, WikiPage[]>()
    for (const [, page] of index.pages) {
      if (category && page.category !== category) continue
      const arr = categoryPages.get(page.category) || []
      arr.push(page)
      categoryPages.set(page.category, arr)
    }
    for (const [cat, pages] of categoryPages) {
      detectContradictions(pages, issues)
    }

    if (issues.length === 0) return "Wiki health check passed — no issues found."

    const summary = issues
      .map((i) => `[${i.severity.toUpperCase()}] ${i.type}: ${i.message}`)
      .join("\n")
    return `Found ${issues.length} issue(s):\n${summary}`
  },
}

function detectContradictions(pages: WikiPage[], issues: LintIssue[]): void {
  const opposingPairs = [
    ["yes", "no"], ["true", "false"], ["enable", "disable"],
    ["should", "should not"], ["always", "never"],
  ]
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      for (const [a, b] of opposingPairs) {
        if (
          pages[i].content.toLowerCase().includes(a) &&
          pages[j].content.toLowerCase().includes(b)
        ) {
          issues.push({
            type: "contradiction",
            severity: "warning",
            page: pages[i].path,
            message: `Possible contradiction between "${pages[i].title}" and "${pages[j].title}" (contains "${a}" vs "${b}")`,
          })
        }
      }
    }
  }
}
```

### Step 10.7: Create CRUD tools (add/list/read/delete)
**File**: `src/tools/WikiTools/WikiCrudTools.ts` (new)
**Action**: Implement wiki_add, wiki_list, wiki_read, wiki_delete
**LOC**: ~100
**Test**: `bun test src/tools/WikiTools/WikiCrudTools.test.ts`
- add: creates page file + updates index
- list: returns all pages with optional category filter
- read: returns page content by path
- delete: removes file + updates index

```typescript
// src/tools/WikiTools/WikiCrudTools.ts
import { z } from "zod"
import { readFile, writeFile, unlink, mkdir } from "fs/promises"
import { join, dirname } from "path"
import { Tool } from "../../Tool"
import { loadWikiIndex, saveWikiIndex, rebuildIndex } from "./wikiIndex"
import { parseWikiMarkdown } from "./wikiParser"

// --- wiki_add ---
const addSchema = z.object({
  path: z.string().describe("Relative path within .wiki/"),
  title: z.string().describe("Page title"),
  content: z.string().describe("Markdown content"),
  category: z.string().default("general"),
  tags: z.array(z.string()).default([]),
})

export const WikiAddTool: Tool = {
  name: "wiki_add",
  description: "Add a new wiki page.",
  inputSchema: addSchema,
  async call(input, ctx) {
    const projectRoot = ctx.cwd || process.cwd()
    const wikiRoot = join(projectRoot, ".wiki")
    const filePath = join(wikiRoot, input.path)
    const content = `# ${input.title}\n\n${input.content}`
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, "utf-8")
    const index = await loadWikiIndex(projectRoot)
    const page = parseWikiMarkdown(input.path, content, Date.now())
    page.tags = input.tags
    page.category = input.category
    index.pages.set(input.path, page)
    await saveWikiIndex(projectRoot, index)
    return `Created wiki page: ${input.path}`
  },
}

// --- wiki_list ---
const listSchema = z.object({
  category: z.string().optional().describe("Filter by category"),
})

export const WikiListTool: Tool = {
  name: "wiki_list",
  description: "List wiki pages with optional category filter.",
  inputSchema: listSchema,
  async call(input, ctx) {
    const projectRoot = ctx.cwd || process.cwd()
    const index = await loadWikiIndex(projectRoot)
    const pages = [...index.pages.values()]
      .filter((p) => !input.category || p.category === input.category)
      .sort((a, b) => b.lastModified - a.lastModified)

    if (pages.length === 0) return "No wiki pages found."
    return pages
      .map((p) => `- **${p.title}** (${p.path}) — ${p.confidence} confidence, updated ${new Date(p.lastModified).toISOString().split("T")[0]}`)
      .join("\n")
  },
}

// --- wiki_read ---
const readSchema = z.object({
  path: z.string().describe("Page path within .wiki/"),
})

export const WikiReadTool: Tool = {
  name: "wiki_read",
  description: "Read a wiki page by path.",
  inputSchema: readSchema,
  async call(input, ctx) {
    const projectRoot = ctx.cwd || process.cwd()
    const filePath = join(projectRoot, ".wiki", input.path)
    try {
      return await readFile(filePath, "utf-8")
    } catch {
      return `Error: Wiki page not found: ${input.path}`
    }
  },
}

// --- wiki_delete ---
const deleteSchema = z.object({
  path: z.string().describe("Page path within .wiki/ to delete"),
})

export const WikiDeleteTool: Tool = {
  name: "wiki_delete",
  description: "Delete a wiki page and remove it from the index.",
  inputSchema: deleteSchema,
  async call(input, ctx) {
    const projectRoot = ctx.cwd || process.cwd()
    const filePath = join(projectRoot, ".wiki", input.path)
    try {
      await unlink(filePath)
    } catch {
      return `Error: Wiki page not found: ${input.path}`
    }
    const index = await rebuildIndex(projectRoot)
    await saveWikiIndex(projectRoot, index)
    return `Deleted wiki page: ${input.path}`
  },
}
```

---

## Cross-Plan Coordination

> See also: **Cross-Plan Coordination: query.ts** section in `2026-06-03-performance-optimization-plan.md` for the full query.ts modification map and recommended merge order across all plans.

### Conflict: `src/query.ts` shared with P4 and P7 plans
- **This plan (Task 2.10)**: Adds Langfuse batch span wrapping around `processToolCalls()` in query.ts
- **P4 plan (Performance)**: Tasks 3, 4 modify query.ts (counter instantiation, microcompact region)
- **P7 plan (Infra)**: Tasks 1, 2, 4, 5 modify query.ts (sanitizer, LSP feedback, usage reminder, post-sampling)
- **Merge strategy**: Task 2.10 changes are purely additive (wrap existing code in span calls). Apply P4 and P7 changes first, then wrap the modified `processToolCalls()` with Langfuse spans. No semantic conflict expected. **Merge order**: P4 Task 3 → P7 Task 1 → P4 Task 4 → P7 Task 2/4/5 → **P6 Task 2.10** → P10 Task 9.

### Conflict: `scripts/build.ts` shared with multiple plans
- **This plan (Tasks 1.9, 2.6, I.2)**: Adds `TRANSCRIPT_CLASSIFIER` and `LANGFUSE_TRACING` to `fullExperimentalFeatures`
- **P4 plan**: May also add feature flags to build.ts
- **Merge strategy**: Feature flag additions are independent array entries. Apply in any order; no merge conflict expected. If `fullExperimentalFeatures` array grows significantly, consider grouping by category with comments.

### Conflict: `src/services/api/claude.ts` shared with Task 2.7
- **This plan (Task 2.7)**: Adds Langfuse recording after API calls in `streamMessage()`
- **Other plans**: May modify claude.ts for model config or error handling
- **Merge strategy**: Langfuse recording is a post-call addition (after response handling). Apply other claude.ts changes first, then add the Langfuse guard at the end of the response handling block.

---

## Cross-Task Integration Steps

### Step I.1: Register all new tools in tools.ts
**File**: `src/tools.ts` (modify)
**Action**: Import and register RalphTool, WikiTools, LspTools, AST tools
**LOC**: ~20
**Test**: `bun test src/tools.test.ts`

### Step I.2: Register feature flags in build.ts
**File**: `scripts/build.ts` (modify)
**Action**: Add TRANSCRIPT_CLASSIFIER, LANGFUSE_TRACING to fullExperimentalFeatures
**LOC**: ~2
**Test**: `bun run build:dev` succeeds

### Step I.3: Update CLAUDE.md documentation
**File**: `CLAUDE.md` (modify)
**Action**: Add new subsystems to Key Architecture table, new files to Important Files table
**LOC**: ~30
**Test**: Manual review

---

## Test Strategy

### Unit Tests (per step)
Each step includes a `bun test` command targeting the specific file. All tests use Bun's built-in test runner.

### Integration Tests
- Task 1: Permission flow integration (classifier → permissions.ts → auto-approve/block)
- Task 2: API call → Langfuse recording → flush
- Task 7: LSP tool → withLspClient → LSPServerManager → mock server

### Test File Locations
All test files follow the pattern: `src/<module>/<file>.test.ts` (co-located with source).

---

## Execution Order

```
Phase 1 (P0, independent, can run in parallel):
  Task 3: Ultra Effort + Ultrathink fix         (~30 min)
  Task 2: Langfuse Tracing                       (~60 min)

Phase 2 (P0/P1, depends on Phase 1 for Langfuse):
  Task 1: YOLO Classifier                        (~60 min)
  Task 7: LSP Tools                              (~45 min)

Phase 3 (P1, independent, can run in parallel):
  Task 4: Ultraplan prompts + UI                 (~30 min)
  Task 5: Ralph PRD System                       (~45 min)
  Task 6: Learner Auto-Skill                     (~45 min)

Phase 4 (P1/P2, independent, can run in parallel):
  Task 8: HUD Status Bar                         (~60 min)
  Task 9: Multi-Platform Notifications           (~60 min)
  Task 10: Wiki Knowledge Layer                  (~45 min)

Phase 5: Cross-Task Integration
  Step I.1-I.3                                   (~15 min)
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| OTel dependency conflict (Task 2) | Use peerDependenciesMeta optional, runtime isolation via independent BasicTracerProvider |
| 53+ tools need toAutoClassifierInput (Task 1) | Phased: Phase 1 = 8 core tools, Phase 2-4 = incremental |
| LSP server availability varies (Task 7) | Feature flag off by default; graceful "No LSP server" error |
| Stats.tsx conflict between HUD + Analytics tabs (Task 8) | Coordinate both tabs in single change; isolate in separate components |
| Classifier false positives (Task 1) | Conservative defaults; user feedback loop; cache 60s TTL |

---

## Success Criteria

- [ ] All `bun test` commands pass for each step
- [ ] Feature flags gate all new functionality (zero overhead when disabled)
- [ ] No breaking changes to existing APIs, tools, or commands
- [ ] Langfuse tracing produces valid trace trees in Langfuse UI
- [ ] YOLO classifier correctly blocks dangerous operations in auto mode
- [ ] LSP tools return accurate results for supported languages
- [ ] HUD renders correctly at various terminal widths
- [ ] Notifications dispatch to configured platforms
- [ ] Wiki tools correctly CRUD knowledge pages
