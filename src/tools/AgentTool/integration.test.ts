/**
 * Agent工具系统集成测试
 */

import { describe, it, expect } from 'vitest'
import { DesignConstraintIntegration } from './designConstraintIntegration'
import { agentDetectorTool } from './AgentDetectorTool'

describe('DesignConstraintIntegration', () => {
  it('should create instance', () => {
    const integration = new DesignConstraintIntegration()
    expect(integration).toBeInstanceOf(DesignConstraintIntegration)
  })

  it('should have detection method', () => {
    const integration = new DesignConstraintIntegration()
    expect(integration.executeDetection).toBeDefined()
  })

  it('should have logFalsePositive method', () => {
    const integration = new DesignConstraintIntegration()
    expect(integration.logFalsePositive).toBeDefined()
  })

  it('should have getLearningRecords method', () => {
    const integration = new DesignConstraintIntegration()
    expect(integration.getLearningRecords).toBeDefined()
  })

  // TODO: 添加实际检测功能的测试
  // 需要mock AI模型和项目上下文
})

describe('AgentDetectorTool', () => {
  it('should have correct name and description', () => {
    expect(agentDetectorTool.name).toBe('agentDetector')
    expect(agentDetectorTool.description).toBe('智能代码检测工具，替代37个硬编码detector + SkillEvolver 9项审计')
  })

  it('should have valid input schema', () => {
    expect(agentDetectorTool.inputSchema).toBeDefined()
    expect(agentDetectorTool.inputSchema.shape.code).toBeDefined()
    expect(agentDetectorTool.inputSchema.shape.fileType).toBeDefined()
  })

  it('should be concurrency safe', () => {
    const input = { code: 'test', fileType: 'ts' as const }
    expect(agentDetectorTool.isConcurrencySafe(input)).toBe(true)
  })

  it('should be enabled', () => {
    expect(agentDetectorTool.isEnabled()).toBe(true)
  })

  it('should be read only', () => {
    const input = { code: 'test', fileType: 'ts' as const }
    expect(agentDetectorTool.isReadOnly(input)).toBe(true)
  })

  // TODO: 添加实际检测功能的测试
  // 需要mock AI模型来测试检测逻辑
})