# Four-Project Cross-Integration Design

**Date**: 2026-06-03
**Status**: Design Complete, Pending Implementation
**Scope**: Integrate features from claude-code-best (v2.6.6), openclaude (v0.16.1), oh-my-claudecode (v4.14.4) into ola-cc (v0.4.10)

---

## 1. Project Overview

| Project | Type | Version | Key Characteristics |
|---------|------|---------|---------------------|
| **claude-code-best** | Official upstream | v2.6.6 | Anthropic maintained, Feature flags, Langfuse/ACP/WeChat |
| **ola-cc** | Fork | v0.4.10 | OLA_CC_ prefix, enhanced OpenAI shim, CPU debug, cache strategy, ASAEF evolution |
| **openclaude** | Community fork | v0.16.1 | External builtin-tools, Langfuse, multi-provider OAuth, 13+ providers |
| **oh-my-claudecode** | SDK plugin layer | v4.14.4 | **Not a fork**, independent orchestration via Claude Agent SDK |

---

## 2. Existing Feature Differences (10 Subsystems)

### 2.1 Provider System

| Dimension | claude-code-best | ola-cc | openclaude |
|-----------|-----------------|--------|------------|
| APIProvider types | 5: firstParty/bedrock/vertex/foundry/openai | 7: +gemini/grok | **13**: +gemini/github/codex/nvidia-nim/minimax/mistral/xai/xiaomi-mimo |
| OpenAI shim | Basic | **Enhanced schema sanitization** | codex/xai OAuth + think tag sanitizer |
| Cache strategy | None | **getCacheStrategy() dual strategy** | None |
| Provider override | None | None | **providerOverride per-agent** |
| Timeout validation | Direct parseInt | **NaN/negative/upper-cap validation** | Direct parseInt |
| 3rd-party host detection | None | **isThirdPartyProvider()** | None |
| SSH auth nonce | Supported | Not supported | Not supported |

**Best**: openclaude (provider count) + ola-cc (cache strategy + timeout validation)

### 2.2 Tool System

| Dimension | claude-code-best | ola-cc | openclaude |
|-----------|-----------------|--------|------------|
| ToolRegistry | **O(n) linear scan** | None | None |
| buildTool assertion | **inputSchema check** | None | None |
| JSON Schema types | **Strict Draft 7** | Loose unknown | Loose unknown |
| CompactProgressEvent | 3 stages | **4 stages (enhanced)** | 3 stages |
| AgentDefinition import | Local | Local | **External @claude-code-best/builtin-tools** |

**Best**: claude-code-best (ToolRegistry + type safety), ola-cc (CompactProgressEvent)

### 2.3 Command System

| Dimension | claude-code-best | ola-cc | openclaude |
|-----------|-----------------|--------|------------|
| Feature flag gating | **Many feature() conditional imports** | All enabled | **feature() conditional imports** |
| meetsAvailabilityRequirement | **Checks claude-ai/console** | **return true (security risk)** | Checks claude-ai/console |
| Unique commands | tui/sessions/fork/peers | **goal/skill/autonomy** | dream/knowledge/lsp/wiki |

**Critical issue**: ola-cc's `meetsAvailabilityRequirement` always returns true, exposing internal commands.

### 2.4 Compact System

| Dimension | claude-code-best | ola-cc | openclaude |
|-----------|-----------------|--------|------------|
| compactModelRouter | None | **Present (cost optimization)** | None |
| isThirdPartyProvider | None | **Present (cache strategy)** | None |

**Best**: ola-cc (compactModelRouter + cache strategy detection)

### 2.5 Sub-Agent System

| Dimension | claude-code-best | ola-cc | openclaude |
|-----------|-----------------|--------|------------|
| ResourceQuotaManager | **Present** | None | None |
| getClassification | **Present** | None | None |
| agentRouting | None | **Present** | **Present** |
| assembleToolPool | Direct import | **Registration pattern (breaks circular dep)** | Direct import |

**Best**: claude-code-best (resource quota) + ola-cc (circular dependency solution)

### 2.6 Permission System

| Dimension | claude-code-best | ola-cc | openclaude |
|-----------|-----------------|--------|------------|
| isBypassPermissionsModeAvailable | **Default false** | **Default false** | Default true (permissive) |

### 2.7-2.10 Hook/MCP/Build/State

- **Hook**: Nearly identical across all three, openclaude adds `hookChainsCanUseTool`
- **MCP**: Nearly identical, openclaude externalizes tools to separate package
- **Build**: openclaude most flexible (custom feature flag plugin + external builtin-tools)
- **State**: ola-cc most distinctive (valuesEqual recursive comparison + CPU debug)

---

## 2.11 Feature Flag Matrix

所有新增功能均通过 compile-time `feature()` 门控（`bun:bundle`）或 runtime 环境变量门控。未启用时所有导出函数降级为 no-op，零运行时开销。

| # | 子系统 | Flag 名称 | 类型 | 默认值 | 降级策略 | 环境变量覆盖 |
|---|--------|----------|------|--------|---------|-------------|
| 1 | Langfuse Tracing | `LANGFUSE_TRACING` | compile-time | OFF | 所有 tracing 函数 → no-op，不创建 OTel 资源 | `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` 同时设置才激活 |
| 2 | LSP Tools | `LSP_TOOLS` | compile-time | OFF | `LspClientManager` 不加载，12 个工具不注册 | `OLA_CC_ENABLE_LSP=1` |
| 3 | Agent Routing | `OLA_CC_AGENT_ROUTING` | runtime | OFF | 所有 agent 使用默认 provider/model | `OLA_CC_AGENT_ROUTING=1` |
| 4 | Smart Model Routing | `OLA_CC_SMART_ROUTING` | runtime | OFF | 所有消息使用主模型，不进行复杂度分类 | `OLA_CC_SMART_ROUTING=1` |
| 5 | GrowthBook LOCAL_DEFAULTS | — | runtime (always-on) | ON | 使用 `defaultValue` 参数兜底 | — |
| 6 | yoloClassifier | `TRANSCRIPT_CLASSIFIER` | compile-time | OFF | 使用现有 rule-based 权限检查 | `OLA_CC_ENABLE_CLASSIFIER=1` |
| 7 | Keychain Linux/Windows | — | runtime (platform) | ON | 平台检测自动选择：Linux → libsecret，Windows → DPAPI，其他 → fallback | — |
| 8 | Provider Auto-Detect | `OLA_CC_PROVIDER_AUTO_DETECT` | runtime | ON | 使用默认 anthropic provider | `OLA_CC_PROVIDER_AUTO_DETECT=0` 禁用 |
| 9 | Dynamic Workflows | `WORKFLOW_SCRIPTS` | compile-time | OFF | DAG-based workflow 继续工作 | `OLA_CC_ENABLE_WORKFLOWS=1` |
| 10 | SSRF Guard | `SSRF_GUARD` | compile-time | ON | 禁用 SSRF 检查（不推荐） | `OLA_CC_DISABLE_SSRF=1` |
| 11 | Secret Scanner | `SECRET_SCANNER` | compile-time | ON | 禁用凭据扫描 | `OLA_CC_DISABLE_SECRET_SCAN=1` |
| 12 | ACP Protocol | `ACP_PROTOCOL` | compile-time | OFF | ACP 相关功能不注册 | `OLA_CC_ENABLE_ACP=1` |

**门控模式**:
- **compile-time**: `feature('FLAG') ? (require(...)) : null` — 代码不打包进产物
- **runtime**: 环境变量或 `settings.json` 配置，运行时检查

---

## 3. P0/P1 Feature Implementation Details

### 3.1 Langfuse Tracing (P0, from claude-code-best)

**Architecture**: 4 files in `src/services/langfuse/`

| File | Purpose |
|------|---------|
| `client.ts` | SDK init + lifecycle (initLangfuse/flushLangfuse/shutdownLangfuse) |
| `tracing.ts` | Trace/Generation/Span creation (createTrace/recordLLMObservation/recordToolObservation) |
| `convert.ts` | Anthropic → OpenAI message format conversion |
| `sanitize.ts` | 3-layer redaction (global path → tool input keys → tool output by type) |

**Type hierarchy**:
```
RootTrace (agent) → LangfuseSpan (generation) → LangfuseSpan (tool) → LangfuseSpan (batch)
```

**Environment variables**:
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` (required)
- `LANGFUSE_BASE_URL` (default: cloud.langfuse.com)
- `LANGFUSE_FLUSH_AT` (default: 20) / `LANGFUSE_FLUSH_INTERVAL` (default: 10s)
- `LANGFUSE_EXPORT_MODE` (batched/immediate)
- `LANGFUSE_USER_ID` (optional)

**Integration steps**:
1. Install: `@langfuse/otel` + `@langfuse/tracing` + `@opentelemetry/sdk-trace-base`
2. Create `src/services/langfuse/` (4 files)
3. Integrate `recordLLMObservation` in `src/services/api/claude.ts`
4. Integrate `recordToolObservation` in `src/services/tools/toolExecution.ts`
5. Integrate trace lifecycle in `src/QueryEngine.ts`
6. Call `initLangfuse()` at startup, `shutdownLangfuse()` at exit

**Files to modify**: `package.json`, `src/services/langfuse/` (new), `src/services/api/claude.ts`, `src/services/tools/toolExecution.ts`, `src/QueryEngine.ts`, `src/query.ts`

### 3.2 LSP Tools (P0, from oh-my-claudecode)

**12 tools**: hover/goto_definition/find_references/document_symbols/workspace_symbols/diagnostics/rename/format/code_actions/completion/signature_help/folding_range

**Key design**: `withLspClient` wrapper + `lspClientManager.getClientForFile()` per-language routing

**Integration steps**:
1. Create `src/tools/LspTools/` (3 files: manager, tools, types)
2. Add LSP client dependency handling
3. Register in `src/tools.ts`

### 3.3 Agent Routing (P0, from openclaude)

**`resolveAgentRunModelRouting()`**: Priority chain toolSpecifiedModel > agentName > subagentType > "default"

**`applyAgentProviderOverrideToEnv()`**: Clears 22 competing env vars, prevents agent provider pollution

**Integration steps**:
1. Create `src/services/api/agentRouting.ts`
2. Extend `SettingsJson` type with `agentModels` + `agentRouting`
3. Modify `src/services/api/client.ts` — add providerOverride branch
4. Modify `src/tools/AgentTool/AgentTool.tsx` — call resolveAgentRunModelRouting()

### 3.4 Smart Model Routing (P1, from openclaude)

**8 conditions for "simple"**: non-first-turn + no code blocks + no 28 keywords + single paragraph + ≤160 chars + ≤28 words + no attachments + no tool results

**Config**: `settings.smartRouting = { enabled, simpleModel, strongModel, simpleMaxChars, simpleMaxWords }`

**Integration steps**:
1. Create `src/services/api/smartModelRouting.ts` (pure function, no deps)
2. Extend settings type with `smartRouting`
3. Integrate in `src/query.ts` before API request

### 3.5 GrowthBook LOCAL_GATE_DEFAULTS (P1, from claude-code-best)

**Key difference**: claude-code-best has 30+ local defaults enabling features without GrowthBook server connection. ola-cc missing this.

**Lookup priority chain** (claude-code-best):
1. `CLAUDE_INTERNAL_FC_OVERRIDES` env var
2. `growthBookOverrides` config
3. **`LOCAL_GATE_DEFAULTS`** local defaults ← ola-cc missing
4. `remoteEvalFeatureValues` memory cache
5. `cachedGrowthBookFeatures` disk cache
6. `defaultValue` parameter

**Integration steps**:
1. Add `LOCAL_GATE_DEFAULTS` object to `src/services/analytics/growthbook.ts`
2. Add `getLocalGateDefault()` function
3. Modify all `getFeatureValue*` and `checkGate*` functions to include LOCAL_GATE_DEFAULTS fallback

### 3.6 yoloClassifier (P1, from claude-code-best)

**Core interface**:
```typescript
export async function classifyYoloAction(
  messages: Message[],
  action: TranscriptEntry,
  tools: Tools,
  context: ToolPermissionContext,
  signal: AbortSignal,
): Promise<YoloClassifierResult>
```

**Classification flow**:
1. `buildTranscriptEntries(messages)` — extract user text + assistant tool_use (exclude assistant text to prevent injection)
2. `toCompact(action, lookup)` — compress current action via `Tool.toAutoClassifierInput()`
3. `buildYoloSystemPrompt(context)` — assemble system prompt (base + permissions + allow/deny)
4. Two modes: single-stage structured output / two-stage XML (`<block>yes/no</block>`)
5. `sideQuery()` to small model (haiku/sonnet) for safety classification

**Integration steps**:
1. 已有 `src/utils/permissions/yoloClassifier.ts` + `classifierShared.ts` + `classifierDecision.ts` — 需增强 sideQuery 和 prompt 模板
2. Adapt `sideQuery()` dependency
3. Hook into `permissions.ts` checkPermissions flow
4. `feature('TRANSCRIPT_CLASSIFIER')` compile-time gate

**Risk**: Heavy dependency chain (sideQuery, GrowthBook, CLAUDE.md cache loop breaking)

### 3.7 Keychain Storage (P1, from openclaude)

**3 platforms**: macOS `security` CLI / Linux libsecret / Windows DPAPI

**Key design**: 30s TTL cache + stale-while-error (return stale when fetch fails)

**ola-cc status**: Has `macOsKeychainStorage.ts` + `fallbackStorage.ts` + `plainTextStorage.ts`, missing `linuxSecretStorage.ts` + `windowsCredentialStorage.ts`

**Interface difference**: ola-cc uses key-value `get(key)/set(key, value)`, openclaude uses whole-JSON `read()/update(data)`

**Integration steps**:
1. Create `src/utils/secureStorage/linuxSecretStorage.ts`
2. Create `src/utils/secureStorage/windowsCredentialStorage.ts`
3. Modify `src/utils/secureStorage/index.ts` — add linux/windows branches

### 3.8 Provider Auto-Detect (P1, from openclaude)

**Detection priority** (first match wins):

| Priority | Provider | Detection |
|----------|----------|-----------|
| 1 | anthropic | `ANTHROPIC_API_KEY` |
| 2 | codex | `CODEX_API_KEY` / `CHATGPT_ACCOUNT_ID` / `~/.codex/auth.json` |
| 3 | github | `GITHUB_TOKEN` / `GH_TOKEN` |
| 4 | openai | `OPENAI_API_KEY` |
| 5 | gemini | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| 6-9 | mistral/minimax/xiaomi-mimo/xai | Respective API keys |
| 10 | ollama | Network probe `localhost:11434/api/tags` |
| 11 | lm-studio | Network probe `localhost:1234/v1/models` |

**Integration steps**:
1. Create `src/utils/providerAutoDetect.ts` (pure function)
2. Integrate in `src/entrypoints/cli.tsx` — call at first startup
3. Integrate in `src/setup.ts` — apply when no explicit provider config

---

## 4. Dynamic Workflows (from claude-code-best)

### 4.1 Architecture

claude-code's Workflow is a **Markdown/YAML DSL task orchestration system**, completely different from ola-cc's existing DAG-based workflow.

| Dimension | claude-code | ola-cc (existing) |
|-----------|-------------|-------------------|
| DSL format | Markdown + YAML frontmatter | TypeScript DAG definition |
| Execution engine | Step-by-step LLM-driven | Topological sort DAG execution |
| State persistence | `.claude/workflow-runs/*.json` | Memory |
| Permission control | `/workflows approve <id>` | None |

### 4.2 Workflow File Format

```yaml
---
name: deploy-pipeline
description: "Deploy workflow"
permissions:
  bash: "allow"
  file_edit: "ask"
  web_fetch: "deny"
---

# Deploy Pipeline

## Step 1: Build
Run `npm run build` and verify no errors.

## Step 2: Test
Run `npm test` and ensure all tests pass.

## Step 3: Deploy
[requires approval]
Deploy to production with `npm run deploy`.
```

### 4.3 WorkflowTool 5 Actions

| Action | Function |
|--------|----------|
| `start` | Parse Markdown, create workflow, start first step |
| `advance` | Mark current step complete, LLM executes next step |
| `status` | Query run status |
| `cancel` | Cancel run |
| `list` | List available workflow templates |

### 4.4 Files to Modify (14)

| File | Operation |
|------|-----------|
| `src/tools/WorkflowTool/WorkflowTool.ts` | **Rewrite** — replace with step-by-step engine |
| `src/tools/WorkflowTool/constants.ts` | **Extend** — add directory/extension constants |
| `src/tools/WorkflowTool/createWorkflowCommand.ts` | **Rewrite** — slash command generator |
| `src/tools/WorkflowTool/WorkflowPermissionRequest.tsx` | **Rewrite** — permission UI |
| `src/tools/WorkflowTool/workflowTypes.ts` | **Delete** — DAG types no longer needed |
| `src/utils/workflowRuns.ts` | **New** — run record persistence |
| `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` | **Rewrite** — background task |
| `src/components/tasks/WorkflowDetailDialog.tsx` | **Rewrite** — detail UI |
| `src/commands/workflows/index.ts` | **Rewrite** — /workflows command |
| `src/tools.ts` | **Adjust** — feature gate |
| `scripts/build.ts` | **已有** — `WORKFLOW_SCRIPTS` flag（确认启用） |

---

## 5. Ultra Series (from claude-code-best)

### 5.1 Ultrathink — Fully Ported

**Status**: 100% ported. Minor differences:
- `thinking.ts` missing `opus-4-7` model support

### 5.2 Ultraplan — Mostly Ported, 3 Key Gaps

| Ported | Missing |
|--------|---------|
| keyword.ts (keyword detection) | **prompt.ts** (3 prompt templates + GrowthBook dynamic selection) |
| ccrSession.ts (remote session polling) | **UltraplanChoiceDialog.tsx** |
| commands/ultraplan.tsx (command entry) | **UltraplanLaunchDialog.tsx** |
| RemoteAgentTask.tsx (background task) | prompt.txt content is placeholder |

### 5.3 Ultrareview — Fully Ported

Only missing `ultrareviewPreflight.ts` (pre-check).

### 5.4 Effort System — Missing `xhigh` Level

| Feature | claude-code | ola-cc |
|---------|-------------|--------|
| EFFORT_LEVELS | low/medium/high/**xhigh**/max | low/medium/high/max |
| modelSupportsXhighEffort() | Present | Missing |
| modelSupportsMaxEffort() | Generic true | Opus 4.6 only |
| opus-4-7 support | Present | Missing |
| deepseek-v4-pro support | Present | Missing |

**Files to modify**:
- `src/utils/effort.ts` — add xhigh + model support
- `src/commands/effort/effort.tsx` — update help text
- `src/components/EffortIndicator.ts` — add EFFORT_XHIGH symbol
- `src/constants/figures.ts` — add EFFORT_XHIGH constant
- `src/utils/thinking.ts` — fix import + add opus-4-7

---

## 6. Corrections to Previous Report

| Previous Claim | Actual Status |
|----------------|---------------|
| ToolRegistry has O(1) lookup | **Both use O(n) linear scan**, neither has ToolRegistry class |
| ResourceQuotaManager from claude-code | **Only ola-cc has it**, claude-code uses distributed providerUsage |
| CompactProgressEvent claude-code has 4 stages | **claude-code only has 3 stages**, ola-cc has 4 (more complete) |
| logCpuDiag from claude-code | **Neither project has it** |

---

## 热点文件修改协调

以下源文件被多份设计文档声明需要修改，实施时需按顺序合并：

| 热点文件 | 修改来源 | 建议实施顺序 | 冲突解决 |
|---------|---------|-------------|---------|
| `src/query.ts` | Performance Optimization (§3 增量 Token), Context UX (§3 Context Collapse), Dynamic Workflows (§5 WorkflowTool) | 1. IncrementalTokenCounter → 2. Context Collapse → 3. WorkflowTool | 各功能修改 query.ts 的不同函数，按 Phase 分批合入 |
| `src/services/compact/compact.ts` | Performance Optimization (§5 Cached Microcompact), Context UX (§3 Context Collapse), Quality Reliability (§1 AutoFix) | 1. AutoFix hook → 2. Cached Microcompact → 3. Context Collapse | AutoFix 通过 hook 注入不修改 compact 本体；CachedMC 和 Collapse 修改不同函数 |
| `src/services/tools/toolExecution.ts` | Quality Reliability (§1 AutoFix), Performance Optimization (§9 Tool Result Persistence) | 1. AutoFix → 2. Tool Result Persistence | AutoFix 在 tool 执行后 hook；Persistence 在 result 返回前 hook，两者不冲突 |
| `src/services/api/claude.ts` | Performance Optimization (§2 Tool Schema Cache), Langfuse Tracing (§3) | 1. Langfuse → 2. Tool Schema Cache | Langfuse 添加 tracing wrapper；Schema Cache 修改 schema 构建，不同位置 |
| `src/tools/AgentTool/AgentTool.tsx` | Agent Routing (§1), Agent Intelligence - Delegation Enforcer (§6), Autopilot Pipeline (§2) | 1. Agent Routing model override → 2. Delegation Enforcer forceInherit → 3. Autopilot phase adapter | 各功能修改 AgentTool 的不同 hook 点：Routing 在 model selection，Delegation 在 context creation，Autopilot 在 phase transition |

### 热点文件代码骨架

#### `src/query.ts` 修改示例

```typescript
// 现有 import 区域（第 18-24 行附近）— 添加 feature gate
const incrementalToken = feature("INCREMENTAL_TOKEN")
  ? (require("./utils/incrementalTokenCounter.js") as typeof import("./utils/incrementalTokenCounter.js"))
  : null;
const smartRouting = feature("SMART_MODEL_ROUTING")
  ? (require("./services/api/smartModelRouting.js") as typeof import("./services/api/smartModelRouting.js"))
  : null;

// QueryParams 扩展（第 302 行附近）
export type QueryParams = {
  // ... existing fields ...
  incrementalTokenState?: IncrementalTokenState; // 新增：增量 token 计数状态
  smartRoutingConfig?: SmartRoutingConfig;        // 新增：智能路由配置
};

// queryLoop 内部（第 373 行附近）— 在 API 调用前插入
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<...> {
  // ... existing setup ...
  const tokenCounter = incrementalToken?.createIncrementalTokenState();

  while (/* loop condition */) {
    // --- 增量 Token 计数（Performance Optimization §3）---
    const tokenDelta = tokenCounter
      ? incrementalToken!.computeDelta(tokenCounter, state.messages)
      : undefined;

    // --- 智能路由（Agent Routing §3.4）---
    const effectiveModel = smartRouting && params.smartRoutingConfig?.enabled
      ? smartRouting.routeMessage(state.messages, params.smartRoutingConfig)
      : undefined; // undefined = 使用默认 model

    // --- 现有 API 调用 ---
    const response = yield* deps.apiCall({
      // ... existing params ...
      model: effectiveModel ?? state.toolUseContext.model,
      tokenDelta, // 透传增量 token 信息
    });

    // --- Context Collapse hook（Context UX §3）---
    if (contextCollapse && shouldCollapseContext(state.messages)) {
      state = { ...state, messages: contextCollapse.collapseMessages(state.messages) };
    }
  }
}
```

#### `src/services/api/claude.ts` 修改示例

```typescript
// Langfuse tracing 集成点（§3.1）— 在 API 调用包装器中
import { feature } from 'bun:bundle';
const langfuse = feature('LANGFUSE_TRACING')
  ? (require('./langfuse/tracing.js') as typeof import('./langfuse/tracing.js'))
  : null;

// 在 apiCall 函数中
async function apiCall(params: ApiCallParams) {
  const trace = langfuse?.createTrace({ name: 'api-call', ... });
  try {
    const generation = trace ? langfuse!.recordLLMObservation(trace, params) : undefined;
    const response = await client.messages.create(params);
    generation?.end({ output: response });
    return response;
  } catch (err) {
    generation?.end({ error: err });
    throw err;
  } finally {
    await langfuse?.flushLangfuse();
  }
}
```

#### `src/tools/AgentTool/AgentTool.tsx` 修改示例

```typescript
// Agent Routing 集成点 — 在 model 选择处
const agentRouting = feature('AGENT_ROUTING')
  ? (require('../../services/api/agentRouting.js') as typeof import('../../services/api/agentRouting.js'))
  : null;

// 在 AgentTool.call() 内部
const resolvedModel = agentRouting
  ? agentRouting.resolveAgentRunModelRouting({
      toolSpecifiedModel: input.model,
      agentName: agent.name,
      subagentType: agent.subagentType,
      settings: toolUseContext.settings,
    })
  : undefined;

// Delegation Enforcer 集成点 — 在 context 创建处
const delegationEnforcer = feature('DELEGATION_ENFORCER')
  ? (require('../../services/delegation-enforcer/index.js') as typeof import('../../services/delegation-enforcer/index.js'))
  : null;

const agentContext = delegationEnforcer?.shouldForceInherit(parentModel)
  ? createSubagentContext({ ...baseOpts, forceInherit: true })
  : createSubagentContext(baseOpts);
```

### Agent 模型选择决策树

当 Agent Routing、Delegation Enforcer、Smart Routing 同时启用时，按以下优先级决策：

1. **Agent Routing** (`OLA_CC_AGENT_ROUTING`): 最高优先级。`resolveAgentRunModelRouting()` 的 5 级优先链决定 base model
2. **Delegation Enforcer** (`OLA_CC_DELEGATION_ENFORCER`): 中优先级。在 Agent Routing 选定 model 后，检查是否需要 `forceInherit`（非 Claude parent model 场景）
3. **Smart Routing** (`OLA_CC_SMART_ROUTING`): 最低优先级。仅在无 Agent Routing 覆盖时，根据消息复杂度选择 model

冲突解决：当三者建议不同 model 时，Agent Routing > Delegation Enforcer > Smart Routing > 默认 model。

### Goal 熔断 vs Continuation Enforcement

Goal 系统的 dead-turn 熔断（连续 N 轮无进展自动停止）与 Continuation Enforcement 的 "NEVER STOPS" 哲学存在冲突。协调规则：

- **Goal 熔断优先**: 当 Goal 系统判定 dead-turn 并触发熔断时，Continuation Enforcement 应尊重熔断决策，不注入继续提醒
- **检测方式**: Continuation 检查 `GoalState.circuitBreakerTriggered` 标志，若为 true 则跳过 continuation 注入
- **用户覆盖**: 用户可通过 `/cancel` 手动停止，两者均尊重

---

## 7. Implementation Roadmap

### Phase 1 — Fixes + Quick Wins (1 week)

| # | Feature | Source | Effort | Files |
|---|---------|--------|--------|-------|
| 1 | Fix thinking.ts import error | — | XS | 1 file |
| 2 | Add xhigh effort level | claude-code | S | 4 files |
| 3 | Restore meetsAvailabilityRequirement | claude-code | XS | 1 file |
| 4 | GrowthBook LOCAL_GATE_DEFAULTS | claude-code | S | 1 file |
| 5 | AutoDream null safety fix | — | XS | 1 file |

### Phase 2 — Core Features (2-3 weeks)

| # | Feature | Source | Effort | Files |
|---|---------|--------|--------|-------|
| 6 | Ultraplan prompt templates + UI | claude-code | M | 3 new + 2 modified |
| 7 | Langfuse tracing | claude-code | M | 4 new + 4 modified + 3 deps |
| 8 | LSP 12 tools | oh-my-claudecode | M | 3 new + 2 modified |
| 9 | Agent Routing | openclaude | M | 2 new + 3 modified |
| 10 | Smart Model Routing | openclaude | M | 3 new + 2 modified |
| 11 | Provider Auto-Detect | openclaude | S | 1 new + 1 modified |

### Phase 3a — Security (2-3 weeks)

| # | Feature | Source | Effort | Files |
|---|---------|--------|--------|-------|
| 12 | yoloClassifier | claude-code | L | 5+ new + 3 modified |
| 13 | SSRF Guard | openclaude | S | 1 new |
| 14 | Secret Scanner | openclaude | S | 1 new |
| 15 | Keychain linux/windows | openclaude | S | 2 new + 1 modified |
| 16 | LocalVault AES-256-GCM | claude-code | M | 2 new + 1 modified |

### Phase 3b — Ecosystem (3-4 weeks)

| # | Feature | Source | Effort | Files |
|---|---------|--------|--------|-------|
| 17 | ACP Protocol | claude-code | L | 6 new + 1 dep |
| 18 | providerUsage subsystem | claude-code | M | 5+ new |
| 19 | GitHub Copilot provider | openclaude | M | 3 new + 3 modified |
| 20 | Gemini provider | openclaude | M | 2 new + 3 modified |
| 21 | Learner auto-skill extraction | oh-my-claudecode | M | 3 new |
| 22 | Notepad 3-zone memory | oh-my-claudecode | M | 2 new |
| 23 | Dynamic Workflows | claude-code | L | 14 files rewrite |

---

## 7.1 LOC 估算总表

按子系统分组，引用各专项文档的 LOC 估算。

| Phase | # | 子系统 | 新增文件 | 新增 LOC | 修改文件 | 修改 LOC | 总 LOC | 专项文档 |
|-------|---|--------|---------|----------|---------|----------|--------|---------|
| P1 | 1 | thinking.ts 修复 + xhigh effort | 0 | 0 | 5 | ~80 | ~80 | `ultra-series-design.md` |
| P1 | 2 | meetsAvailabilityRequirement | 0 | 0 | 1 | ~10 | ~10 | — |
| P1 | 3 | GrowthBook LOCAL_DEFAULTS | 0 | 0 | 1 | ~60 | ~60 | — |
| P1 | 4 | AutoDream null safety | 0 | 0 | 1 | ~5 | ~5 | — |
| P2 | 5 | Ultraplan prompt + UI | 3 | ~400 | 2 | ~80 | ~480 | `ultra-series-design.md` |
| P2 | 6 | Langfuse Tracing | 4 | ~800 | 4 | ~120 | ~920 | `langfuse-tracing-design.md` |
| P2 | 7 | LSP 12 Tools | 3 | ~600 | 2 | ~50 | ~650 | `lsp-tools-design.md` |
| P2 | 8 | Agent Routing | 2 | ~350 | 3 | ~80 | ~430 | `agent-routing-smart-routing-design.md` |
| P2 | 9 | Smart Model Routing | 3 | ~300 | 2 | ~60 | ~360 | `agent-routing-smart-routing-design.md` |
| P2 | 10 | Provider Auto-Detect | 1 | ~150 | 1 | ~30 | ~180 | — |
| P3a | 11 | yoloClassifier 增强 | 5 | ~700 | 3 | ~100 | ~800 | `yolo-classifier-design.md` |
| P3a | 12 | SSRF Guard | 1 | ~200 | 0 | 0 | ~200 | `security-hardening-design.md` |
| P3a | 13 | Secret Scanner | 1 | ~180 | 0 | 0 | ~180 | `security-hardening-design.md` |
| P3a | 14 | Keychain linux/windows | 2 | ~250 | 1 | ~40 | ~290 | — |
| P3a | 15 | LocalVault AES-256-GCM | 2 | ~600 | 1 | ~30 | ~630 | `acp-vault-design.md` |
| P3b | 16 | ACP Protocol | 6 | ~2740 | 0 | 0 | ~2740 | `acp-vault-design.md` |
| P3b | 17 | providerUsage | 5 | ~500 | 0 | 0 | ~500 | — |
| P3b | 18 | GitHub Copilot provider | 3 | ~400 | 3 | ~80 | ~480 | `provider-extension-design.md` |
| P3b | 19 | Gemini provider | 2 | ~350 | 3 | ~80 | ~430 | `provider-extension-design.md` |
| P3b | 20 | Learner auto-skill | 3 | ~500 | 0 | 0 | ~500 | `oh-my-claudecode-features-design.md` |
| P3b | 21 | Notepad 3-zone | 2 | ~300 | 0 | 0 | ~300 | `oh-my-claudecode-features-design.md` |
| P3b | 22 | Dynamic Workflows | 1 | ~400 | 13 | ~800 | ~1200 | `dynamic-workflows-design.md` |
| — | — | **合计** | **46** | **~8,700** | **45** | **~1,665** | **~10,365** | — |

**注意**: 上表不含 UX Enhancements（5100 LOC，独立设计文档）和 Infrastructure Hardening（独立设计文档）。

---

## 7.2 Phase 依赖图

Phase 之间存在严格依赖关系，必须按序执行；Phase 内部任务可并行。

```
Phase 1 (Quick Wins, 1 week)
├── [1] thinking.ts 修复 ─────────────┐
├── [2] xhigh effort ─────────────────┤
├── [3] meetsAvailabilityRequirement ──┤  ← 无相互依赖，可并行
├── [4] GrowthBook LOCAL_DEFAULTS ─────┤
└── [5] AutoDream null safety ─────────┘
        │
        ▼
Phase 2 (Core Features, 2-3 weeks)
├── [6] Ultraplan ────────────────────┐
├── [7] Langfuse ─────────────────────┤
├── [8] Agent Routing ────────────────┤  ← 无相互依赖，可并行
├── [9] Smart Routing ────────────────┤     但 [9] 依赖 [8] 的 agentRouting.ts
│        └── depends: [8]             │
├── [10] Provider Auto-Detect ────────┘
│
│  Phase 2 Gate: 所有 Core Features 完成后进入 Phase 3
│
├──────────────────────────────────────────┐
▼                                          ▼
Phase 3a (Security, 2-3 weeks)    Phase 3b (Ecosystem, 3-4 weeks)
├── [11] yoloClassifier ──────────┐ ├── [16] ACP Protocol
│   depends: [4] GrowthBook       │ ├── [17] providerUsage
├── [12] SSRF Guard ──────────────┤ ├── [18] GitHub Copilot
├── [13] Secret Scanner ──────────┤ │   depends: [8] Agent Routing
├── [14] Keychain linux/win ──────┤ ├── [19] Gemini
├── [15] LocalVault ──────────────┘ ├── [20] Learner
│   depends: [16] ACP (shared code)│ ├── [21] Notepad
│                                  │ └── [22] Dynamic Workflows
│  3a 与 3b 可并行                  │     depends: [4] GrowthBook
└──────────────────────────────────┘
```

**关键依赖说明**:

| 依赖 | 原因 |
|------|------|
| Phase 2 → Phase 1 | GrowthBook LOCAL_DEFAULTS 是 yoloClassifier 和 Langfuse 的运行时依赖 |
| Smart Routing → Agent Routing | 共享 `src/services/api/agentRouting.ts` 基础设施 |
| yoloClassifier → GrowthBook | 分类器使用 GrowthBook 特性开关控制模型选择 |
| Dynamic Workflows → GrowthBook | Workflow 审批 UI 使用 GrowthBook 控制 |
| LocalVault → ACP | 共享加密基础设施（`@opentelemetry` 依赖链） |
| GitHub Copilot → Agent Routing | provider 配置通过 agentRouting 注入 |
| Phase 3a ∥ Phase 3b | 安全和生态无交叉依赖，可并行开发 |

---

## 8. Key File Paths Reference

### claude-code-best (source)
- `src/services/langfuse/` — Langfuse tracing (4 files)
- `src/services/acp/` — ACP protocol (5 files)
- `src/services/autoDream/` — AutoDream (4 files)
- `src/services/analytics/growthbook.ts` — GrowthBook with LOCAL_GATE_DEFAULTS
- `src/utils/permissions/yoloClassifier.ts` — Safety classifier
- `src/utils/effort.ts` — Effort system (5 levels)
- `src/utils/thinking.ts` — Adaptive thinking
- `src/utils/ultraplan/` — Ultraplan utilities
- `src/commands/review/` — Ultrareview
- `packages/builtin-tools/src/tools/WorkflowTool/` — Dynamic Workflows
- `src/utils/workflowRuns.ts` — Workflow run persistence
- `src/tasks/LocalWorkflowTask/` — Workflow background task
- `src/commands.ts` — meetsAvailabilityRequirement

### openclaude (source)
- `src/services/api/agentRouting.ts` — Agent routing
- `src/services/api/smartModelRouting.ts` — Smart model routing
- `src/services/api/providerConfig.ts` — GitHub Copilot + Gemini config
- `src/services/api/openaiShim.ts` — Enhanced OpenAI shim (Gemini body, responses API)
- `src/utils/secureStorage/` — Keychain storage (9 files)
- `src/utils/providerAutoDetect.ts` — Provider auto-detection

### oh-my-claudecode (source)
- `src/tools/lsp-tools.ts` — LSP 12 tools
- `src/hooks/ralph/` — Ralph PRD system (prd.ts, progress.ts, verifier.ts)
- `src/features/model-routing/` — Model routing (signals.ts, scorer.ts, rules.ts)
- `src/hooks/learner/` — Learner auto-skill extraction (detector.ts, auto-learner.ts, validator.ts)
- `src/hooks/notepad/` — Notepad 3-zone memory
- `src/tools/ast-tools.ts` — AST tools with meta-variables

### ola-cc (target)
- `src/services/api/client.ts` — API client factory
- `src/services/api/openai.ts` — OpenAI-compatible adapter
- `src/services/api/claude.ts` — Anthropic SDK client
- `src/services/analytics/growthbook.ts` — GrowthBook integration
- `src/utils/model/providers.ts` — Provider detection
- `src/utils/model/agent.ts` — Sub-agent model selection
- `src/utils/effort.ts` — Effort system
- `src/utils/thinking.ts` — Adaptive thinking
- `src/utils/settings/types.ts` — Settings schema
- `src/tools/AgentTool/AgentTool.tsx` — Agent tool
- `src/tools.ts` — Tool registration
- `src/commands.ts` — Command registration
- `src/QueryEngine.ts` — Agentic loop orchestrator
- `src/query.ts` — API query logic
- `src/state/store.ts` — State management
- `src/Tool.ts` — Tool interface
- `scripts/build.ts` — Build script

---

## 9. ola-cc 独有优势（不可替代）

*来源: 源码级实现对比分析*

| 优势 | 说明 | 核心文件 |
|------|------|---------|
| ASAEF 进化系统 | 8 阶段确定性状态机 + L1→L2→L3 分层推进 | `EvolutionEngine.ts` |
| Goal 系统 | ReAct 目标编排 + 三层熔断 + 收敛检测 | `src/commands/goal/` |
| SingularityTool | 34 个 API 操作（评分/遥测/注册表/门控/审计） | `src/tools/SingularityTool/` |
| compactModelRouter | 智能压缩模型路由 | `src/services/compact/` |
| 5 种 Compact 策略 | auto/micro/session/snipe/reactive | `src/services/compact/` |
| NATS 事件总线 | 可选分布式事件 + 内存 Fallback | `src/services/eventBus/` |
| A2UI 协议 | 状态机 + 熔断器 | `src/tools/A2UITool/` |
| CodeGraph | 代码图谱分析 | `src/tools/CodegraphTool/` |
| process-diagnostic | 19 源文件 + 12 测试进程诊断 | `src/services/process-diagnostic/` |
| toolRanker BM25 | 渐进式工具排名省 22% token | `src/services/api/toolRanker.ts` |

---

## 10. 关键源文件索引（四项目）

*来源: 源码级实现对比分析*

### claude-code

| 文件 | 功能 |
|------|------|
| `src/services/extractMemories/extractMemories.ts` | 自动记忆提取 |
| `src/services/autoDream/autoDream.ts` | 后台记忆整合 |
| `src/services/SessionMemory/sessionMemory.ts` | 会话摘要 |
| `src/services/localVault/localVault.ts` | AES-256-GCM 加密存储 |
| `src/services/langfuse/` | Langfuse 可观测性 |
| `src/services/acp/` | ACP 协议 |
| `src/tools/ToolSearchTool/` | 渐进式工具发现 |
| `src/services/api/promptCacheBreakDetection.ts` | 缓存断裂检测 |

### openclaude

| 文件 | 功能 |
|------|------|
| `src/services/api/compressToolHistory.ts` | 三级工具压缩 |
| `src/utils/incrementalTokenCounter.ts` | SHA-256 增量计数 |
| `src/services/api/thinkTagSanitizer.ts` | 推理标签清理 |
| `src/services/api/openaiErrorClassification.ts` | 14 类错误分类 |
| `src/utils/hooks/ssrfGuard.ts` | SSRF 防护 |
| `src/services/teamMemorySync/secretScanner.ts` | 凭据扫描 |
| `src/utils/urlRedaction.ts` | URL 脱敏 |
| `src/tools/AgentTool/agentMemory.ts` | 三作用域记忆 |

### oh-my-claudecode

| 文件 | 功能 |
|------|------|
| `src/features/magic-keywords.ts` | Magic Keywords |
| `src/hooks/autopilot/pipeline.ts` | Autopilot 管线 |
| `src/features/session-history-search/index.ts` | 会话历史搜索 |
| `src/features/model-routing/router.ts` | 智能模型路由 |
| `src/hooks/notepad/index.ts` | Notepad 三层记忆 |
| `src/features/continuation-enforcement.ts` | 续行强制 |
| `src/features/delegation-enforcer.ts` | 委派强制 |
| `src/hooks/codebase-map.ts` | 代码库地图 |
| `src/hooks/factcheck/index.ts` | 事实核查 |
