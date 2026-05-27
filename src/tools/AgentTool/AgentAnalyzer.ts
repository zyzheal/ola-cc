/**
 * Agent智能分析器 - 核心推理引擎
 *
 * 从资深agent专家角度优化的工具系统，替代硬编码规则
 * 实现自然语言推理、上下文感知和智能决策
 */

import { z } from 'zod/v4'

// 分析结果类型定义
export interface AnalysisResult {
  intent: string // 代码意图
  riskLevel: 'low' | 'medium' | 'high' // 风险级别
  confidence: number // 置信度 0-100
  evidence: string[] // 证据列表
  suggestions: string[] // 建议列表
}

// 分析上下文类型
export interface AnalysisContext {
  projectType: 'frontend' | 'backend' | 'fullstack' | 'unknown'
  imports: string[]
  dependencies: string[]
}

// EmbodiSkill 四类型反思结果 Schema
export const StructuredAnalysisSchema = z.object({
  reasoning_trace: z.string(),
  signal_type: z.enum(['DISCOVERY', 'OPTIMIZATION', 'SKILL_DEFECT', 'EXECUTION_LAPSE']),
  target_skill_segment: z.string().nullable(),
  evidence: z.string(),
  proposed_revision: z.string(),
})

export type StructuredAnalysisResult = z.infer<typeof StructuredAnalysisSchema>
export class AgentAnalyzer {
  private model: any // AI模型实例
  private context: AnalysisContext

  constructor(model: any, context: AnalysisContext) {
    this.model = model
    this.context = context
  }

  /**
   * 分析代码意图和潜在风险
   */
  async analyzeCode(code: string, fileType: 'ts' | 'tsx' | 'js' | 'jsx'): Promise<AnalysisResult> {
    // 1. 理解代码结构和意图
    const intent = await this.understandIntent(code, fileType)

    // 2. 识别潜在风险
    const risks = await this.identifyRisks(code, fileType)

    // 3. 生成分析结果
    return {
      intent,
      riskLevel: this.calculateRiskLevel(risks),
      confidence: this.calculateConfidence(risks),
      evidence: risks.evidence,
      suggestions: risks.suggestions
    }
  }

  /**
   * 理解代码意图（自然语言推理）
   */
  private async understandIntent(code: string, fileType: 'ts' | 'tsx' | 'js' | 'jsx'): Promise<string> {
    const prompt = this.generateIntentPrompt(code, fileType)

    // 使用AI模型进行自然语言推理
    const response = await this.model.generate(prompt, {
      maxTokens: 100,
      temperature: 0.3
    })

    return response.text.trim()
  }

  /**
   * 识别潜在风险（智能检测）
   */
  private async identifyRisks(code: string, fileType: 'ts' | 'tsx' | 'js' | 'jsx'): Promise<{
    evidence: string[]
    suggestions: string[]
  }> {
    const prompt = this.generateRiskPrompt(code, fileType)

    const response = await this.model.generate(prompt, {
      maxTokens: 200,
      temperature: 0.5
    })

    // 解析AI响应
    const analysis = this.parseRiskAnalysis(response.text)
    return analysis
  }

  /**
   * 生成意图分析提示
   */
  private generateIntentPrompt(code: string, fileType: 'ts' | 'tsx' | 'js' | 'jsx'): string {
    return `分析以下${fileType}代码的意图和功能：

代码：
\`\`\`${fileType}
${code}
\`\`\`

请用自然语言描述这段代码的主要功能和意图。关注：
1. 这段代码实现了什么功能？
2. 它的主要目的是什么？
3. 它属于前端、后端还是通用工具？
4. 有没有明显的业务逻辑？
5. 可能的用户交互场景？

请提供简洁但全面的描述。`
  }

  /**
   * 生成风险分析提示
   */
  private generateRiskPrompt(code: string, fileType: 'ts' | 'tsx' | 'js' | 'jsx'): string {
    return `分析以下${fileType}代码的潜在风险和安全问题：

代码：
\`\`\`${fileType}
${code}
\`\`\`

请识别以下类型的风险（如果存在）：
1. SQL注入风险 - 字符串拼接、模板字面量、ORM使用不当
2. 安全漏洞 - 认证、授权、数据泄露
3. 用户体验问题 - 加载状态、错误处理、空状态
4. 代码质量问题 - 未使用的变量、魔法数字、不可达代码
5. 业务逻辑问题 - 表单验证、数据过滤、审计日志

对于每个识别出的风险，请提供：
- 风险类型和具体位置
- 风险证据
- 修复建议

请用结构化格式回答，包括证据和建议。`
  }

  /**
   * 解析风险分析结果
   */
  private parseRiskAnalysis(response: string): { evidence: string[], suggestions: string[] } {
    // 简单解析逻辑，实际实现可以根据AI响应格式优化
    const lines = response.split('\n')
    const evidence: string[] = []
    const suggestions: string[] = []

    let inEvidence = false
    let inSuggestions = false

    for (const line of lines) {
      if (line.includes('证据：') || line.includes('Evidence:')) {
        inEvidence = true
        inSuggestions = false
        continue
      }
      if (line.includes('建议：') || line.includes('Suggestions:')) {
        inEvidence = false
        inSuggestions = true
        continue
      }

      if (inEvidence) {
        evidence.push(line.trim())
      }
      if (inSuggestions) {
        suggestions.push(line.trim())
      }
    }

    return { evidence, suggestions }
  }

  /**
   * 计算风险级别
   */
  private calculateRiskLevel(risks: { evidence: string[] }): 'low' | 'medium' | 'high' {
    const evidenceCount = risks.evidence.length
    if (evidenceCount === 0) return 'low'
    if (evidenceCount <= 2) return 'medium'
    return 'high'
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(risks: { evidence: string[] }): number {
    const evidenceCount = risks.evidence.length
    // 基于证据数量计算置信度
    return Math.min(100, evidenceCount * 20 + 40)
  }

  // ============================================
  // EmbodiSkill 四类型反思分析
  // ============================================

  /**
   * 批量分析多条轨迹 — CONSOLIDATEREVISIONS 等价实现
   *
   * 对多条执行轨迹进行反思分析后合并冲突信号，用于 EmbodiSkill 批量修订
   *
   * @param traces - 执行轨迹列表
   * @param skillContent - 当前技能内容
   * @returns 合并后的修订信号列表
   */
  async analyzeBatch(
    skill: string,
    traces: { taskDescription: string; executionTrace: string; outcome: 'success' | 'failure' }[],
    skillContent?: string,
  ): Promise<StructuredAnalysisResult[]> {
    const results: StructuredAnalysisResult[] = []

    for (const trace of traces) {
      try {
        const result = await this.analyzeSkillExecution(
          skill,
          trace.taskDescription,
          trace.executionTrace,
          trace.outcome,
          skillContent,
        )
        results.push(result)
      } catch {
        // 单条失败不影响整体
      }
    }

    return this.consolidateRevisions(results)
  }

  /**
   * 合并修订信号 — CONSOLIDATEREVISIONS
   *
   * 优先级: SKILL_DEFECT > OPTIMIZATION > DISCOVERY
   * EXECUTION_LAPSE 强制分流到附录，不参与主体冲突
   */
  private consolidateRevisions(
    signals: StructuredAnalysisResult[],
  ): StructuredAnalysisResult[] {
    if (signals.length === 0) return []

    // 1. 分离附录类信号
    const appendixSignals = signals.filter(s => s.signal_type === 'EXECUTION_LAPSE')
    const bodySignals = signals.filter(s => s.signal_type !== 'EXECUTION_LAPSE')

    // 2. 主体信号去重：按 target_skill_segment 去重，保留优先级最高的
    const seen = new Map<string, StructuredAnalysisResult>()
    for (const s of bodySignals) {
      const key = s.target_skill_segment ?? s.signal_type
      const existing = seen.get(key)
      if (!existing || this.priorityScore(s.signal_type) > this.priorityScore(existing.signal_type)) {
        seen.set(key, s)
      }
    }

    return [...seen.values(), ...appendixSignals]
  }

  private priorityScore(type: string): number {
    switch (type) {
      case 'SKILL_DEFECT': return 3
      case 'OPTIMIZATION': return 2
      case 'DISCOVERY': return 1
      case 'EXECUTION_LAPSE': return 0
      default: return 0
    }
  }

  /**
   * EmbodiSkill 技能执行分析 — 区分技能问题 vs 执行失误
   *
   * 基于论文 Algorithm 1 的 SKILLAWAREFLECT 步骤：
   * - DISCOVERY: 成功轨迹揭示缺失内容
   * - OPTIMIZATION: 有更好方式
   * - SKILL_DEFECT: 技能本身不正确/不完整
   * - EXECUTION_LAPSE: 技能正确但执行者未遵循
   *
   * @param skill - 技能名称
   * @param taskDescription - 任务描述
   * @param executionTrace - 执行轨迹（tool calls + responses）
   * @param outcome - 最终结果
   * @param skillContent - 当前技能内容（SKILL.md body）
   */
  async analyzeSkillExecution(
    skill: string,
    taskDescription: string,
    executionTrace: string,
    outcome: 'success' | 'failure',
    skillContent?: string,
  ): Promise<StructuredAnalysisResult> {
    const prompt = `你是一个技能分析专家。你的任务是分析智能体的执行轨迹，并判断失败或成功的原因。
你必须严格区分"技能策略本身的错误"和"执行者未遵循有效指导"。

技能名称: ${skill}
任务描述: ${taskDescription}
最终结果: ${outcome}

${skillContent ? `当前技能内容:
${skillContent}
` : ''}
执行轨迹:
${executionTrace}

请用 JSON 格式返回分析结果（不要输出其他文本）：
{
  "reasoning_trace": "分析轨迹与技能匹配度的思考过程",
  "signal_type": "DISCOVERY|OPTIMIZATION|SKILL_DEFECT|EXECUTION_LAPSE",
  "target_skill_segment": "需要修改的具体技能片段，如果是DISCOVERY则为null",
  "evidence": "支持该判断的轨迹证据",
  "proposed_revision": "具体的修改建议或附录提醒内容"
}

反思类型判断标准：
- DISCOVERY: 成功轨迹揭示了技能中缺失的内容（技能需要新增内容）
- OPTIMIZATION: 技能有效，但有更好的实现方式
- SKILL_DEFECT: 技能本身不正确或不完整（技能需要修正）
- EXECUTION_LAPSE: 技能正确，但执行者没有遵循技能的指导（需要在附录中强调）`

    try {
      const response = await this.model.generate(prompt, {
        maxTokens: 500,
        temperature: 0.3,
      })

      const result = this.extractAndParseJSON(response.text)
      return StructuredAnalysisSchema.parse(result)
    } catch (error) {
      // JSON 解析失败时 fallback 到文本解析
      console.warn('[AgentAnalyzer] analyzeSkillExecution JSON parse failed:', error)
      return this.fallbackAnalysis(executionTrace, outcome)
    }
  }

  /**
   * 从 AI 响应中提取 JSON 块
   */
  private extractAndParseJSON(text: string): Record<string, unknown> {
    // 尝试直接解析
    try {
      return JSON.parse(text)
    } catch {
      // 尝试提取 markdown 代码块中的 JSON
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (codeBlockMatch) {
        return JSON.parse(codeBlockMatch[1].trim())
      }
      // 尝试提取第一个 JSON 对象
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
      throw new Error('No valid JSON found in response')
    }
  }

  /**
   * Fallback: 当 JSON 解析失败时的文本分析
   */
  private fallbackAnalysis(
    executionTrace: string,
    outcome: 'success' | 'failure',
  ): StructuredAnalysisResult {
    if (outcome === 'success') {
      return {
        reasoning_trace: '执行成功，但无法提取结构化分析',
        signal_type: 'DISCOVERY',
        target_skill_segment: null,
        evidence: `成功轨迹: ${executionTrace.substring(0, 200)}`,
        proposed_revision: '记录此成功轨迹作为参考',
      }
    }

    // 基于关键词的简单分类
    const trace = executionTrace.toLowerCase()
    if (trace.includes('error') || trace.includes('fail') || trace.includes('exception')) {
      return {
        reasoning_trace: '执行失败，可能是技能缺陷',
        signal_type: 'SKILL_DEFECT',
        target_skill_segment: null,
        evidence: `失败轨迹: ${executionTrace.substring(0, 200)}`,
        proposed_revision: '检查技能逻辑是否正确',
      }
    }

    return {
      reasoning_trace: '执行异常，可能是执行失误',
      signal_type: 'EXECUTION_LAPSE',
      target_skill_segment: null,
      evidence: `异常轨迹: ${executionTrace.substring(0, 200)}`,
      proposed_revision: '在执行时更仔细地遵循技能指导',
    }
  }
}