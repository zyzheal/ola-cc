/**
 * 学习系统 - 从执行历史中持续优化
 *
 * 资深agent专家优化的核心组件，通过分析历史执行记录
 * 自动调整检测策略，提高准确性和减少维护成本
 *
 * 新增：支持 SkillEvolver 对比分析引擎（winners \ losers）
 */

import { z } from 'zod/v4'
import { DetectionResult, Issue } from './AdaptiveDetector'
import type { StructuredAnalysisResult } from './AgentAnalyzer'
import { saveExecutionRecord, loadExecutionHistory } from '../../services/singularity/storage'

// ============================================
// SkillEvolver 对比分析结果类型
// ============================================

export interface ContrastResult {
  delta: {
    uniqueToWinners: string[]  // 胜者独有的反思类型
    uniqueToLosers: string[]   // 败者独有的反思类型
    scoreDelta: number         // 平均分差
    winnerCount: number
    loserCount: number
  } | null
  insight: string
}

// ============================================
// 执行记录类型（替代原有的仅误报记录）
// ============================================

export interface ExecutionRecord {
  id: string
  skill: string
  taskDescription: string
  outcome: 'success' | 'failure'
  score: number                          // singularity 5维评分 (0-100)
  signal: StructuredAnalysisResult | null // EmbodiSkill 四类型反思
  edgeCases: string[]
  timestamp: Date
  duration_ms: number
  // A3: Dependency-aware priority fields
  priority?: number                      // task priority weight (default 1)
  unlockCount?: number                   // dependencies unblocked (default 0)
  active?: boolean                       // current active task (default false)
}

/** Frontier score result for dependency-aware prioritization */
export interface FrontierScore {
  record: ExecutionRecord
  frontierScore: number
  breakdown: {
    priorityComponent: number
    ageComponent: number
    unlockComponent: number
    activeComponent: number
  }
}

// 误报记录类型（保留向后兼容）
export interface FalsePositiveRecord {
  id: string
  issueType: string
  pattern: string
  reason: string
  confidenceReduction: number
  reportedBy: string
  timestamp: Date
}

// 学习系统配置
export interface LearningConfig {
  maxRecords: number
  confidenceThreshold: number
  autoAdjust: boolean
  enablePatternLearning: boolean
  maxExecutionHistory?: number           // 执行历史最大条数（内存）
  enablePersistence?: boolean             // Phase 4: 是否持久化到 JSONL
  /** 对比分析：胜者最低分数阈值（默认 70） */
  winnerThreshold?: number
  /** 对比分析：败者最高分数阈值（默认 50） */
  loserThreshold?: number
}

// 学习系统主类
export class LearningSystem {
  // 新增：执行历史（双缓冲区：success + failure）
  private executionHistory: ExecutionRecord[] = []

  // 保留：向后兼容
  private records: FalsePositiveRecord[]
  private config: LearningConfig

  constructor(config: LearningConfig = {}) {
    this.config = {
      maxRecords: 100,
      confidenceThreshold: 60,
      autoAdjust: true,
      enablePatternLearning: true,
      maxExecutionHistory: 200,
      enablePersistence: false,
      winnerThreshold: 70,
      loserThreshold: 50,
      ...config
    }
    this.records = []
  }

  // ============================================
  // 执行记录方法（SkillEvolver / EmbodiSkill 集成）
  // ============================================

  /**
   * 记录一次技能执行结果
   *
   * 如果 enablePersistence 为 true，同步写入 JSONL 持久化
   */
  logExecution(record: Omit<ExecutionRecord, 'id'>): void {
    const full: ExecutionRecord = {
      ...record,
      id: this.generateId(),
    }
    this.executionHistory.push(full)
    this.pruneExecutionHistory()

    // Phase 4: 持久化到 JSONL
    if (this.config.enablePersistence) {
      try {
        saveExecutionRecord(record.skill, full as unknown as Record<string, unknown>)
      } catch {
        // 持久化失败不阻断主流程
      }
    }
  }

  /**
   * 从磁盘加载某 skill 的执行历史
   *
   * 仅在 enablePersistence 为 true 时有效
   *
   * @param skill - 技能名称
   * @param merge - 是否合并到内存（默认 true，会去重）
   */
  loadFromDisk(skill: string, merge = true): ExecutionRecord[] {
    if (!this.config.enablePersistence) return []

    try {
      const raw = loadExecutionHistory(skill) as unknown as ExecutionRecord[]
      if (merge) {
        const existingIds = new Set(this.executionHistory.map(r => r.id))
        const newRecords = raw.filter(r => r.id && !existingIds.has(r.id))
        this.executionHistory.push(...newRecords)
        this.pruneExecutionHistory()
      }
      return raw
    } catch {
      return []
    }
  }

  /**
   * 清理执行历史
   */
  private pruneExecutionHistory(): void {
    const max = this.config.maxExecutionHistory ?? 200
    if (this.executionHistory.length <= max) return
    this.executionHistory = this.executionHistory.slice(-max)
  }

  // ============================================
  // SkillEvolver 对比分析引擎
  // ============================================

  /**
   * SkillEvolver 对比分析 — Δ = winners \ losers
   *
   * 基于论文 Algorithm 1 的 Contrast 步骤：
   * - 提取成功轨迹独有的信号（什么有效）
   * - 提取失败轨迹独有的信号（什么无效）
   * - 计算平均分差
   *
   * @param skill - 技能名称
   * @param windowSize - 分析窗口大小（默认 20 条）
   */
  contrastAnalysis(skill: string, windowSize = 20): ContrastResult {
    const relevant = this.executionHistory
      .filter(r => r.skill === skill)
      .slice(-windowSize)

    const winnerThreshold = this.config.winnerThreshold ?? 70
    const loserThreshold = this.config.loserThreshold ?? 50
    const winners = relevant.filter(r => r.outcome === 'success' && r.score >= winnerThreshold)
    const losers = relevant.filter(r => r.outcome === 'failure' || r.score < loserThreshold)

    if (winners.length === 0 || losers.length === 0) {
      return {
        delta: null,
        insight: `数据不足：胜者 ${winners.length} 条，败者 ${losers.length} 条，无法进行对比分析`,
      }
    }

    // Δ = winners \ losers — 提取胜者独有的反思类型
    const winnerSignals = new Set(
      winners.map(w => w.signal?.signal_type).filter((s): s is string => !!s)
    )
    const loserSignals = new Set(
      losers.map(l => l.signal?.signal_type).filter((s): s is string => !!s)
    )

    const uniqueToWinners = [...winnerSignals].filter(s => !loserSignals.has(s))
    const uniqueToLosers = [...loserSignals].filter(s => !winnerSignals.has(s))

    const avgWin = winners.reduce((s, w) => s + w.score, 0) / winners.length
    const avgLose = losers.reduce((s, l) => s + l.score, 0) / losers.length

    return {
      delta: {
        uniqueToWinners,
        uniqueToLosers,
        scoreDelta: avgWin - avgLose,
        winnerCount: winners.length,
        loserCount: losers.length,
      },
      insight: this.generateInsight(uniqueToWinners, uniqueToLosers, avgWin, avgLose),
    }
  }

  /**
   * 生成对比洞察
   */
  private generateInsight(
    uniqueWinners: string[],
    uniqueLosers: string[],
    avgWin: number,
    avgLose: number
  ): string {
    const parts: string[] = []
    if (uniqueWinners.length > 0) {
      parts.push(`胜者独有信号：${uniqueWinners.join('、')}，这些可能是成功关键因素`)
    }
    if (uniqueLosers.length > 0) {
      parts.push(`败者独有信号：${uniqueLosers.join('、')}，这些可能是失败根因`)
    }
    parts.push(`平均分差：${(avgWin - avgLose).toFixed(1)} 分（胜者 ${avgWin.toFixed(1)} vs 败者 ${avgLose.toFixed(1)}）`)
    return parts.join('；')
  }

  /**
   * 获取执行历史统计
   */
  getExecutionStats(skill?: string): {
    total: number
    success: number
    failure: number
    avgScore: number
    signalDistribution: Record<string, number>
  } {
    const relevant = skill
      ? this.executionHistory.filter(r => r.skill === skill)
      : this.executionHistory

    const signalDist: Record<string, number> = {}
    for (const r of relevant) {
      if (r.signal?.signal_type) {
        signalDist[r.signal.signal_type] = (signalDist[r.signal.signal_type] || 0) + 1
      }
    }

    return {
      total: relevant.length,
      success: relevant.filter(r => r.outcome === 'success').length,
      failure: relevant.filter(r => r.outcome === 'failure').length,
      avgScore: relevant.length > 0
        ? relevant.reduce((s, r) => s + r.score, 0) / relevant.length
        : 0,
      signalDistribution: signalDist,
    }
  }

  /**
   * 获取某技能的执行记录数
   */
  getRecordCount(skill: string): number {
    return this.executionHistory.filter(r => r.skill === skill).length
  }

  /**
   * 获取某技能的执行历史
   */
  getExecutionHistory(skill: string, limit = 50): ExecutionRecord[] {
    return this.executionHistory
      .filter(r => r.skill === skill)
      .slice(-limit)
  }

  /**
   * 为 SyntheticDatasetBuilder 提供执行历史数据
   * 复用现有 getExecutionHistory() 公共方法
   */
  getHistoryForMining(skill: string): ExecutionRecord[] {
    return this.getExecutionHistory(skill, 20)
  }

  // ============================================
  // A3: Dependency-Aware Frontier Scoring
  // ============================================

  /**
   * Compute frontier scores for execution records.
   *
   * P1 fix: logarithmic age (bounded), diminishing returns for unlocks.
   *
   * Formula:
   *   priority*10 + AGE_WEIGHT*ln(1+ageHours)/ln(1+AGE_HALF_LIFE_HOURS)
   *   + UNLOCK_WEIGHT*(1-exp(-unlockCount/UNLOCK_DECAY)) + ACTIVE_BONUS
   *
   * @param skill - The skill/agent type
   * @param limit - Max records to score (default 50)
   * @returns Sorted array of FrontierScore (highest first)
   */
  computeFrontierScores(skill: string, limit = 50): FrontierScore[] {
    // Frontier scoring constants
    const AGE_WEIGHT = 20           // max age bonus at half-life
    const AGE_HALF_LIFE_HOURS = 169 // 7 days — ln(1+169)/ln(1+169) = 1.0
    const UNLOCK_WEIGHT = 15        // max unlock bonus (asymptote)
    const UNLOCK_DECAY = 3          // diminishing returns half-point
    const ACTIVE_BONUS = 20         // flat bonus for active tasks

    const records = this.executionHistory
      .filter(r => r.skill === skill)
      .slice(-limit)

    const now = Date.now()

    const scores: FrontierScore[] = records.map(record => {
      const priority = record.priority ?? 1
      const unlockCount = record.unlockCount ?? 0
      const active = record.active ?? false

      // Age in hours since record creation
      const ageMs = now - record.timestamp.getTime()
      const ageHours = ageMs / (1000 * 60 * 60)

      const priorityComponent = priority * 10
      // P1: logarithmic age — bounded, ~20 at 7 days
      const ageComponent = AGE_WEIGHT * Math.log(1 + ageHours) / Math.log(1 + AGE_HALF_LIFE_HOURS)
      // P1: diminishing returns — saturates at UNLOCK_WEIGHT
      const unlockComponent = UNLOCK_WEIGHT * (1 - Math.exp(-unlockCount / UNLOCK_DECAY))
      const activeComponent = active ? ACTIVE_BONUS : 0

      const frontierScore = priorityComponent + ageComponent + unlockComponent + activeComponent

      return {
        record,
        frontierScore,
        breakdown: {
          priorityComponent,
          ageComponent,
          unlockComponent,
          activeComponent,
        },
      }
    })

    // Sort by frontier score descending
    scores.sort((a, b) => b.frontierScore - a.frontierScore)
    return scores
  }

  // ============================================
  // 原有误报记录方法（向后兼容）
  // ============================================

  /**
   * 记录误报（保留向后兼容）
   */
  logFalsePositive(
    issue: Issue,
    reason: string,
    reportedBy: string
  ): void {
    const record: FalsePositiveRecord = {
      id: this.generateId(),
      issueType: issue.type,
      pattern: this.extractPattern(issue.description),
      reason,
      confidenceReduction: this.calculateReduction(issue.severity),
      reportedBy,
      timestamp: new Date()
    }

    this.records.push(record)
    this.pruneOldRecords()
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * 提取模式
   */
  private extractPattern(description: string): string {
    return description.substring(0, 50) + '...'
  }

  /**
   * 计算置信度降低
   */
  private calculateReduction(severity: 'error' | 'warning' | 'info'): number {
    switch (severity) {
      case 'error': return 50
      case 'warning': return 30
      case 'info': return 20
      default: return 25
    }
  }

  /**
   * 清理旧记录
   */
  private pruneOldRecords(): void {
    if (this.records.length <= this.config.maxRecords) return

    this.records.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    this.records = this.records.slice(0, this.config.maxRecords)
  }

  /**
   * 获取所有记录
   */
  getRecords(): FalsePositiveRecord[] {
    return [...this.records]
  }

  /**
   * 清空记录
   */
  clearRecords(): void {
    this.records = []
  }

  // ============================================
  // A2: 行动链结晶 — 结构化经验提取
  // ============================================

  /**
   * Crystallize an action chain into structured, reusable knowledge.
   *
   * Analyzes a sequence of tool calls to extract:
   * - Key patterns (what worked / what didn't)
   * - Tool usage sequences
   * - Error recovery strategies
   *
   * @param skill - The skill/agent type
   * @param actionChain - Sequence of tool call results from the agent execution
   * @returns Crystallized knowledge text, or empty string if insufficient data
   */
  crystallize(
    skill: string,
    actionChain: Array<{
      toolName: string
      input: string
      output: string
      success: boolean
      duration_ms: number
    }>,
  ): string {
    if (actionChain.length === 0) return ''

    // Extract patterns from the action chain
    const toolSequence = actionChain.map(a => a.toolName)
    const failures = actionChain.filter(a => !a.success)
    const successes = actionChain.filter(a => a.success)

    // Build structured knowledge
    const parts: string[] = []

    // Tool usage pattern
    const uniqueTools = [...new Set(toolSequence)]
    parts.push(`Tools used: ${uniqueTools.join(', ')}`)

    // Success/failure ratio
    const successRate =
      actionChain.length > 0
        ? ((successes.length / actionChain.length) * 100).toFixed(0)
        : '0'
    parts.push(`Success rate: ${successRate}% (${successes.length}/${actionChain.length})`)

    // Error patterns
    if (failures.length > 0) {
      const errorTools = [...new Set(failures.map(f => f.toolName))]
      parts.push(`Failed tools: ${errorTools.join(', ')}`)

      // Extract error messages (first 100 chars of each)
      const errorMessages = failures
        .map(f => `${f.toolName}: ${f.output.slice(0, 100)}`)
        .slice(0, 3)
      parts.push(`Error patterns:\n${errorMessages.map(m => `- ${m}`).join('\n')}`)
    }

    // Duration analysis
    const totalDuration = actionChain.reduce((s, a) => s + a.duration_ms, 0)
    const avgDuration =
      actionChain.length > 0 ? Math.round(totalDuration / actionChain.length) : 0
    parts.push(`Avg tool duration: ${avgDuration}ms`)

    // Sequence pattern (first 5 tools)
    const seqPattern = toolSequence.slice(0, 5).join(' → ')
    if (toolSequence.length > 5) {
      parts.push(`Sequence: ${seqPattern} → ...`)
    } else {
      parts.push(`Sequence: ${seqPattern}`)
    }

    return parts.join('\n')
  }
}

// 学习系统工厂
export class LearningSystemFactory {
  static create(config?: LearningConfig): LearningSystem {
    return new LearningSystem(config)
  }
}