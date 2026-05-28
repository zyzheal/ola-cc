# Goal ReAct Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 ReAct 智能编排器，让 `/goal` 命令支持多场景感知、三维收敛检测、统一错误恢复、技能自动发现，最终实现任务 100% 自动完成。

**Architecture:** 7 个新模块（纯函数/无副作用）+ 1 个编排器整合模块。`goalRuntime.ts` 的 `turn_finished` 核心决策委托给 `goalOrchestrator`，自身精简为会计/状态更新。所有新模块通过只读输入→决策输出的契约解耦。

**Tech Stack:** TypeScript, Bun test, Zod (optional), 纯函数设计

**Spec:** `docs/superpowers/specs/2026-05-28-goal-react-orchestrator-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/utils/goal/goalScenario.ts` | 场景识别 + 配置查表 + 亲和矩阵 |
| `src/utils/goal/goalScenario.test.ts` | 场景识别单元测试 |
| `src/utils/goal/goalReActObserver.ts` | ReAct 阶段推断 + 质量信号提取 |
| `src/utils/goal/goalReActObserver.test.ts` | ReAct 观测单元测试 |
| `src/utils/goal/goalConvergence.ts` | 三维收敛检测（信息增益/质量/变更幅度） |
| `src/utils/goal/goalConvergence.test.ts` | 收敛检测单元测试 |
| `src/utils/goal/goalErrorTracker.ts` | 统一错误计数器 |
| `src/utils/goal/goalErrorTracker.test.ts` | 错误追踪单元测试 |
| `src/utils/goal/goalErrorRecovery.ts` | 三层恢复决策 + prompt 生成 |
| `src/utils/goal/goalErrorRecovery.test.ts` | 错误恢复单元测试 |
| `src/utils/goal/goalSkillRanker.ts` | 技能排名纯函数 |
| `src/utils/goal/goalSkillRanker.test.ts` | 技能排名单元测试 |
| `src/utils/goal/skillRegistry.ts` | SKILL.md 扫描 + 缓存 |
| `src/utils/goal/skillRegistry.test.ts` | 技能注册表单元测试 |
| `src/utils/goal/goalOrchestrator.ts` | 编排器整合 |
| `src/utils/goal/goalOrchestrator.test.ts` | 编排器集成测试 |

### Modified Files
| File | Changes |
|------|---------|
| `src/commands/goal/types.ts` | GoalRuntimeState 扩展（+4 可选字段），GoalTask.status 加 "skipped" |
| `src/state/AppStateStore.ts` | goalRuntime 默认值新增可选字段 |
| `src/utils/goal/goalRuntime.ts` | turn_finished 委托给 orchestrator，删除废弃代码，hadObservableChanges 语义重定义 |

---

## Task 1: 类型扩展 — GoalRuntimeState + GoalTask

**Files:**
- Modify: `src/commands/goal/types.ts`
- Modify: `src/state/AppStateStore.ts`

- [ ] **Step 1: 写失败测试 — GoalRuntimeState 新字段存在性**

```typescript
// src/commands/goal/types.test.ts (新建)
import { describe, it, expect } from "bun:test"
import type { GoalRuntimeState } from "./types.js"

describe("GoalRuntimeState orchestrator fields", () => {
  it("should accept optional currentScenario", () => {
    const state = {} as GoalRuntimeState
    expect(state.currentScenario).toBeUndefined()
  })

  it("should accept optional convergenceState", () => {
    const state = {} as GoalRuntimeState
    expect(state.convergenceState).toBeUndefined()
  })

  it("should accept optional errorTracker", () => {
    const state = {} as GoalRuntimeState
    expect(state.errorTracker).toBeUndefined()
  })

  it("should accept optional lastObservation", () => {
    const state = {} as GoalRuntimeState
    expect(state.lastObservation).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/commands/goal/types.test.ts -v`
Expected: FAIL — 类型字段不存在

- [ ] **Step 3: 实现 — 扩展 GoalRuntimeState**

在 `src/commands/goal/types.ts` 的 `GoalRuntimeState` 接口中添加：

```typescript
// 添加到 GoalRuntimeState 接口末尾，现有字段之后

// v3 orchestrator — 场景
currentScenario?: string          // ScenarioType: "code_change" | "doc_writing" | "troubleshooting" | "design_improve" | "refactoring"

// v3 orchestrator — 收敛检测
convergenceState?: {
  informationGains: number[]      // 滑动窗口，max 5
  qualityScores: number[]
  changeMagnitudes: number[]
  round: number
}

// v3 orchestrator — 统一错误追踪
errorTracker?: {
  categories: Record<string, { count: number; threshold: number }>
  recoveryLayer: string           // RecoveryLayer
  fullRestartUsed: boolean
}

// v3 orchestrator — ReAct 观测（每轮覆盖）
lastObservation?: {
  mainPhase: string | null        // ReActPhase
  phases: string[]
  qualitySignals: { hasErrors: boolean; hasSuccess: boolean; hasProgress: boolean }
}
```

同时在 `GoalTask.status` 中添加 `"skipped"`:

```typescript
// 修改前
status: "pending" | "in_progress" | "completed";

// 修改后
status: "pending" | "in_progress" | "completed" | "skipped";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/commands/goal/types.test.ts -v`
Expected: PASS

- [ ] **Step 5: 更新 AppStateStore 默认值**

在 `src/state/AppStateStore.ts` 的 `goalRuntime` 默认对象中添加新字段：

```typescript
// 在 goalRuntime 默认对象末尾（~line 602），consecutiveCritical: 0 之后添加
currentScenario: undefined,
convergenceState: undefined,
errorTracker: undefined,
lastObservation: undefined,
```

- [ ] **Step 6: 验证构建**

Run: `bun run build:dev 2>&1 | tail -5`
Expected: 构建成功，无类型错误

- [ ] **Step 7: Commit**

```bash
git add src/commands/goal/types.ts src/commands/goal/types.test.ts src/state/AppStateStore.ts
git commit -m "feat: extend GoalRuntimeState with orchestrator fields + GoalTask skipped status"
```

---

## Task 2: 场景识别模块 — goalScenario.ts

**Files:**
- Create: `src/utils/goal/goalScenario.ts`
- Create: `src/utils/goal/goalScenario.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/utils/goal/goalScenario.test.ts
import { describe, it, expect } from "bun:test"
import { identifyScenarios, resolveScenario, SCENARIO_KEYWORDS, getScenarioConfig } from "./goalScenario.js"

describe("identifyScenarios", () => {
  it("should identify troubleshooting from English keywords", () => {
    const matches = identifyScenarios("fix the crash in auth module")
    expect(matches[0].type).toBe("troubleshooting")
    expect(matches[0].confidence).toBeGreaterThan(0.3)
  })

  it("should identify troubleshooting from Chinese keywords", () => {
    const matches = identifyScenarios("排查生产环境内存泄漏")
    expect(matches[0].type).toBe("troubleshooting")
  })

  it("should identify doc_writing", () => {
    const matches = identifyScenarios("写一份 README 文档")
    expect(matches[0].type).toBe("doc_writing")
  })

  it("should identify refactoring", () => {
    const matches = identifyScenarios("重构 auth 模块并解耦依赖")
    expect(matches[0].type).toBe("refactoring")
  })

  it("should identify design_improve", () => {
    const matches = identifyScenarios("设计新的缓存架构方案")
    expect(matches[0].type).toBe("design_improve")
  })

  it("should identify code_change", () => {
    const matches = identifyScenarios("实现用户登录功能")
    expect(matches[0].type).toBe("code_change")
  })

  it("should fallback to code_change for empty input", () => {
    const matches = identifyScenarios("")
    expect(matches[0].type).toBe("code_change")
    expect(matches[0].confidence).toBe(0.3)
  })

  it("should fallback to code_change for ambiguous input", () => {
    const matches = identifyScenarios("do the thing")
    expect(matches[0].type).toBe("code_change")
  })

  it("should handle mixed scenarios with confidence scoring", () => {
    const matches = identifyScenarios("排查 bug 并重构代码")
    const types = matches.map(m => m.type)
    expect(types).toContain("troubleshooting")
    expect(types).toContain("refactoring")
  })

  it("should assign exclusive floor 0.35 when few matches", () => {
    // "crash" is exclusive, but only 1 match out of many keywords
    const matches = identifyScenarios("crash")
    const troubleshoot = matches.find(m => m.type === "troubleshooting")
    expect(troubleshoot).toBeDefined()
    expect(troubleshoot!.confidence).toBeGreaterThanOrEqual(0.35)
  })

  it("should not boost shared-only matches above 0.3 exclusive floor", () => {
    // "fix" and "问题" are shared only
    const matches = identifyScenarios("fix the problem")
    // Should have some confidence but no exclusive boost
    expect(matches.length).toBeGreaterThan(0)
  })
})

describe("resolveScenario", () => {
  it("should return ScenarioConfig with required fields", () => {
    const config = resolveScenario("fix the crash")
    expect(config.type).toBe("troubleshooting")
    expect(config.maxRoundsPerTask).toBeGreaterThan(0)
    expect(config.phases.length).toBe(5)
    expect(config.preferredSkills.length).toBeGreaterThan(0)
  })

  it("should use mixed scenario when confidence 0.3-0.7", () => {
    const config = resolveScenario("重构 auth 模块并修复 bug")
    // Should be either refactoring or troubleshooting depending on confidence
    expect(["refactoring", "troubleshooting"]).toContain(config.type)
    // Mixed scenario should include skills from both
    expect(config.preferredSkills.length).toBeGreaterThan(2)
  })

  it("should return code_change for empty input", () => {
    const config = resolveScenario("")
    expect(config.type).toBe("code_change")
  })
})

describe("getScenarioConfig", () => {
  it("should return all 5 scenario configs", () => {
    const types = ["code_change", "doc_writing", "troubleshooting", "design_improve", "refactoring"]
    for (const type of types) {
      const config = getScenarioConfig(type as any)
      expect(config.type).toBe(type)
      expect(config.phases.length).toBe(5)
      expect(config.maxRoundsPerTask).toBeGreaterThan(0)
      expect(config.convergenceThreshold).toBeGreaterThan(0)
    }
  })

  it("should have skillAffinity in each config", () => {
    const config = getScenarioConfig("code_change")
    expect(config.skillAffinity).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/goalScenario.test.ts -v`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 goalScenario.ts**

完整实现参见设计文档 §4.3。关键函数：

```typescript
// src/utils/goal/goalScenario.ts

export type ScenarioType = "code_change" | "doc_writing" | "troubleshooting" | "design_improve" | "refactoring"

export interface PhaseConfig {
  name: string
  weight: number
  required: boolean
  preferredSkills: string[]
}

export interface ScenarioConfig {
  type: ScenarioType
  phases: PhaseConfig[]
  maxRoundsPerTask: number
  convergenceThreshold: number
  requiredTools: string[]
  preferredSkills: string[]
  skillAffinity: Record<string, number>
}

export interface KeywordEntry {
  keyword: string
  weight: number
  type: "exclusive" | "shared"
}

export interface ScenarioMatch {
  type: ScenarioType
  confidence: number
  matchedKeywords: { exclusive: string[]; shared: string[] }
}

// SCENARIO_KEYWORDS, SCENARIO_CONFIGS, SKILL_SCENARIO_AFFINITY 从设计文档复制
// identifyScenarios(), selectScenarioConfig(), identifyTaskScenario()
// getScenarioConfig(), resolveScenario()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/goalScenario.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/goal/goalScenario.ts src/utils/goal/goalScenario.test.ts
git commit -m "feat: add goalScenario — scenario identification with confidence scoring"
```

---

## Task 3: ReAct 观测模块 — goalReActObserver.ts

**Files:**
- Create: `src/utils/goal/goalReActObserver.ts`
- Create: `src/utils/goal/goalReActObserver.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/utils/goal/goalReActObserver.test.ts
import { describe, it, expect } from "bun:test"
import { inferReActPhases, extractQualitySignals, observeTurn } from "./goalReActObserver.js"

describe("inferReActPhases", () => {
  it("should map Read/Grep/Glob to ANALYZE", () => {
    const obs = inferReActPhases(["Read", "Grep", "Glob"])
    expect(obs.mainPhase).toBe("ANALYZE")
    expect(obs.phases).toContain("ANALYZE")
  })

  it("should map Edit/Write to FIX", () => {
    const obs = inferReActPhases(["Edit", "Write"])
    expect(obs.mainPhase).toBe("FIX")
  })

  it("should map Bash to VERIFY", () => {
    const obs = inferReActPhases(["Bash"])
    expect(obs.mainPhase).toBe("VERIFY")
  })

  it("should map Agent to REVIEW", () => {
    const obs = inferReActPhases(["Agent"])
    expect(obs.mainPhase).toBe("REVIEW")
  })

  it("should map Skill to SKILL", () => {
    const obs = inferReActPhases(["Skill"])
    expect(obs.mainPhase).toBe("SKILL")
  })

  it("should determine mainPhase by frequency", () => {
    const obs = inferReActPhases(["Read", "Read", "Edit"])
    expect(obs.mainPhase).toBe("ANALYZE")
  })

  it("should handle unknown tools as ANALYZE", () => {
    const obs = inferReActPhases(["UnknownTool"])
    expect(obs.mainPhase).toBe("ANALYZE")
  })

  it("should handle empty tool calls", () => {
    const obs = inferReActPhases([])
    expect(obs.mainPhase).toBeNull()
    expect(obs.phases).toHaveLength(0)
  })

  it("should populate phaseTools map correctly", () => {
    const obs = inferReActPhases(["Read", "Edit", "Read"])
    const analyzeTools = obs.phaseTools.get("ANALYZE")
    expect(analyzeTools).toEqual(["Read", "Read"])
    const fixTools = obs.phaseTools.get("FIX")
    expect(fixTools).toEqual(["Edit"])
  })
})

describe("extractQualitySignals", () => {
  it("should detect errors", () => {
    const signals = extractQualitySignals("Error: build failed")
    expect(signals.hasErrors).toBe(true)
  })

  it("should detect success", () => {
    const signals = extractQualitySignals("Build successful, all tests pass")
    expect(signals.hasSuccess).toBe(true)
  })

  it("should detect progress", () => {
    const signals = extractQualitySignals("Created new file and fixed the bug")
    expect(signals.hasProgress).toBe(true)
  })

  it("should handle empty output", () => {
    const signals = extractQualitySignals("")
    expect(signals.hasErrors).toBe(false)
    expect(signals.hasSuccess).toBe(false)
    expect(signals.hasProgress).toBe(false)
  })

  it("should not confuse 'no error' with error", () => {
    const signals = extractQualitySignals("no error found")
    expect(signals.hasErrors).toBe(false)
  })

  it("should be case insensitive", () => {
    const signals = extractQualitySignals("ERROR: FAILED")
    expect(signals.hasErrors).toBe(true)
  })
})

describe("observeTurn", () => {
  it("should combine phase inference and quality signals", () => {
    const obs = observeTurn(["Edit", "Bash"], "build successful, fixed the bug")
    expect(obs.mainPhase).toBe("FIX") // Edit has more calls than Bash
    expect(obs.qualitySignals.hasSuccess).toBe(true)
    expect(obs.qualitySignals.hasProgress).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/goalReActObserver.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 goalReActObserver.ts**

从设计文档 §4.2 复制完整实现：`TOOL_PHASE_MAP`, `inferReActPhases`, `extractQualitySignals`, `observeTurn`。

**注意**: `phaseTools` 类型使用 `Map<ReActPhase, string[]>`，但 GoalRuntimeState 中存储为普通对象。`observeTurn` 返回后，编排器负责转换为可序列化格式。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/goalReActObserver.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/goal/goalReActObserver.ts src/utils/goal/goalReActObserver.test.ts
git commit -m "feat: add goalReActObserver — ReAct phase inference + quality signals"
```

---

## Task 4: 收敛检测模块 — goalConvergence.ts

**Files:**
- Create: `src/utils/goal/goalConvergence.ts`
- Create: `src/utils/goal/goalConvergence.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/utils/goal/goalConvergence.test.ts
import { describe, it, expect } from "bun:test"
import {
  computeInformationGain,
  computeQualityScore,
  computeChangeMagnitude,
  checkConvergence,
  updateConvergenceState,
  tokenize,
} from "./goalConvergence.js"
import type { TurnRecord } from "../../commands/goal/types.js"

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turnId: "turn-1",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    wallStartMs: Date.now(),
    wallEndMs: Date.now() + 1000,
    toolCallsSummary: [],
    outputSummary: "",
    hadObservableChanges: false,
    ...overrides,
  }
}

describe("tokenize", () => {
  it("should tokenize English text", () => {
    const tokens = tokenize("build successful all tests pass")
    expect(tokens.has("build")).toBe(true)
    expect(tokens.has("successful")).toBe(true)
    expect(tokens.has("tests")).toBe(true)
    // stop words removed
    expect(tokens.has("all")).toBe(false)
  })

  it("should tokenize Chinese text with bigrams", () => {
    const tokens = tokenize("重构认证模块")
    expect(tokens.has("重构")).toBe(true)
    expect(tokens.has("认证")).toBe(true)
    expect(tokens.has("模块")).toBe(true)
    // unigrams also present
    expect(tokens.has("重")).toBe(true)
  })

  it("should handle mixed Chinese/English", () => {
    const tokens = tokenize("修复 auth 模块的 bug")
    expect(tokens.has("修复")).toBe(true)
    expect(tokens.has("auth")).toBe(true)
    expect(tokens.has("bug")).toBe(true)
  })

  it("should return empty set for empty input", () => {
    const tokens = tokenize("")
    expect(tokens.size).toBe(0)
  })
})

describe("computeInformationGain", () => {
  it("should return 1.0 for first turn", () => {
    const gain = computeInformationGain(makeTurn(), undefined)
    expect(gain).toBe(1.0)
  })

  it("should return low gain for identical turns", () => {
    const prev = makeTurn({ toolCallsSummary: ["Read"], outputSummary: "same text" })
    const curr = makeTurn({ toolCallsSummary: ["Read"], outputSummary: "same text" })
    const gain = computeInformationGain(curr, prev)
    expect(gain).toBeLessThan(0.3)
  })

  it("should return high gain for novel tools", () => {
    const prev = makeTurn({ toolCallsSummary: ["Read"], hadObservableChanges: false })
    const curr = makeTurn({ toolCallsSummary: ["Edit", "Bash"], hadObservableChanges: true })
    const gain = computeInformationGain(curr, prev)
    expect(gain).toBeGreaterThan(0.5)
  })

  it("should handle both empty outputs as 0 novelty", () => {
    const prev = makeTurn({ outputSummary: "" })
    const curr = makeTurn({ outputSummary: "" })
    const gain = computeInformationGain(curr, prev)
    // toolNovelty=0, observable depends, outputNovelty=0
    expect(gain).toBeLessThan(0.5)
  })

  it("should handle one empty output as max novelty", () => {
    const prev = makeTurn({ outputSummary: "some text here" })
    const curr = makeTurn({ outputSummary: "" })
    const gain = computeInformationGain(curr, prev)
    // outputNovelty component should be 1.0
    expect(gain).toBeGreaterThan(0)
  })
})

describe("computeQualityScore", () => {
  it("should score build errors as 0", () => {
    const turn = makeTurn({ outputSummary: "build failed: syntax error" })
    const score = computeQualityScore(turn, "code_change")
    expect(score).toBeLessThan(50)
  })

  it("should score 'no error' as not-error", () => {
    const turn = makeTurn({ outputSummary: "no error found, all tests pass" })
    const score = computeQualityScore(turn, "code_change")
    expect(score).toBeGreaterThan(80)
  })

  it("should score 'no errors' as success", () => {
    const turn = makeTurn({ outputSummary: "compiled successfully, 0 errors" })
    const score = computeQualityScore(turn, "code_change")
    expect(score).toBeGreaterThan(80)
  })

  it("should return optimistic default for empty output", () => {
    const turn = makeTurn({ outputSummary: "" })
    const score = computeQualityScore(turn, "code_change")
    // No signals → optimistic defaults (60-70)
    expect(score).toBeGreaterThanOrEqual(50)
    expect(score).toBeLessThanOrEqual(80)
  })

  it("should detect regression", () => {
    const turn = makeTurn({ outputSummary: "regression detected, previously working code broke" })
    const score = computeQualityScore(turn, "refactoring")
    expect(score).toBeLessThan(50)
  })

  it("should weight differently per scenario", () => {
    const turn = makeTurn({ outputSummary: "all tests pass" })
    const codeScore = computeQualityScore(turn, "code_change")
    const docScore = computeQualityScore(turn, "doc_writing")
    // code_change weights testPassing higher than doc_writing
    expect(codeScore).not.toBe(docScore)
  })
})

describe("computeChangeMagnitude", () => {
  it("should return 0 when no observable changes", () => {
    const turn = makeTurn({ hadObservableChanges: false })
    expect(computeChangeMagnitude(turn)).toBe(0)
  })

  it("should score Write higher than Edit", () => {
    const writeTurn = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Write"] })
    const editTurn = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Edit"] })
    expect(computeChangeMagnitude(writeTurn)).toBeGreaterThan(computeChangeMagnitude(editTurn))
  })

  it("should score multiple tools higher than single", () => {
    const single = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Edit"] })
    const multi = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Edit", "Write", "Bash"] })
    expect(computeChangeMagnitude(multi)).toBeGreaterThan(computeChangeMagnitude(single))
  })
})

describe("checkConvergence", () => {
  it("should not converge with insufficient data", () => {
    const state = { informationGains: [0.5], qualityScores: [80], changeMagnitudes: [10], round: 1 }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(false)
  })

  it("should converge when IG low + quality high", () => {
    const state = {
      informationGains: [0.1, 0.1],
      qualityScores: [80, 82],
      changeMagnitudes: [2, 1],
      round: 4,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("info_gain_stable")
  })

  it("should not converge when quality below 80", () => {
    const state = {
      informationGains: [0.1, 0.1],
      qualityScores: [60, 62],
      changeMagnitudes: [2, 1],
      round: 4,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(false)
  })

  it("should converge at max_rounds with high quality", () => {
    const state = {
      informationGains: [0.5, 0.4, 0.3, 0.3, 0.2],
      qualityScores: [80, 82, 85, 83, 84],
      changeMagnitudes: [10, 8, 5, 3, 2],
      round: 5,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("max_rounds")
  })

  it("should report max_rounds_low_quality when quality below 80 at max", () => {
    const state = {
      informationGains: [0.5, 0.4, 0.3, 0.3, 0.2],
      qualityScores: [50, 55, 60, 58, 62],
      changeMagnitudes: [10, 8, 5, 3, 2],
      round: 5,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("max_rounds_low_quality")
  })

  it("should not converge on changesMinimal without hasHadChanges", () => {
    // All changeMagnitudes = 0 (pure analysis turns)
    const state = {
      informationGains: [0.3, 0.3],
      qualityScores: [80, 82],
      changeMagnitudes: [0, 0],
      round: 3,
    }
    const result = checkConvergence(state, 5)
    expect(result.converged).toBe(false)
  })

  it("should converge on changesMinimal when hasHadChanges=true", () => {
    const state = {
      informationGains: [0.3, 0.3],
      qualityScores: [80, 82],
      changeMagnitudes: [5, 0], // had changes before, now minimal
      round: 3,
    }
    const result = checkConvergence(state, 5)
    // qualityStable: |82-80|=2 < 8, qualityAbove: 82>=80, changesMinimal: 0<3, hasHadChanges: true
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("changes_minimal")
  })

  it("should adapt window size to maxRounds", () => {
    const state = {
      informationGains: [0.5, 0.4, 0.1, 0.1],
      qualityScores: [80, 82, 85, 83],
      changeMagnitudes: [10, 5, 2, 1],
      round: 3,
    }
    // maxRounds=3, window=min(5,3)=3, but we have 4 elements
    const result = checkConvergence(state, 3)
    // round(3) >= maxRounds(3) + qualityAbove → converged
    expect(result.converged).toBe(true)
    expect(result.reason).toBe("max_rounds")
  })
})

describe("updateConvergenceState", () => {
  it("should increment round and push values", () => {
    const state = { informationGains: [], qualityScores: [], changeMagnitudes: [], round: 0 }
    const turn = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Edit"] })
    updateConvergenceState(state, turn, undefined, "code_change", 5)
    expect(state.round).toBe(1)
    expect(state.informationGains.length).toBe(1)
    expect(state.qualityScores.length).toBe(1)
    expect(state.changeMagnitudes.length).toBe(1)
  })

  it("should trim to window size", () => {
    const state = {
      informationGains: [0.5, 0.4, 0.3, 0.2, 0.1],
      qualityScores: [80, 82, 85, 83, 84],
      changeMagnitudes: [10, 8, 5, 3, 2],
      round: 5,
    }
    const turn = makeTurn({ hadObservableChanges: true, toolCallsSummary: ["Read"] })
    updateConvergenceState(state, turn, makeTurn(), "code_change", 5)
    // Window = min(5, 5) = 5, after push should still be 5 (shift removes oldest)
    expect(state.informationGains.length).toBe(5)
    expect(state.round).toBe(6)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/goalConvergence.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 goalConvergence.ts**

从设计文档 §4.4 复制完整实现。关键函数：`tokenize`, `computeInformationGain`, `computeQualityScore`, `computeChangeMagnitude`, `checkConvergence`, `updateConvergenceState`。

**注意**:
- `SCENARIO_QUALITY_WEIGHTS` 是模块内常量
- `tokenize` 需要处理中文 bigram + unigram
- `checkConvergence` 中 `hasHadChanges = cm.some(m => m > 0)` 保护纯分析轮

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/goalConvergence.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/goal/goalConvergence.ts src/utils/goal/goalConvergence.test.ts
git commit -m "feat: add goalConvergence — 3D convergence detection with quality gate"
```

---

## Task 5: 统一错误追踪 — goalErrorTracker.ts

**Files:**
- Create: `src/utils/goal/goalErrorTracker.ts`
- Create: `src/utils/goal/goalErrorTracker.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/utils/goal/goalErrorTracker.test.ts
import { describe, it, expect, beforeEach } from "bun:test"
import {
  createTracker,
  recordError,
  resetCategory,
  resetOnProgress,
  shouldPause,
  getErrorCount,
} from "./goalErrorTracker.js"

describe("goalErrorTracker", () => {
  let tracker: ReturnType<typeof createTracker>

  beforeEach(() => {
    tracker = createTracker()
  })

  it("should create tracker with all categories at 0", () => {
    expect(getErrorCount(tracker, "runtime_exception")).toBe(0)
    expect(getErrorCount(tracker, "dead_turn")).toBe(0)
    expect(getErrorCount(tracker, "critical_analysis")).toBe(0)
  })

  it("should not pause with no errors", () => {
    expect(shouldPause(tracker)).toBe(false)
  })

  it("should pause after 3 runtime_exceptions", () => {
    recordError(tracker, "runtime_exception")
    expect(shouldPause(tracker)).toBe(false)
    recordError(tracker, "runtime_exception")
    expect(shouldPause(tracker)).toBe(false)
    recordError(tracker, "runtime_exception")
    expect(shouldPause(tracker)).toBe(true)
  })

  it("should pause after 5 dead_turns", () => {
    for (let i = 0; i < 5; i++) recordError(tracker, "dead_turn")
    expect(shouldPause(tracker)).toBe(true)
  })

  it("should pause after 3 critical_analyses", () => {
    for (let i = 0; i < 3; i++) recordError(tracker, "critical_analysis")
    expect(shouldPause(tracker)).toBe(true)
  })

  it("should reset specific category", () => {
    recordError(tracker, "runtime_exception")
    recordError(tracker, "runtime_exception")
    resetCategory(tracker, "runtime_exception")
    expect(getErrorCount(tracker, "runtime_exception")).toBe(0)
  })

  it("should reset dead_turn and runtime_exception on progress", () => {
    recordError(tracker, "dead_turn")
    recordError(tracker, "dead_turn")
    recordError(tracker, "runtime_exception")
    resetOnProgress(tracker)
    expect(getErrorCount(tracker, "dead_turn")).toBe(0)
    expect(getErrorCount(tracker, "runtime_exception")).toBe(0)
    // critical_analysis should NOT reset on progress
    // (it's reset by explicit resetCategory)
  })

  it("should track recoveryLayer", () => {
    expect(tracker.recoveryLayer).toBe("FIX_RETRY")
  })

  it("should serialize to JSON-compatible format (Record not Map)", () => {
    recordError(tracker, "runtime_exception")
    const json = JSON.stringify(tracker)
    const parsed = JSON.parse(json)
    expect(parsed.categories.runtime_exception.count).toBe(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/goalErrorTracker.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 goalErrorTracker.ts**

从设计文档 §4.5 复制完整实现。注意使用 `Record<ErrorCategory, ...>` 而非 `Map`。

```typescript
// src/utils/goal/goalErrorTracker.ts

export type ErrorCategory = "runtime_exception" | "dead_turn" | "critical_analysis"
export type RecoveryLayer = "FIX_RETRY" | "SKILL_RETRY" | "FULL_RESTART"

export interface ErrorCategoryCounter {
  count: number
  threshold: number
}

export interface UnifiedErrorTracker {
  categories: Record<ErrorCategory, ErrorCategoryCounter>
  recoveryLayer: RecoveryLayer
  fullRestartUsed: boolean
}

const DEFAULT_THRESHOLDS: Record<ErrorCategory, number> = {
  runtime_exception: 3,
  dead_turn: 5,
  critical_analysis: 3,
}

export function createTracker(): UnifiedErrorTracker {
  return {
    categories: {
      runtime_exception: { count: 0, threshold: DEFAULT_THRESHOLDS.runtime_exception },
      dead_turn: { count: 0, threshold: DEFAULT_THRESHOLDS.dead_turn },
      critical_analysis: { count: 0, threshold: DEFAULT_THRESHOLDS.critical_analysis },
    },
    recoveryLayer: "FIX_RETRY",
    fullRestartUsed: false,
  }
}

export function recordError(tracker: UnifiedErrorTracker, category: ErrorCategory): void {
  tracker.categories[category].count++
}

export function resetCategory(tracker: UnifiedErrorTracker, category: ErrorCategory): void {
  tracker.categories[category].count = 0
}

export function resetOnProgress(tracker: UnifiedErrorTracker): void {
  tracker.categories.dead_turn.count = 0
  tracker.categories.runtime_exception.count = 0
}

export function shouldPause(tracker: UnifiedErrorTracker): boolean {
  return Object.values(tracker.categories).some(c => c.count >= c.threshold)
}

export function getErrorCount(tracker: UnifiedErrorTracker, category: ErrorCategory): number {
  return tracker.categories[category].count
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/goalErrorTracker.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/goal/goalErrorTracker.ts src/utils/goal/goalErrorTracker.test.ts
git commit -m "feat: add goalErrorTracker — unified error counting with Record-based serialization"
```

---

## Task 6: 错误恢复模块 — goalErrorRecovery.ts

**Files:**
- Create: `src/utils/goal/goalErrorRecovery.ts`
- Create: `src/utils/goal/goalErrorRecovery.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/utils/goal/goalErrorRecovery.test.ts
import { describe, it, expect, beforeEach } from "bun:test"
import { handleVerifyFailure, handleReviewRejection, resetRecovery } from "./goalErrorRecovery.js"
import { createTracker, recordError } from "./goalErrorTracker.js"
import type { UnifiedErrorTracker } from "./goalErrorTracker.js"

describe("goalErrorRecovery", () => {
  let tracker: UnifiedErrorTracker

  beforeEach(() => {
    tracker = createTracker()
  })

  describe("handleVerifyFailure", () => {
    it("should retry at FIX_RETRY level", () => {
      const decision = handleVerifyFailure(tracker, "build failed")
      expect(decision.action).toBe("retry")
      expect(decision.layer).toBe("FIX_RETRY")
      expect(decision.recoveryPrompt).toBeDefined()
    })

    it("should escalate to SKILL_RETRY after 3 FIX_RETRY failures", () => {
      // Simulate 3 runtime exceptions (FIX_RETRY threshold)
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      const decision = handleVerifyFailure(tracker, "build failed")
      expect(decision.action).toBe("escalate")
      expect(decision.layer).toBe("SKILL_RETRY")
    })

    it("should escalate to FULL_RESTART after 3 SKILL_RETRY failures", () => {
      tracker.recoveryLayer = "SKILL_RETRY"
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      const decision = handleVerifyFailure(tracker, "build failed")
      expect(decision.action).toBe("escalate")
      expect(decision.layer).toBe("FULL_RESTART")
    })

    it("should pause after FULL_RESTART exhausted", () => {
      tracker.recoveryLayer = "FULL_RESTART"
      tracker.fullRestartUsed = true
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      recordError(tracker, "runtime_exception")
      const decision = handleVerifyFailure(tracker, "build failed")
      expect(decision.action).toBe("pause")
    })
  })

  describe("handleReviewRejection", () => {
    it("should retry with review feedback", () => {
      const decision = handleReviewRejection(tracker, "architecture concern")
      expect(decision.action).toBe("retry")
      expect(decision.recoveryPrompt).toContain("architecture concern")
    })
  })

  describe("resetRecovery", () => {
    it("should reset layer and error counts", () => {
      tracker.recoveryLayer = "SKILL_RETRY"
      recordError(tracker, "runtime_exception")
      recordError(tracker, "dead_turn")
      resetRecovery(tracker)
      expect(tracker.recoveryLayer).toBe("FIX_RETRY")
      expect(tracker.categories.runtime_exception.count).toBe(0)
      expect(tracker.categories.dead_turn.count).toBe(0)
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/goalErrorRecovery.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 goalErrorRecovery.ts**

从设计文档 §4.6 实现。三层恢复状态机：FIX_RETRY → SKILL_RETRY → FULL_RESTART → pause。

```typescript
// src/utils/goal/goalErrorRecovery.ts
import type { UnifiedErrorTracker, RecoveryLayer } from "./goalErrorTracker.js"
import { resetCategory, resetOnProgress, shouldPause } from "./goalErrorTracker.js"

export interface RecoveryDecision {
  action: "retry" | "escalate" | "pause" | "continue"
  layer: RecoveryLayer
  recoveryPrompt?: string
}

export function handleVerifyFailure(tracker: UnifiedErrorTracker, detail: string): RecoveryDecision {
  // Check if any category exceeded threshold → escalate
  const runtimeCount = tracker.categories.runtime_exception.count
  const threshold = tracker.categories.runtime_exception.threshold

  if (runtimeCount >= threshold) {
    if (tracker.recoveryLayer === "FIX_RETRY") {
      tracker.recoveryLayer = "SKILL_RETRY"
      resetCategory(tracker, "runtime_exception")
      return {
        action: "escalate",
        layer: "SKILL_RETRY",
        recoveryPrompt: `FIX_RETRY exhausted (3 failures). Escalating to SKILL_RETRY. Last error: ${detail}. Try invoking a different skill for this task.`,
      }
    }
    if (tracker.recoveryLayer === "SKILL_RETRY") {
      tracker.recoveryLayer = "FULL_RESTART"
      resetCategory(tracker, "runtime_exception")
      return {
        action: "escalate",
        layer: "FULL_RESTART",
        recoveryPrompt: `SKILL_RETRY exhausted. Escalating to FULL_RESTART. Last error: ${detail}. Re-analyze from scratch with a different approach.`,
      }
    }
    if (tracker.recoveryLayer === "FULL_RESTART") {
      if (tracker.fullRestartUsed) {
        return {
          action: "pause",
          layer: "FULL_RESTART",
          recoveryPrompt: `All recovery layers exhausted. Pausing goal. Last error: ${detail}`,
        }
      }
      tracker.fullRestartUsed = true
      resetCategory(tracker, "runtime_exception")
      return {
        action: "retry",
        layer: "FULL_RESTART",
        recoveryPrompt: `FULL_RESTART: Starting fresh. Last error: ${detail}. Re-read all relevant files and reconsider the approach.`,
      }
    }
  }

  // Normal retry at current layer
  return {
    action: "retry",
    layer: tracker.recoveryLayer,
    recoveryPrompt: `[${tracker.recoveryLayer}] Verification failed: ${detail}. Fix the specific issue and retry.`,
  }
}

export function handleReviewRejection(tracker: UnifiedErrorTracker, reason: string): RecoveryDecision {
  return {
    action: "retry",
    layer: tracker.recoveryLayer,
    recoveryPrompt: `[${tracker.recoveryLayer}] Review flagged: ${reason}. Address the concern before proceeding.`,
  }
}

export function resetRecovery(tracker: UnifiedErrorTracker): void {
  tracker.recoveryLayer = "FIX_RETRY"
  resetCategory(tracker, "runtime_exception")
  resetOnProgress(tracker)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/goalErrorRecovery.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/goal/goalErrorRecovery.ts src/utils/goal/goalErrorRecovery.test.ts
git commit -m "feat: add goalErrorRecovery — 3-layer recovery state machine"
```

---

## Task 7: 技能注册表扫描 — skillRegistry.ts

**Files:**
- Create: `src/utils/goal/skillRegistry.ts`
- Create: `src/utils/goal/skillRegistry.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/utils/goal/skillRegistry.test.ts
import { describe, it, expect } from "bun:test"
import { parseFrontmatter, parseTriggers } from "./skillRegistry.js"

describe("parseFrontmatter", () => {
  it("should parse YAML frontmatter", () => {
    const content = `---
name: test-skill
description: A test skill
trigger: test,debug
priority: 5
---
Body content here`
    const result = parseFrontmatter(content)
    expect(result.name).toBe("test-skill")
    expect(result.description).toBe("A test skill")
    expect(result.trigger).toBe("test,debug")
    expect(result.priority).toBe("5")
  })

  it("should handle missing frontmatter", () => {
    const result = parseFrontmatter("No frontmatter here")
    expect(result.name).toBeUndefined()
  })

  it("should handle empty frontmatter", () => {
    const content = `---
---
Body`
    const result = parseFrontmatter(content)
    expect(result.name).toBeUndefined()
  })

  it("should handle missing optional fields", () => {
    const content = `---
name: minimal-skill
---
Body`
    const result = parseFrontmatter(content)
    expect(result.name).toBe("minimal-skill")
    expect(result.description).toBeUndefined()
    expect(result.priority).toBeUndefined()
  })
})

describe("parseTriggers", () => {
  it("should parse comma-separated triggers", () => {
    expect(parseTriggers("test,debug,fix")).toEqual(["test", "debug", "fix"])
  })

  it("should trim whitespace", () => {
    expect(parseTriggers(" test , debug , fix ")).toEqual(["test", "debug", "fix"])
  })

  it("should handle empty string", () => {
    expect(parseTriggers("")).toEqual([])
  })

  it("should filter empty entries", () => {
    expect(parseTriggers("test,,debug")).toEqual(["test", "debug"])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/skillRegistry.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 skillRegistry.ts**

```typescript
// src/utils/goal/skillRegistry.ts

export interface SkillMetadata {
  name: string
  path: string
  description: string
  triggers: string[]
  priority: number
  conflictsWith: string[]
  lastModified: number
}

export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const lines = match[1].split("\n")
  const result: Record<string, string> = {}
  for (const line of lines) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key) result[key] = value
  }
  return result
}

export function parseTriggers(triggerStr: string): string[] {
  if (!triggerStr) return []
  return triggerStr.split(",").map(s => s.trim()).filter(Boolean)
}

let cachedSkills: SkillMetadata[] | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 30_000

export async function scanSkillRegistry(): Promise<SkillMetadata[]> {
  const { glob } = await import("glob")
  const fs = await import("fs/promises")
  const os = await import("os")
  const path = await import("path")

  const skillDir = path.join(os.homedir(), ".ola-cc", "skills")
  const pattern = path.join(skillDir, "*", "SKILL.md")
  const files = await glob(pattern)

  const results: SkillMetadata[] = []
  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf-8")
      const fm = parseFrontmatter(content)
      if (!fm.name) continue
      const stat = await fs.stat(filePath)
      results.push({
        name: fm.name,
        path: filePath,
        description: fm.description ?? "",
        triggers: parseTriggers(fm.trigger ?? ""),
        priority: parseInt(fm.priority ?? "0", 10) || 0,
        conflictsWith: (fm["conflicts-with"] ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
        lastModified: stat.mtimeMs,
      })
    } catch {
      // Skip corrupted files
    }
  }
  return results
}

export async function getSkillMetadata(): Promise<SkillMetadata[]> {
  if (cachedSkills && Date.now() - cacheTimestamp < CACHE_TTL_MS) return cachedSkills
  cachedSkills = await scanSkillRegistry()
  cacheTimestamp = Date.now()
  return cachedSkills
}

export function invalidateSkillCache(): void {
  cachedSkills = null
  cacheTimestamp = 0
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/skillRegistry.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/goal/skillRegistry.ts src/utils/goal/skillRegistry.test.ts
git commit -m "feat: add skillRegistry — SKILL.md frontmatter scanner with 30s cache"
```

---

## Task 8: 技能排名模块 — goalSkillRanker.ts

**Files:**
- Create: `src/utils/goal/goalSkillRanker.ts`
- Create: `src/utils/goal/goalSkillRanker.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/utils/goal/goalSkillRanker.test.ts
import { describe, it, expect } from "bun:test"
import { rankSkills, scoreSkill, extractTerms } from "./goalSkillRanker.js"
import type { SkillMetadata } from "./skillRegistry.js"
import type { ScenarioConfig } from "./goalScenario.js"

function makeSkill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: "test-skill",
    path: "/test/path",
    description: "A test skill for testing",
    triggers: ["test"],
    priority: 5,
    conflictsWith: [],
    lastModified: Date.now(),
    ...overrides,
  }
}

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    type: "code_change",
    phases: [],
    maxRoundsPerTask: 5,
    convergenceThreshold: 5,
    requiredTools: [],
    preferredSkills: [],
    skillAffinity: {},
    ...overrides,
  }
}

describe("extractTerms", () => {
  it("should extract lowercase terms", () => {
    const terms = extractTerms("Fix the Auth Module Bug")
    expect(terms).toContain("fix")
    expect(terms).toContain("auth")
    expect(terms).toContain("module")
    expect(terms).toContain("bug")
  })

  it("should filter stop words", () => {
    const terms = extractTerms("the quick brown fox")
    expect(terms).not.toContain("the")
    expect(terms).toContain("quick")
  })
})

describe("scoreSkill", () => {
  it("should score name match highly", () => {
    const skill = makeSkill({ name: "systematic-debugging" })
    const score = scoreSkill(skill, ["debugging"], makeScenario())
    expect(score).toBeGreaterThan(50)
  })

  it("should score trigger match", () => {
    const skill = makeSkill({ triggers: ["debug", "fix"] })
    const score = scoreSkill(skill, ["debug"], makeScenario())
    expect(score).toBeGreaterThan(10)
  })

  it("should score description match", () => {
    const skill = makeSkill({ description: "helps with debugging code" })
    const score = scoreSkill(skill, ["debugging"], makeScenario())
    expect(score).toBeGreaterThan(5)
  })

  it("should apply scenario affinity bonus", () => {
    const skill = makeSkill({ name: "systematic-debugging" })
    const scenario = makeScenario({
      type: "troubleshooting",
      skillAffinity: { "systematic-debugging": 0.9 },
    })
    const score = scoreSkill(skill, ["unrelated"], scenario)
    expect(score).toBeGreaterThan(30) // affinity * 40
  })

  it("should include priority bonus", () => {
    const highPriority = makeSkill({ priority: 10 })
    const lowPriority = makeSkill({ priority: 1 })
    const s1 = scoreSkill(highPriority, [], makeScenario())
    const s2 = scoreSkill(lowPriority, [], makeScenario())
    expect(s1).toBeGreaterThan(s2)
  })
})

describe("rankSkills", () => {
  it("should return skills sorted by score descending", () => {
    const skills = [
      makeSkill({ name: "low-match" }),
      makeSkill({ name: "systematic-debugging" }),
      makeSkill({ name: "test-driven-development" }),
    ]
    const scenario = makeScenario({ type: "troubleshooting" })
    const ranked = rankSkills("debug the crash", skills, scenario, 3)
    expect(ranked[0].skill.name).toBe("systematic-debugging")
  })

  it("should respect limit", () => {
    const skills = Array.from({ length: 20 }, (_, i) => makeSkill({ name: `skill-${i}` }))
    const ranked = rankSkills("test", skills, makeScenario(), 5)
    expect(ranked.length).toBeLessThanOrEqual(5)
  })

  it("should handle empty query", () => {
    const skills = [makeSkill()]
    const ranked = rankSkills("", skills, makeScenario(), 5)
    expect(ranked.length).toBe(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/goalSkillRanker.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 goalSkillRanker.ts**

从设计文档 §4.7 复制完整实现。`SKILL_SCENARIO_AFFINITY` 常量从 §4.3 场景-技能亲和矩阵复制。

```typescript
// src/utils/goal/goalSkillRanker.ts
import type { SkillMetadata } from "./skillRegistry.js"
import type { ScenarioConfig } from "./goalScenario.js"

const STOP_WORDS = new Set(["the","a","an","is","are","was","were","be","been","have","has","had","do","does","did","will","would","could","should","may","might","can","shall","i","you","he","she","it","we","they","this","that","to","of","in","for","on","with","at","by","from","as","not","or","and","but","if","then","so"])

export interface RankedSkill {
  skill: SkillMetadata
  score: number
}

export function extractTerms(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(w => w.length > 1 && !STOP_WORDS.has(w))
}

export function scoreSkill(skill: SkillMetadata, terms: string[], scenario: ScenarioConfig): number {
  let score = 0
  const nameLower = skill.name.toLowerCase()
  const descLower = skill.description.toLowerCase()

  // name match (weight 100)
  if (terms.some(t => nameLower.includes(t))) score += 100

  // trigger match (weight 12)
  for (const trigger of skill.triggers) {
    if (terms.some(t => trigger.toLowerCase().includes(t))) score += 12
  }

  // description match (weight 8)
  if (terms.some(t => descLower.includes(t))) score += 8

  // scenario affinity (weight 40)
  const affinity = SKILL_SCENARIO_AFFINITY[skill.name]?.[scenario.type] ?? 0
  score += affinity * 40

  // priority bonus
  score += (skill.priority / 10) * 20

  return score
}

export function rankSkills(
  query: string,
  availableSkills: SkillMetadata[],
  scenario: ScenarioConfig,
  limit: number = 5,
): RankedSkill[] {
  const terms = extractTerms(query)
  return availableSkills
    .map(skill => ({ skill, score: scoreSkill(skill, terms, scenario) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// SKILL_SCENARIO_AFFINITY from design doc §4.3
const SKILL_SCENARIO_AFFINITY: Record<string, Record<string, number>> = {
  "systematic-debugging":    { code_change: 0.3, doc_writing: 0.0, troubleshooting: 1.0, design_improve: 0.1, refactoring: 0.3 },
  "brainstorming":           { code_change: 0.4, doc_writing: 0.3, troubleshooting: 0.1, design_improve: 1.0, refactoring: 0.2 },
  "test-driven-development": { code_change: 0.9, doc_writing: 0.0, troubleshooting: 0.5, design_improve: 0.1, refactoring: 0.8 },
  "verification-before-completion": { code_change: 0.8, doc_writing: 0.4, troubleshooting: 0.6, design_improve: 0.3, refactoring: 0.8 },
  "requesting-code-review":  { code_change: 0.7, doc_writing: 0.3, troubleshooting: 0.4, design_improve: 0.4, refactoring: 0.7 },
  "writing-plans":           { code_change: 0.5, doc_writing: 0.5, troubleshooting: 0.2, design_improve: 0.8, refactoring: 0.6 },
  "executing-plans":         { code_change: 0.7, doc_writing: 0.3, troubleshooting: 0.2, design_improve: 0.4, refactoring: 0.6 },
  "design-constraint":       { code_change: 0.5, doc_writing: 0.2, troubleshooting: 0.2, design_improve: 0.9, refactoring: 0.7 },
  "design-doc-reviewer":     { code_change: 0.2, doc_writing: 0.8, troubleshooting: 0.1, design_improve: 0.9, refactoring: 0.3 },
  "code-design-analyzer":    { code_change: 0.4, doc_writing: 0.1, troubleshooting: 0.5, design_improve: 0.8, refactoring: 0.8 },
  "task-decomposer":         { code_change: 0.6, doc_writing: 0.3, troubleshooting: 0.3, design_improve: 0.7, refactoring: 0.5 },
  "orion-deep-audit":        { code_change: 0.5, doc_writing: 0.0, troubleshooting: 0.8, design_improve: 0.4, refactoring: 0.7 },
  "orion-repairing":         { code_change: 0.5, doc_writing: 0.0, troubleshooting: 0.7, design_improve: 0.1, refactoring: 0.4 },
  "orion-reviewing":         { code_change: 0.6, doc_writing: 0.2, troubleshooting: 0.4, design_improve: 0.4, refactoring: 0.6 },
  "feature-dev:feature-dev": { code_change: 0.9, doc_writing: 0.1, troubleshooting: 0.2, design_improve: 0.4, refactoring: 0.4 },
  "simplify":                { code_change: 0.3, doc_writing: 0.0, troubleshooting: 0.2, design_improve: 0.2, refactoring: 0.9 },
  "docs-navigator":          { code_change: 0.1, doc_writing: 0.7, troubleshooting: 0.0, design_improve: 0.4, refactoring: 0.1 },
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/goalSkillRanker.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/goal/goalSkillRanker.ts src/utils/goal/goalSkillRanker.test.ts
git commit -m "feat: add goalSkillRanker — scenario-aware skill ranking with affinity matrix"
```

---

## Task 9: 编排器整合 — goalOrchestrator.ts

**Files:**
- Create: `src/utils/goal/goalOrchestrator.ts`
- Create: `src/utils/goal/goalOrchestrator.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/utils/goal/goalOrchestrator.test.ts
import { describe, it, expect, beforeEach } from "bun:test"
import { createOrchestratorDecision, buildTurnAnalysisContext } from "./goalOrchestrator.js"

describe("goalOrchestrator", () => {
  describe("createOrchestratorDecision", () => {
    it("should continue when all checks pass", () => {
      const decision = createOrchestratorDecision({
        goal: { status: "active" },
        convergence: { converged: false },
        errorTracker: { shouldPause: false },
        allTasksDone: false,
      })
      expect(decision.action).toBe("continue")
      expect(decision.prompt).toBeDefined()
    })

    it("should pause when error tracker says pause", () => {
      const decision = createOrchestratorDecision({
        goal: { status: "active" },
        convergence: { converged: false },
        errorTracker: { shouldPause: true, reason: "3 consecutive errors" },
        allTasksDone: false,
      })
      expect(decision.action).toBe("pause")
      expect(decision.reason).toContain("error")
    })

    it("should continue with completion prompt when all tasks done", () => {
      const decision = createOrchestratorDecision({
        goal: { status: "active" },
        convergence: { converged: false },
        errorTracker: { shouldPause: false },
        allTasksDone: true,
      })
      expect(decision.action).toBe("continue")
      expect(decision.prompt).toContain("complete")
    })

    it("should handle convergence with high quality", () => {
      const decision = createOrchestratorDecision({
        goal: { status: "active" },
        convergence: { converged: true, reason: "info_gain_stable" },
        errorTracker: { shouldPause: false },
        allTasksDone: false,
      })
      expect(decision.action).toBe("continue")
      expect(decision.prompt).toContain("ADVANCE")
    })

    it("should pause on max_rounds_low_quality", () => {
      const decision = createOrchestratorDecision({
        goal: { status: "active" },
        convergence: { converged: true, reason: "max_rounds_low_quality" },
        errorTracker: { shouldPause: false },
        allTasksDone: false,
      })
      expect(decision.action).toBe("pause")
      expect(decision.reason).toContain("low quality")
    })

    it("should not continue when goal is paused", () => {
      const decision = createOrchestratorDecision({
        goal: { status: "paused" },
        convergence: { converged: false },
        errorTracker: { shouldPause: false },
        allTasksDone: false,
      })
      expect(decision.action).toBe("pause")
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/goalOrchestrator.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 goalOrchestrator.ts**

```typescript
// src/utils/goal/goalOrchestrator.ts

import type { Goal, GoalRuntimeState, TurnRecord } from "../../commands/goal/types.js"
import type { ScenarioConfig, ScenarioType } from "./goalScenario.js"
import { resolveScenario } from "./goalScenario.js"
import { observeTurn } from "./goalReActObserver.js"
import { checkConvergence, updateConvergenceState } from "./goalConvergence.js"
import { createTracker, recordError, resetOnProgress, shouldPause as trackerShouldPause } from "./goalErrorTracker.js"
import { handleVerifyFailure, resetRecovery } from "./goalErrorRecovery.js"
import type { TodoItem } from "../todo/types.js"

export interface OrchestratorDecision {
  action: "continue" | "pause" | "skip_task" | "retry"
  prompt?: string
  reason: string
  pauseReason?: string
}

export interface TurnAnalysisContext {
  goal: Goal
  runtime: Readonly<GoalRuntimeState>
  currentTurn: TurnRecord | undefined
  previousTurn: TurnRecord | undefined
  todos: TodoItem[]
  currentTask: string | undefined
  observation: ReturnType<typeof observeTurn>
  scenarioConfig: ScenarioConfig
}

/**
 * Initialize orchestrator state on goal_created.
 * Called from goalRuntime.ts when a new goal is created.
 */
export function initOrchestratorState(
  runtime: GoalRuntimeState,
  objective: string,
): void {
  const config = resolveScenario(objective)
  runtime.currentScenario = config.type
  runtime.convergenceState = {
    informationGains: [],
    qualityScores: [],
    changeMagnitudes: [],
    round: 0,
  }
  runtime.errorTracker = createTracker()
}

/**
 * Process a turn through the orchestrator.
 * Returns an OrchestratorDecision that goalRuntime uses to update state.
 *
 * Pure function contract: does NOT modify GoalRuntimeState directly.
 * goalRuntime is responsible for applying the decision.
 */
export function processTurn(
  ctx: TurnAnalysisContext,
): OrchestratorDecision {
  const { goal, runtime, currentTurn, previousTurn, todos, observation, scenarioConfig } = ctx

  // Guard: goal not active
  if (goal.status !== "active") {
    return { action: "pause", reason: `Goal status is ${goal.status}` }
  }

  // Update convergence state
  if (runtime.convergenceState && currentTurn) {
    updateConvergenceState(
      runtime.convergenceState,
      currentTurn,
      previousTurn,
      scenarioConfig.type as ScenarioType,
      scenarioConfig.maxRoundsPerTask,
    )
  }

  // Check convergence
  const convergenceResult = runtime.convergenceState
    ? checkConvergence(runtime.convergenceState, scenarioConfig.maxRoundsPerTask)
    : { converged: false }

  // Check error tracker
  const tracker = runtime.errorTracker
  const errorPause = tracker ? trackerShouldPause(tracker) : false

  // Check task completion
  const allTasksDone = todos.length > 0 && todos.every(t => t.status === "completed")

  return createOrchestratorDecision({
    goal: { status: goal.status },
    convergence: convergenceResult,
    errorTracker: errorPause ? { shouldPause: true, reason: "Error threshold exceeded" } : { shouldPause: false },
    allTasksDone,
    recoveryLayer: tracker?.recoveryLayer,
  })
}

/**
 * Decision matrix — pure function, easy to test.
 */
export function createOrchestratorDecision(input: {
  goal: { status: string }
  convergence: { converged: boolean; reason?: string }
  errorTracker: { shouldPause: boolean; reason?: string }
  allTasksDone: boolean
  recoveryLayer?: string
}): OrchestratorDecision {
  // Priority 1: Goal not active
  if (input.goal.status !== "active") {
    return { action: "pause", reason: `Goal status is ${input.goal.status}` }
  }

  // Priority 2: Error tracker says pause
  if (input.errorTracker.shouldPause) {
    return {
      action: "pause",
      reason: input.errorTracker.reason ?? "Error threshold exceeded",
      pauseReason: `[Goal auto-paused] ${input.errorTracker.reason ?? "Consecutive errors"}. Use /goal resume to continue.`,
    }
  }

  // Priority 3: All tasks done
  if (input.allTasksDone) {
    return {
      action: "continue",
      prompt: 'All tasks are completed. Call update_goal(status: "complete", summary: "...") to finish the goal.',
      reason: "all_tasks_completed",
    }
  }

  // Priority 4: Convergence reached
  if (input.convergence.converged) {
    if (input.convergence.reason === "max_rounds_low_quality") {
      return {
        action: "pause",
        reason: "Reached max rounds with low quality — pausing for reassessment",
        pauseReason: "[Goal auto-paused] Max rounds reached but quality is below threshold. Consider simplifying the task or breaking it into smaller sub-tasks.",
      }
    }
    // High quality convergence → advance to next task
    return {
      action: "continue",
      prompt: "Current task converged successfully. Mark it completed via TodoWrite and start the next pending task.",
      reason: `converged: ${input.convergence.reason}`,
    }
  }

  // Priority 5: Recovery escalation
  if (input.recoveryLayer && input.recoveryLayer !== "FIX_RETRY") {
    return {
      action: "retry",
      reason: `Recovery layer: ${input.recoveryLayer}`,
      prompt: `[${input.recoveryLayer}] Try a different approach for the current task.`,
    }
  }

  // Default: continue with standard prompt
  return {
    action: "continue",
    prompt: undefined, // goalRuntime will use buildContinuationPrompt
    reason: "continuing",
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/goalOrchestrator.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/goal/goalOrchestrator.ts src/utils/goal/goalOrchestrator.test.ts
git commit -m "feat: add goalOrchestrator — pure-function decision matrix integrating all modules"
```

---

## Task 10: goalRuntime.ts 集成 — 委托编排器

**Files:**
- Modify: `src/utils/goal/goalRuntime.ts`

- [ ] **Step 1: 写失败测试 — 验证 orchestrator 集成点存在**

在现有测试或新测试中验证 `processGoalRuntimeEvent` 的 `goal_created` 事件初始化 orchestrator 状态：

```typescript
// src/utils/goal/goalRuntime.orchestrator.test.ts
import { describe, it, expect } from "bun:test"
import { processGoalRuntimeEvent } from "./goalRuntime.js"
import type { Goal, GoalRuntimeState } from "../../commands/goal/types.js"
import { ThreadGoalStatus } from "../../commands/goal/types.js"

function makeGoal(): Goal {
  return {
    id: "test-1", threadId: "t-1", objective: "fix the crash",
    status: ThreadGoalStatus.Active, tokenBudget: null, tokensUsed: 0,
    timeUsedSeconds: 0, createdAt: Date.now(), updatedAt: Date.now(),
    totalApiTokens: 0, totalApiWallMs: 0, mode: "standard", autoEdit: false,
  }
}

function makeRuntime(): GoalRuntimeState {
  return {
    accounting: { turn: null, wallClock: { lastAccountedAt: 0, activeGoalId: null } },
    budgetLimitReportedGoalId: null, continuationTurnId: null,
    turnBuffer: [], totalApiTokens: 0, totalApiWallMs: 0,
    consecutiveErrors: 0, turnsWithNoChanges: 0,
    _currentTurnWallStartMs: 0, _toolCallsThisTurn: [], consecutiveCritical: 0,
  }
}

describe("goalRuntime orchestrator integration", () => {
  it("should initialize orchestrator state on goal_created", () => {
    const runtime = makeRuntime()
    const goal = makeGoal()
    const updatedGoals: Goal[] = []
    const injectedPrompts: string[] = []

    processGoalRuntimeEvent(
      { type: "goal_created", goal },
      {
        goal, runtime,
        currentTokenUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
        injectPrompt: async (p) => injectedPrompts.push(p),
        updateGoal: (g) => updatedGoals.push(g),
      },
    )

    expect(runtime.currentScenario).toBeDefined()
    expect(runtime.convergenceState).toBeDefined()
    expect(runtime.errorTracker).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/goalRuntime.orchestrator.test.ts -v`
Expected: FAIL — orchestrator 状态未初始化

- [ ] **Step 3: 修改 goalRuntime.ts**

**3a. 添加 import**

在文件顶部添加：

```typescript
import { initOrchestratorState, processTurn } from "./goalOrchestrator.js"
import { resolveScenario } from "./goalScenario.js"
import { observeTurn } from "./goalReActObserver.js"
import { recordError, resetOnProgress, shouldPause } from "./goalErrorTracker.js"
import { handleVerifyFailure, resetRecovery } from "./goalErrorRecovery.js"
```

**3b. goal_created 事件中初始化 orchestrator**

在 `goal_created` case 中，`runtime.consecutiveCritical = 0` 之后添加：

```typescript
// Initialize orchestrator state
initOrchestratorState(runtime, event.goal.objective)
```

**3c. turn_finished 中委托决策**

在 `turn_finished` case 中，将决策逻辑委托给 orchestrator。关键改动：

1. 在记录 turnBuffer 之后，调用 `observeTurn` 获取观测结果
2. 存储到 `runtime.lastObservation`
3. 调用 `processTurn` 获取 decision
4. 根据 decision.action 执行状态更新

```typescript
// 在 turnBuffer 记录之后（~line 522），添加：
// ReAct observation
const toolCallsThisTurnForObs = runtime._toolCallsThisTurn ?? []
const observation = observeTurn(toolCallsThisTurnForObs, context.outputSummary ?? "")
// Convert Map to serializable object for storage
runtime.lastObservation = {
  mainPhase: observation.mainPhase,
  phases: observation.phases,
  qualitySignals: observation.qualitySignals,
}

// Orchestrator decision
const scenarioConfig = resolveScenario(goal.objective)
const prevTurn = runtime.turnBuffer.length >= 2
  ? runtime.turnBuffer[runtime.turnBuffer.length - 2]
  : undefined
const currentTurnRecord = runtime.turnBuffer[runtime.turnBuffer.length - 1]
const allTodos = context.getTodos?.() ?? []
const currentGoalTasks = context.getGoalTasks?.()
const currentTodos = context.getTodos?.()
const inProgressGoalTask = currentGoalTasks?.find(t => t.status === "in_progress")
const inProgressTodo = currentTodos?.find(t => t.status === "in_progress")
const currentTaskContent = inProgressGoalTask?.content ?? inProgressTodo?.content

const decision = processTurn({
  goal, runtime,
  currentTurn: currentTurnRecord,
  previousTurn: prevTurn,
  todos: allTodos,
  currentTask: currentTaskContent,
  observation,
  scenarioConfig,
})

// Apply decision
if (decision.action === "pause") {
  const pausedGoal = { ...goal, status: Status.Paused, updatedAt: Date.now(), pauseReason: decision.pauseReason ?? decision.reason }
  context.updateGoal(pausedGoal)
  runtime.pendingAnalysis = undefined
  disposeGoalMemory(goal.id)
  return { shouldContinue: false, injectedPrompt: decision.pauseReason ?? decision.reason }
}

if (decision.action === "continue" && decision.prompt) {
  return { shouldContinue: true, injectedPrompt: decision.prompt }
}

// Default: use standard continuation prompt
```

**3d. 删除废弃代码**

删除 `autoProgressTasks` 函数（lines 178-219）和 `autoAdvanceGoalTasks` 函数（lines 234-267），以及 `turn_started` 中对它们的调用（lines 309-326）。

**3e. hadObservableChanges 语义重定义**

修改 line 429 的 `hadObservableChanges` 计算：

```typescript
// 修改前
const hadObservableChanges = outputGrew || toolCallsThisTurn.length > 0

// 修改后
const WRITE_TOOLS = new Set(["Write", "FileWrite", "Edit", "FileEdit"])
const hasFileSystemChanges = toolCallsThisTurn.some(t => WRITE_TOOLS.has(t))
const hadObservableChanges = hasFileSystemChanges || (outputGrew && (context.currentTokenUsage?.outputTokens ?? 0) > 100)
```

**3f. catch 块中使用 errorTracker**

修改 catch 块（lines 704-727）使用 errorTracker：

```typescript
} catch (error) {
  console.error("[goalRuntime] Error processing event:", error)
  const { goal, runtime } = context
  if (goal && runtime) {
    // Use error tracker if available, fallback to legacy counter
    if (runtime.errorTracker) {
      recordError(runtime.errorTracker, "runtime_exception")
      if (shouldPause(runtime.errorTracker)) {
        const pausedGoal = { ...goal, status: Status.Paused, updatedAt: Date.now() }
        context.updateGoal(pausedGoal)
        runtime.pendingAnalysis = undefined
        return { shouldContinue: false, injectedPrompt: `[Goal paused due to errors] 3 consecutive errors encountered. Use /goal resume to continue.` }
      }
    } else {
      // Legacy fallback
      runtime.consecutiveErrors = (runtime.consecutiveErrors ?? 0) + 1
      if (runtime.consecutiveErrors >= 3) {
        const pausedGoal = { ...goal, status: Status.Paused, updatedAt: Date.now() }
        context.updateGoal(pausedGoal)
        runtime.pendingAnalysis = undefined
        return { shouldContinue: false, injectedPrompt: `[Goal paused due to errors] 3 consecutive errors encountered. Use /goal resume to continue.` }
      }
    }
  }
  return { shouldContinue: true }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/goalRuntime.orchestrator.test.ts -v`
Expected: PASS

- [ ] **Step 5: 运行所有 goal 测试**

Run: `bun test src/utils/goal/ -v`
Expected: 所有测试通过

- [ ] **Step 6: 验证构建**

Run: `bun run build:dev 2>&1 | tail -5`
Expected: 构建成功

- [ ] **Step 7: Commit**

```bash
git add src/utils/goal/goalRuntime.ts src/utils/goal/goalRuntime.orchestrator.test.ts
git commit -m "feat: integrate orchestrator into goalRuntime — delegate turn_finished decisions, remove dead code"
```

---

## Task 11: 熔断器配置 — 场景特定阈值

**Files:**
- Modify: `src/utils/goal/goalOrchestrator.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// 在 goalOrchestrator.test.ts 中添加
describe("circuit breaker", () => {
  it("should have scenario-specific thresholds", () => {
    const { SCENARIO_CIRCUIT_BREAKER } = require("./goalOrchestrator.js")
    expect(SCENARIO_CIRCUIT_BREAKER.code_change.maxPerTask).toBe(5)
    expect(SCENARIO_CIRCUIT_BREAKER.troubleshooting.maxPerTask).toBe(8)
    expect(SCENARIO_CIRCUIT_BREAKER.doc_writing.maxPerTask).toBe(3)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/goal/goalOrchestrator.test.ts -v -t "circuit breaker"`
Expected: FAIL

- [ ] **Step 3: 实现熔断器**

在 `goalOrchestrator.ts` 中添加：

```typescript
export const SCENARIO_CIRCUIT_BREAKER: Record<string, { maxPerTask: number; timeoutMs: number }> = {
  code_change:     { maxPerTask: 5,  timeoutMs: 20 * 60 * 1000 },
  doc_writing:     { maxPerTask: 3,  timeoutMs: 15 * 60 * 1000 },
  troubleshooting: { maxPerTask: 8,  timeoutMs: 45 * 60 * 1000 },
  design_improve:  { maxPerTask: 5,  timeoutMs: 25 * 60 * 1000 },
  refactoring:     { maxPerTask: 6,  timeoutMs: 30 * 60 * 1000 },
}
```

在 `processTurn` 中集成熔断器检查：

```typescript
// Check circuit breaker
const breaker = SCENARIO_CIRCUIT_BREAKER[scenarioConfig.type]
if (runtime.convergenceState && runtime.convergenceState.round >= breaker.maxPerTask) {
  return {
    action: "skip_task",
    reason: `Circuit breaker: ${runtime.convergenceState.round} rounds exceeded max ${breaker.maxPerTask} for ${scenarioConfig.type}`,
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/goal/goalOrchestrator.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/goal/goalOrchestrator.ts
git commit -m "feat: add scenario-specific circuit breakers to orchestrator"
```

---

## Task 12: 验证完整构建 + 全量测试

- [ ] **Step 1: 运行所有 goal 模块测试**

Run: `bun test src/utils/goal/ -v`
Expected: 所有测试通过（goalMemory + goalScenario + goalReActObserver + goalConvergence + goalErrorTracker + goalErrorRecovery + goalSkillRanker + skillRegistry + goalOrchestrator + goalRuntime）

- [ ] **Step 2: 验证生产构建**

Run: `bun run build:dev 2>&1 | tail -10`
Expected: 构建成功，无类型错误

- [ ] **Step 3: 运行 smoke test**

Run: `bun run dev --help`
Expected: 正常输出帮助信息

- [ ] **Step 4: Final commit (如果有遗漏)**

```bash
git status
# 如果有未提交的文件
git add -A && git commit -m "chore: verify all orchestrator modules build and test correctly"
```

---

## Self-Review Checklist

- [ ] 所有 spec §4.2-§4.12 的模块都有对应 Task
- [ ] 所有 spec §7 测试策略的测试用例都被覆盖
- [ ] GoalRuntimeState 新字段使用 `Record` 而非 `Map`（兼容 DeepImmutable）
- [ ] GoalTask.status 包含 "skipped"
- [ ] hadObservableChanges 语义重定义已完成
- [ ] autoProgressTasks / autoAdvanceGoalTasks 废弃代码已删除
- [ ] catch 块使用 errorTracker
- [ ] 所有新模块都是纯函数（不修改外部状态）
- [ ] orchestrator 不直接修改 GoalRuntimeState（单一写入者原则）
- [ ] 中文 bigram 分词已实现
- [ ] "no error" 负向环视已实现
- [ ] 纯分析轮 hasHadChanges 保护已实现
