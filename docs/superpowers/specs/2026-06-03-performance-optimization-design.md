# Performance Optimization Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: openclaude + claude-code
**Priority**: P0/P1
**Effort**: S-M

---

## 1. Cross-Provider Cache Metrics (P0, from openclaude)

**Source**: `/Users/heal/openclaude/src/services/api/cacheMetrics.ts`

### Features

- Unified cache field extraction across 10+ providers
- `extractCacheReadFromRawUsage()`: Handles provider-specific fields:
  - Anthropic: `cache_read_input_tokens`
  - OpenAI: `input_tokens_details.cached_tokens` 或 `prompt_tokens_details.cached_tokens`
  - DeepSeek: `prompt_cache_hit_tokens`
  - Kimi / Moonshot: `cached_tokens`（顶层字段，非嵌套）
  - Gemini: `cached_content_token_count`（顶层字段，非 `usageMetadata` 嵌套）
  - Copilot (non-Claude): `supported: false`（N/A，不报告 cache 数据）
  - Ollama: `supported: false`（N/A，不报告 cache 数据，非 `prompt_eval_count` 估算）
- `/cache-stats` command: compact/full format display

### Integration

| File | Operation |
|------|-----------|
| `src/services/api/cacheMetrics.ts` | **New** |
| `src/commands/cache-stats.ts` | **New** — /cache-stats command |

---

## 2. Tool Schema Cache (P0, from openclaude)

**Source**: `/Users/heal/openclaude/src/utils/toolSchemaCache.ts`

### Features

- Session-scoped: Lock schema bytes after rendering
- Prevents cache breakage from GB flag flips, MCP reconnects
- `invalidateRemovedToolSchemas()`: Selective invalidation

### Performance: ~5-15% cache break reduction (基于 tool schema 变化频率 < 2 次/session 的场景)

### Integration

| File | Operation |
|------|-----------|
| `src/utils/toolSchemaCache.ts` | **New** |
| `src/services/api/claude.ts` | Modify — Use cached schemas |

---

## 3. Incremental Token Counter (P0, from openclaude)

**Source**: `/Users/heal/openclaude/src/utils/incrementalTokenCounter.ts`

### Features

- SHA-256 content hash for cache validation
- Incremental calculation: O(1) cache hit / O(n) miss
- Factory modes: realtime(50K) / batch(200K) / lightweight(10K)

### Performance: ~90% token computation overhead reduction (基于消息数 > 100 且内容变化率 < 10% 的场景)

### Integration

| File | Operation |
|------|-----------|
| `src/utils/incrementalTokenCounter.ts` | **New** |
| `src/query.ts` | Modify — Use incremental counter |

---

## 4. Tool History Compression (P1, from openclaude)

**Source**: `/Users/heal/openclaude/src/services/api/compressToolHistory.ts`

### Three-Tier Compression

| Tier | Content | Retention |
|------|---------|-----------|
| Recent | Full fidelity | Last N messages |
| Mid | Truncated to 2K chars | Middle messages |
| Old | Stub: `[toolName args={...} → N chars omitted]` | Oldest messages |

### Adaptive Tier Sizing

- 16K context → 2/3 tier sizes
- 500K context → 25/50 tier sizes
- Complementary with microCompact (Claude cache-based vs size-based)

### Performance: 40-60% token reduction (基于 50+ turn 非 Claude provider 长会话)

### 与 microCompact 的执行顺序

执行顺序：先 microCompact（按大小裁剪 tool result），再 History Compression（按消息年龄分层压缩）。两者修改不同维度，不冲突。

### Integration

| File | Operation |
|------|-----------|
| `src/services/api/compressToolHistory.ts` | **New** |
| `src/query.ts` | Modify — Apply compression before API calls |

---

## 5. Cached Microcompact (P1, from claude-code)

**Source**: `/Users/heal/claude-code/src/services/compact/cachedMicrocompact.ts`
**Status**: 已有 `src/services/compact/cachedMicrocompact.ts` — 扩展

**与 microCompact 的关系**: 互补而非替代。
- microCompact: 基于 tool result 大小的压缩，适用于所有 provider
- Cached Microcompact: 基于 Claude cache_edits API 的服务端删除，仅 Claude provider
- 两者可同时启用：先 microCompact 压缩大小，再 Cached Microcompact 删除旧 cache

### Features

- Uses Claude 4.x `cache_edits` beta API
- Server-side deletion of old tool_results
- Trigger: 10 tool results, keep recent 5
- `CachedMCState` tracks registered tools, deleted refs, pinned edits

### Performance: 30-50% cache token savings (基于 Claude 4.x cache_edits beta，10+ tool results/session)

### Integration

| File | Operation |
|------|-----------|
| `src/services/compact/cachedMicrocompact.ts` | **New** |
| `src/services/compact/compact.ts` | Modify — Integrate cached microcompact |

---

## 6. Provider Auto-Fallback (P1, from openclaude)

**Source**: `/Users/heal/openclaude/src/utils/providerFallback.ts`

### Features

- Chain fallback: `providerFallbackChain` config（用户配置的 provider ID 有序列表）
- Rate limit trigger: Auto-switch on 429
- No loop: 到链尾返回 `null`，不回绕

### Loop 防护

实际代码**没有** `FallbackState` 接口或 `visited` 集合。防护机制非常简单：

```typescript
export function resolveNextFallbackProvider(
  activeProfileId: string | null,
  chain: string[],
  profiles: ProviderProfile[],
): ProviderFallbackResolution | null {
  // 从 activeProfileId 在 chain 中的位置之后开始查找
  // 返回第一个有效 profile，到链尾返回 null
  // 不回绕到 chain 头部（避免 ratelimit → ratelimit 循环）
}
```

防护仅靠**链尾终止**：遍历 chain 中 active 之后的条目，找到第一个有效 profile 返回；到链尾返回 `null`。没有 `visited` 集合、没有 `maxAttempts` 计数器。

### Integration

| File | Operation |
|------|-----------|
| `src/utils/providerFallback.ts` | **New** |
| `src/services/api/client.ts` | Modify — Add fallback logic |

---

## 7. Context Partitioning (P2, from openclaude)

**Source**: `/Users/heal/openclaude/src/utils/contextPartitioning.ts`

### Four-Zone Priority

| Zone | Budget | Content |
|------|--------|---------|
| Recent | 50K | Latest messages |
| Important | 30K | Error/fail messages, long messages |
| Background | 10K | Normal messages |
| System | 8K | System prompts |

### Pruning Strategies

- `prune_oldest`: Remove oldest first
- `prune_least_important`: Remove lowest priority first
- ~~Message chain integrity: tool_use → tool_result pairs never split~~ **（未实现 — TODO）**

> **注意**：实际代码中 `classifyMessage` 仅按内容关键词分类（`error`/`fail`/`important` → important zone，`tool_use` → important zone，长度 > 2000 → important zone），**没有 tool_use/tool_result 配对保护逻辑**。配对完整性保护需后续实现。

### Performance: 15-25% unnecessary token reduction under context pressure

### Integration

| File | Operation |
|------|-----------|
| `src/utils/contextPartitioning.ts` | **New** |
| `src/services/compact/compact.ts` | Modify — Use partitioning strategy |

---

## 8. Token Budget Parser (P2, from claude-code)

**Source**: `/Users/heal/claude-code/src/utils/tokenBudget.ts`

### Features

- Natural language parsing: `+500k`, `use 2M tokens`
- `getBudgetContinuationMessage()`: Inject continuation instruction at budget percentage

### Integration

| File | Operation |
|------|-----------|
| `src/utils/tokenBudget.ts` | **New** |
| `src/query.ts` | Modify — Apply budget limits |

---

## 9. Tool Result Persistence (P2, from claude-code)

**Source**: `/Users/heal/claude-code/src/utils/toolResultStorage.ts`

### Features

- Disk persistence: Large results written to file, not truncated
- Per-message aggregate budget: `enforceToolResultBudget()`
- Content Replacement State: `seenIds + replacements` for prompt cache stability
- Preview: 2KB preview + file path reference

### Performance: 20-40% token savings in long sessions

### Integration

| File | Operation |
|------|-----------|
| `src/utils/toolResultStorage.ts` | **New** |
| `src/services/tools/toolExecution.ts` | Modify — Persist large results |

---

## 10. Streaming Tool Execution (P1, from openclaude)

**Source**: `/Users/heal/openclaude/src/services/tools/StreamingToolExecutor.ts`

### Features

- `isConcurrencySafe` flag: Parallel-safe tools (Read) vs exclusive tools (Edit)
- Stream-start: Begin execution as `tool_use` blocks stream in
- Ordered buffering: Parallel execution, ordered output
- Sibling abort: One Bash error → abort all parallel tools
- Streaming fallback: Discard pending tools on stream failure

### Performance: 3x → ~1x latency for parallel Read tools

### Integration

| File | Operation |
|------|-----------|
| `src/services/tools/StreamingToolExecutor.ts` | **New** |
| `src/query.ts` | Modify — Use streaming executor |

---

## 11. Side Query (P1, from claude-code)

**Source**: `/Users/heal/claude-code/src/utils/sideQuery.ts`

### Features

- Lightweight API wrapper for auxiliary queries
- Multi-provider: Anthropic/OpenAI/Grok/Gemini
- Default small params: `max_tokens = 1024`
- Langfuse integration: Each side query creates child span

### Use Cases

- Permission classifier (yoloClassifier)
- Permission explainer
- Session search
- Model validation

### Integration

| File | Operation |
|------|-----------|
| `src/utils/sideQuery.ts` | **New** |
| `src/utils/permissions/yoloClassifier.ts` | Modify — Use side query |

---

## 12. Prompt Cache Break Detection (P1, from claude-code)

**Source**: `/Users/heal/claude-code/src/services/api/promptCacheBreakDetection.ts`
**Status**: 已有 `src/services/api/promptCacheBreakDetection.ts`（~768 LOC）— 已有完整诊断输出

### 12.1 核心机制

两阶段诊断系统：
1. **Phase 1 (pre-call)**：`recordPromptState()` 记录当前 prompt/tool 状态，检测变化，存储 pending changes
2. **Phase 2 (post-call)**：`checkResponseForCacheBreak()` 检查 API 响应的 cache tokens，判断是否发生 cache break，用 pending changes 解释原因

### 12.2 诊断维度（12 维）

实际 12 维来自 `PendingChanges` 接口的布尔字段：

| 维度 | 字段名 | 检测内容 | 影响 |
|------|--------|---------|------|
| 1. System Prompt 变化 | `systemPromptChanged` | system prompt 内容 hash 不同（含字符数 delta） | 全部 cache 失效 |
| 2. Tool Schema 变化 | `toolSchemasChanged` | 工具列表/描述变化（含 per-tool hash 精确定位） | 工具区 cache 失效 |
| 3. Cache Control 变化 | `cacheControlChanged` | cache_control scope/TTL 翻转（global↔org, 1h↔5m） | 全部 cache 失效 |
| 4. Model 变化 | `modelChanged` | model ID 不同 | 全部 cache 失效 |
| 5. Fast Mode 变化 | `fastModeChanged` | fast mode 开关切换 | 全部 cache 失效 |
| 6. Global Cache Strategy 变化 | `globalCacheStrategyChanged` | MCP 工具发现/移除导致策略翻转 | 全部 cache 失效 |
| 7. Betas 变化 | `betasChanged` | anthropic_beta 列表不同（含 added/removed diff） | 全部 cache 失效 |
| 8. Auto Mode 变化 | `autoModeChanged` | AFK_MODE_BETA_HEADER presence 翻转 | 全部 cache 失效 |
| 9. Overage 变化 | `overageChanged` | overage 状态翻转（TTL latched，不应再翻转） | 全部 cache 失效 |
| 10. Cached MC 变化 | `cachedMCChanged` | cache_edits beta header 翻转 | 全部 cache 失效 |
| 11. Effort 变化 | `effortChanged` | resolved effort 值变化 | 全部 cache 失效 |
| 12. Extra Body 变化 | `extraBodyChanged` | getExtraBodyParams() hash 变化 | 全部 cache 失效 |

### 12.3 诊断输出（已启用）

代码已有完整 `logEvent('tengu_prompt_cache_break', {...})` 输出，包含：
- 所有 12 维布尔变化标记
- 工具增删详情（added/removed/changed tool names，MCP 工具标记为 `mcp`）
- Beta header diff（added/removed）
- Cache strategy 变化（prev/new）
- Token 数据（prevCacheReadTokens, cacheReadTokens, cacheCreationTokens）
- 时间间隔（timeSinceLastAssistantMsg, lastAssistantMsgOver5minAgo, lastAssistantMsgOver1hAgo）
- Diff 文件路径（debug 模式下写入 `.claude/cache-break-*.diff`）

**诊断原因分类**：
- 有 client-side 变化 → 列出具体变化项
- 无变化 + >1h gap → "possible 1h TTL expiry"
- 无变化 + >5min gap → "possible 5min TTL expiry"
- 无变化 + <5min gap → "likely server-side (prompt unchanged, <5min gap)"

> **注意**：`CacheBreakDiagnosis` 接口在实际代码中**不存在**。诊断结果通过 `logForDebugging` 和 `logEvent` 输出，不通过结构化接口返回。

### 12.4 辅助功能

- `notifyCacheDeletion()` — cached microcompact 删除 cache 后调用，标记下一次 token drop 为预期行为
- `notifyCompaction()` — compact 后调用，重置 cache read baseline
- `cleanupAgentTracking()` — agent 结束时清理追踪状态
- LRU 追踪：`MAX_TRACKED_SOURCES = 10`，防止 subagent 过多导致内存增长
- 排除模型：haiku 模型跳过检测（cache 行为不同）

### Integration

| File | Operation |
|------|-----------|
| `src/services/api/promptCacheBreakDetection.ts` | **已有** — 完整诊断输出已启用 |

---

## 13. 架构师视角：性能体系分层

12 个功能按职责划分为四层，形成自底向上的性能优化栈：

```
┌─────────────────────────────────────────────────────────────────┐
│ Provider 层 (L4)                                                │
│   Provider Auto-Fallback ── 429 时自动切换 provider              │
├─────────────────────────────────────────────────────────────────┤
│ Execution 层 (L3)                                               │
│   Streaming Tool Execution ── 并行工具流式执行                    │
│   Side Query ── 轻量级辅助 API 调用                               │
├─────────────────────────────────────────────────────────────────┤
│ Context 层 (L2)                                                  │
│   Context Partitioning ── 四区域优先级裁剪                        │
│   Tool History Compression ── 三级消息压缩                        │
│   Cached Microcompact ── Claude cache_edits 服务端删除            │
│   Tool Result Persistence ── 大结果磁盘持久化                     │
│   Token Budget Parser ── 自然语言 token 预算                      │
├─────────────────────────────────────────────────────────────────┤
│ Token/Cache 层 (L1)                                              │
│   Cross-Provider Cache Metrics ── 10+ provider 缓存指标           │
│   Tool Schema Cache ── Schema 字节锁定防缓存断裂                  │
│   Incremental Token Counter ── SHA-256 增量计数                   │
│   Prompt Cache Break Detection ── 12 维缓存断裂诊断               │
└─────────────────────────────────────────────────────────────────┘
```

**层间依赖**：
- L1 → L2：Incremental Token Counter 为 Context Partitioning 提供精确 token 度量
- L2 → L3：Context 层压缩后的上下文由 Execution 层的 Streaming Executor 消费
- L1 → L4：Cache Metrics 和 Cache Break Detection 的诊断数据驱动 Provider Fallback 决策

---

## 14. 实施路线图

4 Phase 分组，按依赖关系排序：

| Phase | 功能 | 优先级 | 依赖 | 预计周期 |
|-------|------|--------|------|---------|
| **Phase 0: Cache 层** | Cross-Provider Cache Metrics | P0 | 无 | 1 周 |
| | Tool Schema Cache | P0 | 无 | |
| | Prompt Cache Break Detection | P0 | 无（已有代码） | |
| **Phase 0: Token 层** | Incremental Token Counter | P0 | 无 | 1 周 |
| **Phase 1: Execution 层** | Streaming Tool Execution | P1 | 无 | 2 周 |
| | Side Query | P1 | 无 | |
| | Tool History Compression | P1 | 无 | |
| | Cached Microcompact | P1 | 无（已有代码） | |
| **Phase 2: Context 层** | Context Partitioning | P2 | Phase 0 Token 层 | 2 周 |
| | Token Budget Parser | P2 | Phase 0 Token 层 | |
| | Tool Result Persistence | P2 | 无 | |
| **Phase 3: Provider 层** | Provider Auto-Fallback | P1 | Phase 0 Cache 层 | 1 周 |

**关键路径**：Phase 0 Cache + Token → Phase 2 Context（依赖精确 token 计数）→ Phase 3 Fallback（依赖缓存诊断）

---

## 15. LOC 估算总表

| # | 功能 | 新增文件 | LOC 估算 | 修改文件 | 难度 |
|---|------|---------|---------|---------|------|
| 1 | Cross-Provider Cache Metrics | `cacheMetrics.ts` + `cache-stats.ts` | ~200 | — | Low |
| 2 | Tool Schema Cache | `toolSchemaCache.ts` | ~120 | `claude.ts` ~30 | Low |
| 3 | Incremental Token Counter | `incrementalTokenCounter.ts` | ~250 | `query.ts` ~40 | Medium |
| 4 | Tool History Compression | `compressToolHistory.ts` | ~200 | `query.ts` ~30 | Medium |
| 5 | Cached Microcompact | `cachedMicrocompact.ts` | ~180 | `compact.ts` ~40 | Medium |
| 6 | Provider Auto-Fallback | `providerFallback.ts` | ~150 | `client.ts` ~50 | Medium |
| 7 | Context Partitioning | `contextPartitioning.ts` | ~220 | `compact.ts` ~40 | High |
| 8 | Token Budget Parser | `tokenBudget.ts` | ~100 | `query.ts` ~20 | Low |
| 9 | Tool Result Persistence | `toolResultStorage.ts` | ~1050 | `toolExecution.ts` ~40 | Medium |
| 10 | Streaming Tool Execution | `StreamingToolExecutor.ts` | ~350 | `query.ts` ~60 | High |
| 11 | Side Query | `sideQuery.ts` | ~750 | `yoloClassifier.ts` ~30 | Low |
| 12 | Prompt Cache Break Detection | — (已有) | ~80 | `cache-debug.ts` ~120 | Low |
| | **合计** | 10 新文件 | **~3,680** | 7 修改文件 **~360** | |

**总计**: ~4,040 LOC 新增/修改

---

## 16. 向后兼容约束

| 功能 | Feature Flag | 默认 | 降级策略 |
|------|-------------|------|---------|
| Cache Metrics | CACHE_METRICS | off | 无 cache 统计 |
| Tool Schema Cache | TOOL_SCHEMA_CACHE | off | 每次重新渲染 |
| Incremental Token Counter | INCREMENTAL_TOKEN | off | 全量计算 |
| Tool History Compression | COMPRESS_TOOL_HISTORY | off | 不压缩 |
| Cached Microcompact | CACHED_MICROCOMPACT | 已有（代码中已注册） | 仅 microCompact |
| Provider Auto-Fallback | PROVIDER_FALLBACK | off | 单 provider |
| Context Partitioning | CONTEXT_PARTITIONING | off | 标准 compact |
| Token Budget | TOKEN_BUDGET | off | 无限制 |
| Tool Result Persistence | TOOL_RESULT_PERSIST | off | 内存中截断 |
| Streaming Tool Execution | STREAMING_TOOLS | off | 串行执行 |
| Side Query | SIDE_QUERY | off | 主 API 调用 |
| Cache Break Detection | CACHE_BREAK_DETECTION | 已有（代码中已注册） | 无诊断 |
