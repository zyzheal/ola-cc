/**
 * goalErrorTracker — 统一错误追踪系统
 *
 * 将 5 个分散的错误计数器合并为单一 tracker，使用 Record<ErrorCategory, ...>
 * 而非 Map，确保 AppStateStore JSON 序列化兼容。
 *
 * 设计参考: docs/superpowers/specs/2026-05-28-goal-react-orchestrator-design.md §4.5
 */

// ============================================
// 类型定义
// ============================================

/** 错误类别：描述发生了什么（只用于计数和检测） */
export type ErrorCategory =
  | "runtime_exception"    // catch 块异常（代码 bug）
  | "dead_turn"            // 无可观测变更
  | "critical_analysis"    // 分析结果 critical

/** 恢复层级：描述正在尝试什么（只用于决策） */
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

// ============================================
// 常量
// ============================================

export const DEFAULT_THRESHOLDS: Record<ErrorCategory, number> = {
  runtime_exception: 3,
  dead_turn: 5,
  critical_analysis: 3,
}

// ============================================
// 工厂函数
// ============================================

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

// ============================================
// 操作函数（纯函数，直接修改 tracker）
// ============================================

/** 记录一次错误，对应类别的 count++ */
export function recordError(tracker: UnifiedErrorTracker, category: ErrorCategory): void {
  tracker.categories[category].count++
}

/** 重置指定类别的计数为 0 */
export function resetCategory(tracker: UnifiedErrorTracker, category: ErrorCategory): void {
  tracker.categories[category].count = 0
}

/**
 * 进展时重置：重置 dead_turn 和 runtime_exception
 * critical_analysis 不重置（分析级别的严重问题应持续追踪）
 */
export function resetOnProgress(tracker: UnifiedErrorTracker): void {
  tracker.categories.dead_turn.count = 0
  tracker.categories.runtime_exception.count = 0
}

/** 任一类别计数达到阈值时返回 true */
export function shouldPause(tracker: UnifiedErrorTracker): boolean {
  return (
    tracker.categories.runtime_exception.count >= tracker.categories.runtime_exception.threshold ||
    tracker.categories.dead_turn.count >= tracker.categories.dead_turn.threshold ||
    tracker.categories.critical_analysis.count >= tracker.categories.critical_analysis.threshold
  )
}

/** 获取指定类别的当前错误计数 */
export function getErrorCount(tracker: UnifiedErrorTracker, category: ErrorCategory): number {
  return tracker.categories[category].count
}
