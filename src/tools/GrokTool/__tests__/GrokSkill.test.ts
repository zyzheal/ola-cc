/**
 * GrokSkill 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokSkill.test.ts
 */

import { describe, it, expect } from 'bun:test'
import { formatGrokError, formatGrokResult } from '../GrokSkill.js'
import { GrokError } from '../GrokManager.js'

describe('formatGrokError', () => {
  it('should format GrokError with all fields', () => {
    const error = new GrokError('TEST_CODE', 'test', 'test message', true, 'test suggestion')
    const result = formatGrokError(error)

    expect(result).toContain('TEST_CODE')
    expect(result).toContain('test message')
    expect(result).toContain('可恢复')
    expect(result).toContain('test suggestion')
  })

  it('should format GrokError without suggestion', () => {
    const error = new GrokError('CODE', 'stage', 'msg', false)
    const result = formatGrokError(error)

    expect(result).toContain('CODE')
    expect(result).not.toContain('建议')
  })

  it('should format regular Error', () => {
    const result = formatGrokError(new Error('regular error'))
    expect(result).toContain('regular error')
  })

  it('should format unknown error', () => {
    const result = formatGrokError('string error')
    expect(result).toContain('string error')
  })
})

describe('formatGrokResult', () => {
  it('should format grok_status with exists=true', () => {
    const result = formatGrokResult('grok_status', {
      exists: true,
      nodeCount: 100,
      edgeCount: 250,
      lastUpdated: '2026-01-01',
      stale: false,
    })

    expect(result.formatted).toContain('存在: 是')
    expect(result.formatted).toContain('100')
    expect(result.formatted).toContain('250')
  })

  it('should format grok_status with stale warning', () => {
    const result = formatGrokResult('grok_status', {
      exists: true,
      stale: true,
    })

    expect(result.formatted).toContain('过期')
  })

  it('should format grok_chat with sources', () => {
    const result = formatGrokResult('grok_chat', {
      answer: 'Test answer',
      sources: [{ file: 'test.ts', line: 42 }],
    })

    expect(result.formatted).toContain('Test answer')
    expect(result.formatted).toContain('test.ts:42')
  })

  it('should format grok_explain', () => {
    const result = formatGrokResult('grok_explain', {
      summary: 'This is a test',
      relationships: [{ file: 'rel.ts', line: 10 }],
    })

    expect(result.formatted).toContain('This is a test')
    expect(result.formatted).toContain('rel.ts:10')
  })

  it('should format grok_domain', () => {
    const result = formatGrokResult('grok_domain', { domains: 'Payment, Auth' })
    expect(result.formatted).toContain('Payment, Auth')
  })

  it('should format grok_tour', () => {
    const result = formatGrokResult('grok_tour', { tours: 'Step 1, Step 2' })
    expect(result.formatted).toContain('Step 1, Step 2')
  })

  it('should format grok_diff', () => {
    const result = formatGrokResult('grok_diff', { impacted: 'Files affected' })
    expect(result.formatted).toContain('Files affected')
  })

  it('should format grok_dashboard', () => {
    const result = formatGrokResult('grok_dashboard', { url: 'http://localhost:63000' })
    expect(result.formatted).toContain('http://localhost:63000')
  })

  it('should format grok_generate', () => {
    const result = formatGrokResult('grok_generate', {
      filePath: 'graph.json',
      nodeCount: 100,
      edgeCount: 200,
      domainCount: 5,
    })

    expect(result.formatted).toContain('graph.json')
    expect(result.formatted).toContain('100')
    expect(result.formatted).toContain('200')
    expect(result.formatted).toContain('5')
  })

  it('should format unknown operation as JSON', () => {
    const result = formatGrokResult('unknown', { foo: 'bar' })
    expect(result.formatted).toContain('"foo"')
  })

  it('should return raw result', () => {
    const data = { answer: 'test' }
    const result = formatGrokResult('grok_chat', data)
    expect(result.raw).toBe(data)
  })
})
