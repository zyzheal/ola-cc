# CodeGraph + Grok 图算法增强设计

> 日期: 2026-06-05
> 状态: Draft (v5 — 第四轮评审修复版)
> 范围: GraphEngine 图算法引擎 + 双引擎增强
> 评审: 架构师(3P0/5P1/5P2) + 算法专家(5P0/5P1/5P2) + 领域架构师(2P0/3P1/3P2)

## 1. 背景与目标

### 1.1 现状

CodeGraph（实时 AST 查询）和 Grok（离线知识图谱）已实现基础代码理解能力，但缺乏：
- 深度图分析算法（切片、SCC、社区检测）
- 跨文件影响传播分析
- 架构级洞察（模块边界、耦合度量）

### 1.2 目标

构建 TS 内置图算法引擎 `GraphEngine`，零外部依赖，对标 2024-2026 业界最优方案：

| 来源 | 借鉴模式 |
|------|---------|
| Joern CPG | AST+CFG+PDG 联合图 |
| IntelliJ | 增量解析 + 按需分析 |
| Sourcegraph SCIP | 符号全局唯一标识 |
| codebase-memory-mcp | SQLite + BM25 + 社区检测 |
| ops-codegraph | 三级增量检测 + 角色分类 |

## 2. 架构设计

### 2.1 模块结构

```
src/services/graph/                  # 共享基础设施（避免跨 tool 循环依赖）
├── GraphEngine.ts                   # 核心图算法引擎
├── GraphStore.ts                    # 图存储层（内存/SQLite）
├── IncrementalSync.ts               # 三级增量同步
└── __tests__/
    ├── GraphEngine.test.ts
    ├── GraphStore.test.ts
    └── IncrementalSync.test.ts

src/tools/CodegraphTool/
├── CodegraphTool.ts                 # 现有 tool（扩展 operation）
├── CodegraphManager.ts              # 现有 CLI 管理器
└── __tests__/

src/tools/GrokTool/
├── GrokTool.ts                      # 现有 tool（扩展 operation）
├── GrokManager.ts                   # 现有管理器（调用 GraphEngine）
└── __tests__/
```

**设计决策**: GraphEngine 放在 `src/services/graph/` 而非 tool 目录下，避免 Grok→CodegraphTool 循环依赖。两个 tool 正向依赖共享服务层。

### 2.2 数据流

```
┌─────────────────────────────────────────────────────────────┐
│                    数据源（外部索引）                          │
│  codegraph CLI → .codegraph/codegraph.db (SQLite)           │
│  Grok pipeline → .understand-anything/knowledge-graph.json  │
└───────────────────────┬─────────────────────────────────────┘
                        │ GraphStore.load() 数据适配器
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    GraphStore（统一图表示）                    │
│  adjacency: Map<string, Map<string, EdgeMeta>>              │
│  reverse:   Map<string, Map<string, EdgeMeta>>              │
│  nodeMeta:  Map<string, NodeMetadata>                       │
│                                                              │
│  EdgeMeta = { type: 'calls'|'imports'|'data'|'control'|     │
│               'inherits'|'implements', weight: number }      │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    GraphEngine（算法层）                      │
│  bfs/dfs, tarjanSCC, dominatorTree, pageRank, ...           │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────┴─────────────────────────────────────┐
│  CodegraphTool (operation)     │  GrokManager (LLM 摘要)     │
│  codegraph_scc, _slice, ...    │  grok_architecture, ...     │
│  返回结构化 JSON               │  调用 GraphEngine + LLM     │
└────────────────────────────────┘─────────────────────────────┘
```

**GraphStore 数据适配器**: `load()` 接受两个数据源：
- `.codegraph/codegraph.db` — 通过 `bun:sqlite` 读取 codegraph CLI 的索引
- `.understand-anything/knowledge-graph.json` — 直接解析 JSON

**字段映射规则**:

| 内部字段 | codegraph.db (SQLite) | knowledge-graph.json |
|---------|----------------------|---------------------|
| `nodeMeta.id` | `symbols.qualified_name` | `nodes[].id` |
| `nodeMeta.name` | `symbols.name` | `nodes[].name` |
| `nodeMeta.kind` | `symbols.kind` (function/class/variable/module) | `nodes[].kind` |
| `nodeMeta.file` | `symbols.file_path` | `nodes[].file` |
| `nodeMeta.line` | `symbols.start_line` | `nodes[].line` |
| `nodeMeta.signature` | `symbols.signature` | `nodes[].signature` |
| `nodeMeta.layer` | — (无) | `nodes[].layer`（顶层字段，非 metadata 嵌套） |
| `nodeMeta.domain` | — (无) | `nodes[].domain`（顶层字段，非 metadata 嵌套） |
| `edge.type` | `edges.kind` (call/import/data_flow) | `edges[].type` |
| `edge.weight` | `edges.weight` (默认 1) | — (无 weight 字段，默认 1) |
| `adjacency[from][to]` | 从 `edges` 表构建 | 从 `edges[]` 数组构建 |
| `reverse[to][from]` | 同上，反向索引 | 同上，反向索引 |

**类型映射**: codegraph.db 的 `call`→`calls`, `import`→`imports`, `data_flow`→`data`, `inherit`→`inherits`, `implement`→`implements`。Grok 的 `depends`→`imports`, `relates`→`control`。未知类型映射为 `control`。

**双数据源合并策略**:

当两个数据源同时存在时，GraphStore.load() 按以下规则合并：

1. **符号身份匹配**: codegraph 使用 `qualified_name`（如 `src/auth.ts:AuthService.login`），Grok 使用 `file:name`（如 `src/auth.ts:login`）。匹配规则：以 `file + name` 做二级索引，Grok 的 `file:name` 解析为 `{file, name}` 后与 codegraph 的 `{file_path, name}` 比较。
   **消歧规则**: 当 Grok 的 `file:name` 匹配到多个 codegraph 符号时：(a) 优先选择 kind 相同的；(b) 仍有多候选时，选择 name 最短的（精确匹配）。具体匹配策略取决于 Phase 0 验证 codegraph symbols 表的 `name` 列格式。
2. **属性合并优先级**: codegraph.db 提供精确的 AST 级数据（signature、line），Grok JSON 提供语义层数据（layer、domain、summary）。合并时：AST 字段以 codegraph 为准，语义字段以 Grok 为准。
3. **边去重**: 同一对节点的同类型边去重（以 `{from, to, type}` 三元组为 key）。不同类型边保留（如 codegraph 的 `calls` + Grok 的 `depends` 同时存在）。
4. **单一数据源**: 当仅一个数据源存在时，直接加载，不做合并。

**数据源缺失处理**: 见 Section 9（错误处理）。

### 2.3 图数据结构

```typescript
// 评审修复：邻接表扩展为加权+类型化，兼容所有算法
interface EdgeMeta {
  type: 'calls' | 'imports' | 'data' | 'control' | 'inherits' | 'implements' | 'relates' | 'depends'
  weight: number  // 调用频率/依赖强度，默认 1
}

// 适配器映射规则：Grok 的 'depends'→'imports', 'relates'→'control'
// codegraph 的 'call'→'calls', 'import'→'imports', 'data_flow'→'data'
// 未知类型默认映射为 'control'

interface NodeMetadata {
  id: string
  name: string
  kind: string      // 'function'|'class'|'variable'|'module'|'file'|'symbol' 等，宽松类型兼容 LLM 输出
  file: string
  line: number
  signature?: string
  layer?: string    // Grok 专有：架构层（顶层字段）
  domain?: string   // Grok 专有：业务域（顶层字段）
}

// 适配器规范化：LLM 输出的 kind 值（interface/type/enum 等）保留原样
// role 分类等算法通过 kind 前缀匹配而非严格枚举
```

### 2.4 GraphEngine API

```typescript
export class GraphEngine {
  private adjacency: Map<string, Map<string, EdgeMeta>>  // 正向加权邻接
  private reverse: Map<string, Map<string, EdgeMeta>>    // 反向加权邻接
  private nodeMeta: Map<string, NodeMetadata>

  // ── 基础遍历 ──
  bfs(start: string, maxDepth?: number): TraversalResult
  dfs(start: string, maxDepth?: number): TraversalResult

  // ── Phase 3a: 低复杂度 + 高价值 ──
  backwardReachability(nodeId: string): ReachabilityResult  // 反向可达性 (O(V+E))
  tarjanSCC(): SCCResult[]                                  // Tarjan SCC (O(V+E))
  // 显式栈迭代版，关键状态机见下方伪代码
  topologicalSort(): TopoResult                             // 拓扑排序，有环返回 SCC (O(V+E))
  pageRank(damping?: number, maxIter?: number): CentralityResult  // PageRank (O(k·E))
  // 收敛度量: L1 范数（业界标准），epsilon=1e-6
  // 悬挂节点（出度=0）: 概率质量均匀分配给所有节点
  // 公式: PR_new[v] = (1-d)/N + d * (Σ PR[u]/outDeg(u) + danglingSum/N)
  //   其中 danglingSum = Σ PR[d] for d where outDeg(d)==0
  dominatorTree(root: string): Map<string, string | null>   // 支配树 (O(V+E))
  deltaGraph(old: GraphSnapshot, curr: GraphSnapshot): DeltaResult  // 差分图 (O(V+E))
  // 注意：GraphSnapshot 获取机制需 Phase 0 验证 codegraph CLI 是否支持历史索引
  // 若不支持，降级为基于 IncrementalSync 的增量 diff（对比 dirty 文件对应的节点/边）

  // ── Phase 3b: 中复杂度 + 核心场景 ──
  classifyRoles(opts?: RoleOpts): Map<string, RoleType>   // 角色分类 (O(V+E))
  backwardDataSlice(nodeId: string): SliceResult          // 数据依赖切片 (O(V+E))
  // DDG 来源: codegraph.db 的 data_flow 边（Phase 0 验证）
  // 降级策略: 若 DDG 不可用，退化为 backwardReachability（调用图近似切片）
  couplingMetrics(): MetricsResult                        // 内聚/耦合度量 (O(V+E))

  // ── Phase 3c: 高复杂度 + 增值功能 ──
  katzCentrality(opts?: KatzOpts): CentralityResult       // Katz 中心性 (O(k·E))
  betweennessCentrality(sampleSize?: number): CentralityResult  // 近似 Betweenness (O(k·E))
  louvainCommunity(opts?: LouvainOpts): CommunityResult   // Louvain 社区检测 (O(V·logV))
  // 收敛条件: 内层 — 本轮无节点移动 或 delta Q < epsilon
  //          外层 — modularity 增益 < epsilon 或 达到 maxLevels
  temporalCoupling(opts?: TemporalOpts): CouplingResult   // 时间耦合 (O(C·F²))
  // 性能约束: maxCommits=50000, maxFiles=500, 6个月窗口
  // 增量缓存: .codegraph/temporal-cache.json 持久化已解析 commit→files 映射
  // git log 命令: --name-status -M（含重命名检测）--no-merges
}

type RoleType = 'entry' | 'core' | 'utility' | 'adaptor' | 'dead' | 'leaf'

// 分类规则（按优先级排序，先匹配者胜）:
// 1. dead:   从所有 entry 点反向 BFS 不可达
// 2. entry:  fanIn = 0 且 fanOut > 0（无被调用，只调用别人）
// 3. leaf:   fanOut = 0 且 fanIn > 0（只被调用，不调用别人）
// 4. adaptor: 跨模块边占比 > 50%（桥接两个模块）
// 5. core:   PageRank 排名前 20% 且 fanIn > median
// 6. utility: fanIn > P75 且 fanOut < P25（被大量调用但不调用别人）
// 冲突优先级: dead > entry > leaf > adaptor > core > utility

interface RoleOpts {
  corePercentile?: number     // core 的 PageRank 百分位阈值，默认 0.8
  utilityFanInPercentile?: number  // utility 的 fanIn 百分位，默认 0.75
  adaptorCrossModuleRatio?: number // adaptor 的跨模块边占比，默认 0.5
}

// 评审修复：统一返回结构
interface GraphOperationResult<T> {
  _summary: string              // 一句话摘要（LLM 友好）
  _nextSteps?: string[]         // 建议的下一步操作
  data: T
  metadata: { nodeCount: number; edgeCount?: number; truncated: boolean }
}

// ── 返回类型定义 ──

interface TraversalResult {
  nodes: string[]               // 访问顺序
  edges: Array<{ from: string; to: string }>
  depth: Map<string, number>    // 节点→深度
}

interface ReachabilityResult {
  reachable: string[]           // 可达节点集
  via: Map<string, string[]>    // 节点→到达路径（中间节点）
}

interface SCCResult {
  id: number
  nodes: string[]
  size: number
  isTrivial: boolean   // size=1 时为 true（不在任何环中）
}

interface TopoResult {
  order: string[]               // 拓扑序（SCC 缩为超级节点 "SCC:Name"）
  cycles?: SCCResult[]          // 有环时附带 SCC
}

interface CentralityResult {
  scores: Array<{ node: string; score: number }>  // 按分值降序，归一化 0-1
}

interface DeltaResult {
  added: string[]               // 新增节点
  removed: string[]             // 删除节点
  edgeAdded: Array<{ from: string; to: string; type: string }>
  edgeRemoved: Array<{ from: string; to: string; type: string }>
  summary: { nodesDelta: number; edgesDelta: number }
}

interface SliceResult {
  symbols: string[]             // 切片中的符号
  dataFlows: Array<{ from: string; to: string; via: string }>  // 数据流路径
}

interface MetricsResult {
  highCoupling: Array<{ node: string; fanIn: number; fanOut: number; instability: number }>
  lcom: Array<{ class: string; lcom: number; methods: number; fields: number }>
  // LCOM* (Henderson-Sellers) ∈ [0, 2]，0=完全内聚，2=完全无内聚
}

interface CommunityResult {
  communities: Array<{ id: number; nodes: string[]; size: number; label?: string }>
  modularity: number            // Newman 模块度 Q ∈ [-0.5, 1]，实践中 [0.3, 0.7]
  resolution: number
  // label 由上层（CodegraphTool/GrokManager）通过 LLM 生成，GraphEngine 只返回 id+nodes+size
  // 注意: resolution limit — resolution=1.0 时，小于 sqrt(2m) 条边的小社区可能被合并
  // resolution>2.0 可能产生过度碎片化
}

interface CouplingResult {
  pairs: Array<{ a: string; b: string; score: number; coChanges: number }>
  window: { since: string; until: string }
}

interface GraphSnapshot {
  adjacency: Map<string, Map<string, EdgeMeta>>
  nodeMeta: Map<string, NodeMetadata>
  timestamp: number
}

interface KatzOpts {
  alpha?: number                // 衰减因子，默认 0.1
  epsilon?: number              // 收敛阈值，默认 1e-6
  maxIter?: number              // 最大迭代次数，默认 100
}

interface TemporalOpts {
  since?: string                // ISO 日期，默认 6 个月前
  limit?: number                // 最大耦合对数，默认 50
  minCoChanges?: number         // 最小共现次数，默认 3
  maxCommits?: number           // 最大解析 commit 数，默认 50000
}

interface LouvainOpts {
  resolution?: number           // 社区粒度，默认 1.0
  epsilon?: number              // 外层 modularity 增益阈值，默认 1e-6
  maxLevels?: number            // 最大层级数，默认 10
  maxPasses?: number            // 内层最大 pass 数，默认 100
}
```

**Tarjan SCC 显式栈伪代码**（关键状态机）:

```
function tarjanSCC():
  index = 0
  stack = []           // SCC 栈
  callStack = []       // 显式调用栈，每帧: {nodeId, neighbors, neighborIdx, lowlink, onStack}
  result = []

  for each node v:
    if v.index exists: continue
    callStack.push({v, neighbors(v), 0, index, true})
    v.index = index++

    while callStack not empty:
      frame = callStack.peek()
      // 阶段1: 首次访问 — 遍历邻居
      if frame.neighborIdx < frame.neighbors.length:
        w = frame.neighbors[frame.neighborIdx++]
        if w.index not exists:
          callStack.push({w, neighbors(w), 0, index, true})
          w.index = index++
        else if w.onStack:
          frame.lowlink = min(frame.lowlink, w.index)
      // 阶段2: 所有邻居处理完毕 — 回溯
      else:
        if frame.lowlink == frame.node.index:
          scc = []
          do: w = stack.pop(); w.onStack = false; scc.push(w)
          while w != frame.node
          result.push(scc)
        parent = callStack[callStack.length - 2]
        if parent: parent.lowlink = min(parent.lowlink, frame.lowlink)
        callStack.pop()

// 三个关键不变量:
// 1. index[v] 严格单调递增（分配后不变）
// 2. onStack 精确等于当前 DFS 路径上的节点
// 3. lowlink[v] ≤ index[v]，回溯时取 min
```

**评审修复说明**:

| 修复项 | 变更 |
|--------|------|
| P0: 邻接表缺边权重/类型 | 扩展为 `Map<string, Map<string, EdgeMeta>>` |
| P0: BackwardSlice 需 SDG | 重命名为 `backwardReachability`（近似切片），Phase 3b 增加 `backwardDataSlice`（数据依赖切片） |
| P0: Betweenness 100K 超时 | 改为 `betweennessCentrality(sampleSize=200)` 采样近似，O(k·E) ≈ 0.1s，经验精度取决于图拓扑，不保证固定误差率 |
| P0: Katz 缺收敛条件 | 添加 `KatzOpts { alpha, epsilon, maxIter }`，默认 α=0.1, ε=1e-6, maxIter=100 |
| P0: 缺调用图构建说明 | 调用图由 codegraph CLI 预构建，GraphStore.load() 直接加载 |
| P1: 缺 PageRank | 增加 `pageRank()`，比 Katz 更常用（Sourcegraph/Google 均使用） |
| P1: TopSort 未处理有环 | 返回 `TopoResult { order, cycles? }`，有环时附带 SCC |
| P1: Leiden 实现复杂 | 改为 Louvain（功能等价，代码量减半），后续可增量升级 |
| P1: impact_v2 命名 | 重命名为 `codegraph_impact_deep`，原 `codegraph_impact` 保留为快速版 |
| P0: 返回格式未定义 | 定义 `GraphOperationResult<T>` 统一接口 |

## 3. 新增 Tool Operations

### 3.1 CodeGraph 新增操作

| Operation | 描述 | 算法 | Phase |
|-----------|------|------|-------|
| `codegraph_scc` | 强连通分量：发现循环依赖和相互递归 | Tarjan SCC | 3a |
| `codegraph_toposort` | 拓扑排序：依赖加载顺序，有环返回 SCC | TopologicalSort | 3a |
| `codegraph_delta` | 差分图：两次索引之间的结构变化 | DeltaGraph | 3a |
| `codegraph_pagerank` | PageRank 中心性：找出核心节点 | PageRank | 3a |
| `codegraph_impact_deep` | 深度影响分析：基于支配树 + 数据切片 | DominatorTree + DataSlice | 3a |
| `codegraph_roles` | 角色分类：entry/core/utility/adaptor/dead/leaf | Degree + Reachability | 3b |
| `codegraph_slice` | 数据依赖切片：追踪影响某变量的所有数据流 | BackwardDataSlice | 3b |
| `codegraph_coupling` | 耦合度量：扇入扇出、不稳定度、LCOM | CouplingMetrics | 3b |
| `codegraph_community` | 社区检测：自动发现架构模块边界 | Louvain | 3c |
| `codegraph_centrality` | 中心性分析：Katz + Betweenness 近似 | Katz + SampledBetweenness | 3c |
| `codegraph_temporal` | 时间耦合：哪些文件总是同时修改 | TemporalCoupling | 3c |

**评审修复**: `codegraph_impact_v2` → `codegraph_impact_deep`（语义更清晰）。

### 3.2 Grok 新增操作

| Operation | 描述 | 执行路径 |
|-----------|------|---------|
| `grok_architecture` | 架构洞察 | 调用 `GraphEngine.louvainCommunity()` + `classifyRoles()` → LLM 摘要 |
| `grok_hotspots` | 热点分析 | 调用 `GraphEngine.pageRank()` + `temporalCoupling()` → LLM 摘要 |

**评审修复**: Grok 新 operation 明确为"调用 GraphEngine 底层算法 + LLM 语义总结"，不在 Grok 端重复实现图算法。

**实现位置**: `grok_architecture` 和 `grok_hotspots` 在 `GrokTool.ts` 的 `call()` 方法中实现（而非 GrokManager），由 Tool 层加载 GraphStore + GraphEngine 并调用 GrokManager 仅做 LLM 摘要。GrokManager 是 1800+ 行的自包含类，不应引入 GraphEngine 依赖。

**GraphStore 初始化契约**:
- GraphStore 为 per-projectRoot 单例，惰性初始化
- 首次调用 `GraphStore.getInstance(projectRoot)` 时加载数据源
- codegraph.db 访问路径: 若 Phase 0 验证 bun:sqlite 直连可行则直接读取，否则通过 CodegraphManager 新增 `exportGraphJSON()` 方法导出
- 缓存失效: `IncrementalSync` 检测到 dirty 时标记，下次 load() 重新加载
- 线程安全: 同一 projectRoot 的并发调用返回同一实例

### 3.3 输入 Schema 示例

```typescript
// codegraph_scc
const sccSchema = z.object({
  operation: z.literal('codegraph_scc'),
  maxNodes: z.number().min(1).max(100).optional().describe('最大返回 SCC 数（默认 20）'),
})

// codegraph_slice
const sliceSchema = z.object({
  operation: z.literal('codegraph_slice'),
  symbol: z.string().max(1000).describe('目标符号名称'),
  maxNodes: z.number().min(1).max(100).optional().describe('最大返回节点数（默认 20）'),
})

// codegraph_community
const communitySchema = z.object({
  operation: z.literal('codegraph_community'),
  resolution: z.number().min(0.1).max(10).optional().describe('社区粒度（默认 1.0，越大越细）'),
  maxNodes: z.number().min(1).max(100).optional().describe('最大返回社区数（默认 20）'),
})

// codegraph_temporal
const temporalSchema = z.object({
  operation: z.literal('codegraph_temporal'),
  since: z.string().optional().describe('时间窗口起始（ISO 日期，默认 6 个月前）'),
  limit: z.number().min(10).max(5000).optional().describe('最大耦合对数（默认 50）'),
})

// codegraph_toposort
const toposortSchema = z.object({
  operation: z.literal('codegraph_toposort'),
  maxNodes: z.number().min(1).max(200).optional().describe('最大返回节点数（默认 50）'),
})

// codegraph_pagerank
const pagerankSchema = z.object({
  operation: z.literal('codegraph_pagerank'),
  damping: z.number().min(0).max(1).optional().describe('阻尼因子（默认 0.85）'),
  maxNodes: z.number().min(1).max(100).optional().describe('返回 Top N 节点（默认 20）'),
})

// codegraph_impact_deep
const impactDeepSchema = z.object({
  operation: z.literal('codegraph_impact_deep'),
  symbol: z.string().max(1000).describe('目标符号名称'),
  maxNodes: z.number().min(1).max(100).optional().describe('最大返回节点数（默认 20）'),
})

// codegraph_roles
const rolesSchema = z.object({
  operation: z.literal('codegraph_roles'),
  maxNodes: z.number().min(1).max(200).optional().describe('最大返回节点数（默认 50）'),
})

// codegraph_coupling
const couplingSchema = z.object({
  operation: z.literal('codegraph_coupling'),
  maxNodes: z.number().min(1).max(100).optional().describe('最大返回节点数（默认 30）'),
})

// codegraph_delta
const deltaSchema = z.object({
  operation: z.literal('codegraph_delta'),
  oldSnapshot: z.string().describe('旧快照标识（commit hash 或时间戳）'),
  newSnapshot: z.string().optional().describe('新快照标识（默认当前）'),
})

// codegraph_centrality
const centralitySchema = z.object({
  operation: z.literal('codegraph_centrality'),
  method: z.enum(['katz', 'betweenness', 'both']).optional().describe('中心性算法（默认 both）'),
  sampleSize: z.number().min(10).max(1000).optional().describe('Betweenness 采样数（默认 200）'),
  maxNodes: z.number().min(1).max(100).optional().describe('返回 Top N 节点（默认 20）'),
})

// grok_architecture
const grokArchitectureSchema = z.object({
  operation: z.literal('grok_architecture'),
  maxCommunities: z.number().min(1).max(50).optional().describe('最大返回社区数（默认 10）'),
})

// grok_hotspots
const grokHotspotsSchema = z.object({
  operation: z.literal('grok_hotspots'),
  maxNodes: z.number().min(1).max(50).optional().describe('返回 Top N 热点（默认 10）'),
  since: z.string().optional().describe('时间窗口起始（ISO 日期，默认 6 个月前）'),
})
```

### 3.4 返回格式示例

```typescript
// codegraph_scc 返回
{
  _summary: "发现 3 个强连通分量，最大 SCC 包含 12 个节点（AuthService→TokenManager→...）",
  _nextSteps: ["codegraph_impact_deep(AuthService)", "codegraph_coupling"],
  data: {
    sccs: [
      { id: 0, nodes: ["AuthService", "TokenManager", "SessionStore"], size: 3 },
      { id: 1, nodes: ["DBPool", "QueryBuilder", "Migration", ...], size: 12 }
    ]
  },
  metadata: { nodeCount: 156, edgeCount: 420, truncated: false }
}

// codegraph_toposort 返回（有环时）
{
  _summary: "拓扑排序完成，发现 2 个循环依赖已合并为超级节点",
  _nextSteps: ["codegraph_scc"],
  data: {
    order: ["Logger", "Config", "DBPool", "SCC:AuthModule", "APIRouter"],
    cycles: [
      { nodes: ["AuthService", "TokenManager", "SessionStore"] }
    ]
  },
  metadata: { nodeCount: 45, truncated: false }
}

// codegraph_pagerank 返回
{
  _summary: "Top 3 核心节点：AuthMiddleware(0.18), Router(0.15), DBPool(0.12)",
  _nextSteps: ["codegraph_impact_deep(AuthMiddleware)", "codegraph_coupling"],
  data: {
    scores: [
      { node: "AuthMiddleware", score: 0.18 },
      { node: "Router", score: 0.15 },
      { node: "DBPool", score: 0.12 }
    ]
  },
  metadata: { nodeCount: 156, truncated: false }
}

// codegraph_coupling 返回
{
  _summary: "高耦合模块：AuthService↔TokenManager (不稳定度 0.89)，建议解耦",
  _nextSteps: ["codegraph_scc", "codegraph_community"],
  data: {
    highCoupling: [
      { node: "AuthService", fanIn: 12, fanOut: 8, instability: 0.40 },
      { node: "TokenManager", fanIn: 3, fanOut: 15, instability: 0.83 }
    ],
    lcom: [
      { class: "UserService", lcom: 0.72, methods: 18, fields: 12 }
    ]
  },
  metadata: { nodeCount: 156, truncated: false }
}

// codegraph_community 返回
{
  _summary: "发现 5 个社区，模块度 Q=0.72，最大社区包含 34 个节点（认证模块）",
  _nextSteps: ["codegraph_roles", "codegraph_coupling"],
  data: {
    communities: [
      { id: 0, nodes: ["AuthService", "TokenManager", ...], size: 34, label: "认证模块" },
      { id: 1, nodes: ["DBPool", "QueryBuilder", ...], size: 22, label: "数据层" }
    ],
    modularity: 0.72
  },
  metadata: { nodeCount: 156, truncated: false }
}
```

## 4. 性能目标（修正版）

| 指标 | 目标 | 备注 |
|------|------|------|
| 查询类 (bfs/dfs/search/scc/toposort/delta) | <10ms | O(V+E)，遍历类 |
| 分析类 (pagerank/katz/coupling/roles) | <2s | O(k·E) 或 O(V+E) |
| 深度分析类 (betweenness/louvain/temporal) | <10s | 采样近似 + 超时保护 |
| 全量索引 (100K LOC) | <30s | 由 codegraph CLI 处理 |
| 增量更新 | <500ms (单文件) | 三级检测 |
| 内存占用 | <200MB (100K 节点) | 加权邻接表 |

**评审修复**: 区分查询类/分析类/深度分析类，不再统一 <10ms。深度分析类增加进度回调和 30s 超时保护。

## 5. 双层 Agent 路由

### 5.1 Goal 系统 L3 主动调用

在 `src/utils/goal/goalToolTier.ts` 中扩展：

```typescript
// 自动触发规则
const GRAPH_AUTO_TRIGGERS = {
  codegraph_slice:       { when: '修改函数签名/接口', debounce: '30s' },
  codegraph_scc:         { when: '检测到循环依赖', debounce: '60s' },
  codegraph_community:   { when: '任务涉及多模块', debounce: '120s' },
  codegraph_impact_deep: { when: '大规模重构', debounce: '30s' },
  codegraph_roles:       { when: '架构审查', debounce: '120s' },
}
```

**评审修复**: debounce 从 per-tool 改为 per-operation，`ToolTierState.lastCallTime` 的 key 从 tool name 改为 `tool:operation`。

**迁移策略**: 保持现有 per-tool debounce 不变，新增 per-operation debounce 作为独立层：
- `isOpDebounced(state, "codegraph:codegraph_scc")` 使用独立的 `Map<string, number>`
- 现有 `isDebounced(state, "codegraph")` 逻辑不受影响
- `CODEGRAPH_MAX_CALLS` 保持 per-tool 上限（2），新 operation 共享此配额

### 5.2 System Prompt 指导

```
当需要理解代码结构时：
- 简单查找 → codegraph_search / Grep
- 调用链 → codegraph_callers / codegraph_callees
- 影响范围 → codegraph_impact（快速）/ codegraph_impact_deep（精确，含数据流）
- 核心节点 → codegraph_pagerank（找出最核心的函数/类）
- 架构理解 → codegraph_community + codegraph_roles
- 循环依赖 → codegraph_scc
- 修改影响 → codegraph_slice + codegraph_delta
- 依赖顺序 → codegraph_toposort
- 耦合度量 → codegraph_coupling
- 文件共现 → codegraph_temporal（哪些文件总是同时修改）
- 测试优先级 → codegraph_pagerank（高 PageRank 值的节点优先测试）
- 死代码清理 → codegraph_roles（dead 分类）确认后删除
```

**searchHint 更新**（Phase 4）:
- codegraph: `'code graph AST callers callees impact trace scc cycle toposort pagerank community centrality coupling temporal delta roles slice dependency analysis'`
- grok: `'knowledge graph code understanding semantic analysis architecture hotspots community roles'`

## 6. 实施计划（修正版）

### Phase 0: 数据源验证 (1 天)
- [ ] `sqlite3 .codegraph/codegraph.db ".schema"` — 验证实际表结构（symbols/edges 表列名）
- [ ] `bun:sqlite` compile 模式兼容性测试 + WAL 锁并发读写测试
- [ ] codegraph CLI 是否提供 `--dump-json` / `export` 子命令（避免直连 SQLite）
- [ ] `knowledge-graph.json` 结构确认: 验证 domain 字段是否有实际值（GrokManager 当前硬编码 `domain: ''`）
- [ ] 验证 codegraph symbols 表的 `name` 列格式（短名 vs qualified_name，影响合并匹配）
- [ ] 若 schema 不可控或有 WAL 锁冲突，改用 CLI `--dump-json` 导出方案

### Phase 1: GraphEngine 核心 (5 天)
- [ ] `src/services/graph/GraphEngine.ts` — 加权邻接表 + 基础遍历
- [ ] `GraphEngine.test.ts` — BFS/DFS + 边权重测试
- [ ] `src/services/graph/GraphStore.ts` — 数据适配器（codegraph.db + knowledge-graph.json）
- [ ] `GraphStore.test.ts` — 双数据源加载测试

### Phase 2: 存储与增量 (2 天)
- [ ] `src/services/graph/IncrementalSync.ts` — 三级检测（短路逻辑：git diff → mtime → hash）
- [ ] 集成 CodegraphManager + GrokManager 的数据加载
- [ ] 增量同步测试

### Phase 3a: 低复杂度高价值 (1.5 天)
- [ ] `tarjanSCC()` — 显式栈迭代版（避免递归栈溢出）
- [ ] `topologicalSort()` — SCC 缩点后拓扑排序
- [ ] `deltaGraph()` — 结构差分（比较两快照的节点/边增删，生成 DeltaResult）
- [ ] `pageRank()` — 幂迭代，O(k·E)
- [ ] `backwardReachability()` — 反向 BFS
- [ ] CodeGraph 5 个新 operation + Zod schema + 测试

### Phase 3b: 中复杂度核心场景 (1.5 天)
- [ ] `classifyRoles()` — 度 + 可达性分类
- [ ] `backwardDataSlice()` — 数据依赖切片（DDG 遍历）
- [ ] `couplingMetrics()` — 扇入扇出 + Henderson-Sellers LCOM
- [ ] CodeGraph 3 个新 operation + 测试

### Phase 3c: 高复杂度增值 (2 天)
- [ ] `louvainCommunity()` — Louvain 社区检测（后续可升级 Leiden）
- [ ] `katzCentrality()` — 幂迭代 + α 约束
- [ ] `betweennessCentrality(sampleSize=200)` — Brandes 采样近似
- [ ] `temporalCoupling()` — git log 解析 + 滑动时间窗口（6 个月）
- [ ] CodeGraph 3 个新 operation + Grok 2 个 operation + 测试

### Phase 4: 路由与集成 (1 天)
- [ ] Goal L3 自动触发（per-operation debounce）
- [ ] System prompt 指导
- [ ] BM25 searchHint 优化

### Phase 5: 测试与优化 (2 天)
- [ ] 单元测试：每个算法 3+ 测试用例（小图、空图、大图边界）
- [ ] 集成测试：GraphStore.load() 双数据源 + GraphEngine 管道
- [ ] 性能基准测试：100K 节点规模，验证 Section 4 各类目标
- [ ] 超时测试：深度分析类 30s 超时 + 进度回调验证
- [ ] 错误处理测试：数据源缺失、损坏、部分加载
- [ ] 文档更新：README + CLAUDE.md 架构描述

**总计: 14 天**（含 Phase 0 验证 1 天 + Phase 1 扩展至 5 天）

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Louvain 实现复杂 | Phase 3c 延期 | 参考 graphology-communities-louvain，300-400 行 |
| Betweenness 采样精度不足 | 排名偏差 | 默认 sampleSize=200，可配置，精度取决于图拓扑 |
| bun:sqlite 兼容性 | 构建失败 | 优先验证 bun:sqlite 在 compile 模式下的行为 |
| git log 解析慢 | temporal 超时 | 滑动时间窗口 + 增量缓存 + 30s 超时 |
| 递归栈溢出 (Tarjan) | 大图崩溃 | 所有 DFS 算法使用显式栈迭代 |
| Grok→GraphEngine 调用开销 | 两次加载 | GraphStore 单例 + 内存缓存 |

## 8. 与现有 API 的兼容性

新增操作不修改现有 `codegraph_impact`、`codegraph_callers` 等行为。`operationEnum` 仅追加新值，Zod schema 向后兼容（新字段均为 optional）。

现有 CodegraphManager 的 CLI 调用路径不变。GraphEngine 仅在新操作（`codegraph_scc` 等）中被调用，现有操作继续走 CLI 直接查询。

## 9. 错误处理

### 9.1 数据源缺失

| 场景 | 行为 |
|------|------|
| `.codegraph/codegraph.db` 不存在 | 返回 `{ error: true, message: "CodeGraph 索引未初始化", suggestion: "执行 codegraph_init" }` |
| `.understand-anything/knowledge-graph.json` 不存在 | 返回 `{ error: true, message: "Grok 知识图谱未生成", suggestion: "执行 grok_generate" }` |
| 两个数据源都不存在 | 返回合并错误信息，建议先初始化其中一个 |
| SQLite 文件损坏 | 捕获 `bun:sqlite` 异常，返回 `{ error: true, message: "索引文件损坏", suggestion: "执行 codegraph_init 重建" }` |
| JSON 解析失败 | 捕获 JSON parse 错误，返回 `{ error: true, message: "知识图谱格式异常", suggestion: "执行 grok_generate 重建" }` |

### 9.2 算法执行错误

| 场景 | 行为 |
|------|------|
| 目标符号不存在 | 返回 `{ error: true, message: "未找到符号: X", suggestion: "执行 codegraph_search 查找" }` |
| 图为空（0 节点） | 返回空结果 `{ data: { ... }, metadata: { nodeCount: 0, truncated: false } }` |
| 超时（30s） | 返回 `{ error: true, message: "分析超时", partial?: { 已完成的部分结果 } }` |
| 内存超限 | 捕获 OOM，返回 `{ error: true, message: "图规模过大，请缩小范围" }` |
| SCC/TopSort 无限循环 | 显式栈 + 最大迭代计数器（10 × |V|），超限返回部分结果 |

### 9.3 进度回调

深度分析类操作（betweenness/louvain/temporal）通过 `_onProgress` 回调报告进度：

```typescript
_onProgress?.({
  toolUseID: '',
  data: {
    type: 'graph_progress',
    operation: 'codegraph_community',
    stage: 'computing',        // preparing | computing | assembling | done
    progress: 45,              // 0-100
    elapsed: 2300,             // ms
    message: '迭代 12/50，模块度 Q=0.68',
  }
})
```

## 10. 参考工具

| 工具 | Stars | 借鉴内容 |
|------|-------|---------|
| Joern | 3.2K | CPG 联合图、污点分析 |
| codebase-memory-mcp | 3K | SQLite+FTS5、Louvain 社区检测、11信号混合评分 |
| Axon | 708 | KuzuDB、三策略搜索融合、执行流检测 |
| ops-codegraph | 67 | 三级增量检测、角色分类、数据流图 |
| Graphify | 59K | Leiden 社区检测、JSON 图存储 |
| Jelly | 431 | 指向分析、访问路径追踪 |
| graphology | 1.7K | 统一图接口、Louvain/PageRank 实现参考 |
| code2flow | 4.6K | 7步调用图构建算法 |
