/**
 * EvolutionEngine — ASAEF 8阶段进化状态机
 *
 * 基于 ASAEF 五源协同框架的确定性工作流：
 * P0(准备) → P1(回顾) → P2(构思) → P3(修改) → P4(提交) → P5(验证) → P6(门控) → P7(记录) → P8(循环)
 *
 * 每个阶段有明确定义的 I/O 与副作用，禁止跨阶段跳跃。
 *
 * Harness 设计模式融合（Phase 2）：
 * - P0 增强：spec.md 契约模式（来自 Harness harness_plan）
 * - P5 增强：独立评审模式（来自 Harness harness_review）
 * - P7 增强：证据打包模式（来自 Harness harness_release）
 */

// ============================================
// 阶段定义
// ============================================

export enum EvolutionPhase {
  P0_PREPARE = 'P0_PREPARE',
  P1_REVIEW = 'P1_REVIEW',
  P2_CONCEIVE = 'P2_CONCEIVE',
  P3_MUTATE = 'P3_MUTATE',
  P4_COMMIT = 'P4_COMMIT',
  P5_VERIFY = 'P5_VERIFY',
  P6_GATE = 'P6_GATE',
  P7_RECORD = 'P7_RECORD',
  P8_LOOP = 'P8_LOOP',
}

/** 进化状态 */
export interface EvolutionState {
  phase: EvolutionPhase
  iteration: number
  skill: string
  layer: 1 | 2 | 3
  stuckCount: number
  /** 所有迭代中已发生的阶段变更历史 */
  history: { phase: EvolutionPhase; iteration: number; timestamp: Date }[]
  /** 当前阶段的输入/输出 */
  context: Record<string, unknown>
}

// ============================================
// Harness 设计模式融合：契约类型定义
// ============================================

/**
 * SpecContract — 来自 Harness harness_plan 的契约模式
 *
 * 定义进化任务的范围、验收标准和约束条件
 */
export interface SpecContract {
  title: string
  scope: string
  acceptanceCriteria: string[]
  unknowns: string[]
  stopConditions: string[]
  dependencies: string[]
  createdAt: Date
  iteration: number
}

/**
 * ReviewReport — 来自 Harness harness_review 的独立评审模式
 *
 * 评审者 ≠ 实现者，避免自我审查偏差
 */
export interface ReviewReport {
  taskId: string
  reviewer: 'independent-auditor'
  passed: boolean
  findings: {
    severity: 'blocker' | 'advisory' | 'info'
    dimension: string
    description: string
    evidence: string
  }[]
  score: number
  recommendation: 'approve' | 'revise' | 'reject'
  reviewedAt: Date
}

/**
 * EvidencePackage — 来自 Harness harness_release 的证据打包模式
 *
 * 结构化验证证据，而非仅靠记忆
 */
export interface EvidencePackage {
  skill: string
  iteration: number
  spec: SpecContract
  review: ReviewReport | null
  testResults: {
    passed: number
    failed: number
    total: number
    details: { name: string; passed: boolean; duration: number }[]
  }
  artifacts: {
    type: 'diff' | 'log' | 'screenshot' | 'metric'
    name: string
    content: string
  }[]
  metrics: {
    scoreDelta: number
    costRatio: number
    passRate: number
  }
  packagedAt: Date
}

/** 门控决策结果 */
export type GateDecision = 'KEEP' | 'DISCARD' | 'ROLLBACK'

/** 动作结果 */
export interface PhaseResult {
  nextPhase: EvolutionPhase
  decision?: GateDecision
  context: Record<string, unknown>
}

// ============================================
// 配置
// ============================================

export interface EvolutionConfig {
  maxIterations: number
  layerPromotionThreshold: number
  earlyStoppingPatience: number
  defaultLayer: 1 | 2 | 3
}

const DEFAULT_CONFIG: EvolutionConfig = {
  maxIterations: 10,
  layerPromotionThreshold: 3,
  earlyStoppingPatience: 5,
  defaultLayer: 1,
}

// ============================================
// 阶段执行器接口
// ============================================

export interface PhaseExecutor {
  execute(state: EvolutionState, config?: EvolutionConfig): Promise<PhaseResult>
}

// ============================================
// 主状态机
// ============================================

export class EvolutionEngine {
  private state: EvolutionState
  private config: EvolutionConfig
  private executors: Map<EvolutionPhase, PhaseExecutor>
  private noImprovementCount: number = 0
  /** P0 创建的 git worktree 路径（用于隔离进化过程） */
  private workspacePath: string | null = null

  /** Harness 设计模式融合：契约管理 */
  private specContract: SpecContract | null = null
  private reviewReport: ReviewReport | null = null
  private evidencePackage: EvidencePackage | null = null

  constructor(
    skill: string,
    config?: Partial<EvolutionConfig>,
    executors?: Map<EvolutionPhase, PhaseExecutor>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.state = {
      phase: EvolutionPhase.P0_PREPARE,
      iteration: 0,
      skill,
      layer: this.config.defaultLayer,
      stuckCount: 0,
      history: [],
      context: {},
    }
    this.executors = executors ?? new Map()
    // 注册默认 P0 执行器：创建 git worktree 隔离 workspace
    if (!this.executors.has(EvolutionPhase.P0_PREPARE)) {
      this.executors.set(EvolutionPhase.P0_PREPARE, new P0DefaultExecutor())
    }
  }

  /** 获取当前状态 */
  getState(): EvolutionState {
    return { ...this.state, history: [...this.state.history] }
  }

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

  /** 注册阶段执行器 */
  registerExecutor(phase: EvolutionPhase, executor: PhaseExecutor): void {
    this.executors.set(phase, executor)
  }

  // ============================================
  // Harness 设计模式融合：契约管理 API
  // ============================================

  /**
   * P0 增强：创建 spec.md 契约（来自 Harness harness_plan）
   *
   * 在准备阶段定义进化任务的范围、验收标准和约束条件
   */
  createSpecContract(params: {
    title: string
    scope: string
    acceptanceCriteria: string[]
    unknowns?: string[]
    stopConditions?: string[]
    dependencies?: string[]
  }): SpecContract {
    this.specContract = {
      title: params.title,
      scope: params.scope,
      acceptanceCriteria: params.acceptanceCriteria,
      unknowns: params.unknowns ?? [],
      stopConditions: params.stopConditions ?? ['所有测试通过', '无回归'],
      dependencies: params.dependencies ?? [],
      createdAt: new Date(),
      iteration: this.state.iteration,
    }

    // 将契约注入状态上下文
    this.state.context.specContract = this.specContract
    return this.specContract
  }

  /**
   * 获取当前 spec 契约
   */
  getSpecContract(): SpecContract | null {
    return this.specContract ?? (this.state.context.specContract as SpecContract | null)
  }

  /**
   * P5 增强：执行独立评审（来自 Harness harness_review）
   *
   * 评审者 ≠ 实现者，避免自我审查偏差
   */
  async executeIndependentReview(params: {
    taskId: string
    testResults: { passed: boolean; name: string; regression: boolean }[]
    score: number
    weakDimensions: string[]
  }): Promise<ReviewReport> {
    const spec = this.getSpecContract()
    const findings: ReviewReport['findings'] = []

    // 检查验收标准
    if (spec) {
      for (const criteria of spec.acceptanceCriteria) {
        // 这里应该由独立的 LLM 评审，简化为基于测试结果的检查
        const criteriaMet = params.testResults.some(r => r.passed && r.name.includes(criteria.substring(0, 20)))
        if (!criteriaMet) {
          findings.push({
            severity: 'blocker',
            dimension: 'acceptance-criteria',
            description: `未满足验收标准: ${criteria}`,
            evidence: '测试结果中未找到匹配的通过测试',
          })
        }
      }
    }

    // 检查弱维度
    for (const dim of params.weakDimensions) {
      findings.push({
        severity: 'advisory',
        dimension: dim,
        description: `维度 ${dim} 评分较低，建议优化`,
        evidence: `当前评分: ${params.score}`,
      })
    }

    // 检查停止条件
    if (spec) {
      for (const condition of spec.stopConditions) {
        if (condition.includes('测试通过') && params.testResults.some(r => !r.passed)) {
          findings.push({
            severity: 'blocker',
            dimension: 'stop-condition',
            description: `停止条件未满足: ${condition}`,
            evidence: `${params.testResults.filter(r => !r.passed).length} 个测试失败`,
          })
        }
      }
    }

    const blockerCount = findings.filter(f => f.severity === 'blocker').length
    const passed = blockerCount === 0 && params.score >= 60

    this.reviewReport = {
      taskId: params.taskId,
      reviewer: 'independent-auditor',
      passed,
      findings,
      score: params.score,
      recommendation: passed ? 'approve' : blockerCount > 0 ? 'reject' : 'revise',
      reviewedAt: new Date(),
    }

    // 将评审报告注入状态上下文
    this.state.context.reviewReport = this.reviewReport
    return this.reviewReport
  }

  /**
   * 获取评审报告
   */
  getReviewReport(): ReviewReport | null {
    return this.reviewReport ?? (this.state.context.reviewReport as ReviewReport | null)
  }

  /**
   * P7 增强：打包证据（来自 Harness harness_release）
   *
   * 结构化验证证据，而非仅靠记忆
   */
  packageEvidence(params: {
    testResults: EvidencePackage['testResults']
    artifacts?: EvidencePackage['artifacts']
    scoreDelta: number
    costRatio: number
  }): EvidencePackage {
    const spec = this.getSpecContract()
    const review = this.getReviewReport()

    this.evidencePackage = {
      skill: this.state.skill,
      iteration: this.state.iteration,
      spec: spec ?? {
        title: this.state.skill,
        scope: '未定义',
        acceptanceCriteria: [],
        unknowns: [],
        stopConditions: [],
        dependencies: [],
        createdAt: new Date(),
        iteration: this.state.iteration,
      },
      review,
      testResults: params.testResults,
      artifacts: params.artifacts ?? [],
      metrics: {
        scoreDelta: params.scoreDelta,
        costRatio: params.costRatio,
        passRate: params.testResults.total > 0
          ? params.testResults.passed / params.testResults.total
          : 0,
      },
      packagedAt: new Date(),
    }

    // 将证据包注入状态上下文
    this.state.context.evidencePackage = this.evidencePackage
    return this.evidencePackage
  }

  /**
   * 获取证据包
   */
  getEvidencePackage(): EvidencePackage | null {
    return this.evidencePackage ?? (this.state.context.evidencePackage as EvidencePackage | null)
  }

  /**
   * 验证契约完成度
   *
   * 检查所有验收标准是否满足，所有停止条件是否达成
   */
  validateContractCompletion(): {
    passed: boolean
    blockers: string[]
    advisories: string[]
  } {
    const spec = this.getSpecContract()
    const review = this.getReviewReport()

    if (!spec) {
      return { passed: true, blockers: [], advisories: [] }
    }

    const blockers: string[] = []
    const advisories: string[] = []

    // 检查验收标准
    for (const criteria of spec.acceptanceCriteria) {
      // 简化检查：如果评审通过则认为满足
      if (review && !review.passed) {
        const relatedFinding = review.findings.find(f =>
          f.description.includes(criteria.substring(0, 20))
        )
        if (relatedFinding && relatedFinding.severity === 'blocker') {
          blockers.push(`未满足: ${criteria}`)
        }
      }
    }

    // 检查停止条件
    for (const condition of spec.stopConditions) {
      if (condition.includes('测试通过')) {
        const evidence = this.getEvidencePackage()
        if (evidence && evidence.testResults.failed > 0) {
          blockers.push(`停止条件未达成: ${condition}`)
        }
      }
    }

    return {
      passed: blockers.length === 0,
      blockers,
      advisories,
    }
  }

  /**
   * 运行一轮完整的进化循环
   *
   * 严格按 P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 顺序执行
   */
  async runOnce(): Promise<EvolutionState> {
    // 从当前阶段开始，执行直到 P8 决定下一轮
    let currentPhase = this.state.phase

    while (true) {
      const executor = this.executors.get(currentPhase)
      if (!executor) {
        // 无执行器时跳过（默认行为：推进到下一阶段）
        const next = this.defaultNextPhase(currentPhase)
        if (next === currentPhase) break // P8 结束
        this.state.phase = next
        currentPhase = next
        continue
      }

      const result = await executor.execute(this.state, this.config)
      this.recordHistory(currentPhase)

      // 更新上下文
      this.state.context = { ...this.state.context, ...result.context }
      this.state.phase = result.nextPhase

      // 处理门控决策
      if (result.decision === 'DISCARD' || result.decision === 'ROLLBACK') {
        this.state.stuckCount++
        this.noImprovementCount++
        // DISCARD/ROLLBACK → 回到 P2 构思
        this.state.phase = EvolutionPhase.P2_CONCEIVE
      }

      // P8 循环判定
      if (result.nextPhase === EvolutionPhase.P8_LOOP) {
        if (this.shouldTerminate()) {
          break
        }
        // 下一轮迭代
        this.state.iteration++
        this.state.phase = EvolutionPhase.P0_PREPARE
        // 检查是否需要升层
        if (this.state.stuckCount >= this.config.layerPromotionThreshold) {
          this.promoteLayer()
          this.state.stuckCount = 0
        }
        break
      }

      currentPhase = this.state.phase
    }

    return this.getState()
  }

  /**
   * 连续运行直到终止条件满足
   */
  async runToCompletion(): Promise<{
    finalState: EvolutionState
    iterationsExecuted: number
  }> {
    let iterations = 0

    while (!this.shouldTerminate() && iterations < this.config.maxIterations) {
      await this.runOnce()
      iterations++
    }

    return { finalState: this.getState(), iterationsExecuted: iterations }
  }

  // ============================================
  // 内部方法
  // ============================================

  private recordHistory(phase: EvolutionPhase): void {
    this.state.history.push({
      phase,
      iteration: this.state.iteration,
      timestamp: new Date(),
    })
  }

  private defaultNextPhase(current: EvolutionPhase): EvolutionPhase {
    // ASAEF 设计约束: 禁止跨阶段跳跃
    // 如果无执行器注册，当前阶段被视为"pass-through"，
    // 但仍然严格按顺序推进到下一个阶段
    const order: EvolutionPhase[] = [
      EvolutionPhase.P0_PREPARE,
      EvolutionPhase.P1_REVIEW,
      EvolutionPhase.P2_CONCEIVE,
      EvolutionPhase.P3_MUTATE,
      EvolutionPhase.P4_COMMIT,
      EvolutionPhase.P5_VERIFY,
      EvolutionPhase.P6_GATE,
      EvolutionPhase.P7_RECORD,
      EvolutionPhase.P8_LOOP,
    ]
    const idx = order.indexOf(current)
    if (idx < 0 || idx >= order.length - 1) {
      // P8 是最终阶段，返回自身表示循环结束
      return current
    }
    return order[idx + 1]
  }

  private shouldTerminate(): boolean {
    return (
      this.state.iteration >= this.config.maxIterations ||
      this.noImprovementCount >= this.config.earlyStoppingPatience
    )
  }

  private promoteLayer(): void {
    if (this.state.layer < 3) {
      this.state.layer = (this.state.layer + 1) as 1 | 2 | 3
    }
  }

  /** 重置状态（用于重启进化） */
  reset(skill?: string): void {
    this.state = {
      phase: EvolutionPhase.P0_PREPARE,
      iteration: 0,
      skill: skill ?? this.state.skill,
      layer: this.config.defaultLayer,
      stuckCount: 0,
      history: [],
      context: {},
    }
    this.noImprovementCount = 0
  }

  /** 获取 workspace 路径（P0 创建的隔离环境） */
  getWorkspacePath(): string | null {
    return this.workspacePath ?? (this.state.context.workspacePath as string | null)
  }

  /** 清理 workspace（进化结束后删除 worktree 或目录） */
  cleanupWorkspace(): void {
    const wsPath = this.getWorkspacePath()
    if (!wsPath) return
    try {
      const wsType = this.state.context.workspaceType as string
      if (wsType === 'worktree') {
        // git worktree 需要用 git 命令清理
        const { execSync } = require('child_process')
        try {
          execSync(`git worktree remove "${wsPath}" --force`, { stdio: 'pipe' })
        } catch {
          // force remove failed, fallback to manual cleanup
          fs.rmSync(wsPath, { recursive: true, force: true })
        }
      } else {
        fs.rmSync(wsPath, { recursive: true, force: true })
      }
    } catch {
      // cleanup failed silently — workspace may have been manually removed
    }
  }
}

// ============================================
// 工具函数
// ============================================

/** Layer 成本描述 */
export const LAYER_COST: Record<1 | 2 | 3, string> = {
  1: '毫秒级 — 修改 description/metadata',
  2: '秒级 — 修改 body/instruction 逻辑',
  3: '分钟级 — 修改 scripts/ 或工具链',
}

// ============================================
// DiverseStrategies — SkillEvolver K=4 变异策略
// ============================================

/**
 * 策略类型枚举（来自 SkillEvolver 论文算法）
 *
 * NOT temperature sampling — fundamentally different repair approaches.
 * Each strategy addresses the same weakness with a different philosophy.
 */
export enum StrategyType {
  CONSERVATIVE = 'conservative',   // Add missing documentation/declarations
  STRUCTURAL = 'structural',       // Reorganize workflow to surface the weakness
  DEFENSIVE = 'defensive',         // Add fallback/error handling guidance
  CREATIVE = 'creative',           // Merge the fix into the main flow
}

export interface DiverseStrategy {
  type: StrategyType
  name: string
  description: string
  approach: string
  /** Which Layer this strategy best aligns with */
  preferredLayer: 1 | 2 | 3
  /** Which rubric dimension this strategy targets */
  targetDimensions: string[]
  /** Estimated lines of change */
  estimatedLines: number
}

/**
 * 生成 K=4 多样化修复策略
 *
 * 基于 SkillEvolver DiverseStrategies 算法：
 * 每次迭代生成 4 个截然不同的候选策略，而非温度采样。
 * 策略必须在**方法**上不同（不仅仅是措辞差异）。
 *
 * @param weakDimensions - 低分维度列表
 * @param currentLayer - 当前变异层级 (L1/L2/L3)
 * @returns 4 个多样化策略
 */
export function generateDiverseStrategies(
  weakDimensions: string[],
  currentLayer: 1 | 2 | 3,
): DiverseStrategy[] {
  const strategies: DiverseStrategy[] = []

  // S1: Conservative — 添加缺失的内容
  strategies.push({
    type: StrategyType.CONSERVATIVE,
    name: 'conservative-addition',
    description: 'Add missing documentation, declarations, or edge case listings',
    approach: `For dimensions ${weakDimensions.join(', ')}: add a dedicated section listing the missing elements without changing the existing workflow logic`,
    preferredLayer: 1,
    targetDimensions: weakDimensions,
    estimatedLines: 5 + weakDimensions.length * 2,
  })

  // S2: Structural — 重新组织workflow
  strategies.push({
    type: StrategyType.STRUCTURAL,
    name: 'structural-reorganization',
    description: 'Reorganize workflow steps to surface weak areas earlier',
    approach: `Rearrange workflow so that ${weakDimensions.join(', ')} considerations are checked at each step, not just at the end`,
    preferredLayer: 2,
    targetDimensions: weakDimensions,
    estimatedLines: 10 + weakDimensions.length * 3,
  })

  // S3: Defensive — 添加防御性处理
  strategies.push({
    type: StrategyType.DEFENSIVE,
    name: 'defensive-fallback',
    description: 'Add fallback paths and error recovery guidance',
    approach: `For each step where ${weakDimensions.join(', ')} could fail, add explicit "what if X fails?" branches with recovery actions`,
    preferredLayer: 2,
    targetDimensions: weakDimensions,
    estimatedLines: 8 + weakDimensions.length * 4,
  })

  // S4: Creative — 融入主线逻辑
  strategies.push({
    type: StrategyType.CREATIVE,
    name: 'creative-embedding',
    description: 'Merge fixes into the primary workflow flow',
    approach: `Instead of adding separate sections for ${weakDimensions.join(', ')}, embed the handling directly into existing workflow steps so it feels natural`,
    preferredLayer: weakDimensions.includes('correctness') ? 2 : 1,
    targetDimensions: weakDimensions,
    estimatedLines: 6 + weakDimensions.length * 3,
  })

  // Diversity check: 如果2+策略太相似，标记警告
  const approaches = strategies.map(s => s.approach.substring(0, 30))
  const uniqueApproaches = new Set(approaches)
  if (uniqueApproaches.size < 3) {
    // 重新生成以确保多样性（此处简化为标记，实际应由LLM重新提议）
    strategies[3].approach = `Radically different approach: instead of incremental fixes, propose a fundamentally different workflow sequence that inherently avoids ${weakDimensions.join(', ')} failures`
    strategies[3].name = 'creative-radical'
  }

  // Layer alignment: 根据当前层级排序优先策略
  strategies.sort((a, b) => {
    const aScore = a.preferredLayer === currentLayer ? 0 : Math.abs(a.preferredLayer - currentLayer)
    const bScore = b.preferredLayer === currentLayer ? 0 : Math.abs(b.preferredLayer - currentLayer)
    return aScore - bScore
  })

  return strategies
}

/**
 * 检查策略是否与SurgicalPatch约束兼容
 *
 * @param strategy - 候选策略
 * @param totalLines - SKILL.md 总行数
 * @param maxChangeRatio - 最大改动比例 (默认0.15)
 * @param maxAbsoluteLines - 最大绝对改动行数 (默认30)
 */
export function checkSurgicalPatchConstraint(
  strategy: DiverseStrategy,
  totalLines: number,
  maxChangeRatio = 0.15,
  maxAbsoluteLines = 30,
): { withinBudget: boolean; budgetLines: number; actualEstimate: number } {
  const budgetLines = Math.min(
    Math.floor(totalLines * maxChangeRatio),
    maxAbsoluteLines,
  )
  return {
    withinBudget: strategy.estimatedLines <= budgetLines,
    budgetLines,
    actualEstimate: strategy.estimatedLines,
  }
}

/** 获取某阶段的中文描述 */
export function getPhaseDescription(phase: EvolutionPhase): string {
  const descriptions: Record<EvolutionPhase, string> = {
    [EvolutionPhase.P0_PREPARE]: '准备 — 创建 Git 隔离 workspace、加载 evolve_plan.md、跑基线',
    [EvolutionPhase.P1_REVIEW]: '回顾 — 读取 results.tsv, experiments.jsonl, git log',
    [EvolutionPhase.P2_CONCEIVE]: '构思 — 引用 trace 证据 → 分析失败模式 → 生成候选改动',
    [EvolutionPhase.P3_MUTATE]: '修改 — 执行分层原子改动（L1/L2/L3）',
    [EvolutionPhase.P4_COMMIT]: '提交 — Git commit + tag',
    [EvolutionPhase.P5_VERIFY]: '验证 — 三层评测: L1(quick) → L2(grader) → L3(blind)',
    [EvolutionPhase.P6_GATE]: '门控 — 5维 AND 决策: KEEP / DISCARD / ROLLBACK',
    [EvolutionPhase.P7_RECORD]: '记录 — 写入实验记忆，生成结构化 telemetry',
    [EvolutionPhase.P8_LOOP]: '循环 — Stuck Detection → Layer Promotion → Early Stopping',
  }
  return descriptions[phase] ?? '未知阶段'
}

// ============================================
// 默认 P0 执行器 — Git worktree 隔离
// ============================================

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * P0 默认执行器：创建 git worktree 作为进化隔离 workspace
 *
 * ASAEF 设计约束：进化过程在独立 git worktree 中运行，
 * 防止修改污染主项目。P4(提交) 在 worktree 内 commit，
 * P6(门控) DISCARD 时直接删除 worktree（git worktree remove）。
 */
export class P0DefaultExecutor implements PhaseExecutor {
  async execute(state: EvolutionState, config?: EvolutionConfig): Promise<PhaseResult> {
    const skill = state.skill
    const baseDir = path.join(os.homedir(), '.ola-cc', 'singularity', 'evolve-workspaces')
    const workspaceDir = path.join(baseDir, `${skill}-iter${state.iteration}`)

    // 确保 workspace 目录存在
    fs.mkdirSync(baseDir, { recursive: true })

    // 尝试创建 git worktree（如果主仓库可用）
    let workspaceCreated = false
    let workspaceType: 'worktree' | 'directory' = 'directory'

    try {
      // 检查是否有 git 仓库
      const gitDir = findGitRoot()
      if (gitDir) {
        // 创建 git worktree 作为隔离环境
        const branchName = `evolve/${skill}/iter${state.iteration}`
        const { execSync } = require('child_process')
        try {
          execSync(`git worktree add "${workspaceDir}" -b "${branchName}"`, {
            cwd: gitDir,
            stdio: 'pipe',
          })
          workspaceType = 'worktree'
          workspaceCreated = true
        } catch {
          // worktree 创建失败（分支已存在等），退化为普通目录
          fs.mkdirSync(workspaceDir, { recursive: true })
          workspaceCreated = true
        }
      } else {
        // 无 git 仓库，使用普通目录（非隔离模式）
        fs.mkdirSync(workspaceDir, { recursive: true })
        workspaceCreated = true
      }
    } catch {
      // 任何失败都回退到普通目录
      fs.mkdirSync(workspaceDir, { recursive: true })
      workspaceCreated = true
    }

    return {
      nextPhase: EvolutionPhase.P1_REVIEW,
      context: {
        workspacePath: workspaceDir,
        workspaceType,
        workspaceCreated,
        isolated: workspaceType === 'worktree',
      },
    }
  }
}

/**
 * 从当前工作目录向上查找 git 根目录
 */
function findGitRoot(): string | null {
  let current = process.cwd()
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}