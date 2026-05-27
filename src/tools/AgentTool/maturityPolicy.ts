/**
 * MaturityPolicy — ORION 技能成熟度标准化判定
 *
 * 统一判定规则，替代 goalMemory 和 crystallizing SKILL.md 中的重复代码。
 *
 * 支持：
 * - 环境变量覆盖阈值（MATURITY_TESTED_RUNS, MATURITY_TESTED_AVG 等）
 * - 多语言提示（locale = 'zh' | 'en'）
 */

export type MaturityLevel = 'draft' | 'tested' | 'hardened' | 'crystallized'

export interface MaturityPolicy {
  tested:    PolicyEntry
  hardened:  PolicyEntry
  crystallized: PolicyEntry
}

export interface PolicyEntry {
  minRuns: number
  minAvg: number
  requireEdgeCases?: boolean
}

export type LocaleOption = 'zh' | 'en'

/** 默认策略 */
const DEFAULT_POLICY: MaturityPolicy = {
  tested:     { minRuns: 3,  minAvg: 60 },
  hardened:   { minRuns: 5,  minAvg: 80, requireEdgeCases: true },
  crystallized: { minRuns: 5, minAvg: 90, requireEdgeCases: true },
}

/**
 * 获取策略（支持环境变量覆盖）
 *
 * 环境变量：
 *   MATURITY_TESTED_RUNS / MATURITY_TESTED_AVG
 *   MATURITY_HARDENED_RUNS / MATURITY_HARDENED_AVG
 *   MATURITY_CRYSTALLIZED_RUNS / MATURITY_HARDENED_AVG
 */
export function getMaturityPolicy(): MaturityPolicy {
  return {
    tested: {
      minRuns: parseInt(process.env.MATURITY_TESTED_RUNS || String(DEFAULT_POLICY.tested.minRuns), 10),
      minAvg: parseInt(process.env.MATURITY_TESTED_AVG || String(DEFAULT_POLICY.tested.minAvg), 10),
    },
    hardened: {
      minRuns: parseInt(process.env.MATURITY_HARDENED_RUNS || String(DEFAULT_POLICY.hardened.minRuns), 10),
      minAvg: parseInt(process.env.MATURITY_HARDENED_AVG || String(DEFAULT_POLICY.hardened.minAvg), 10),
      requireEdgeCases: process.env.MATURITY_HARDENED_EDGE_CASES !== 'false',
    },
    crystallized: {
      minRuns: parseInt(process.env.MATURITY_CRYSTALLIZED_RUNS || String(DEFAULT_POLICY.crystallized.minRuns), 10),
      minAvg: parseInt(process.env.MATURITY_CRYSTALLIZED_AVG || String(DEFAULT_POLICY.crystallized.minAvg), 10),
      requireEdgeCases: process.env.MATURITY_CRYSTALLIZED_EDGE_CASES !== 'false',
    },
  }
}

/** 兼容旧代码：直接引用时使用默认策略 */
export const MATURITY_POLICY: MaturityPolicy = DEFAULT_POLICY

/**
 * 根据执行次数、平均分、edge cases 数量判断当前成熟度
 *
 * @param policy - 策略（可选，默认 DEFAULT_POLICY）
 */
export function getMaturity(
  executionCount: number,
  avgScore: number,
  edgeCasesHandled: number,
  policy?: MaturityPolicy,
): MaturityLevel {
  const p = policy ?? DEFAULT_POLICY

  if (executionCount >= p.crystallized.minRuns &&
      avgScore >= p.crystallized.minAvg &&
      (!p.crystallized.requireEdgeCases || edgeCasesHandled > 0)) {
    return 'crystallized'
  }
  if (executionCount >= p.hardened.minRuns &&
      avgScore >= p.hardened.minAvg &&
      (!p.hardened.requireEdgeCases || edgeCasesHandled > 0)) {
    return 'hardened'
  }
  if (executionCount >= p.tested.minRuns &&
      avgScore >= p.tested.minAvg) {
    return 'tested'
  }
  return 'draft'
}

/**
 * 获取成熟度到下一级的提示
 *
 * @param locale - 语言（默认 'zh'）
 * @param policy - 策略（可选，默认 DEFAULT_POLICY）
 */
export function getNextMaturityHint(
  current: MaturityLevel,
  executionCount: number,
  avgScore: number,
  edgeCases: number,
  locale: LocaleOption = 'zh',
  policy?: MaturityPolicy,
): string | null {
  const p = policy ?? DEFAULT_POLICY

  const t = locale === 'en' ? STRINGS_EN : STRINGS_ZH

  switch (current) {
    case 'draft':
      if (executionCount < p.tested.minRuns) {
        const needed = p.tested.minRuns - executionCount
        return t.draftNeedsRuns(needed)
      }
      return t.draftNeedsAvg(p.tested.minAvg)
    case 'tested':
      if (executionCount < p.hardened.minRuns) {
        const needed = p.hardened.minRuns - executionCount
        return t.testedNeedsRuns(needed, p.hardened.minAvg)
      }
      if (!edgeCases) {
        return t.testedNeedsEdgeCase
      }
      return t.testedNeedsAvg(p.hardened.minAvg)
    case 'hardened':
      return t.hardenedNeedsAvg(p.crystallized.minAvg)
    case 'crystallized':
      return null
    default:
      return null
  }
}

// ============================================
// 多语言字符串
// ============================================

interface MaturityStrings {
  draftNeedsRuns: (needed: number) => string
  draftNeedsAvg: (minAvg: number) => string
  testedNeedsRuns: (needed: number, minAvg: number) => string
  testedNeedsEdgeCase: string
  testedNeedsAvg: (minAvg: number) => string
  hardenedNeedsAvg: (minAvg: number) => string
}

const STRINGS_ZH: MaturityStrings = {
  draftNeedsRuns: (needed: number) => `需要 ${needed} 更多执行才能评估`,
  draftNeedsAvg: (minAvg: number) => `avg score 需达到 ${minAvg}`,
  testedNeedsRuns: (needed: number, minAvg: number) => `需要 ${needed} 更多执行且 avg >= ${minAvg}`,
  testedNeedsEdgeCase: '需要记录至少一个 edge case',
  testedNeedsAvg: (minAvg: number) => `avg score 需达到 ${minAvg}`,
  hardenedNeedsAvg: (minAvg: number) => `avg score 需达到 ${minAvg}`,
}

const STRINGS_EN: MaturityStrings = {
  draftNeedsRuns: (needed: number) => `Needs ${needed} more execution(s) to evaluate`,
  draftNeedsAvg: (minAvg: number) => `Needs avg score >= ${minAvg}`,
  testedNeedsRuns: (needed: number, minAvg: number) => `Needs ${needed} more run(s) and avg >= ${minAvg}`,
  testedNeedsEdgeCase: 'Needs at least one recorded edge case',
  testedNeedsAvg: (minAvg: number) => `Needs avg score >= ${minAvg}`,
  hardenedNeedsAvg: (minAvg: number) => `Needs avg score >= ${minAvg}`,
}
