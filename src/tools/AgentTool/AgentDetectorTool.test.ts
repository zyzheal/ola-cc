/**
 * AgentDetectorTool测试
 */

import { describe, it, expect } from 'vitest'
import { agentDetectorTool } from './AgentDetectorTool'

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

  it('should have prompt method', async () => {
    const promptText = await agentDetectorTool.prompt({
      getToolPermissionContext: async () => ({ mode: 'default' as const }),
      tools: [],
      agents: [],
    })
    expect(promptText).toBeDefined()
    expect(typeof promptText).toBe('string')
    expect(promptText).toContain('智能代码检测')
  })
})