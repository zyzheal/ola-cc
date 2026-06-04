# CodeGraph + Grok 图算法增强设计

> 日期: 2026-06-05
> 状态: Draft (v2 — 三方评审修复版)
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
│  EdgeMeta = { type: 'calls'|'imports'|'data'|'control',     │
│               weight: number }                               │
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

适配器将两种格式统一转换为 `adjacency` + `nodeMeta` 内部表示。

### 2.3 图数据结构

```typescript
// 评审修复：邻接表扩展为加权+类型化，兼容所有算法
interface EdgeMeta {
  type: 'calls' | 'imports' | 'data' | 'control' | 'inherits' | 'implements'
  weight: number  // 调用频率/依赖强度，默认 1
}

interface NodeMetadata {
  id: string
  name: string
  kind: 'function' | 'class' | 'variable' | 'module' | 'file'
  file: string
  line: number
  signature?: string
  layer?: string    // Grok 专有：架构层
  domain?: string   // Grok 专有：业务域
}
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
  topologicalSort(): TopoResult                             // 拓扑排序，有环返回 SCC (O(V+E))
  pageRank(damping?: number, maxIter?: number): CentralityResult  // PageRank (O(k·E))
  deltaGraph(old: GraphSnapshot, curr: GraphSnapshot): DeltaResult  // 差分图 (O(V+E))

  // ── Phase 3b: 中复杂度 + 核心场景 ──
  classifyRoles(): Map<string, RoleType>                  // 角色分类 (O(V+E))
  backwardDataSlice(nodeId: string): SliceResult          // 数据依赖切片 (O(V+E))
  couplingMetrics(): MetricsResult                        // 内聚/耦合度量 (O(V+E))

  // ── Phase 3c: 高复杂度 + 增值功能 ──
  katzCentrality(opts?: KatzOpts): CentralityResult       // Katz 中心性 (O(k·E))
  betweennessCentrality(sampleSize?: number): CentralityResult  // 近似 Betweenness (O(k·E))
  louvainCommunity(resolution?: number): CommunityResult  // Louvain 社区检测 (O(V·logV))
  temporalCoupling(opts?: TemporalOpts): CouplingResult   // 时间耦合 (O(C·F²))
}

type RoleType = 'entry' | 'core' | 'utility' | 'adaptor' | 'dead' | 'leaf'

// 评审修复：统一返回结构
interface GraphOperationResult<T> {
  _summary: string              // 一句话摘要（LLM 友好）
  _nextSteps?: string[]         // 建议的下一步操作
  data: T
  metadata: { nodeCount: number; edgeCount?: number; truncated: boolean }
}
```

**评审修复说明**:

| 修复项 | 变更 |
|--------|------|
| P0: 邻接表缺边权重/类型 | 扩展为 `Map<string, Map<string, EdgeMeta>>` |
| P0: BackwardSlice 需 SDG | 重命名为 `backwardReachability`（近似切片），Phase 3b 增加 `backwardDataSlice`（数据依赖切片） |
| P0: Betweenness 100K 超时 | 改为 `betweennessCentrality(sampleSize=200)` 采样近似，O(k·E) ≈ 0.1s |
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
```

## 4. 性能目标（修正版）

| 指标 | 目标 | 备注 |
|------|------|------|
| 查询类 (bfs/dfs/search/scc/toposort/delta) | <10ms | O(V+E)，遍历类 |
| 分析类 (pagerank/katz/coupling/roles) | <2s | O(k·E) 或 O(V+E) |
| 深度分析类 (betweenness/leiden/temporal) | <10s | 采样近似 + 超时保护 |
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

## 6. 实施计划（修正版）

### Phase 1: GraphEngine 核心 (3 天)
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
- [ ] `deltaGraph()` — 结构差分
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
- [ ] 集成测试（真实项目端到端）
- [ ] 性能基准测试（100K 节点规模）
- [ ] 文档更新

**总计: 12 天**（评审建议从 10 天调整为 12 天）

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Louvain 实现复杂 | Phase 3c 延期 | 参考 graphology-communities-louvain，300-400 行 |
| Betweenness 采样精度不足 | 结果偏差 | 默认 sampleSize=200，可配置，误差 <5% |
| bun:sqlite 兼容性 | 构建失败 | 优先验证 bun:sqlite 在 compile 模式下的行为 |
| git log 解析慢 | temporal 超时 | 滑动时间窗口 + 增量缓存 + 30s 超时 |
| 递归栈溢出 (Tarjan) | 大图崩溃 | 所有 DFS 算法使用显式栈迭代 |
| Grok→GraphEngine 调用开销 | 两次加载 | GraphStore 单例 + 内存缓存 |

## 8. 参考工具

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
