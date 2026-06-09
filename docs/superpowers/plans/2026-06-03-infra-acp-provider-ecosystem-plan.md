# Infrastructure + ACP Vault + Provider Extension + Ecosystem Implementation Plan

**Date**: 2026-06-03
**Design Docs**:
- `/Users/heal/ola-cc/docs/superpowers/specs/2026-06-03-infrastructure-hardening-design.md`
- `/Users/heal/ola-cc/docs/superpowers/specs/2026-06-03-acp-vault-design.md`
- `/Users/heal/ola-cc/docs/superpowers/specs/2026-06-03-provider-extension-design.md`
- `/Users/heal/ola-cc/docs/superpowers/specs/2026-06-03-ecosystem-extensibility-design.md`

**Total Tasks**: 10
**Test Runner**: `bun test`
**Estimated LOC**: ~3,630 (new) + ~130 (modifications)

---

## Task 1: Empty Message Sanitizer + Tool Argument Normalization (P1, ~250 LOC)

**Design Doc**: Infrastructure Hardening, Sections 3 & 7
**Source Reference**: See Infrastructure Hardening design doc Section 3 (Empty Message Sanitizer) and Section 7 (Tool Argument Normalization)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 1.1 | Write tests | `src/services/api/emptyMessageSanitizer.test.ts` | New | ~80 |
| 1.2 | Implement sanitizer | `src/services/api/emptyMessageSanitizer.ts` | New | ~60 |
| 1.3 | Write tests | `src/services/api/toolArgumentNormalization.test.ts` | New | ~100 |
| 1.4 | Implement normalizer | `src/services/api/toolArgumentNormalization.ts` | New | ~150 |
| 1.5 | Integrate into query.ts | `src/query.ts` | Modify | ~15 |

### Step 1.1: Write tests for Empty Message Sanitizer

**File**: `/Users/heal/ola-cc/src/services/api/emptyMessageSanitizer.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import { sanitizeMessages } from './emptyMessageSanitizer'

describe('sanitizeMessages', () => {
  const PLACEHOLDER = '[empty message — no content provided]'

  it('injects placeholder for empty string content', () => {
    const messages = [{ role: 'user' as const, content: '' }]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe(PLACEHOLDER)
  })

  it('injects placeholder for whitespace-only string content', () => {
    const messages = [{ role: 'user' as const, content: '   ' }]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe(PLACEHOLDER)
  })

  it('injects placeholder for empty array content', () => {
    const messages = [{ role: 'user' as const, content: [] as any[] }]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toEqual([{ type: 'text', text: PLACEHOLDER }])
  })

  it('injects placeholder when array has only empty text blocks', () => {
    const messages = [{ role: 'assistant' as const, content: [{ type: 'text', text: '   ' }] as any[] }]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toContainEqual({ type: 'text', text: PLACEHOLDER })
  })

  it('preserves non-empty content', () => {
    const messages = [{ role: 'user' as const, content: 'Hello world' }]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe('Hello world')
  })

  it('preserves array content with non-empty text', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text', text: 'Hello' }] as any[] }]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('skips system messages', () => {
    const messages = [{ role: 'system' as const, content: '' }]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe('')
  })

  it('handles multiple messages', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: '' },
      { role: 'user' as const, content: '' },
    ]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe('Hello')
    expect(result[1].content).toBe(PLACEHOLDER)
    expect(result[2].content).toBe(PLACEHOLDER)
  })
})
```

Run: `bun test src/services/api/emptyMessageSanitizer.test.ts` -- expect all failures.

### Step 1.2: Implement Empty Message Sanitizer

**File**: `/Users/heal/ola-cc/src/services/api/emptyMessageSanitizer.ts`

Create file implementing:
- `sanitizeMessages(messages)`: iterates messages, detects empty string/array content, injects `PLACEHOLDER`
- PLACEHOLDER: `'[empty message — no content provided]'`
- Only processes `user` and `assistant` role messages
- Handles: empty string, whitespace-only string, empty array, array with all-empty text blocks

### Step 1.3: Write tests for Tool Argument Normalization

**File**: `/Users/heal/ola-cc/src/services/api/toolArgumentNormalization.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import { normalizeToolArgs, detectParamType } from './toolArgumentNormalization'

describe('detectParamType', () => {
  it('detects string', () => expect(detectParamType('hello')).toBe('string'))
  it('detects array', () => expect(detectParamType([1, 2])).toBe('array'))
  it('detects object', () => expect(detectParamType({ a: 1 })).toBe('object'))
  it('detects malformed-json string', () => expect(detectParamType('{"a":1}')).toBe('malformed-json'))
  it('returns undefined for null', () => expect(detectParamType(null)).toBeUndefined())
  it('returns undefined for number', () => expect(detectParamType(42)).toBeUndefined())
})

describe('normalizeToolArgs', () => {
  const mockSchema = { type: 'object' as const, properties: {} }

  it('wraps bare string into {command: "..."} for BashTool', () => {
    const rules = [{
      name: 'bash-string-wrap',
      matches: { toolName: 'Bash', paramType: 'string' as const },
      transform: (raw: unknown) => ({ command: String(raw) }),
    }]
    const result = normalizeToolArgs('Bash', 'ls -la', mockSchema, rules)
    expect(result.normalized).toEqual({ command: 'ls -la' })
    expect(result.changed).toBe(true)
    expect(result.appliedRules).toContain('bash-string-wrap')
  })

  it('does not apply rule for non-matching tool', () => {
    const rules = [{
      name: 'bash-only',
      matches: { toolName: 'Bash', paramType: 'string' as const },
      transform: () => ({ wrapped: true }),
    }]
    const result = normalizeToolArgs('Read', 'test.ts', mockSchema, rules)
    expect(result.normalized).toBe('test.ts')
    expect(result.changed).toBe(false)
  })

  it('applies multiple rules in order', () => {
    const rules = [
      { name: 'r1', matches: {}, transform: (raw: unknown) => ({ ...raw as object, r1: true }) },
      { name: 'r2', matches: {}, transform: (raw: unknown) => ({ ...raw as object, r2: true }) },
    ]
    const result = normalizeToolArgs('Test', { a: 1 }, mockSchema, rules)
    expect(result.appliedRules).toEqual(['r1', 'r2'])
    expect(result.normalized).toEqual({ a: 1, r1: true, r2: true })
  })
})
```

### Step 1.4: Implement Tool Argument Normalization

**File**: `/Users/heal/ola-cc/src/services/api/toolArgumentNormalization.ts`

Create file implementing:
- `detectParamType(value)`: classifies value as `'string' | 'array' | 'object' | 'malformed-json' | undefined`
- `normalizeToolArgs(toolName, rawArgs, schema, rules)`: applies matching rules sequentially
- `NormalizationRule` and `NormalizationResult` interfaces
- Default rules array: bash string wrap, malformed JSON parse

### Step 1.5: Integrate into query.ts

**File**: `/Users/heal/ola-cc/src/query.ts`

- Import `sanitizeMessages` from `./services/api/emptyMessageSanitizer.js`
- Import `normalizeToolArgs` from `./services/api/toolArgumentNormalization.js`

**Insertion Point 1 — Before API call (sanitize messages)**:
- Location: function `queryLoop()` (line 363), after `let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]` (line 569)
- INSERT POINT: after line 569, before `let tracking = autoCompactTracking` (line 571)
- Code:
```typescript
// INSERT POINT: Empty Message Sanitizer — sanitize messages before API call
if (isEnvTruthy(process.env.OLA_CC_EMPTY_MSG_SANITIZER)) {
  messagesForQuery = sanitizeMessages(messagesForQuery)
}
```

**Insertion Point 2 — Before tool execution (normalize tool args)**:
- Location: function `queryLoop()`, in the tool execution section after `queryCheckpoint("query_tool_execution_start")` (line 2080)
- INSERT POINT: after line 2094 (end of streamingToolExecution log events), before `const toolUpdates = streamingToolExecutor` (line 2096)
- Code:
```typescript
// INSERT POINT: Tool Argument Normalization — normalize tool args before execution
if (isEnvTruthy(process.env.OLA_CC_TOOL_ARG_NORMALIZATION)) {
  for (const block of toolUseBlocks) {
    const { normalized, appliedRules } = normalizeToolArgs(
      block.name,
      block.input,
      toolUseContext.options.tools.find(t => t.name === block.name)?.inputSchema,
      defaultNormalizationRules,
    )
    if (appliedRules.length > 0) {
      block.input = normalized
      logForDebugging?.(`[ToolArgNorm] ${block.name}: applied ${appliedRules.join(', ')}`)
    }
  }
}
```

Run: `bun test src/services/api/emptyMessageSanitizer.test.ts src/services/api/toolArgumentNormalization.test.ts` -- expect all pass.

---

## Task 2: Persistent Agent Memory Store (P1, ~250 LOC)

**Design Doc**: Infrastructure Hardening, Section 5
**Source Reference**: See Infrastructure Hardening design doc Section 5 (Persistent Agent Memory Store)
**Existing Code**: `/Users/heal/ola-cc/src/tools/AgentTool/agentMemory.ts` (scope/path logic exists, missing CRUD store)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 2.1 | Write tests | `src/tools/AgentTool/agentMemoryStore.test.ts` | New | ~120 |
| 2.2 | Implement store | `src/tools/AgentTool/agentMemoryStore.ts` | New | ~200 |

### Step 2.1: Write tests for AgentMemoryStore

**File**: `/Users/heal/ola-cc/src/tools/AgentTool/agentMemoryStore.test.ts`

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentMemoryStoreImpl } from './agentMemoryStore'

describe('AgentMemoryStore', () => {
  let tmpDir: string
  let store: AgentMemoryStoreImpl

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-test-'))
    store = new AgentMemoryStoreImpl(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes and reads a memory entry', async () => {
    await store.write('project', 'test-key', { content: 'hello', tags: ['a'], source: 'manual' })
    const entry = await store.read('project', 'test-key')
    expect(entry?.content).toBe('hello')
    expect(entry?.tags).toEqual(['a'])
    expect(entry?.source).toBe('manual')
    expect(entry?.createdAt).toBeGreaterThan(0)
    expect(entry?.updatedAt).toBeGreaterThanOrEqual(entry!.createdAt)
  })

  it('returns undefined for non-existent key', async () => {
    const entry = await store.read('user', 'missing')
    expect(entry).toBeUndefined()
  })

  it('overwrites existing entry', async () => {
    await store.write('project', 'k', { content: 'v1', tags: [], source: 'manual' })
    await store.write('project', 'k', { content: 'v2', tags: ['x'], source: 'auto-extract' })
    const entry = await store.read('project', 'k')
    expect(entry?.content).toBe('v2')
    expect(entry?.tags).toEqual(['x'])
  })

  it('lists entries with metadata', async () => {
    await store.write('project', 'a', { content: 'alpha', tags: ['t1'], source: 'manual' })
    await store.write('project', 'b', { content: 'beta', tags: ['t2'], source: 'manual' })
    const index = await store.list('project')
    expect(index.length).toBe(2)
    expect(index.map(i => i.key).sort()).toEqual(['a', 'b'])
  })

  it('deletes entry silently if not exists', async () => {
    await store.delete('project', 'nonexistent')
  })

  it('deletes existing entry', async () => {
    await store.write('project', 'k', { content: 'v', tags: [], source: 'manual' })
    await store.delete('project', 'k')
    const entry = await store.read('project', 'k')
    expect(entry).toBeUndefined()
  })

  it('isolates scopes', async () => {
    await store.write('user', 'k', { content: 'user-val', tags: [], source: 'manual' })
    await store.write('project', 'k', { content: 'project-val', tags: [], source: 'manual' })
    expect((await store.read('user', 'k'))?.content).toBe('user-val')
    expect((await store.read('project', 'k'))?.content).toBe('project-val')
  })

  it('supports remote memory dir via constructor override', async () => {
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-mem-'))
    const remoteStore = new AgentMemoryStoreImpl(undefined, remoteDir)
    await remoteStore.write('user', 'rk', { content: 'remote', tags: [], source: 'manual' })
    const entry = await remoteStore.read('user', 'rk')
    expect(entry?.content).toBe('remote')
    fs.rmSync(remoteDir, { recursive: true, force: true })
  })
})
```

Run: `bun test src/tools/AgentTool/agentMemoryStore.test.ts` -- expect all failures.

### Step 2.2: Implement AgentMemoryStore

**File**: `/Users/heal/ola-cc/src/tools/AgentTool/agentMemoryStore.ts`

Create file implementing:
- `AgentMemoryStoreImpl` class with `read`, `write`, `list`, `delete` methods
- Three scopes: `user` (~/.ola-cc/agent-memory-store/), `project` (.ola-cc/agent-memory-store/), `local` (.ola-cc/agent-memory-store-local/)
- JSON file per entry: `<scope-dir>/<key>.json`
- `MemoryEntry` interface: `content`, `createdAt`, `updatedAt`, `tags`, `source`
- `MemoryIndex` interface: `key`, `summary` (first 100 chars of content), `updatedAt`, `tags`
- `CLAUDE_CODE_REMOTE_MEMORY_DIR` env var support for user scope
- Atomic writes via tmp file + rename

Run: `bun test src/tools/AgentTool/agentMemoryStore.test.ts` -- expect all pass.

---

## Task 3: Pre-Compact Checkpoint + Session History Search (P1, ~350 LOC)

**Design Doc**: Infrastructure Hardening, Sections 6 & 12
**Source Reference**: See Infrastructure Hardening design doc Section 6 (Pre-Compact Checkpoint) and Section 12 (Session History Search)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 3.1 | Write tests | `src/services/compact/preCompactCheckpoint.test.ts` | New | ~80 |
| 3.2 | Implement checkpoint | `src/services/compact/preCompactCheckpoint.ts` | New | ~130 |
| 3.3 | Write tests | `src/services/session-history-search/index.test.ts` | New | ~100 |
| 3.4 | Implement search | `src/services/session-history-search/index.ts` | New | ~180 |
| 3.5 | Integrate checkpoint | `src/services/compact/compact.ts` | Modify | ~20 |

### Step 3.1: Write tests for Pre-Compact Checkpoint

**File**: `/Users/heal/ola-cc/src/services/compact/preCompactCheckpoint.test.ts`

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { savePreCompactCheckpoint, loadCheckpoints } from './preCompactCheckpoint'

describe('PreCompactCheckpoint', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'))
    process.env.OLA_CC_CHECKPOINT_DIR = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.OLA_CC_CHECKPOINT_DIR
  })

  it('saves checkpoint with all required fields', async () => {
    const checkpoint = await savePreCompactCheckpoint('session-1', {
      activeMode: 'autopilot',
      todoSummary: [{ id: 't1', text: 'fix bug', status: 'pending' }],
      wisdom: [{ key: 'w1', content: 'always test' }],
      backgroundTasks: [{ id: 'bg1', name: 'lint', status: 'running', progress: 50 }],
      messageCount: 42,
    })
    expect(checkpoint.sessionId).toBe('session-1')
    expect(checkpoint.activeMode).toBe('autopilot')
    expect(checkpoint.todoSummary).toHaveLength(1)
    expect(checkpoint.wisdom).toHaveLength(1)
    expect(checkpoint.backgroundTasks).toHaveLength(1)
    expect(checkpoint.messageCount).toBe(42)
    expect(checkpoint.sizeBytes).toBeGreaterThan(0)
    expect(checkpoint.timestamp).toBeGreaterThan(0)
  })

  it('persists checkpoint to disk', async () => {
    await savePreCompactCheckpoint('session-2', {
      activeMode: 'none',
      todoSummary: [],
      wisdom: [],
      backgroundTasks: [],
      messageCount: 10,
    })
    const checkpoints = loadCheckpoints('session-2')
    expect(checkpoints.length).toBeGreaterThanOrEqual(1)
    expect(checkpoints[0].sessionId).toBe('session-2')
  })

  it('handles minimal state gracefully', async () => {
    const checkpoint = await savePreCompactCheckpoint('s3', {
      activeMode: 'none',
      todoSummary: [],
      wisdom: [],
      backgroundTasks: [],
      messageCount: 0,
    })
    expect(checkpoint.sizeBytes).toBeGreaterThan(0)
  })
})
```

Run: `bun test src/services/compact/preCompactCheckpoint.test.ts` -- expect all failures.

### Step 3.2: Implement Pre-Compact Checkpoint

**File**: `/Users/heal/ola-cc/src/services/compact/preCompactCheckpoint.ts`

Create file implementing:
- `savePreCompactCheckpoint(sessionId, state)`: serializes state to JSON, writes to checkpoint dir
- `loadCheckpoints(sessionId)`: reads all checkpoint files for a session
- `PreCompactCheckpoint` interface with all fields from design doc
- Checkpoint dir: `process.env.OLA_CC_CHECKPOINT_DIR` or `<cwd>/.ola-cc/checkpoints/`
- File naming: `pre-compact-<timestamp>.json`
- Atomic write: tmp + rename

### Step 3.3: Write tests for Session History Search

**File**: `/Users/heal/ola-cc/src/services/session-history-search/index.test.ts`

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { searchSessionHistory, parseRelativeTime } from './index'

describe('parseRelativeTime', () => {
  it('parses minutes', () => expect(parseRelativeTime('30m')).toBe(30 * 60 * 1000))
  it('parses hours', () => expect(parseRelativeTime('2h')).toBe(2 * 3600 * 1000))
  it('parses days', () => expect(parseRelativeTime('7d')).toBe(7 * 86400 * 1000))
  it('returns 0 for invalid', () => expect(parseRelativeTime('abc')).toBe(0))
})

describe('searchSessionHistory', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-search-test-'))
    // Create mock transcript files
    const transcriptDir = path.join(tmpDir, 'projects', 'test-project')
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(transcriptDir, 'session-1.jsonl'),
      JSON.stringify({ role: 'user', content: 'fix the auth bug' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'I will fix the authentication issue' }) + '\n'
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds matching sessions by pattern', async () => {
    const results = await searchSessionHistory({
      pattern: 'auth',
      projectPath: 'test-project',
      includeWorktrees: false,
      limit: 10,
      transcriptBaseDir: tmpDir,
    })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].matches.length).toBeGreaterThan(0)
  })

  it('returns empty for non-matching pattern', async () => {
    const results = await searchSessionHistory({
      pattern: 'nonexistent-xyz-12345',
      includeWorktrees: false,
      limit: 10,
      transcriptBaseDir: tmpDir,
    })
    expect(results).toHaveLength(0)
  })
})
```

### Step 3.4: Implement Session History Search

**File**: `/Users/heal/ola-cc/src/services/session-history-search/index.ts`

Create file implementing:
- `searchSessionHistory(query)`: reads JSONL transcript files, searches for pattern matches
- `parseRelativeTime(str)`: parses `30m`/`2h`/`7d` to milliseconds
- `SessionHistorySearchQuery` and `SessionSearchResult` interfaces
- Support time range filtering, project path filtering, worktree awareness
- Score-based ranking: exact match > partial match

### Step 3.5: Integrate Pre-Compact Checkpoint into compact.ts

**File**: `/Users/heal/ola-cc/src/services/compact/compact.ts`

- Import `savePreCompactCheckpoint` from `./preCompactCheckpoint.js`

**Insertion Point — Before `executePreCompactHooks()` in `compactConversation()`**:
- Location: function `compactConversation()` (line 394), inside the `try` block
- INSERT POINT: after `const appState = context.getAppState()` (line 417), before `executePreCompactHooks()` — this ensures `appState` is available for the checkpoint code
- Code:
```typescript
// INSERT POINT: Pre-Compact Checkpoint — save state before hooks run
// Note: appState is already declared on line 417 as `const appState = context.getAppState()`
//       Do NOT re-declare it here; reuse the existing variable.
if (isEnvTruthy(process.env.OLA_CC_PRE_COMPACT_CHECKPOINT)) {
  const sessionId = appState.sessionId ?? 'unknown'
  await savePreCompactCheckpoint(sessionId, {
    activeMode: appState.activeMode ?? 'none',
    todoSummary: appState.todos?.map(t => ({ id: t.id, text: t.text, status: t.status })) ?? [],
    wisdom: appState.wisdomEntries ?? [],
    backgroundTasks: appState.backgroundTasks?.map(t => ({ id: t.id, name: t.name, status: t.status, progress: t.progress })) ?? [],
    messageCount: messages.length,
  })
}
```

**Note**: There is a second `executePreCompactHooks()` call in `partialCompactConversation()` (line 908). The same checkpoint insertion should be applied there as well, after `const preCompactTokenCount = tokenCountWithEstimation(allMessages)` (line 900) and before `context.onCompactProgress?.(...)` (line 902).

Run: `bun test src/services/compact/preCompactCheckpoint.test.ts src/services/session-history-search/index.test.ts` -- expect all pass.

---

## Task 4: LocalVault + Keychain Integration (P1, ~350 LOC)

**Design Doc**: ACP Vault Design, Sections 3 & 8
**Source Reference**: See ACP Vault Design doc Section 3 (LocalVault) and Section 8 (Keychain Integration)
**Existing Code**: `/Users/heal/ola-cc/src/utils/secureStorage/` (macOS keychain + plain text exists, missing Linux/Windows + AES encryption)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 4.1 | Write tests | `src/services/localVault/localVault.test.ts` | New | ~120 |
| 4.2 | Implement vault | `src/services/localVault/localVault.ts` | New | ~250 |
| 4.3 | Implement keychain wrapper | `src/services/localVault/keychain.ts` | New | ~135 |
| 4.4 | Add Linux storage | `src/utils/secureStorage/linuxSecretStorage.ts` | New | ~90 |
| 4.5 | Add Windows storage | `src/utils/secureStorage/windowsCredentialStorage.ts` | New | ~100 |
| 4.6 | Wire platform dispatch | `src/utils/secureStorage/index.ts` | Modify | ~15 |

### Step 4.1: Write tests for LocalVault

**File**: `/Users/heal/ola-cc/src/services/localVault/localVault.test.ts`

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { LocalVault } from './localVault'

describe('LocalVault', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'))
    process.env.OLA_CC_VAULT_DIR = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.OLA_CC_VAULT_DIR
  })

  it('stores and retrieves a secret', async () => {
    const vault = new LocalVault({ passphrase: 'test-passphrase-123' })
    await vault.setSecret('api-key', 'sk-abc123')
    const value = await vault.getSecret('api-key')
    expect(value).toBe('sk-abc123')
  })

  it('returns null for non-existent key', async () => {
    const vault = new LocalVault({ passphrase: 'test-passphrase-123' })
    const value = await vault.getSecret('missing-key')
    expect(value).toBeNull()
  })

  it('overwrites existing secret', async () => {
    const vault = new LocalVault({ passphrase: 'test-passphrase-123' })
    await vault.setSecret('k', 'v1')
    await vault.setSecret('k', 'v2')
    expect(await vault.getSecret('k')).toBe('v2')
  })

  it('deletes a secret', async () => {
    const vault = new LocalVault({ passphrase: 'test-passphrase-123' })
    await vault.setSecret('k', 'v')
    await vault.deleteSecret('k')
    expect(await vault.getSecret('k')).toBeNull()
  })

  it('enforces 64KB value limit', async () => {
    const vault = new LocalVault({ passphrase: 'test-passphrase-123' })
    const bigValue = 'x'.repeat(64 * 1024 + 1)
    await expect(vault.setSecret('k', bigValue)).rejects.toThrow('64KB')
  })

  it('uses AAD to prevent record swap attacks', async () => {
    const vault = new LocalVault({ passphrase: 'test-passphrase-123' })
    await vault.setSecret('key-a', 'value-a')
    await vault.setSecret('key-b', 'value-b')
    // Reading key-a should NOT return value-b
    expect(await vault.getSecret('key-a')).toBe('value-a')
    expect(await vault.getSecret('key-b')).toBe('value-b')
  })

  it('rejects invalid UTF-8 on decrypt', async () => {
    const vault = new LocalVault({ passphrase: 'test-passphrase-123' })
    await vault.setSecret('k', 'valid')
    // Corrupt the stored file
    const files = fs.readdirSync(tmpDir)
    const vaultFile = files.find(f => f.endsWith('.vault'))
    if (vaultFile) {
      const data = fs.readFileSync(path.join(tmpDir, vaultFile))
      // Flip bytes in the encrypted payload area
      data[data.length - 5] ^= 0xff
      fs.writeFileSync(path.join(tmpDir, vaultFile), data)
    }
    await expect(vault.getSecret('k')).resolves.toBeNull()
  })
})
```

Run: `bun test src/services/localVault/localVault.test.ts` -- expect all failures.

### Step 4.2: Implement LocalVault

**File**: `/Users/heal/ola-cc/src/services/localVault/localVault.ts`

Create file implementing:
- `LocalVault` class with `setSecret`, `getSecret`, `deleteSecret` methods
- AES-256-GCM encryption: per-entry random 12-byte IV, AAD = entry key
- KDF: `scryptSync` (N:16384, r:8, p:1), per-vault 16-byte random salt
- Value limit: 64KB enforcement
- Derived key zeroing: `key256.fill(0)` after use
- `TextDecoder('utf-8', { fatal: true })` for invalid UTF-8 detection
- Atomic writes: tmp file + POSIX rename
- Passphrase priority: env var > file > auto-generate
- Vault file path: `process.env.OLA_CC_VAULT_DIR` or `~/.claude/vault/`

### Step 4.3: Implement Keychain Wrapper

**File**: `/Users/heal/ola-cc/src/services/localVault/keychain.ts`

Create file implementing:
- `KeychainAccess` interface: `set`, `get`, `delete`, `list`
- `__index__` account for key listing
- Lazy module loading: `_mod` three-state cache (`'not-tried'`/`null`/`KeyringModule`)
- `__index__` corruption recovery via `security find-generic-password` scan
- Bun compatibility: try `@napi-rs/keyring` first, fallback to CLI (`security`/`secret-tool`/PowerShell)

### Step 4.4: Add Linux Secret Storage

**File**: `/Users/heal/ola-cc/src/utils/secureStorage/linuxSecretStorage.ts`

Create file implementing `SecureStorage` interface using `secret-tool lookup/set` CLI commands. Pattern follows `macOsKeychainStorage.ts`.

### Step 4.5: Add Windows Credential Storage

**File**: `/Users/heal/ola-cc/src/utils/secureStorage/windowsCredentialStorage.ts`

Create file implementing `SecureStorage` interface using PowerShell DPAPI (`ProtectedData::Protect/Unprotect`) with CurrentUser scope.

### Step 4.6: Wire Platform Dispatch

**File**: `/Users/heal/ola-cc/src/utils/secureStorage/index.ts`

Modify `getSecureStorage()`:
```typescript
export function getSecureStorage(): SecureStorage {
  if (process.platform === 'darwin') {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }
  if (process.platform === 'linux') {
    return createFallbackStorage(linuxSecretStorage, plainTextStorage)
  }
  if (process.platform === 'win32') {
    return createFallbackStorage(windowsCredentialStorage, plainTextStorage)
  }
  return plainTextStorage
}
```

Run: `bun test src/services/localVault/localVault.test.ts` -- expect all pass.

---

## Task 5: ACP Agent + NDJSON Protocol (P1, ~400 LOC)

**Design Doc**: ACP Vault Design, Section 2
**Source Reference**: See ACP Vault Design doc Section 2 (ACP Agent + NDJSON Protocol)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 5.1 | Write tests | `src/services/acp/ndjson.test.ts` | New | ~80 |
| 5.2 | Implement NDJSON protocol | `src/services/acp/ndjson.ts` | New | ~60 |
| 5.3 | Write tests | `src/services/acp/agent.test.ts` | New | ~100 |
| 5.4 | Implement ACP Agent | `src/services/acp/agent.ts` | New | ~350 |
| 5.5 | Implement ACP entry | `src/services/acp/entry.ts` | New | ~75 |
| 5.6 | Implement ACP bridge | `src/services/acp/bridge.ts` | New | ~120 |
| 5.7 | Wire CLI entry | `src/entrypoints/cli.tsx` | Modify | ~20 |

### Step 5.1: Write tests for NDJSON Protocol

**File**: `/Users/heal/ola-cc/src/services/acp/ndjson.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import { serializeAcpMessage, deserializeAcpStream } from './ndjson'

describe('serializeAcpMessage', () => {
  it('serializes heartbeat message', () => {
    const msg = { type: 'heartbeat' as const, payload: { timestamp: '2026-06-03T00:00:00Z' } }
    const line = serializeAcpMessage(msg)
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual(msg)
  })

  it('serializes session_update', () => {
    const msg = { type: 'session_update' as const, payload: { action: 'start' as const, sessionId: 's1', model: 'opus' } }
    const line = serializeAcpMessage(msg)
    const parsed = JSON.parse(line)
    expect(parsed.type).toBe('session_update')
    expect(parsed.payload.action).toBe('start')
  })
})

describe('deserializeAcpStream', () => {
  it('parses multiple messages from chunk', () => {
    const chunk =
      JSON.stringify({ type: 'heartbeat', payload: { timestamp: 't1' } }) + '\n' +
      JSON.stringify({ type: 'agent_prompt', payload: { text: 'hello' } }) + '\n'
    const messages = [...deserializeAcpStream(chunk)]
    expect(messages).toHaveLength(2)
    expect(messages[0].type).toBe('heartbeat')
    expect(messages[1].type).toBe('agent_prompt')
  })

  it('handles empty lines gracefully', () => {
    const chunk = '\n\n' + JSON.stringify({ type: 'heartbeat', payload: { timestamp: 't' } }) + '\n\n'
    const messages = [...deserializeAcpStream(chunk)]
    expect(messages).toHaveLength(1)
  })

  it('throws on invalid JSON', () => {
    expect(() => [...deserializeAcpStream('not-json\n')]).toThrow()
  })
})
```

### Step 5.2: Implement NDJSON Protocol

**File**: `/Users/heal/ola-cc/src/services/acp/ndjson.ts`

Create file implementing:
- `AcpMessage` type union: `session_update | agent_prompt | agent_response | heartbeat | error`
- `SessionUpdate` type union: `start | stop | compact | progress`
- `serializeAcpMessage(msg)`: `JSON.stringify(msg) + '\n'`
- `deserializeAcpStream(chunk)`: generator yielding parsed messages
- Error code constants: `SESSION_NOT_FOUND`, `PERMISSION_DENIED`, `MODEL_ERROR`, `CONTEXT_OVERFLOW`, `INTERNAL_ERROR`

### Step 5.3: Write tests for ACP Agent

**File**: `/Users/heal/ola-cc/src/services/acp/agent.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import { AcpAgent } from './agent'

describe('AcpAgent session lifecycle', () => {
  it('creates a new session', () => {
    const agent = new AcpAgent()
    const sessionId = agent.createSession({ cwd: '/tmp' })
    expect(sessionId).toBeTruthy()
    expect(agent.getSession(sessionId)).toBeTruthy()
  })

  it('destroys a session', () => {
    const agent = new AcpAgent()
    const sessionId = agent.createSession({ cwd: '/tmp' })
    agent.destroySession(sessionId)
    expect(agent.getSession(sessionId)).toBeUndefined()
  })

  it('queues prompts when one is running', () => {
    const agent = new AcpAgent()
    const sessionId = agent.createSession({ cwd: '/tmp' })
    agent.enqueuePrompt(sessionId, 'first')
    agent.enqueuePrompt(sessionId, 'second')
    const session = agent.getSession(sessionId)!
    expect(session.pendingQueue).toHaveLength(1) // second is queued
  })

  it('compacts pending queue when head exceeds threshold', () => {
    const agent = new AcpAgent()
    const sessionId = agent.createSession({ cwd: '/tmp' })
    const session = agent.getSession(sessionId)!
    // Simulate high head pointer
    for (let i = 0; i < 2050; i++) {
      session.pendingQueue.push(`msg-${i}`)
    }
    session.pendingQueueHead = 1025
    agent.compactPendingQueue(sessionId)
    expect(session.pendingQueueHead).toBeLessThan(1025)
  })
})
```

### Step 5.4: Implement ACP Agent

**File**: `/Users/heal/ola-cc/src/services/acp/agent.ts`

Create file implementing:
- `AcpAgent` class: `createSession`, `destroySession`, `getSession`, `enqueuePrompt`, `compactPendingQueue`
- `AcpSession` state: `queryEngine`, `cancelled`, `cancelGeneration`, `cwd`, `pendingMessages`, `pendingQueue`, `pendingQueueHead`, `toolUseCache`, `clientCapabilities`
- Heartbeat: 30s interval send `heartbeat` message, 90s timeout detection
- Prompt queue: `pendingMessages` Map + `pendingQueue` array + head pointer + lazy compaction (head > 1024 && consumed > half)

### Step 5.5: Implement ACP Entry

**File**: `/Users/heal/ola-cc/src/services/acp/entry.ts`

Create file implementing:
- `startAcpAgent()`: establishes stdio transport, creates `AcpAgent`, pipes stdin through `deserializeAcpStream`, routes messages to agent

### Step 5.6: Implement ACP Bridge

**File**: `/Users/heal/ola-cc/src/services/acp/bridge.ts`

Create file implementing:
- `forwardSessionUpdates(sdkMessageStream)`: converts SDKMessage stream to AcpMessage stream
- Mapping: `system` -> compact_boundary, `result` -> usage accumulation, `stream_event` -> content forwarding, `assistant` -> full message conversion, `progress` -> subagent progress

### Step 5.7: Wire CLI Entry

**File**: `/Users/heal/ola-cc/src/entrypoints/cli.tsx`

- Add `acp` subcommand in the fast-path dispatch section
- Dynamic import `src/services/acp/entry.js` when `args[0] === 'acp'`

Run: `bun test src/services/acp/` -- expect all pass.

---

## Task 6: Provider Auto-Detect + Schema Conversion (P1, ~300 LOC)

**Design Doc**: Provider Extension, Sections 2 & 7
**Source Reference**: See Provider Extension design doc Section 2 (Provider Auto-Detect) and Section 7 (Schema Conversion)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 6.1 | Write tests | `src/utils/providerAutoDetect.test.ts` | New | ~120 |
| 6.2 | Implement auto-detect | `src/utils/providerAutoDetect.ts` | New | ~180 |
| 6.3 | Write tests | `src/services/api/schemaConversion.test.ts` | New | ~100 |
| 6.4 | Implement schema conversion | `src/services/api/schemaConversion.ts` | New | ~120 |

### Step 6.1: Write tests for Provider Auto-Detect

**File**: `/Users/heal/ola-cc/src/utils/providerAutoDetect.test.ts`

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { detectBestProvider, clearDetectionCache } from './providerAutoDetect'

describe('detectBestProvider', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Clear all provider env vars
    for (const key of Object.keys(process.env)) {
      if (key.includes('API_KEY') || key.includes('TOKEN') || key.startsWith('CLAUDE_CODE_USE_')) {
        delete process.env[key]
      }
    }
    clearDetectionCache()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    clearDetectionCache()
  })

  it('detects anthropic via ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const result = detectBestProvider()
    expect(result?.kind).toBe('anthropic')
    expect(result?.source).toContain('ANTHROPIC_API_KEY')
  })

  it('detects github via GITHUB_TOKEN', () => {
    process.env.GITHUB_TOKEN = 'ghp_test'
    const result = detectBestProvider()
    expect(result?.kind).toBe('github')
  })

  it('detects openai via OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const result = detectBestProvider()
    expect(result?.kind).toBe('openai')
  })

  it('detects gemini via GEMINI_API_KEY', () => {
    process.env.GEMINI_API_KEY = 'test'
    const result = detectBestProvider()
    expect(result?.kind).toBe('gemini')
  })

  it('returns null when no provider detected', () => {
    const result = detectBestProvider()
    expect(result).toBeNull()
  })

  it('respects priority order (anthropic > openai)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.OPENAI_API_KEY = 'sk-test'
    const result = detectBestProvider()
    expect(result?.kind).toBe('anthropic')
  })

  it('caches detection result', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const r1 = detectBestProvider()
    delete process.env.ANTHROPIC_API_KEY
    const r2 = detectBestProvider() // Should return cached result
    expect(r2?.kind).toBe('anthropic')
  })
})
```

### Step 6.2: Implement Provider Auto-Detect

**File**: `/Users/heal/ola-cc/src/utils/providerAutoDetect.ts`

Create file implementing:
- `detectBestProvider()`: checks env vars in priority order (anthropic -> codex -> github -> openai -> gemini -> mistral -> minimax -> xiaomi-mimo -> xai -> ollama -> lm-studio)
- `DetectedProvider` type: `{ kind, source, baseUrl?, model? }`
- Local service probe: `Promise.allSettled` for ollama (localhost:11434) and lm-studio (localhost:1234), 1.2s timeout
- Detection cache: Map with 5-minute TTL
- `clearDetectionCache()`: for testing

### Step 6.3: Write tests for Schema Conversion

**File**: `/Users/heal/ola-cc/src/services/api/schemaConversion.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import { convertToolSchemaToGemini, convertJsonSchemaToGeminiSchema } from './schemaConversion'

describe('convertJsonSchemaToGeminiSchema', () => {
  it('preserves basic types', () => {
    expect(convertJsonSchemaToGeminiSchema({ type: 'string' })).toEqual({ type: 'STRING' })
    expect(convertJsonSchemaToGeminiSchema({ type: 'number' })).toEqual({ type: 'NUMBER' })
    expect(convertJsonSchemaToGeminiSchema({ type: 'boolean' })).toEqual({ type: 'BOOLEAN' })
    expect(convertJsonSchemaToGeminiSchema({ type: 'integer' })).toEqual({ type: 'INTEGER' })
  })

  it('flattens oneOf to first schema', () => {
    const schema = { oneOf: [{ type: 'string' as const }, { type: 'number' as const }] }
    const result = convertJsonSchemaToGeminiSchema(schema)
    expect(result).toEqual({ type: 'STRING' })
  })

  it('removes additionalProperties', () => {
    const schema = { type: 'object' as const, properties: {}, additionalProperties: true }
    const result = convertJsonSchemaToGeminiSchema(schema)
    expect(result).not.toHaveProperty('additionalProperties')
  })

  it('recursively converts properties', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        name: { type: 'string' as const },
        count: { type: 'integer' as const },
      },
    }
    const result = convertJsonSchemaToGeminiSchema(schema)
    expect(result.properties.name).toEqual({ type: 'STRING' })
    expect(result.properties.count).toEqual({ type: 'INTEGER' })
  })

  it('recursively converts array items', () => {
    const schema = { type: 'array' as const, items: { type: 'string' as const } }
    const result = convertJsonSchemaToGeminiSchema(schema)
    expect(result.items).toEqual({ type: 'STRING' })
  })
})

describe('convertToolSchemaToGemini', () => {
  it('converts Anthropic tool to Gemini function declaration', () => {
    const tool = {
      name: 'Bash',
      description: 'Run a bash command',
      input_schema: { type: 'object' as const, properties: { command: { type: 'string' as const } }, required: ['command'] },
    }
    const result = convertToolSchemaToGemini(tool)
    expect(result.functionDeclarations[0].name).toBe('Bash')
    expect(result.functionDeclarations[0].parameters.properties.command).toEqual({ type: 'STRING' })
  })
})
```

### Step 6.4: Implement Schema Conversion

**File**: `/Users/heal/ola-cc/src/services/api/schemaConversion.ts`

Create file implementing:
- `convertToolSchemaToGemini(tool)`: wraps in `functionDeclarations` array
- `convertJsonSchemaToGeminiSchema(schema)`: recursive conversion
  - `oneOf`/`anyOf` -> flatten to first match
  - `additionalProperties` -> remove
  - `type: "null"` -> remove field
  - Type enum mapping: `string`->`STRING`, `number`->`NUMBER`, `integer`->`INTEGER`, `boolean`->`BOOLEAN`, `array`->`ARRAY`, `object`->`OBJECT`
  - `$ref` -> inline expand (best effort)
- `convertToolResultToGemini(toolUseId, result, toolNameLookup)`: maps `toolUseId` to function name

Run: `bun test src/utils/providerAutoDetect.test.ts src/services/api/schemaConversion.test.ts` -- expect all pass.

---

## Task 7: Gemini + Ollama Adapters (P1, ~400 LOC)

**Design Doc**: Provider Extension, Sections 3 & 4
**Source Reference**: See Provider Extension design doc Section 3 (Gemini Adapter) and Section 4 (Ollama Adapter)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 7.1 | Write tests | `src/utils/geminiAuth.test.ts` | New | ~60 |
| 7.2 | Implement Gemini auth | `src/utils/geminiAuth.ts` | New | ~120 |
| 7.3 | Write tests | `src/services/api/geminiAdapter.test.ts` | New | ~100 |
| 7.4 | Implement Gemini adapter | `src/services/api/geminiAdapter.ts` | New | ~200 |
| 7.5 | Wire providers | `src/utils/model/providers.ts` | Modify | ~10 |
| 7.6 | Wire client | `src/services/api/client.ts` | Modify | ~40 |
| 7.7 | Register flags | `scripts/build.ts` | Modify | ~10 |

### Step 7.1: Write tests for Gemini Auth

**File**: `/Users/heal/ola-cc/src/utils/geminiAuth.test.ts`

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { resolveGeminiAuth } from './geminiAuth'

describe('resolveGeminiAuth', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    delete process.env.GEMINI_ACCESS_TOKEN
    delete process.env.GEMINI_AUTH_MODE
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('uses GEMINI_API_KEY when available', () => {
    process.env.GEMINI_API_KEY = 'test-key'
    const auth = resolveGeminiAuth()
    expect(auth.mode).toBe('api-key')
    expect(auth.apiKey).toBe('test-key')
  })

  it('falls back to GOOGLE_API_KEY', () => {
    process.env.GOOGLE_API_KEY = 'google-key'
    const auth = resolveGeminiAuth()
    expect(auth.mode).toBe('api-key')
    expect(auth.apiKey).toBe('google-key')
  })

  it('uses access token when GEMINI_AUTH_MODE=access-token', () => {
    process.env.GEMINI_AUTH_MODE = 'access-token'
    process.env.GEMINI_ACCESS_TOKEN = 'ya29.test'
    const auth = resolveGeminiAuth()
    expect(auth.mode).toBe('access-token')
    expect(auth.accessToken).toBe('ya29.test')
  })

  it('returns null when no credentials found', () => {
    const auth = resolveGeminiAuth()
    expect(auth).toBeNull()
  })
})
```

### Step 7.2: Implement Gemini Auth

**File**: `/Users/heal/ola-cc/src/utils/geminiAuth.ts`

Create file implementing:
- `resolveGeminiAuth()`: checks `GEMINI_API_KEY` -> `GOOGLE_API_KEY` -> `GEMINI_ACCESS_TOKEN` -> ADC file
- `GeminiAuth` type: `{ mode: 'api-key' | 'access-token' | 'adc', apiKey?, accessToken? }`
- `GEMINI_AUTH_MODE` env var override

### Step 7.3: Write tests for Gemini Adapter

**File**: `/Users/heal/ola-cc/src/services/api/geminiAdapter.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import { buildGeminiBody, geminiSseToAnthropic } from './geminiAdapter'

describe('buildGeminiBody', () => {
  it('converts system prompt to systemInstruction', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }]
    const body = buildGeminiBody(messages, {
      systemPrompt: 'You are helpful.',
      model: 'gemini-2.5-flash',
    })
    expect(body.systemInstruction.parts[0].text).toBe('You are helpful.')
  })

  it('maps assistant role to model role', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ]
    const body = buildGeminiBody(messages, { model: 'gemini-2.5-flash' })
    expect(body.contents[0].role).toBe('user')
    expect(body.contents[1].role).toBe('model')
  })

  it('converts tool_use to functionCall', () => {
    const messages = [{
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
    }]
    const body = buildGeminiBody(messages, { model: 'gemini-2.5-flash' })
    expect(body.contents[0].parts[0].functionCall).toBeTruthy()
    expect(body.contents[0].parts[0].functionCall.name).toBe('Bash')
  })

  it('maps max_tokens to generationConfig.maxOutputTokens', () => {
    const body = buildGeminiBody([], { model: 'gemini-2.5-flash', maxTokens: 4096 })
    expect(body.generationConfig.maxOutputTokens).toBe(4096)
  })
})

describe('geminiSseToAnthropic', () => {
  it('converts Gemini SSE text chunk to Anthropic format', () => {
    const geminiChunk = { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }
    const result = geminiSseToAnthropic(geminiChunk)
    expect(result.type).toBe('content_block_delta')
    expect(result.delta.text).toBe('Hello')
  })
})
```

### Step 7.4: Implement Gemini Adapter

**File**: `/Users/heal/ola-cc/src/services/api/geminiAdapter.ts`

Create file implementing:
- `buildGeminiBody(messages, config)`: converts Anthropic messages to Gemini format
  - `assistant` -> `model` role
  - `tool_use` -> `functionCall`
  - `tool_result` -> `functionResponse` (with `toolUseIdToName` mapping)
  - system prompt -> `systemInstruction`
  - `max_tokens` -> `generationConfig.maxOutputTokens`
  - tools -> `functionDeclarations` (using schema conversion from Task 6)
- `geminiSseToAnthropic(chunk)`: converts Gemini SSE response chunks to Anthropic stream events
- `GeminiConfig` interface: `model`, `systemPrompt?`, `maxTokens?`, `temperature?`, `tools?`

### Step 7.5: Wire Providers

**File**: `/Users/heal/ola-cc/src/utils/model/providers.ts`

- Add `'github'` and `'gemini'` to `APIProvider` type union
- Add `CLAUDE_CODE_USE_GITHUB` and `CLAUDE_CODE_USE_GEMINI` branches to `getAPIProvider()`

### Step 7.6: Wire Client

**File**: `/Users/heal/ola-cc/src/services/api/client.ts`

- Add `CLAUDE_CODE_USE_GITHUB` branch: import and use `githubProvider.ts`
- Add `CLAUDE_CODE_USE_GEMINI` branch: import and use `geminiAdapter.ts` via openai.ts
- Both guarded by feature flags

### Step 7.7: Register Feature Flags

**File**: `/Users/heal/ola-cc/scripts/build.ts`

- Add `'GEMINI_PROVIDER'`, `'OLLAMA_PROVIDER'`, `'PROVIDER_AUTO_DETECT'` to `fullExperimentalFeatures` array

Run: `bun test src/utils/geminiAuth.test.ts src/services/api/geminiAdapter.test.ts` -- expect all pass.

---

## Task 8: Plugin Sandbox (P1, ~350 LOC)

**Design Doc**: Ecosystem Extensibility, Section 2.4
**Source Reference**: See Ecosystem Extensibility design doc Section 2.4 (Plugin Sandbox)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 8.1 | Write tests | `src/services/plugin/pluginSandbox.test.ts` | New | ~120 |
| 8.2 | Implement sandbox | `src/services/plugin/pluginSandbox.ts` | New | ~200 |
| 8.3 | Implement manifest types | `src/services/plugin/types.ts` | New | ~40 |

### Step 8.1: Write tests for Plugin Sandbox

**File**: `/Users/heal/ola-cc/src/services/plugin/pluginSandbox.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import { createPluginSandbox, PermissionDeniedError } from './pluginSandbox'

describe('createPluginSandbox', () => {
  const manifest = {
    name: 'test-plugin',
    permissions: {
      filesystem: { read: ['/workspace/**'] },
      network: false,
      subprocess: false,
    },
  }

  it('creates a proxy with no prototype chain', () => {
    const sandbox = createPluginSandbox(manifest)
    expect(Object.getPrototypeOf(sandbox)).toBeNull()
  })

  it('throws PermissionDeniedError for unallowed API access', () => {
    const sandbox = createPluginSandbox(manifest)
    expect(() => (sandbox as any).process).toThrow(PermissionDeniedError)
  })

  it('throws PermissionDeniedError on set attempt', () => {
    const sandbox = createPluginSandbox(manifest)
    expect(() => { (sandbox as any).foo = 'bar' }).toThrow(PermissionDeniedError)
  })

  it('allows access to declared API namespaces', () => {
    const api = { readFile: (path: string) => `content:${path}` }
    const sandbox = createPluginSandbox({ ...manifest, permissions: { ...manifest.permissions, api: { fs: api } } })
    expect((sandbox as any).fs).toBe(api)
  })

  it('intercepts __proto__ access', () => {
    const sandbox = createPluginSandbox(manifest)
    expect(() => (sandbox as any).__proto__).toThrow(PermissionDeniedError)
  })

  it('intercepts constructor access', () => {
    const sandbox = createPluginSandbox(manifest)
    expect(() => (sandbox as any).constructor).toThrow(PermissionDeniedError)
  })

  it('freezes injected API objects', () => {
    const api = { readFile: () => '' }
    const sandbox = createPluginSandbox({ ...manifest, permissions: { ...manifest.permissions, api: { fs: api } } })
    expect(Object.isFrozen((sandbox as any).fs)).toBe(true)
  })

  it('supports has() trap for allowed APIs', () => {
    const api = { readFile: () => '' }
    const sandbox = createPluginSandbox({ ...manifest, permissions: { ...manifest.permissions, api: { fs: api } } })
    expect('fs' in sandbox).toBe(true)
    expect('process' in sandbox).toBe(false)
  })
})
```

### Step 8.2: Implement Plugin Sandbox

**File**: `/Users/heal/ola-cc/src/services/plugin/pluginSandbox.ts`

Create file implementing:
- `createPluginSandbox(manifest)`: returns `Proxy` over `Object.create(null)`
- Proxy handler `get` trap: only allows manifest-declared API namespaces, throws `PermissionDeniedError` for everything else
- Proxy handler `set` trap: always throws
- Proxy handler `has` trap: returns true only for allowed APIs
- Intercepts `__proto__`, `constructor`, `prototype` access
- Deep-freezes all injected API objects via `Object.freeze()`
- `PermissionDeniedError` extends Error
- `buildAllowedAPIs(permissions)`: constructs frozen API surface from manifest

### Step 8.3: Implement Manifest Types

**File**: `/Users/heal/ola-cc/src/services/plugin/types.ts`

Create file implementing:
- `PluginManifest` interface: `name`, `version`, `author`, `description`, `permissions`
- `PluginPermissions` interface: `filesystem`, `network`, `subprocess`, `api`

Run: `bun test src/services/plugin/pluginSandbox.test.ts` -- expect all pass.

---

## Task 9: Skill Store + TF-IDF Search (P1, ~350 LOC)

**Design Doc**: Ecosystem Extensibility, Sections 3 & 4
**Source Reference**: See Ecosystem Extensibility design doc Section 3 (Skill Store) and Section 4 (TF-IDF Search)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 9.1 | Write tests | `src/services/skill-store/index.test.ts` | New | ~80 |
| 9.2 | Implement skill store | `src/services/skill-store/index.ts` | New | ~180 |
| 9.3 | Write tests | `src/services/skill-search/tfidf.test.ts` | New | ~100 |
| 9.4 | Implement TF-IDF engine | `src/services/skill-search/tfidf.ts` | New | ~200 |

### Step 9.1: Write tests for Skill Store

**File**: `/Users/heal/ola-cc/src/services/skill-store/index.test.ts`

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SkillStore } from './index'

describe('SkillStore', () => {
  let tmpDir: string
  let store: SkillStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-store-test-'))
    store = new SkillStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('installs a skill from local path', async () => {
    const skillDir = path.join(tmpDir, 'source-skill')
    fs.mkdirSync(skillDir)
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\nDescription here')

    const entry = await store.install(skillDir)
    expect(entry.name).toBe('source-skill')
    expect(entry.installed).toBe(true)
  })

  it('lists installed skills', async () => {
    const skillDir = path.join(tmpDir, 'my-skill')
    fs.mkdirSync(skillDir)
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill')
    await store.install(skillDir)

    const skills = store.list()
    expect(skills.length).toBeGreaterThanOrEqual(1)
    expect(skills.some(s => s.name === 'my-skill')).toBe(true)
  })

  it('uninstalls a skill', async () => {
    const skillDir = path.join(tmpDir, 'temp-skill')
    fs.mkdirSync(skillDir)
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Temp')
    await store.install(skillDir)
    await store.uninstall('temp-skill')
    expect(store.list().find(s => s.name === 'temp-skill')).toBeUndefined()
  })

  it('gets skill details', async () => {
    const skillDir = path.join(tmpDir, 'detail-skill')
    fs.mkdirSync(skillDir)
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Detail Skill\nA detailed skill')
    await store.install(skillDir)

    const detail = store.get('detail-skill')
    expect(detail?.description).toContain('detailed')
  })
})
```

### Step 9.2: Implement Skill Store

**File**: `/Users/heal/ola-cc/src/services/skill-store/index.ts`

Create file implementing:
- `SkillStore` class: `install`, `uninstall`, `list`, `get`, `search` methods
- `SkillEntry` interface: `id`, `name`, `description`, `version`, `author`, `category`, `installed`
- Local JSON index: `<storeDir>/index.json`
- `install(sourcePath)`: copies SKILL.md + metadata to store, updates index
- `uninstall(name)`: removes from store + index
- `search(query)`: TF-IDF search (delegates to skill-search module)
- OAuth Device Code Flow stub for remote store (future)

### Step 9.3: Write tests for TF-IDF Engine

**File**: `/Users/heal/ola-cc/src/services/skill-search/tfidf.test.ts`

```typescript
import { describe, expect, it } from 'bun:test'
import { TfIdfEngine } from './tfidf'

describe('TfIdfEngine', () => {
  it('indexes documents and searches', () => {
    const engine = new TfIdfEngine()
    engine.addDocument('skill-1', 'git version control commit branch')
    engine.addDocument('skill-2', 'docker container deploy kubernetes')
    engine.addDocument('skill-3', 'git merge rebase conflict resolution')

    const results = engine.search('git commit')
    expect(results.length).toBeGreaterThanOrEqual(2)
    // skill-1 and skill-3 should match; skill-1 should rank higher
    expect(results[0].id).toBe('skill-1')
  })

  it('handles CJK bi-gram tokenization', () => {
    const engine = new TfIdfEngine()
    engine.addDocument('s1', '代码质量检查工具')
    engine.addDocument('s2', '部署流程自动化')

    const results = engine.search('代码质量')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].id).toBe('s1')
  })

  it('removes document from index', () => {
    const engine = new TfIdfEngine()
    engine.addDocument('s1', 'hello world')
    engine.addDocument('s2', 'hello earth')
    engine.removeDocument('s1')

    const results = engine.search('hello world')
    expect(results.find(r => r.id === 's1')).toBeUndefined()
  })

  it('returns empty for no matches', () => {
    const engine = new TfIdfEngine()
    engine.addDocument('s1', 'typescript programming')
    const results = engine.search('quantum physics')
    expect(results).toHaveLength(0)
  })

  it('handles empty query', () => {
    const engine = new TfIdfEngine()
    engine.addDocument('s1', 'test')
    const results = engine.search('')
    expect(results).toHaveLength(0)
  })
})
```

### Step 9.4: Implement TF-IDF Engine

**File**: `/Users/heal/ola-cc/src/services/skill-search/tfidf.ts`

Create file implementing:
- `TfIdfEngine` class: `addDocument`, `removeDocument`, `search` methods
- TF calculation: `log(1 + count(term, doc))`
- IDF calculation: `log(N / df(term)) + 1`
- Similarity: cosine similarity `cos(A,B) = A·B / (|A|x|B|)`
- CJK handling: bi-gram tokenization for CJK Unicode ranges
- English stemming: basic suffix stripping (`-ing`, `-ed`, `-s`)
- Stop words: built-in English stop word list (~150 words)
- In-memory inverted index (no persistence for < 1000 skills)

Run: `bun test src/services/skill-store/index.test.ts src/services/skill-search/tfidf.test.ts` -- expect all pass.

---

## Task 10: Agent Usage Reminder + Non-Interactive Env (P2, ~200 LOC)

**Design Doc**: Infrastructure Hardening, Sections 8 & 9
**Source Reference**: See Infrastructure Hardening design doc Section 8 (Agent Usage Reminder) and Section 9 (Non-Interactive Env)

### Files

| # | Step | File | Action | LOC |
|---|------|------|--------|-----|
| 10.1 | Write tests | `src/hooks/agent-usage-reminder/index.test.ts` | New | ~80 |
| 10.2 | Implement reminder | `src/hooks/agent-usage-reminder/index.ts` | New | ~100 |
| 10.3 | Write tests | `src/hooks/non-interactive-env/index.test.ts` | New | ~60 |
| 10.4 | Implement non-interactive env | `src/hooks/non-interactive-env/index.ts` | New | ~80 |

### Step 10.1: Write tests for Agent Usage Reminder

**File**: `/Users/heal/ola-cc/src/hooks/agent-usage-reminder/index.test.ts`

```typescript
import { describe, expect, it, beforeEach } from 'bun:test'
import { UsageReminderTracker } from './index'

describe('UsageReminderTracker', () => {
  let tracker: UsageReminderTracker

  beforeEach(() => {
    tracker = new UsageReminderTracker({
      monitoredTools: ['Grep', 'Glob', 'WebSearch'],
      threshold: 3,
      messageTemplate: 'You called {{toolName}} {{count}} times. Consider delegating to an agent.',
      cooldownSeconds: 60,
      disableInSubagent: false,
    })
  })

  it('does not trigger below threshold', () => {
    const msg = tracker.recordCall('Grep')
    expect(msg).toBeNull()
    tracker.recordCall('Grep')
    expect(tracker.recordCall('Grep')).toBeNull() // 3rd call, but threshold check is > not >=
  })

  it('triggers after threshold exceeded', () => {
    for (let i = 0; i < 3; i++) tracker.recordCall('Grep')
    const msg = tracker.recordCall('Grep') // 4th call
    expect(msg).toContain('Grep')
    expect(msg).toContain('4')
  })

  it('respects cooldown period', () => {
    for (let i = 0; i < 4; i++) tracker.recordCall('Grep')
    const msg1 = tracker.recordCall('Grep')
    expect(msg1).toBeTruthy()
    const msg2 = tracker.recordCall('Grep')
    expect(msg2).toBeNull() // still in cooldown
  })

  it('does not trigger for unmonitored tools', () => {
    for (let i = 0; i < 10; i++) tracker.recordCall('Read')
    const msg = tracker.recordCall('Read')
    expect(msg).toBeNull()
  })

  it('resets counter for different tools independently', () => {
    for (let i = 0; i < 4; i++) tracker.recordCall('Grep')
    expect(tracker.recordCall('Glob')).toBeNull() // Glob only called once
  })

  it('disables in subagent when configured', () => {
    const subTracker = new UsageReminderTracker({
      monitoredTools: ['Grep'],
      threshold: 2,
      messageTemplate: 'test',
      cooldownSeconds: 60,
      disableInSubagent: true,
    })
    subTracker.setIsSubagent(true)
    for (let i = 0; i < 10; i++) subTracker.recordCall('Grep')
    expect(subTracker.recordCall('Grep')).toBeNull()
  })
})
```

### Step 10.2: Implement Agent Usage Reminder

**File**: `/Users/heal/ola-cc/src/hooks/agent-usage-reminder/index.ts`

Create file implementing:
- `UsageReminderTracker` class: `recordCall(toolName)`, `setIsSubagent(bool)`
- `UsageReminderConfig` interface: `monitoredTools`, `threshold`, `messageTemplate`, `cooldownSeconds`, `disableInSubagent`
- Internal state: per-tool call counter, last reminder timestamp
- Template variable replacement: `{{toolName}}`, `{{count}}`
- Cooldown: skip reminder if within `cooldownSeconds` of last reminder for same tool

### Step 10.3: Write tests for Non-Interactive Env

**File**: `/Users/heal/ola-cc/src/hooks/non-interactive-env/index.test.ts`

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { isNonInteractive, applyNonInteractiveEnv } from './index'

describe('isNonInteractive', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.CI
    delete process.env.GITHUB_ACTIONS
    delete process.env.GITLAB_CI
    delete process.env.JENKINS_URL
    delete process.env.CIRCLECI
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('detects CI environment', () => {
    process.env.CI = 'true'
    expect(isNonInteractive()).toBe(true)
  })

  it('detects GitHub Actions', () => {
    process.env.GITHUB_ACTIONS = 'true'
    expect(isNonInteractive()).toBe(true)
  })

  it('detects GitLab CI', () => {
    process.env.GITLAB_CI = 'true'
    expect(isNonInteractive()).toBe(true)
  })

  it('returns false when interactive', () => {
    // Note: process.stdin.isTTY may be undefined in test environment
    // This test verifies the env var checks work
    expect(isNonInteractive()).toBe(false)
  })
})

describe('applyNonInteractiveEnv', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.CI = 'true'
    delete process.env.GIT_TERMINAL_PROMPT
    delete process.env.PAGER
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('sets default env vars in non-interactive mode', () => {
    applyNonInteractiveEnv()
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(process.env.PAGER).toBe('cat')
  })

  it('does not override existing env vars', () => {
    process.env.GIT_TERMINAL_PROMPT = '1'
    applyNonInteractiveEnv()
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('1')
  })
})
```

### Step 10.4: Implement Non-Interactive Env

**File**: `/Users/heal/ola-cc/src/hooks/non-interactive-env/index.ts`

Create file implementing:
- `isNonInteractive()`: checks `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`, `CIRCLECI`, `!process.stdin.isTTY`
- `applyNonInteractiveEnv(config?)`: sets env vars (GIT_TERMINAL_PROMPT=0, GIT_EDITOR=:, EDITOR=:, VISUAL='', PAGER=cat, npm_config_yes=true, HOMEBREW_NO_AUTO_UPDATE=1) without overriding existing
- `NonInteractiveEnvConfig` interface: `envVars`, `blockedCommands`
- Default blocked commands: `vim`, `vi`, `nano`, `less`, `more`, `top`, `htop`

Run: `bun test src/hooks/agent-usage-reminder/ src/hooks/non-interactive-env/` -- expect all pass.

---

### Execution Safety Net

> **注意**：本计划使用 `executing-plans` 技能执行。该技能当前为骨架版本（71行，无 Iron Law），以下安全措施补偿其约束力不足：

1. **每任务验证检查点**：每个任务完成后必须运行 `bun test` 和 `bun run build:dev`，不可跳过
2. **行号偏移检测**：修改共享文件（如 query.ts、compact.ts）后，验证插入点行号与计划一致
3. **失败回退**：连续 2 次任务失败则暂停执行，报告失败原因，等待用户确认
4. **不可猜测**：计划步骤不清晰时必须停下询问，不可自行推断

---

## Execution Order & Dependencies

```
Task 1 (Sanitizer + Normalization)  ──┐
Task 2 (AgentMemoryStore)            ──┤── No cross-dependencies
Task 6 (Provider Auto-Detect + Schema)─┤
Task 8 (Plugin Sandbox)              ──┤
Task 10 (Usage Reminder + Non-Interactive) ┘
       │
       ▼
Task 3 (Pre-Compact + Session Search) ── depends on compact.ts structure
Task 4 (LocalVault + Keychain)        ── depends on secureStorage types
Task 9 (Skill Store + TF-IDF)         ── depends on Task 8 (plugin types)
       │
       ▼
Task 5 (ACP Agent + NDJSON)           ── depends on Task 4 (LocalVault for token storage)
Task 7 (Gemini + Ollama Adapters)     ── depends on Task 6 (schema conversion + auto-detect)
```

**Parallelizable batches**:
- Batch 1 (no deps): Tasks 1, 2, 6, 8, 10 -- all can run simultaneously
- Batch 2 (sequential): Tasks 3, 4, 9
- Batch 3 (sequential): Tasks 5, 7

## Feature Flags Summary

| Flag | Task | Default | Controls |
|------|------|---------|----------|
| `OLA_CC_EMPTY_MSG_SANITIZER` | 1 | off | Empty message detection + placeholder injection |
| `OLA_CC_TOOL_ARG_NORMALIZATION` | 1 | off | Tool argument auto-repair |
| `OLA_CC_PERSISTENT_AGENT_MEMORY` | 2 | off | Persistent memory store (fallback to in-memory Map) |
| `OLA_CC_PRE_COMPACT_CHECKPOINT` | 3 | off | Pre-compact state snapshot |
| `OLA_CC_SESSION_HISTORY_SEARCH` | 3 | off | /search command |
| `ACP_VAULT` | 4 | off | AES-256-GCM encrypted vault |
| `ACP_KEYCHAIN` | 4 | off | OS keychain integration |
| `GEMINI_PROVIDER` | 7 | off | Gemini adapter |
| `OLLAMA_PROVIDER` | 7 | off | Ollama local service |
| `PROVIDER_AUTO_DETECT` | 6 | off | Auto-detect best provider |
| `PLUGIN_MARKETPLACE` | 8 | off | Plugin sandbox + marketplace |
| `SKILL_STORE` | 9 | off | Remote skill store |
| `SKILL_SEARCH` | 9 | off | TF-IDF auto-match |
| `OLA_CC_AGENT_USAGE_REMINDER` | 10 | off | Usage reminder notifications |
| `OLA_CC_NON_INTERACTIVE_ENV` | 10 | off | CI environment adaptation |

## Total LOC Estimate

| Task | New LOC | Modified LOC |
|------|---------|-------------|
| 1 | ~390 | ~15 |
| 2 | ~200 | 0 |
| 3 | ~310 | ~20 |
| 4 | ~575 | ~15 |
| 5 | ~605 | ~20 |
| 6 | ~420 | 0 |
| 7 | ~330 | ~60 |
| 8 | ~240 | 0 |
| 9 | ~380 | 0 |
| 10 | ~180 | 0 |
| **Total** | **~3,630** | **~130** |

Grand Total: **~3,760 LOC**
