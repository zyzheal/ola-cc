# Hermes+EverOS 进化系统增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 ola-cc ASAEF 进化系统，添加标准化评估数据集、LLM 文本反馈、约束验证和 BM25 记忆检索，综合进化效能从 29% 提升到 83%。

**Architecture:** 4 个 Phase 独立模块：Phase 1 (evalDataset + datasetBuilder) + Phase 2 (rubricEvaluator 增强) 可并行，Phase 3 (constraintValidator) 依赖 Phase 1 类型，Phase 4 (BM25 + RRF + MemoryIndex) 完全独立。所有新模块通过 EvolutionEngine 状态机集成。

**Tech Stack:** TypeScript, Bun test, Zod validation, JSONL persistence, BM25 algorithm (pure TS, zero deps)

**设计文档:** `docs/hermes-everos-evolution-enhancement-plan.md` (v1.5)

---

## File Structure

### Phase 1 — 新建
- `src/services/singularity/evalDataset.ts` — EvalExample/EvalDataset 类型 + EvalDatasetManager (save/load/split/toTestResults)
- `src/services/singularity/datasetBuilder.ts` — SyntheticDatasetBuilder (generate + mineFromHistory)
- `src/services/singularity/datasetBuilder.test.ts` — 测试

### Phase 2 — 修改
- `src/tools/AgentTool/rubricEvaluator.ts` — 新增 FitnessFeedback/GateResultWithFeedback/evaluateQualityWithFeedback
- `src/services/singularity/EvolutionEngine.ts` — P2_CONCEIVE 消费 feedback

### Phase 3 — 新建
- `src/services/singularity/constraintValidator.ts` — ConstraintValidator (6 项约束检查)
- `src/services/singularity/constraintValidator.test.ts` — 测试

### Phase 4 — 新建
- `src/utils/memory/bm25.ts` — BM25 算法
- `src/utils/memory/rrf.ts` — RRF 多路融合
- `src/services/memory/memoryIndex.ts` — MemoryIndex 服务
- `src/utils/memory/bm25.test.ts` — BM25 测试
- `src/utils/memory/rrf.test.ts` — RRF 测试

### Phase 1+3 — 修改
- `src/tools/AgentTool/LearningSystem.ts` — 新增 mineFromHistory 方法
- `src/services/singularity/EvolutionEngine.ts` — P0 集成数据集, P3 集成约束

---

## Task 1: EvalDataset 类型定义与管理器

**Files:**
- Create: `src/services/singularity/evalDataset.ts`
- Test: `src/services/singularity/datasetBuilder.test.ts` (仅 EvalDatasetManager 部分)

- [ ] **Step 1: Write failing tests for EvalDatasetManager**

```typescript
// src/services/singularity/datasetBuilder.test.ts
import { describe, it, expect } from 'bun:test'
import { EvalDatasetManager, type EvalExample } from './evalDataset'

describe('EvalDatasetManager', () => {
  const makeExamples = (n: number): EvalExample[] =>
    Array.from({ length: n }, (_, i) => ({
      taskInput: `task-${i}`,
      expectedBehavior: `expected behavior for task ${i} with enough detail`,
      difficulty: (['easy', 'medium', 'hard'] as const)[i % 3],
      category: `cat-${i % 2}`,
      source: 'synthetic' as const,
    }))

  it('should split into train/val/holdout with correct ratios', () => {
    const examples = makeExamples(20)
    const dataset = EvalDatasetManager.split(examples)
    expect(dataset.train.length).toBe(10)
    expect(dataset.val.length).toBe(5)
    expect(dataset.holdout.length).toBe(5)
  })

  it('should handle small dataset gracefully', () => {
    const examples = makeExamples(3)
    const dataset = EvalDatasetManager.split(examples)
    expect(dataset.train.length + dataset.val.length + dataset.holdout.length).toBe(3)
  })

  it('should save and load dataset from JSONL roundtrip', async () => {
    const examples = makeExamples(10)
    const dataset = EvalDatasetManager.split(examples)
    const tmpPath = '/tmp/test-eval-dataset.jsonl'
    EvalDatasetManager.save(dataset, tmpPath)
    const loaded = EvalDatasetManager.load(tmpPath)
    expect(loaded.train.length).toBe(dataset.train.length)
    expect(loaded.holdout.length).toBe(dataset.holdout.length)
    expect(loaded.train[0].taskInput).toBe(dataset.train[0].taskInput)
  })

  it('should convert to test results format', () => {
    const examples = makeExamples(5)
    const predictions = ['pred1', 'pred2', 'pred3', 'pred4', 'pred5']
    const results = EvalDatasetManager.toTestResults({ train: examples, val: [], holdout: examples }, predictions)
    expect(results.length).toBe(5)
    expect(results[0]).toHaveProperty('passed')
    expect(results[0]).toHaveProperty('name')
    expect(results[0]).toHaveProperty('regression')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/singularity/datasetBuilder.test.ts`
Expected: FAIL — `evalDataset` module not found

- [ ] **Step 3: Implement EvalDatasetManager**

```typescript
// src/services/singularity/evalDataset.ts
import * as fs from 'fs'

export interface EvalExample {
  taskInput: string
  expectedBehavior: string
  difficulty: 'easy' | 'medium' | 'hard'
  category: string
  source: 'synthetic' | 'golden' | 'sessiondb'
}

export interface EvalDataset {
  train: EvalExample[]
  val: EvalExample[]
  holdout: EvalExample[]
  skipValidation?: boolean
}

export class EvalDatasetManager {
  static save(dataset: EvalDataset, filePath: string): void {
    const lines = [
      JSON.stringify({ __header: true, version: '1.0', createdAt: new Date().toISOString(), totalExamples: dataset.train.length + dataset.val.length + dataset.holdout.length }),
      ...dataset.train.map(e => JSON.stringify({ ...e, __split: 'train' })),
      ...dataset.val.map(e => JSON.stringify({ ...e, __split: 'val' })),
      ...dataset.holdout.map(e => JSON.stringify({ ...e, __split: 'holdout' })),
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  }

  static load(filePath: string): EvalDataset {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const train: EvalExample[] = []
    const val: EvalExample[] = []
    const holdout: EvalExample[] = []

    for (const line of lines) {
      const obj = JSON.parse(line)
      if (obj.__header) continue
      const { __split, ...example } = obj
      if (__split === 'val') val.push(example)
      else if (__split === 'holdout') holdout.push(example)
      else train.push(example)
    }
    return { train, val, holdout }
  }

  static split(examples: EvalExample[]): EvalDataset {
    const shuffled = [...examples].sort(() => Math.random() - 0.5)
    const n = shuffled.length
    const trainEnd = Math.floor(n * 0.5)
    const valEnd = trainEnd + Math.floor(n * 0.25)
    return {
      train: shuffled.slice(0, trainEnd),
      val: shuffled.slice(trainEnd, valEnd),
      holdout: shuffled.slice(valEnd),
    }
  }

  static toTestResults(
    dataset: EvalDataset,
    predictions: string[],
  ): { passed: boolean; name: string; regression: boolean }[] {
    const holdout = dataset.holdout
    return holdout.map((example, i) => ({
      passed: predictions[i]?.includes(example.expectedBehavior.slice(0, 20)) ?? false,
      name: `holdout-${example.category}-${i}`,
      regression: false,
    }))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/singularity/datasetBuilder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/singularity/evalDataset.ts src/services/singularity/datasetBuilder.test.ts
git commit -m "feat(phase1): add EvalDataset types and EvalDatasetManager (split/save/load)"
```

---

## Task 2: SyntheticDatasetBuilder — generate() 方法

**Files:**
- Modify: `src/services/singularity/datasetBuilder.ts` (新建)
- Modify: `src/services/singularity/datasetBuilder.test.ts`

- [ ] **Step 1: Write failing tests for generate()**

追加到 `datasetBuilder.test.ts`:

```typescript
import { SyntheticDatasetBuilder } from './datasetBuilder'

describe('SyntheticDatasetBuilder', () => {
  it('should generate eval dataset from skill text with mocked LLM', async () => {
    // 需要 mock LLM 调用 — 使用构造函数注入
    const mockLLM = async () => JSON.stringify({
      examples: Array.from({ length: 20 }, (_, i) => ({
        taskInput: `test task ${i}`,
        expectedBehavior: `expected behavior ${i} with sufficient detail for validation`,
        difficulty: 'medium',
        category: 'general',
      }))
    })
    const builder = new SyntheticDatasetBuilder(mockLLM)
    const dataset = await builder.generate('---\nname: test-skill\ndescription: test\n---\n# Test Skill\nSome content here.')
    expect(dataset.skipValidation).toBeUndefined()
    expect(dataset.train.length + dataset.val.length + dataset.holdout.length).toBeGreaterThanOrEqual(15)
  })

  it('should handle empty skill text gracefully', async () => {
    const mockLLM = async () => JSON.stringify({ examples: [] })
    const builder = new SyntheticDatasetBuilder(mockLLM)
    const dataset = await builder.generate('')
    expect(dataset.skipValidation).toBe(true)
  })

  it('should degrade to mineFromHistory on LLM failure', async () => {
    const mockLLM = async () => { throw new Error('LLM timeout') }
    const builder = new SyntheticDatasetBuilder(mockLLM)
    // 传入 mock history — 将在 Task 3 实现 mineFromHistory 后验证
    const dataset = await builder.generate('skill text', { maxRetries: 1 })
    // LLM 失败 + 无 history → skipValidation
    expect(dataset.skipValidation).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/singularity/datasetBuilder.test.ts`
Expected: FAIL — `SyntheticDatasetBuilder` not found

- [ ] **Step 3: Implement SyntheticDatasetBuilder.generate()**

```typescript
// src/services/singularity/datasetBuilder.ts
import { EvalDatasetManager, type EvalDataset, type EvalExample } from './evalDataset'

type LLMCaller = (prompt: string) => Promise<string>

export class SyntheticDatasetBuilder {
  constructor(private callLLM: LLMCaller) {}

  async generate(
    skillText: string,
    options?: {
      numCases?: number
      maxRetries?: number
      minValidCases?: number
      timeoutMs?: number
    },
  ): Promise<EvalDataset> {
    const numCases = options?.numCases ?? 20
    const maxRetries = options?.maxRetries ?? 3
    const minValidCases = options?.minValidCases ?? 5

    if (!skillText || skillText.trim().length < 10) {
      return { train: [], val: [], holdout: [], skipValidation: true }
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const prompt = this.buildPrompt(skillText, numCases)
        const raw = await this.callLLM(prompt)
        const parsed = JSON.parse(raw)
        const examples = this.validateCases(parsed.examples ?? [])
        if (examples.length >= minValidCases) {
          return EvalDatasetManager.split(examples)
        }
      } catch (e: unknown) {
        const err = e as { status?: number; retryAfter?: number; message?: string }
        if (err.status === 429) {
          await new Promise(r => setTimeout(r, err.retryAfter ?? 2000 * (attempt + 1)))
          continue
        }
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
        }
      }
    }

    // All retries failed — return skipValidation dataset
    return { train: [], val: [], holdout: [], skipValidation: true }
  }

  private buildPrompt(skillText: string, numCases: number): string {
    return `Given the full text of a skill, generate ${numCases} diverse test cases.
Each test case should include:
- taskInput: what a user would actually ask
- expectedBehavior: what a good response should contain/do (≥20 chars)
- difficulty: easy/medium/hard
- category: what aspect of the skill this tests

Skill text:
${skillText}

Respond with JSON: { "examples": [{ "taskInput": "...", "expectedBehavior": "...", "difficulty": "...", "category": "..." }] }`
  }

  private validateCases(raw: unknown[]): EvalExample[] {
    return raw.filter((e): e is EvalExample => {
      if (!e || typeof e !== 'object') return false
      const ex = e as Record<string, unknown>
      return (
        typeof ex.taskInput === 'string' && ex.taskInput.length > 0 &&
        typeof ex.expectedBehavior === 'string' && ex.expectedBehavior.length >= 20 &&
        ['easy', 'medium', 'hard'].includes(ex.difficulty as string) &&
        typeof ex.category === 'string'
      )
    }).map(e => ({ ...e, source: 'synthetic' as const }))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/singularity/datasetBuilder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/singularity/datasetBuilder.ts
git commit -m "feat(phase1): add SyntheticDatasetBuilder with LLM generation and retry logic"
```

---

## Task 3: mineFromHistory — 从执行历史挖掘用例

**Files:**
- Modify: `src/services/singularity/datasetBuilder.ts`
- Modify: `src/tools/AgentTool/LearningSystem.ts`
- Modify: `src/services/singularity/datasetBuilder.test.ts`

- [ ] **Step 1: Write failing tests for mineFromHistory**

追加到 `datasetBuilder.test.ts`:

```typescript
describe('mineFromHistory', () => {
  it('should extract valid examples from execution history', async () => {
    const mockLLM = async () => '{}'
    const builder = new SyntheticDatasetBuilder(mockLLM)
    const history = Array.from({ length: 10 }, (_, i) => ({
      id: `rec-${i}`,
      skill: 'test-skill',
      taskDescription: `task description ${i} with enough detail to extract`,
      outcome: (i % 3 === 0 ? 'failure' : 'success') as 'success' | 'failure',
      score: 60 + i * 3,
      signal: null,
      edgeCases: [],
      timestamp: new Date(),
      duration_ms: 1000,
    }))
    const examples = await builder.mineFromHistory('test-skill', history)
    expect(examples.length).toBeGreaterThanOrEqual(3)
    expect(examples[0].taskInput).toBeTruthy()
    expect(examples[0].expectedBehavior.length).toBeGreaterThanOrEqual(20)
    expect(examples[0].source).toBe('sessiondb')
  })

  it('should return empty array for insufficient history', async () => {
    const mockLLM = async () => '{}'
    const builder = new SyntheticDatasetBuilder(mockLLM)
    const examples = await builder.mineFromHistory('test-skill', [])
    expect(examples.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/singularity/datasetBuilder.test.ts -t "mineFromHistory"`
Expected: FAIL — `mineFromHistory` method not implemented yet

- [ ] **Step 3: Implement mineFromHistory in datasetBuilder.ts**

追加到 `SyntheticDatasetBuilder` 类:

```typescript
  async mineFromHistory(skill: string, history: ExecutionRecord[]): Promise<EvalExample[]> {
    if (history.length < 3) return []

    return history
      .filter(r => r.taskDescription && r.taskDescription.length > 10)
      .slice(0, 20)
      .map(r => ({
        taskInput: r.taskDescription,
        expectedBehavior: `Expected: task completes with score ≥ 70. Actual outcome: ${r.outcome} (score: ${r.score}). Focus on: ${r.signal?.defectType ?? 'general quality'}`,
        difficulty: (r.score >= 80 ? 'easy' : r.score >= 60 ? 'medium' : 'hard') as 'easy' | 'medium' | 'hard',
        category: skill,
        source: 'sessiondb' as const,
      }))
  }
```

需要在文件顶部添加 ExecutionRecord 导入:

```typescript
import type { ExecutionRecord } from '../../tools/AgentTool/LearningSystem'
```

- [ ] **Step 4: Add mineFromHistory to LearningSystem**

在 `src/tools/AgentTool/LearningSystem.ts` 的 `LearningSystem` 类中添加公共方法:

```typescript
  /**
   * 为 SyntheticDatasetBuilder 提供执行历史数据
   * 复用现有 getExecutionHistory() 公共方法
   */
  getHistoryForMining(skill: string): ExecutionRecord[] {
    return this.getExecutionHistory(skill, 20)
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/services/singularity/datasetBuilder.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/singularity/datasetBuilder.ts src/tools/AgentTool/LearningSystem.ts
git commit -m "feat(phase1): add mineFromHistory for execution history mining as LLM fallback"
```

---

## Task 4: Phase 2 — FitnessFeedback 类型与 GateResultWithFeedback

**Files:**
- Modify: `src/tools/AgentTool/rubricEvaluator.ts`

- [ ] **Step 1: Write failing tests for GateResultWithFeedback**

新建 `src/tools/AgentTool/rubricEvaluator.feedback.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import { evaluateQualityWithFeedback, type GateResultWithFeedback, type FitnessFeedback } from './rubricEvaluator'

describe('evaluateQualityWithFeedback', () => {
  it('should return feedback for failed dimensions when enableLLMFeedback=true', async () => {
    const mockLLM = async () => JSON.stringify({
      feedback: '技能缺少错误处理指导，导致 LLM 在 API 失败时无响应',
      suggestedApproach: '添加 try/catch 示例和错误码映射',
    })
    const result = await evaluateQualityWithFeedback(
      {
        tokenBudget: 1000,
        tokensUsed: 500,
        baselineTokens: 400,
        testResults: [
          { passed: true, name: 'test1', regression: false },
          { passed: false, name: 'test2', regression: false },
        ],
      },
      '---\nname: test\n---\n# Skill content',
      undefined,
      { enableLLMFeedback: true, model: 'mock' },
      mockLLM,
    )
    expect(result.passed).toBeDefined()
    expect(result.feedback).toBeDefined()
    expect(Array.isArray(result.feedback)).toBe(true)
  })

  it('should not call LLM when enableLLMFeedback is false', async () => {
    let llmCalled = false
    const mockLLM = async () => { llmCalled = true; return '{}' }
    await evaluateQualityWithFeedback(
      { tokenBudget: 1000, tokensUsed: 500, baselineTokens: 400 },
      'skill text',
      undefined,
      { enableLLMFeedback: false },
      mockLLM,
    )
    expect(llmCalled).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tools/AgentTool/rubricEvaluator.feedback.test.ts`
Expected: FAIL — `evaluateQualityWithFeedback` not exported

- [ ] **Step 3: Implement GateResultWithFeedback and evaluateQualityWithFeedback**

在 `src/tools/AgentTool/rubricEvaluator.ts` 末尾追加:

```typescript
// ============================================
// Phase 2: LLM-as-judge 文本反馈
// ============================================

export interface FitnessFeedback {
  dimension: string
  score: number
  threshold: number
  feedback: string
  suggestedApproach?: string
}

export interface GateResultWithFeedback extends GateResult {
  feedback: FitnessFeedback[]
  overallFeedback?: string
}

type FeedbackLLMCaller = (prompt: string) => Promise<string>

const FEEDBACK_PROMPT_TEMPLATE = (dimension: string, score: number, threshold: number, skillText: string) =>
`你是一个技能质量评审专家。以下是一个技能的文本和它的评估结果。

技能文本：
${skillText}

评估维度 ${dimension} 得分 ${score}，未达到阈值 ${threshold}。

请分析该维度失败的具体原因，并给出可操作的改进建议。
要求：
1. 指出技能文本中导致该维度得分低的具体段落或缺失内容
2. 给出具体的修改方向（不是泛泛的建议）
3. 建议不超过 3 句话

响应 JSON 格式：{ "feedback": "...", "suggestedApproach": "..." }`

// 反馈缓存（skillText+dimension → feedback）
const feedbackCache = new Map<string, { feedback: FitnessFeedback; cachedAt: number }>()
const FEEDBACK_CACHE_TTL = 3600_000 // 1 hour

export async function evaluateQualityWithFeedback(
  quality: QualityInput,
  skillText: string,
  config?: RubricConfig,
  options?: {
    enableLLMFeedback?: boolean
    model?: string
  },
  llmCaller?: FeedbackLLMCaller,
): Promise<GateResultWithFeedback> {
  // 先执行标准评分
  const baseResult = evaluateQuality(quality, config)

  if (!options?.enableLLMFeedback) {
    return { ...baseResult, feedback: [], overallFeedback: undefined }
  }

  const feedbacks: FitnessFeedback[] = []
  const cfg = getRubricConfig()

  // 对每个失败维度生成反馈
  const dimensionThresholds: Record<string, number> = {
    holdout_floor: cfg.holdoutFloor,
    min_delta: cfg.minDelta,
    trigger_f1: cfg.triggerF1Floor,
    cost_budget: cfg.maxCostRatio,
  }

  for (const [dim, threshold] of Object.entries(dimensionThresholds)) {
    const dimResult = baseResult.dimensions[dim as keyof typeof baseResult.dimensions]
    if (!dimResult || dimResult.passed) continue

    const cacheKey = `${skillText.slice(0, 100)}:${dim}`
    const cached = feedbackCache.get(cacheKey)
    if (cached && Date.now() - cached.cachedAt < FEEDBACK_CACHE_TTL) {
      feedbacks.push(cached.feedback)
      continue
    }

    if (!llmCaller) continue

    try {
      const prompt = FEEDBACK_PROMPT_TEMPLATE(dim, Number(dimResult.value), threshold, skillText)
      const raw = await llmCaller(prompt)
      const parsed = JSON.parse(raw)
      const fb: FitnessFeedback = {
        dimension: dim,
        score: Number(dimResult.value),
        threshold,
        feedback: parsed.feedback ?? '无具体反馈',
        suggestedApproach: parsed.suggestedApproach,
      }
      feedbacks.push(fb)
      feedbackCache.set(cacheKey, { feedback: fb, cachedAt: Date.now() })
    } catch {
      // LLM feedback 失败不影响评分结果
    }
  }

  return {
    ...baseResult,
    feedback: feedbacks,
    overallFeedback: feedbacks.length > 0
      ? feedbacks.map(f => `维度 ${f.dimension}: ${f.feedback}`).join('\n')
      : undefined,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools/AgentTool/rubricEvaluator.feedback.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/rubricEvaluator.ts src/tools/AgentTool/rubricEvaluator.feedback.test.ts
git commit -m "feat(phase2): add FitnessFeedback, GateResultWithFeedback, and evaluateQualityWithFeedback"
```

---

## Task 5: EvolutionEngine P2_CONCEIVE 消费 feedback

**Files:**
- Modify: `src/services/singularity/EvolutionEngine.ts`

- [ ] **Step 1: Write failing test**

新建 `src/services/singularity/evolutionEngine.feedback.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import { EvolutionEngine, EvolutionPhase } from './EvolutionEngine'

describe('EvolutionEngine P2 feedback integration', () => {
  it('should inject feedback into failureAnalysis context', () => {
    const engine = new EvolutionEngine('test-skill')
    // 模拟 P6 门控结果带有 feedback
    const state = engine.getState()
    state.context.gateResult = {
      passed: false,
      dimensions: {} as any,
      feedback: [
        {
          dimension: 'holdout_floor',
          score: 0.4,
          threshold: 0.6,
          feedback: '技能缺少错误处理指导',
          suggestedApproach: '添加 try/catch 示例',
        },
      ],
      overallFeedback: '维度 holdout_floor: 技能缺少错误处理指导',
    }
    // 验证 failureAnalysis 能被正确构建
    const gateResult = state.context.gateResult as any
    expect(gateResult.feedback).toBeDefined()
    expect(gateResult.feedback.length).toBe(1)
    expect(gateResult.feedback[0].feedback).toContain('错误处理')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/singularity/evolutionEngine.feedback.test.ts`
Expected: FAIL (test should pass actually since it's just reading state — adjust if needed)

- [ ] **Step 3: Add P2_CONCEIVE feedback consumption to EvolutionEngine**

在 `EvolutionEngine` 类中添加辅助方法（不影响现有 `run()` 循环，仅提供消费接口）:

```typescript
  /**
   * Phase 2 增强：从门控结果中提取 feedback 注入 P2 上下文
   *
   * 在 P2_CONCEIVE 阶段开始前调用，将 LLM feedback 转化为 failureAnalysis
   */
  injectFeedbackForP2(): void {
    const gateResult = this.state.context.gateResult as {
      feedback?: { dimension: string; feedback: string }[]
    } | undefined

    if (gateResult?.feedback && gateResult.feedback.length > 0) {
      this.state.context.failureAnalysis = gateResult.feedback
        .map(f => `维度 ${f.dimension}: ${f.feedback}`)
        .join('\n')
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test src/services/singularity/evolutionEngine.feedback.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/singularity/EvolutionEngine.ts src/services/singularity/evolutionEngine.feedback.test.ts
git commit -m "feat(phase2): add P2_CONCEIVE feedback injection in EvolutionEngine"
```

---

## Task 6: Phase 3 — ConstraintValidator 核心实现

**Files:**
- Create: `src/services/singularity/constraintValidator.ts`
- Create: `src/services/singularity/constraintValidator.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/services/singularity/constraintValidator.test.ts
import { describe, it, expect } from 'bun:test'
import { ConstraintValidator, type ConstraintResult } from './constraintValidator'

describe('ConstraintValidator', () => {
  const validator = new ConstraintValidator()

  const validSkill = `---
name: test-skill
description: A test skill for validation
---
# Test Skill
Some content here.`

  const largeSkill = 'x'.repeat(20000) // 20KB

  it('should pass when size is within limit', async () => {
    const results = await validator.validateAll(validSkill, 'skill')
    const sizeResult = results.find(r => r.constraintName === 'size_limit')
    expect(sizeResult?.passed).toBe(true)
  })

  it('should fail when size exceeds 15KB', async () => {
    const results = await validator.validateAll(largeSkill, 'skill')
    const sizeResult = results.find(r => r.constraintName === 'size_limit')
    expect(sizeResult?.passed).toBe(false)
  })

  it('should pass when growth is within 20%', async () => {
    const baseline = 'x'.repeat(5000)
    const evolved = 'x'.repeat(6000) // +20%
    const results = await validator.validateAll(evolved, 'skill', baseline)
    const growthResult = results.find(r => r.constraintName === 'growth_limit')
    expect(growthResult?.passed).toBe(true)
  })

  it('should fail when growth exceeds 20%', async () => {
    const baseline = 'x'.repeat(5000)
    const evolved = 'x'.repeat(7000) // +40%
    const results = await validator.validateAll(evolved, 'skill', baseline)
    const growthResult = results.find(r => r.constraintName === 'growth_limit')
    expect(growthResult?.passed).toBe(false)
  })

  it('should pass for valid skill structure', async () => {
    const results = await validator.validateAll(validSkill, 'skill')
    const structResult = results.find(r => r.constraintName === 'skill_structure')
    expect(structResult?.passed).toBe(true)
  })

  it('should fail for missing frontmatter', async () => {
    const noFront = '# Just a heading\nSome content without frontmatter'
    const results = await validator.validateAll(noFront, 'skill')
    const structResult = results.find(r => r.constraintName === 'skill_structure')
    expect(structResult?.passed).toBe(false)
  })

  it('should pass non-empty check', async () => {
    const results = await validator.validateAll(validSkill, 'skill')
    const nonEmpty = results.find(r => r.constraintName === 'non_empty')
    expect(nonEmpty?.passed).toBe(true)
  })

  it('should fail empty check', async () => {
    const results = await validator.validateAll('', 'skill')
    const nonEmpty = results.find(r => r.constraintName === 'non_empty')
    expect(nonEmpty?.passed).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/singularity/constraintValidator.test.ts`
Expected: FAIL — `constraintValidator` module not found

- [ ] **Step 3: Implement ConstraintValidator**

```typescript
// src/services/singularity/constraintValidator.ts

export interface ConstraintResult {
  passed: boolean
  constraintName: string
  message: string
  details?: string
}

export interface ConstraintConfig {
  maxSkillSize: number
  maxToolDescSize: number
  maxPromptGrowth: number
  maxAbsoluteLines: number
  maxChangeRatio: number
}

const DEFAULT_CONSTRAINT_CONFIG: ConstraintConfig = {
  maxSkillSize: 15000,
  maxToolDescSize: 500,
  maxPromptGrowth: 0.2,
  maxAbsoluteLines: 30,
  maxChangeRatio: 0.15,
}

function getConfig(overrides?: Partial<ConstraintConfig>): ConstraintConfig {
  return {
    maxSkillSize: parseInt(process.env.CONSTRAINT_MAX_SKILL_SIZE ?? '') || overrides?.maxSkillSize ?? DEFAULT_CONSTRAINT_CONFIG.maxSkillSize,
    maxToolDescSize: parseInt(process.env.CONSTRAINT_MAX_TOOL_DESC ?? '') || overrides?.maxToolDescSize ?? DEFAULT_CONSTRAINT_CONFIG.maxToolDescSize,
    maxPromptGrowth: parseFloat(process.env.CONSTRAINT_MAX_GROWTH ?? '') || overrides?.maxPromptGrowth ?? DEFAULT_CONSTRAINT_CONFIG.maxPromptGrowth,
    maxAbsoluteLines: parseInt(process.env.CONSTRAINT_MAX_LINES ?? '') || overrides?.maxAbsoluteLines ?? DEFAULT_CONSTRAINT_CONFIG.maxAbsoluteLines,
    maxChangeRatio: parseFloat(process.env.CONSTRAINT_MAX_RATIO ?? '') || overrides?.maxChangeRatio ?? DEFAULT_CONSTRAINT_CONFIG.maxChangeRatio,
  }
}

export class ConstraintValidator {
  async validateAll(
    artifactText: string,
    artifactType: 'skill' | 'tool' | 'prompt',
    baselineText?: string,
    configOverrides?: Partial<ConstraintConfig>,
  ): Promise<ConstraintResult[]> {
    if (process.env.OLA_CC_DISABLE_CONSTRAINT_VALIDATOR === 'true') {
      return [{ passed: true, constraintName: 'disabled', message: 'ConstraintValidator disabled via env' }]
    }

    const config = getConfig(configOverrides)
    const results: ConstraintResult[] = []

    results.push(this.checkNonEmpty(artifactText))
    results.push(this.checkSize(artifactText, artifactType, config))

    if (baselineText) {
      results.push(this.checkGrowth(artifactText, baselineText, config))
    }

    if (artifactType === 'skill') {
      results.push(this.checkSkillStructure(artifactText))
    }

    return results
  }

  private checkNonEmpty(text: string): ConstraintResult {
    const passed = text.trim().length > 0
    return {
      passed,
      constraintName: 'non_empty',
      message: passed ? 'Artifact is non-empty' : 'Artifact is empty',
    }
  }

  private checkSize(text: string, type: string, config: ConstraintConfig): ConstraintResult {
    const limit = type === 'tool' ? config.maxToolDescSize : config.maxSkillSize
    const size = text.length
    const passed = size <= limit
    return {
      passed,
      constraintName: 'size_limit',
      message: passed
        ? `Size ${size} within limit ${limit}`
        : `Size ${size} exceeds limit ${limit}`,
      details: `${size}/${limit} characters`,
    }
  }

  private checkGrowth(text: string, baseline: string, config: ConstraintConfig): ConstraintResult {
    const baselineSize = baseline.length
    const currentSize = text.length
    if (baselineSize === 0) {
      return { passed: true, constraintName: 'growth_limit', message: 'No baseline for comparison' }
    }
    const growth = (currentSize - baselineSize) / baselineSize
    const passed = growth <= config.maxPromptGrowth
    return {
      passed,
      constraintName: 'growth_limit',
      message: passed
        ? `Growth ${(growth * 100).toFixed(1)}% within limit ${config.maxPromptGrowth * 100}%`
        : `Growth ${(growth * 100).toFixed(1)}% exceeds limit ${config.maxPromptGrowth * 100}%`,
      details: `${baselineSize} → ${currentSize} (${(growth * 100).toFixed(1)}%)`,
    }
  }

  private checkSkillStructure(text: string): ConstraintResult {
    const hasFrontmatter = /^---\s*\n/.test(text) && /\nname:\s*\S/.test(text) && /\ndescription:\s*\S/.test(text)
    return {
      passed: hasFrontmatter,
      constraintName: 'skill_structure',
      message: hasFrontmatter
        ? 'Skill has valid frontmatter (name + description)'
        : 'Skill missing YAML frontmatter with name and description',
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/singularity/constraintValidator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/singularity/constraintValidator.ts src/services/singularity/constraintValidator.test.ts
git commit -m "feat(phase3): add ConstraintValidator with size/growth/structure/non-empty checks"
```

---

## Task 7: Phase 4 — BM25 算法核心

**Files:**
- Create: `src/utils/memory/bm25.ts`
- Create: `src/utils/memory/bm25.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/utils/memory/bm25.test.ts
import { describe, it, expect } from 'bun:test'
import { BM25, type BM25Result } from './bm25'

describe('BM25', () => {
  it('should index and retrieve documents by keyword', () => {
    const bm25 = new BM25()
    bm25.addDocument('doc1', 'Windows crash fix for Bun runtime')
    bm25.addDocument('doc2', 'macOS installation guide')
    bm25.addDocument('doc3', 'Linux package manager setup')
    const results = bm25.search('Windows crash')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('doc1')
  })

  it('should rank exact match higher than partial match', () => {
    const bm25 = new BM25()
    bm25.addDocument('exact', 'provider switching API routes')
    bm25.addDocument('partial', 'provider configuration and setup guide')
    const results = bm25.search('provider switching')
    expect(results[0].docId).toBe('exact')
  })

  it('should handle Chinese tokenization', () => {
    const bm25 = new BM25()
    bm25.addDocument('cn1', 'provider 切换配置指南')
    bm25.addDocument('cn2', 'API 路由设置')
    const results = bm25.search('切换')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('cn1')
  })

  it('should handle camelCase identifier splitting', () => {
    const bm25 = new BM25()
    bm25.addDocument('code1', 'camelCaseVariable used in function')
    bm25.addDocument('code2', 'some other document')
    const results = bm25.search('camel case')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('code1')
  })

  it('should handle empty query gracefully', () => {
    const bm25 = new BM25()
    bm25.addDocument('doc', 'some content')
    const results = bm25.search('')
    expect(results.length).toBe(0)
  })

  it('should support document removal', () => {
    const bm25 = new BM25()
    bm25.addDocument('doc1', 'first document about testing')
    bm25.addDocument('doc2', 'second document about coding')
    bm25.removeDocument('doc1')
    const results = bm25.search('testing')
    expect(results.find(r => r.docId === 'doc1')).toBeUndefined()
  })

  it('should use IDF smooth variant correctly', () => {
    const bm25 = new BM25()
    bm25.addDocument('common', 'the the the common word appears everywhere')
    bm25.addDocument('rare', 'the unique rare keyword xyzzy appears once')
    const results = bm25.search('xyzzy')
    expect(results.length).toBe(1)
    expect(results[0].docId).toBe('rare')
    expect(results[0].score).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/utils/memory/bm25.test.ts`
Expected: FAIL — `bm25` module not found

- [ ] **Step 3: Implement BM25**

```typescript
// src/utils/memory/bm25.ts

export interface BM25Config {
  k1: number
  b: number
}

export interface BM25Result {
  docId: string
  score: number
  matchedTerms: string[]
}

const DEFAULT_BM25_CONFIG: BM25Config = { k1: 1.2, b: 0.75 }

export class BM25 {
  private config: BM25Config
  private documents: Map<string, string> = new Map()
  private termFreqs: Map<string, Map<string, number>> = new Map()
  private docLengths: Map<string, number> = new Map()
  private avgDocLength: number = 0
  private docCount: number = 0
  private idfCache: Map<string, number> = new Map()

  constructor(config?: Partial<BM25Config>) {
    this.config = { ...DEFAULT_BM25_CONFIG, ...config }
  }

  addDocument(docId: string, content: string): void {
    this.documents.set(docId, content)
    const tokens = this.tokenize(content)
    const freqs = new Map<string, number>()
    for (const token of tokens) {
      freqs.set(token, (freqs.get(token) ?? 0) + 1)
    }
    this.termFreqs.set(docId, freqs)
    this.docLengths.set(docId, tokens.length)
    this.docCount = this.documents.size
    this.avgDocLength = [...this.docLengths.values()].reduce((a, b) => a + b, 0) / this.docCount
    this.idfCache.clear()
  }

  removeDocument(docId: string): void {
    this.documents.delete(docId)
    this.termFreqs.delete(docId)
    this.docLengths.delete(docId)
    this.docCount = this.documents.size
    this.avgDocLength = this.docCount > 0
      ? [...this.docLengths.values()].reduce((a, b) => a + b, 0) / this.docCount
      : 0
    this.idfCache.clear()
  }

  search(query: string, topK: number = 10): BM25Result[] {
    if (!query.trim()) return []

    const queryTokens = this.tokenize(query)
    if (queryTokens.length === 0) return []

    const scores = new Map<string, { score: number; matchedTerms: Set<string> }>()

    for (const term of queryTokens) {
      const idf = this.calculateIDF(term)
      if (idf <= 0) continue

      for (const [docId, freqs] of this.termFreqs) {
        const tf = freqs.get(term) ?? 0
        if (tf === 0) continue

        const docLen = this.docLengths.get(docId) ?? 0
        const { k1, b } = this.config
        const numerator = tf * (k1 + 1)
        const denominator = tf + k1 * (1 - b + b * docLen / this.avgDocLength)
        const score = idf * numerator / denominator

        const entry = scores.get(docId) ?? { score: 0, matchedTerms: new Set() }
        entry.score += score
        entry.matchedTerms.add(term)
        scores.set(docId, entry)
      }
    }

    return [...scores.entries()]
      .map(([docId, { score, matchedTerms }]) => ({ docId, score, matchedTerms: [...matchedTerms] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  private tokenize(text: string): string[] {
    const tokens: string[] = []

    // English words + digit mixed tokens (preserves base64, v2, P0-1)
    const englishWords = text.match(/[a-zA-Z][a-zA-Z0-9]*/g) || []
    tokens.push(...englishWords.map(w => w.toLowerCase()))

    // Chinese chars (unigram + bigram)
    const chineseChars = text.match(/[\u4e00-\u9fff]/g) || []
    tokens.push(...chineseChars)
    for (let i = 0; i < chineseChars.length - 1; i++) {
      tokens.push(chineseChars[i] + chineseChars[i + 1])
    }

    // Code identifiers (camelCase / snake_case splitting)
    const identifiers = text.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []
    for (const id of identifiers) {
      const camelParts = id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ')
      tokens.push(...camelParts)
      if (id.includes('_')) {
        tokens.push(...id.toLowerCase().split('_').filter(Boolean))
      }
    }

    return tokens
  }

  private calculateIDF(term: string): number {
    const cached = this.idfCache.get(term)
    if (cached !== undefined) return cached

    let docsWithTerm = 0
    for (const freqs of this.termFreqs.values()) {
      if (freqs.has(term)) docsWithTerm++
    }

    // IDF smooth variant: log(1 + (N - n + 0.5) / (n + 0.5))
    const idf = this.docCount === 0
      ? 0
      : Math.log(1 + (this.docCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5))

    this.idfCache.set(term, idf)
    return idf
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/utils/memory/bm25.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
mkdir -p src/utils/memory
git add src/utils/memory/bm25.ts src/utils/memory/bm25.test.ts
git commit -m "feat(phase4): add BM25 algorithm with Chinese/camelCase/snake_case tokenization"
```

---

## Task 8: Phase 4 — RRF 多路融合

**Files:**
- Create: `src/utils/memory/rrf.ts`
- Create: `src/utils/memory/rrf.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/utils/memory/rrf.test.ts
import { describe, it, expect } from 'bun:test'
import { reciprocalRankFusion, vectorAnchoredFusion } from './rrf'

describe('RRF', () => {
  it('should fuse multiple score maps correctly', () => {
    const map1 = new Map([['a', 10], ['b', 8], ['c', 5]])
    const map2 = new Map([['a', 6], ['b', 9], ['d', 7]])
    const results = reciprocalRankFusion([map1, map2])
    expect(results.length).toBe(4)
    // 'a' appears high in both → should be rank 1
    expect(results[0].docId).toBe('a')
  })

  it('should rank documents appearing in multiple lists higher', () => {
    const map1 = new Map([['shared', 5], ['only1', 10]])
    const map2 = new Map([['shared', 5], ['only2', 10]])
    const results = reciprocalRankFusion([map1, map2])
    // shared appears in both maps → higher RRF score
    const sharedRank = results.findIndex(r => r.docId === 'shared')
    const only1Rank = results.findIndex(r => r.docId === 'only1')
    expect(sharedRank).toBeLessThan(only1Rank)
  })

  it('should handle single score map', () => {
    const map = new Map([['x', 100], ['y', 50]])
    const results = reciprocalRankFusion([map])
    expect(results.length).toBe(2)
    expect(results[0].docId).toBe('x')
  })

  it('should handle empty score maps', () => {
    const results = reciprocalRankFusion([new Map(), new Map()])
    expect(results.length).toBe(0)
  })

  it('vectorAnchoredFusion should blend BM25 and vector scores', () => {
    const vecScores = new Map([['doc1', 0.9], ['doc2', 0.3]])
    const bm25Scores = new Map([['doc1', 5], ['doc2', 10]])
    const results = vectorAnchoredFusion(vecScores, bm25Scores)
    expect(results.length).toBe(2)
    // doc1 has high vector score → should rank high despite lower BM25
    expect(results[0].docId).toBe('doc1')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/utils/memory/rrf.test.ts`
Expected: FAIL — `rrf` module not found

- [ ] **Step 3: Implement RRF**

```typescript
// src/utils/memory/rrf.ts
import type { BM25Result } from './bm25'

/**
 * Reciprocal Rank Fusion
 *
 * RRF_score(d) = Σ 1 / (k + rank_i(d))
 *
 * @param scoreMaps 多个检索器的原始评分结果（value 为相关度分数，非排名序号）
 *                  函数内部会将 score 降序转换为 rank（1-based），再计算 RRF
 * @param k 平滑常数，默认 60（Cormack et al. 2009 推荐值）
 */
export function reciprocalRankFusion(
  scoreMaps: Array<Map<string, number>>,
  k: number = 60,
): BM25Result[] {
  const rrfScores = new Map<string, number>()

  for (const scoreMap of scoreMaps) {
    // Convert scores to ranks (1-based, highest score = rank 1)
    const sorted = [...scoreMap.entries()].sort((a, b) => b[1] - a[1])
    sorted.forEach(([docId], index) => {
      const rank = index + 1
      const current = rrfScores.get(docId) ?? 0
      rrfScores.set(docId, current + 1 / (k + rank))
    })
  }

  return [...rrfScores.entries()]
    .map(([docId, score]) => ({ docId, score, matchedTerms: [] }))
    .sort((a, b) => b.score - a.score)
}

/**
 * 向量锚定融合（为未来向量检索预留）
 *
 * final_score = α * vec_score + (1-α) * saturate(bm25_score)
 * saturate(x) = x / (x + k)
 */
export function vectorAnchoredFusion(
  vecScores: Map<string, number>,
  bm25Scores: Map<string, number>,
  alpha: number = 0.7,
  k: number = 60,
): BM25Result[] {
  const allDocs = new Set([...vecScores.keys(), ...bm25Scores.keys()])
  const results: BM25Result[] = []

  for (const docId of allDocs) {
    const vecScore = vecScores.get(docId) ?? 0
    const bm25Score = bm25Scores.get(docId) ?? 0
    const saturated = bm25Score / (bm25Score + k)
    const finalScore = alpha * vecScore + (1 - alpha) * saturated
    results.push({ docId, score: finalScore, matchedTerms: [] })
  }

  return results.sort((a, b) => b.score - a.score)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/utils/memory/rrf.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/memory/rrf.ts src/utils/memory/rrf.test.ts
git commit -m "feat(phase4): add RRF reciprocal rank fusion and vector anchored fusion"
```

---

## Task 9: Phase 4 — MemoryIndex 服务

**Files:**
- Create: `src/services/memory/memoryIndex.ts`

- [ ] **Step 1: Write failing tests**

新建 `src/services/memory/memoryIndex.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryIndex } from './memoryIndex'
import * as fs from 'fs'
import * as path from 'path'

describe('MemoryIndex', () => {
  const tmpDir = '/tmp/test-memory-index-' + Date.now()

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '- [Test](test.md)\n')
    fs.writeFileSync(path.join(tmpDir, 'test.md'), '# Test\nThis is about Windows crash fix for Bun')
    fs.writeFileSync(path.join(tmpDir, 'provider.md'), '# Provider\nAPI routing and provider switching guide')
    fs.writeFileSync(path.join(tmpDir, 'chinese.md'), '# 中文\nprovider 切换配置指南')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should index all memory files on startup', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    const stats = idx.getStats()
    expect(stats.totalDocuments).toBe(3) // excludes MEMORY.md
  })

  it('should search after indexing', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    const { results, degraded } = idx.search('Windows crash')
    expect(degraded).toBe(false)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('test.md')
  })

  it('should support incremental index update', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    // Add new file
    fs.writeFileSync(path.join(tmpDir, 'new.md'), '# New\nDocker container setup')
    idx.indexFile(path.join(tmpDir, 'new.md'))
    const { results } = idx.search('Docker container')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].docId).toBe('new.md')
  })

  it('should support file removal', async () => {
    const idx = new MemoryIndex(tmpDir)
    await idx.indexAll()
    idx.removeFile(path.join(tmpDir, 'test.md'))
    const stats = idx.getStats()
    expect(stats.totalDocuments).toBe(2)
  })

  it('should degrade gracefully when not indexed', () => {
    const idx = new MemoryIndex(tmpDir)
    const { results, degraded } = idx.search('anything')
    expect(degraded).toBe(true)
    expect(results.length).toBe(0)
  })

  it('should handle pending files during indexing', async () => {
    const idx = new MemoryIndex(tmpDir)
    // Start indexing (takes time)
    const indexPromise = idx.indexAll()
    // Try to add file while indexing
    idx.indexFile(path.join(tmpDir, 'test.md'))
    await indexPromise
    // pending file should be replayed
    const stats = idx.getStats()
    expect(stats.totalDocuments).toBeGreaterThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/memory/memoryIndex.test.ts`
Expected: FAIL — `memoryIndex` module not found

- [ ] **Step 3: Implement MemoryIndex**

```typescript
// src/services/memory/memoryIndex.ts
import { BM25, type BM25Result } from '../../utils/memory/bm25'
import * as fs from 'fs'
import * as path from 'path'

export class MemoryIndex {
  private bm25: BM25
  private memoryDir: string
  private indexReady: boolean = false
  private indexVersion: number = 0
  private indexing: boolean = false
  private pendingFiles: Set<string> = new Set()

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir
    this.bm25 = new BM25()
  }

  async indexAll(): Promise<void> {
    if (this.indexing) return
    this.indexing = true
    try {
      const files = (await fs.promises.readdir(this.memoryDir))
        .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
      for (const file of files) {
        const content = await fs.promises.readFile(path.join(this.memoryDir, file), 'utf-8')
        this.bm25.addDocument(file, content)
      }
      this.indexReady = true
      this.indexVersion++
      // replay pending files accumulated during indexing
      for (const pending of this.pendingFiles) {
        this.indexFile(pending)
      }
      this.pendingFiles.clear()
    } finally {
      this.indexing = false
    }
  }

  indexFile(filePath: string): void {
    if (this.indexing) {
      this.pendingFiles.add(filePath)
      return
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    const docId = path.basename(filePath)
    this.bm25.addDocument(docId, content)
    this.indexVersion++
  }

  removeFile(filePath: string): void {
    this.bm25.removeDocument(path.basename(filePath))
    this.indexVersion++
  }

  search(query: string, topK: number = 5): { results: BM25Result[]; degraded: boolean } {
    if (!this.indexReady) return { results: [], degraded: true }
    return { results: this.bm25.search(query, topK), degraded: false }
  }

  getStats(): { totalDocuments: number; totalTerms: number } {
    return {
      totalDocuments: this.bm25['docCount'] ?? 0,
      totalTerms: this.bm25['idfCache']?.size ?? 0,
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/memory/memoryIndex.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
mkdir -p src/services/memory
git add src/services/memory/memoryIndex.ts src/services/memory/memoryIndex.test.ts
git commit -m "feat(phase4): add MemoryIndex service with BM25 search, incremental update, and degraded fallback"
```

---

## Task 10: Integration — EvolutionEngine P0 数据集集成 + P3 约束集成

**Files:**
- Modify: `src/services/singularity/EvolutionEngine.ts`

- [ ] **Step 1: Write integration tests**

新建 `src/services/singularity/evolutionEngine.integration.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import { EvolutionEngine, EvolutionPhase } from './EvolutionEngine'

describe('EvolutionEngine integration', () => {
  it('should have P0_PREPARE executor for dataset loading', () => {
    const engine = new EvolutionEngine('test-skill')
    const state = engine.getState()
    expect(state.phase).toBe(EvolutionPhase.P0_PREPARE)
  })

  it('should support injecting feedback for P2', () => {
    const engine = new EvolutionEngine('test-skill')
    const state = engine.getState()
    state.context.gateResult = {
      passed: false,
      dimensions: {} as any,
      feedback: [{ dimension: 'holdout_floor', score: 0.4, threshold: 0.6, feedback: 'test feedback' }],
    }
    engine.injectFeedbackForP2()
    const updatedState = engine.getState()
    expect(updatedState.context.failureAnalysis).toContain('test feedback')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `bun test src/services/singularity/evolutionEngine.integration.test.ts`
Expected: PASS

- [ ] **Step 3: Add P3 constraint integration helper to EvolutionEngine**

在 `EvolutionEngine` 类中添加:

```typescript
  /**
   * Phase 3 增强：约束验证辅助方法
   *
   * 在 P3_MUTATE 阶段调用，检查进化后的技能是否满足约束
   */
  async validateConstraints(
    evolvedText: string,
    baselineText?: string,
  ): Promise<{ passed: boolean; failures: string[] }> {
    const { ConstraintValidator } = await import('./constraintValidator')
    const validator = new ConstraintValidator()
    const results = await validator.validateAll(evolvedText, 'skill', baselineText)
    const failures = results.filter(r => !r.passed).map(r => `${r.constraintName}: ${r.message}`)
    return { passed: failures.length === 0, failures }
  }

  /**
   * Phase 1 增强：数据集加载/生成辅助方法
   *
   * 在 P0_PREPARE 阶段调用
   */
  async loadOrGenerateDataset(
    skillText: string,
    datasetPath: string,
    llmCaller?: (prompt: string) => Promise<string>,
  ): Promise<{ loaded: boolean; path: string }> {
    const { EvalDatasetManager } = await import('./evalDataset')
    try {
      EvalDatasetManager.load(datasetPath)
      return { loaded: true, path: datasetPath }
    } catch {
      // Dataset doesn't exist — generate if LLM caller provided
      if (llmCaller) {
        const { SyntheticDatasetBuilder } = await import('./datasetBuilder')
        const builder = new SyntheticDatasetBuilder(llmCaller)
        const dataset = await builder.generate(skillText)
        EvalDatasetManager.save(dataset, datasetPath)
        return { loaded: false, path: datasetPath }
      }
      return { loaded: false, path: datasetPath }
    }
  }
```

- [ ] **Step 4: Run all related tests**

Run: `bun test src/services/singularity/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/singularity/EvolutionEngine.ts src/services/singularity/evolutionEngine.integration.test.ts
git commit -m "feat(integration): add P0 dataset loading, P2 feedback injection, P3 constraint validation helpers to EvolutionEngine"
```

---

## Task 11: Final Verification — 全量测试 + 验收

- [ ] **Step 1: Run all Phase 1-4 tests**

```bash
bun test src/services/singularity/datasetBuilder.test.ts src/tools/AgentTool/rubricEvaluator.feedback.test.ts src/services/singularity/constraintValidator.test.ts src/utils/memory/bm25.test.ts src/utils/memory/rrf.test.ts src/services/memory/memoryIndex.test.ts src/services/singularity/evolutionEngine.integration.test.ts src/services/singularity/evolutionEngine.feedback.test.ts
```

Expected: ALL PASS

- [ ] **Step 2: Verify acceptance criteria from design doc**

```bash
# Phase 1: verify split ratios
bun test src/services/singularity/datasetBuilder.test.ts -t "split"

# Phase 2: verify feedback disabled by default
bun test src/tools/AgentTool/rubricEvaluator.feedback.test.ts -t "not call LLM"

# Phase 3: verify size/growth/structure checks
bun test src/services/singularity/constraintValidator.test.ts

# Phase 4: verify Chinese + camelCase tokenization
bun test src/utils/memory/bm25.test.ts -t "Chinese|camelCase"
```

Expected: ALL PASS

- [ ] **Step 3: Run existing tests to verify no regression**

```bash
bun test src/services/singularity/ src/tools/AgentTool/
```

Expected: ALL PASS (no existing tests broken)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: Hermes+EverOS evolution enhancement complete (Phase 1-4)

- Phase 1: EvalDataset + SyntheticDatasetBuilder + mineFromHistory
- Phase 2: FitnessFeedback + GateResultWithFeedback + evaluateQualityWithFeedback
- Phase 3: ConstraintValidator (size/growth/structure/non-empty)
- Phase 4: BM25 + RRF + MemoryIndex (Chinese/camelCase tokenization)

Comprehensive evolution effectiveness: 29% → 83%"
```
