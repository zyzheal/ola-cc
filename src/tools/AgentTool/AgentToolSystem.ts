/**
 * Agent工具系统 - 核心智能检测引擎
 *
 * 资深agent专家优化的工具系统，整合智能分析、自适应检测和学习功能
 * 替代原有的硬编码规则系统
 */

import { z } from 'zod'
import { AgentAnalyzer } from './AgentAnalyzer'
import { AdaptiveDetector } from './AdaptiveDetector'
import { LearningSystem } from './LearningSystem'
import { AgentAnalyzerFactory, AdaptiveDetectorFactory, LearningSystemFactory } from './factories'

// 检测结果类型
export interface DetectionResult {
  code: string
  fileType: 'ts' | 'tsx' | 'js' | 'jsx'
  analysis: {
    intent: string
    riskLevel: 'low' | 'medium' | 'high'
    confidence: number
    evidence: string[]
    suggestions: string[]
  }
  detection: {
    issues: Issue[]
    strategy: string
    confidence: number
    suggestions: string[]
  }
  learningApplied: boolean
}

// 问题类型
export interface Issue {
  type: string
  description: string
  severity: 'error' | 'warning' | 'info'
  location?: string
}

// Agent工具系统配置
export interface AgentToolSystemConfig {
  model: any // AI模型实例
  projectContext: ProjectContext
  detectionConfig: DetectionConfig
  learningConfig?: LearningConfig
}

// 项目上下文类型
export interface ProjectContext {
  projectType: 'frontend' | 'backend' | 'fullstack' | 'unknown'
  imports: string[]
  dependencies: string[]
}

// 检测配置类型
export interface DetectionConfig {
  strategy: 'security' | 'ux' | 'quality' | 'performance' | 'all'
  priority: 'high' | 'medium' | 'low'
  confidenceThreshold: number
  autoAdjust: boolean
}

// 学习配置类型
export interface LearningConfig {
  maxRecords: number
  confidenceThreshold: number
  autoAdjust: boolean
  enablePatternLearning: boolean
}

// Agent工具系统主类
export class AgentToolSystem {
  private analyzer: AgentAnalyzer
  private detector: AdaptiveDetector
  private learningSystem: LearningSystem
  private config: AgentToolSystemConfig

  constructor(config: AgentToolSystemConfig) {
    this.config = config
    this.analyzer = AgentAnalyzerFactory.create(config.model, config.projectContext)
    this.detector = AdaptiveDetectorFactory.create(
      this.analyzer,
      config.detectionConfig,
      config.projectContext
    )
    this.learningSystem = LearningSystemFactory.create(config.learningConfig)
  }

  /**
   * 执行智能检测
   */
  async detect(code: string, fileType: 'ts' | 'tsx' | 'js' | 'jsx'): Promise<DetectionResult> {
    // 1. 智能分析代码意图
    const analysis = await this.analyzer.analyzeCode(code, fileType)

    // 2. 自适应检测潜在风险
    const detection = await this.detector.detect(code, fileType)

    return {
      code,
      fileType,
      analysis,
      detection,
      learningApplied: false
    }
  }

  /**
   * 记录误报
   */
  logFalsePositive(
    issue: Issue,
    reason: string,
    reportedBy: string
  ): void {
    this.learningSystem.logFalsePositive(issue, reason, reportedBy)
  }

  /**
   * 获取学习记录
   */
  getLearningRecords(): FalsePositiveRecord[] {
    return this.learningSystem.getRecords()
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<AgentToolSystemConfig>): void {
    this.config = { ...this.config, ...newConfig }
    this.detector.updateConfig(newConfig.detectionConfig)
  }
}

// Agent工具系统工厂
export class AgentToolSystemFactory {
  static create(config: AgentToolSystemConfig): AgentToolSystem {
    return new AgentToolSystem(config)
  }
}

// 误报记录类型（从LearningSystem导入）
type FalsePositiveRecord = any // 实际使用时从LearningSystem导入完整类型

// 导出工厂类以便使用
export { AgentAnalyzerFactory, AdaptiveDetectorFactory, LearningSystemFactory } from './factories'