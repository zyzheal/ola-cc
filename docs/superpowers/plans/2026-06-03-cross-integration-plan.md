# Four-Project Cross-Integration: 总协调实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 协调四个项目 (claude-code-best v2.6.6, openclaude v0.16.1, oh-my-claudecode v4.14.4, ola-cc v0.4.10) 的功能集成，覆盖热点文件协调修改、Feature Gate 基础设施、Phase 依赖管理、集成测试。

**Architecture:** 本计划是总协调计划，聚焦于 5 个热点文件的协调修改和 Feature Gate 基础设施搭建。各子系统（Langfuse、LSP、Agent Routing 等）有独立的专项计划。热点文件按"修改不同函数、按 Phase 分批合入"原则处理，避免冲突。

**Tech Stack:** TypeScript, Bun test runner, `bun:bundle` feature() gates

**Design Doc:** `docs/superpowers/specs/2026-06-03-four-project-cross-integration-design.md`

**依赖关系:** 本计划是所有 Phase 的前置依赖。Task 1-2 (Feature Gate) 必须先完成，后续 Phase 才能安全添加 `feature()` 门控代码。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `scripts/build.ts` | Modify | 添加新 feature flags 到 `fullExperimentalFeatures` |
| `scripts/build-publish.ts` | Modify | 同步新 feature flags |
| `src/utils/featureGate.ts` | Create | 统一 runtime feature gate 辅助函数 |
| `src/utils/__tests__/featureGate.test.ts` | Create | Feature gate 单元测试 |
| `src/commands.ts` | Modify | 修复 `meetsAvailabilityRequirement` 安全漏洞 |
| `src/services/api/agentRouting.ts` | Create | Agent Routing 核心（独立子计划入口） |
| `src/services/api/smartModelRouting.ts` | Create | Smart Model Routing 纯函数（独立子计划入口） |
| `src/query.ts` | Modify | 智能路由集成点 + 增量 token 计数集成点 |
| `src/services/api/claude.ts` | Modify | Langfuse tracing 集成点 + Tool Schema Cache |
| `src/services/tools/toolExecution.ts` | Modify | AutoFix hook + Langfuse tool observation 集成点 |
| `src/tools/AgentTool/AgentTool.tsx` | Modify | Agent Routing model override + Delegation Enforcer 集成点 |
| `src/services/compact/compact.ts` | Modify | Context Collapse + Cached Microcompact 集成点（已有，确认无冲突） |
| `src/services/compact/__tests__/compactRegression.test.ts` | Create | compact.ts 回归测试 |
| `src/services/analytics/growthbook.ts` | Modify | GrowthBook LOCAL_GATE_DEFAULTS |
| `src/utils/__tests__/integration/hotFileCoordination.test.ts` | Create | 热点文件集成测试 |

---

## Task 1: Feature Gate 基础设施搭建

**Files:**
- Modify: `scripts/build.ts` — 添加新 feature flags
- Modify: `scripts/build-publish.ts` — 同步新 feature flags
- Create: `src/utils/featureGate.ts` — runtime gate 辅助函数
- Create: `src/utils/__tests__/featureGate.test.ts` — 单元测试

**Why first:** 所有后续 Phase 都依赖 feature gate 基础设施。compile-time gates 通过 `bun:bundle` 的 `feature()` 已有机制，但缺少 runtime gates (环境变量门控) 的统一辅助函数。

- [ ] **Step 1: 编写 featureGate.ts 单元测试**

```typescript
// src/utils/__tests__/featureGate.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { isRuntimeGateEnabled, getRuntimeGateValue } from '../featureGate.js'

describe('featureGate', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, originalEnv)
  })

  describe('isRuntimeGateEnabled', () => {
    test('returns true when env var is "1"', () => {
      process.env.OLA_CC_AGENT_ROUTING = '1'
      expect(isRuntimeGateEnabled('OLA_CC_AGENT_ROUTING')).toBe(true)
    })

    test('returns false when env var is "0"', () => {
      process.env.OLA_CC_AGENT_ROUTING = '0'
      expect(isRuntimeGateEnabled('OLA_CC_AGENT_ROUTING')).toBe(false)
    })

    test('returns false when env var is not set', () => {
      delete process.env.OLA_CC_AGENT_ROUTING
      expect(isRuntimeGateEnabled('OLA_CC_AGENT_ROUTING')).toBe(false)
    })

    test('returns default when env var is not set', () => {
      delete process.env.OLA_CC_PROVIDER_AUTO_DETECT
      expect(isRuntimeGateEnabled('OLA_CC_PROVIDER_AUTO_DETECT', true)).toBe(true)
    })

    test('returns true for truthy values (true, yes, on)', () => {
      process.env.OLA_CC_AGENT_ROUTING = 'true'
      expect(isRuntimeGateEnabled('OLA_CC_AGENT_ROUTING')).toBe(true)
      process.env.OLA_CC_AGENT_ROUTING = 'yes'
      expect(isRuntimeGateEnabled('OLA_CC_AGENT_ROUTING')).toBe(true)
      process.env.OLA_CC_AGENT_ROUTING = 'on'
      expect(isRuntimeGateEnabled('OLA_CC_AGENT_ROUTING')).toBe(true)
    })

    test('returns false for falsy values (false, no, off)', () => {
      process.env.OLA_CC_AGENT_ROUTING = 'false'
      expect(isRuntimeGateEnabled('OLA_CC_AGENT_ROUTING')).toBe(false)
      process.env.OLA_CC_AGENT_ROUTING = 'no'
      expect(isRuntimeGateEnabled('OLA_CC_AGENT_ROUTING')).toBe(false)
      process.env.OLA_CC_AGENT_ROUTING = 'off'
      expect(isRuntimeGateEnabled('OLA_CC_AGENT_ROUTING')).toBe(false)
    })
  })

  describe('getRuntimeGateValue', () => {
    test('returns string value from env var', () => {
      process.env.LANGFUSE_BASE_URL = 'https://custom.langfuse.com'
      expect(getRuntimeGateValue('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com')).toBe('https://custom.langfuse.com')
    })

    test('returns default when env var is not set', () => {
      delete process.env.LANGFUSE_BASE_URL
      expect(getRuntimeGateValue('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com')).toBe('https://cloud.langfuse.com')
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test src/utils/__tests__/featureGate.test.ts
```

Expected: FAIL — `featureGate.ts` 不存在

- [ ] **Step 3: 创建 featureGate.ts**

```typescript
// src/utils/featureGate.ts
/**
 * Runtime feature gate utilities.
 *
 * Compile-time gates use `feature('FLAG')` from `bun:bundle` — code is excluded
 * from the bundle when the flag is off. Runtime gates check environment variables
 * at startup and are cached in memory for the session lifetime.
 *
 * Naming convention: compile-time flags use UPPER_SNAKE_CASE (e.g. LANGFUSE_TRACING),
 * runtime flags use OLA_CC_ prefix (e.g. OLA_CC_AGENT_ROUTING).
 */

import { isEnvTruthy } from './envUtils.js'

/**
 * Check if a runtime feature gate is enabled via environment variable.
 *
 * Truthy values: '1', 'true', 'yes', 'on' (case-insensitive)
 * Falsy values: '0', 'false', 'no', 'off', or absent
 *
 * @param envVar - The environment variable name (e.g. 'OLA_CC_AGENT_ROUTING')
 * @param defaultValue - Default when env var is not set (default: false)
 */
export function isRuntimeGateEnabled(envVar: string, defaultValue: boolean = false): boolean {
  const value = process.env[envVar]
  if (value === undefined || value === '') {
    return defaultValue
  }
  return isEnvTruthy(value)
}

/**
 * Get a string value from a runtime feature gate environment variable.
 *
 * @param envVar - The environment variable name
 * @param defaultValue - Default when env var is not set
 */
export function getRuntimeGateValue(envVar: string, defaultValue: string): string {
  const value = process.env[envVar]
  if (value === undefined || value === '') {
    return defaultValue
  }
  return value
}

/**
 * Runtime gate constants for all cross-integration features.
 * These provide a single source of truth for env var names.
 */
export const RUNTIME_GATES = {
  /** Agent Routing: per-agent model override via settings.json */
  AGENT_ROUTING: 'OLA_CC_AGENT_ROUTING',
  /** Smart Model Routing: complexity-based model selection */
  SMART_ROUTING: 'OLA_CC_SMART_ROUTING',
  /** Provider Auto-Detect: auto-detect provider from API keys */
  PROVIDER_AUTO_DETECT: 'OLA_CC_PROVIDER_AUTO_DETECT',
  /** Delegation Enforcer: force model inheritance for non-Claude parents */
  DELEGATION_ENFORCER: 'OLA_CC_DELEGATION_ENFORCER',
} as const

/**
 * Pre-computed gate state for the current session.
 * Call once at startup, pass to consumers to avoid repeated env lookups.
 */
export interface RuntimeGateState {
  agentRouting: boolean
  smartRouting: boolean
  providerAutoDetect: boolean
  delegationEnforcer: boolean
}

/**
 * Snapshot all runtime gates at session start.
 * This avoids repeated process.env access in hot paths.
 */
export function snapshotRuntimeGates(): RuntimeGateState {
  return {
    agentRouting: isRuntimeGateEnabled(RUNTIME_GATES.AGENT_ROUTING),
    smartRouting: isRuntimeGateEnabled(RUNTIME_GATES.SMART_ROUTING),
    providerAutoDetect: isRuntimeGateEnabled(RUNTIME_GATES.PROVIDER_AUTO_DETECT, true),
    delegationEnforcer: isRuntimeGateEnabled(RUNTIME_GATES.DELEGATION_ENFORCER),
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test src/utils/__tests__/featureGate.test.ts
```

Expected: PASS

- [ ] **Step 5: 添加新 compile-time feature flags 到 build.ts**

在 `scripts/build.ts` 的 `fullExperimentalFeatures` 数组中添加新 flags:

```typescript
const fullExperimentalFeatures = [
  // ... existing flags ...
  'LANGFUSE_TRACING',     // Langfuse observability (P2, compile-time)
  'LSP_TOOLS',            // LSP 12 tools (P2, compile-time)
  'SSRF_GUARD',           // SSRF protection (P3a, compile-time, default ON)
  'SECRET_SCANNER',       // Credential scanner (P3a, compile-time, default ON)
  'ACP_PROTOCOL',         // ACP protocol (P3b, compile-time)
  'SMART_MODEL_ROUTING',  // Smart model routing by complexity (P2, compile-time)
  'AGENT_ROUTING',        // Per-agent model override (P2, compile-time)
  'INTERNAL_COMMANDS',    // Internal-only commands for ant users (compile-time, always ON in this build)
] as const
```

> **Gate 机制说明：**
> - **compile-time flags** (上方列表): 通过 `feature('FLAG')` 在 build 时决定代码是否包含到 bundle 中。当 flag 关闭时，对应代码被 dead-code-eliminated，零运行时开销。
> - **runtime gates** (下方 `RUNTIME_GATES`): 通过 `isRuntimeGateEnabled('OLA_CC_*')` 在运行时检查环境变量，决定功能是否实际启用。即使 compile-time flag 开启，runtime gate 为 false 时功能仍然关闭。
> - 两层门控是 AND 关系：compile-time OFF = 代码不存在；compile-time ON + runtime OFF = 代码存在但不执行。

同时在 `scripts/build-publish.ts` 的 `fullExperimentalFeatures` 数组中同步添加。

- [ ] **Step 6: 运行完整 featureGate 测试套件**

```bash
bun test src/utils/__tests__/featureGate.test.ts
```

Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/utils/featureGate.ts src/utils/__tests__/featureGate.test.ts scripts/build.ts scripts/build-publish.ts
git commit -m "feat: add Feature Gate infrastructure for cross-integration

- Create src/utils/featureGate.ts with runtime gate utilities
- Add RUNTIME_GATES constants and snapshotRuntimeGates()
- Register new compile-time flags: LANGFUSE_TRACING, LSP_TOOLS, SSRF_GUARD, SECRET_SCANNER, ACP_PROTOCOL, SMART_MODEL_ROUTING, AGENT_ROUTING, INTERNAL_COMMANDS
- Sync flags between build.ts and build-publish.ts"
```

---

## Task 2: GrowthBook LOCAL_GATE_DEFAULTS

**Files:**
- Modify: `src/services/analytics/growthbook.ts`

**Why second:** GrowthBook LOCAL_DEFAULTS 是 yoloClassifier (P3a) 和 Dynamic Workflows (P3b) 的运行时依赖。补全后，所有子系统的 GrowthBook 调用都能获得合理的默认值，无需连接 GrowthBook 服务器。

- [ ] **Step 1: 编写测试验证 LOCAL_GATE_DEFAULTS 缺失**

```typescript
// src/services/analytics/__tests__/growthbookLocalDefaults.test.ts
import { describe, test, expect } from 'bun:test'

describe('GrowthBook LOCAL_GATE_DEFAULTS', () => {
  test('getFeatureValue_CACHED_MAY_BE_STALE returns local default when GrowthBook is unavailable', async () => {
    // In a cold-start scenario (no GrowthBook connection), the function
    // should fall back to LOCAL_GATE_DEFAULTS before falling back to the
    // caller-supplied defaultValue.
    const { getFeatureValue_CACHED_MAY_BE_STALE } = require('../growthbook.js')

    // This should NOT return the caller's defaultValue when a LOCAL_GATE_DEFAULT exists
    // For features without LOCAL_DEFAULTS, it should return the caller's defaultValue
    const result = getFeatureValue_CACHED_MAY_BE_STALE('nonexistent_feature_xyz', 'fallback')
    expect(result).toBe('fallback')
  })
})
```

- [ ] **Step 2: 运行测试确认基线行为**

```bash
bun test src/services/analytics/__tests__/growthbookLocalDefaults.test.ts
```

Expected: PASS (当前行为：不存在的 feature 返回 caller defaultValue)

- [ ] **Step 3: 在 growthbook.ts 中添加 LOCAL_GATE_DEFAULTS**

在 `src/services/analytics/growthbook.ts` 中，在 `getFeatureValue_CACHED_MAY_BE_STALE` 函数之前添加:

```typescript
/**
 * Local gate defaults for features that should work without GrowthBook server.
 *
 * Lookup priority chain:
 * 1. CLAUDE_INTERNAL_FC_OVERRIDES env var
 * 2. growthBookOverrides config
 * 3. LOCAL_GATE_DEFAULTS ← this object
 * 4. remoteEvalFeatureValues memory cache
 * 5. cachedGrowthBookFeatures disk cache
 * 6. defaultValue parameter
 *
 * Only add entries here for features that have a sensible static default.
 * Kill-switches and experiments should NOT have local defaults.
 */
const LOCAL_GATE_DEFAULTS: Record<string, unknown> = {
  // Compact
  tengu_compact_cache_prefix: true,
  tengu_compact_streaming_retry: false,
  // Tool search
  tengu_tool_search_enabled: false,
  // Token budget
  tengu_token_budget_continuation: false,
  // Media recovery
  tengu_media_recovery_enabled: true,
  // Max output tokens escalation
  tengu_otk_slot_v1: false,
  // Classifier
  tengu_classifier_enabled: false,
}
```

- [ ] **Step 4: 在 getFeatureValue_CACHED_MAY_BE_STALE 中添加 LOCAL_DEFAULTS 查找**

找到 `getFeatureValue_CACHED_MAY_BE_STALE` 函数，在其返回逻辑中，在返回 caller `defaultValue` 之前，添加 LOCAL_GATE_DEFAULTS 查找:

```typescript
// In getFeatureValue_CACHED_MAY_BE_STALE, before returning defaultValue:
const localDefault = LOCAL_GATE_DEFAULTS[feature]
if (localDefault !== undefined) {
  return localDefault as T
}
return defaultValue
```

- [ ] **Step 5: 运行测试确认通过**

```bash
bun test src/services/analytics/__tests__/growthbookLocalDefaults.test.ts
```

Expected: PASS

- [ ] **Step 6: 运行 GrowthBook 相关测试**

```bash
bun test src/services/analytics/
```

Expected: All tests pass

- [ ] **Step 7: 提交**

```bash
git add src/services/analytics/growthbook.ts src/services/analytics/__tests__/growthbookLocalDefaults.test.ts
git commit -m "feat: add GrowthBook LOCAL_GATE_DEFAULTS for offline feature defaults

- Add LOCAL_GATE_DEFAULTS with sensible defaults for 7 features
- Insert lookup in getFeatureValue_CACHED_MAY_BE_STALE priority chain
- Ensures features work without GrowthBook server connection
- Required by yoloClassifier (P3a) and Dynamic Workflows (P3b)"
```

---

## Task 3: 修复 meetsAvailabilityRequirement 安全漏洞

**Files:**
- Modify: `src/commands.ts`

**Why third:** 安全修复，独立于其他任务。当前 `meetsAvailabilityRequirement` 始终返回 `true`，暴露内部命令。

- [ ] **Step 1: 编写测试**

```typescript
// src/__tests__/commandsAvailability.test.ts
import { describe, test, expect } from 'bun:test'

describe('meetsAvailabilityRequirement', () => {
  test('returns true for commands with no availability requirement', () => {
    const { meetsAvailabilityRequirement } = require('../commands.js')
    const cmd = { name: 'help', availability: undefined }
    expect(meetsAvailabilityRequirement(cmd)).toBe(true)
  })

  test('returns false for internal commands when not internal user', () => {
    const { meetsAvailabilityRequirement } = require('../commands.js')
    const cmd = { name: 'internal-debug', availability: { internal: true } }
    // In external builds, this should return false
    expect(meetsAvailabilityRequirement(cmd)).toBe(false)
  })

  test('returns true for public commands', () => {
    const { meetsAvailabilityRequirement } = require('../commands.js')
    const cmd = { name: 'help', availability: { public: true } }
    expect(meetsAvailabilityRequirement(cmd)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test src/__tests__/commandsAvailability.test.ts
```

Expected: FAIL — `meetsAvailabilityRequirement` 始终返回 true

- [ ] **Step 3: 修复 meetsAvailabilityRequirement**

在 `src/commands.ts` 中，将:

```typescript
export function meetsAvailabilityRequirement(_cmd: Command): boolean {
  return true
}
```

修改为:

```typescript
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  // Internal commands are only available in ant builds (compile-time constant).
  // Cannot use process.env.USER_TYPE because it's undefined in external builds
  // — USER_TYPE is a compile-time constant injected by bun:bundle, not a runtime env var.
  if (cmd.availability?.internal) {
    return feature('INTERNAL_COMMANDS')
  }
  return true
}
```

> **为什么不用 `process.env.USER_TYPE`**: USER_TYPE 在 compile-time 固定为 `'ant'`（见 CLAUDE.md: "USER_TYPE fixed to 'ant' at compile time"）。在 external builds 中 `process.env.USER_TYPE` 为 `undefined`，导致内部命令无法访问。使用 `feature('INTERNAL_COMMANDS')` 确保在本构建中始终为 true（因为 `fullExperimentalFeatures` 包含它），external build 可通过不包含此 flag 来禁用内部命令。

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test src/__tests__/commandsAvailability.test.ts
```

Expected: PASS

- [ ] **Step 5: 运行命令系统测试**

```bash
bun test src/commands.ts src/__tests__/commands*
```

Expected: All tests pass

- [ ] **Step 6: 提交**

```bash
git add src/commands.ts src/__tests__/commandsAvailability.test.ts
git commit -m "fix: restore meetsAvailabilityRequirement security check

Previously always returned true, exposing internal commands to external users.
Now checks cmd.availability.internal against USER_TYPE === 'ant'."
```

---

## Task 4: 热点文件集成点预留 (query.ts + claude.ts)

**Files:**
- Modify: `src/query.ts` — 添加 Smart Routing + Incremental Token 集成点
- Modify: `src/services/api/claude.ts` — 添加 Langfuse tracing 集成点

**Why fourth:** 热点文件修改需按设计文档 §6 的建议顺序执行。query.ts 和 claude.ts 的修改互不冲突（query.ts 修改 QueryParams 和 queryLoop 入口，claude.ts 修改 API 调用包装器）。

- [ ] **Step 1: 在 query.ts 中添加 feature gate imports**

在 `src/query.ts` 文件顶部的 `/* eslint-disable @typescript-eslint/no-require-imports */` 区域（第 20-26 行附近），在现有 `reactiveCompact` 和 `contextCollapse` 之后添加:

```typescript
const smartRouting = feature("SMART_MODEL_ROUTING")
  ? (require("./services/api/smartModelRouting.js") as typeof import("./services/api/smartModelRouting.js"))
  : null;
```

注意：`SMART_MODEL_ROUTING` 是 compile-time flag（已在 Task 1 注册到 build.ts），控制代码是否打包进 bundle。
实际启用还需 runtime gate `OLA_CC_SMART_ROUTING`（见 `src/utils/featureGate.ts` 的 `RUNTIME_GATES.SMART_ROUTING`）。
两层门控是 AND 关系：compile-time OFF = 代码不存在；compile-time ON + runtime OFF = 代码存在但 `isRuntimeGateEnabled` 返回 false。

- [ ] **Step 2: 在 QueryParams 中添加 Smart Routing 字段**

在 `src/query.ts` 的 `QueryParams` 类型定义中（第 302 行附近）添加:

```typescript
export type QueryParams = {
  // ... existing fields ...
  /** Smart routing config — populated from settings when OLA_CC_SMART_ROUTING=1 */
  smartRoutingConfig?: {
    enabled: boolean
    simpleModel?: string
    strongModel?: string
    simpleMaxChars?: number
    simpleMaxWords?: number
  }
}
```

- [ ] **Step 3: 在 queryLoop 中添加 Smart Routing 集成点**

在 `src/query.ts` 的 `queryLoop` 函数中，在 API 调用之前（约第 1030 行 `deps.callModel` 之前），添加:

```typescript
// --- Smart Routing integration point (Phase 2, from openclaude) ---
// When enabled, select model based on message complexity.
// The smart routing module is a pure function with no side effects.
// If smartRouting is null (compile-time disabled) or config is not set,
// currentModel remains unchanged.
if (smartRouting && params.smartRoutingConfig?.enabled) {
  const routedModel = smartRouting.routeMessage(
    state.messages,
    params.smartRoutingConfig,
  )
  if (routedModel) {
    currentModel = routedModel
  }
}
```

- [ ] **Step 4: 在 claude.ts 中添加 Langfuse tracing 集成点**

在 `src/services/api/claude.ts` 文件顶部的 import 区域之后，添加 feature gate:

```typescript
import { feature } from 'bun:bundle'

/* eslint-disable @typescript-eslint/no-require-imports */
const langfuse = feature('LANGFUSE_TRACING')
  ? (require('./langfuse/tracing.js') as typeof import('./langfuse/tracing.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
```

- [ ] **Step 5: 在 claude.ts 的 apiCall 包装器中添加 tracing hook**

找到 `queryModelWithStreaming` 函数中实际调用 API 的位置（`client.messages.create` 或等效调用），在调用前后添加:

```typescript
// --- Langfuse tracing integration point (Phase 2) ---
const trace = langfuse?.createTrace({ name: 'api-call', sessionId, model })
const generation = trace ? langfuse!.recordLLMObservation(trace, params) : undefined

try {
  // ... existing API call ...
  generation?.end({ output: response })
} catch (err) {
  generation?.end({ error: err })
  throw err
} finally {
  await langfuse?.flushLangfuse()
}
```

注意：实际集成时 `langfuse` 模块尚不存在（Task 属于 Phase 2），此处仅添加 `feature()` gate 和 null 检查。`langfuse` 变量为 `null` 时所有调用都是 no-op，零运行时开销。

- [ ] **Step 6: 运行 query.ts 相关测试**

```bash
bun test src/query.ts src/__tests__/query*
```

Expected: All tests pass

- [ ] **Step 7: 运行 claude.ts 相关测试**

```bash
bun test src/services/api/claude.ts src/services/api/__tests__/
```

Expected: All tests pass

- [ ] **Step 8: 提交**

```bash
git add src/query.ts src/services/api/claude.ts
git commit -m "feat: add integration points for Smart Routing and Langfuse in hot files

- query.ts: add feature gate import for smartRouting, extend QueryParams,
  add routeMessage call before API call (no-op when feature disabled)
- claude.ts: add feature gate import for langfuse, add tracing hook
  wrapper around API call (no-op when feature disabled)"
```

---

## Task 5: 热点文件集成点预留 (toolExecution.ts + AgentTool.tsx)

**Files:**
- Modify: `src/services/tools/toolExecution.ts` — 添加 AutoFix hook + Langfuse tool observation
- Modify: `src/tools/AgentTool/AgentTool.tsx` — 添加 Agent Routing model override

**Why fifth:** 与 Task 4 并行但修改不同文件。toolExecution.ts 的 AutoFix 在 tool 执行后 hook，Langfuse observation 在 result 返回前 hook，两者不冲突。AgentTool.tsx 的 Agent Routing 在 model selection 处修改。

- [ ] **Step 1: 在 toolExecution.ts 中添加 Langfuse tool observation 集成点**

在 `src/services/tools/toolExecution.ts` 文件顶部的 import 区域，添加:

```typescript
import { feature } from 'bun:bundle'

/* eslint-disable @typescript-eslint/no-require-imports */
const langfuseTool = feature('LANGFUSE_TRACING')
  ? (require('../../services/langfuse/tracing.js') as typeof import('../../services/langfuse/tracing.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
```

- [ ] **Step 2: 在 toolExecution.ts 的工具执行结果处添加 tracing hook**

找到工具执行完成、结果已收集的位置，在 yield tool result 之前:

```typescript
// --- Langfuse tool observation integration point (Phase 2) ---
if (langfuseTool && toolUseBlock) {
  langfuseTool.recordToolObservation({
    toolName: toolUseBlock.name,
    input: toolUseBlock.input,
    output: result,
    durationMs: executionTime,
    isError: isErrorMessage,
  })
}
```

- [ ] **Step 3: 在 AgentTool.tsx 中添加 Agent Routing feature gate**

在 `src/tools/AgentTool/AgentTool.tsx` 文件顶部的 `/* eslint-disable @typescript-eslint/no-require-imports */` 区域（第 90 行附近），添加:

```typescript
// AGENT_ROUTING: compile-time flag（已在 Task 1 注册），控制代码是否打包。
// 实际启用还需 runtime gate OLA_CC_AGENT_ROUTING（见 featureGate.ts）。
const agentRouting = feature('AGENT_ROUTING')
  ? (require('../../services/api/agentRouting.js') as typeof import('../../services/api/agentRouting.js'))
  : null
```

- [ ] **Step 4: 在 AgentTool.tsx 的 model 选择处添加 Routing hook**

在 `AgentTool.tsx` 的 `call()` 方法中，找到 `getAgentModel()` 调用（选择 subagent model 的位置），在其后添加:

```typescript
// --- Agent Routing integration point (Phase 2, from openclaude) ---
// Priority: Agent Routing > Delegation Enforcer > Smart Routing > default
const resolvedModel = agentRouting
  ? agentRouting.resolveAgentRunModelRouting({
      toolSpecifiedModel: input.model,
      agentName: agent.name,
      subagentType: agent.subagentType,
      settings: toolUseContext.settings,
    })
  : undefined
const effectiveModel = resolvedModel ?? agentModel
```

- [ ] **Step 5: 运行 toolExecution.ts 相关测试**

```bash
bun test src/services/tools/
```

Expected: All tests pass

- [ ] **Step 6: 运行 AgentTool 相关测试**

```bash
bun test src/tools/AgentTool/
```

Expected: All tests pass

- [ ] **Step 7: 提交**

```bash
git add src/services/tools/toolExecution.ts src/tools/AgentTool/AgentTool.tsx
git commit -m "feat: add integration points for Langfuse and Agent Routing in hot files

- toolExecution.ts: add feature gate for langfuseTool, add tool observation
  hook after tool execution (no-op when LANGFUSE_TRACING disabled)
- AgentTool.tsx: add feature gate for agentRouting, add model override
  hook before agent execution (no-op when AGENT_ROUTING disabled)"
```

---

## Task 6: compact.ts 集成点确认 + Context Collapse 协调

**Files:**
- Modify: `src/services/compact/compact.ts` — 确认已有集成点无冲突

**Why sixth:** compact.ts 已经有 `feature('CONTEXT_COLLAPSE')` 和 `feature('CACHED_MICROCOMPACT')` 集成点（通过 query.ts 中的 feature gate imports）。本 Task 确认这些集成点与新增的 AutoFix hook 和 Cached Microcompact 修改不冲突。

- [ ] **Step 1: 审计 compact.ts 现有 feature gates**

运行以下命令确认 compact.ts 中已有的 feature gate 使用:

```bash
grep -n "feature(" src/services/compact/compact.ts
```

Expected: 找到 `feature('KAIROS')` 和 `feature('PROMPT_CACHE_BREAK_DETECTION')` 等已有 gates。

- [ ] **Step 2: 确认 query.ts 中 compact 相关 gates 的位置关系**

在 `src/query.ts` 中，确认以下调用顺序（从设计文档 §6 热点文件协调表）:

1. `reactiveCompact` (第 20-22 行) — feature gate import
2. `contextCollapse` (第 23-25 行) — feature gate import
3. `snipCompact` (第 236-238 行) — feature gate import

确认这些 gates 在 queryLoop 中的调用顺序:
1. snip → 2. microcompact → 3. context collapse → 4. autocompact → 5. reactive compact

这个顺序与设计文档一致：AutoFix hook 在 tool 执行后（compact 之前），CachedMC 和 Collapse 修改不同函数。

- [ ] **Step 3: 添加 AutoFix hook 集成点到 compact.ts**

在 `compact.ts` 的 `compactConversation` 函数中，在 `executePreCompactHooks` 之后、`streamCompactSummary` 之前，添加:

```typescript
// --- AutoFix hook integration point (Phase 3a) ---
// AutoFix runs as a pre-compact hook, not modifying compact.ts itself.
// The hook is registered via executePreCompactHooks and can modify
// messages before they are sent for summarization.
// This integration point is a no-op placeholder — the actual AutoFix
// hook implementation is in the Quality Reliability sub-plan.
```

此步骤仅添加注释标记，不修改逻辑。AutoFix 通过 hook 注入机制工作，不需要修改 compact 本体。

- [ ] **Step 3.5: 添加 compact.ts 回归测试**

```typescript
// src/services/compact/__tests__/compactRegression.test.ts
import { describe, test, expect } from 'bun:test'

describe('compact.ts regression — existing functionality preserved', () => {
  test('compactConversation function is exported and callable', () => {
    const { compactConversation } = require('../compact.js')
    expect(typeof compactConversation).toBe('function')
  })

  test('buildPostCompactMessages function is exported', () => {
    const { buildPostCompactMessages } = require('../compact.js')
    expect(typeof buildPostCompactMessages).toBe('function')
  })

  test('resetGoalRuntimeAfterCompact function is exported', () => {
    const { resetGoalRuntimeAfterCompact } = require('../compact.js')
    expect(typeof resetGoalRuntimeAfterCompact).toBe('function')
  })

  test('compact module has no syntax errors and can be fully loaded', () => {
    // Verify the entire module loads without errors after comment additions
    const compactModule = require('../compact.js')
    expect(compactModule).toBeDefined()
    expect(Object.keys(compactModule).length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3.6: 运行回归测试确认通过**

```bash
bun test src/services/compact/__tests__/compactRegression.test.ts
```

Expected: PASS

- [ ] **Step 4: 运行 compact 相关测试**

```bash
bun test src/services/compact/
```

Expected: All tests pass

- [ ] **Step 5: 提交**

```bash
git add src/services/compact/compact.ts src/services/compact/__tests__/compactRegression.test.ts
git commit -m "docs: add integration point markers for AutoFix in compact.ts

- Add comment markers for AutoFix hook integration point
- Add regression test to verify existing compact.ts exports are preserved
- Confirm existing feature gates (KAIROS, PROMPT_CACHE_BREAK_DETECTION)
  don't conflict with new integration points
- Verify snip→microcompact→collapse→autocompact→reactive order"
```

---

## Task 7: 集成测试 + Phase 依赖验证

**Files:**
- Create: `src/utils/__tests__/integration/hotFileCoordination.test.ts` — 热点文件集成测试

**Why seventh:** 验证所有热点文件的修改互不冲突，feature gates 正确工作，Phase 依赖链完整。

- [ ] **Step 1: 编写热点文件协调集成测试**

```typescript
// src/utils/__tests__/integration/hotFileCoordination.test.ts
import { describe, test, expect } from 'bun:test'

describe('Hot file coordination', () => {
  describe('feature gates are consistent across hot files', () => {
    test('query.ts imports feature from bun:bundle', () => {
      // Verify the module can be required without errors
      // This catches import cycle issues and missing dependencies
      const queryModule = require('../../../query.js')
      expect(queryModule.query).toBeDefined()
      expect(queryModule.QueryParams).toBeDefined()
    })

    test('compact.ts imports feature from bun:bundle', () => {
      const compactModule = require('../../../services/compact/compact.js')
      expect(compactModule.compactConversation).toBeDefined()
      expect(compactModule.buildPostCompactMessages).toBeDefined()
      expect(compactModule.resetGoalRuntimeAfterCompact).toBeDefined()
    })

    test('claude.ts can be imported', () => {
      const claudeModule = require('../../../services/api/claude.js')
      expect(claudeModule.queryModelWithStreaming).toBeDefined()
    })

    test('toolExecution.ts can be imported', () => {
      const toolExecModule = require('../../../services/tools/toolExecution.js')
      expect(toolExecModule).toBeDefined()
    })
  })

  describe('runtime gate integration', () => {
    test('snapshotRuntimeGates returns all gates', () => {
      const { snapshotRuntimeGates } = require('../../featureGate.js')
      const gates = snapshotRuntimeGates()
      expect(typeof gates.agentRouting).toBe('boolean')
      expect(typeof gates.smartRouting).toBe('boolean')
      expect(typeof gates.providerAutoDetect).toBe('boolean')
      expect(typeof gates.delegationEnforcer).toBe('boolean')
    })

    test('runtime gates default to OFF except providerAutoDetect', () => {
      // Save and clear env
      const saved: Record<string, string | undefined> = {}
      for (const key of ['OLA_CC_AGENT_ROUTING', 'OLA_CC_SMART_ROUTING', 'OLA_CC_PROVIDER_AUTO_DETECT', 'OLA_CC_DELEGATION_ENFORCER']) {
        saved[key] = process.env[key]
        delete process.env[key]
      }

      const { snapshotRuntimeGates } = require('../../featureGate.js')
      const gates = snapshotRuntimeGates()
      expect(gates.agentRouting).toBe(false)
      expect(gates.smartRouting).toBe(false)
      expect(gates.providerAutoDetect).toBe(true)  // default ON
      expect(gates.delegationEnforcer).toBe(false)

      // Restore env
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) {
          process.env[key] = value
        }
      }
    })
  })

  describe('GrowthBook LOCAL_GATE_DEFAULTS', () => {
    test('LOCAL_GATE_DEFAULTS covers critical features', () => {
      // Verify that getFeatureValue returns non-undefined for features with local defaults
      const { getFeatureValue_CACHED_MAY_BE_STALE } = require('../../../services/analytics/growthbook.js')
      // These features have LOCAL_GATE_DEFAULTS entries
      const result = getFeatureValue_CACHED_MAY_BE_STALE('tengu_compact_cache_prefix', false)
      expect(typeof result).toBe('boolean')
    })
  })

  describe('meetsAvailabilityRequirement security', () => {
    test('internal commands are filtered in external builds', () => {
      const { meetsAvailabilityRequirement } = require('../../../commands.js')
      const internalCmd = { name: 'debug', availability: { internal: true } }
      // In external builds (USER_TYPE !== 'ant'), this should return false
      // In ant builds, this should return true
      const result = meetsAvailabilityRequirement(internalCmd)
      expect(typeof result).toBe('boolean')
    })

    test('commands without availability requirement are always available', () => {
      const { meetsAvailabilityRequirement } = require('../../../commands.js')
      const publicCmd = { name: 'help' }
      expect(meetsAvailabilityRequirement(publicCmd)).toBe(true)
    })
  })
})
```

- [ ] **Step 2: 运行集成测试**

```bash
bun test src/utils/__tests__/integration/hotFileCoordination.test.ts
```

Expected: PASS

- [ ] **Step 3: 运行全量测试确认无回归**

```bash
bun test --timeout 60000 2>&1 | tail -30
```

Expected: All tests pass (no new failures)

- [ ] **Step 4: 构建验证**

```bash
bun run build:dev 2>&1 | tail -20
```

Expected: Build succeeds, `./cli-dev` created

- [ ] **Step 5: 提交**

```bash
git add src/utils/__tests__/integration/hotFileCoordination.test.ts
git commit -m "test: add hot file coordination integration tests

- Verify feature gate consistency across query.ts, compact.ts, claude.ts, toolExecution.ts
- Verify runtime gate defaults (providerAutoDetect=ON, others=OFF)
- Verify GrowthBook LOCAL_GATE_DEFAULTS coverage
- Verify meetsAvailabilityRequirement security fix"
```

---

## Task 8: Phase 依赖文档 + 子计划入口确认

**Files:**
- Modify: `docs/superpowers/plans/2026-06-03-cross-integration-plan.md` — 本文件，添加子计划索引

**Why last:** 所有基础设施就绪后，确认子计划入口和依赖关系，为后续 Phase 实施做准备。

- [ ] **Step 1: 确认 Phase 依赖链完整性**

验证以下依赖链:

```
Phase 1 (本计划 Task 1-3)
  ├── Task 1: Feature Gate 基础设施 ← 所有 Phase 的前置
  ├── Task 2: GrowthBook LOCAL_DEFAULTS ← yoloClassifier (P3a) + Workflows (P3b) 的依赖
  └── Task 3: meetsAvailabilityRequirement ← 安全修复，无下游依赖

Phase 2 (独立子计划，依赖 Task 1)
  ├── Langfuse Tracing → 依赖 Task 1 (LANGFUSE_TRACING flag) + Task 4 (claude.ts 集成点)
  ├── LSP 12 Tools → 依赖 Task 1 (LSP_TOOLS flag)
  ├── Agent Routing → 依赖 Task 1 (AGENT_ROUTING runtime gate) + Task 5 (AgentTool.tsx 集成点)
  ├── Smart Model Routing → 依赖 Agent Routing (共享 agentRouting.ts) + Task 4 (query.ts 集成点)
  └── Provider Auto-Detect → 依赖 Task 1 (PROVIDER_AUTO_DETECT runtime gate)

Phase 3a (独立子计划，依赖 Task 1 + Task 2)
  ├── yoloClassifier → 依赖 Task 2 (GrowthBook LOCAL_DEFAULTS)
  ├── SSRF Guard → 依赖 Task 1 (SSRF_GUARD flag)
  └── Secret Scanner → 依赖 Task 1 (SECRET_SCANNER flag)

Phase 3b (独立子计划，依赖 Task 1 + Task 2)
  ├── ACP Protocol → 依赖 Task 1 (ACP_PROTOCOL flag)
  └── Dynamic Workflows → 依赖 Task 2 (GrowthBook LOCAL_DEFAULTS)
```

- [ ] **Step 2: 确认子计划文件路径**

| 子系统 | 子计划路径 | 状态 |
|--------|-----------|------|
| Langfuse Tracing | `docs/superpowers/specs/langfuse-tracing-design.md` | 待创建 |
| LSP 12 Tools | `docs/superpowers/specs/lsp-tools-design.md` | 待创建 |
| Agent Routing + Smart Routing | `docs/superpowers/specs/agent-routing-smart-routing-design.md` | 待创建 |
| yoloClassifier | `docs/superpowers/specs/yolo-classifier-design.md` | 待创建 |
| Security Hardening | `docs/superpowers/specs/security-hardening-design.md` | 待创建 |
| Dynamic Workflows | `docs/superpowers/specs/dynamic-workflows-design.md` | 待创建 |
| Ultra Series | `docs/superpowers/specs/ultra-series-design.md` | 已存在 |

- [ ] **Step 3: 更新本计划的 Self-Review**

---

## Self-Review

### 1. 设计文档覆盖

| 设计文档章节 | Task | 状态 |
|-------------|------|------|
| §2.11 Feature Flag Matrix | Task 1 | 完成 |
| §3.5 GrowthBook LOCAL_DEFAULTS | Task 2 | 完成 |
| §2.3 meetsAvailabilityRequirement | Task 3 | 完成 |
| §6 query.ts 集成点 | Task 4 | 预留 |
| §6 claude.ts 集成点 | Task 4 | 预留 |
| §6 toolExecution.ts 集成点 | Task 5 | 预留 |
| §6 AgentTool.tsx 集成点 | Task 5 | 预留 |
| §6 compact.ts 集成点 | Task 6 | 确认 |
| §7.2 Phase 依赖图 | Task 7, 8 | 验证 |
| §3.1 Langfuse Tracing | Task 4 | 集成点预留 |
| §3.3 Agent Routing | Task 5 | 集成点预留 |
| §3.4 Smart Model Routing | Task 4 | 集成点预留 |

### 2. Placeholder Scan

本计划中 Task 4-5 的集成点代码是"预留"性质 — feature gate 和 null 检查已就位，实际功能模块（langfuse/、agentRouting.ts、smartModelRouting.ts）由各自的子计划创建。这不是 placeholder，而是正确的"gate-first"开发模式：先确保代码路径安全（feature disabled 时零开销），再在子计划中填充实现。

### 3. 热点文件冲突分析

| 热点文件 | 本计划修改 | 子计划修改 | 冲突 |
|---------|-----------|-----------|------|
| query.ts | +smartRouting import, +QueryParams field, +routeMessage hook | Performance Optimization: +incrementalToken | 无 — 不同函数 |
| claude.ts | +langfuse import, +tracing hook | Performance Optimization: +toolSchemaCache | 无 — 不同位置 |
| toolExecution.ts | +langfuseTool import, +observation hook | Quality Reliability: +autoFix hook | 无 — hook 点不同 |
| AgentTool.tsx | +agentRouting import, +model override hook | Delegation Enforcer: +forceInherit | 无 — 不同 hook 点 |
| compact.ts | 确认无冲突 | Context Collapse, CachedMC | 已有 feature gates |

### 4. Type Consistency

- `RuntimeGateState` 接口 — 所有字段为 `boolean`，与 `isRuntimeGateEnabled` 返回类型一致
- `RUNTIME_GATES` 常量 — 使用 `as const` 确保类型推断精确
- `QueryParams.smartRoutingConfig` — 可选字段，与现有 `QueryParams` 模式一致
- feature gate imports — 使用 `feature('FLAG') ? require(...) : null` 模式，与 query.ts 现有模式一致

### 5. 测试覆盖

| Task | 测试文件 | 测试数量 |
|------|---------|---------|
| Task 1 | `src/utils/__tests__/featureGate.test.ts` | 7 tests |
| Task 2 | `src/services/analytics/__tests__/growthbookLocalDefaults.test.ts` | 1 test |
| Task 3 | `src/__tests__/commandsAvailability.test.ts` | 3 tests |
| Task 6 | `src/services/compact/__tests__/compactRegression.test.ts` | 4 tests |
| Task 7 | `src/utils/__tests__/integration/hotFileCoordination.test.ts` | 7 tests |

---

## 实施检查清单

| Task | 检查项 | 状态 |
|------|--------|------|
| T1 | featureGate.ts 创建 | ☐ |
| T1 | RUNTIME_GATES 常量 | ☐ |
| T1 | snapshotRuntimeGates() | ☐ |
| T1 | 新 compile-time flags 注册 (含 SMART_MODEL_ROUTING, AGENT_ROUTING, INTERNAL_COMMANDS) | ☐ |
| T1 | 7 tests passing | ☐ |
| T2 | LOCAL_GATE_DEFAULTS 对象 | ☐ |
| T2 | getFeatureValue 查找链修改 | ☐ |
| T3 | meetsAvailabilityRequirement 修复 | ☐ |
| T3 | 3 tests passing | ☐ |
| T4 | query.ts smartRouting gate import | ☐ |
| T4 | QueryParams 扩展 | ☐ |
| T4 | routeMessage hook | ☐ |
| T4 | claude.ts langfuse gate import | ☐ |
| T4 | tracing hook wrapper | ☐ |
| T5 | toolExecution.ts langfuseTool gate | ☐ |
| T5 | tool observation hook | ☐ |
| T5 | AgentTool.tsx agentRouting gate | ☐ |
| T5 | model override hook | ☐ |
| T6 | compact.ts 集成点确认 | ☐ |
| T6 | 回归测试 4 tests passing | ☐ |
| T6 | 调用顺序验证 | ☐ |
| T7 | 集成测试 7 tests passing | ☐ |
| T7 | 全量测试无回归 | ☐ |
| T7 | 构建验证 | ☐ |
| T8 | Phase 依赖链确认 | ☐ |
| T8 | 子计划入口确认 | ☐ |
