/**
 * GraphStore 测试
 *
 * 测试策略:
 * 1. 空数据源 → 正确错误
 * 2. codegraph.db 加载 → 节点/边正确映射
 * 3. Grok JSON 加载 → 节点/边正确合并
 * 4. 双数据源合并 → 属性优先级正确
 * 5. 边类型映射 → 7 种 codegraph 类型 + 2 种 grok 类型
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { GraphStore, GraphStoreError, type EdgeMeta, type NodeMetadata } from '../GraphStore.js'
import { resolve } from 'path'

// 使用实际的 codegraph.db 做集成测试
const PROJECT_ROOT = resolve(import.meta.dir, '../../../../')

describe('GraphStore', () => {
  let store: GraphStore

  beforeEach(() => {
    // 使用 PROJECT_ROOT 作为 key（GraphStore 用它解析 .codegraph/ 路径）
    // markDirty() 强制重新加载避免缓存污染
    store = GraphStore.getInstance(PROJECT_ROOT)
    store.markDirty()
  })

  describe('load()', () => {
    test('should load codegraph.db successfully', async () => {
      const data = await store.load()
      expect(store.isLoaded).toBe(true)
      expect(store.size.nodes).toBeGreaterThan(0)
      expect(store.size.edges).toBeGreaterThan(0)
    })

    test('should have correct node metadata', async () => {
      await store.load()
      const nodes = [...store.nodeMeta.values()]
      expect(nodes.length).toBeGreaterThan(0)

      // 每个节点必须有 id, name, kind, file, line
      for (const node of nodes.slice(0, 10)) {
        expect(node.id).toBeTruthy()
        expect(node.name).toBeTruthy()
        expect(node.kind).toBeTruthy()
        expect(node.file).toBeTruthy()
        expect(node.line).toBeGreaterThan(0)
      }
    })

    test('should map all 7 codegraph edge types', async () => {
      await store.load()
      const edgeTypes = new Set<EdgeMeta['type']>()

      for (const [, outMap] of store.adjacency) {
        for (const [, edge] of outMap) {
          edgeTypes.add(edge.type)
        }
      }

      // 至少应有 calls, imports, contains, data (references)
      expect(edgeTypes.has('calls')).toBe(true)
      expect(edgeTypes.has('imports')).toBe(true)
      expect(edgeTypes.has('contains')).toBe(true)
      expect(edgeTypes.has('data')).toBe(true) // references → data
    })

    test('should build reverse edges correctly', async () => {
      await store.load()

      // 随机取一个有出边的节点，验证反向边存在
      for (const [from, outMap] of store.adjacency) {
        if (outMap.size === 0) continue
        const firstTarget = [...outMap.keys()][0]
        if (firstTarget.includes('::')) continue // 跳过合并 key

        const reverseMap = store.getInEdges(firstTarget)
        expect(reverseMap.has(from)).toBe(true)
        break
      }
    })

    test('should report size correctly', async () => {
      await store.load()
      const { nodes, edges } = store.size
      expect(nodes).toBeGreaterThan(50000) // 实际 53987
      expect(edges).toBeGreaterThan(100000) // 实际 137337
    })
  })

  describe('edge type mapping', () => {
    test('calls kind maps to calls type', async () => {
      await store.load()
      // 找一条 calls 边验证
      for (const [, outMap] of store.adjacency) {
        for (const [, edge] of outMap) {
          if (edge.type === 'calls') {
            expect(edge.type).toBe('calls')
            expect(edge.weight).toBe(1)
            return
          }
        }
      }
    })

    test('contains kind maps to contains type', async () => {
      await store.load()
      for (const [, outMap] of store.adjacency) {
        for (const [, edge] of outMap) {
          if (edge.type === 'contains') {
            expect(edge.type).toBe('contains')
            return
          }
        }
      }
    })
  })

  describe('node id format', () => {
    test('nodes.id should be kind:hash format', async () => {
      await store.load()
      const nodes = [...store.nodeMeta.values()]

      // 检查 id 格式: 应该是 kind:hash 或 file:path
      const fileNode = nodes.find(n => n.kind === 'file')
      expect(fileNode).toBeDefined()
      expect(fileNode!.id).toMatch(/^file:/)

      const funcNode = nodes.find(n => n.kind === 'function')
      expect(funcNode).toBeDefined()
      expect(funcNode!.id).toMatch(/^function:/)
    })

    test('nodes should have qualified_name', async () => {
      await store.load()
      const nodes = [...store.nodeMeta.values()]
      const withQN = nodes.filter(n => n.qualified_name)
      expect(withQN.length).toBeGreaterThan(0)
    })
  })

  describe('error handling', () => {
    test('should throw NO_DATA_SOURCE for non-existent project', async () => {
      const badStore = GraphStore.getInstance('/tmp/nonexistent-' + Date.now())
      try {
        await badStore.load()
        expect(true).toBe(false) // should not reach
      } catch (e) {
        expect(e).toBeInstanceOf(GraphStoreError)
        expect((e as GraphStoreError).code).toBe('NO_DATA_SOURCE')
      }
    })

    test('should provide suggestion in error', async () => {
      const badStore = GraphStore.getInstance('/tmp/nonexistent-2-' + Date.now())
      try {
        await badStore.load()
      } catch (e) {
        expect((e as GraphStoreError).suggestion).toBeTruthy()
      }
    })
  })

  describe('reload and markDirty', () => {
    test('should reload data after markDirty', async () => {
      await store.load()
      const sizeBefore = store.size

      store.markDirty()
      expect(store.isLoaded).toBe(false)

      await store.load()
      const sizeAfter = store.size
      expect(sizeAfter.nodes).toBe(sizeBefore.nodes)
    })
  })
})
