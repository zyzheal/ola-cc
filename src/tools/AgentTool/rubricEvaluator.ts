/**
 * RubricEvaluator — ORION ASAEF 5维 AND 门控评分引擎
 *
 * 通用质量评判标准，与 goal memory compact 逻辑解耦。
 * 可被任何 skill / agent / telemetry 模块调用。
 */

// ============================================
// 类型定义
// ============================================

/** 单个维度的评估结果 */
export interface GateDimension {
  passed: boolean
  value: number | string[]
  threshold: number | string
}

/** ASAEF 5维 AND 门控评估结果 */
export interface GateResult {
  /** true = 所有维度都通过（AND 逻辑） */
  passed: boolean
  dimensions: {
    holdout_floor: GateDimension
    min_delta: GateDimension
    trigger_f1: GateDimension
    cost_budget: GateDimension
    regression_check: GateDimension
  }
}

/** ASAEF 配置（可通过环境变量覆盖） */
export interface RubricConfig {
  holdoutFloor: number        // >= 0.60
  minDelta: number            // >= 0.05
  triggerF1Floor: number      // >= 0.85
  maxCostRatio: number        // <= 1.2x
  /** 基线通过率（用于 passRateDelta fallback，默认 0.5 随机猜测基线） */
  baselinePassRate?: number
}

// ============================================
// 默认配置 + 环境变量覆盖
// ============================================

const DEFAULT_CONFIG: RubricConfig = {
  holdoutFloor: 0.60,
  minDelta: 0.05,
  triggerF1Floor: 0.85,
  maxCostRatio: 1.2,
  baselinePassRate: 0.5,
}

export function getRubricConfig(): RubricConfig {
  return {
    holdoutFloor: parseFloat(process.env.RUBRIC_HOLDOUT_FLOOR ?? String(DEFAULT_CONFIG.holdoutFloor)),
    minDelta: parseFloat(process.env.RUBRIC_MIN_DELTA ?? String(DEFAULT_CONFIG.minDelta)),
    triggerF1Floor: parseFloat(process.env.RUBRIC_TRIGGER_F1 ?? String(DEFAULT_CONFIG.triggerF1Floor)),
    maxCostRatio: parseFloat(process.env.RUBRIC_MAX_COST_RATIO ?? String(DEFAULT_CONFIG.maxCostRatio)),
    baselinePassRate: parseFloat(process.env.RUBRIC_BASELINE_PASS_RATE ?? String(DEFAULT_CONFIG.baselinePassRate)),
  }
}

// ============================================
// 核心评分函数
// ============================================

/**
 * 通用的 QualityInput — 不依赖 Goal 类型，保持模块独立
 */
export interface QualityInput {
  /** token 预算限制（null / 0 = 无限制） */
  tokenBudget: number | null
  /** 实际消耗的 tokens */
  tokensUsed: number
  /** 基线 token 消耗（无 skill 时的预期消耗） */
  baselineTokens: number
  /** 测试结果（可选） */
  testResults?: { passed: boolean; name: string; regression: boolean }[]
  /** 触发准确率（可选，外部评分系统提供） */
  triggerAccuracy?: number
  /** passRate 改进幅度（可选，相比基线方法的通过率提升） */
  passRateDelta?: number
}

/**
 * 执行 5 维 AND 门控评估
 *
 * @param quality - 质量输入对象
 * @param config - 评估配置（默认从环境变量读）
 * @returns GateResult
 */
export function evaluateQuality(quality: QualityInput, config?: RubricConfig): GateResult {
  const cfg = config ?? getRubricConfig()

  // 1. holdout_floor: 留出集通过率
  const passRate = (quality.testResults?.length ?? 0) > 0
    ? quality.testResults!.filter(r => r.passed).length / quality.testResults!.length
    : 1.0

  // 2. min_delta: 相比基线的改进幅度
  // 设计文档定义: passRate 的改进幅度 (新方法passRate - 基线passRate)
  // 如果外部提供了 passRateDelta，直接使用
  // 否则使用配置的基线通过率（默认 0.5 随机猜测基线）
  const baselinePassRate = cfg.baselinePassRate ?? 0.5
  const delta = quality.passRateDelta ?? Math.max(0, passRate - baselinePassRate)

  // 3. trigger_f1: 触发准确率
  const triggerF1 = quality.triggerAccuracy ?? 1.0

  // 4. cost_budget: Token 成本是否在预算内
  const costRatio = quality.baselineTokens > 0
    ? quality.tokensUsed / quality.baselineTokens
    : 1.0

  // 5. regression_check: 回归测试
  const regressions = quality.testResults
    ?.filter(r => r.regression && !r.passed)
    .map(r => r.name) ?? []

  return {
    passed:
      passRate >= cfg.holdoutFloor &&
      delta >= cfg.minDelta &&
      triggerF1 >= cfg.triggerF1Floor &&
      costRatio <= cfg.maxCostRatio &&
      regressions.length === 0,
    dimensions: {
      holdout_floor: {
        passed: passRate >= cfg.holdoutFloor,
        value: passRate,
        threshold: cfg.holdoutFloor,
      },
      min_delta: {
        passed: delta >= cfg.minDelta,
        value: delta,
        threshold: cfg.minDelta,
      },
      trigger_f1: {
        passed: triggerF1 >= cfg.triggerF1Floor,
        value: triggerF1,
        threshold: cfg.triggerF1Floor,
      },
      cost_budget: {
        passed: costRatio <= cfg.maxCostRatio,
        value: costRatio,
        threshold: cfg.maxCostRatio,
      },
      regression_check: {
        passed: regressions.length === 0,
        value: regressions,
        threshold: '[]',
      },
    },
  }
}

/**
 * 获取失败维度的摘要
 */
export function getFailedDimensions(result: GateResult): string[] {
  const failed: string[] = []
  for (const [name, dim] of Object.entries(result.dimensions)) {
    if (!dim.passed) {
      failed.push(`${name} (${dim.value < dim.threshold ? '<' : '>'}${dim.threshold})`)
    }
  }
  return failed
}

// ============================================
// 论文综合评分公式
// ============================================

/**
 * 论文 Finalize 阶段综合评分 Score(v)
 *
 * Score(v) = w1 * passRate - w2 * normCost - w3 * overfitRisk
 *
 * @param passRate - 任务通过率 (0~1)
 * @param normCost - 归一化成本（实际消耗 / 基线消耗）
 * @param overfitRisk - 过拟合风险（随机遮蔽 20% 描述后的性能下降幅度）
 * @param weights - 权重配置（默认 w1=1.0, w2=0.15, w3=0.25）
 */
export function calculateComprehensiveScore(
  passRate: number,
  normCost: number,
  overfitRisk: number,
  weights?: { w1: number; w2: number; w3: number },
): number {
  const w = weights ?? { w1: 1.0, w2: 0.15, w3: 0.25 }
  return Math.max(0, Math.min(100,
    w.w1 * passRate * 100 - w.w2 * normCost * 100 - w.w3 * overfitRisk * 100,
  ))
}

/**
 * 从 GateResult 计算综合评分
 *
 * 将 5 维 AND 门控输出映射为论文综合评分
 * overfitRisk: 回归失败数越多风险越高
 */
export function gateToComprehensiveScore(gate: GateResult): number {
  const passRate = gate.dimensions.holdout_floor.passed
    ? (gate.dimensions.holdout_floor.value as number)
    : 0
  const costRatio = gate.dimensions.cost_budget.passed
    ? (gate.dimensions.cost_budget.value as number)
    : 2.0 // 超预算时惩罚
  // overfitRisk: 回归失败越多，过拟合风险越高
  // 每个回归失败贡献 0.05 的过拟合风险（论文定义: dropout 测试的性能下降幅度）
  const regressions = gate.dimensions.regression_check.passed
    ? 0
    : (gate.dimensions.regression_check.value as string[]).length
  const overfitRisk = regressions * 0.05

  return calculateComprehensiveScore(passRate, costRatio, overfitRisk)
}

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
  const cfg = config ?? getRubricConfig()

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

    const cacheKey = `${skillText.slice(0, 300)}:${dim}`
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
      // Evict expired entries when cache grows large
      if (feedbackCache.size > 100) {
        const now = Date.now()
        for (const [key, entry] of feedbackCache) {
          if (now - entry.cachedAt >= FEEDBACK_CACHE_TTL) {
            feedbackCache.delete(key)
          }
        }
      }
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
