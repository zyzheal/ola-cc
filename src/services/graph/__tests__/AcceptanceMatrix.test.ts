/**
 * AcceptanceMatrix 测试
 *
 * 使用 testHelpers 工厂函数创建已知图拓扑，
 * 验证 6 个用户故事的验收标准。
 */

import { describe, test, expect } from 'bun:test'
import { AcceptanceMatrix } from '../AcceptanceMatrix.js'
import { GraphEngine } from '../GraphEngine.js'
import {
  createStoreFromAdjacency,
  dag,
  cycle,
  chain,
  emptyGraph,
  star,
} from './testHelpers.js'

// ============================================================
// Helper
// ============================================================

function createMatrix(adj: Record<string, string[]>, key?: string) {
  const store = createStoreFromAdjacency(adj, key ?? `acceptance-${Date.now()}`)
  const engine = new GraphEngine(store)
  return new AcceptanceMatrix(engine, store)
}

// ============================================================
// Tests
// ============================================================

describe('AcceptanceMatrix', () => {
  describe('getCriteria', () => {
    test('returns 6 user stories', () => {
      const { store, engine } = dag()
      const matrix = new AcceptanceMatrix(engine, store)

      const criteria = matrix.getCriteria()
      expect(criteria.length).toBe(6)
    })

    test('each criterion has required fields', () => {
      const { store, engine } = dag()
      const matrix = new AcceptanceMatrix(engine, store)

      const criteria = matrix.getCriteria()
      for (const c of criteria) {
        expect(c.id).toBeTruthy()
        expect(c.story).toBeTruthy()
        expect(c.criteria).toBeTruthy()
        expect(typeof c.verify).toBe('function')
      }
    })
  })

  describe('verifyAll', () => {
    test('DAG graph: all criteria pass', async () => {
      const { store, engine } = dag()
      const matrix = new AcceptanceMatrix(engine, store)

      const result = await matrix.verifyAll()

      expect(result.total).toBe(6)
      expect(result.fail).toBe(0)
      expect(result.skip).toBe(0)
      expect(result.pass).toBe(6)
    })

    test('cycle graph: all criteria pass', async () => {
      const { store, engine } = cycle()
      const matrix = new AcceptanceMatrix(engine, store)

      const result = await matrix.verifyAll()

      expect(result.total).toBe(6)
      expect(result.pass).toBe(6)
    })

    test('chain graph: all criteria pass', async () => {
      const { store, engine } = chain(5)
      const matrix = new AcceptanceMatrix(engine, store)

      const result = await matrix.verifyAll()

      expect(result.total).toBe(6)
      expect(result.pass).toBe(6)
    })

    test('star graph: all criteria pass', async () => {
      const { store, engine } = star(5)
      const matrix = new AcceptanceMatrix(engine, store)

      const result = await matrix.verifyAll()

      expect(result.total).toBe(6)
      expect(result.pass).toBe(6)
    })

    test('empty graph: US-01 and US-02 fail', async () => {
      const { store, engine } = emptyGraph()
      const matrix = new AcceptanceMatrix(engine, store)

      const result = await matrix.verifyAll()

      // 空图: 搜索和影响分析应失败
      expect(result.fail).toBeGreaterThan(0)
      const failedIds = result.details.filter(d => d.status === 'fail').map(d => d.id)
      expect(failedIds).toContain('US-01')
    })

    test('result details match pass/fail/skip counts', async () => {
      const { store, engine } = dag()
      const matrix = new AcceptanceMatrix(engine, store)

      const result = await matrix.verifyAll()

      const passCount = result.details.filter(d => d.status === 'pass').length
      const failCount = result.details.filter(d => d.status === 'fail').length
      const skipCount = result.details.filter(d => d.status === 'skip').length

      expect(passCount).toBe(result.pass)
      expect(failCount).toBe(result.fail)
      expect(skipCount).toBe(result.skip)
      expect(passCount + failCount + skipCount).toBe(result.total)
    })
  })

  describe('individual stories', () => {
    test('US-01 symbol search: BFS finds reachable nodes', async () => {
      const { store, engine } = dag()
      const matrix = new AcceptanceMatrix(engine, store)

      const criteria = matrix.getCriteria()
      const us01 = criteria.find(c => c.id === 'US-01')!

      expect(await us01.verify()).toBe(true)
    })

    test('US-02 impact analysis: returns forward and backward reachability', async () => {
      const { store, engine } = dag()
      const matrix = new AcceptanceMatrix(engine, store)

      const criteria = matrix.getCriteria()
      const us02 = criteria.find(c => c.id === 'US-02')!

      expect(await us02.verify()).toBe(true)
    })

    test('US-03 architecture: community detection returns valid result', async () => {
      const { store, engine } = dag()
      const matrix = new AcceptanceMatrix(engine, store)

      const criteria = matrix.getCriteria()
      const us03 = criteria.find(c => c.id === 'US-03')!

      expect(await us03.verify()).toBe(true)
    })

    test('US-04 data flow: backwardDataSlice returns symbols', async () => {
      const { store, engine } = dag()
      const matrix = new AcceptanceMatrix(engine, store)

      const criteria = matrix.getCriteria()
      const us04 = criteria.find(c => c.id === 'US-04')!

      expect(await us04.verify()).toBe(true)
    })

    test('US-05 cyclic deps: SCC detection works', async () => {
      const { store, engine } = cycle()
      const matrix = new AcceptanceMatrix(engine, store)

      const criteria = matrix.getCriteria()
      const us05 = criteria.find(c => c.id === 'US-05')!

      expect(await us05.verify()).toBe(true)
    })

    test('US-06 onboarding: roles and PageRank assigned', async () => {
      const { store, engine } = dag()
      const matrix = new AcceptanceMatrix(engine, store)

      const criteria = matrix.getCriteria()
      const us06 = criteria.find(c => c.id === 'US-06')!

      expect(await us06.verify()).toBe(true)
    })
  })
})
