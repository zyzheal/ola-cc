/**
 * GoalCompletionRecorder — Goal 执行链路嵌入 record 写入
 *
 * Phase 3 核心模块：
 * 1. 维护全局 LearningSystem 单例
 * 2. goal 完成时自动记录执行记录
 * 3. 集成 TelemetryWriter 遥测写入
 * 4. 支持 ASAEF 5维 AND 门控评估（可选）
 *
 * 调用方只需在 goal 完成时调用 recordGoalCompletion(goal)
 */

import type { QualityInput } from '../../tools/AgentTool/rubricEvaluator.js'
import { evaluateQuality as evaluateRubric } from '../../tools/AgentTool/rubricEvaluator.js'
import type { Goal } from '../../commands/goal/types.js'

// ============================================
// 常量
// ============================================

/** 防污染：磁盘最大保留条数 */
const MAX_DISK_RECORDS = 500

/** 防污染：触发裁剪的阈值比例（达到 max 的 90% 时裁剪） */
const PRUNE_THRESHOLD_RATIO = 0.9

// ============================================
// 单例管理
// ============================================

let _learningSystem: import('../../tools/AgentTool/LearningSystem.js').LearningSystem | null = null

/**
 * 获取全局 LearningSystem 单例
 * 延迟加载：首次调用时动态 require，避免模块求值期的依赖循环
 */
export function getGoalLearningSystem(): import('../../tools/AgentTool/LearningSystem.js').LearningSystem {
  if (!_learningSystem) {
    const { LearningSystem } = require('../../tools/AgentTool/LearningSystem.js') as typeof import('../../tools/AgentTool/LearningSystem.js')
    _learningSystem = new LearningSystem({
      maxRecords: 100,
      confidenceThreshold: 60,
      autoAdjust: true,
      enablePatternLearning: true,
      maxExecutionHistory: 200,
      enablePersistence: true,  // Phase 4: 启用 JSONL 持久化
    })
  }
  return _learningSystem
}

/**
 * 重置单例（主要用于测试）
 */
export function resetGoalLearningSystem(): void {
  _learningSystem = null
}

// ============================================
// Goal 完成记录
// ============================================

/**
 * 记录 goal 完成时的执行记录
 *
 * 写入两条记录：
 * 1. LearningSystem.logExecution() — 内存执行历史（用于对比分析）
 * 2. TelemetryWriter.log() — 磁盘遥测持久化
 *
 * @param goal - 已完成的 goal 对象
 * @param options - 可选参数
 * @returns 执行记录 ID
 */
export function recordGoalCompletion(
  goal: Goal,
  options: {
    /** 任务描述（默认从 goal.objective 获取） */
    taskDescription?: string
    /** 执行结果（默认 success） */
    outcome?: 'success' | 'failure'
    /** EmbodiSkill 信号类型（可选，由外部分析后传入） */
    signalType?: string
    /** 执行耗时 ms（默认从 goal.timeUsedSeconds 换算） */
    durationMs?: number
    /** 测试结果（用于 ASAEF AND 门控评估，可选） */
    testResults?: GoalTestResult[]
    /** 基线 token 数（用于 ASAEF AND 门控评估，可选） */
    baselineTokens?: number
  } = {},
): string {
  const ls = getGoalLearningSystem()
  const taskDesc = options.taskDescription ?? goal.objective
  const outcome = options.outcome ?? 'success'
  const durationMs = options.durationMs ?? (goal.timeUsedSeconds || 0) * 1000

  // 1. 写入 LearningSystem 执行历史
  ls.logExecution({
    skill: 'goal',
    taskDescription: taskDesc,
    outcome,
    score: calculateGoalScore(goal),
    signal: options.signalType
      ? {
          reasoning_trace: `Goal "${goal.objective}" ${outcome === 'success' ? 'completed' : 'failed'}`,
          signal_type: options.signalType as any,
          target_skill_segment: null,
          evidence: `tokensUsed: ${goal.tokensUsed}, timeUsed: ${goal.timeUsedSeconds}s`,
          proposed_revision: '',
        }
      : null,
    edgeCases: [],
    timestamp: new Date(),
    duration_ms: durationMs,
  })

  // 2. 写入 TelemetryWriter 遥测（延迟加载）
  const { TelemetryWriter } = require('../../services/singularity/index.js') as typeof import('../../services/singularity/index.js')
  TelemetryWriter.log('goal', {
    trigger: 'goal-completed',
    version: 'v1.0.0',
    summary: `${outcome === 'success' ? '✅' : '❌'} Goal "${goal.objective}" ${outcome === 'success' ? 'completed' : 'failed'}`,
    score: calculateGoalScore(goal),
    duration_ms: durationMs,
  })

  // 3. 可选：ASAEF 5维 AND 门控评估 — 使用统一 rubricEvaluator
  if (options.testResults) {
    const qualityInput: QualityInput = {
      tokenBudget: goal.tokenBudget,
      tokensUsed: goal.tokensUsed,
      baselineTokens: options.baselineTokens ?? goal.tokenBudget ?? 0,
      testResults: options.testResults.map(r => ({ passed: r.passed, name: r.name, regression: r.regression })),
      triggerAccuracy: undefined, // by default trust external scoring system
    }
    const gateResult = evaluateRubric(qualityInput)
    if (!gateResult.passed) {
      const { getFailedDimensions } = require('../../tools/AgentTool/rubricEvaluator.js') as typeof import('../../tools/AgentTool/rubricEvaluator.js')
      const failedDims = getFailedDimensions(gateResult)
      TelemetryWriter.log('goal', {
        trigger: 'goal-gate-failed',
        version: 'v1.0.0',
        summary: `ASAEF AND gate failed: ${failedDims.join(', ')}`,
        duration_ms: 0,
      })
    }
  }

  // 4. 防污染：定期裁剪磁盘历史（每达到阈值触发一次）
  maybePruneGoalExecutionHistory()

  return `goal_${goal.id}_${Date.now()}`
}

// ============================================
// 防污染：裁剪与分割
// ============================================

/**
 * 计数器：记录上次裁剪时的写入次数，避免每次写入都 stat
 */
let _writeCountSinceLastPrune = 0

/**
 * 检查并裁剪 goal 的磁盘执行历史（防污染）
 *
 * 每写入 PRUNE_THRESHOLD_RATIO * MAX_DISK_RECORDS 条触发一次裁剪
 */
export function maybePruneGoalExecutionHistory(): number {
  _writeCountSinceLastPrune++
  const threshold = Math.floor(MAX_DISK_RECORDS * PRUNE_THRESHOLD_RATIO)
  if (_writeCountSinceLastPrune < threshold) return 0

  _writeCountSinceLastPrune = 0
  const { pruneExecutionHistory } = require('../../services/singularity/storage.js') as typeof import('../../services/singularity/storage.js')
  return pruneExecutionHistory('goal', MAX_DISK_RECORDS)
}

/**
 * 强制裁剪 goal 的磁盘执行历史
 */
export function pruneGoalExecutionHistory(maxRecords = MAX_DISK_RECORDS): number {
  _writeCountSinceLastPrune = 0
  const { pruneExecutionHistory } = require('../../services/singularity/storage.js') as typeof import('../../services/singularity/storage.js')
  return pruneExecutionHistory('goal', maxRecords)
}

/**
 * 计算 goal 的评分（基于 token 利用率）
 *
 * 评分规则：
 * - tokenBudget 为 null 或 0 时返回 100（无预算限制视为成功）
 * - 使用率 <= 50% → 100 分
 * - 使用率 50%-80% → 80-100 分（线性）
 * - 使用率 80%-100% → 50-80 分
 * - 使用率 > 100% → 30 分
 */
function calculateGoalScore(goal: Goal): number {
  if (!goal.tokenBudget || goal.tokenBudget === 0) return 100
  const ratio = goal.tokensUsed / goal.tokenBudget
  if (ratio <= 0.5) return 100
  if (ratio <= 0.8) return Math.round(80 + 20 * ((0.8 - ratio) / 0.3))
  if (ratio <= 1.0) return Math.round(50 + 30 * ((1.0 - ratio) / 0.2))
  return 30
}

/**
 * 获取 LearningSystem 执行统计（对外暴露）
 */
export function getGoalExecutionStats() {
  return getGoalLearningSystem().getExecutionStats('goal')
}

/**
 * 获取 LearningSystem 对比分析（对外暴露）
 */
export function getGoalContrastAnalysis(windowSize = 20) {
  return getGoalLearningSystem().contrastAnalysis('goal', windowSize)
}
