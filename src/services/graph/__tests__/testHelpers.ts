/**
 * Graph Test Factory — 生成标准图拓扑用于测试
 *
 * 提供 11 个工厂函数，覆盖 DAG、环、SCC、星型、链、
 * 加权图、空图、完全图、二分图等常见拓扑。
 *
 * 用法:
 *   const { store, engine } = dag()
 *   const result = engine.tarjanSCC()
 */

import { GraphStore, type EdgeMeta, type NodeMetadata } from '../GraphStore.js'
import { GraphEngine } from '../GraphEngine.js'

// ============================================================
// Types
// ============================================================

type EdgeInput = string | { to: string; type?: EdgeMeta['type']; weight?: number }

/** 邻接表输入: nodeId → [target | { to, type?, weight? }] */
type AdjacencyInput = Record<string, EdgeInput[]>

/** 工厂返回值: 同时提供 store 和 engine */
export interface GraphFixture {
  store: GraphStore
  engine: GraphEngine
}

// ============================================================
// Core factory: createStoreFromAdjacency
// ============================================================

/**
 * 从邻接表描述创建 in-memory GraphStore（绕过 load()）
 *
 * @param adj - 邻接表: nodeId → [target | { to, type?, weight? }]
 * @param uniqueKey - 可选的单例 key（避免缓存冲突）
 */
export function createStoreFromAdjacency(
  adj: AdjacencyInput,
  uniqueKey?: string,
): GraphStore {
  const key = uniqueKey ?? `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const store = GraphStore.getInstance(key)
  const anyStore = store as any

  // 注入节点元数据
  const allNodeIds = collectNodeIds(adj)
  for (const id of allNodeIds) {
    store.nodeMeta.set(id, makeNodeMeta(id))
  }

  // 注入边（正向 + 反向）
  for (const [from, edges] of Object.entries(adj)) {
    for (const edge of edges) {
      const to = typeof edge === 'string' ? edge : edge.to
      const type: EdgeMeta['type'] = typeof edge === 'string' ? 'calls' : (edge.type ?? 'calls')
      const weight = typeof edge === 'string' ? 1 : (edge.weight ?? 1)

      // 确保 target 节点也有元数据
      if (!store.nodeMeta.has(to)) {
        store.nodeMeta.set(to, makeNodeMeta(to))
      }

      // 正向边
      let fromMap = store.adjacency.get(from)
      if (!fromMap) {
        fromMap = new Map()
        store.adjacency.set(from, fromMap)
      }
      fromMap.set(to, { type, weight })

      // 反向边
      let toReverse = store.reverse.get(to)
      if (!toReverse) {
        toReverse = new Map()
        store.reverse.set(to, toReverse)
      }
      toReverse.set(from, { type, weight })
    }
  }

  // 标记已加载（绕过 load() 的惰性检查）
  anyStore.loaded = true

  return store
}

/**
 * 从邻接表创建 GraphFixture（store + engine）
 */
export function createFixture(adj: AdjacencyInput, uniqueKey?: string): GraphFixture {
  const store = createStoreFromAdjacency(adj, uniqueKey)
  const engine = new GraphEngine(store)
  return { store, engine }
}

// ============================================================
// Topology factories
// ============================================================

/**
 * DAG: A → B → C, A → D → C
 *
 *   A ─→ B ─→ C
 *   └──→ D ─↗
 */
export function dag(): GraphFixture {
  return createFixture({
    A: ['B', 'D'],
    B: ['C'],
    D: ['C'],
  })
}

/**
 * Cycle: A → B → C → A
 *
 *   A → B → C
 *   ↑       │
 *   └───────┘
 */
export function cycle(): GraphFixture {
  return createFixture({
    A: ['B'],
    B: ['C'],
    C: ['A'],
  })
}

/**
 * DAG with cycle: A → B → C → A, A → D
 *
 *   A → B → C
 *   ↑       │
 *   └───────┘
 *   A → D
 */
export function dagWithCycle(): GraphFixture {
  return createFixture({
    A: ['B', 'D'],
    B: ['C'],
    C: ['A'],
  })
}

/**
 * Multiple SCCs:
 *   SCC1: A → B → C → A
 *   SCC2: D → E → D
 *   F: isolated
 */
export function multiSCC(): GraphFixture {
  return createFixture({
    A: ['B'],
    B: ['C'],
    C: ['A'],
    D: ['E'],
    E: ['D'],
    F: [],
  })
}

/**
 * Star: center → leaf1 .. leafN
 *
 *       center
 *      / | \  \
 *    l1  l2  l3 ... lN
 */
export function star(n: number): GraphFixture {
  const adj: AdjacencyInput = { center: [] }
  for (let i = 0; i < n; i++) {
    adj.center.push(`leaf${i}`)
    adj[`leaf${i}`] = []
  }
  return createFixture(adj)
}

/**
 * Chain: 0 → 1 → 2 → ... → N
 */
export function chain(n: number): GraphFixture {
  const adj: AdjacencyInput = {}
  for (let i = 0; i < n; i++) {
    adj[`n${i}`] = i < n - 1 ? [`n${i + 1}`] : []
  }
  return createFixture(adj)
}

/**
 * Weighted graph with different edge types and weights:
 *
 *   A ─calls(w:3)──→ B
 *   A ─data(w:1)───→ C
 *   B ─imports(w:2)→ C
 *   C ─control(w:1)→ D
 *   D ─inherits(w:5)→ E
 */
export function weightedGraph(): GraphFixture {
  const store = createStoreFromAdjacency({
    A: [
      { to: 'B', type: 'calls', weight: 3 },
      { to: 'C', type: 'data', weight: 1 },
    ],
    B: [
      { to: 'C', type: 'imports', weight: 2 },
    ],
    C: [
      { to: 'D', type: 'control', weight: 1 },
    ],
    D: [
      { to: 'E', type: 'inherits', weight: 5 },
    ],
    E: [],
  })
  const engine = new GraphEngine(store)
  return { store, engine }
}

/**
 * Empty graph: no nodes, no edges
 */
export function emptyGraph(): GraphFixture {
  return createFixture({})
}

/**
 * Complete graph K_n: every node has an edge to every other node
 */
export function completeGraph(n: number): GraphFixture {
  const adj: AdjacencyInput = {}
  for (let i = 0; i < n; i++) {
    const edges: string[] = []
    for (let j = 0; j < n; j++) {
      if (i !== j) edges.push(`n${j}`)
    }
    adj[`n${i}`] = edges
  }
  return createFixture(adj)
}

/**
 * Bipartite graph: left nodes → right nodes, no edges within each set
 *
 *   L0 ─→ R0
 *   L0 ─→ R1
 *   L1 ─→ R1
 *   L1 ─→ R2
 */
export function bipartite(): GraphFixture {
  return createFixture({
    L0: ['R0', 'R1'],
    L1: ['R1', 'R2'],
    L2: ['R2', 'R0'],
    R0: [],
    R1: [],
    R2: [],
  })
}

// ============================================================
// Helpers
// ============================================================

/** 收集邻接表中所有出现过的节点 ID */
function collectNodeIds(adj: AdjacencyInput): Set<string> {
  const ids = new Set<string>()
  for (const [from, edges] of Object.entries(adj)) {
    ids.add(from)
    for (const edge of edges) {
      ids.add(typeof edge === 'string' ? edge : edge.to)
    }
  }
  return ids
}

/** 为节点生成最小 NodeMetadata */
function makeNodeMeta(id: string): NodeMetadata {
  return {
    id,
    name: id,
    kind: 'function',
    file: `/test/${id.toLowerCase()}.ts`,
    line: 1,
  }
}
