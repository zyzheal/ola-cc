/**
 * GoalMemoryManager — /goal 模式自动内存回收
 *
 * 三个核心组件：
 * 1. BudgetMonitor — 预算阈值监控（默认 70% 触发）
 * 2. CompactTrigger  — 统一触发器（带冷却期，防重复触发）
 * 3. SessionMCRegistry 入口 — P0-01 已移至 cachedMicrocompact.ts
 *
 * P0-02 修复：使用回调延迟方案，不改造 processGoalRuntimeEvent 为 async
 * P0-03 修复：冷却期机制，防止 compact 后每轮重复触发
 */

import type { Goal } from '../../commands/goal/types.js'
import { SessionMCRegistry } from '../../services/compact/cachedMicrocompact.js'

// ============================================
// 配置
// ============================================

export interface GoalMemoryConfig {
  /** 预算使用率阈值，达到后触发 compact（默认 0.7 = 70%） */
  budgetThresholdPct: number
  /** compact 后冷却轮数，冷却期内不重复触发（默认 5） */
  cooldownTurns: number
  /** 冷却期后预算使用率最小增长才再次触发（默认 0.1 = 10%） */
  minBudgetDeltaPct: number
}

function getEnvConfig(): GoalMemoryConfig {
  const envBudgetPct = parseInt(process.env.OLA_CC_GOAL_COMPACT_BUDGET_PCT || '', 10)
  const envCooldown = parseInt(process.env.OLA_CC_GOAL_COMPACT_COOLDOWN_TURNS || '', 10)
  const envDelta = parseInt(process.env.OLA_CC_GOAL_COMPACT_MIN_DELTA_PCT || '', 10)

  return {
    budgetThresholdPct: !isNaN(envBudgetPct) && envBudgetPct > 0 && envBudgetPct <= 100
      ? envBudgetPct / 100
      : 0.7,
    cooldownTurns: !isNaN(envCooldown) && envCooldown >= 0 ? envCooldown : 5,
    minBudgetDeltaPct: !isNaN(envDelta) && envDelta > 0 ? envDelta / 100 : 0.1,
  }
}

const CONFIG = getEnvConfig()

// ============================================
// CompactNeedResult — 触发结果类型
// ============================================

export interface CompactNeedResult {
  shouldCompact: boolean
  reason: 'budget_threshold' | 'context_window' | 'cached_mc_overflow' | null
  message?: string
}

// ============================================
// BudgetMonitor — P0-03 带冷却期
// ============================================

/** 每个 goal 的内存监控状态 */
interface GoalMemoryState {
  /** 上次触发 compact 时的预算使用率 */
  lastCompactBudgetPct: number
  /** 冷却期剩余轮数 */
  cooldownRemaining: number
  /** 累计未触发轮数（goal 启动后） */
  turnsSinceStart: number
}

const goalStates = new Map<string, GoalMemoryState>()

function getOrCreateState(goalId: string): GoalMemoryState {
  let state = goalStates.get(goalId)
  if (!state) {
    state = {
      lastCompactBudgetPct: 0,
      cooldownRemaining: 0,
      turnsSinceStart: 0,
    }
    goalStates.set(goalId, state)
  }
  return state
}

/** goal 完成/暂停时清理状态 */
export function disposeGoalMemory(goalId: string): void {
  goalStates.delete(goalId)
  // 同时清理 SessionMCRegistry 中的对应实例
  SessionMCRegistry.dispose(goalId)
}

/**
 * 检查预算阈值，带冷却期保护（P0-03 修复）
 *
 * 核心逻辑：
 * - budget 使用率 >= 70% 时触发
 * - 触发后进入 cooldown（默认 5 turns）
 * - cooldown 结束后，只有预算使用率增长 >= 10% 才再次触发
 * - 防止 compact 后每轮重复触发（compact 不减少 goal.tokensUsed）
 */
export function checkBudgetThreshold(
  goal: Goal,
): { shouldCompact: boolean; reason: string } {
  // 无预算限制，不需要触发
  if (goal.tokenBudget === null || goal.tokenBudget === 0) {
    return { shouldCompact: false, reason: '' }
  }

  const state = getOrCreateState(goal.id)
  state.turnsSinceStart++

  // 冷却期中，跳过检查
  if (state.cooldownRemaining > 0) {
    state.cooldownRemaining--
    return { shouldCompact: false, reason: 'cooldown' }
  }

  const budgetPct = goal.tokensUsed / goal.tokenBudget

  // 检查是否达到阈值
  if (budgetPct < CONFIG.budgetThresholdPct) {
    return { shouldCompact: false, reason: '' }
  }

  // 检查预算使用率增长是否足够（防重复触发 P0-03）
  const delta = budgetPct - state.lastCompactBudgetPct
  if (state.lastCompactBudgetPct > 0 && delta < CONFIG.minBudgetDeltaPct) {
    return {
      shouldCompact: false,
      reason: `budget delta too small (${(delta * 100).toFixed(1)}% < ${(CONFIG.minBudgetDeltaPct * 100).toFixed(1)}%)`,
    }
  }

  // 触发 compact，进入冷却期
  state.lastCompactBudgetPct = budgetPct
  state.cooldownRemaining = CONFIG.cooldownTurns

  return {
    shouldCompact: true,
    reason: `budget at ${(budgetPct * 100).toFixed(1)}% >= ${(CONFIG.budgetThresholdPct * 100).toFixed(1)}%`,
  }
}

/**
 * 统一入口：检查是否需要 compact（同步，P0-02 回调延迟方案）
 *
 * 综合检查：
 * 1. 预算阈值 >= 70% → 触发
 * 2. 未来可扩展：上下文窗口检查（委托 auto-compact）
 *
 * @returns CompactNeedResult — shouldCompact 为 true 时调用方应触发 compact
 */
export function checkMemoryIfNeeded(
  goal: Goal,
): CompactNeedResult {
  try {
    // 1. 预算阈值检查
    const budgetResult = checkBudgetThreshold(goal)
    if (budgetResult.shouldCompact) {
      return {
        shouldCompact: true,
        reason: 'budget_threshold',
        message: budgetResult.reason,
      }
    }

    // 2. 未来可在此添加上下文窗口检查
    // if (contextWindowCheck(goal, messages)) { ... }

    return { shouldCompact: false, reason: null }
  } catch (error) {
    // P1-04 降级策略：检查失败时跳过，不中断 goal 执行
    console.error('[goalMemory] checkMemoryIfNeeded error:', error)
    return { shouldCompact: false, reason: null }
  }
}

/**
 * 获取当前内存监控状态（调试用）
 */
export function getGoalMemoryDebugInfo(goalId: string) {
  const state = goalStates.get(goalId)
  if (!state) return null
  return {
    ...state,
    budgetThresholdPct: CONFIG.budgetThresholdPct,
    cooldownTurns: CONFIG.cooldownTurns,
    minBudgetDeltaPct: CONFIG.minBudgetDeltaPct,
  }
}
