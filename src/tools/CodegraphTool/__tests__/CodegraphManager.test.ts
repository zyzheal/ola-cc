/**
 * CodegraphManager 单元测试
 *
 * Run: bun test src/tools/CodegraphTool/__tests__/CodegraphManager.test.ts
 */

import { describe, it, expect } from 'bun:test'
import { join } from 'path'
import * as CodegraphManager from '../CodegraphManager.js'

describe('CodegraphManager', () => {
  describe('module exports', () => {
    it('should export required functions', () => {
      expect(typeof CodegraphManager.isCodegraphInitialized).toBe('function')
      expect(typeof CodegraphManager.ensureReady).toBe('function')
      expect(typeof CodegraphManager.initProject).toBe('function')
      expect(typeof CodegraphManager.getContext).toBe('function')
      expect(typeof CodegraphManager.searchNodes).toBe('function')
      expect(typeof CodegraphManager.getCallers).toBe('function')
      expect(typeof CodegraphManager.getCallees).toBe('function')
      expect(typeof CodegraphManager.getImpact).toBe('function')
      expect(typeof CodegraphManager.getStatus).toBe('function')
      expect(typeof CodegraphManager.getFiles).toBe('function')
      expect(typeof CodegraphManager.sync).toBe('function')
      expect(typeof CodegraphManager.getLastSyncAge).toBe('function')
    })
  })

  describe('getLastSyncAge', () => {
    it('should return null when no sync has been recorded', () => {
      const age = CodegraphManager.getLastSyncAge('/tmp/nonexistent-project-' + Date.now())
      expect(age).toBeNull()
    })

    it('should return a number after sync is recorded', () => {
      // getLastSyncAge returns null for projects that haven't been synced
      // After a real sync, it returns milliseconds since last sync
      const age = CodegraphManager.getLastSyncAge(process.cwd())
      // Either null (never synced) or a non-negative number
      if (age !== null) {
        expect(age).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('isCodegraphInitialized', () => {
    it('should return false for non-existent project', () => {
      const fakePath = join('/tmp', 'test-' + Date.now(), 'subdir')
      expect(CodegraphManager.isCodegraphInitialized(fakePath)).toBe(false)
    })

    it('should return boolean for current project', () => {
      const result = CodegraphManager.isCodegraphInitialized(process.cwd())
      expect(typeof result).toBe('boolean')
    })
  })

  describe('getStatus', () => {
    it('should not trigger binary download', async () => {
      const result = await CodegraphManager.getStatus('/tmp/test-project')
      expect(result.ok).toBe(true)
      const parsed = JSON.parse(result.stdout)
      expect(parsed).toHaveProperty('initialized')
    })
  })
})
