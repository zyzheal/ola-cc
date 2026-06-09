# Ultra Series Integration Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: claude-code-best v2.6.6
**Priority**: P0/P1
**Effort**: S-M

---

## 1. Overview

Ultra 系列是 claude-code 的高级功能集，包括 Ultrathink（超深度思考）、Ultraplan（超级规划）、Ultrareview（超级审查）。ola-cc 已移植约 85%，本文档聚焦缺失部分。

## 2. Current Porting Status

| Feature | Status | Completeness |
|---------|--------|-------------|
| Ultrathink | **Fully ported** | 100% (minor bugs) |
| Ultraplan | **Mostly ported** | 75% (missing prompt templates + UI) |
| Ultrareview | **Fully ported** | 95% (missing preflight) |
| Effort system | **Partially ported** | 80% (missing xhigh level) |

---

## 3. Ultrathink Fixes (P0)

### 3.1 Issue: Missing opus-4-7 Support

**File**: `src/utils/thinking.ts` (line 113-144)

实际函数 `modelSupportsAdaptiveThinking()` 使用 `getCanonicalName()` + `includes()` 检查，当前 allowlist 仅含 `opus-4-6` 和 `sonnet-4-6`：

```typescript
// 实际代码 (line 120):
if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
  return true
}

// 修正: 添加 opus-4-7
if (canonical.includes('opus-4-7') || canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
  return true
}
```

注意: `modelSupportsAdaptiveThinking` 与 `modelSupportsThinking` (line 90) 是不同函数。后者检查所有 Claude 4+ 模型，前者仅检查支持 adaptive thinking 的子集。

### 3.2 Issue: Missing Import (confirmed bug)

**File**: `src/utils/thinking.ts`

`resolveAntModel` 在 `modelSupportsThinking()` (line 96) 中被调用但未 import。需要添加:

```typescript
import { resolveAntModel } from './model/antModels.js'
```

实际导入源: `src/utils/model/antModels.ts:51` — `export function resolveAntModel(model: string | undefined): AntModel | undefined`

### 3.3 Files to Modify

| File | Change |
|------|--------|
| `src/utils/thinking.ts` | Add opus-4-7 + fix import |

---

## 4. Effort System Enhancement (P0)

### 4.1 Add xhigh Level

**Current**: `low → medium → high → max`
**Target**: `low → medium → high → xhigh → max`

**类型传播要求**: 添加 `xhigh` 需同步更新 `src/entrypoints/sdk/runtimeTypes.ts` 中的 `EffortLevel` 类型定义（当前为 `'low' | 'medium' | 'high' | string`），以及所有消费该类型的组件。`effort.ts` 通过 `import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'` 引用该类型（line 9），`EFFORT_LEVELS` 使用 `satisfies readonly EffortLevel[]` 约束（line 18）。修改 `runtimeTypes.ts` 后，TypeScript 编译器会自动标记所有未处理 `xhigh` 的 switch-case。

### 4.2 File Changes

**`src/utils/effort.ts`**:

当前实际代码结构:
- `EFFORT_LEVELS` (line 13): `['low', 'medium', 'high', 'max'] as const satisfies readonly EffortLevel[]`
- `modelSupportsEffort()` (line 23): 使用 `get3PModelCapabilityOverride` + `m.includes()` 检查，allowlist 含 `opus-4-6`, `sonnet-4-6`
- `modelSupportsMaxEffort()` (line 55): 仅允许 `opus-4-6`（非所有 effort 模型），带 `resolveAntModel` 内部路径

```typescript
// 1. 添加 xhigh 到 EFFORT_LEVELS
// 当前 (line 13):
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const satisfies readonly EffortLevel[]
// 修改为:
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortLevel[]

// 2. 更新 modelSupportsMaxEffort (line 55) — 当前仅允许 opus-4-6:
// 实际代码:
export function modelSupportsMaxEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) return supported3P
  if (model.toLowerCase().includes('opus-4-6')) return true
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) return true
  return false
}
// 修正: 添加 opus-4-7 到 allowlist
//   if (model.toLowerCase().includes('opus-4-6') || model.toLowerCase().includes('opus-4-7')) return true

// 3. 更新 modelSupportsEffort (line 23) — 添加 opus-4-7:
// 当前 allowlist: 'opus-4-6', 'sonnet-4-6'
// 修正: 添加 'opus-4-7'

// 4. 更新 toPersistableEffort (line 97) 和 convertEffortValueToLevel (line 204) — 添加 'xhigh' 分支
// 5. 更新 getEffortLevelDescription (line 226) — 添加 'xhigh' 描述
```

**注意**: `modelSupportsXhighEffort()` 和 `getMaxEffortEffectiveness()` 在实际代码中不存在。如需引入效果等级标注，应作为新函数添加，不影响现有接口。

**`src/commands/effort/effort.tsx`**:
- Update help text to include `xhigh`

**`src/components/EffortIndicator.ts`** (line 27-42):

实际代码 `effortLevelToSymbol()` 使用 switch-case，当前有 `low`(EFFORT_LOW), `medium`(EFFORT_MEDIUM), `high`(EFFORT_HIGH), `max`(EFFORT_MAX) 四个分支，default 返回 EFFORT_HIGH。

```typescript
// 添加 xhigh case:
case 'xhigh':
  return EFFORT_XHIGH  // New symbol, 需在 figures.ts 中定义
```

**`src/constants/figures.ts`** (line 10-13):

当前实际常量:
```typescript
export const EFFORT_LOW = '○'    // \u25cb
export const EFFORT_MEDIUM = '◐' // \u25d0
export const EFFORT_HIGH = '●'   // \u25cf
export const EFFORT_MAX = '◉'    // \u25c9 - (Opus 4.6 only)
```

添加:
```typescript
export const EFFORT_XHIGH = '◎'  // \u25ce - 介于 HIGH 和 MAX 之间
```

### 4.3 Files to Modify

| File | Change |
|------|--------|
| `src/utils/effort.ts` | Add xhigh + model support |
| `src/commands/effort/effort.tsx` | Update help text |
| `src/components/EffortIndicator.ts` | Add EFFORT_XHIGH case |
| `src/constants/figures.ts` | Add EFFORT_XHIGH constant |

---

## 5. Ultraplan Missing Components (P1)

### 5.1 Prompt Templates

**Missing**: `src/utils/ultraplan/prompt.ts`

claude-code has 3 prompt templates selected dynamically via GrowthBook:

| Template | Use Case | Prompt 核心指令 |
|----------|----------|----------------|
| `simple_plan` | Default, single-plan | 用于简单任务（<5 步）。输入：用户需求 + 代码上下文。输出：markdown checklist 格式，每步含 `[ ]` checkbox、操作描述、estimated LOC。要求 LLM 按依赖顺序排列步骤，每步粒度控制在 50 LOC 以内。 |
| `visual_plan` | Visual/diagram-heavy plans | 用于 UI/布局任务。输入：组件描述 + 设计约束。输出：ASCII mockup（用 box-drawing 字符绘制布局）+ 实现步骤组合。要求 LLM 先输出视觉结构，再输出对应的组件实现清单。 |
| `three_subagents_with_critique` | Complex plans with 3 sub-agents + critic | 用于复杂架构任务。输入：系统需求 + 现有架构。流程：3 个子代理独立输出方案（各有不同侧重：性能/可维护性/简洁性），然后 critic 子代理评估 3 个方案并选择最优，输出最终方案 + 改进建议。 |

**GrowthBook 降级**: 当 GrowthBook 不可用时，默认使用 `simple_plan` template。

**Current ola-cc**: `prompt.txt` contains placeholder text "Ultraplan is unavailable in the restored development build." (已确认，1行)

**Fix**: Create `prompt.ts` with template selection logic, replace `prompt.txt` content。

#### Prompt Template 核心内容

以下为 3 个 template 的可直接使用的 prompt 文本框架:

**`simple_plan`**:
```
You are planning a simple task. Output a markdown checklist:
- Each step should be a single, actionable item
- Estimate LOC for each step
- Mark dependencies with [depends: step N]
- Total steps should be ≤ 5
```

**`visual_plan`**:
```
You are planning a UI/visual task. Output:
1. ASCII mockup of the target layout
2. Implementation steps referencing the mockup
3. Component hierarchy diagram
```

**`three_subagents_with_critique`**:
```
You are planning a complex architectural task.
Step 1: Spawn 3 subagents, each proposing a different approach
Step 2: Spawn a critic subagent to evaluate all 3 proposals
Step 3: Use the critic's recommendation as the final plan
```

#### Template Selection Logic (`prompt.ts`)

```typescript
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

type PlanTemplate = 'simple_plan' | 'visual_plan' | 'three_subagents_with_critique'

export function getPlanTemplate(): PlanTemplate {
  return getFeatureValue_CACHED_MAY_BE_STALE('ultraplan_template', 'simple_plan')
}

export function buildPlanPrompt(template: PlanTemplate, context: string): string {
  const templates: Record<PlanTemplate, string> = {
    simple_plan: SIMPLE_PLAN_PROMPT,
    visual_plan: VISUAL_PLAN_PROMPT,
    three_subagents_with_critique: THREE_SUBAGENTS_PROMPT,
  }
  return `${templates[template]}\n\n---\n\n${context}`
}
```

### 5.2 UI Components

**Missing**: `src/components/ultraplan/`

| Component | Purpose |
|-----------|---------|
| `UltraplanChoiceDialog.tsx` | Choose between plan templates |
| `UltraplanLaunchDialog.tsx` | Configure and launch ultraplan |

### 5.3 Cleanup Registry

**Modify**: `src/utils/cleanupRegistry.ts` — 扩展现有实现，添加 ASAEF 工具使用统计

现有 cleanupRegistry 已被 39+ 文件使用，提供资源清理注册/注销能力。需要扩展以支持 ultraplan 取消时的资源清理，并为 ASAEF 进化系统记录工具使用统计。

### 5.4 Files to Modify

| File | Operation |
|------|-----------|
| `src/utils/ultraplan/prompt.ts` | **New** — Template selection logic |
| `src/utils/ultraplan/prompt.txt` | **Replace** — Actual prompt content |
| `src/components/ultraplan/UltraplanChoiceDialog.tsx` | **New** |
| `src/components/ultraplan/UltraplanLaunchDialog.tsx` | **New** |
| `src/utils/cleanupRegistry.ts` | **Modify** — 扩展现有实现，添加 ASAEF 工具使用统计 |
| `src/commands/ultraplan.tsx` | **Modify** — Use new templates + cleanup |

---

## 6. Ultrareview Missing Component (P1)

### 6.1 Preflight Check

**Missing**: `src/services/api/ultrareviewPreflight.ts`

Performs pre-checks before launching remote review:
- Verify CCR connectivity
- Check quota availability
- Validate PR/branch access

### 6.2 Files to Modify

| File | Operation |
|------|-----------|
| `src/services/api/ultrareviewPreflight.ts` | **New** |

---

## Feature Flags

实际使用两层门控机制（非 `OLA_CC_` 环境变量）:

| Feature | Build-time Flag | Runtime Gate | 降级策略 |
|---------|----------------|--------------|---------|
| Ultraplan | `feature('ULTRAPLAN')` — `scripts/build.ts` 已注册 | GrowthBook `tengu_turtle_carbon` (与 Ultrathink 共用) | 使用现有 /plan 命令 |
| Ultrathink | `feature('ULTRATHINK')` — `scripts/build.ts` 已注册 | GrowthBook `tengu_turtle_carbon` | 默认 thinking 模式 |
| Ultrareview | **无 build flag** — 通过 `isUltrareviewEnabled()` 检查 | GrowthBook 配置 (`src/commands/review/ultrareviewEnabled.ts`) | 使用现有代码审查流程 |

**门控模式**: `feature()` (build-time, `bun:bundle` DCE) → GrowthBook (runtime A/B) → 降级路径。Ultrareview 无 build flag，完全依赖 GrowthBook 运行时配置。

---

## 7. Dependency Summary

| Dependency | Used By | Status in ola-cc |
|------------|---------|------------------|
| `teleportToRemote()` | Ultraplan, Ultrareview | Present |
| GrowthBook | All Ultra features | Present |
| `ExitPlanModeTool` | Ultraplan | Present |
| `cleanupRegistry` | Ultraplan | **Present** — 扩展现有实现，添加 ASAEF 工具使用统计 |
| CCR service | Ultraplan, Ultrareview | External service |
| OAuth | CCR sessions | Present |
