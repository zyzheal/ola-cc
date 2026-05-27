/**
 * 自适应检测器 - 根据上下文自动调整检测策略
 *
 * 资深agent专家优化的关键组件，根据项目类型、文件类型、依赖关系等
 * 自动选择最合适的检测策略和工具
 */

import { z } from 'zod/v4'
import { AgentAnalyzer } from './AgentAnalyzer'

// 检测策略类型
export type DetectionStrategy = 'security' | 'ux' | 'quality' | 'performance' | 'all'

// 检测配置
export interface DetectionConfig {
  strategy: DetectionStrategy
  priority: 'high' | 'medium' | 'low'
  confidenceThreshold: number
  autoAdjust: boolean
}

// 自适应检测器主类
export class AdaptiveDetector {
  private analyzer: AgentAnalyzer
  private config: DetectionConfig
  private projectContext: ProjectContext

  constructor(
    analyzer: AgentAnalyzer,
    config: DetectionConfig,
    projectContext: ProjectContext
  ) {
    this.analyzer = analyzer
    this.config = config
    this.projectContext = projectContext
  }

  /**
   * 执行自适应检测
   */
  async detect(code: string, fileType: 'ts' | 'tsx' | 'js' | 'jsx'): Promise<DetectionResult> {
    // 1. 分析代码上下文
    const context = await this.analyzeContext(code, fileType)

    // 2. 选择最佳检测策略
    const strategy = this.selectStrategy(context)

    // 3. 执行检测
    const result = await this.executeDetection(code, fileType, strategy)

    // 4. 自适应调整
    if (this.config.autoAdjust) {
      await this.adjustStrategy(result)
    }

    return result
  }

  /**
   * 分析代码上下文
   */
  private async analyzeContext(
    code: string,
    fileType: 'ts' | 'tsx' | 'js' | 'jsx'
  ): Promise<CodeContext> {
    const prompt = this.generateContextPrompt(code, fileType)

    const response = await this.analyzer.model.generate(prompt, {
      maxTokens: 150,
      temperature: 0.4
    })

    return this.parseContext(response.text)
  }

  /**
   * 选择最佳检测策略
   */
  private selectStrategy(context: CodeContext): DetectionStrategy {
    // 根据项目类型和代码上下文选择策略
    if (this.projectContext.projectType === 'backend') {
      return 'security' // 后端优先安全检测
    } else if (this.projectContext.projectType === 'frontend') {
      return 'ux' // 前端优先用户体验检测
    }

    // 根据代码内容动态选择
    if (context.hasDatabaseOperations) {
      return 'security'
    }
    if (context.hasUserInterface) {
      return 'ux'
    }
    if (context.hasPerformanceCriticalCode) {
      return 'performance'
    }

    return this.config.strategy || 'all'
  }

  /**
   * 执行检测
   */
  private async executeDetection(
    code: string,
    fileType: 'ts' | 'tsx' | 'js' | 'jsx',
    strategy: DetectionStrategy
  ): Promise<DetectionResult> {
    const prompt = this.generateDetectionPrompt(code, fileType, strategy)

    const response = await this.analyzer.model.generate(prompt, {
      maxTokens: 300,
      temperature: 0.6
    })

    return this.parseDetectionResult(response.text, strategy)
  }

  /**
   * 自适应调整策略
   */
  private async adjustStrategy(result: DetectionResult): Promise<void> {
    // 根据检测结果调整配置
    if (result.riskLevel === 'high' && this.config.priority === 'medium') {
      this.config.priority = 'high'
    }

    if (result.confidence < this.config.confidenceThreshold) {
      // 降低置信度阈值或调整策略
      this.config.confidenceThreshold = Math.max(50, this.config.confidenceThreshold - 10)
    }
  }

  /**
   * 生成上下文分析提示
   */
  private generateContextPrompt(
    code: string,
    fileType: 'ts' | 'tsx' | 'js' | 'jsx'
  ): string {
    return `分析以下${fileType}代码的上下文信息：

代码：
\`\`\`${fileType}
${code}
\`\`\`

请识别以下信息：
1. 是否包含数据库操作（SQL查询、ORM调用）
2. 是否包含用户界面代码（React、Vue等）
3. 是否包含性能关键代码（大量计算、循环）
4. 是否包含安全相关代码（认证、授权）
5. 主要功能领域（API、UI组件、工具函数等）

请用简洁的JSON格式回答：`
  }

  /**
   * 生成检测提示
   */
  private generateDetectionPrompt(
    code: string,
    fileType: 'ts' | 'tsx' | 'js' | 'jsx',
    strategy: DetectionStrategy
  ): string {
    const strategyDescriptions = {
      security: '安全风险检测 - SQL注入、认证漏洞、数据泄露',
      ux: '用户体验检测 - 加载状态、错误处理、空状态',
      quality: '代码质量检测 - 未使用变量、魔法数字、不可达代码',
      performance: '性能问题检测 - 慢查询、内存泄漏、渲染优化',
      all: '全面检测 - 所有上述问题'
    }

    return `使用${strategyDescriptions[strategy]}策略分析以下${fileType}代码：

代码：
\`\`\`${fileType}
${code}
\`\`\`

请识别相关的潜在问题，包括：
- 具体问题和位置
- 风险级别
- 修复建议

请提供结构化分析结果。`
  }

  /**
   * 解析上下文分析结果
   */
  private parseContext(response: string): CodeContext {
    try {
      // 简化解析逻辑，实际实现可以根据AI响应格式优化
      const context: CodeContext = {
        hasDatabaseOperations: response.includes('数据库') || response.includes('SQL'),
        hasUserInterface: response.includes('UI') || response.includes('组件'),
        hasPerformanceCriticalCode: response.includes('性能') || response.includes('优化'),
        hasSecurityRelatedCode: response.includes('安全') || response.includes('认证'),
        mainFunctionDomain: this.extractDomain(response)
      }
      return context
    } catch {
      return {
        hasDatabaseOperations: false,
        hasUserInterface: false,
        hasPerformanceCriticalCode: false,
        hasSecurityRelatedCode: false,
        mainFunctionDomain: 'unknown'
      }
    }
  }

  /**
   * 解析检测结果
   */
  private parseDetectionResult(
    response: string,
    strategy: DetectionStrategy
  ): DetectionResult {
    // 简化解析逻辑，实际实现可以根据AI响应格式优化
    const issues: Issue[] = []
    const suggestions: string[] = []

    const lines = response.split('\n')
    let inIssues = false
    let inSuggestions = false

    for (const line of lines) {
      if (line.includes('问题：') || line.includes('Issues:')) {
        inIssues = true
        inSuggestions = false
        continue
      }
      if (line.includes('建议：') || line.includes('Suggestions:')) {
        inIssues = false
        inSuggestions = true
        continue
      }

      if (inIssues) {
        // 解析问题
        const match = line.match(/(.+?)\s*-\s*(.+)/)
        if (match) {
          issues.push({
            type: this.mapIssueType(match[1]),
            description: match[2],
            severity: this.mapSeverity(match[1])
          })
        }
      }
      if (inSuggestions) {
        suggestions.push(line.trim())
      }
    }

    return {
      issues,
      strategy,
      confidence: this.calculateConfidence(issues),
      suggestions
    }
  }

  /**
   * 提取主要功能领域
   */
  private extractDomain(response: string): string {
    if (response.includes('API') || response.includes('接口')) return 'api'
    if (response.includes('UI') || response.includes('组件')) return 'ui'
    if (response.includes('工具') || response.includes('utils')) return 'utils'
    return 'unknown'
  }

  /**
   * 映射问题类型
   */
  private mapIssueType(description: string): string {
    const mappings: Record<string, string> = {
      'SQL注入': 'sql-injection',
      '认证漏洞': 'auth-vulnerability',
      '数据泄露': 'data-leakage',
      '加载状态': 'loading-state',
      '错误处理': 'error-handling',
      '空状态': 'empty-state',
      '未使用变量': 'unused-variable',
      '魔法数字': 'magic-number',
      '不可达代码': 'unreachable-code',
      '性能问题': 'performance-issue'
    }

    for (const [key, value] of Object.entries(mappings)) {
      if (description.includes(key)) return value
    }
    return 'unknown'
  }

  /**
   * 映射严重级别
   */
  private mapSeverity(description: string): 'error' | 'warning' | 'info' {
    if (description.includes('SQL注入') || description.includes('认证漏洞')) return 'error'
    if (description.includes('数据泄露') || description.includes('性能问题')) return 'warning'
    return 'info'
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(issues: Issue[]): number {
    if (issues.length === 0) return 0
    const severeIssues = issues.filter(i => i.severity === 'error').length
    const warningIssues = issues.filter(i => i.severity === 'warning').length

    // 基于问题严重程度计算置信度
    return Math.min(100, severeIssues * 30 + warningIssues * 15 + 50)
  }
}

// 代码上下文类型
export interface CodeContext {
  hasDatabaseOperations: boolean
  hasUserInterface: boolean
  hasPerformanceCriticalCode: boolean
  hasSecurityRelatedCode: boolean
  mainFunctionDomain: string
}

// 检测结果类型
export interface DetectionResult {
  issues: Issue[]
  strategy: DetectionStrategy
  confidence: number
  suggestions: string[]
}

// 问题类型
export interface Issue {
  type: string
  description: string
  severity: 'error' | 'warning' | 'info'
}

// 项目上下文类型
export interface ProjectContext {
  projectType: 'frontend' | 'backend' | 'fullstack' | 'unknown'
  imports: string[]
  dependencies: string[]
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