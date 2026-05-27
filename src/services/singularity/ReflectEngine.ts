/**
 * ReflectEngine — skill自我反思闭环引擎 (智能增强4)
 *
 * EmbodiSkill深度集成：执行→反思→诊断→改进→验证→记录
 *
 * 4类型反思闭环映射：
 * - DISCOVERY → 新增Workflow步骤 (L2)
 * - OPTIMIZATION → 修改现有步骤使其更高效 (L1→L2)
 * - SKILL_DEFECT → SurgicalPatch修补缺陷 (L2→L3)
 * - EXECUTION_LAPSE → 添加强调/提醒 (L1)
 */

import { ScoreManager, RegistryManager } from './index'
import { AdaptiveTriggerEngine } from './AdaptiveTrigger'

// ============================================
// 反思结果类型
// ============================================

export type SignalType = 'DISCOVERY' | 'OPTIMIZATION' | 'SKILL_DEFECT' | 'EXECUTION_LAPSE'

export interface ReflectResult {
  skill: string
  signalType: SignalType
  diagnosis: string             // 精确诊断描述
  targetSegment: string         // SKILL.md中需要修改的部分
  suggestedFix: string          // 具体修改建议
  estimatedLines: number        // 预估改动行数
  confidence: number            // 诊断置信度(0-1)
  improvementType: 'add_section' | 'modify_step' | 'patch_defect' | 'add_emphasis'
  recommendedLayer: 1 | 2 | 3
}

// 四类型→改进映射
const SIGNAL_TO_FIX: Record<SignalType, ReflectResult['improvementType'] & { layer: 1 | 2 | 3; description: string }> = {
  DISCOVERY: { improvementType: 'add_section', layer: 2, description: '新增Workflow步骤覆盖发现的缺失内容' },
  OPTIMIZATION: { improvementType: 'modify_step', layer: 1, description: '修改现有步骤使其更高效' },
  SKILL_DEFECT: { improvementType: 'patch_defect', layer: 2, description: 'SurgicalPatch修补缺陷逻辑' },
  EXECUTION_LAPSE: { improvementType: 'add_emphasis', layer: 1, description: '添加⚠强调提醒，防止执行者偏离' },
}

// ============================================
// ReflectEngine 主类
// ============================================

export class ReflectEngine {

  /**
   * 分析skill执行输出，判断反思类型
   *
   * 核心区分原则（EmbodiSkill论文核心贡献）：
   * SKILL_DEFECT = skill策略本身有错误 → 修改skill
   * EXECUTION_LAPSE = skill正确但执行者未遵循 → 只强调，不修改逻辑
   */
  static diagnose(
    skillName: string,
    score: number,
    executionOutput: string,
    previousAvg: number,
  ): ReflectResult {
    // 基于评分和退化信号判断反思类型
    const signals = AdaptiveTriggerEngine.detectSignals(skillName)

    // 确定signalType
    let signalType: SignalType
    let diagnosis: string
    let targetSegment: string

    const scoreDelta = score - previousAvg

    if (score >= 85 && scoreDelta >= 5) {
      // 高评分且比上次好 → Discovery
      signalType = 'DISCOVERY'
      diagnosis = `Skill在本次执行中表现优秀(${score}/100)，发现可以进一步优化的模式`
      targetSegment = 'Workflow末尾'
    } else if (score >= 70 && scoreDelta >= 0) {
      // 稳定良好 → Optimization
      signalType = 'OPTIMIZATION'
      diagnosis = `Skill稳定运行(${score}/100)，但存在优化空间：执行时间或token效率可提升`
      targetSegment = 'Workflow各步骤'
    } else if (score < 50 || (signals.some(s => s.type === 'score_decline' && s.severity === 'high'))) {
      // 明确失败 → SKILL_DEFECT
      signalType = 'SKILL_DEFECT'
      diagnosis = `Skill策略本身存在缺陷(${score}/100)，产出逻辑错误或不完整`
      targetSegment = '核心Workflow步骤'
    } else {
      // 中等评分但逻辑看起来正确 → EXECUTION_LAPSE
      signalType = 'EXECUTION_LAPSE'
      diagnosis = `Skill策略可能正确(${score}/100)，但执行者未遵循指导——考虑添加强调而非修改逻辑`
      targetSegment = '关键步骤添加⚠提醒'
    }

    const fixMapping = SIGNAL_TO_FIX[signalType]

    // 生成改进建议
    const suggestedFix = ReflectEngine.generateFixSuggestion(skillName, signalType, diagnosis, signals)

    // 预估改动行数
    const estimatedLines = signalType === 'EXECUTION_LAPSE' ? 3 : signalType === 'DISCOVERY' ? 8 : 5

    // 置信度
    const confidence = score < 30 ? 0.9 : score < 50 ? 0.75 : score < 70 ? 0.6 : 0.5

    return {
      skill: skillName,
      signalType,
      diagnosis,
      targetSegment,
      suggestedFix,
      estimatedLines,
      confidence,
      improvementType: fixMapping.improvementType,
      recommendedLayer: fixMapping.layer,
    }
  }

  /**
   * 生成具体改进建议
   */
  private static generateFixSuggestion(
    skillName: string,
    signalType: SignalType,
    diagnosis: string,
    signals: import('./AdaptiveTrigger').DegradationSignal[],
  ): string {
    switch (signalType) {
      case 'DISCOVERY':
        const discoveryItems = signals
          .filter(s => s.type === 'edgecase_exposure')
          .map(s => s.evidence)
          .join('; ')
        return `在Workflow末尾新增步骤，覆盖发现的新场景：${discoveryItems || '将本次执行中的有效模式编码为新步骤'}`

      case 'OPTIMIZATION':
        const dimWeak = signals.find(s => s.type === 'dimension_weak')
        return `优化Workflow步骤，减少冗余描述和重复步骤。${dimWeak ? `目标维度：${dimWeak.evidence}` : '目标：减少token消耗'}`

      case 'SKILL_DEFECT':
        const scoreDecline = signals.find(s => s.type === 'score_decline')
        return `使用SurgicalPatch修补缺陷：${scoreDecline ? scoreDecline.evidence : '修复核心逻辑错误'}。改动控制在15%/30行内。`

      case 'EXECUTION_LAPSE':
        return `不修改skill逻辑，仅在关键步骤添加⚠强调标记和"必须执行"提示，防止执行者偏离有效指导`

      default:
        return '无法生成改进建议'
    }
  }

  /**
   * 对所有skill执行反思诊断
   */
  static reflectAll(): ReflectResult[] {
    const registry = RegistryManager.get()
    const results: ReflectResult[] = []

    for (const skillName of Object.keys(registry.skills)) {
      const entry = registry.skills[skillName]
      if (entry && entry.executionCount >= 2) {
        const avgScore = ScoreManager.getAverage(skillName)
        const previousAvg = avgScore // 用当前平均作为previous（未来可从历史版本取）
        const result = ReflectEngine.diagnose(skillName, avgScore, '', previousAvg)
        if (result.confidence >= 0.5) {
          results.push(result)
        }
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence)
  }

  /**
   * 将反思结果映射为可执行的修改建议列表
   */
  static mapToExecutableChanges(reflectResult: ReflectResult): {
    action: string
    targetFile: string
    changeType: 'add' | 'modify' | 'patch' | 'emphasis'
    estimatedLines: number
    withinBudget: boolean
  }[] {
    const budget = Math.min(
      Math.floor(200 * 0.15), // 200行SKILL.md的15%
      30,                     // 最大30行
    )

    return [{
      action: reflectResult.suggestedFix,
      targetFile: `~/.ola-cc/skills/orion-${reflectResult.skill}/SKILL.md`,
      changeType: reflectResult.improvementType,
      estimatedLines: reflectResult.estimatedLines,
      withinBudget: reflectResult.estimatedLines <= budget,
    }]
  }
}