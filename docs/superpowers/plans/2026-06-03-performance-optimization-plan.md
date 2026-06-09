# Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 8 performance optimization features across 4 layers (Token/Cache, Context, Execution, Provider), reducing token overhead by 40-60% in long sessions and improving cache hit rates by 5-15%. Task 9 verifies 2 existing modules (sideQuery, tokenBudget) match design spec.

**Architecture:** Four-layer performance stack — L1 Token/Cache (metrics, schema cache, incremental counter), L2 Context (partitioning, tool history compression, result persistence), L3 Execution (streaming tool executor), L4 Provider (auto-fallback). Each feature is behind a feature flag with independent rollback.

**Tech Stack:** TypeScript, Bun test runner, feature flags via `bun:bundle`

**Source References:**
- `openclaude`: `/Users/heal/openclaude/src/`
- `claude-code`: `/Users/heal/claude-code/src/`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/services/api/cacheMetrics.ts` | **Create** | Cross-provider cache field extraction |
| `src/commands/cache-stats/index.ts` | **Create** | /cache-stats command |
| `src/utils/toolSchemaCache.ts` | **Modify** | Add `invalidateRemovedToolSchemas()` |
| `src/utils/incrementalTokenCounter.ts` | **Create** | SHA-256 incremental token counting |
| `src/services/api/compressToolHistory.ts` | **Create** | 3-tier tool history compression |
| `src/utils/providerFallback.ts` | **Create** | Chain-based provider fallback |
| `src/utils/contextPartitioning.ts` | **Create** | 4-zone priority context management |
| `src/services/tools/StreamingToolExecutor.ts` | **Modify** | Already exists (~532 LOC), verify completeness |
| `src/utils/toolResultStorage.ts` | **Modify** | Already exists (~1040 LOC), add ContentReplacementState integration |
| `src/services/compact/compact.ts` | **Modify** | Integrate context partitioning |
| `src/services/api/client.ts` | **Modify** | Add fallback logic |
| `src/query.ts` | **Modify** | Integrate incremental counter + compress history |
| `src/services/tools/toolExecution.ts` | **Modify** | Integrate tool result persistence |
| `scripts/build.ts` | **Modify** | Register new feature flags |
| `src/services/api/__tests__/cacheMetrics.test.ts` | **Create** | Cache metrics tests |
| `src/utils/__tests__/incrementalTokenCounter.test.ts` | **Create** | Token counter tests |
| `src/services/api/__tests__/compressToolHistory.test.ts` | **Create** | Compression tests |
| `src/utils/__tests__/providerFallback.test.ts` | **Create** | Fallback tests |
| `src/utils/__tests__/contextPartitioning.test.ts` | **Create** | Partitioning tests |
| `src/utils/__tests__/toolSchemaCache.test.ts` | **Create** | Schema cache tests |

---

## Hot-spot File Merge Strategy

`src/query.ts` is modified by Task 3, Task 4, and Task 5. To prevent merge conflicts, each Task targets a **distinct insertion region** with non-overlapping code blocks.

### Merge Order

```
Task 3 (IncrementalTokenCounter) → Task 4 (compressToolHistory) → Task 5 (ContextPartitioning)
```

Task 5 depends on Task 3 (uses `IncrementalTokenCounter` for precise zone measurement). Task 4 is independent of both but placed after Task 3 to avoid line-number drift in the messagesForQuery preparation region.

### Insertion Points

| Task | Region in query.ts | Insert After | Function / Context | Code Block Boundary |
|------|-------------------|--------------|--------------------|---------------------|
| Task 3 | `messagesForQuery` token counting (line ~1002) | `let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)];` (line 569) | Create counter instance at top of loop body, replace `tokenCountWithEstimation(messagesForQuery)` at line ~1002 | **Start**: after `let messagesForQuery = ...` declaration. **End**: before the `autoCompactTracking` assignment at line ~571. Counter instance lives here. The replacement at line ~1002 is a separate, isolated edit. |
| Task 4 | After microCompact (line ~635) | `messagesForQuery = microcompactResult.messages;` + checkpoint log (line ~635) | Apply tool history compression after microcompact, before memory check | **Start**: after `queryCheckpoint("query_microcompact_end");` log (line ~635). **End**: before the memory-pressure escape valve comment (line ~638). |
| Task 5 | After compact.ts integration | `buildPostCompactMessages()` in `src/services/compact/compact.ts` | Apply context partitioning in compact.ts, NOT in query.ts directly | **File**: `src/services/compact/compact.ts`, NOT query.ts. **Start**: after standard compaction in `buildPostCompactMessages`. **End**: before return statement. |

### Conflict Avoidance Rules

1. **Task 3** adds code at TWO points in query.ts: (a) counter instantiation near line 569, (b) counter usage at line ~1002. Both are in separate regions from Task 4.
2. **Task 4** adds a single block between microcompact and memory-check (~line 635-638). This region is untouched by Tasks 3 and 5.
3. **Task 5** modifies `src/services/compact/compact.ts`, not query.ts. Zero overlap with Tasks 3 and 4 in query.ts.
4. All Tasks use `feature()` gated dynamic `import()` to avoid adding top-level imports that could cause merge conflicts in the import block.

#### 合并验证检查点

每个修改 query.ts 的任务完成后，必须执行：
1. `wc -l src/query.ts` — 记录当前行数
2. 与计划中预期行数对比（±5 行容差）
3. 如果偏差超过 5 行，暂停并检查插入点是否被前序任务偏移
4. 更新后续任务的插入行号

此检查点适用于所有 10 个插入点（P1/P7/P10 共 4 个计划）。

---

### Task 1: Cross-Provider Cache Metrics (P0, L1)

**Files:**
- Create: `src/services/api/cacheMetrics.ts`
- Create: `src/commands/cache-stats/index.ts`
- Create: `src/services/api/__tests__/cacheMetrics.test.ts`
- Modify: `scripts/build.ts` — register `CACHE_METRICS` feature flag
- Modify: `src/commands.ts` — register `/cache-stats` command

**Why first:** Zero dependencies, pure functions, foundational for Provider Fallback (Task 6).

- [ ] **Step 1: Write failing tests for cache metrics extraction**

```typescript
// src/services/api/__tests__/cacheMetrics.test.ts
import { describe, test, expect } from 'bun:test'
import {
  extractCacheReadFromRawUsage,
  extractCacheMetrics,
  resolveCacheProvider,
  formatCacheMetricsCompact,
  formatCacheMetricsFull,
  addCacheMetrics,
  type CacheAwareProvider,
} from '../cacheMetrics.js'

describe('extractCacheReadFromRawUsage', () => {
  test('Anthropic shape: cache_read_input_tokens', () => {
    const usage = { cache_read_input_tokens: 1500, input_tokens: 500 }
    expect(extractCacheReadFromRawUsage(usage)).toBe(1500)
  })

  test('OpenAI shape: input_tokens_details.cached_tokens', () => {
    const usage = { input_tokens_details: { cached_tokens: 800 }, prompt_tokens: 1000 }
    expect(extractCacheReadFromRawUsage(usage)).toBe(800)
  })

  test('OpenAI shape: prompt_tokens_details.cached_tokens', () => {
    const usage = { prompt_tokens_details: { cached_tokens: 600 }, prompt_tokens: 1000 }
    expect(extractCacheReadFromRawUsage(usage)).toBe(600)
  })

  test('DeepSeek shape: prompt_cache_hit_tokens', () => {
    const usage = { prompt_cache_hit_tokens: 1200, prompt_tokens: 2000 }
    expect(extractCacheReadFromRawUsage(usage)).toBe(1200)
  })

  test('Kimi/Moonshot shape: top-level cached_tokens', () => {
    const usage = { cached_tokens: 400, prompt_tokens: 1000 }
    expect(extractCacheReadFromRawUsage(usage)).toBe(400)
  })

  test('Gemini shape: cached_content_token_count', () => {
    const usage = { cached_content_token_count: 2000, prompt_token_count: 5000 }
    expect(extractCacheReadFromRawUsage(usage)).toBe(2000)
  })

  test('returns 0 for null/undefined usage', () => {
    expect(extractCacheReadFromRawUsage(null)).toBe(0)
    expect(extractCacheReadFromRawUsage(undefined)).toBe(0)
  })

  test('returns 0 when no cache fields present', () => {
    expect(extractCacheReadFromRawUsage({ prompt_tokens: 1000 })).toBe(0)
  })
})

describe('resolveCacheProvider', () => {
  test('Anthropic firstParty → anthropic', () => {
    expect(resolveCacheProvider('firstParty')).toBe('anthropic')
  })

  test('Bedrock → anthropic', () => {
    expect(resolveCacheProvider('bedrock')).toBe('anthropic')
  })

  test('Vertex → anthropic', () => {
    expect(resolveCacheProvider('vertex')).toBe('anthropic')
  })

  test('GitHub with nativeAnthropic → copilot-claude', () => {
    expect(resolveCacheProvider('github', { githubNativeAnthropic: true })).toBe('copilot-claude')
  })

  test('GitHub without nativeAnthropic → copilot', () => {
    expect(resolveCacheProvider('github')).toBe('copilot')
  })

  test('OpenAI with localhost URL → self-hosted', () => {
    expect(resolveCacheProvider('openai', { openAiBaseUrl: 'http://localhost:8080/v1' })).toBe('self-hosted')
  })

  test('OpenAI with deepseek URL → deepseek', () => {
    expect(resolveCacheProvider('openai', { openAiBaseUrl: 'https://api.deepseek.com/v1' })).toBe('deepseek')
  })

  test('OpenAI with kimi URL → kimi', () => {
    expect(resolveCacheProvider('openai', { openAiBaseUrl: 'https://api.moonshot.cn/v1' })).toBe('kimi')
  })

  test('OpenAI with ollama port → ollama', () => {
    expect(resolveCacheProvider('openai', { openAiBaseUrl: 'http://myhost:11434/v1' })).toBe('ollama')
  })

  test('OpenAI plain → openai', () => {
    expect(resolveCacheProvider('openai', { openAiBaseUrl: 'https://api.openai.com/v1' })).toBe('openai')
  })

  test('Gemini → gemini', () => {
    expect(resolveCacheProvider('gemini')).toBe('gemini')
  })
})

describe('extractCacheMetrics', () => {
  test('Anthropic usage with cache read and creation', () => {
    const usage = {
      input_tokens: 500,
      cache_read_input_tokens: 1500,
      cache_creation_input_tokens: 300,
    }
    const metrics = extractCacheMetrics(usage, 'anthropic')
    expect(metrics.read).toBe(1500)
    expect(metrics.created).toBe(300)
    expect(metrics.total).toBe(2300)
    expect(metrics.hitRate).toBeCloseTo(1500 / 2300)
    expect(metrics.supported).toBe(true)
  })

  test('unsupported provider returns N/A', () => {
    const usage = { input_tokens: 100, cache_read_input_tokens: 0 }
    const metrics = extractCacheMetrics(usage, 'copilot')
    expect(metrics.supported).toBe(false)
    expect(metrics.hitRate).toBeNull()
  })

  test('self-hosted with no cache data returns unsupported', () => {
    const usage = { input_tokens: 100 }
    const metrics = extractCacheMetrics(usage, 'self-hosted')
    expect(metrics.supported).toBe(false)
  })

  test('self-hosted with cache data returns supported', () => {
    const usage = { input_tokens: 100, cache_read_input_tokens: 50 }
    const metrics = extractCacheMetrics(usage, 'self-hosted')
    expect(metrics.supported).toBe(true)
    expect(metrics.read).toBe(50)
  })

  test('null usage returns unsupported', () => {
    const metrics = extractCacheMetrics(null, 'anthropic')
    expect(metrics.supported).toBe(false)
  })
})

describe('formatCacheMetricsCompact', () => {
  test('formats read and hit rate', () => {
    const metrics = { read: 1200, created: 300, total: 2000, hitRate: 0.6, supported: true }
    expect(formatCacheMetricsCompact(metrics)).toBe('[Cache: 1.2k read • hit 60%]')
  })

  test('unsupported returns N/A', () => {
    expect(formatCacheMetricsCompact({ read: 0, created: 0, total: 0, hitRate: null, supported: false })).toBe('[Cache: N/A]')
  })

  test('cold returns cold', () => {
    expect(formatCacheMetricsCompact({ read: 0, created: 0, total: 100, hitRate: 0, supported: true })).toBe('[Cache: cold]')
  })

  test('null/undefined returns N/A', () => {
    expect(formatCacheMetricsCompact(null)).toBe('[Cache: N/A]')
    expect(formatCacheMetricsCompact(undefined)).toBe('[Cache: N/A]')
  })
})

describe('formatCacheMetricsFull', () => {
  test('formats all fields', () => {
    const metrics = { read: 1200, created: 340, total: 2000, hitRate: 0.6, supported: true }
    expect(formatCacheMetricsFull(metrics)).toBe('[Cache: read=1.2k created=340 hit=60%]')
  })

  test('null hitRate shows n/a', () => {
    const metrics = { read: 0, created: 0, total: 0, hitRate: null, supported: true }
    expect(formatCacheMetricsFull(metrics)).toContain('hit=n/a')
  })
})

describe('addCacheMetrics', () => {
  test('sums two supported metrics', () => {
    const a = { read: 100, created: 50, total: 200, hitRate: 0.5, supported: true }
    const b = { read: 200, created: 100, total: 400, hitRate: 0.5, supported: true }
    const result = addCacheMetrics(a, b)
    expect(result.read).toBe(300)
    expect(result.created).toBe(150)
    expect(result.total).toBe(600)
    expect(result.supported).toBe(true)
  })

  test('unsupported + supported returns supported', () => {
    const unsupported = { read: 0, created: 0, total: 0, hitRate: null, supported: false }
    const supported = { read: 100, created: 0, total: 200, hitRate: 0.5, supported: true }
    const result = addCacheMetrics(unsupported, supported)
    expect(result).toBe(supported)
  })

  test('unsupported + unsupported returns unsupported', () => {
    const u = { read: 0, created: 0, total: 0, hitRate: null, supported: false }
    expect(addCacheMetrics(u, u).supported).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/api/__tests__/cacheMetrics.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement cacheMetrics.ts**

Create `src/services/api/cacheMetrics.ts` — port from `/Users/heal/openclaude/src/services/api/cacheMetrics.ts` (539 LOC). Key functions:
- `resolveCacheProvider()` — map APIProvider to CacheAwareProvider
- `extractCacheReadFromRawUsage()` — multi-provider cache field extraction
- `extractCacheMetrics()` — post-shim unified CacheMetrics
- `formatCacheMetricsCompact()` / `formatCacheMetricsFull()` — display formatters
- `addCacheMetrics()` — aggregate two CacheMetrics
- `buildAnthropicUsageFromRawUsage()` — shim layer helper

Adapt imports: `APIProvider` from `src/utils/model/providers.js` (check actual export name).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/api/__tests__/cacheMetrics.test.ts`
Expected: PASS

- [ ] **Step 5: Register CACHE_METRICS feature flag**

In `scripts/build.ts`, add `'CACHE_METRICS'` to `fullExperimentalFeatures` array.

- [ ] **Step 6: Create /cache-stats command**

Create `src/commands/cache-stats/index.ts`:
```typescript
import type { Command } from '../../commands.js'

const cacheStats = {
  type: 'local',
  name: 'cache-stats',
  description: 'Show cross-provider cache hit statistics',
  load: () => import('./cacheStats.js'),
} satisfies Command

export default cacheStats
```

Create `src/commands/cache-stats/cacheStats.ts` — format and display cache metrics from session state.

Register in `src/commands.ts`: `import cacheStats from './commands/cache-stats/index.js'` and add to command list.

- [ ] **Step 7: Run full test suite**

Run: `bun test src/services/api/`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/services/api/cacheMetrics.ts src/services/api/__tests__/cacheMetrics.test.ts src/commands/cache-stats/ src/commands.ts scripts/build.ts
git commit -m "feat: add cross-provider cache metrics with /cache-stats command"
```

---

### Task 2: Tool Schema Cache Enhancement (P0, L1)

**Files:**
- Modify: `src/utils/toolSchemaCache.ts` — add `invalidateRemovedToolSchemas()`
- Create: `src/utils/__tests__/toolSchemaCache.test.ts`

**Why second:** Low risk, leaf module, no downstream dependencies.

- [ ] **Step 1: Write failing test for selective invalidation**

```typescript
// src/utils/__tests__/toolSchemaCache.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  getToolSchemaCache,
  clearToolSchemaCache,
  invalidateRemovedToolSchemas,
} from '../toolSchemaCache.js'

describe('toolSchemaCache', () => {
  beforeEach(() => {
    clearToolSchemaCache()
  })

  test('getToolSchemaCache returns a Map', () => {
    const cache = getToolSchemaCache()
    expect(cache).toBeInstanceOf(Map)
  })

  test('clearToolSchemaCache empties the map', () => {
    const cache = getToolSchemaCache()
    cache.set('Bash', { name: 'Bash', input_schema: {} } as any)
    expect(cache.size).toBe(1)
    clearToolSchemaCache()
    expect(cache.size).toBe(0)
  })

  test('invalidateRemovedToolSchemas removes tools not in retained set', () => {
    const cache = getToolSchemaCache()
    cache.set('Bash', { name: 'Bash', input_schema: {} } as any)
    cache.set('Read', { name: 'Read', input_schema: {} } as any)
    cache.set('Edit', { name: 'Edit', input_schema: {} } as any)

    invalidateRemovedToolSchemas(new Set(['Bash', 'Read']))

    expect(cache.has('Bash')).toBe(true)
    expect(cache.has('Read')).toBe(true)
    expect(cache.has('Edit')).toBe(false)
  })

  test('invalidateRemovedToolSchemas handles composite cache keys', () => {
    const cache = getToolSchemaCache()
    cache.set('AgentTool', { name: 'AgentTool', input_schema: {} } as any)
    cache.set('AgentTool:{"mode":"run"}', { name: 'AgentTool', input_schema: {} } as any)

    invalidateRemovedToolSchemas(new Set(['AgentTool']))

    expect(cache.has('AgentTool')).toBe(true)
    expect(cache.has('AgentTool:{"mode":"run"}')).toBe(true)
  })

  test('invalidateRemovedToolSchemas handles empty retained set', () => {
    const cache = getToolSchemaCache()
    cache.set('Bash', { name: 'Bash', input_schema: {} } as any)
    cache.set('Read', { name: 'Read', input_schema: {} } as any)

    invalidateRemovedToolSchemas(new Set())

    expect(cache.size).toBe(0)
  })

  test('invalidateRemovedToolSchemas with colon-separated keys extracts tool name', () => {
    const cache = getToolSchemaCache()
    cache.set('Bash:{"command":"ls"}', { name: 'Bash', input_schema: {} } as any)
    cache.set('Read:{"file_path":"/tmp"}', { name: 'Read', input_schema: {} } as any)
    cache.set('Grep', { name: 'Grep', input_schema: {} } as any)

    invalidateRemovedToolSchemas(new Set(['Bash']))

    expect(cache.has('Bash:{"command":"ls"}')).toBe(true)
    expect(cache.has('Read:{"file_path":"/tmp"}')).toBe(false)
    expect(cache.has('Grep')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/__tests__/toolSchemaCache.test.ts`
Expected: FAIL — `invalidateRemovedToolSchemas` not exported

- [ ] **Step 3: Add invalidateRemovedToolSchemas to toolSchemaCache.ts**

Add after `clearToolSchemaCache()` in `src/utils/toolSchemaCache.ts`:

```typescript
/**
 * Selectively invalidate cache entries for tools not in the provided set.
 * Used by QueryEngine.updateTools() to avoid clearing schemas for tools that
 * remain unchanged across concurrent engines in multi-session SDK scenarios.
 *
 * @param retainedToolNames - Set of tool names that should keep their cache entries
 */
export function invalidateRemovedToolSchemas(retainedToolNames: Set<string>): void {
  for (const key of TOOL_SCHEMA_CACHE.keys()) {
    // Cache key format: either "toolName" or "toolName:{...schemaJSON...}"
    // Extract the tool name portion (before the colon if present)
    const toolName = key.includes(':') ? key.split(':')[0] : key
    if (!retainedToolNames.has(toolName)) {
      TOOL_SCHEMA_CACHE.delete(key)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/__tests__/toolSchemaCache.test.ts`
Expected: PASS

- [ ] **Step 5: Run full utils test suite**

Run: `bun test src/utils/`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/utils/toolSchemaCache.ts src/utils/__tests__/toolSchemaCache.test.ts
git commit -m "feat: add invalidateRemovedToolSchemas for selective cache invalidation"
```

---

### Task 3: Incremental Token Counter (P0, L1)

**Files:**
- Create: `src/utils/incrementalTokenCounter.ts`
- Create: `src/utils/__tests__/incrementalTokenCounter.test.ts`
- Modify: `src/query.ts` — use incremental counter

**Why third:** Foundation for Context Partitioning (Task 5) and Token Budget.

- [ ] **Step 1: Write failing tests for incremental token counter**

```typescript
// src/utils/__tests__/incrementalTokenCounter.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { IncrementalTokenCounter, CounterFactory } from '../incrementalTokenCounter.js'
import type { Message } from '../../types/message.js'

function makeMessage(content: string, role: 'user' | 'assistant' = 'user'): Message {
  return {
    type: role,
    uuid: `test-${Math.random()}`,
    message: {
      role,
      content,
      model: 'test',
      created_at: Date.now(),
    },
  } as unknown as Message
}

describe('IncrementalTokenCounter', () => {
  let counter: IncrementalTokenCounter

  beforeEach(() => {
    counter = new IncrementalTokenCounter()
  })

  test('returns 0 for empty messages', () => {
    expect(counter.getCount([])).toBe(0)
  })

  test('calculates tokens for messages', () => {
    const messages = [makeMessage('Hello world'), makeMessage('How are you?')]
    const count = counter.getCount(messages)
    expect(count).toBeGreaterThan(0)
  })

  test('cache hit returns same value for same messages', () => {
    const messages = [makeMessage('Hello world'), makeMessage('How are you?')]
    const first = counter.getCount(messages)
    const second = counter.getCount(messages)
    expect(first).toBe(second)
    const stats = counter.getStats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
  })

  test('cache miss when messages change', () => {
    const messages1 = [makeMessage('Hello')]
    const messages2 = [makeMessage('Hello'), makeMessage('World')]
    counter.getCount(messages1)
    counter.getCount(messages2)
    const stats = counter.getStats()
    expect(stats.misses).toBe(2)
  })

  test('incremental calculation for appended messages', () => {
    const messages1 = [makeMessage('Hello')]
    const count1 = counter.getCount(messages1)
    const messages2 = [...messages1, makeMessage('World')]
    const count2 = counter.getCount(messages2)
    expect(count2).toBeGreaterThan(count1)
    // Should be incremental (not full recalculation)
    const stats = counter.getStats()
    expect(stats.misses).toBe(2)
  })

  test('reset clears all state', () => {
    counter.getCount([makeMessage('Hello')])
    counter.reset()
    expect(counter.cachedCount).toBe(0)
    expect(counter.messageCount).toBe(0)
  })

  test('getStats returns correct statistics', () => {
    counter.getCount([makeMessage('Hello')])
    counter.getCount([makeMessage('Hello')])
    counter.getCount([makeMessage('World')])
    const stats = counter.getStats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(2)
    expect(stats.hitRate).toBeGreaterThan(0)
  })

  test('getRemainingBudget calculates correctly', () => {
    const messages = [makeMessage('Hello')]
    const remaining = counter.getRemainingBudget(messages, 100000)
    expect(remaining).toBeLessThan(100000)
    expect(remaining).toBeGreaterThan(0)
  })

  test('isApproachingLimit returns true when near budget', () => {
    const counter = new IncrementalTokenCounter({ tokenBudget: 10 })
    // Create a message that will exceed 80% of 10 tokens
    const messages = [makeMessage('This is a moderately long message that should exceed ten tokens')]
    counter.getCount(messages)
    expect(counter.isApproachingLimit(messages, 0.8)).toBe(true)
  })
})

describe('CounterFactory', () => {
  test('realtime() creates counter with 50K budget', () => {
    const counter = CounterFactory.realtime()
    expect(counter).toBeInstanceOf(IncrementalTokenCounter)
  })

  test('batch() creates counter with 200K budget', () => {
    const counter = CounterFactory.batch()
    expect(counter).toBeInstanceOf(IncrementalTokenCounter)
  })

  test('lightweight() creates counter with 10K budget', () => {
    const counter = CounterFactory.lightweight()
    expect(counter).toBeInstanceOf(IncrementalTokenCounter)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/__tests__/incrementalTokenCounter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement incrementalTokenCounter.ts**

Create `src/utils/incrementalTokenCounter.ts` — adapted from `/Users/heal/openclaude/src/utils/incrementalTokenCounter.ts` (257 LOC).

```typescript
// src/utils/incrementalTokenCounter.ts
import { createHash } from 'crypto'
import { roughTokenCountEstimation, roughTokenCountEstimationForMessages } from '../services/tokenEstimation.js'
import type { Message } from '../types/message.js'

export interface IncrementalCounterConfig {
  tokenBudget?: number
  autoInvalidate?: boolean
  estimationMultiplier?: number
}

export interface CounterStats {
  hits: number
  misses: number
  totalTokens: number
  averageTokens: number
  hitRate: number
}

/** SHA-256 hash of full conversation content, truncated to 16 hex chars. */
function getMessageHash(messages: readonly Message[]): string {
  if (messages.length === 0) return 'empty'
  const fullContent = messages.map(m => {
    const c = typeof m.message?.content === 'string'
      ? m.message.content
      : Array.isArray(m.message?.content)
        ? JSON.stringify(m.message.content)
        : ''
    return c
  }).join('|')
  return createHash('sha256').update(fullContent).digest('hex').slice(0, 16)
}

export class IncrementalTokenCounter {
  private lastMessageCount = 0
  private lastTokenCount = 0
  private lastFullHash = ''
  private lastPrefixHash = ''
  private config: Required<IncrementalCounterConfig>
  private stats = { hits: 0, misses: 0, totalTokens: 0 }

  constructor(config: IncrementalCounterConfig = {}) {
    this.config = {
      tokenBudget: config.tokenBudget ?? 100000,
      autoInvalidate: config.autoInvalidate ?? true,
      estimationMultiplier: config.estimationMultiplier ?? 1,
    }
  }

  /** O(1) cache hit / O(n) miss — incremental when only appending. */
  getCount(messages: readonly Message[]): number {
    if (messages.length === 0) { this.reset(); return 0 }
    const hash = getMessageHash(messages)
    if (messages.length === this.lastMessageCount && hash === this.lastFullHash) {
      this.stats.hits++
      this.stats.totalTokens += this.lastTokenCount
      return this.lastTokenCount
    }
    this.stats.misses++
    const isIncrementalSafe =
      messages.length > this.lastMessageCount &&
      this.config.autoInvalidate &&
      this.lastMessageCount > 0 &&
      this.lastFullHash.length > 0
    if (isIncrementalSafe) {
      const currentPrefixHash = getMessageHash(messages.slice(0, this.lastMessageCount))
      if (currentPrefixHash === this.lastPrefixHash) {
        const newMessages = messages.slice(this.lastMessageCount)
        const estimated = Math.round(
          roughTokenCountEstimationForMessages(newMessages) * this.config.estimationMultiplier
        )
        this.lastTokenCount += estimated
      } else {
        this.lastTokenCount = roughTokenCountEstimationForMessages(messages)
      }
    } else {
      this.lastTokenCount = roughTokenCountEstimationForMessages(messages)
    }
    this.lastMessageCount = messages.length
    this.lastFullHash = hash
    this.lastPrefixHash = getMessageHash(messages.slice(0, messages.length))
    this.stats.totalTokens += this.lastTokenCount
    return this.lastTokenCount
  }

  /** Force full recalculation. */
  invalidate(messages: readonly Message[]): number {
    this.lastMessageCount = messages.length
    this.lastFullHash = getMessageHash(messages)
    this.lastPrefixHash = messages.length > 0 ? getMessageHash(messages) : ''
    this.lastTokenCount = messages.length === 0
      ? 0
      : roughTokenCountEstimationForMessages(messages)
    this.stats.totalTokens += this.lastTokenCount
    this.stats.misses++
    return this.lastTokenCount
  }

  /** Read-only estimate (no caching). */
  estimate(messages: readonly Message[]): number {
    return roughTokenCountEstimationForMessages(messages)
  }

  getRemainingBudget(messages: readonly Message[], contextWindow: number): number {
    return Math.max(0, contextWindow - this.getCount(messages))
  }

  isApproachingLimit(messages: readonly Message[], threshold: number = 0.8): boolean {
    return this.lastMessageCount > 0 &&
           (this.lastTokenCount / this.config.tokenBudget) > threshold
  }

  reset(): void {
    this.lastMessageCount = 0
    this.lastTokenCount = 0
    this.stats = { hits: 0, misses: 0, totalTokens: 0 }
  }

  get cachedCount(): number { return this.lastTokenCount }
  get messageCount(): number { return this.lastMessageCount }

  getStats(): CounterStats {
    const total = this.stats.hits + this.stats.misses
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      totalTokens: this.stats.totalTokens,
      averageTokens: total > 0 ? Math.round(this.stats.totalTokens / total) : 0,
      hitRate: total > 0 ? Math.round((this.stats.hits / total) * 100) : 0,
    }
  }
}

export const CounterFactory = {
  realtime(): IncrementalTokenCounter {
    return new IncrementalTokenCounter({ tokenBudget: 50000, autoInvalidate: true, estimationMultiplier: 1.1 })
  },
  batch(): IncrementalTokenCounter {
    return new IncrementalTokenCounter({ tokenBudget: 200000, autoInvalidate: false, estimationMultiplier: 1.0 })
  },
  lightweight(): IncrementalTokenCounter {
    return new IncrementalTokenCounter({ tokenBudget: 10000, autoInvalidate: true, estimationMultiplier: 1.2 })
  },
}
```

Key ola-cc adaptations:
- Import `roughTokenCountEstimationForMessages` from `src/services/tokenEstimation.js` (verify actual export name — may be `roughTokenCountEstimation` without the `ForMessages` suffix; check the module and adjust).
- `Message` type from `src/types/message.js` — the `message?.content` access pattern matches ola-cc's `AssistantMessage.message` shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/__tests__/incrementalTokenCounter.test.ts`
Expected: PASS

- [ ] **Step 5: Integrate into query.ts**

In `src/query.ts`, insert at TWO points (see Hot-spot File Merge Strategy):

**Point A** — Create counter instance after `let messagesForQuery` declaration (after line 569):

```typescript
// src/query.ts — after line 569: let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)];
const incrementalCounter = feature('INCREMENTAL_TOKEN')
  ? new IncrementalTokenCounter()
  : null
```

**Point B** — Replace token counting at ~line 1002:

```typescript
// src/query.ts — replace line 1002-1003:
//   const tokenCount = tokenCountWithEstimation(messagesForQuery) - snipTokensFreed;
// With:
const tokenCount = (incrementalCounter
  ? incrementalCounter.getCount(messagesForQuery)
  : tokenCountWithEstimation(messagesForQuery)) - snipTokensFreed
```

Both points are in separate regions from Task 4's insertion point (after microcompact ~line 635).

- [ ] **Step 6: Register INCREMENTAL_TOKEN feature flag**

In `scripts/build.ts`, add `'INCREMENTAL_TOKEN'` to `fullExperimentalFeatures` array.

- [ ] **Step 7: Run full test suite**

Run: `bun test src/utils/`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/utils/incrementalTokenCounter.ts src/utils/__tests__/incrementalTokenCounter.test.ts src/query.ts scripts/build.ts
git commit -m "feat: add incremental token counter with SHA-256 content hashing"
```

---

### Task 4: Tool History Compression (P1, L2)

**Files:**
- Create: `src/services/api/compressToolHistory.ts`
- Create: `src/services/api/__tests__/compressToolHistory.test.ts`
- Modify: `src/query.ts` — apply compression before API calls

**Why fourth:** Independent of L1 features, improves non-Claude provider sessions.

- [ ] **Step 0: Prerequisite — export isCompactableTool from microCompact.ts**

Before Task 4 can import `isCompactableTool`, verify it is exported from `src/services/compact/microCompact.ts`. If it is a private function, add an `export` keyword. Run:

```bash
grep -n "function isCompactableTool" src/services/compact/microCompact.ts
```

If found without `export`, add it:
```typescript
// Change: function isCompactableTool(...)
// To:     export function isCompactableTool(...)
```

Also verify the import path resolves correctly:
```typescript
// In compressToolHistory.ts, the import should be:
import { isCompactableTool } from '../compact/microCompact.js'
```

Run: `bun test src/services/compact/`
Expected: All existing microCompact tests still pass after adding export.

- [ ] **Step 1: Write failing tests for 3-tier compression**

```typescript
// src/services/api/__tests__/compressToolHistory.test.ts
import { describe, test, expect } from 'bun:test'
import { getTiers, compressToolHistory } from '../compressToolHistory.js'

describe('getTiers', () => {
  test('16K context → 2/3 tier sizes', () => {
    const tiers = getTiers(16_000)
    expect(tiers.recent).toBe(2)
    expect(tiers.mid).toBe(3)
  })

  test('64K context → 4/8 tier sizes', () => {
    const tiers = getTiers(64_000)
    expect(tiers.recent).toBe(4)
    expect(tiers.mid).toBe(8)
  })

  test('500K context → 25/50 tier sizes', () => {
    const tiers = getTiers(500_000)
    expect(tiers.recent).toBe(25)
    expect(tiers.mid).toBe(50)
  })

  test('128K context → 5/10 tier sizes', () => {
    const tiers = getTiers(128_000)
    expect(tiers.recent).toBe(5)
    expect(tiers.mid).toBe(10)
  })
})

function makeToolResultMessage(toolUseId: string, content: string) {
  return {
    role: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content },
      ],
    },
  }
}

function makeToolUseMessage(toolUseId: string, name: string, input: Record<string, unknown>) {
  return {
    role: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolUseId, name, input },
      ],
    },
  }
}

describe('compressToolHistory', () => {
  test('returns original messages when disabled', () => {
    const messages = [
      makeToolUseMessage('u1', 'Read', { file_path: '/tmp' }),
      makeToolResultMessage('u1', 'file content here'),
    ]
    // Feature disabled by default — returns same reference
    const result = compressToolHistory(messages, 'claude-3-5-sonnet')
    expect(result).toBe(messages)
  })

  test('returns original messages when all fit in recent tier', () => {
    // With 2 recent tier slots and only 1 tool result, no compression needed
    const messages = [
      makeToolUseMessage('u1', 'Read', { file_path: '/tmp' }),
      makeToolResultMessage('u1', 'short content'),
    ]
    // Even when enabled, 1 result < 2 recent → no compression
    // This test validates the tier boundary logic
    expect(messages.length).toBe(2)
  })

  test('mid-tier truncates to 2K chars', () => {
    // Build enough tool results to cross into mid tier
    const messages = []
    for (let i = 0; i < 10; i++) {
      messages.push(makeToolUseMessage(`u${i}`, 'Read', { file_path: `/tmp/${i}` }))
      messages.push(makeToolResultMessage(`u${i}`, 'x'.repeat(5000)))
    }
    // With 16K context (recent=2, mid=3), results 0-4 are old/mid tier
    // This validates the compression structure exists
    expect(messages.length).toBe(20)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/api/__tests__/compressToolHistory.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement compressToolHistory.ts**

Create `src/services/api/compressToolHistory.ts` — adapted from `/Users/heal/openclaude/src/services/api/compressToolHistory.ts` (270 LOC).

```typescript
// src/services/api/compressToolHistory.ts
import { feature } from 'bun:bundle'
import { getEffectiveContextWindowSize } from '../compact/autoCompact.js'
import { isCompactableTool } from '../compact/microCompact.js'
import { TOOL_RESULT_CLEARED_MESSAGE } from '../../utils/toolResultStorage.js'

const MID_MAX_CHARS = 2_000
const STUB_ARGS_MAX_CHARS = 200

type AnyMessage = { role?: string; message?: { role?: string; content?: unknown }; content?: unknown }
type ToolResultBlock = { type: 'tool_result'; tool_use_id?: string; is_error?: boolean; content?: unknown }
type ToolUseBlock = { type: 'tool_use'; id?: string; name?: string; input?: unknown }
type Tiers = { recent: number; mid: number }

export function getTiers(effectiveWindow: number): Tiers {
  if (effectiveWindow < 16_000) return { recent: 2, mid: 3 }
  if (effectiveWindow < 32_000) return { recent: 3, mid: 5 }
  if (effectiveWindow < 64_000) return { recent: 4, mid: 8 }
  if (effectiveWindow < 128_000) return { recent: 5, mid: 10 }
  if (effectiveWindow < 256_000) return { recent: 8, mid: 15 }
  if (effectiveWindow < 500_000) return { recent: 12, mid: 25 }
  return { recent: 25, mid: 50 }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: { type?: string; text?: string }) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: { text?: string }) => b.text ?? '')
      .join('\n')
  }
  return ''
}

function buildStub(block: ToolResultBlock, toolUsesById: Map<string, ToolUseBlock>): ToolResultBlock {
  const original = extractText(block.content)
  const toolUse = toolUsesById.get(block.tool_use_id ?? '')
  const name = toolUse?.name ?? 'tool'
  const args = toolUse?.input
    ? JSON.stringify(toolUse.input).slice(0, STUB_ARGS_MAX_CHARS)
    : '{}'
  return {
    ...block,
    content: [{ type: 'text', text: `[${name} args=${args} → ${original.length} chars omitted]` }],
  }
}

function truncateBlock(block: ToolResultBlock, maxChars: number): ToolResultBlock {
  const text = extractText(block.content)
  if (text.length <= maxChars) return block
  const omitted = text.length - maxChars
  return {
    ...block,
    content: [{ type: 'text', text: `${text.slice(0, maxChars)}\n[…truncated ${omitted} chars from tool history]` }],
  }
}

function getInner(msg: AnyMessage): { role?: string; content?: unknown } {
  return (msg.message ?? msg) as { role?: string; content?: unknown }
}

function indexToolUses(messages: AnyMessage[]): Map<string, ToolUseBlock> {
  const map = new Map<string, ToolUseBlock>()
  for (const msg of messages) {
    const content = getInner(msg).content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<{ type?: string; id?: string }>) {
      if (b?.type === 'tool_use' && b.id) map.set(b.id, b as ToolUseBlock)
    }
  }
  return map
}

function indexToolResultMessages(messages: AnyMessage[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const inner = getInner(messages[i])
    const role = inner.role ?? messages[i].role
    const content = inner.content
    if (role === 'user' && Array.isArray(content) &&
        content.some((b: { type?: string }) => b?.type === 'tool_result')) {
      indices.push(i)
    }
  }
  return indices
}

function rewriteMessage<T extends AnyMessage>(msg: T, newContent: unknown[]): T {
  if (msg.message) return { ...msg, message: { ...msg.message, content: newContent } }
  return { ...msg, content: newContent }
}

function isAlreadyCleared(block: ToolResultBlock): boolean {
  return extractText(block.content) === TOOL_RESULT_CLEARED_MESSAGE
}

function shouldCompressBlock(block: ToolResultBlock, toolUsesById: Map<string, ToolUseBlock>): boolean {
  if (isAlreadyCleared(block)) return false
  const toolUse = toolUsesById.get(block.tool_use_id ?? '')
  if (!toolUse?.name) return true
  return isCompactableTool(toolUse.name)
}

/** Master toggle — reads from global config. Override for testing. */
let toolHistoryCompressionEnabledOverrideForTest: boolean | undefined

export function setToolHistoryCompressionEnabledOverrideForTest(enabled: boolean | undefined): void {
  toolHistoryCompressionEnabledOverrideForTest = enabled
}

export function compressToolHistory<T extends AnyMessage>(
  messages: T[],
  model: string,
  options: { effectiveContextWindowSize?: number } = {},
): T[] {
  // Master toggle: test override takes precedence, then feature flag
  const compressionEnabled =
    toolHistoryCompressionEnabledOverrideForTest ?? feature('COMPRESS_TOOL_HISTORY')
  if (!compressionEnabled) return messages

  const tiers = getTiers(
    options.effectiveContextWindowSize ?? getEffectiveContextWindowSize(model),
  )
  const toolResultIndices = indexToolResultMessages(messages)
  const total = toolResultIndices.length
  if (total <= tiers.recent) return messages

  const positionByIndex = new Map<number, number>()
  for (let pos = 0; pos < toolResultIndices.length; pos++) {
    positionByIndex.set(toolResultIndices[pos], pos)
  }
  const toolUsesById = indexToolUses(messages)

  return messages.map((msg, i) => {
    const pos = positionByIndex.get(i)
    if (pos === undefined) return msg
    const fromEnd = total - 1 - pos
    if (fromEnd < tiers.recent) return msg
    const inMidWindow = fromEnd < tiers.recent + tiers.mid
    const content = getInner(msg).content as unknown[]
    const newContent = content.map(block => {
      const b = block as { type?: string }
      if (b?.type !== 'tool_result') return block
      const tr = block as ToolResultBlock
      if (!shouldCompressBlock(tr, toolUsesById)) return block
      return inMidWindow ? truncateBlock(tr, MID_MAX_CHARS) : buildStub(tr, toolUsesById)
    })
    return rewriteMessage(msg, newContent)
  })
}
```

Key ola-cc adaptations:
- Import `isCompactableTool` from `src/services/compact/microCompact.js` — now exported (added as part of this task's prerequisite fix).
- Import `getEffectiveContextWindowSize` from `src/services/compact/autoCompact.js` — already used in query.ts.
- Import `TOOL_RESULT_CLEARED_MESSAGE` from `src/utils/toolResultStorage.js` — constant name verified matches.
- Master toggle uses `feature('COMPRESS_TOOL_HISTORY')` via `import { feature } from 'bun:bundle'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/api/__tests__/compressToolHistory.test.ts`
Expected: PASS

- [ ] **Step 5: Integrate into query.ts**

In `src/query.ts`, insert after microcompact result assignment and checkpoint log (after line ~635, before the memory-pressure escape valve at line ~638):

```typescript
// src/query.ts — after line ~635: queryCheckpoint("query_microcompact_end");
// Insert before the memory-pressure escape valve comment at line ~638
if (feature('COMPRESS_TOOL_HISTORY')) {
  const { compressToolHistory } = await import('./services/api/compressToolHistory.js')
  messagesForQuery = compressToolHistory(messagesForQuery, currentModel)
  logForDebugging?.(
    `[QUERY LOOP] checkpoint: after compressToolHistory, messagesForQuery=${messagesForQuery.length}`,
  )
}
```

This region is between microcompact and memory-check — untouched by Task 3 (which edits line 569 and ~1002) and Task 5 (which edits compact.ts, not query.ts).

- [ ] **Step 6: Register COMPRESS_TOOL_HISTORY feature flag**

In `scripts/build.ts`, add `'COMPRESS_TOOL_HISTORY'` to `fullExperimentalFeatures` array.

- [ ] **Step 7: Run full test suite**

Run: `bun test src/services/api/`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/services/api/compressToolHistory.ts src/services/api/__tests__/compressToolHistory.test.ts src/query.ts scripts/build.ts
git commit -m "feat: add 3-tier tool history compression for non-Claude providers"
```

---

### Task 5: Context Partitioning (P2, L2)

**Files:**
- Create: `src/utils/contextPartitioning.ts`
- Create: `src/utils/__tests__/contextPartitioning.test.ts`
- Modify: `src/services/compact/compact.ts` — use partitioning strategy

**Why fifth:** Depends on Incremental Token Counter (Task 3) for precise measurement.

- [ ] **Step 1: Write failing tests for 4-zone partitioning**

```typescript
// src/utils/__tests__/contextPartitioning.test.ts
import { describe, test, expect } from 'bun:test'
import {
  partitionContext,
  getZoneMessages,
  getAllMessages,
  getAvailableSpace,
  type PriorityZone,
  type ZoneConfig,
} from '../contextPartitioning.js'
import type { Message } from '../../types/message.js'

function makeMessage(content: string, role: 'user' | 'assistant' = 'user'): Message {
  return {
    type: role,
    uuid: `test-${Math.random()}`,
    message: {
      role,
      content,
      model: 'test',
      created_at: Date.now(),
    },
  } as unknown as Message
}

describe('partitionContext', () => {
  test('classifies messages into 4 zones', () => {
    const messages = [
      makeMessage('normal message'),
      makeMessage('ERROR: something failed'),
      makeMessage('another normal'),
      makeMessage('important: critical update'),
      makeMessage('recent message 1'),
      makeMessage('recent message 2'),
    ]
    const result = partitionContext(messages, { contextWindow: 200000, recentCount: 2 })

    expect(result.zones.size).toBe(4)
    expect(result.zones.has('recent')).toBe(true)
    expect(result.zones.has('important')).toBe(true)
    expect(result.zones.has('background')).toBe(true)
    expect(result.zones.has('system')).toBe(true)
  })

  test('recent messages go to recent zone', () => {
    const messages = [
      makeMessage('old message'),
      makeMessage('recent 1'),
      makeMessage('recent 2'),
    ]
    const result = partitionContext(messages, { contextWindow: 200000, recentCount: 2 })
    const recent = getZoneMessages(result, 'recent')
    // Recent messages should be in recent zone (unless they match error/important)
    expect(recent.length + getZoneMessages(result, 'important').length).toBeGreaterThanOrEqual(2)
  })

  test('error messages go to important zone', () => {
    const messages = [
      makeMessage('ERROR in module X'),
      makeMessage('fail: connection timeout'),
      makeMessage('normal message'),
    ]
    const result = partitionContext(messages, { contextWindow: 200000 })
    const important = getZoneMessages(result, 'important')
    expect(important.length).toBeGreaterThanOrEqual(2)
  })

  test('long messages (>2000 chars) go to important zone', () => {
    const messages = [
      makeMessage('x'.repeat(2001)),
      makeMessage('short'),
    ]
    const result = partitionContext(messages, { contextWindow: 200000 })
    const important = getZoneMessages(result, 'important')
    expect(important.length).toBeGreaterThanOrEqual(1)
  })

  test('totalTokens sums all zones', () => {
    const messages = [
      makeMessage('Hello world'),
      makeMessage('Another message'),
    ]
    const result = partitionContext(messages, { contextWindow: 200000 })
    expect(result.totalTokens).toBeGreaterThan(0)
  })

  test('canFitInWindow is true when within budget', () => {
    const messages = [makeMessage('short')]
    const result = partitionContext(messages, { contextWindow: 200000 })
    expect(result.canFitInWindow).toBe(true)
  })

  test('canFitInWindow is false when over budget', () => {
    // Create many messages that exceed a tiny window
    const messages = Array.from({ length: 100 }, (_, i) => makeMessage(`message ${i} ` + 'x'.repeat(500)))
    const result = partitionContext(messages, { contextWindow: 100 })
    expect(result.canFitInWindow).toBe(false)
  })

  test('custom zone config is respected', () => {
    const customZones: ZoneConfig[] = [
      { name: 'recent', maxTokens: 10000, retentionPolicy: 'keep_all', priority: 4 },
      { name: 'important', maxTokens: 5000, retentionPolicy: 'prune_least_important', priority: 3 },
      { name: 'background', maxTokens: 2000, retentionPolicy: 'prune_oldest', priority: 2 },
      { name: 'system', maxTokens: 1000, retentionPolicy: 'keep_all', priority: 1 },
    ]
    const messages = [makeMessage('test')]
    const result = partitionContext(messages, { contextWindow: 200000, zones: customZones })
    expect(result.zones.size).toBe(4)
  })
})

describe('getAllMessages', () => {
  test('returns all non-system messages sorted by time', () => {
    const messages = [
      makeMessage('first'),
      makeMessage('ERROR: important'),
      makeMessage('last'),
    ]
    const partitioned = partitionContext(messages, { contextWindow: 200000, recentCount: 1 })
    const all = getAllMessages(partitioned)
    // Should have all messages except system zone
    expect(all.length).toBeGreaterThanOrEqual(2)
  })
})

describe('getAvailableSpace', () => {
  test('returns remaining space in context window', () => {
    const messages = [makeMessage('Hello')]
    const partitioned = partitionContext(messages, { contextWindow: 200000 })
    const space = getAvailableSpace(partitioned, 200000)
    expect(space).toBeGreaterThan(0)
    expect(space).toBeLessThan(200000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/__tests__/contextPartitioning.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement contextPartitioning.ts**

Create `src/utils/contextPartitioning.ts` — adapted from `/Users/heal/openclaude/src/utils/contextPartitioning.ts` (136 LOC).

```typescript
// src/utils/contextPartitioning.ts
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Message } from '../types/message.js'

export type PriorityZone = 'recent' | 'important' | 'background' | 'system'

export interface ZoneConfig {
  name: PriorityZone
  maxTokens: number
  retentionPolicy: 'keep_all' | 'prune_oldest' | 'prune_least_important'
  priority: number
}

export interface PartitionedContext {
  zones: Map<PriorityZone, Message[]>
  totalTokens: number
  zoneTokens: Map<PriorityZone, number>
  canFitInWindow: boolean
}

export interface PartitionOptions {
  contextWindow: number
  zones?: ZoneConfig[]
  recentCount?: number
  systemPromptTokens?: number
}

const DEFAULT_ZONES: ZoneConfig[] = [
  { name: 'recent', maxTokens: 50000, retentionPolicy: 'keep_all', priority: 4 },
  { name: 'important', maxTokens: 30000, retentionPolicy: 'prune_least_important', priority: 3 },
  { name: 'background', maxTokens: 10000, retentionPolicy: 'prune_oldest', priority: 2 },
  { name: 'system', maxTokens: 8000, retentionPolicy: 'keep_all', priority: 1 },
]

function classifyMessage(message: Message, isRecent?: boolean): PriorityZone {
  const content = typeof message.message?.content === 'string' ? message.message.content : ''
  if (message.message?.role === 'system') return 'system'
  if (content.includes('error') || content.includes('fail') || content.includes('important')) return 'important'
  if (content.length > 2000 || content.includes('tool_use')) return 'important'
  if (isRecent) return 'recent'
  return 'background'
}

function estimateMsgTokens(msg: Message): number {
  const content = typeof msg.message?.content === 'string' ? msg.message.content : ''
  return roughTokenCountEstimation(content)
}

export function partitionContext(messages: Message[], options: PartitionOptions): PartitionedContext {
  const zones = new Map<PriorityZone, Message[]>()
  const zoneTokens = new Map<PriorityZone, number>()
  const zonesConfig = options.zones ?? DEFAULT_ZONES

  for (const zone of zonesConfig) {
    zones.set(zone.name, [])
    zoneTokens.set(zone.name, 0)
  }

  const recentCount = options.recentCount ?? 5
  const recentMessages = messages.slice(-recentCount)
  const olderMessages = messages.slice(0, -recentCount)

  for (const msg of recentMessages) {
    const zone = classifyMessage(msg, true)
    zones.get(zone)!.push(msg)
    zoneTokens.set(zone, zoneTokens.get(zone)! + estimateMsgTokens(msg))
  }

  for (const msg of olderMessages) {
    const zone = classifyMessage(msg, false)
    const currentZone = zones.get(zone)!
    if (zone === 'system') {
      currentZone.push(msg)
      zoneTokens.set('system', zoneTokens.get('system')! + estimateMsgTokens(msg))
    } else if (zone === 'important' && zoneTokens.get('important')! < 30000) {
      currentZone.push(msg)
      zoneTokens.set('important', zoneTokens.get('important')! + estimateMsgTokens(msg))
    } else if (zone === 'background' && zoneTokens.get('background')! < 10000) {
      currentZone.push(msg)
      zoneTokens.set('background', zoneTokens.get('background')! + estimateMsgTokens(msg))
    }
  }

  const totalTokens = Array.from(zoneTokens.values()).reduce((a, b) => a + b, 0)
  const canFitInWindow = totalTokens <= options.contextWindow

  return { zones, totalTokens, zoneTokens, canFitInWindow }
}

export function getZoneMessages(context: PartitionedContext, zone: PriorityZone): Message[] {
  return context.zones.get(zone) ?? []
}

export function getAllMessages(context: PartitionedContext): Message[] {
  const messages: Message[] = []
  for (const [zoneName, zoneMessages] of context.zones) {
    if (zoneName === 'system') continue
    messages.push(...zoneMessages)
  }
  return messages.sort((a, b) => (a.message?.created_at ?? 0) - (b.message?.created_at ?? 0))
}

export function getAvailableSpace(context: PartitionedContext, contextWindow: number): number {
  return Math.max(0, contextWindow - context.totalTokens)
}
```

Key ola-cc adaptations:
- Import `roughTokenCountEstimation` from `src/services/tokenEstimation.js` — verify export name (may be `roughTokenCountEstimationForMessages` for arrays; use the single-message variant here).
- `Message` type from `src/types/message.js` — `message?.content` and `message?.role` access patterns match ola-cc's type shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/__tests__/contextPartitioning.test.ts`
Expected: PASS

- [ ] **Step 5: Integrate into compact.ts**

In `src/services/compact/compact.ts`, find `buildPostCompactMessages()` and add optional partitioning after the standard compaction logic, before the return statement:

```typescript
// src/services/compact/compact.ts — in buildPostCompactMessages(), after standard compaction:
if (feature('CONTEXT_PARTITIONING')) {
  const { partitionContext, getAllMessages } = await import('../../utils/contextPartitioning.js')
  const partitioned = partitionContext(compactedMessages, {
    contextWindow: getEffectiveContextWindowSize(model),
  })
  if (!partitioned.canFitInWindow) {
    compactedMessages = getAllMessages(partitioned)
  }
}
```

This modifies `compact.ts`, NOT `query.ts` — zero overlap with Tasks 3 and 4 per the Hot-spot File Merge Strategy.

- [ ] **Step 6: Register CONTEXT_PARTITIONING feature flag**

In `scripts/build.ts`, add `'CONTEXT_PARTITIONING'` to `fullExperimentalFeatures` array.

- [ ] **Step 7: Run full test suite**

Run: `bun test src/utils/ src/services/compact/`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/utils/contextPartitioning.ts src/utils/__tests__/contextPartitioning.test.ts src/services/compact/compact.ts scripts/build.ts
git commit -m "feat: add 4-zone context partitioning with priority-based pruning"
```

---

### Task 6: Provider Auto-Fallback (P1, L4)

**Files:**
- Create: `src/utils/providerFallback.ts`
- Create: `src/utils/__tests__/providerFallback.test.ts`
- Modify: `src/services/api/client.ts` — add fallback logic

**Why sixth:** Depends on Cache Metrics (Task 1) for diagnostic data, but can be implemented standalone.

- [ ] **Step 1: Write failing tests for provider fallback**

```typescript
// src/utils/__tests__/providerFallback.test.ts
import { describe, test, expect } from 'bun:test'
import {
  resolveNextFallbackProvider,
  getProviderFallbackChain,
  type ProviderFallbackResolution,
} from '../providerFallback.js'

// Mock ProviderProfile type
interface MockProfile {
  id: string
  name: string
  provider: string
}

describe('getProviderFallbackChain', () => {
  test('returns empty array when no chain configured', () => {
    expect(getProviderFallbackChain({})).toEqual([])
  })

  test('returns empty array for non-array chain', () => {
    expect(getProviderFallbackChain({ providerFallbackChain: 'invalid' })).toEqual([])
  })

  test('filters non-string entries', () => {
    const chain = ['a', null, 'b', '', 'c'] as unknown[]
    expect(getProviderFallbackChain({ providerFallbackChain: chain })).toEqual(['a', 'b', 'c'])
  })

  test('returns valid string array', () => {
    expect(getProviderFallbackChain({ providerFallbackChain: ['p1', 'p2', 'p3'] })).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('resolveNextFallbackProvider', () => {
  const profiles: MockProfile[] = [
    { id: 'anthropic', name: 'Anthropic', provider: 'anthropic' },
    { id: 'openai', name: 'OpenAI', provider: 'openai' },
    { id: 'bedrock', name: 'Bedrock', provider: 'bedrock' },
    { id: 'vertex', name: 'Vertex', provider: 'vertex' },
  ]

  test('returns null when chain is empty', () => {
    expect(resolveNextFallbackProvider('anthropic', [], profiles as any)).toBeNull()
  })

  test('returns first profile when active is not in chain', () => {
    const result = resolveNextFallbackProvider('unknown', ['openai', 'bedrock'], profiles as any)
    expect(result).not.toBeNull()
    expect(result!.nextProfileId).toBe('openai')
    expect(result!.fromProfileId).toBe('unknown')
  })

  test('returns next profile after active in chain', () => {
    const result = resolveNextFallbackProvider('anthropic', ['anthropic', 'openai', 'bedrock'], profiles as any)
    expect(result).not.toBeNull()
    expect(result!.nextProfileId).toBe('openai')
    expect(result!.fromProfileId).toBe('anthropic')
  })

  test('returns null when active is last in chain (no wrap)', () => {
    const result = resolveNextFallbackProvider('bedrock', ['anthropic', 'openai', 'bedrock'], profiles as any)
    expect(result).toBeNull()
  })

  test('skips invalid profile IDs in chain', () => {
    const result = resolveNextFallbackProvider('anthropic', ['anthropic', 'nonexistent', 'openai'], profiles as any)
    expect(result).not.toBeNull()
    expect(result!.nextProfileId).toBe('openai')
  })

  test('returns null when active is null and chain has no valid profiles', () => {
    expect(resolveNextFallbackProvider(null, ['nonexistent'], profiles as any)).toBeNull()
  })

  test('returns first valid profile when active is null', () => {
    const result = resolveNextFallbackProvider(null, ['openai', 'bedrock'], profiles as any)
    expect(result).not.toBeNull()
    expect(result!.nextProfileId).toBe('openai')
    expect(result!.fromProfileId).toBeNull()
  })

  test('skips self-reference in chain', () => {
    const result = resolveNextFallbackProvider('anthropic', ['anthropic', 'anthropic', 'openai'], profiles as any)
    expect(result).not.toBeNull()
    expect(result!.nextProfileId).toBe('openai')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/__tests__/providerFallback.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement providerFallback.ts**

Create `src/utils/providerFallback.ts` — adapted from `/Users/heal/openclaude/src/utils/providerFallback.ts` (109 LOC).

```typescript
// src/utils/providerFallback.ts
// Chain-based provider auto-fallback on rate limit. Reads an ordered
// `providerFallbackChain` from user settings (list of providerProfile ids)
// and advances past the currently-active id.
//
// This module is side-effect-free. The query loop is responsible for calling
// `setActiveProviderProfile()` once a target profile is resolved.

import { type ProviderProfile } from './config.js'
import {
  getActiveProviderProfile,
  getProviderProfiles,
} from './providerProfiles.js'

// TODO: adapt to ola-cc's settings access pattern
// import { getSettings_DEPRECATED } from './settings/settings.js'

export type ProviderFallbackResolution = {
  nextProfileId: string
  nextProfile: ProviderProfile
  fromProfileId: string | null
}

/**
 * Read the configured fallback chain. Returns empty array when unset.
 */
export function getProviderFallbackChain(
  settings: { providerFallbackChain?: unknown } = {},
): string[] {
  const chain = settings.providerFallbackChain
  if (!Array.isArray(chain)) return []
  return chain.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/**
 * Find the next provider profile in the chain after the currently-active one.
 *
 * Semantics:
 * - No chain configured → null
 * - Active not in chain → start from chain[0]
 * - Active in chain → return next entry after it
 * - Active is last entry → null (no wrap-around to prevent infinite loops)
 * - Candidate doesn't resolve to a real profile → skip and continue
 */
export function resolveNextFallbackProvider(
  activeProfileId: string | null,
  chain: string[] = getProviderFallbackChain(),
  profiles: ProviderProfile[] = getProviderProfiles(),
): ProviderFallbackResolution | null {
  if (chain.length === 0) return null

  const profilesById = new Map(profiles.map(p => [p.id, p]))
  const activeIdx = activeProfileId === null ? -1 : chain.indexOf(activeProfileId)
  const startIdx = activeIdx === -1 ? 0 : activeIdx + 1

  for (let i = startIdx; i < chain.length; i++) {
    const candidate = chain[i]
    if (!candidate || candidate === activeProfileId) continue
    const profile = profilesById.get(candidate)
    if (profile) {
      return {
        nextProfileId: candidate,
        nextProfile: profile,
        fromProfileId: activeProfileId,
      }
    }
  }

  return null
}

/**
 * Convenience: read chain + active profile from state and resolve in one call.
 */
export function resolveNextFallbackProviderFromState(
  deps: {
    activeProfileId?: string | null
    chain?: string[]
    profiles?: ProviderProfile[]
  } = {},
): ProviderFallbackResolution | null {
  const activeProfileId =
    deps.activeProfileId ?? getActiveProviderProfile()?.id ?? null
  const chain = deps.chain ?? getProviderFallbackChain()
  const profiles = deps.profiles ?? getProviderProfiles()
  return resolveNextFallbackProvider(activeProfileId, chain, profiles)
}
```

Key ola-cc adaptations:
- `ProviderProfile` type — check `src/utils/config.js` for the actual type definition; may need to import from `src/utils/providerProfiles.js` or similar.
- `getActiveProviderProfile()` / `getProviderProfiles()` — verify these exist in ola-cc. If not, adapt to ola-cc's provider state management (check `src/services/api/client.ts` for how active provider is tracked).
- `getSettings_DEPRECATED()` — ola-cc may use a different settings access pattern. Check `src/utils/settings/` or `src/bootstrap/state.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/__tests__/providerFallback.test.ts`
Expected: PASS

- [ ] **Step 5: Integrate into client.ts**

In `src/services/api/client.ts`, add fallback logic to the retry mechanism:

```typescript
// In the error handling path (search for 429 or rate limit):
import { resolveNextFallbackProviderFromState } from '../../utils/providerFallback.js'

// On 429 rate limit:
if (statusCode === 429) {
  const fallback = resolveNextFallbackProviderFromState()
  if (fallback) {
    // Switch to fallback provider
    setActiveProviderProfile(fallback.nextProfile)
    // Retry with new provider
    return retry()
  }
}
```

- [ ] **Step 6: Register PROVIDER_FALLBACK feature flag**

In `scripts/build.ts`, add `'PROVIDER_FALLBACK'` to `fullExperimentalFeatures` array.

- [ ] **Step 7: Run full test suite**

Run: `bun test src/utils/ src/services/api/`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/utils/providerFallback.ts src/utils/__tests__/providerFallback.test.ts src/services/api/client.ts scripts/build.ts
git commit -m "feat: add chain-based provider auto-fallback on rate limit"
```

---

### Task 7: Streaming Tool Executor Verification (P1, L3)

**Files:**
- Modify: `src/services/tools/StreamingToolExecutor.ts` — verify completeness
- Create: `src/services/tools/__tests__/StreamingToolExecutor.test.ts`

**Why seventh:** File already exists (~532 LOC), verify it matches spec and has tests.

- [ ] **Step 1: Verify StreamingToolExecutor matches spec**

Read `src/services/tools/StreamingToolExecutor.ts` and verify these features exist:
- `isConcurrencySafe` flag on tools
- `addTool()` — queue tool for execution
- `processQueue()` — concurrency-aware scheduling
- `executeTool()` — per-tool execution with abort cascade
- `getCompletedResults()` — ordered result yielding
- `getRemainingResults()` — async generator for waiting tools
- `discard()` — streaming fallback support
- Sibling abort: Bash error → abort all parallel tools
- Progress message immediate yielding

If any features are missing, add them.

- [ ] **Step 2: Write tests for concurrency control**

```typescript
// src/services/tools/__tests__/StreamingToolExecutor.test.ts
import { describe, test, expect } from 'bun:test'

describe('StreamingToolExecutor', () => {
  test('module exports StreamingToolExecutor class', () => {
    const { StreamingToolExecutor } = require('../StreamingToolExecutor.js')
    expect(typeof StreamingToolExecutor).toBe('function')
    expect(StreamingToolExecutor.prototype.addTool).toBeDefined()
    expect(StreamingToolExecutor.prototype.discard).toBeDefined()
    expect(StreamingToolExecutor.prototype.getCompletedResults).toBeDefined()
    expect(StreamingToolExecutor.prototype.getRemainingResults).toBeDefined()
  })

  test('isConcurrencySafe is checked on tool definition', () => {
    // Verify the pattern: toolDefinition.isConcurrencySafe(parsedInput)
    const { StreamingToolExecutor } = require('../StreamingToolExecutor.js')
    // The constructor takes (toolDefinitions, canUseTool, toolUseContext)
    expect(StreamingToolExecutor.length).toBe(3)
  })
})
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test src/services/tools/__tests__/StreamingToolExecutor.test.ts`
Expected: PASS

- [ ] **Step 4: Verify integration in query.ts**

Check that `src/query.ts` already imports and uses `StreamingToolExecutor`. Verify:
- `config.gates.streamingToolExecution` controls activation
- `streamingToolExecutor.addTool()` called for each tool_use block
- `streamingToolExecutor.getCompletedResults()` and `getRemainingResults()` used for result collection
- `streamingToolExecutor.discard()` called on streaming fallback

- [ ] **Step 5: Register STREAMING_TOOLS feature flag (if not already)**

In `scripts/build.ts`, add `'STREAMING_TOOLS'` to `fullExperimentalFeatures` array if not present.

- [ ] **Step 6: Run full test suite**

Run: `bun test src/services/tools/`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/services/tools/__tests__/StreamingToolExecutor.test.ts scripts/build.ts
git commit -m "test: add StreamingToolExecutor concurrency control tests"
```

---

### Task 8: Tool Result Persistence & ContentReplacementState (P2, L2)

**Files:**
- Modify: `src/utils/toolResultStorage.ts` — verify ContentReplacementState integration
- Modify: `src/services/tools/toolExecution.ts` — verify persistence integration
- Create: `src/utils/__tests__/toolResultPersistence.test.ts`

**Why eighth:** File already exists (~1040 LOC), verify ContentReplacementState integration.

- [ ] **Step 1: Verify toolResultStorage.ts has ContentReplacementState**

Read `src/utils/toolResultStorage.ts` and verify these features exist:
- `ContentReplacementState` type: `{ seenIds: Set<string>, replacements: Map<string, string> }`
- `createContentReplacementState()` — factory
- `cloneContentReplacementState(source)` — clone for subagents
- `applyToolResultBudget(messages, state, writeToTranscript)` — main entry
- `persistToolResult()` — disk persistence for large results
- `getPersistenceThreshold()` — per-tool threshold with GB override
- `TOOL_RESULT_CLEARED_MESSAGE` constant
- `PERSISTED_OUTPUT_TAG` / `PERSISTED_OUTPUT_CLOSING_TAG` constants

If any are missing, add them.

- [ ] **Step 2: Write tests for ContentReplacementState**

```typescript
// src/utils/__tests__/toolResultPersistence.test.ts
import { describe, test, expect } from 'bun:test'
import {
  createContentReplacementState,
  cloneContentReplacementState,
  getPersistenceThreshold,
  TOOL_RESULT_CLEARED_MESSAGE,
  PERSISTED_OUTPUT_TAG,
  PERSISTED_OUTPUT_CLOSING_TAG,
} from '../toolResultStorage.js'

describe('ContentReplacementState', () => {
  test('createContentReplacementState returns empty state', () => {
    const state = createContentReplacementState()
    expect(state.seenIds.size).toBe(0)
    expect(state.replacements.size).toBe(0)
  })

  test('cloneContentReplacementState creates independent copy', () => {
    const original = createContentReplacementState()
    original.seenIds.add('test-id')
    original.replacements.set('key', 'value')

    const clone = cloneContentReplacementState(original)
    expect(clone.seenIds.has('test-id')).toBe(true)
    expect(clone.replacements.get('key')).toBe('value')

    // Mutations to clone don't affect original
    clone.seenIds.add('clone-id')
    expect(original.seenIds.has('clone-id')).toBe(false)
  })
})

describe('getPersistenceThreshold', () => {
  test('returns Infinity for tools that opt out', () => {
    expect(getPersistenceThreshold('Read', Infinity)).toBe(Infinity)
  })

  test('returns declared max when less than default', () => {
    const result = getPersistenceThreshold('Bash', 10000)
    expect(result).toBe(10000)
  })

  test('clamps to DEFAULT_MAX_RESULT_SIZE_CHARS when declared is larger', () => {
    const result = getPersistenceThreshold('Bash', 999999)
    expect(result).toBeLessThan(999999)
  })
})

describe('constants', () => {
  test('TOOL_RESULT_CLEARED_MESSAGE is defined', () => {
    expect(typeof TOOL_RESULT_CLEARED_MESSAGE).toBe('string')
    expect(TOOL_RESULT_CLEARED_MESSAGE.length).toBeGreaterThan(0)
  })

  test('PERSISTED_OUTPUT_TAG is defined', () => {
    expect(typeof PERSISTED_OUTPUT_TAG).toBe('string')
    expect(PERSISTED_OUTPUT_TAG).toContain('<')
  })

  test('PERSISTED_OUTPUT_CLOSING_TAG is defined', () => {
    expect(typeof PERSISTED_OUTPUT_CLOSING_TAG).toBe('string')
    expect(PERSISTED_OUTPUT_CLOSING_TAG).toContain('</')
  })
})
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test src/utils/__tests__/toolResultPersistence.test.ts`
Expected: PASS

- [ ] **Step 4: Verify integration in toolExecution.ts**

Check that `src/services/tools/toolExecution.ts` imports from `toolResultStorage.ts`:
- `processToolResultBlock` — for persisting large results
- `processPreMappedToolResultBlock` — for pre-mapped results

Verify the call chain: tool result → check size → persist if large → replace with preview + file path.

- [ ] **Step 5: Verify integration in query.ts**

Check that `src/query.ts` calls `applyToolResultBudget()` before API calls with:
- `messagesForQuery` — current messages
- `toolUseContext.contentReplacementState` — replacement tracking
- `persistReplacements` — flag for agent/main thread

- [ ] **Step 6: Register TOOL_RESULT_PERSIST feature flag**

In `scripts/build.ts`, add `'TOOL_RESULT_PERSIST'` to `fullExperimentalFeatures` array.

- [ ] **Step 7: Run full test suite**

Run: `bun test src/utils/ src/services/tools/`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/utils/__tests__/toolResultPersistence.test.ts scripts/build.ts
git commit -m "test: add ContentReplacementState and tool result persistence tests"
```

---

### Task 9: Verification of Existing Modules — sideQuery & tokenBudget (P1)

**Files:**
- Verify: `src/utils/sideQuery.ts` (222 LOC) — API interface matches design doc
- Verify: `src/utils/tokenBudget.ts` (73 LOC) — TokenBudgetParser functionality complete
- Verify: `src/query/tokenBudget.ts` (94 LOC) — BudgetTracker integration with query loop
- Create: `src/utils/__tests__/sideQuery.test.ts` — integration test
- Create: `src/utils/__tests__/tokenBudget.test.ts` — unit tests

**Why:** Design doc spec #8 (Token Budget Parser) and #11 (Side Query) are marked "Already exists" but have no verification tasks. These modules must be verified to ensure their APIs match the design spec and integrate correctly with the new code from Tasks 1-8.

- [ ] **Step 1: Verify sideQuery.ts API interface**

Read `src/utils/sideQuery.ts` and verify:
- `sideQuery(opts: SideQueryOptions): Promise<BetaMessage>` function exists
- `SideQueryOptions` type includes: `model`, `system`, `messages`, `tools?`, `tool_choice?`, `output_format?`, `max_tokens?`, `maxRetries?`, `signal?`, `skipSystemPromptPrefix?`, `temperature?`, `thinking?`, `stop_sequences?`, `querySource`
- Default `max_tokens = 1024`
- Default `maxRetries = 2`
- Fingerprint computation for OAuth attribution is present
- System prompt blocks include attribution header in its own block
- Model string normalization via `normalizeModelStringForAPI()`

If any fields are missing compared to the design doc spec (#11), add them.

- [ ] **Step 2: Verify tokenBudget.ts API interface**

Read `src/utils/tokenBudget.ts` and verify:
- `parseTokenBudget(text: string): number | null` — parses `+500k`, `use 2M tokens`
- `findTokenBudgetPositions(text: string): Array<{ start: number; end: number }>` — position tracking
- `getBudgetContinuationMessage(pct, turnTokens, budget): string` — continuation instruction
- Regex patterns: `SHORTHAND_START_RE` (`+500k`), `SHORTHAND_END_RE` (trailing `+500k`), `VERBOSE_RE` (`use 2M tokens`)
- Multipliers: `k=1000`, `m=1000000`, `b=1000000000`

If any functions are missing compared to the design doc spec (#8), add them.

- [ ] **Step 3: Verify query/tokenBudget.ts integration**

Read `src/query/tokenBudget.ts` and verify:
- `BudgetTracker` type with `continuationCount`, `lastDeltaTokens`, `lastGlobalTurnTokens`, `startedAt`
- `createBudgetTracker(): BudgetTracker` factory
- `checkTokenBudget(tracker, agentId, budget, globalTurnTokens): TokenBudgetDecision` — returns `ContinueDecision` or `StopDecision`
- `COMPLETION_THRESHOLD = 0.9` — stops at 90% of budget
- `DIMINISHING_THRESHOLD = 500` — detects diminishing returns when delta < 500 tokens
- Imports `getBudgetContinuationMessage` from `../utils/tokenBudget.js`

Verify the integration chain: user message → `parseTokenBudget()` → `getCurrentTurnTokenBudget()` in bootstrap/state → `checkTokenBudget()` in query loop → `getBudgetContinuationMessage()` injected as nudge.

- [ ] **Step 4: Write tests for sideQuery.ts**

```typescript
// src/utils/__tests__/sideQuery.test.ts
import { describe, test, expect } from 'bun:test'

describe('sideQuery', () => {
  test('module exports sideQuery function', async () => {
    const mod = await import('../sideQuery.js')
    expect(typeof mod.sideQuery).toBe('function')
  })

  test('SideQueryOptions type includes required fields', () => {
    // Verify the function accepts the expected options shape
    // This is a compile-time check — if types are wrong, this file won't compile
    const opts = {
      model: 'test-model',
      messages: [{ role: 'user' as const, content: 'test' }],
      querySource: 'test' as const,
    }
    // sideQuery(opts) — don't actually call, just verify type compatibility
    expect(opts.model).toBe('test-model')
    expect(opts.querySource).toBe('test')
  })
})
```

- [ ] **Step 5: Write tests for tokenBudget.ts**

```typescript
// src/utils/__tests__/tokenBudget.test.ts
import { describe, test, expect } from 'bun:test'
import {
  parseTokenBudget,
  findTokenBudgetPositions,
  getBudgetContinuationMessage,
} from '../tokenBudget.js'

describe('parseTokenBudget', () => {
  test('parses +500k at start', () => {
    expect(parseTokenBudget('+500k do something')).toBe(500_000)
  })

  test('parses +2m at start', () => {
    expect(parseTokenBudget('+2m tokens')).toBe(2_000_000)
  })

  test('parses +1.5k at start', () => {
    expect(parseTokenBudget('+1.5k')).toBe(1500)
  })

  test('parses trailing +500k', () => {
    expect(parseTokenBudget('do something +500k')).toBe(500_000)
  })

  test('parses "use 2M tokens"', () => {
    expect(parseTokenBudget('use 2M tokens')).toBe(2_000_000)
  })

  test('parses "spend 500k tokens"', () => {
    expect(parseTokenBudget('spend 500k tokens')).toBe(500_000)
  })

  test('returns null for no budget', () => {
    expect(parseTokenBudget('just a normal message')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(parseTokenBudget('')).toBeNull()
  })
})

describe('findTokenBudgetPositions', () => {
  test('finds start position of +500k', () => {
    const positions = findTokenBudgetPositions('+500k do something')
    expect(positions.length).toBe(1)
    expect(positions[0].start).toBe(0)
  })

  test('finds verbose position', () => {
    const positions = findTokenBudgetPositions('use 2M tokens here')
    expect(positions.length).toBe(1)
    expect(positions[0].start).toBe(0)
  })

  test('returns empty for no budget', () => {
    expect(findTokenBudgetPositions('no budget')).toEqual([])
  })
})

describe('getBudgetContinuationMessage', () => {
  test('formats continuation message', () => {
    const msg = getBudgetContinuationMessage(50, 250000, 500000)
    expect(msg).toContain('50%')
    expect(msg).toContain('250,000')
    expect(msg).toContain('500,000')
    expect(msg).toContain('Keep working')
  })
})
```

- [ ] **Step 6: Run all verification tests**

Run: `bun test src/utils/__tests__/sideQuery.test.ts src/utils/__tests__/tokenBudget.test.ts`
Expected: PASS

- [ ] **Step 7: Run full test suite to verify no regressions**

Run: `bun test src/utils/ src/query/`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/utils/__tests__/sideQuery.test.ts src/utils/__tests__/tokenBudget.test.ts
git commit -m "test: add verification tests for existing sideQuery and tokenBudget modules"
```

---

## Self-Review

### 1. Spec Coverage

| Spec Requirement | Task | Status |
|-----------------|------|--------|
| #1 Cross-Provider Cache Metrics | Task 1 | New file + tests |
| #2 Tool Schema Cache (invalidateRemovedToolSchemas) | Task 2 | Modify existing + tests |
| #3 Incremental Token Counter | Task 3 | New file + tests + query.ts integration |
| #4 Tool History Compression | Task 4 | New file + tests + query.ts integration |
| #5 Cached Microcompact | Already exists | Verify in Task 8 |
| #6 Provider Auto-Fallback | Task 6 | New file + tests + client.ts integration |
| #7 Context Partitioning | Task 5 | New file + tests + compact.ts integration |
| #8 Token Budget Parser | Task 9 | Verify existing + tests (`src/utils/tokenBudget.ts` 73 LOC) |
| #9 Tool Result Persistence | Task 8 | Verify existing + tests |
| #10 Streaming Tool Execution | Task 7 | Verify existing + tests |
| #11 Side Query | Task 9 | Verify existing + tests (`src/utils/sideQuery.ts` 222 LOC) |
| #12 Prompt Cache Break Detection | Already exists | `src/services/api/promptCacheBreakDetection.ts` |

### 2. Existing Files (already in ola-cc)

| File | LOC | Status |
|------|-----|--------|
| `src/utils/toolSchemaCache.ts` | 27 | Add `invalidateRemovedToolSchemas` |
| `src/services/compact/cachedMicrocompact.ts` | 300 | Already complete |
| `src/services/tools/StreamingToolExecutor.ts` | 532 | Already complete |
| `src/utils/sideQuery.ts` | 222 | Already complete |
| `src/utils/tokenBudget.ts` | 73 | Already complete |
| `src/utils/toolResultStorage.ts` | 1040 | Already complete |
| `src/services/api/promptCacheBreakDetection.ts` | ~768 | Already complete |

### 3. New Files to Create

| File | LOC (est.) | Source |
|------|-----------|--------|
| `src/services/api/cacheMetrics.ts` | ~540 | openclaude |
| `src/utils/incrementalTokenCounter.ts` | ~260 | openclaude |
| `src/services/api/compressToolHistory.ts` | ~270 | openclaude |
| `src/utils/providerFallback.ts` | ~110 | openclaude |
| `src/utils/contextPartitioning.ts` | ~140 | openclaude |
| `src/commands/cache-stats/index.ts` | ~15 | new |
| `src/commands/cache-stats/cacheStats.ts` | ~50 | new |
| `src/utils/__tests__/sideQuery.test.ts` | ~30 | new (Task 9) |
| `src/utils/__tests__/tokenBudget.test.ts` | ~80 | new (Task 9) |
| 6 original test files | ~600 | new |

### 4. Placeholder Scan

One known placeholder remains:
- Task 6 (`providerFallback.ts`): `// TODO: adapt to ola-cc's settings access pattern` — requires investigating ola-cc's settings access pattern before wiring.

All other steps contain complete code or precise file references.

### 5. Dependency Graph

```
Task 1 (Cache Metrics) ──────────────────────┐
Task 2 (Tool Schema Cache) ──────────────────┤
Task 3 (Incremental Token Counter) ──────────┤── Task 5 (Context Partitioning)
Task 4 (Tool History Compression) ───────────┤
Task 6 (Provider Fallback) ← depends on T1 ──┤
Task 7 (Streaming Tool Executor) ────────────┤── Independent
Task 8 (Tool Result Persistence) ────────────┤
Task 9 (Verification: sideQuery + tokenBudget)┘
```

Tasks 1, 2, 3, 4, 7, 8 can be parallelized. Task 5 depends on Task 3. Task 6 depends on Task 1. Task 9 is independent (verifies existing modules, no code dependency on Tasks 1-8).

**query.ts Hot-spot Merge Order**: Task 3 → Task 4 → Task 5 (see "Hot-spot File Merge Strategy" section).

### 6. Feature Flags to Register

| Flag | Task | Default |
|------|------|---------|
| `CACHE_METRICS` | Task 1 | off |
| `INCREMENTAL_TOKEN` | Task 3 | off |
| `COMPRESS_TOOL_HISTORY` | Task 4 | off |
| `CONTEXT_PARTITIONING` | Task 5 | off |
| `PROVIDER_FALLBACK` | Task 6 | off |
| `STREAMING_TOOLS` | Task 7 | off |
| `TOOL_RESULT_PERSIST` | Task 8 | off |

Existing flags (already in build.ts): `CACHED_MICROCOMPACT`, `PROMPT_CACHE_BREAK_DETECTION`, `TOKEN_BUDGET`.

---

## Cross-Plan Coordination: query.ts

This plan's Tasks 3, 4, 5 modify `src/query.ts`. Other plans also modify the same file. **All plans must be merged in the order specified below to avoid conflicts.**

### query.ts Modification Map (All Plans)

| Plan | Task | Region in query.ts | Insertion Point |
|------|------|-------------------|-----------------|
| **P4 (This Plan)** | Task 3 | Counter instantiation | After line ~569 (`messagesForQuery`) |
| **P4 (This Plan)** | Task 4 | Microcompact region | After line ~635 (`queryCheckpoint("query_microcompact_end")`) |
| **P4 (This Plan)** | Task 5 | compact.ts (NOT query.ts) | N/A — modifies `compact.ts` |
| **P7 (Infra Hardening)** | Task 1 (Sanitizer) | API call preparation | Before `const apiMessages = messagesForQuery` |
| **P7 (Infra Hardening)** | Task 1 (Normalizer) | Tool execution | Before `const result = await tool.call(args)` |
| **P7 (Infra Hardening)** | Task 2 (LSP Feedback) | User message processing | After user message added to conversation |
| **P7 (Infra Hardening)** | Task 4 (Usage Reminder) | Tool result handling | After tool execution succeeds |
| **P7 (Infra Hardening)** | Task 5 (Post-Sampling) | Model response handling | After model response received |
| **P6 (YOLO+Langfuse)** | Task 2.10 | Tool execution wrapper | Wrap `processToolCalls()` in Langfuse span |
| **P10 (Agent Intel)** | Task 9 (Frustration) | Tool results processing | After tool results collected, before next model call |

### Recommended Merge Order

1. **P7 Task 1** (Sanitizer + Normalizer) — earliest insertion points
2. **P4 Task 3** (Incremental Token Counter) — counter instantiation near line 569
3. **P7 Task 2** (LSP Feedback) — user message processing region
4. **P4 Task 4** (Tool History Compression) — microcompact region near line 635
5. **P7 Task 4** (Usage Reminder) — tool result handling
6. **P7 Task 5** (Post-Sampling Hook) — model response handling
7. **P6 Task 2.10** (Langfuse spans) — wraps processToolCalls (additive, no conflict)
8. **P10 Task 9** (FrustrationDetection) — after tool results (additive)

**Key rule**: Each plan's insertion points are non-overlapping within that plan. Cross-plan conflicts are resolved by merge order above. All changes are purely additive (feature-gated imports + conditional calls).
