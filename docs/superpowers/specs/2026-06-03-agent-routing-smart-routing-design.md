# Agent Routing + Smart Model Routing Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: openclaude v0.16.1
**Priority**: P0/P1
**Effort**: M (5 new files + 5 modified)

---

## Feature Flags

| Flag | 默认 | 环境变量覆盖 | 降级策略 |
|------|------|-------------|---------|
| `OLA_CC_AGENT_ROUTING` | off | `OLA_CC_AGENT_ROUTING=1` | 所有 agent 使用默认 provider |
| `OLA_CC_SMART_ROUTING` | off | `OLA_CC_SMART_ROUTING=1` | 所有消息使用主模型 |

---

## 1. Agent Routing (P0)

### 1.1 Overview

Agent Routing 允许为不同的 agent/subagent 指定不同的 provider 和模型，实现 per-agent 级别的模型路由。

### 1.2 Configuration

```json
// settings.json
{
  "agentModels": {
    "sonnet-provider": { "base_url": "https://api.openai.com/v1", "api_key": "sk-..." },
    "deepseek": { "base_url": "https://api.deepseek.com/v1", "api_key": "sk-..." }
  },
  "agentRouting": {
    "code-reviewer": "sonnet-provider",
    "planner": "deepseek",
    "default": "anthropic"
  }
}
```

### 1.3 Core Logic

**`resolveAgentRunModelRouting()`** — Priority chain:

```
toolSpecifiedModel > agentName > subagentType > "default" > null
```

All keys normalized (lowercase + strip `-`/`_`) with collision warning.

**Return value**: `{ mainLoopModel, providerOverride? }`

### 1.4 Security Hardening

**`applyAgentProviderOverrideToEnv()`**:
1. Clear 22 competing env vars (`PROVIDER_ENV_VARS_TO_CLEAR_FOR_OVERRIDE`)
2. Set `CLAUDE_CODE_USE_OPENAI=1` + `OPENAI_MODEL` + `OPENAI_BASE_URL` + `OPENAI_API_KEY`
3. In `client.ts`, providerOverride path **filters Authorization/x-api-key headers** to prevent credential leakage

### 1.5 Files to Modify

| File | Operation | Description |
|------|-----------|-------------|
| `src/services/api/agentRouting.ts` | **New** | Core routing logic |
| `src/utils/settings/types.ts` | Modify | Add `agentModels` + `agentRouting` Zod schema |
| `src/services/api/client.ts` | Modify | Add providerOverride branch in getAnthropicClient() |
| `src/tools/AgentTool/AgentTool.tsx` | Modify | Call resolveAgentRunModelRouting() at agent start |
| `src/state/AppState.tsx` | Modify | Pass settings to agent execution context |

### 1.6 Risks

- ola-cc's `client.ts` uses `createOpenAICompatibleClient` (from `openai.ts`), not openclaude's `createOpenAIShimClient` (from `openaiShim.ts`) — interface incompatible, needs adapter layer

---

## 2. Smart Model Routing (P1)

### 2.1 Overview

Smart Routing 根据消息复杂度自动选择便宜模型（simple）或强大模型（strong），节省成本。

### 2.2 Configuration

```json
// settings.json
{
  "smartRouting": {
    "enabled": true,
    "simpleModel": "haiku",
    "strongModel": "sonnet",
    "simpleMaxChars": 160,
    "simpleMaxWords": 28
  }
}
```

### 2.3 "Simple" Message Detection

**All 8 conditions must be satisfied**:

| # | Condition | Threshold |
|---|-----------|-----------|
| 1 | Non-empty text | — |
| 2 | Not first turn | `turnNumber !== 1` |
| 3 | No code blocks | No `` ``` `` or `` ` `` |
| 4 | No strong keywords | 28 keywords: plan, design, architect, refactor, debug, investigate, analyze, implement, optimize, review, audit, diagnose, root cause, why does, why is, how should, why did, propose, trace, reproduce |
| 5 | Single paragraph | No `\n\s*\n` |
| 6 | Character count | ≤ `simpleMaxChars` (default 160) |
| 7 | Word count | ≤ `simpleMaxWords` (default 28) |
| 8 | Empty input (tool-use chain continuation) | → simple |

### 2.4 Return Value

```typescript
{ model: string, complexity: 'simple' | 'strong', reason: string }
```

### 2.5 Integration Point

In `src/query.ts`, before building API request:
```typescript
import { routeModel } from '../services/api/smartModelRouting.js'

const routing = routeModel(messages, turnNumber, settings.smartRouting)
if (routing) {
  selectedModel = routing.model
}
```

### 2.6 Files to Modify

| File | Operation | Description |
|------|-----------|-------------|
| `src/services/api/smartModelRouting.ts` | **New** | Pure function, no deps |
| `src/utils/settings/types.ts` | Modify | Add `smartRouting` schema |
| `src/query.ts` | Modify | Call routeModel() before API request |

### 2.7 turnNumber 可用性

在 `src/query.ts` 的 agentic loop 中，`turnNumber` 已通过 context 传递。验证: `src/query.ts` 中 `QueryEngine` 已维护 `turnCount`。

集成点: 在 `routeModel()` 调用时传入 `context.turnCount`：

```typescript
// src/query.ts — agentic loop 内部
const turnCount = queryEngine.getTurnCount()
const routing = routeModel(messages, turnCount, settings.smartRouting)
```

### 2.8 中文词数处理

对中文等非空格分隔语言，使用字符数而非词数：

```typescript
function estimateWordCount(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const nonCjkWords = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').split(/\s+/).filter(Boolean).length
  return cjkChars + nonCjkWords
}
```

此函数在 `routeModel()` 内部替换原有的 `split(/\s+/).length` 逻辑，确保中文短消息（如 "帮我看看这个文件" = 8 字符/词）不会被误判为 strong。

### 2.9 Risks

- Need to ensure `turnNumber` is available in query loop (已解决，见 2.7)
- Interaction with existing `getAgentModel()` needs clear priority definition

---

## 3. 架构师视角

### 3.1 在 ola-cc 模型选择体系中的位置

Agent Routing 和 Smart Routing 共同构成 ola-cc 的多层模型路由体系，与 Delegation Enforcer 协作：

```
用户消息 → [Smart Routing] → 选择 simple/strong 模型
                ↓
         agent 启动 → [Agent Routing] → 按 agent 名称/provider 路由
                ↓
         subagent 委托 → [Delegation Enforcer] → 规范化模型名 + forceInherit
                ↓
         getAgentModel() → 非 Claude parent 保护 → 最终模型
```

### 3.2 决策树

```
routeModel() 被调用
├── Smart Routing enabled?
│   ├── 是 → 检测消息复杂度
│   │   ├── simple → simpleModel (haiku)
│   │   └── strong → strongModel (sonnet)
│   └── 否 → 使用主模型
│
├── Agent Routing enabled?
│   ├── 是 → resolveAgentRunModelRouting()
│   │   ├── toolSpecifiedModel → 直接使用
│   │   ├── agentName 匹配 → 使用配置的 provider
│   │   ├── subagentType 匹配 → 使用配置的 provider
│   │   └── default → 使用默认 provider
│   └── 否 → 所有 agent 使用主模型
│
└── Delegation Enforcer (中间件)
    ├── forceInherit → 删除 model 参数，继承 parent
    ├── 已有 model → normalizeToCcAlias()
    └── 无 model → 从 agent 定义查找
```

### 3.3 优先级规则

当三层路由同时启用时，优先级为：

1. `toolSpecifiedModel`（工具调用时显式指定）— 最高
2. Agent Routing（按 agent 名称配置）— 高
3. Smart Routing（按消息复杂度）— 中
4. Delegation Enforcer（规范化 + 继承）— 兜底
5. `getAgentModel()` 非 Claude 保护 — 安全兜底（不可覆盖）

### 3.4 竞品对比

| 方案 | 路由粒度 | 路由依据 | 中文支持 | 降级策略 |
|------|---------|---------|---------|---------|
| ola-cc (本设计) | per-agent + per-message | agent 名称 + 消息复杂度 + CJK 字符计数 | 原生支持 | 三层 fallback + feature flag |
| openclaude v0.16.1 | per-agent | agent 名称 + provider 配置 | 无特殊处理 | 环境变量降级 |
| claude-code (官方) | 无动态路由 | 固定模型 + `ANTHROPIC_MODEL` 环境变量 | N/A | 仅环境变量切换 |
| Cursor / Windsurf | per-workspace | 项目配置 + 用户偏好 | 无特殊处理 | 手动切换 |

**ola-cc 优势**: 唯一同时支持 per-agent 路由 + per-message 复杂度路由 + CJK 词数处理的方案。
