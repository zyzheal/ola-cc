/**
 * AdaptiveTrigger — 自适应进化触发引擎 (智能增强1)
 *
 * 从被动修复转向主动响应：检测退化信号 → 决策判断 → 自动建议进化
 *
 * 3层架构：
 * - 信号检测层：评分下降/维度退化/执行异常/edge case暴露
 * - 决策判断层：权重加权 → urgency判定 → 冷却期控制
 * - 自动执行层：建议而非强制（保持用户控制权）
 */

import { ScoreManager } from './index'
import { TelemetryWriter } from './index'
import { RegistryManager, type RegistryEntry } from './index'

// ============================================
// 信号类型
// ============================================

export interface DegradationSignal {
  type: 'score_decline' | 'dimension_weak' | 'duration_anomaly' | 'edgecase_exposure'
  skill: string
  severity: 'low' | 'medium' | 'high'
  evidence: string
  weight: number       // 信号权重 (0-1)
  rawValue: number      // 信号原始值
  threshold: number     // 信号阈值
}

export interface TriggerDecision {
  shouldEvolve: boolean
  urgency: 'low' | 'medium' | 'high'
  targetDimensions: string[]
  recommendedLayer: 1 | 2 | 3
  cooldownRemaining: number    // 冷却期剩余执行次数
  signals: DegradationSignal[] // 触发的信号列表
  compositeScore: number       // 加权综合退化分 (0-1)
}

// ============================================
// 信号权重配置
// ============================================

const SIGNAL_WEIGHTS: Record<DegradationSignal['type'], number> = {
  score_decline: 0.35,
  dimension_weak: 0.25,
  duration_anomaly: 0.15,
  edgecase_exposure: 0.15,
  // trigger_mismatch: 0.10 (未来扩展)
}

// 冷却期：同一skill 3次执行内不重复建议进化
const COOLDOWN_EXECUTIONS = 3

// ============================================
// AdaptiveTriggerEngine 主类
// ============================================

export class AdaptiveTriggerEngine {

  /**
   * 检测单个skill的所有退化信号
   */
  static detectSignals(skillName: string): DegradationSignal[] {
    const signals: DegradationSignal[] = []

    // 1. 评分持续下降检测
    const trend = ScoreManager.getTrend(skillName)
    if (trend.versions.length >= 3) {
      const last3 = trend.versions.slice(-3)
      const scores = last3.map(v => v.avg)
      const first = scores[0]
      const last = scores[scores.length - 1]
      const decline = first - last // 正值=下降

      if (decline >= 10) {
        signals.push({
          type: 'score_decline',
          skill: skillName,
          severity: decline >= 20 ? 'high' : decline >= 10 ? 'medium' : 'low',
          evidence: `评分连续下降 ${first}→${last}（降幅${decline}分）`,
          weight: SIGNAL_WEIGHTS.score_decline,
          rawValue: decline,
          threshold: 10,
        })
      }
    }

    // 2. 维度退化检测
    const scoreData = ScoreManager.get(skillName)
    if (scoreData) {
      const currentVer = scoreData.versions.find(v => v.version === scoreData.currentVersion)
      if (currentVer && currentVer.scores.length >= 2) {
        // 找最低维度（从最近的score entry中提取）
        const recentScores = currentVer.scores.slice(-3)
        // 简化：没有维度数据时用总分代替
        const avgScore = currentVer.averageScore
        if (avgScore < 50) {
          signals.push({
            type: 'dimension_weak',
            skill: skillName,
            severity: avgScore < 30 ? 'high' : avgScore < 50 ? 'medium' : 'low',
            evidence: `平均评分低于修复阈值：${avgScore}/100`,
            weight: SIGNAL_WEIGHTS.dimension_weak,
            rawValue: avgScore,
            threshold: 50,
          })
        }
      }
    }

    // 3. 执行时间异常检测
    const telemetry = TelemetryWriter.list(skillName, 5)
    if (telemetry.length >= 3) {
      const durations = telemetry.map(t => t.duration_ms).filter(d => d > 0)
      if (durations.length >= 3) {
        const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length
        const baseline = durations[0] // 最早记录作为基线
        const ratio = avgDuration / baseline

        if (ratio >= 1.5) {
          signals.push({
            type: 'duration_anomaly',
            skill: skillName,
            severity: ratio >= 2.0 ? 'high' : ratio >= 1.5 ? 'medium' : 'low',
            evidence: `执行时间增长：基线${baseline}ms→平均${avgDuration}ms（增长${(ratio * 100 - 100).toFixed(0)}%）`,
            weight: SIGNAL_WEIGHTS.duration_anomaly,
            rawValue: ratio,
            threshold: 1.5,
          })
        }
      }
    }

    // 4. Edge case暴露检测
    if (scoreData) {
      const currentVer = scoreData.versions.find(v => v.version === scoreData.currentVersion)
      if (currentVer) {
        const recentEdgeCases = currentVer.scores
          .slice(-3)
          .flatMap(s => s.edgeCasesEncountered ?? [])
        const uniqueEdgeCases = new Set(recentEdgeCases)

        if (uniqueEdgeCases.size >= 3) {
          signals.push({
            type: 'edgecase_exposure',
            skill: skillName,
            severity: uniqueEdgeCases.size >= 5 ? 'high' : 'medium',
            evidence: `近期发现${uniqueEdgeCases.size}个新edge case：${[...uniqueEdgeCases].slice(0, 3).join(', ')}`,
            weight: SIGNAL_WEIGHTS.edgecase_exposure,
            rawValue: uniqueEdgeCases.size,
            threshold: 3,
          })
        }
      }
    }

    return signals
  }

  /**
   * 检测所有skill的退化信号
   */
  static detectAllSignals(): DegradationSignal[] {
    const registry = RegistryManager.get()
    const allSignals: DegradationSignal[] = []
    for (const skillName of Object.keys(registry.skills)) {
      allSignals.push(...AdaptiveTriggerEngine.detectSignals(skillName))
    }
    return allSignals
  }

  /**
   * 基于信号做出进化触发决策
   */
  static makeDecision(skillName: string, signals: DegradationSignal[]): TriggerDecision {
    // 计算加权综合退化分
    const compositeScore = signals.reduce((sum, s) => sum + s.weight * (s.rawValue / s.threshold), 0)

    // 冷却期：检查最近执行次数
    const registry = RegistryManager.get()
    const entry = registry.skills[skillName]
    const cooldownRemaining = entry ? Math.max(0, COOLDOWN_EXECUTIONS - (entry.executionCount % (COOLDOWN_EXECUTIONS + 1))) : 0

    // 是否应触发进化
    const shouldEvolve = compositeScore >= 0.5 && cooldownRemaining === 0

    // 紧急度
    const highSeverityCount = signals.filter(s => s.severity === 'high').length
    const urgency: TriggerDecision['urgency'] = highSeverityCount >= 2 ? 'high' : compositeScore >= 1.0 ? 'high' : compositeScore >= 0.7 ? 'medium' : 'low'

    // 目标维度（从维度弱信号中提取）
    const targetDimensions = signals
      .filter(s => s.type === 'dimension_weak' || s.type === 'score_decline')
      .map(s => s.evidence.match(/维度[：:]\s*(\w+)/)?.[1] ?? 'general')

    // 建议层级
    const recommendedLayer: TriggerDecision['recommendedLayer'] = urgency === 'high' ? 2 : 1

    return {
      shouldEvolve,
      urgency,
      targetDimensions,
      recommendedLayer,
      cooldownRemaining,
      signals,
      compositeScore,
    }
  }

  /**
   * 对所有skill执行退化检查，返回需要进化的skill列表
   */
  static checkAll(): TriggerDecision[] {
    const registry = RegistryManager.get()
    const decisions: TriggerDecision[] = []

    for (const skillName of Object.keys(registry.skills)) {
      const signals = AdaptiveTriggerEngine.detectSignals(skillName)
      if (signals.length > 0) {
        decisions.push(AdaptiveTriggerEngine.makeDecision(skillName, signals))
      }
    }

    // 按紧急度排序：high > medium > low
    return decisions.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 }
      return order[a.urgency] - order[b.urgency]
    })
  }
}