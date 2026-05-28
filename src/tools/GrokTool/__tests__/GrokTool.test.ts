/**
 * GrokTool 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokTool.test.ts
 */

import { describe, it, expect } from 'bun:test'
import { grokTool } from '../GrokTool.js'

describe('GrokTool', () => {
  it('should have correct tool metadata', () => {
    expect(grokTool.name).toBe('grok')
    expect(typeof grokTool.description).toBe('function')
  })

  it('should return description containing key terms', async () => {
    const desc = await (grokTool.description as Function)({}, { isNonInteractiveSession: false, toolPermissionContext: {} as any, tools: [] as any })
    expect(desc).toContain('知识图谱')
  })

  it('should have valid input schema', () => {
    const schema = grokTool.inputSchema
    expect(schema).toBeDefined()
  })

  it('should have prompt function', () => {
    expect(typeof grokTool.prompt).toBe('function')
  })

  it('should have isConcurrencySafe', () => {
    expect(grokTool.isConcurrencySafe()).toBe(true)
  })

  it('should have isEnabled', () => {
    expect(grokTool.isEnabled()).toBe(true)
  })

  describe('isReadOnly', () => {
    it('should be read-only for non-generate operations', () => {
      expect(grokTool.isReadOnly({ operation: 'grok_chat' } as any)).toBe(true)
      expect(grokTool.isReadOnly({ operation: 'grok_status' } as any)).toBe(true)
      expect(grokTool.isReadOnly({ operation: 'grok_explain' } as any)).toBe(true)
    })

    it('should not be read-only for grok_generate', () => {
      expect(grokTool.isReadOnly({ operation: 'grok_generate' } as any)).toBe(false)
    })
  })

  describe('mapToolResultToToolResultBlockParam', () => {
    it('should serialize result to JSON', () => {
      const result = grokTool.mapToolResultToToolResultBlockParam(
        { ok: true, operation: 'test', result: {} },
        'test-id'
      )
      expect(result.tool_use_id).toBe('test-id')
      expect(result.type).toBe('tool_result')
      expect(typeof result.content).toBe('string')
    })
  })
})
