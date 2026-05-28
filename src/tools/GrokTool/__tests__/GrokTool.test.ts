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
    expect(grokTool.description).toContain('知识图谱')
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
      expect(grokTool.isReadOnly({ operation: 'grok_chat' })).toBe(true)
      expect(grokTool.isReadOnly({ operation: 'grok_status' })).toBe(true)
      expect(grokTool.isReadOnly({ operation: 'grok_explain' })).toBe(true)
    })

    it('should not be read-only for grok_generate', () => {
      expect(grokTool.isReadOnly({ operation: 'grok_generate' })).toBe(false)
    })
  })

  describe('prompt', () => {
    it('should return generate prompt', async () => {
      const result = await grokTool.prompt({ operation: 'grok_generate' })
      expect(result).toContain('生成项目知识图谱')
    })

    it('should return chat prompt with question', async () => {
      const result = await grokTool.prompt({ operation: 'grok_chat', question: 'test?' })
      expect(result).toContain('test?')
    })

    it('should return explain prompt with target', async () => {
      const result = await grokTool.prompt({ operation: 'grok_explain', target: 'file.ts' })
      expect(result).toContain('file.ts')
    })

    it('should return status prompt', async () => {
      const result = await grokTool.prompt({ operation: 'grok_status' })
      expect(result).toContain('检查图谱状态')
    })

    it('should return default prompt for unknown op', async () => {
      const result = await grokTool.prompt({ operation: 'unknown' })
      expect(result).toContain('Grok')
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
