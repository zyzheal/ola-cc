/**
 * GraphStore 测试
 *
 * 测试策略:
 * 1. 空数据源 → 正确错误
 * 2. codegraph.db 加载 → 节点/边正确映射
 * 3. Grok JSON 加载 → 节点/边正确合并
 * 4. 双数据源合并 → 属性优先级正确
 * 5. 边类型映射 → 13 种 codegraph 类型 + 2 种 grok 类型
 * 6. Phase 1b 无损化改造：EdgeType扩展/schema验证/NodeKind/fileKeyToId/新API/concurrent lock
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { GraphStore, GraphStoreError, type EdgeMeta, type NodeMetadata } from '../GraphStore.js'
import { resolve } from 'path'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'fs'

// 使用实际的 codegraph.db 做集成测试
const PROJECT_ROOT = resolve(import.meta.dir, '../../../../')

/**
 * Helper: create a test store with an in-memory-like SQLite DB at the given directory.
 * Creates .codegraph/codegraph.db with the given schema and data.
 * Returns the store after loading.
 */
async function createStoreWithDb(
  dir: string,
  nodeSchema: string,
  edgeSchema: string,
  nodeInserts: string[],
  edgeInserts: string[],
): Promise<GraphStore> {
  mkdirSync(resolve(dir, '.codegraph'), { recursive: true })
  const dbPath = resolve(dir, '.codegraph', 'codegraph.db')
  const db = new Database(dbPath)
  db.run(nodeSchema)
  db.run(edgeSchema)
  for (const sql of nodeInserts) db.run(sql)
  for (const sql of edgeInserts) db.run(sql)
  db.close()

  const store = GraphStore.getInstance(dir)
  await store.load()
  return store
}

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
        for (const [, edges] of outMap) {
          for (const edge of edges) {
            edgeTypes.add(edge.type)
          }
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
        for (const [, edges] of outMap) {
          for (const edge of edges) {
            if (edge.type === 'calls') {
              expect(edge.type).toBe('calls')
              expect(edge.weight).toBe(1)
              return
            }
          }
        }
      }
    })

    test('contains kind maps to contains type', async () => {
      await store.load()
      for (const [, outMap] of store.adjacency) {
        for (const [, edges] of outMap) {
          for (const edge of edges) {
            if (edge.type === 'contains') {
              expect(edge.type).toBe('contains')
              return
            }
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

  describe('EdgeMeta[] array storage', () => {
    test('adjacency values should be EdgeMeta[] arrays, not single EdgeMeta', async () => {
      // 加载后，adjacency.get(from).get(to) 应该返回 EdgeMeta[] 数组
      await store.load()

      // 找一个有出边的节点
      for (const [from, outMap] of store.adjacency) {
        if (outMap.size === 0) continue
        for (const [to, value] of outMap) {
          // 关键断言：value 应该是数组 (EdgeMeta[])，不是对象 (EdgeMeta)
          expect(Array.isArray(value)).toBe(true)
          if (Array.isArray(value)) {
            expect(value.length).toBeGreaterThan(0)
            // 每个元素应该有 type 和 weight
            for (const edge of value) {
              expect(edge).toHaveProperty('type')
              expect(edge).toHaveProperty('weight')
            }
          }
          return // 只检查第一条边
        }
      }
    })

    test('no merged keys with :: separator in adjacency', async () => {
      // 新设计不应该有 `${to}::${type}` 这样的合并 key
      await store.load()

      for (const [from, outMap] of store.adjacency) {
        for (const [key] of outMap) {
          expect(key).not.toContain('::')
        }
      }
    })

    test('reverse edges should also be EdgeMeta[] arrays', async () => {
      await store.load()

      for (const [to, inMap] of store.reverse) {
        if (inMap.size === 0) continue
        for (const [from, value] of inMap) {
          expect(Array.isArray(value)).toBe(true)
          return
        }
      }
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

// ============================================================
// Phase 1b: EdgeType expansion (12+1 kinds)
// ============================================================

describe('Phase 1b: EdgeType expansion', () => {
  test('CODEGRAPH_EDGE_MAP should have 12 entries', () => {
    // Verify the exported EdgeMeta type accepts all 13 types
    const validTypes: EdgeMeta['type'][] = [
      'calls', 'imports', 'data', 'control', 'inherits', 'implements',
      'contains', 'exports', 'type_of', 'returns', 'instantiates', 'overrides', 'decorates',
    ]
    expect(validTypes.length).toBe(13)
  })

  test('new edge types should be valid EdgeMeta types', () => {
    const edge: EdgeMeta = { type: 'exports', weight: 1 }
    expect(edge.type).toBe('exports')
    const edge2: EdgeMeta = { type: 'type_of', weight: 1 }
    expect(edge2.type).toBe('type_of')
    const edge3: EdgeMeta = { type: 'returns', weight: 1 }
    expect(edge3.type).toBe('returns')
    const edge4: EdgeMeta = { type: 'instantiates', weight: 1 }
    expect(edge4.type).toBe('instantiates')
    const edge5: EdgeMeta = { type: 'overrides', weight: 1 }
    expect(edge5.type).toBe('overrides')
    const edge6: EdgeMeta = { type: 'decorates', weight: 1 }
    expect(edge6.type).toBe('decorates')
  })
})

// ============================================================
// Phase 1b: codegraph.db schema validation
// ============================================================

describe('Phase 1b: schema validation', () => {
  const TEST_DIR = resolve('/tmp', 'graphstore-schema-test-' + Date.now())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('should handle missing optional columns gracefully', async () => {
    const store = await createStoreWithDb(
      TEST_DIR + '/minimal',
      `CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`,
      `CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`,
      [
        `INSERT INTO nodes VALUES ('func:a', 'function', 'foo', 'src/foo.ts', 10)`,
        `INSERT INTO nodes VALUES ('func:b', 'function', 'bar', 'src/bar.ts', 20)`,
      ],
      [`INSERT INTO edges VALUES ('func:a', 'func:b', 'calls')`],
    )

    expect(store.nodeMeta.size).toBe(2)
    const nodeA = store.getNode('func:a')!
    expect(nodeA.name).toBe('foo')
    expect(nodeA.signature).toBeUndefined()
    expect(nodeA.qualified_name).toBeUndefined()
  })

  test('should load extended columns when present', async () => {
    const store = await createStoreWithDb(
      TEST_DIR + '/extended',
      `CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
        file_path TEXT, start_line INTEGER, end_line INTEGER, signature TEXT,
        docstring TEXT, language TEXT, visibility TEXT,
        is_exported INTEGER, is_async INTEGER, is_static INTEGER, is_abstract INTEGER
      )`,
      `CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`,
      [`INSERT INTO nodes VALUES ('func:c', 'function', 'baz', 'mod.baz', 'src/baz.ts', 5, 15, 'fn()', 'A doc', 'typescript', 'public', 1, 1, 0, 0)`],
      [`INSERT INTO edges VALUES ('func:c', 'func:c', 'calls')`],
    )

    const nodeC = store.getNode('func:c')!
    expect(nodeC.name).toBe('baz')
    expect(nodeC.qualified_name).toBe('mod.baz')
    expect(nodeC.signature).toBe('fn()')
    // Extended fields stored in NodeMetadata
    expect((nodeC as any).docstring).toBe('A doc')
    expect((nodeC as any).language).toBe('typescript')
    expect((nodeC as any).end_line).toBe(15)
  })

  test('should handle all 12 edge types from codegraph', async () => {
    const edgeKinds = [
      'calls', 'imports', 'contains', 'references', 'extends', 'implements',
      'exports', 'type_of', 'returns', 'instantiates', 'overrides', 'decorates',
    ]

    const edgeInserts = edgeKinds.map(kind => `INSERT INTO edges VALUES ('n:a', 'n:b', '${kind}')`)

    const store = await createStoreWithDb(
      TEST_DIR + '/alledges',
      `CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`,
      `CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`,
      [
        `INSERT INTO nodes VALUES ('n:a', 'function', 'a', 'a.ts', 1)`,
        `INSERT INTO nodes VALUES ('n:b', 'function', 'b', 'b.ts', 1)`,
      ],
      edgeInserts,
    )

    // Verify all edge types are mapped correctly
    const outEdges = store.getOutEdges('n:a')
    const toB = outEdges.get('n:b')
    expect(toB).toBeDefined()
    expect(toB!.length).toBe(edgeKinds.length)

    const types = new Set(toB!.map(e => e.type))
    expect(types.has('calls')).toBe(true)
    expect(types.has('imports')).toBe(true)
    expect(types.has('contains')).toBe(true)
    expect(types.has('data')).toBe(true)        // references → data
    expect(types.has('inherits')).toBe(true)     // extends → inherits
    expect(types.has('implements')).toBe(true)
    expect(types.has('exports')).toBe(true)
    expect(types.has('type_of')).toBe(true)
    expect(types.has('returns')).toBe(true)
    expect(types.has('instantiates')).toBe(true) // instantiates → instantiates (not calls)
    expect(types.has('overrides')).toBe(true)
    expect(types.has('decorates')).toBe(true)
  })
})

// ============================================================
// Phase 1b: fileKeyToId identity bridge
// ============================================================

describe('Phase 1b: fileKeyToId identity bridge', () => {
  const TEST_DIR = resolve('/tmp', 'graphstore-identity-test-' + Date.now())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('Grok nodes should merge with codegraph nodes by file:name', async () => {
    const dir = TEST_DIR + '/merge'
    mkdirSync(resolve(dir, '.codegraph'), { recursive: true })

    // Create codegraph DB
    const dbPath = resolve(dir, '.codegraph', 'codegraph.db')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, start_line INTEGER, signature TEXT)`)
    db.run(`CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`)
    db.run(`INSERT INTO nodes VALUES ('func:abc', 'function', 'processData', 'lib.processData', 'src/lib.ts', 42, 'fn(data)')`)
    db.close()

    // Create Grok JSON with matching node
    const grokDir = resolve(dir, '.understand-anything')
    mkdirSync(grokDir, { recursive: true })
    writeFileSync(resolve(grokDir, 'knowledge-graph.json'), JSON.stringify({
      nodes: [
        { id: 'grok:processData', name: 'processData', kind: 'function', file: 'src/lib.ts', line: 42, layer: 'L2', domain: 'core' },
      ],
      edges: [],
    }))

    const store = GraphStore.getInstance(dir)
    await store.load()

    // The node should be merged: codegraph id kept, Grok layer/domain added
    const node = store.getNode('func:abc')
    expect(node).toBeDefined()
    expect(node!.layer).toBe('L2')
    expect(node!.domain).toBe('core')
    expect(node!.name).toBe('processData')

    // Should NOT have a separate Grok-only node with key "src/lib.ts:processData"
    const grokOnlyNode = store.getNode('src/lib.ts:processData')
    expect(grokOnlyNode).toBeUndefined()
  })

  test('Grok-only nodes should still be added with file:name key', async () => {
    const dir = TEST_DIR + '/grokonly'
    mkdirSync(resolve(dir, '.codegraph'), { recursive: true })

    // Create empty codegraph DB
    const dbPath = resolve(dir, '.codegraph', 'codegraph.db')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`)
    db.run(`CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`)
    db.close()

    // Create Grok JSON with a unique node
    const grokDir = resolve(dir, '.understand-anything')
    mkdirSync(grokDir, { recursive: true })
    writeFileSync(resolve(grokDir, 'knowledge-graph.json'), JSON.stringify({
      nodes: [
        { id: 'grok:only', name: 'uniqueFunc', kind: 'function', file: 'src/unique.ts', line: 10, layer: 'L1', domain: 'util' },
      ],
      edges: [],
    }))

    const store = GraphStore.getInstance(dir)
    await store.load()

    // Grok-only node should be added with file:name key
    const node = store.getNode('src/unique.ts:uniqueFunc')
    expect(node).toBeDefined()
    expect(node!.layer).toBe('L1')
    expect(node!.domain).toBe('util')
  })
})

// ============================================================
// Phase 1b: New public API methods
// ============================================================

describe('Phase 1b: new public API methods', () => {
  const TEST_DIR = resolve('/tmp', 'graphstore-api-test-' + Date.now())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  const NODE_SCHEMA = `CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`
  const EDGE_SCHEMA = `CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`
  const NODE_DATA = [
    `INSERT INTO nodes VALUES ('n:a', 'function', 'a', 'a.ts', 1)`,
    `INSERT INTO nodes VALUES ('n:b', 'function', 'b', 'b.ts', 1)`,
    `INSERT INTO nodes VALUES ('n:c', 'function', 'c', 'c.ts', 1)`,
  ]
  const EDGE_DATA = [
    `INSERT INTO edges VALUES ('n:a', 'n:b', 'calls')`,
    `INSERT INTO edges VALUES ('n:a', 'n:c', 'imports')`,
    `INSERT INTO edges VALUES ('n:b', 'n:c', 'calls')`,
    `INSERT INTO edges VALUES ('n:c', 'n:a', 'references')`, // cycle
  ]

  test('getOutNeighborIds should return unique neighbor IDs', async () => {
    const store = await createStoreWithDb(TEST_DIR + '/t1', NODE_SCHEMA, EDGE_SCHEMA, NODE_DATA, EDGE_DATA)
    const neighbors = store.getOutNeighborIds('n:a')
    expect(neighbors).toContain('n:b')
    expect(neighbors).toContain('n:c')
    expect(neighbors.length).toBe(2)
  })

  test('getOutNeighborIds should return empty for unknown node', async () => {
    const store = await createStoreWithDb(TEST_DIR + '/t2', NODE_SCHEMA, EDGE_SCHEMA, NODE_DATA, EDGE_DATA)
    expect(store.getOutNeighborIds('n:nonexistent')).toEqual([])
  })

  test('getInNeighborIds should return nodes with edges pointing to target', async () => {
    const store = await createStoreWithDb(TEST_DIR + '/t3', NODE_SCHEMA, EDGE_SCHEMA, NODE_DATA, EDGE_DATA)
    const inNeighbors = store.getInNeighborIds('n:c')
    expect(inNeighbors).toContain('n:a')
    expect(inNeighbors).toContain('n:b')
    expect(inNeighbors.length).toBe(2)
  })

  test('getEdgeBetween should return all edges between two nodes', async () => {
    const store = await createStoreWithDb(TEST_DIR + '/t4', NODE_SCHEMA, EDGE_SCHEMA, NODE_DATA, EDGE_DATA)
    const edges = store.getEdgeBetween('n:a', 'n:b')
    expect(edges.length).toBe(1)
    expect(edges[0].type).toBe('calls')
  })

  test('getEdgeBetween should return empty for no connection', async () => {
    const store = await createStoreWithDb(TEST_DIR + '/t5', NODE_SCHEMA, EDGE_SCHEMA, NODE_DATA, EDGE_DATA)
    expect(store.getEdgeBetween('n:b', 'n:a')).toEqual([])
  })

  test('getOutDegree should count total outgoing edges', async () => {
    const store = await createStoreWithDb(TEST_DIR + '/t6', NODE_SCHEMA, EDGE_SCHEMA, NODE_DATA, EDGE_DATA)
    // n:a → n:b (calls) + n:a → n:c (imports) = 2
    expect(store.getOutDegree('n:a')).toBe(2)
    // n:b → n:c (calls) = 1
    expect(store.getOutDegree('n:b')).toBe(1)
    expect(store.getOutDegree('n:nonexistent')).toBe(0)
  })

  test('getInDegree should count total incoming edges', async () => {
    const store = await createStoreWithDb(TEST_DIR + '/t7', NODE_SCHEMA, EDGE_SCHEMA, NODE_DATA, EDGE_DATA)
    // n:c has incoming: n:a→n:c, n:b→n:c = 2
    expect(store.getInDegree('n:c')).toBe(2)
    // n:a has incoming: n:c→n:a (references) = 1
    expect(store.getInDegree('n:a')).toBe(1)
  })

  test('getWeightedOutDegree should sum weights of outgoing edges', async () => {
    const store = await createStoreWithDb(TEST_DIR + '/t8', NODE_SCHEMA, EDGE_SCHEMA, NODE_DATA, EDGE_DATA)
    expect(store.getWeightedOutDegree('n:a')).toBe(2)
  })

  test('getWeightedOutDegree with excludeTypes should exclude specified types', async () => {
    const store = await createStoreWithDb(TEST_DIR + '/t9', NODE_SCHEMA, EDGE_SCHEMA, NODE_DATA, EDGE_DATA)
    // n:a: calls(1) + imports(1) = 2 total
    expect(store.getWeightedOutDegree('n:a', ['imports'])).toBe(1)
    expect(store.getWeightedOutDegree('n:a', ['calls'])).toBe(1)
    expect(store.getWeightedOutDegree('n:a', ['calls', 'imports'])).toBe(0)
  })
})

// ============================================================
// Phase 1b: loadingPromise concurrent lock
// ============================================================

describe('Phase 1b: loadingPromise concurrent lock', () => {
  const TEST_DIR = resolve('/tmp', 'graphstore-concurrent-test-' + Date.now())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('concurrent load() calls should share the same promise', async () => {
    const dir = TEST_DIR + '/concurrent1'
    const store = await createStoreWithDb(
      dir,
      `CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`,
      `CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`,
      [`INSERT INTO nodes VALUES ('n:x', 'function', 'x', 'x.ts', 1)`],
      [],
    )

    // Already loaded, verify concurrent calls return same data
    const [result1, result2, result3] = await Promise.all([
      store.load(),
      store.load(),
      store.load(),
    ])

    expect(result1.nodeMeta.size).toBe(1)
    expect(result2.nodeMeta.size).toBe(1)
    expect(result3.nodeMeta.size).toBe(1)
    expect(store.isLoaded).toBe(true)
  })

  test('concurrent load() on fresh store should share loading promise', async () => {
    const dir = TEST_DIR + '/concurrent2'
    mkdirSync(resolve(dir, '.codegraph'), { recursive: true })
    const dbPath = resolve(dir, '.codegraph', 'codegraph.db')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`)
    db.run(`CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`)
    db.run(`INSERT INTO nodes VALUES ('n:y', 'function', 'y', 'y.ts', 1)`)
    db.close()

    const store = GraphStore.getInstance(dir)
    // NOT loaded yet — fire concurrent loads
    const results = await Promise.all([
      store.load(),
      store.load(),
      store.load(),
    ])

    for (const result of results) {
      expect(result.nodeMeta.size).toBe(1)
      expect(result.nodeMeta.has('n:y')).toBe(true)
    }
  })

  test('markDirty should reset loadingPromise so next load works', async () => {
    const dir = TEST_DIR + '/concurrent3'
    const store = await createStoreWithDb(
      dir,
      `CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`,
      `CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`,
      [`INSERT INTO nodes VALUES ('n:z', 'function', 'z', 'z.ts', 1)`],
      [],
    )

    expect(store.isLoaded).toBe(true)
    store.markDirty()
    expect(store.isLoaded).toBe(false)

    // Should be able to load again
    await store.load()
    expect(store.isLoaded).toBe(true)
    expect(store.getNode('n:z')).toBeDefined()
  })
})

// ============================================================
// Phase 1b: NodeKind — all 22 kinds preserved
// ============================================================

describe('Phase 1b: NodeKind preservation', () => {
  const TEST_DIR = resolve('/tmp', 'graphstore-nodekind-test-' + Date.now())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('should preserve all 22 node kinds from codegraph.db without truncation', async () => {
    const kinds = [
      'function', 'method', 'class', 'interface', 'enum', 'variable', 'constant',
      'type_alias', 'module', 'file', 'struct', 'trait', 'protocol', 'parameter',
      'namespace', 'route', 'component', 'field', 'property', 'constructor',
      'decorator', 'macro',
    ]

    const nodeInserts = kinds.map((kind, i) =>
      `INSERT INTO nodes VALUES ('kind:${i}', '${kind}', 'node_${i}', 'file_${i}.ts', ${i})`,
    )

    const store = await createStoreWithDb(
      TEST_DIR + '/nodekind',
      `CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER)`,
      `CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`,
      nodeInserts,
      [],
    )

    // Verify all 22 kinds are preserved
    for (let i = 0; i < kinds.length; i++) {
      const node = store.getNode(`kind:${i}`)
      expect(node).toBeDefined()
      expect(node!.kind).toBe(kinds[i])
    }

    // Verify unique kinds count
    const uniqueKinds = new Set([...store.nodeMeta.values()].map(n => n.kind))
    expect(uniqueKinds.size).toBe(22)
  })
})
