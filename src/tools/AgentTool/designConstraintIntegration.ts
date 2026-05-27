/**
 * design-constraint技能集成
 *
 * 将Agent工具系统集成到design-constraint技能中
 * 保持与原有37个detector的兼容性
 */

import { AgentToolSystem, AgentToolSystemFactory } from './AgentToolSystem'
import { agentDetectorTool } from './AgentDetectorTool'

// 检测配置
const detectionConfig = {
  strategy: 'all',
  priority: 'high',
  confidenceThreshold: 60,
  autoAdjust: true
}

// 学习配置
const learningConfig = {
  maxRecords: 100,
  confidenceThreshold: 60,
  autoAdjust: true,
  enablePatternLearning: true
}

// design-constraint集成类
export class DesignConstraintIntegration {
  private agentToolSystem: AgentToolSystem

  constructor() {
    // 创建Agent工具系统
    this.agentToolSystem = AgentToolSystemFactory.create({
      model: null, // 在实际使用中会从技能上下文获取
      projectContext: this.getProjectContext(),
      detectionConfig,
      learningConfig
    })
  }

  /**
   * 执行design-constraint检测
   */
  async executeDetection(code: string, fileType: 'ts' | 'tsx' | 'js' | 'jsx'): Promise<any> {
    try {
      // 使用Agent工具系统进行智能检测
      const result = await this.agentToolSystem.detect(code, fileType)

      // 转换为design-constraint兼容格式
      return this.convertToDesignConstraintFormat(result)
    } catch (error) {
      throw new Error(`design-constraint集成检测失败: ${error.message}`)
    }
  }

  /**
   * 转换为design-constraint兼容格式
   */
  private convertToDesignConstraintFormat(result: any): any {
    return {
      // 保持与原有37个detector相同的输出格式
      issues: result.detection.issues.map((issue: any) => ({
        file: 'unknown', // 需要根据实际文件信息设置
        line: 0, // 需要根据实际位置信息设置
        column: 0, // 需要根据实际位置信息设置
        check: issue.type,
        message: issue.description,
        severity: issue.severity,
        fix: issue.suggestions[0] || ''
      })),
      analysis: {
        intent: result.analysis.intent,
        riskLevel: result.analysis.riskLevel,
        confidence: result.analysis.confidence,
        evidence: result.analysis.evidence,
        suggestions: result.analysis.suggestions
      },
      detection: {
        issues: result.detection.issues,
        strategy: result.detection.strategy,
        confidence: result.detection.confidence,
        suggestions: result.detection.suggestions
      },
      learningApplied: result.learningApplied
    }
  }

  /**
   * 获取项目上下文
   */
  private getProjectContext(): any {
    // 简化实现，实际可以从项目配置获取
    return {
      projectType: 'fullstack',
      imports: [],
      dependencies: []
    }
  }

  /**
   * 获取AI模型
   */
  private getModel(): any {
    // 简化实现，实际可以从技能上下文获取
    return null
  }

  /**
   * 记录误报
   */
  logFalsePositive(issue: any, reason: string, reportedBy: string): void {
    this.agentToolSystem.logFalsePositive(issue, reason, reportedBy)
  }

  /**
   * 获取学习记录
   */
  getLearningRecords(): any[] {
    return this.agentToolSystem.getLearningRecords()
  }
}

// design-constraint集成实例
export const designConstraintIntegration = new DesignConstraintIntegration()