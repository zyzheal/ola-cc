# ReAct Observer + Skills-Tools 适配方案

> 日期: 2026-05-28
> 状态: Draft
> 关联: goal-react-orchestrator-design.md

---

## 1. ReAct 可观测协议 (ReActObserver)

### 1.1 问题

`goalRuntime.ts` 的 `turn_finished` 事件只记录 `toolCallsSummary: string[]`（工具名列表）和 `outputSummary?: string`（前 200 字符），无法区分模型正在执行哪个 ReAct 阶段。收敛检测、场景感知编排、错误恢复都需要知道当前阶段。

### 1.2 接口定义

```typescript
// src/utils/goal/reactObserver.ts

/**
 * ReAct 阶段枚举。
 * 单轮可涉及多个阶段（模型并行调用 Read+Bash）。
 */
export type ReActPhase =
  | 'ANALYZE'   // Read, Grep, Glob, codegraph, grok
  | 'SKILL'     // SkillTool 调用
  | 'REVIEW'    // Agent 子调用
  | 'FIX'       // Edit, Write, FileEdit, FileWrite
  | 'VERIFY'    // Bash（含 build/test 命令）
  | 'UNKNOWN'   // 无法归类

/**
 * 单轮 ReAct 观测结果。
 */
export interface ReActTurnObservation {
  /** 本轮涉及的阶段（按出现顺序去重） */
  phases: ReActPhase[]
  /** 主阶段：出现次数最多的阶段 */
  primaryPhase: ReActPhase
  /** 各阶段的工具调用映射 */
  phaseToolMap: Map<ReActPhase, string[]>
  /** 从输出提取的质量信号 */
  qualitySignals: QualitySignals
  /** 轮次序号（从 1 开始） */
  turnIndex: number
}

/**
 * 从输出文本提取的质量信号。
 */
export interface QualitySignals {
  /** 是否包含错误指示 */
  hasError: boolean
  /** 是否包含成功指示 */
  hasSuccess: boolean
  /** 检测到的错误模式列表 */
  errorPatterns: string[]
  /** 检测到的成功模式列表 */
  successPatterns: string[]
  /** 置信度 (0-1)，基于信号数量 */
  confidence: number
}

/**
 * 质量信号提取的模式定义。
 */
const ERROR_PATTERNS = [
  'error', 'failed', 'failure', 'cannot', 'unable',
  'exception', 'crash', 'broken', 'undefined is not',
  'type error', 'syntax error', 'reference error',
  'build failed', 'test failed', 'compilation error',
] as const

const SUCCESS_PATTERNS = [
  'passed', 'success', 'completed', 'done', 'fixed',
  'all tests pass', 'build succeeded', 'no errors',
  'verified', 'confirmed', 'working correctly',
] as const

// ============================================================
// 工具名 → 阶段映射表
// ============================================================

/**
 * 工具名到 ReAct 阶段的映射。
 * 新增工具只需在此表添加一行。
 */
const TOOL_PHASE_MAP: Record<string, ReActPhase> = {
  // ANALYZE: 阅读、搜索、知识图谱
  Read: 'ANALYZE',
  FileRead: 'ANALYZE',
  Grep: 'ANALYZE',
  Glob: 'ANALYZE',
  codegraph: 'ANALYZE',
  grok: 'ANALYZE',

  // SKILL: 技能调用
  SkillTool: 'SKILL',

  // REVIEW: 子 Agent 审查
  Agent: 'REVIEW',

  // FIX: 文件编辑
  Edit: 'FIX',
  Write: 'FIX',
  FileEdit: 'FIX',
  FileWrite: 'FIX',

  // VERIFY: 构建和测试（Bash 需要进一步判断）
  Bash: 'VERIFY',  // 默认归为 VERIFY，见 inferBashPhase
}

/**
 * Bash 工具的阶段推断。
 * 检查命令内容来区分 ANALYZE（grep/find）和 VERIFY（build/test）。
 *
 * 注意：当前 _toolCallsThisTurn 只记录工具名，不含参数。
 * 阶段 1 增强：tool_completed 事件传递 toolInput 摘要后，
 * 可在此处解析 Bash 命令内容。
 *
 * 当前实现：Bash 默认归为 VERIFY（最常见用途）。
 */
function inferBashPhase(commandHint?: string): ReActPhase {
  if (!commandHint) return 'VERIFY'

  const lower = commandHint.toLowerCase()

  // 分析类命令
  if (/\b(grep|find|cat|head|tail|ls|tree|wc|file|stat)\b/.test(lower)) {
    return 'ANALYZE'
  }

  // 构建/测试类命令
  if (/\b(bun\s+(run\s+)?(build|test|dev)|npm\s+(run\s+)?(build|test)|jest|vitest|make|cargo\s+(build|test)|go\s+(build|test)|python.*-m\s+pytest)\b/.test(lower)) {
    return 'VERIFY'
  }

  return 'VERIFY'
}

// ============================================================
// 核心推理函数
// ============================================================

/**
 * 从工具调用列表推断 ReAct 阶段。
 *
 * 输入：本轮调用的工具名列表（来自 runtime._toolCallsThisTurn）
 * 输出：涉及的阶段列表（按首次出现顺序去重）
 *
 * 设计原则：
 * - 纯函数，无副作用
 * - O(n) 时间复杂度
 * - 新工具只需更新 TOOL_PHASE_MAP
 */
export function inferReActPhases(toolCalls: string[]): ReActPhase[] {
  const seen = new Set<ReActPhase>()
  const phases: ReActPhase[] = []

  for (const toolName of toolCalls) {
    const phase = TOOL_PHASE_MAP[toolName] ?? 'UNKNOWN'
    if (!seen.has(phase)) {
      seen.add(phase)
      phases.push(phase)
    }
  }

  // 如果没有工具调用，返回 UNKNOWN
  if (phases.length === 0) {
    return ['UNKNOWN']
  }

  return phases
}

/**
 * 构建完整的 ReAct 轮次观测结果。
 *
 * 在 turn_finished 事件中调用，替代简单的 toolCallsSummary。
 */
export function observeTurn(
  toolCalls: string[],
  outputSummary: string | undefined,
  turnIndex: number,
): ReActTurnObservation {
  const phases = inferReActPhases(toolCalls)

  // 主阶段：出现次数最多
  const phaseCounts = new Map<ReActPhase, number>()
  for (const toolName of toolCalls) {
    const phase = TOOL_PHASE_MAP[toolName] ?? 'UNKNOWN'
    phaseCounts.set(phase, (phaseCounts.get(phase) ?? 0) + 1)
  }
  let primaryPhase: ReActPhase = 'UNKNOWN'
  let maxCount = 0
  for (const [phase, count] of phaseCounts) {
    if (count > maxCount) {
      maxCount = count
      primaryPhase = phase
    }
  }

  // 阶段→工具映射
  const phaseToolMap = new Map<ReActPhase, string[]>()
  for (const toolName of toolCalls) {
    const phase = TOOL_PHASE_MAP[toolName] ?? 'UNKNOWN'
    const existing = phaseToolMap.get(phase) ?? []
    existing.push(toolName)
    phaseToolMap.set(phase, existing)
  }

  // 质量信号
  const qualitySignals = extractQualitySignals(outputSummary)

  return { phases, primaryPhase, phaseToolMap, qualitySignals, turnIndex }
}

/**
 * 从输出文本提取质量信号。
 *
 * 策略：关键词匹配 + 置信度计算。
 * 不做 NLP，只做规则匹配，保证 <1ms 执行时间。
 */
export function extractQualitySignals(
  outputSummary: string | undefined,
): QualitySignals {
  if (!outputSummary) {
    return {
      hasError: false,
      hasSuccess: false,
      errorPatterns: [],
      successPatterns: [],
      confidence: 0,
    }
  }

  const lower = outputSummary.toLowerCase()

  const matchedErrors: string[] = []
  for (const pattern of ERROR_PATTERNS) {
    if (lower.includes(pattern)) {
      matchedErrors.push(pattern)
    }
  }

  const matchedSuccess: string[] = []
  for (const pattern of SUCCESS_PATTERNS) {
    if (lower.includes(pattern)) {
      matchedSuccess.push(pattern)
    }
  }

  // 置信度：信号越多越确定（上限 1.0）
  const totalSignals = matchedErrors.length + matchedSuccess.length
  const confidence = Math.min(1.0, totalSignals * 0.2)

  return {
    hasError: matchedErrors.length > 0,
    hasSuccess: matchedSuccess.length > 0,
    errorPatterns: matchedErrors,
    successPatterns: matchedSuccess,
    confidence,
  }
}

// ============================================================
// ReAct 状态追踪（用于收敛检测）
// ============================================================

/**
 * 多轮 ReAct 状态。
 * 持有在 GoalRuntimeState 上，随 turn_finished 更新。
 */
export interface ReActState {
  /** 历史轮次观测（最多保留最近 5 轮） */
  observations: ReActTurnObservation[]
  /** 当前轮次计数 */
  roundCount: number
  /** 各阶段出现频率统计 */
  phaseFrequency: Map<ReActPhase, number>
}

/**
 * 创建初始 ReAct 状态。
 */
export function createReActState(): ReActState {
  return {
    observations: [],
    roundCount: 0,
    phaseFrequency: new Map(),
  }
}

/**
 * 更新 ReAct 状态（每轮结束时调用）。
 * 返回更新后的状态（不可变更新）。
 */
export function updateReActState(
  state: ReActState,
  observation: ReActTurnObservation,
): ReActState {
  const observations = [...state.observations, observation]
  // 保留最近 5 轮
  if (observations.length > 5) {
    observations.shift()
  }

  // 更新频率统计
  const phaseFrequency = new Map(state.phaseFrequency)
  for (const phase of observation.phases) {
    phaseFrequency.set(phase, (phaseFrequency.get(phase) ?? 0) + 1)
  }

  return {
    observations,
    roundCount: state.roundCount + 1,
    phaseFrequency,
  }
}
```

### 1.3 集成点

在 `goalRuntime.ts` 的 `turn_finished` 处理中，替换当前的简单记录：

```typescript
// 现有代码（goalRuntime.ts 第 509-519 行附近）
runtime.turnBuffer = recordTurnApiUsage(
  runtime.turnBuffer ?? [],
  lastTurn?.turnId ?? "unknown",
  context.currentTokenUsage,
  wallStartMs,
  wallEndMs,
  {
    toolCallsSummary: runtime._toolCallsThisTurn ?? [],
    outputSummary: context.outputSummary,
    hadObservableChanges,
  },
);

// 新增：ReAct 观测
const reactObservation = observeTurn(
  runtime._toolCallsThisTurn ?? [],
  context.outputSummary,
  (runtime.reactState?.roundCount ?? 0) + 1,
);
runtime.reactState = updateReActState(
  runtime.reactState ?? createReActState(),
  reactObservation,
);
```

### 1.4 TurnRecord 扩展

```typescript
// src/commands/goal/types.ts — TurnRecord 增加字段
export interface TurnRecord {
  turnId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  wallStartMs: number;
  wallEndMs: number;
  toolCallsSummary?: string[];
  outputSummary?: string;
  hadObservableChanges?: boolean;
  // NEW: ReAct 观测
  reactPhases?: ReActPhase[];      // 本轮涉及的阶段
  reactPrimaryPhase?: ReActPhase;  // 主阶段
  qualitySignals?: QualitySignals; // 质量信号
}

// GoalRuntimeState 增加字段
export interface GoalRuntimeState {
  // ... existing fields ...
  // NEW: ReAct 状态追踪
  reactState?: ReActState;
}
```

---

## 2. Skills-Tools 适配方案

### 2.1 问题分析

`toolRanker.ts` 的 `rankTools()` 接受 `Tools`（即 `readonly Tool[]`），其中 `Tool` 需要：
- `name: string`
- `searchHint?: string`
- `prompt(options): Promise<string>` — 用于获取完整描述
- `inputSchema`, `call()`, `checkPermissions()` 等完整 Tool 接口

Skills 是 `Command`（`type: 'prompt'`），有：
- `name: string`
- `description: string`
- `whenToUse?: string` — 类似 searchHint
- `trigger?: string[]` — 触发词
- `priority?: number`
- `getPromptForCommand()` — 返回 prompt 内容

**类型不匹配**：`Command` 不实现 `Tool` 接口，缺少 `inputSchema`、`call()`、`checkPermissions()` 等。

### 2.2 方案选择

| 方案 | 描述 | 复杂度 | 侵入性 |
|------|------|--------|--------|
| A: 虚拟 Tool 适配器 | 将 Command 包装为最小 Tool 实现 | 中 | 低 |
| B: 独立 Skills 排名 | toolRanker 之外单独做 Skills BM25 | 低 | 最低 |
| C: 扩展 rankTools 支持 union type | 修改 rankTools 接口 | 高 | 高 |

**选择方案 B**：最简洁，零侵入，Skills 排名和 Tool 排名完全独立。

### 2.3 方案 B 实现

```typescript
// src/services/api/skillRanker.ts

import type { Command } from '../../types/command.js'
import { escapeRegExp } from '../../utils/stringUtils.js'

// ============================================================
// 配置
// ============================================================

/** 最终选出的 Skills 数量 */
const MAX_SKILL_COUNT = 5

/** 工具名 → ReAct 阶段关联的优先 Skills */
const PHASE_PREFERRED_SKILLS: Record<string, string[]> = {
  ANALYZE: ['systematic-debugging', 'code-design-analyzer'],
  REVIEW: ['design-doc-reviewer', 'code-design-analyzer'],
  FIX: ['simplify'],
  VERIFY: ['verification-before-completion'],
  SKILL: [],  // SKILL 阶段本身就是调用技能
}

// ============================================================
// 分词（复用 toolRanker 的逻辑）
// ============================================================

function extractTerms(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(term => term.length > 1)
}

// ============================================================
// Skills 排名
// ============================================================

interface SkillScore {
  command: Command
  score: number
}

/**
 * 对 Skills 进行 BM25 排名。
 *
 * 评分权重：
 * - name 精确匹配: 100
 * - name 部分匹配: 20
 * - whenToUse 匹配: 15（等效于 searchHint）
 * - description 匹配: 8
 * - trigger 匹配: 12（Skills 特有）
 * - priority 加成: priority / 10（最大 10 分）
 * - 阶段偏好加成: 25（当前 ReAct 阶段优先选择的 Skills）
 */
export function rankSkills(
  skills: Command[],
  query: string,
  options?: {
    currentPhase?: string       // 当前 ReAct 阶段
    preferredSkills?: string[]  // 场景偏好 Skills
  },
): Command[] {
  if (skills.length === 0) return []
  if (skills.length <= MAX_SKILL_COUNT) return skills

  const queryTerms = extractTerms(query)
  if (queryTerms.length === 0) return skills.slice(0, MAX_SKILL_COUNT)

  // 预编译正则
  const termPatterns = new Map<string, RegExp>()
  for (const term of queryTerms) {
    termPatterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
  }

  const scored: SkillScore[] = skills.map(cmd => {
    let score = 0
    const nameLower = cmd.name.toLowerCase()
    const nameParts = extractTerms(cmd.name)
    const descLower = cmd.description.toLowerCase()
    const whenToUseLower = (cmd.whenToUse ?? '').toLowerCase()

    for (const term of queryTerms) {
      // name 精确匹配
      if (nameLower === term) {
        score += 100
        continue
      }
      // name 部分匹配
      if (nameParts.includes(term)) {
        score += 20
      } else if (nameParts.some(p => p.includes(term))) {
        score += 10
      }
      // whenToUse 匹配
      const pattern = termPatterns.get(term)!
      if (pattern.test(whenToUseLower)) {
        score += 15
      }
      // description 匹配
      if (pattern.test(descLower)) {
        score += 8
      }
    }

    // trigger 匹配
    if (cmd.trigger) {
      for (const trigger of cmd.trigger) {
        const triggerLower = trigger.toLowerCase()
        for (const term of queryTerms) {
          if (triggerLower.includes(term)) {
            score += 12
            break
          }
        }
      }
    }

    // priority 加成
    if (cmd.priority) {
      score += Math.min(10, cmd.priority / 10)
    }

    // 阶段偏好加成
    if (options?.currentPhase) {
      const preferred = PHASE_PREFERRED_SKILLS[options.currentPhase] ?? []
      if (preferred.includes(cmd.name)) {
        score += 25
      }
    }

    // 场景偏好加成
    if (options?.preferredSkills?.includes(cmd.name)) {
      score += 20
    }

    return { command: cmd, score }
  })

  // 排序并返回 top-K
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, MAX_SKILL_COUNT).map(s => s.command)
}

/**
 * 从 query + currentPhase 构建 Skill 搜索上下文。
 * 将当前任务描述和 ReAct 阶段信息组合为搜索 query。
 */
export function buildSkillQuery(
  taskDescription: string,
  currentPhase?: string,
  recentToolCalls?: string[],
): string {
  const parts = [taskDescription]

  // 从最近工具调用推断上下文关键词
  if (recentToolCalls?.length) {
    const contextKeywords = recentToolCalls
      .map(t => t.toLowerCase())
      .join(' ')
    parts.push(contextKeywords)
  }

  return parts.join(' ')
}
```

### 2.4 集成到 Goal 流程

在 `goalSteering.ts` 的 `buildContinuationPrompt` 中，注入 Top Skills 提示：

```typescript
// goalSteering.ts — buildContinuationPrompt 增强
import { rankSkills } from '../../services/api/skillRanker.js'

export function buildContinuationPrompt(
  goal: Goal,
  currentTask?: string,
  options?: {
    availableSkills?: Command[]
    currentPhase?: string
  }
): string {
  const template = getContinuationTemplate(goal.mode ?? "standard");
  // ... existing template rendering ...

  // NEW: 注入推荐 Skills
  let skillHint = ''
  if (options?.availableSkills?.length && currentTask) {
    const ranked = rankSkills(options.availableSkills, currentTask, {
      currentPhase: options.currentPhase,
    })
    if (ranked.length > 0) {
      skillHint = `\n\n## Recommended Skills (use Skill tool to invoke)\n`
      for (const skill of ranked) {
        skillHint += `- **${skill.name}**: ${skill.description}${skill.whenToUse ? ` — ${skill.whenToUse}` : ''}\n`
      }
    }
  }

  return renderedTemplate + taskLine + skillHint;
}
```

### 2.5 与 BM25 ToolRanker 的关系

```
用户 query
    │
    ├─→ rankTools(tools, query)     → Top-25 Tools（已有）
    │       ↓
    │   API 请求携带 Top-25 Tools
    │
    └─→ rankSkills(skills, query)   → Top-5 Skills（新增）
            ↓
        注入 continuation prompt
        "Recommended Skills: ..."
            ↓
        模型通过 SkillTool 调用
```

两套排名完全独立，零耦合。Skills 不需要实现 Tool 接口。

---

## 3. CodeGraph/Grok 主动调用协议

### 3.1 调用时机

| 维度 | 策略 | 理由 |
|------|------|------|
| 何时调用 | **按需 + 首轮** | 首轮 ANALYZE 调用一次获取全局上下文；后续轮次仅在 FIX 涉及新文件时调用 |
| 调用频率 | 每个任务最多 2 次 CodeGraph + 1 次 Grok | 避免重复查询浪费 token |
| 触发条件 | 满足以下任一：(1) 首轮 ANALYZE (2) FIX 引入新文件 (3) VERIFY 失败需要追溯 | |

```typescript
// src/utils/goal/codegraphProtocol.ts

export interface AnalysisProtocolState {
  /** 当前任务是否已做过首次 CodeGraph 查询 */
  codegraphQueriedForCurrentTask: boolean
  /** 当前任务是否已做过 Grok 分析 */
  grokQueriedForCurrentTask: boolean
  /** 已查询过的文件集合（避免重复） */
  queriedFiles: Set<string>
  /** 上次 CodeGraph 查询时间戳 */
  lastCodegraphQueryMs: number
  /** 上次 Grok 查询时间戳 */
  lastGrokQueryMs: number
}

/**
 * 判断当前轮次是否应该调用 CodeGraph。
 *
 * 规则：
 * 1. 当前任务首轮 ANALYZE → 必须调用
 * 2. FIX 阶段引入新文件 → 调用（检查文件是否在 queriedFiles 中）
 * 3. VERIFY 失败 → 调用（追溯调用链）
 * 4. 距上次查询 < 30 秒 → 跳过（防抖）
 */
export function shouldCallCodegraph(
  state: AnalysisProtocolState,
  currentPhase: string,
  toolCalls: string[],
  changedFiles?: string[],
): { shouldCall: boolean; reason: string } {
  // 防抖：30 秒内不重复调用
  if (Date.now() - state.lastCodegraphQueryMs < 30_000) {
    return { shouldCall: false, reason: 'cooldown' }
  }

  // 规则 1: 首轮 ANALYZE
  if (currentPhase === 'ANALYZE' && !state.codegraphQueriedForCurrentTask) {
    return { shouldCall: true, reason: 'first_analyze' }
  }

  // 规则 2: FIX 引入新文件
  if (currentPhase === 'FIX' && changedFiles?.length) {
    const newFiles = changedFiles.filter(f => !state.queriedFiles.has(f))
    if (newFiles.length > 0) {
      return { shouldCall: true, reason: 'new_files' }
    }
  }

  return { shouldCall: false, reason: 'not_needed' }
}

/**
 * 判断当前轮次是否应该调用 Grok。
 *
 * Grok 查询更重（~3-5 分钟首次生成），所以更保守：
 * 1. 当前任务首轮 ANALYZE 且任务涉及架构/设计 → 调用 grok_domain
 * 2. 当前任务首轮 ANALYZE 且任务涉及特定文件 → 调用 grok_explain
 * 3. 每个任务最多调用 1 次
 */
export function shouldCallGrok(
  state: AnalysisProtocolState,
  currentPhase: string,
  taskDescription: string,
): { shouldCall: boolean; operation: string; reason: string } {
  if (state.grokQueriedForCurrentTask) {
    return { shouldCall: false, operation: '', reason: 'already_queried' }
  }

  if (currentPhase !== 'ANALYZE') {
    return { shouldCall: false, operation: '', reason: 'wrong_phase' }
  }

  const taskLower = taskDescription.toLowerCase()

  // 架构/设计相关任务 → grok_domain
  if (/\b(architect|design|domain|模块|架构|设计|业务域)\b/.test(taskLower)) {
    return { shouldCall: true, operation: 'grok_domain', reason: 'architecture_task' }
  }

  // 涉及特定文件/函数 → grok_explain
  if (/\b(explain|understand|trace|理解|解释|追踪)\b/.test(taskLower)) {
    return { shouldCall: true, operation: 'grok_explain', reason: 'explanation_task' }
  }

  return { shouldCall: false, operation: '', reason: 'not_relevant' }
}
```

### 3.2 超时控制

```typescript
// src/utils/goal/codegraphProtocol.ts

/** CodeGraph 单次查询超时（毫秒） */
const CODEGRAPH_TIMEOUT_MS = 10_000

/** Grok 单次查询超时（毫秒） */
const GROK_TIMEOUT_MS = 15_000

/**
 * 带超时的工具调用包装器。
 *
 * 实现方式：在 continuation prompt 中注入指令，让模型自行调用工具。
 * 超时由 ToolUseContext.abortController 控制（已有的基础设施）。
 *
 * 不在 orchestrator 层直接调用 tool.call() 的原因：
 * 1. tool.call() 需要 ToolUseContext、CanUseToolFn 等上下文
 * 2. 绕过权限检查不安全
 * 3. 让模型调用可以利用已有的超时和错误处理机制
 */
```

### 3.3 降级行为

```typescript
/**
 * CodeGraph 降级策略。
 *
 * 层级 1: codegraph_status 检查 → 未初始化则自动 init
 * 层级 2: 查询超时 → 记录警告，跳过该查询
 * 层级 3: 查询失败 → 降级到 Grep/Glob 手动搜索
 * 层级 4: 连续 3 次失败 → 标记 codegraph 不可用，后续轮次跳过
 */
export interface DegradationState {
  codegraphFailCount: number
  codegraphAvailable: boolean
  grokFailCount: number
  grokAvailable: boolean
}

/**
 * 处理 CodeGraph 调用失败。
 * 返回降级后的分析指令。
 */
export function handleCodegraphFailure(
  state: DegradationState,
  error: string,
): { degraded: boolean; fallbackPrompt: string } {
  state.codegraphFailCount++

  if (state.codegraphFailCount >= 3) {
    state.codegraphAvailable = false
    return {
      degraded: true,
      fallbackPrompt: `[CodeGraph 不可用] 使用 Grep/Glob 手动搜索代码结构。错误: ${error}`,
    }
  }

  return {
    degraded: true,
    fallbackPrompt: `[CodeGraph 查询失败，重试 ${state.codegraphFailCount}/3] 使用 Grep/Glob 作为备选。错误: ${error}`,
  }
}
```

### 3.4 结果注入方式

**选择：注入到 continuation prompt**（而非直接注入 model context）。

理由：
1. continuation prompt 由 orchestrator 控制，不占用 system prompt 空间
2. 结果只在需要的轮次注入，不浪费后续轮次的 context
3. 模型可以自然地将分析结果作为工作记忆使用

```typescript
/**
 * 构建 CodeGraph/Grok 分析结果注入文本。
 * 在 ANALYZE 阶段结束后，拼接到下一轮的 continuation prompt 中。
 */
export function buildAnalysisInjection(
  codegraphResults?: { operation: string; data: unknown }[],
  grokResults?: { operation: string; data: unknown }[],
): string {
  if (!codegraphResults?.length && !grokResults?.length) return ''

  let injection = '\n\n## Analysis Results (use in your next steps)\n'

  if (codegraphResults?.length) {
    injection += '\n### CodeGraph Analysis\n'
    for (const r of codegraphResults) {
      const dataStr = typeof r.data === 'string'
        ? r.data
        : JSON.stringify(r.data, null, 2)
      // 截断过长结果
      const truncated = dataStr.length > 2000
        ? dataStr.slice(0, 2000) + '\n... (truncated)'
        : dataStr
      injection += `**${r.operation}**:\n\`\`\`json\n${truncated}\n\`\`\`\n`
    }
  }

  if (grokResults?.length) {
    injection += '\n### Grok Analysis\n'
    for (const r of grokResults) {
      const dataStr = typeof r.data === 'string'
        ? r.data
        : JSON.stringify(r.data, null, 2)
      const truncated = dataStr.length > 1500
        ? dataStr.slice(0, 1500) + '\n... (truncated)'
        : dataStr
      injection += `**${r.operation}**:\n\`\`\`\n${truncated}\n\`\`\`\n`
    }
  }

  return injection
}
```

### 3.5 完整调用流程

```
turn_finished (ANALYZE 阶段)
    │
    ├─→ shouldCallCodegraph(state, 'ANALYZE', toolCalls)
    │       │
    │       ├─ true → 注入 "调用 codegraph codegraph_context(query=...)" 到 continuation
    │       │         模型调用 → 结果记录到 analysisResults
    │       │
    │       └─ false → 跳过
    │
    ├─→ shouldCallGrok(state, 'ANALYZE', taskDesc)
    │       │
    │       ├─ true → 注入 "调用 grok grok_domain()" 到 continuation
    │       │         模型调用 → 结果记录到 analysisResults
    │       │
    │       └─ false → 跳过
    │
    └─→ buildAnalysisInjection(codegraphResults, grokResults)
            │
            └─→ 拼接到下一轮 continuation prompt
```

---

## 4. 文件变更清单

| 文件 | 变更类型 | 描述 |
|------|---------|------|
| `src/utils/goal/reactObserver.ts` | **新增** | ReAct 阶段推断 + 质量信号提取 |
| `src/services/api/skillRanker.ts` | **新增** | Skills BM25 独立排名 |
| `src/utils/goal/codegraphProtocol.ts` | **新增** | CodeGraph/Grok 调用协议 + 降级 |
| `src/utils/goal/goalRuntime.ts` | 修改 | 集成 ReActObserver，扩展 TurnRecord |
| `src/utils/goal/goalSteering.ts` | 修改 | 注入推荐 Skills + 分析结果 |
| `src/commands/goal/types.ts` | 修改 | TurnRecord + GoalRuntimeState 扩展 |
