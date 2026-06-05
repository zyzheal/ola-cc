/**
 * BatchOrchestrator 测试 (F-105)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { BatchOrchestrator } from '../BatchOrchestrator.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync, existsSync, mkdirSync } from 'fs'

describe('BatchOrchestrator', () => {
  let checkpointFile: string

  beforeEach(() => {
    const dir = join(tmpdir(), 'batch-test')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    checkpointFile = join(dir, `checkpoint-${Date.now()}.json`)
  })

  afterEach(() => {
    if (existsSync(checkpointFile)) unlinkSync(checkpointFile)
  })

  describe('splitBatches', () => {
    it('正确拆分数组为批次', () => {
      const orch = new BatchOrchestrator({ batchSize: 3 })
      const batches = orch.splitBatches([1, 2, 3, 4, 5, 6, 7])

      expect(batches).toHaveLength(3)
      expect(batches[0]).toEqual([1, 2, 3])
      expect(batches[1]).toEqual([4, 5, 6])
      expect(batches[2]).toEqual([7])
    })

    it('空数组返回空批次', () => {
      const orch = new BatchOrchestrator({ batchSize: 5 })
      expect(orch.splitBatches([])).toEqual([])
    })

    it('元素少于 batchSize 时只有一批', () => {
      const orch = new BatchOrchestrator({ batchSize: 10 })
      expect(orch.splitBatches([1, 2, 3])).toHaveLength(1)
    })

    it('元素恰好是 batchSize 的倍数', () => {
      const orch = new BatchOrchestrator({ batchSize: 2 })
      const batches = orch.splitBatches([1, 2, 3, 4])
      expect(batches).toHaveLength(2)
    })
  })

  describe('executeBatches', () => {
    it('所有批次成功执行', async () => {
      const orch = new BatchOrchestrator({
        batchSize: 2,
        concurrency: 1,
        retryCount: 0,
        checkpointFile,
      })

      const batches = [[1, 2], [3, 4], [5, 6]]
      const results = await orch.executeBatches(
        batches,
        async (batch) => batch.map(x => x * 2),
      )

      expect(results.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10, 12])
    })

    it('进度回调被调用', async () => {
      const orch = new BatchOrchestrator({
        batchSize: 2,
        concurrency: 1,
        retryCount: 0,
        checkpointFile,
      })

      const progress: Array<[number, number]> = []
      const batches = [[1], [2], [3]]

      await orch.executeBatches(
        batches,
        async (batch) => batch,
        (completed, total) => progress.push([completed, total]),
      )

      expect(progress).toHaveLength(3)
      expect(progress[2]).toEqual([3, 3])
    })

    it('失败批次自动重试', async () => {
      const orch = new BatchOrchestrator({
        batchSize: 2,
        concurrency: 1,
        retryCount: 2,
        checkpointFile,
      })

      let attempts = 0
      const batches = [[1, 2]]

      const results = await orch.executeBatches(
        batches,
        async (batch) => {
          attempts++
          if (attempts === 1) throw new Error('transient failure')
          return batch.map(x => x * 2)
        },
      )

      expect(results).toEqual([2, 4])
      expect(attempts).toBe(2)
    })

    it('重试耗尽后记录错误', async () => {
      const orch = new BatchOrchestrator({
        batchSize: 2,
        concurrency: 1,
        retryCount: 0, // 不重试
        checkpointFile,
      })

      const batches = [[1, 2], [3, 4]]

      // 第一批始终失败
      const results = await orch.executeBatches(
        batches,
        async (batch) => {
          if (batch[0] === 1) throw new Error('permanent failure')
          return batch.map(x => x * 2)
        },
      )

      // 第二批成功
      expect(results).toEqual([6, 8])
    })

    it('并发控制有效（不超过 concurrency）', async () => {
      let running = 0
      let maxRunning = 0

      const orch = new BatchOrchestrator({
        batchSize: 1,
        concurrency: 2,
        retryCount: 0,
        checkpointFile,
      })

      const batches = [[1], [2], [3], [4], [5]]

      await orch.executeBatches(
        batches,
        async (batch) => {
          running++
          maxRunning = Math.max(maxRunning, running)
          await new Promise(r => setTimeout(r, 50))
          running--
          return batch
        },
      )

      expect(maxRunning).toBeLessThanOrEqual(2)
    })
  })

  describe('process (简化接口)', () => {
    it('处理数组并返回结果和错误', async () => {
      const orch = new BatchOrchestrator({
        batchSize: 2,
        concurrency: 1,
        retryCount: 0,
        checkpointFile,
      })

      const { results, errors } = await orch.process(
        [1, 2, 3, 4],
        async (batch) => batch.map(x => x * 3),
      )

      expect(results.sort((a, b) => a - b)).toEqual([3, 6, 9, 12])
      expect(errors).toHaveLength(0)
    })

    it('部分失败时收集错误', async () => {
      const orch = new BatchOrchestrator({
        batchSize: 2,
        concurrency: 1,
        retryCount: 0,
        checkpointFile,
      })

      const { results, errors } = await orch.process(
        [1, 2, 3, 4],
        async (batch) => {
          if (batch[0] === 1) throw new Error('batch 1 failed')
          return batch.map(x => x * 3)
        },
      )

      expect(results).toEqual([9, 12])
      expect(errors).toHaveLength(1)
      expect(errors[0].batchIndex).toBe(0)
    })

    it('进度回调正确', async () => {
      const orch = new BatchOrchestrator({
        batchSize: 2,
        concurrency: 1,
        retryCount: 0,
        checkpointFile,
      })

      const progress: number[] = []
      await orch.process(
        [1, 2, 3, 4, 5],
        async (batch) => batch,
        (completed) => progress.push(completed),
      )

      expect(progress).toEqual([1, 2, 3])
    })
  })

  describe('checkpoint (断点续传)', () => {
    it('saveCheckpoint + loadCheckpoint', () => {
      const orch = new BatchOrchestrator({ checkpointFile })

      const data = { key: 'value', count: 42 }
      orch.saveCheckpoint(data)

      const loaded = orch.loadCheckpoint()
      expect(loaded).toBeDefined()
      expect((loaded as any).key).toBe('value')
    })

    it('loadCheckpoint 无文件返回 null', () => {
      const orch = new BatchOrchestrator({
        checkpointFile: '/nonexistent/path/checkpoint.json',
      })
      expect(orch.loadCheckpoint()).toBeNull()
    })

    it('clearCheckpoint 删除文件', () => {
      const orch = new BatchOrchestrator({ checkpointFile })
      orch.saveCheckpoint({ test: true })
      expect(existsSync(checkpointFile)).toBe(true)

      orch.clearCheckpoint()
      // 文件可能已被删除
      expect(orch.loadCheckpoint()).toBeNull()
    })

    it('saveCheckpoint 失败不抛出', () => {
      const orch = new BatchOrchestrator({
        checkpointFile: '/invalid/dir/checkpoint.json',
      })
      // 不应抛出
      expect(() => orch.saveCheckpoint({ test: true })).not.toThrow()
    })
  })

  describe('getConfig', () => {
    it('返回当前配置的副本', () => {
      const orch = new BatchOrchestrator({
        batchSize: 5,
        concurrency: 3,
      })

      const config = orch.getConfig()
      expect(config.batchSize).toBe(5)
      expect(config.concurrency).toBe(3)
      expect(config.retryCount).toBe(2) // 默认值

      // 修改副本不影响原始配置
      config.batchSize = 100
      expect(orch.getConfig().batchSize).toBe(5)
    })
  })

  describe('默认配置', () => {
    it('无参数时使用默认值', () => {
      const orch = new BatchOrchestrator()
      const config = orch.getConfig()

      expect(config.batchSize).toBe(12)
      expect(config.concurrency).toBe(2)
      expect(config.retryCount).toBe(2)
    })

    it('部分参数覆盖默认值', () => {
      const orch = new BatchOrchestrator({ batchSize: 20 })
      const config = orch.getConfig()

      expect(config.batchSize).toBe(20)
      expect(config.concurrency).toBe(2) // 默认
    })
  })
})
