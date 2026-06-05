/**
 * GrokTool 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokTool.test.ts
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

// Mock GrokManager
let mockGraphStatus: any = { exists: true, nodeCount: 100, edgeCount: 200, stale: false }
mock.module('../GrokManager.js', () => ({
  grokManager: {
    ensureGrokSource: mock(() => Promise.resolve('/tmp/grok-source')),
    runAgentPipeline: mock(() => Promise.resolve({ status: 'success', nodeCount: 10, edgeCount: 20, domainCount: 3, filePath: '/tmp/graph.json' })),
    queryGraph: mock(() => Promise.resolve({ answer: 'test answer', sources: [] })),
    getGraphStatus: mock(() => Promise.resolve(mockGraphStatus)),
    startDashboard: mock(() => Promise.resolve({ url: 'http://localhost:3000' })),
  },
}))

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

  describe('stale hint', () => {
    beforeEach(() => {
      mockGraphStatus = { exists: true, nodeCount: 100, edgeCount: 200, stale: false }
    })

    afterEach(() => {
      mockGraphStatus = { exists: true, nodeCount: 100, edgeCount: 200, stale: false }
    })

    it('should NOT add stale hint when graph is fresh', async () => {
      mockGraphStatus = { exists: true, nodeCount: 100, edgeCount: 200, stale: false }
      const result = await grokTool.call(
        { operation: 'grok_chat', question: 'test' },
        {} as any,
        {} as any,
        {} as any,
        undefined
      )
      expect(result.data._freshnessNote).toBeUndefined()
    })

    it('should add stale hint when graph is stale', async () => {
      mockGraphStatus = {
        exists: true, nodeCount: 100, edgeCount: 200, stale: true,
        lastUpdated: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      }
      const result = await grokTool.call(
        { operation: 'grok_chat', question: 'test' },
        {} as any,
        {} as any,
        {} as any,
        undefined
      )
      expect(result.data._freshnessNote).toBeDefined()
      expect(result.data._freshnessNote).toContain('天未更新')
      expect(result.data._freshnessNote).toContain('grok_generate')
    })

    it('should add stale hint for grok_explain', async () => {
      mockGraphStatus = {
        exists: true, nodeCount: 100, edgeCount: 200, stale: true,
        lastUpdated: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      }
      const result = await grokTool.call(
        { operation: 'grok_explain', target: 'MyClass' },
        {} as any,
        {} as any,
        {} as any,
        undefined
      )
      expect(result.data._freshnessNote).toBeDefined()
      expect(result.data._freshnessNote).toContain('2')
    })

    it('should NOT add stale hint for non-query operations', async () => {
      mockGraphStatus = { exists: true, nodeCount: 100, edgeCount: 200, stale: true }
      const result = await grokTool.call(
        { operation: 'grok_status' },
        {} as any,
        {} as any,
        {} as any,
        undefined
      )
      expect(result.data._freshnessNote).toBeUndefined()
    })

    it('should handle stale with no lastUpdated', async () => {
      mockGraphStatus = { exists: true, nodeCount: 100, edgeCount: 200, stale: true }
      const result = await grokTool.call(
        { operation: 'grok_chat', question: 'test' },
        {} as any,
        {} as any,
        {} as any,
        undefined
      )
      expect(result.data._freshnessNote).toBeDefined()
      expect(result.data._freshnessNote).toContain('?')
    })
  })
})
