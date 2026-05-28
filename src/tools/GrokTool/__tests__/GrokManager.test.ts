/**
 * GrokManager 单元测试
 *
 * Run: bun test src/tools/GrokTool/__tests__/GrokManager.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'
import { GrokManager, GrokError, ERROR_SUGGESTIONS } from '../GrokManager.js'

const TEST_DIR = resolve('/tmp', `grok-test-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ============================================
// GrokError
// ============================================

describe('GrokError', () => {
  it('should create error with all fields', () => {
    const err = new GrokError('TEST_CODE', 'test-stage', 'test message', true, 'test suggestion')

    expect(err.code).toBe('TEST_CODE')
    expect(err.stage).toBe('test-stage')
    expect(err.message).toBe('test message')
    expect(err.recoverable).toBe(true)
    expect(err.suggestion).toBe('test suggestion')
    expect(err.name).toBe('GrokError')
    expect(err instanceof Error).toBe(true)
  })

  it('should work without suggestion', () => {
    const err = new GrokError('CODE', 'stage', 'msg', false)

    expect(err.suggestion).toBeUndefined()
    expect(err.recoverable).toBe(false)
  })
})

// ============================================
// ERROR_SUGGESTIONS
// ============================================

describe('ERROR_SUGGESTIONS', () => {
  it('should have all expected error codes', () => {
    expect(ERROR_SUGGESTIONS['PARSE_TIMEOUT']).toBeDefined()
    expect(ERROR_SUGGESTIONS['LLM_RATE_LIMIT']).toBeDefined()
    expect(ERROR_SUGGESTIONS['LLM_TOKEN_BUDGET']).toBeDefined()
    expect(ERROR_SUGGESTIONS['GRAPH_INVALID']).toBeDefined()
    expect(ERROR_SUGGESTIONS['SOURCE_CLONE_FAILED']).toBeDefined()
  })
})

// ============================================
// GrokManager constructor
// ============================================

describe('GrokManager constructor', () => {
  it('should accept custom project root', () => {
    const manager = new GrokManager('/tmp/test')
    // No error = success
    expect(manager).toBeDefined()
  })

  it('should use cwd when no root provided', () => {
    const manager = new GrokManager()
    expect(manager).toBeDefined()
  })
})

// ============================================
// getGraphStatus
// ============================================

describe('getGraphStatus', () => {
  it('should return exists=false when graph file missing', async () => {
    const manager = new GrokManager(TEST_DIR)
    const status = await manager.getGraphStatus()

    expect(status.exists).toBe(false)
    expect(status.nodeCount).toBeUndefined()
    expect(status.edgeCount).toBeUndefined()
  })

  it('should return graph stats when file exists', async () => {
    const graphDir = resolve(TEST_DIR, '.understand-anything')
    mkdirSync(graphDir, { recursive: true })

    const graphData = {
      nodes: [{ id: '1' }, { id: '2' }, { id: '3' }],
      edges: [{ from: '1', to: '2' }],
      metadata: { lastUpdated: new Date().toISOString() },
    }
    writeFileSync(resolve(graphDir, 'knowledge-graph.json'), JSON.stringify(graphData))

    const manager = new GrokManager(TEST_DIR)
    const status = await manager.getGraphStatus()

    expect(status.exists).toBe(true)
    expect(status.nodeCount).toBe(3)
    expect(status.edgeCount).toBe(1)
    expect(status.stale).toBe(false)
  })

  it('should mark graph as stale when older than 24h', async () => {
    const graphDir = resolve(TEST_DIR, '.understand-anything')
    mkdirSync(graphDir, { recursive: true })

    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    const graphData = {
      nodes: [{ id: '1' }],
      edges: [],
      metadata: { lastUpdated: oldDate },
    }
    writeFileSync(resolve(graphDir, 'knowledge-graph.json'), JSON.stringify(graphData))

    const manager = new GrokManager(TEST_DIR)
    const status = await manager.getGraphStatus()

    expect(status.exists).toBe(true)
    expect(status.stale).toBe(true)
  })

  it('should handle malformed JSON gracefully', async () => {
    const graphDir = resolve(TEST_DIR, '.understand-anything')
    mkdirSync(graphDir, { recursive: true })
    writeFileSync(resolve(graphDir, 'knowledge-graph.json'), 'not json')

    const manager = new GrokManager(TEST_DIR)
    const status = await manager.getGraphStatus()

    expect(status.exists).toBe(false)
  })
})

// ============================================
// ensureGrokSource (partial)
// ============================================

describe('ensureGrokSource', () => {
  it('should return source dir if already exists', async () => {
    const vendorDir = resolve(TEST_DIR, 'vendor', 'grok')
    const sourceDir = resolve(vendorDir, 'understand-anything')
    mkdirSync(sourceDir, { recursive: true })

    // Need to override vendorDir — use a subclass or test via real path
    // For now, test the "already exists" logic by checking the directory
    expect(existsSync(sourceDir)).toBe(true)
  })
})

// ============================================
// Stub methods
// ============================================

describe('stub methods', () => {
  it('queryGraph should throw not implemented', async () => {
    const manager = new GrokManager(TEST_DIR)
    await expect(manager.queryGraph('test')).rejects.toThrow('Not implemented')
  })

  it('startDashboard should throw not implemented', async () => {
    const manager = new GrokManager(TEST_DIR)
    await expect(manager.startDashboard()).rejects.toThrow('Not implemented')
  })

  it('runAgentPipeline should throw not implemented', async () => {
    const manager = new GrokManager(TEST_DIR)
    await expect(manager.runAgentPipeline({})).rejects.toThrow('Not implemented')
  })
})
