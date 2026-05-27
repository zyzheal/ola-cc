/**
 * AgentDetectorTool - 智能检测工具
 *
 * 替代原有的37个硬编码detector，使用Agent工具系统进行智能检测
 *
 * 新增：SkillEvolver 9项审计清单（codeAuditor）
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool'
import { AgentToolSystem, AgentToolSystemFactory } from './AgentToolSystem'
import { runAudit, getAuditSummary, type AuditResult } from './codeAuditor'
import type { ToolUseContext } from '../../Tool'
import type { CanUseToolFn } from '../../hooks/useCanUseTool'

// 检测配置
const detectionConfig = {
  strategy: 'all' as const,
  priority: 'high' as const,
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

// AgentDetectorTool定义
export const agentDetectorToolDef: ToolDef = {
  name: 'agentDetector',
  description: '智能代码检测工具，替代37个硬编码detector + SkillEvolver 9项审计',
  inputSchema: z.object({
    code: z.string().describe('要检测的代码'),
    fileType: z.enum(['ts', 'tsx', 'js', 'jsx']).describe('文件类型'),
    runAudit: z.boolean().optional().describe('是否同时运行9项审计清单（默认 true）'),
  }),

  async call(input: any, context: ToolUseContext, canUseTool: CanUseToolFn) {
    const { code, fileType, runAudit: shouldAudit = true } = input

    // 创建Agent工具系统
    const agentToolSystem = AgentToolSystemFactory.create({
      model: null, // 在实际使用中会从context获取
      projectContext: getProjectContext(),
      detectionConfig,
      learningConfig
    })

    try {
      // 执行智能检测
      const result = await agentToolSystem.detect(code, fileType)

      // 并行运行9项审计（如果启用）
      let auditResults: AuditResult[] = []
      if (shouldAudit) {
        auditResults = await runAudit(code, fileType, {
          model: agentToolSystem.model,
        })
      }

      const auditSummary = getAuditSummary(auditResults)

      // 转换为兼容格式
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code,
              fileType,
              analysis: result.analysis,
              detection: result.detection,
              learningApplied: result.learningApplied,
              audit: shouldAudit
                ? {
                    results: auditResults,
                    summary: auditSummary,
                    criticalFailures: auditSummary.criticalFailures.map(c => ({
                      checkId: c.checkId,
                      checkName: c.checkName,
                      details: c.details,
                    })),
                  }
                : null,
            }, null, 2)
          }
        ]
      }
    } catch (error) {
      throw new Error(`Agent检测失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  },

  async describe(input: any, options) {
    return '智能代码检测工具，替代37个硬编码detector，提供意图识别、风险评估和问题检测能力，支持SkillEvolver 9项审计清单'
  },

  async prompt() {
    return '智能代码检测工具，用于分析代码质量、安全问题和潜在缺陷，包含5项静态分析 + 4项LLM审计'
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
  isReadOnly: () => true
}

// 创建AgentDetectorTool实例
export const agentDetectorTool = buildTool(agentDetectorToolDef)

// 辅助函数
function getProjectContext() {
  // 简化实现，实际可以从项目配置获取
  return {
    projectType: 'fullstack',
    imports: [],
    dependencies: []
  }
}