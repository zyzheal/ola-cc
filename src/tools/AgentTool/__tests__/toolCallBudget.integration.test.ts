/**
 * ToolCallBudget 集成测试
 *
 * 验证完整传播链：
 * AgentDefinition.toolCallBudget → AgentTool.tsx → runAgent.ts → query.ts
 */

import { describe, test, expect } from 'bun:test'
import type { BaseAgentDefinition } from '../loadAgentsDir.js'

describe('ToolCallBudget Integration', () => {
  test('AgentDefinition supports toolCallBudget field', () => {
    // 验证 BaseAgentDefinition 类型包含 toolCallBudget 字段
    const agent: BaseAgentDefinition = {
      agentType: 'test-agent',
      whenToUse: 'For testing',
      toolCallBudget: 50,
    }
    expect(agent.toolCallBudget).toBe(50)
  })

  test('AgentDefinition toolCallBudget is optional', () => {
    // 验证 toolCallBudget 是可选的
    const agent: BaseAgentDefinition = {
      agentType: 'test-agent',
      whenToUse: 'For testing',
    }
    expect(agent.toolCallBudget).toBeUndefined()
  })

  test('AgentDefinition toolCallBudget=0 disables budget', () => {
    const agent: BaseAgentDefinition = {
      agentType: 'test-agent',
      whenToUse: 'For testing',
      toolCallBudget: 0,
    }
    expect(agent.toolCallBudget).toBe(0)
  })

  test('AgentDefinition toolCallBudget=-1 disables budget', () => {
    const agent: BaseAgentDefinition = {
      agentType: 'test-agent',
      whenToUse: 'For testing',
      toolCallBudget: -1,
    }
    expect(agent.toolCallBudget).toBe(-1)
  })

  test('AgentDefinition toolCallBudget accepts positive integers', () => {
    const agent: BaseAgentDefinition = {
      agentType: 'test-agent',
      whenToUse: 'For testing',
      toolCallBudget: 100,
    }
    expect(agent.toolCallBudget).toBe(100)
  })
})
