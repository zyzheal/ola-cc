/**
 * Agent工具系统工厂 - 统一创建接口
 *
 * 提供智能分析器、自适应检测器和学习系统的统一创建接口
 */

import { z } from 'zod'
import { AgentAnalyzer } from './AgentAnalyzer'
import { AdaptiveDetector } from './AdaptiveDetector'
import { LearningSystem } from './LearningSystem'
import { AgentToolSystem } from './AgentToolSystem'

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

// Agent工具系统配置
export interface AgentToolSystemConfig {
  model: any // AI模型实例
  projectContext: ProjectContext
  detectionConfig: DetectionConfig
  learningConfig?: LearningConfig
}

// 智能分析器工厂
export class AgentAnalyzerFactory {
  static create(model: any, context: ProjectContext): AgentAnalyzer {
    return new AgentAnalyzer(model, context)
  }
}

// 自适应检测器工厂
export class AdaptiveDetectorFactory {
  static create(
    analyzer: AgentAnalyzer,
    config: DetectionConfig,
    projectContext: ProjectContext
  ): AdaptiveDetector {
    return new AdaptiveDetector(analyzer, config, projectContext)
  }
}

// 学习系统工厂
export class LearningSystemFactory {
  static create(config?: LearningConfig): LearningSystem {
    return new LearningSystem(config)
  }
}

// Agent工具系统工厂
export class AgentToolSystemFactory {
  static create(config: AgentToolSystemConfig): AgentToolSystem {
    return new AgentToolSystem(config)
  }
}

// 工厂类已在上面单独导出