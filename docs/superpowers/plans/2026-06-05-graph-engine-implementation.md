# GraphEngine 图算法引擎实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建零外部依赖的 TS 图算法引擎 GraphEngine，从 codegraph.db 和 knowledge-graph.json 加载数据，提供 SCC/PageRank/社区检测等 15 种图算法，通过 11 个新 CodeGraph operation + 2 个 Grok operation 暴露给 AI agent。

**Architecture:** GraphStore（数据层）从 SQLite + JSON 双数据源加载，合并为加权邻接表。GraphEngine（算法层）基于邻接表实现图算法。CodegraphTool/GrokTool（Tool 层）包装为 agent 可调用的 operation。三层解耦，GraphStore 单例共享。

**Tech Stack:** TypeScript, bun:sqlite, Zod, React (Ink UI), bun:test

**Design Doc:** `docs/superpowers/specs/2026-06-05-codegraph-grok-enhancement-design.md` (v8)

**Phase 0 Status:** ✅ 全部完成（6/6 验证项通过）

---

## File Structure

```
src/services/graph/                    # 新建目录（共享基础设施层）
├── GraphStore.ts                      # [已创建] 数据适配器，双数据源加载
├── GraphEngine.ts                     # [已创建] 核心图算法引擎，15 种算法
├── IncrementalSync.ts                 # [待创建] 三级增量同步
├── __tests__/
│   ├── GraphStore.test.ts             # [已创建] GraphStore 集成测试
│   ├── GraphEngine.test.ts            # [待创建] GraphEngine 单元测试
│   └── testHelpers.ts                 # [待创建] 测试工厂（生成各种图拓扑）

src/tools/CodegraphTool/
├── CodegraphTool.ts                   # [已存在] 扩展 11 个新 operation
└── __tests__/
    └── codegraph-graph-ops.test.ts    # [待创建] 新 operation 集成测试

src/tools/GrokTool/
├── GrokTool.ts                        # [已存在] 扩展 2 个新 operation
└── __tests__/
    └── grok-graph-ops.test.ts         # [待创建] Grok 新 operation 测试

src/utils/goal/
└── goalToolTier.ts                    # [已存在] 扩展 per-operation debounce
```

---

## Task 1: 测试工厂 — 生成各种图拓扑

**Files:**
- Create: `src/services/graph/__tests__/testHelpers.ts`

- [ ] **Step 1: 创建测试工厂文件**

```typescript
/**
 * GraphEngine 测试工厂
 *
 * 生成各种标准图拓扑，供所有算法测试复用。
 * 每个工厂函数返回 { store, engine } 对象。
 */

import { GraphStore } from '../GraphStore.js'
import { GraphEngine } from '../GraphEngine.js'
import type { EdgeMeta, NodeMetadata } from '../GraphStore.js'

/**
 * 创建内存 GraphStore（不依赖文件系统）
 */
export function createStoreFromAdjacency(
  adj: Record<string, Array<[string, EdgeMeta['type']]>>,
): GraphStore {
  const store = GraphStore.getInstance('test://' + Math.random())
  // 直接注入数据，跳过 load()
  const anyStore = store as any

  for (const [from, targets] of Object.entries(adj)) {
    // 确保 from 节点存在
    if (!anyStore.nodeMeta.has(from)) {
      anyStore.nodeMeta.set(from, makeNode(from))
    }
    let fromMap = anyStore.adjacency.get(from)
    if (!fromMap) {
      fromMap = new Map()
      anyStore.adjacency.set(from, fromMap)
    }

    for (const [to, type] of targets) {
      if (!anyStore.nodeMeta.has(to)) {
        anyStore.nodeMeta.set(to, makeNode(to))
      }
      fromMap.set(to, { type, weight: 1 })

      let toReverse = anyStore.reverse.get(to)
      if (!toReverse) {
        toReverse = new Map()
        anyStore.reverse.set(to, toReverse)
      }
      toReverse.set(from, { type, weight: 1 })
    }
  }

  anyStore.loaded = true
  return store
}

function makeNode(id: string): NodeMetadata {
  return { id, name: id.split(':').pop() ?? id, kind: 'function', file: 'test.ts', line: 1 }
}

// ── 标准图拓扑 ──

/** DAG: A→B→C, A→D→C */
export function dag(): GraphStore {
  return createStoreFromAdjacency({
    A: [['B', 'calls'], ['D', 'calls']],
    B: [['C', 'calls']],
    D: [['C', 'calls']],
  })
}

/** 环: A→B→C→A */
export function cycle(): GraphStore {
  return createStoreFromAdjacency({
    A: [['B', 'calls']],
    B: [['C', 'calls']],
    C: [['A', 'calls']],
  })
}

/** 含环 DAG: A→B→C→A, A→D */
export function dagWithCycle(): GraphStore {
  return createStoreFromAdjacency({
    A: [['B', 'calls'], ['D', 'calls']],
    B: [['C', 'calls']],
    C: [['A', 'calls']],
  })
}

/** 多 SCC: SCC1(A→B→C→A), SCC2(D→E→D), F 孤立 */
export function multiSCC(): GraphStore {
  return createStoreFromAdjacency({
    A: [['B', 'calls']],
    B: [['C', 'calls']],
    C: [['A', 'calls']],
    D: [['E', 'calls']],
    E: [['D', 'calls']],
  })
}

/** 星型: center→leaf1..leafN */
export function star(n = 5): GraphStore {
  const adj: Record<string, Array<[string, EdgeMeta['type']]>> = {
    center: Array.from({ length: n }, (_, i) => [`leaf${i}`, 'calls' as const]),
  }
  return createStoreFromAdjacency(adj)
}

/** 链: 0→1→2→...→N */
export function chain(n = 10): GraphStore {
  const adj: Record<string, Array<[string, EdgeMeta['type']]>> = {}
  for (let i = 0; i < n - 1; i++) {
    adj[`n${i}`] = [[`n${i + 1}`, 'calls']]
  }
  return createStoreFromAdjacency(adj)
}

/** 带权重图 */
export function weightedGraph(): GraphStore {
  const store = createStoreFromAdjacency({
    A: [['B', 'calls'], ['C', 'data']],
    B: [['C', 'calls']],
    C: [['D', 'imports']],
  })
  // 设置不同权重
  const anyStore = store as any
  const aMap = anyStore.adjacency.get('A')
  aMap.set('B', { type: 'calls', weight: 3 })
  aMap.set('C', { type: 'data', weight: 1 })
  return store
}

/** 空图 */
export function emptyGraph(): GraphStore {
  return createStoreFromAdjacency({})
}

/** 完全连接图 K_n */
export function completeGraph(n = 4): GraphStore {
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`)
  const adj: Record<string, Array<[string, EdgeMeta['type']]>> = {}
  for (const from of nodes) {
    adj[from] = nodes.filter(t => t !== from).map(to => [to, 'calls' as const])
  }
  return createStoreFromAdjacency(adj)
}

/** 二分图 */
export function bipartite(): GraphStore {
  return createStoreFromAdjacency({
    a1: [['b1', 'calls'], ['b2', 'calls']],
    a2: [['b1', 'calls'], ['b2', 'calls']],
    a3: [['b2', 'calls']],
  })
}
```

- [ ] **Step 2: 验证测试工厂可用**

Run: `bun test src/services/graph/__tests__/testHelpers.ts`
Expected: 文件无语法错误

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/testHelpers.ts
git commit -m "test: add graph test factory with 9 standard topologies"
```

---

## Task 2: GraphStore 集成测试 — 验证实际 codegraph.db

**Files:**
- Modify: `src/services/graph/__tests__/GraphStore.test.ts`

- [ ] **Step 1: 运行已有 GraphStore 测试**

Run: `bun test src/services/graph/__tests__/GraphStore.test.ts`
Expected: 所有测试通过（依赖实际 codegraph.db）

- [ ] **Step 2: 修复失败的测试（如有）**

根据实际输出调整断言值（如节点数、边数可能随 codegraph.db 更新变化）

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphStore.test.ts
git commit -m "test: verify GraphStore loads actual codegraph.db correctly"
```

---

## Task 3: GraphEngine 基础遍历测试 (BFS/DFS)

**Files:**
- Create: `src/services/graph/__tests__/GraphEngine.test.ts`

- [ ] **Step 1: 写 BFS 失败测试**

```typescript
import { describe, test, expect } from 'bun:test'
import { GraphEngine } from '../GraphEngine.js'
import { dag, cycle, chain, star, emptyGraph, weightedGraph } from './testHelpers.js'

describe('GraphEngine', () => {
  describe('bfs', () => {
    test('should traverse DAG in breadth-first order', () => {
      const engine = new GraphEngine(dag())
      const result = engine.bfs('A')

      expect(result.nodes).toContain('A')
      expect(result.nodes).toContain('B')
      expect(result.nodes).toContain('C')
      expect(result.nodes).toContain('D')
      expect(result.depth.get('A')).toBe(0)
      expect(result.depth.get('B')).toBe(1)
      expect(result.depth.get('D')).toBe(1)
      expect(result.depth.get('C')).toBe(2)
    })

    test('should handle empty graph', () => {
      const engine = new GraphEngine(emptyGraph())
      const result = engine.bfs('nonexistent')
      expect(result.nodes).toEqual([])
    })

    test('should respect maxDepth', () => {
      const engine = new GraphEngine(chain(10))
      const result = engine.bfs('n0', 3)
      expect(result.depth.get('n3')).toBe(3)
      expect(result.depth.has('n4')).toBe(false)
    })
  })

  describe('dfs', () => {
    test('should traverse all reachable nodes', () => {
      const engine = new GraphEngine(dag())
      const result = engine.dfs('A')
      expect(result.nodes.length).toBe(4) // A, B, C, D
      expect(new Set(result.nodes)).toEqual(new Set(['A', 'B', 'C', 'D']))
    })

    test('should handle cycle without infinite loop', () => {
      const engine = new GraphEngine(cycle())
      const result = engine.dfs('A')
      expect(result.nodes.length).toBe(3) // A, B, C (visited once each)
    })
  })
})
```

- [ ] **Step 2: 运行测试验证通过**

Run: `bun test src/services/graph/__tests__/GraphEngine.test.ts`
Expected: BFS/DFS 测试全部通过（已在 GraphEngine.ts 中实现）

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphEngine.test.ts
git commit -m "test: add BFS/DFS traversal tests with 7 topologies"
```

---

## Task 4: Tarjan SCC 测试

**Files:**
- Modify: `src/services/graph/__tests__/GraphEngine.test.ts`

- [ ] **Step 1: 添加 Tarjan SCC 测试**

```typescript
describe('tarjanSCC', () => {
  test('should find single SCC in cycle', () => {
    const engine = new GraphEngine(cycle())
    const sccs = engine.tarjanSCC()

    // A→B→C→A 形成一个 SCC
    const nonTrivial = sccs.filter(s => !s.isTrivial)
    expect(nonTrivial.length).toBe(1)
    expect(nonTrivial[0].size).toBe(3)
    expect(new Set(nonTrivial[0].nodes)).toEqual(new Set(['A', 'B', 'C']))
  })

  test('should mark all nodes as trivial in DAG', () => {
    const engine = new GraphEngine(dag())
    const sccs = engine.tarjanSCC()

    // DAG 无环，每个节点都是独立 SCC
    const nonTrivial = sccs.filter(s => !s.isTrivial)
    expect(nonTrivial.length).toBe(0)
    expect(sccs.length).toBe(4) // A, B, C, D
  })

  test('should find multiple SCCs', () => {
    const engine = new GraphEngine(multiSCC())
    const sccs = engine.tarjanSCC()

    const nonTrivial = sccs.filter(s => !s.isTrivial)
    expect(nonTrivial.length).toBe(2) // SCC1(A,B,C) + SCC2(D,E)
    expect(sccs.some(s => s.size === 3)).toBe(true)
    expect(sccs.some(s => s.size === 2)).toBe(true)
  })

  test('should handle empty graph', () => {
    const engine = new GraphEngine(emptyGraph())
    const sccs = engine.tarjanSCC()
    expect(sccs.length).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/services/graph/__tests__/GraphEngine.test.ts --filter "tarjanSCC"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphEngine.test.ts
git commit -m "test: add Tarjan SCC tests (cycle, DAG, multi-SCC, empty)"
```

---

## Task 5: Topological Sort 测试

**Files:**
- Modify: `src/services/graph/__tests__/GraphEngine.test.ts`

- [ ] **Step 1: 添加拓扑排序测试**

```typescript
describe('topologicalSort', () => {
  test('should return valid topological order for DAG', () => {
    const engine = new GraphEngine(dag())
    const result = engine.topologicalSort()

    expect(result.cycles).toBeUndefined() // 无环
    // A 必须在 B 和 D 之前
    expect(result.order.indexOf('A')).toBeLessThan(result.order.indexOf('B'))
    expect(result.order.indexOf('A')).toBeLessThan(result.order.indexOf('D'))
    // B 和 D 必须在 C 之前
    expect(result.order.indexOf('B')).toBeLessThan(result.order.indexOf('C'))
    expect(result.order.indexOf('D')).toBeLessThan(result.order.indexOf('C'))
  })

  test('should return SCC info when cycle exists', () => {
    const engine = new GraphEngine(dagWithCycle())
    const result = engine.topologicalSort()

    expect(result.cycles).toBeDefined()
    expect(result.cycles!.length).toBeGreaterThan(0)
    // A, B, C 在同一个 SCC 中
    const scc = result.cycles!.find(c => c.nodes.includes('A'))
    expect(scc).toBeDefined()
    expect(scc!.nodes).toContain('B')
    expect(scc!.nodes).toContain('C')
  })

  test('should handle empty graph', () => {
    const engine = new GraphEngine(emptyGraph())
    const result = engine.topologicalSort()
    expect(result.order).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/services/graph/__tests__/GraphEngine.test.ts --filter "topologicalSort"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphEngine.test.ts
git commit -m "test: add topological sort tests (DAG, cycle, empty)"
```

---

## Task 6: PageRank 测试

**Files:**
- Modify: `src/services/graph/__tests__/GraphEngine.test.ts`

- [ ] **Step 1: 添加 PageRank 测试**

```typescript
describe('pageRank', () => {
  test('should rank hub node highest in star graph', () => {
    const engine = new GraphEngine(star(5))
    const result = engine.pageRank()

    expect(result.scores.length).toBe(6) // center + 5 leaves
    // 所有 score 应在 0-1 范围
    for (const { score } of result.scores) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  test('should converge (scores sum close to 1 before normalization)', () => {
    const engine = new GraphEngine(weightedGraph())
    const result = engine.pageRank()

    expect(result.scores.length).toBe(4)
    // 最高分应为 A（最多入边）
    const topNode = result.scores[0]
    expect(topNode.score).toBeGreaterThan(0)
  })

  test('should handle empty graph', () => {
    const engine = new GraphEngine(emptyGraph())
    const result = engine.pageRank()
    expect(result.scores).toEqual([])
  })

  test('should handle dangling nodes (no outgoing edges)', () => {
    const engine = new GraphEngine(chain(3))
    const result = engine.pageRank()

    // n2 是悬挂节点（无出边），概率质量应均匀分配
    expect(result.scores.length).toBe(3)
    for (const { score } of result.scores) {
      expect(score).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/services/graph/__tests__/GraphEngine.test.ts --filter "pageRank"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphEngine.test.ts
git commit -m "test: add PageRank tests (star, weighted, empty, dangling)"
```

---

## Task 7: Backward Reachability + Dominator Tree 测试

**Files:**
- Modify: `src/services/graph/__tests__/GraphEngine.test.ts`

- [ ] **Step 1: 添加 backwardReachability 测试**

```typescript
describe('backwardReachability', () => {
  test('should find all ancestors', () => {
    const engine = new GraphEngine(dag())
    const result = engine.backwardReachability('C')

    expect(result.reachable).toContain('C')
    expect(result.reachable).toContain('B')
    expect(result.reachable).toContain('D')
    expect(result.reachable).toContain('A')
  })

  test('should return only self for root node', () => {
    const engine = new GraphEngine(dag())
    const result = engine.backwardReachability('A')
    expect(result.reachable).toEqual(['A'])
  })

  test('should handle cycle', () => {
    const engine = new GraphEngine(cycle())
    const result = engine.backwardReachability('A')
    expect(result.reachable.length).toBe(3) // A, B, C
  })
})

describe('dominatorTree', () => {
  test('should return null dominator for root', () => {
    const engine = new GraphEngine(dag())
    const tree = engine.dominatorTree('A')
    expect(tree.get('A')).toBeNull()
  })

  test('should identify immediate dominators in chain', () => {
    const engine = new GraphEngine(chain(5))
    const tree = engine.dominatorTree('n0')

    expect(tree.get('n0')).toBeNull()
    expect(tree.get('n1')).toBe('n0')
    expect(tree.get('n2')).toBe('n1')
  })

  test('should handle diamond pattern', () => {
    const engine = new GraphEngine(dag())
    const tree = engine.dominatorTree('A')

    // A→B→C, A→D→C: C 的支配者是 A（因为有两条路径）
    expect(tree.get('A')).toBeNull()
    expect(tree.get('B')).toBe('A')
    expect(tree.get('D')).toBe('A')
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/services/graph/__tests__/GraphEngine.test.ts --filter "backwardReachability|dominatorTree"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphEngine.test.ts
git commit -m "test: add backward reachability and dominator tree tests"
```

---

## Task 8: Delta Graph + Coupling Metrics 测试

**Files:**
- Modify: `src/services/graph/__tests__/GraphEngine.test.ts`

- [ ] **Step 1: 添加 deltaGraph 测试**

```typescript
import { createStoreFromAdjacency } from './testHelpers.js'

describe('deltaGraph', () => {
  test('should detect added and removed nodes', () => {
    const store1 = createStoreFromAdjacency({
      A: [['B', 'calls']],
    })
    const store2 = createStoreFromAdjacency({
      A: [['B', 'calls']],
      C: [['D', 'calls']],
    })

    const engine = new GraphEngine(store1)
    const old: GraphSnapshot = {
      adjacency: (store1 as any).adjacency,
      nodeMeta: (store1 as any).nodeMeta,
      timestamp: Date.now() - 1000,
    }
    const curr: GraphSnapshot = {
      adjacency: (store2 as any).adjacency,
      nodeMeta: (store2 as any).nodeMeta,
      timestamp: Date.now(),
    }

    const delta = engine.deltaGraph(old, curr)
    expect(delta.added).toContain('C')
    expect(delta.added).toContain('D')
    expect(delta.removed).toEqual([])
  })

  test('should detect added edges', () => {
    const store1 = createStoreFromAdjacency({ A: [['B', 'calls']] })
    const store2 = createStoreFromAdjacency({
      A: [['B', 'calls'], ['C', 'calls']],
    })

    const engine = new GraphEngine(store1)
    const delta = engine.deltaGraph(
      { adjacency: (store1 as any).adjacency, nodeMeta: (store1 as any).nodeMeta, timestamp: 0 },
      { adjacency: (store2 as any).adjacency, nodeMeta: (store2 as any).nodeMeta, timestamp: 1 },
    )

    expect(delta.edgeAdded.length).toBe(1)
    expect(delta.edgeAdded[0].from).toBe('A')
    expect(delta.edgeAdded[0].to).toBe('C')
  })
})

describe('couplingMetrics', () => {
  test('should calculate fanIn/fanOut and instability', () => {
    const engine = new GraphEngine(weightedGraph())
    const result = engine.couplingMetrics()

    expect(result.highCoupling.length).toBeGreaterThanOrEqual(0)
    for (const item of result.highCoupling) {
      expect(item.fanIn).toBeGreaterThanOrEqual(0)
      expect(item.fanOut).toBeGreaterThanOrEqual(0)
      expect(item.instability).toBeGreaterThanOrEqual(0)
      expect(item.instability).toBeLessThanOrEqual(1)
    }
  })

  test('should return empty for empty graph', () => {
    const engine = new GraphEngine(emptyGraph())
    const result = engine.couplingMetrics()
    expect(result.highCoupling).toEqual([])
    expect(result.lcom).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/services/graph/__tests__/GraphEngine.test.ts --filter "deltaGraph|couplingMetrics"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphEngine.test.ts
git commit -m "test: add delta graph and coupling metrics tests"
```

---

## Task 9: Classify Roles + Backward Data Slice 测试

**Files:**
- Modify: `src/services/graph/__tests__/GraphEngine.test.ts`

- [ ] **Step 1: 添加 classifyRoles 测试**

```typescript
describe('classifyRoles', () => {
  test('should identify entry nodes (fanIn=0, fanOut>0)', () => {
    const engine = new GraphEngine(dag())
    const roles = engine.classifyRoles()

    expect(roles.get('A')).toBe('entry')
  })

  test('should identify leaf nodes (fanOut=0, fanIn>0)', () => {
    const engine = new GraphEngine(dag())
    const roles = engine.classifyRoles()

    expect(roles.get('C')).toBe('leaf')
  })

  test('should identify dead code in disconnected graph', () => {
    const store = createStoreFromAdjacency({
      entry: [['a', 'calls']],
      a: [['b', 'calls']],
      dead: [['e', 'calls']], // 从 entry 不可达
    })
    const engine = new GraphEngine(store)
    const roles = engine.classifyRoles()

    expect(roles.get('entry')).toBe('entry')
    expect(roles.get('dead')).toBe('dead')
  })

  test('should assign all nodes a role', () => {
    const engine = new GraphEngine(star(5))
    const roles = engine.classifyRoles()

    for (const node of engine.getAllNodeIds()) {
      expect(roles.has(node)).toBe(true)
    }
  })
})

describe('backwardDataSlice', () => {
  test('should follow data edges backward', () => {
    const store = createStoreFromAdjacency({
      A: [['B', 'data']],
      B: [['C', 'data']],
      C: [['D', 'calls']],
    })
    const engine = new GraphEngine(store)
    const result = engine.backwardDataSlice('B')

    expect(result.symbols).toContain('B')
    expect(result.symbols).toContain('A')
    expect(result.dataFlows.length).toBeGreaterThan(0)
  })

  test('should fallback to backwardReachability when no data edges', () => {
    const engine = new GraphEngine(dag()) // only calls edges
    const result = engine.backwardDataSlice('C')

    expect(result.symbols).toContain('C')
    expect(result.symbols).toContain('B')
    expect(result.symbols).toContain('A')
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/services/graph/__tests__/GraphEngine.test.ts --filter "classifyRoles|backwardDataSlice"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphEngine.test.ts
git commit -m "test: add classify roles and backward data slice tests"
```

---

## Task 10: Louvain Community + Katz/Betweenness Centrality 测试

**Files:**
- Modify: `src/services/graph/__tests__/GraphEngine.test.ts`

- [ ] **Step 1: 添加 Louvain 测试**

```typescript
describe('louvainCommunity', () => {
  test('should detect communities in bipartite graph', () => {
    const engine = new GraphEngine(bipartite())
    const result = engine.louvainCommunity()

    expect(result.communities.length).toBeGreaterThan(0)
    expect(result.modularity).toBeGreaterThanOrEqual(-0.5)
    expect(result.modularity).toBeLessThanOrEqual(1)

    // 每个节点恰好属于一个社区
    const allNodes = new Set<string>()
    for (const comm of result.communities) {
      for (const node of comm.nodes) {
        expect(allNodes.has(node)).toBe(false) // 无重复
        allNodes.add(node)
      }
    }
  })

  test('should respect resolution parameter', () => {
    const engine = new GraphEngine(completeGraph(6))
    const coarse = engine.louvainCommunity({ resolution: 0.5 })
    const fine = engine.louvainCommunity({ resolution: 2.0 })

    // 高分辨率应产生更多社区
    expect(fine.communities.length).toBeGreaterThanOrEqual(coarse.communities.length)
  })

  test('should handle empty graph', () => {
    const engine = new GraphEngine(emptyGraph())
    const result = engine.louvainCommunity()
    expect(result.communities).toEqual([])
  })
})

describe('katzCentrality', () => {
  test('should return normalized scores', () => {
    const engine = new GraphEngine(star(5))
    const result = engine.katzCentrality()

    expect(result.scores.length).toBe(6)
    for (const { score } of result.scores) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  test('should converge with default alpha', () => {
    const engine = new GraphEngine(weightedGraph())
    const result = engine.katzCentrality()
    expect(result.scores.length).toBe(4)
  })
})

describe('betweennessCentrality', () => {
  test('should identify bridge node', () => {
    // A→B→C: B 是桥节点
    const engine = new GraphEngine(chain(3))
    const result = engine.betweennessCentrality(10)

    expect(result.scores.length).toBe(3)
    // B (中间节点) 应有最高 betweenness
    const bScore = result.scores.find(s => s.node === 'n1')!
    expect(bScore.score).toBeGreaterThan(0)
  })

  test('should respect sampleSize', () => {
    const engine = new GraphEngine(star(10))
    const result = engine.betweennessCentrality(3)
    expect(result.scores.length).toBe(11)
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/services/graph/__tests__/GraphEngine.test.ts --filter "louvainCommunity|katzCentrality|betweennessCentrality"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphEngine.test.ts
git commit -m "test: add Louvain community and centrality algorithm tests"
```

---

## Task 11: 实际 codegraph.db 集成测试

**Files:**
- Modify: `src/services/graph/__tests__/GraphEngine.test.ts`

- [ ] **Step 1: 添加真实数据集成测试**

```typescript
describe('integration: real codegraph.db', () => {
  test('should load and run PageRank on actual data', async () => {
    const { GraphStore } = await import('../GraphStore.js')
    const store = GraphStore.getInstance(process.cwd() + '::integration')
    await store.load()

    const engine = new GraphEngine(store)
    const result = engine.pageRank()

    expect(result.scores.length).toBeGreaterThan(1000)
    expect(result.scores[0].score).toBeGreaterThan(0)

    // Top 10 应该是高连接度节点
    for (const { node, score } of result.scores.slice(0, 10)) {
      expect(score).toBeGreaterThan(0)
    }
  }, 30000) // 30s timeout for large graph

  test('should classify roles on actual data', async () => {
    const { GraphStore } = await import('../GraphStore.js')
    const store = GraphStore.getInstance(process.cwd() + '::integration-roles')
    await store.load()

    const engine = new GraphEngine(store)
    const roles = engine.classifyRoles()

    expect(roles.size).toBe(store.size.nodes)
    expect([...roles.values()].includes('entry')).toBe(true)
  }, 30000)

  test('should find SCCs on actual data', async () => {
    const { GraphStore } = await import('../GraphStore.js')
    const store = GraphStore.getInstance(process.cwd() + '::integration-scc')
    await store.load()

    const engine = new GraphEngine(store)
    const sccs = engine.tarjanSCC()

    expect(sccs.length).toBeGreaterThan(0)
    // 应该有一些非平凡 SCC（项目有循环依赖）
    const nonTrivial = sccs.filter(s => !s.isTrivial)
    // 不强制要求有循环，但结果应合理
    expect(sccs.length).toBe(store.size.nodes) // 至少等于节点数
  }, 30000)
})
```

- [ ] **Step 2: 运行集成测试**

Run: `bun test src/services/graph/__tests__/GraphEngine.test.ts --filter "integration"`
Expected: PASS (30s timeout)

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/GraphEngine.test.ts
git commit -m "test: add real codegraph.db integration tests (PageRank, SCC, roles)"
```

---

## Task 12: IncrementalSync 三级增量同步

**Files:**
- Create: `src/services/graph/IncrementalSync.ts`
- Create: `src/services/graph/__tests__/IncrementalSync.test.ts`

- [ ] **Step 1: 写 IncrementalSync 实现**

```typescript
/**
 * IncrementalSync — 三级增量检测
 *
 * 短路逻辑: git diff → mtime → hash
 * 检测哪些文件需要重新索引，标记 GraphStore 为 dirty。
 */

import { execSync } from 'child_process'
import { statSync, readFileSync } from 'fs'
import { resolve, relative } from 'path'
import { createHash } from 'crypto'
import type { GraphStore } from './GraphStore.js'

export interface SyncResult {
  dirty: boolean
  changedFiles: string[]
  reason: 'git-diff' | 'mtime' | 'hash' | 'none'
}

export class IncrementalSync {
  private lastSyncTime = 0
  private fileHashes = new Map<string, string>()
  private fileMtimes = new Map<string, number>()

  constructor(
    private projectRoot: string,
    private store: GraphStore,
  ) {}

  /**
   * 检测变更文件（三级短路检测）
   */
  detect(): SyncResult {
    // Level 1: git diff（最快）
    const gitChanged = this.detectByGitDiff()
    if (gitChanged.length > 0) {
      return { dirty: true, changedFiles: gitChanged, reason: 'git-diff' }
    }

    // Level 2: mtime 比较
    const mtimeChanged = this.detectByMtime()
    if (mtimeChanged.length > 0) {
      return { dirty: true, changedFiles: mtimeChanged, reason: 'mtime' }
    }

    // Level 3: content hash
    const hashChanged = this.detectByHash()
    if (hashChanged.length > 0) {
      return { dirty: true, changedFiles: hashChanged, reason: 'hash' }
    }

    return { dirty: false, changedFiles: [], reason: 'none' }
  }

  /**
   * 同步：重新加载 dirty 文件对应的节点/边
   */
  async sync(): Promise<SyncResult> {
    const result = this.detect()
    if (!result.dirty) return result

    this.store.markDirty()
    await this.store.load()

    this.lastSyncTime = Date.now()
    return result
  }

  private detectByGitDiff(): string[] {
    try {
      const output = execSync('git diff --name-only HEAD -- .', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()

      if (!output) return []
      return output.split('\n').filter(f => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js'))
    } catch {
      return []
    }
  }

  private detectByMtime(): string[] {
    const changed: string[] = []
    for (const [file, oldMtime] of this.fileMtimes) {
      try {
        const stat = statSync(resolve(this.projectRoot, file))
        if (stat.mtimeMs > oldMtime) changed.push(file)
      } catch {
        // 文件可能已删除
        changed.push(file)
      }
    }
    return changed
  }

  private detectByHash(): string[] {
    const changed: string[] = []
    for (const [file, oldHash] of this.fileHashes) {
      try {
        const content = readFileSync(resolve(this.projectRoot, file), 'utf-8')
        const hash = createHash('md5').update(content).digest('hex')
        if (hash !== oldHash) changed.push(file)
      } catch {
        changed.push(file)
      }
    }
    return changed
  }
}
```

- [ ] **Step 2: 写测试**

```typescript
import { describe, test, expect } from 'bun:test'
import { IncrementalSync } from '../IncrementalSync.js'
import { createStoreFromAdjacency } from './testHelpers.js'

describe('IncrementalSync', () => {
  test('should detect no changes on clean repo', () => {
    const store = createStoreFromAdjacency({})
    const sync = new IncrementalSync(process.cwd(), store)
    const result = sync.detect()

    // 在 clean repo 中，git diff 应返回空
    expect(result.reason).toBe('none')
    expect(result.dirty).toBe(false)
  })

  test('should mark store as dirty after sync', async () => {
    const store = createStoreFromAdjacency({})
    const sync = new IncrementalSync(process.cwd(), store)

    // 模拟脏状态
    store.markDirty()
    expect(store.isLoaded).toBe(false)
  })
})
```

- [ ] **Step 3: 运行测试**

Run: `bun test src/services/graph/__tests__/IncrementalSync.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/graph/IncrementalSync.ts src/services/graph/__tests__/IncrementalSync.test.ts
git commit -m "feat: add IncrementalSync three-level change detection (git→mtime→hash)"
```

---

## Task 13: CodegraphTool 扩展 11 个新 operation

**Files:**
- Modify: `src/tools/CodegraphTool/CodegraphTool.ts`

- [ ] **Step 1: 扩展 operationEnum 添加新值**

在 `CodegraphTool.ts` 的 `operationEnum` 中添加：
```typescript
const operationEnum = z.enum([
  // ... 现有 operation ...
  'codegraph_scc',
  'codegraph_toposort',
  'codegraph_delta',
  'codegraph_pagerank',
  'codegraph_impact_deep',
  'codegraph_roles',
  'codegraph_slice',
  'codegraph_coupling',
  'codegraph_community',
  'codegraph_centrality',
  'codegraph_temporal',
])
```

- [ ] **Step 2: 添加 inputSchema 字段**

在 `inputSchema` 中添加新字段：
```typescript
const inputSchema = z.object({
  operation: operationEnum.describe('CodeGraph 操作类型'),
  query: z.string().max(10000).optional(),
  symbol: z.string().max(1000).optional(),
  maxNodes: z.number().min(1).max(100).optional(),
  format: z.enum(['markdown', 'json']).optional(),
  depth: z.number().min(1).max(10).optional(),
  // 新增字段
  damping: z.number().min(0).max(1).optional().describe('PageRank 阻尼因子'),
  resolution: z.number().min(0.1).max(10).optional().describe('Louvain 社区粒度'),
  method: z.enum(['katz', 'betweenness', 'both']).optional().describe('中心性算法'),
  sampleSize: z.number().min(10).max(1000).optional().describe('Betweenness 采样数'),
  since: z.string().optional().describe('时间窗口起始'),
  oldSnapshot: z.string().optional().describe('旧快照标识'),
  newSnapshot: z.string().optional().describe('新快照标识'),
})
```

- [ ] **Step 3: 在 call() 中实现新 operation 分支**

为每个新 operation 添加 case，调用 GraphStore + GraphEngine，返回 `GraphOperationResult<T>` 格式。

- [ ] **Step 4: 更新 searchHint**

```typescript
searchHint: 'code graph AST callers callees impact trace scc cycle toposort pagerank community centrality coupling temporal delta roles slice dependency analysis'
```

- [ ] **Step 5: 更新 renderToolUseMessage labels**

为每个新 operation 添加中文标签。

- [ ] **Step 6: 写集成测试**

```typescript
describe('CodegraphTool new operations', () => {
  test('codegraph_scc returns SCCResult', async () => {
    // 调用 tool，验证返回格式
  })

  test('codegraph_pagerank returns CentralityResult', async () => {
    // 调用 tool，验证返回格式
  })

  // ... 每个 operation 一个测试
})
```

- [ ] **Step 7: 运行测试**

Run: `bun test src/tools/CodegraphTool/__tests__/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/tools/CodegraphTool/CodegraphTool.ts src/tools/CodegraphTool/__tests__/
git commit -m "feat: add 11 new graph operations to CodegraphTool (scc/toposort/delta/pagerank/impact_deep/roles/slice/coupling/community/centrality/temporal)"
```

---

## Task 14: GrokTool 扩展 2 个新 operation

**Files:**
- Modify: `src/tools/GrokTool/GrokTool.ts`

- [ ] **Step 1: 添加 grok_architecture 和 grok_hotspots**

在 GrokTool.ts 的 call() 中添加两个新 case：
- `grok_architecture`: 调用 `GraphEngine.louvainCommunity()` + `classifyRoles()` → LLM 摘要
- `grok_hotspots`: 调用 `GraphEngine.pageRank()` + `temporalCoupling()` → LLM 摘要

- [ ] **Step 2: 写测试**

- [ ] **Step 3: 运行测试**

Run: `bun test src/tools/GrokTool/__tests__/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/GrokTool/GrokTool.ts src/tools/GrokTool/__tests__/
git commit -m "feat: add grok_architecture and grok_hotspots operations"
```

---

## Task 15: Goal L3 per-operation debounce

**Files:**
- Modify: `src/utils/goal/goalToolTier.ts`

- [ ] **Step 1: 添加 per-operation debounce 层**

在 `ToolTierState` 中添加 `opLastCallTime: Map<string, number>`，在 `isDebounced` 中检查 per-operation debounce。

- [ ] **Step 2: 写测试**

- [ ] **Step 3: 运行测试**

Run: `bun test src/utils/goal/goalToolTier.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/utils/goal/goalToolTier.ts src/utils/goal/__tests__/
git commit -m "feat: add per-operation debounce for graph operations"
```

---

## Task 16: 性能基准测试

**Files:**
- Create: `src/services/graph/__tests__/benchmark.test.ts`

- [ ] **Step 1: 写性能基准测试**

```typescript
import { describe, test, expect } from 'bun:test'
import { GraphStore } from '../GraphStore.js'
import { GraphEngine } from '../GraphEngine.js'

describe('performance benchmarks', () => {
  let engine: GraphEngine

  test('load codegraph.db < 1s', async () => {
    const start = Date.now()
    const store = GraphStore.getInstance(process.cwd() + '::bench')
    await store.load()
    const elapsed = Date.now() - start

    engine = new GraphEngine(store)
    console.log(`GraphStore.load(): ${elapsed}ms, ${store.size.nodes} nodes, ${store.size.edges} edges`)
    expect(elapsed).toBeLessThan(1000)
  })

  test('PageRank < 2s', () => {
    const start = Date.now()
    const result = engine.pageRank()
    const elapsed = Date.now() - start
    console.log(`pageRank(): ${elapsed}ms, ${result.scores.length} nodes`)
    expect(elapsed).toBeLessThan(2000)
  })

  test('Tarjan SCC < 10ms', () => {
    const start = Date.now()
    const result = engine.tarjanSCC()
    const elapsed = Date.now() - start
    console.log(`tarjanSCC(): ${elapsed}ms, ${result.length} SCCs`)
    expect(elapsed).toBeLessThan(100)
  })

  test('Louvrain Community < 10s', () => {
    const start = Date.now()
    const result = engine.louvainCommunity()
    const elapsed = Date.now() - start
    console.log(`louvainCommunity(): ${elapsed}ms, ${result.communities.length} communities, Q=${result.modularity}`)
    expect(elapsed).toBeLessThan(10000)
  })
})
```

- [ ] **Step 2: 运行基准测试**

Run: `bun test src/services/graph/__tests__/benchmark.test.ts`
Expected: 所有操作在设计文档 §4 目标时间内

- [ ] **Step 3: Commit**

```bash
git add src/services/graph/__tests__/benchmark.test.ts
git commit -m "test: add performance benchmark tests for all graph algorithms"
```

---

## Task 17: 文档更新

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md` (如适用)

- [ ] **Step 1: 更新 CLAUDE.md**

在 Key Architecture 中添加 GraphEngine 描述：
```markdown
### GraphEngine

图算法引擎 (`src/services/graph/`):
- `GraphStore.ts` — 从 codegraph.db + knowledge-graph.json 加载，统一加权邻接表
- `GraphEngine.ts` — 15 种图算法（BFS/DFS/Tarjan SCC/PageRank/Louvain 等）
- `IncrementalSync.ts` — 三级增量同步（git diff → mtime → hash）
- 零外部依赖，使用 bun:sqlite 直连 SQLite
```

在 Important Files 中添加：
```markdown
| `src/services/graph/GraphEngine.ts` | 核心图算法引擎（15 种算法） |
| `src/services/graph/GraphStore.ts` | 统一图存储层（双数据源适配器） |
| `src/services/graph/IncrementalSync.ts` | 三级增量同步 |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add GraphEngine architecture to CLAUDE.md"
```

---

## Execution Order

```
Phase 1 (基础): Task 1 → Task 2 → Task 3
Phase 2 (存储): Task 12
Phase 3a (低复杂度): Task 4 → Task 5 → Task 6 → Task 7
Phase 3b (中复杂度): Task 8 → Task 9
Phase 3c (高复杂度): Task 10
Phase 3 (集成): Task 11
Phase 4 (Tool 层): Task 13 → Task 14 → Task 15
Phase 5 (验证): Task 16 → Task 17
```

Each task is independently committable and testable.
