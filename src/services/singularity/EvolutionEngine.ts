/**
 * EvolutionEngine — ASAEF 8阶段进化状态机
 *
 * 基于 ASAEF 五源协同框架的确定性工作流：
 * P0(准备) → P1(回顾) → P2(构思) → P3(修改) → P4(提交) → P5(验证) → P6(门控) → P7(记录) → P8(循环)
 *
 * 每个阶段有明确定义的 I/O 与副作用，禁止跨阶段跳跃。
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
  }

  /** 获取当前状态 */
  getState(): EvolutionState {
    return { ...this.state, history: [...this.state.history] }
  }

  /** 注册阶段执行器 */
  registerExecutor(phase: EvolutionPhase, executor: PhaseExecutor): void {
    this.executors.set(phase, executor)
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
    return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : current
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