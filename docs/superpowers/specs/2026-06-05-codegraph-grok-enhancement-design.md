# CodeGraph + Grok 图算法增强设计

> 日期: 2026-06-05
> 状态: Draft
> 范围: GraphEngine 图算法引擎 + 双引擎增强

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
src/tools/CodegraphTool/
├── CodegraphTool.ts          # 现有 tool（扩展 operation）
├── CodegraphManager.ts       # 现有 CLI 管理器
├── GraphEngine.ts            # 新增：核心图算法引擎
├── GraphStore.ts             # 新增：图存储层（SQLite/内存）
├── IncrementalSync.ts        # 新增：三级增量同步
└── __tests__/
    ├── GraphEngine.test.ts
    ├── GraphStore.test.ts
    └── IncrementalSync.test.ts

src/tools/GrokTool/
├── GrokTool.ts               # 现有 tool（扩展 operation）
├── GrokManager.ts            # 现有管理器（扩展图算法）
└── __tests__/
    └── GrokManager.test.ts   # 扩展测试
```

### 2.2 GraphEngine API

```typescript
// GraphEngine.ts — 零外部依赖的图算法引擎
export class GraphEngine {
  private adjacency: Map<string, Set<string>>   // 正向邻接
  private reverse: Map<string, Set<string>>     // 反向邻接
  private nodeMeta: Map<string, NodeMetadata>   // 节点元数据

  // ── 基础遍历 ──
  bfs(start: string, maxDepth?: number): TraversalResult
  dfs(start: string, maxDepth?: number): TraversalResult

  // ── 2024-2026 业界对标算法 ──
  backwardSlice(nodeId: string): SliceResult          // 反向程序切片 (O(V+E))
  tarjanSCC(): SCCResult[]                             // Tarjan 强连通分量 (O(V+E))
  dominatorTree(entry: string): Map<string, string>   // 支配树 (O(V·α(V)))
  katzCentrality(k: number, alpha?: number): CentralityResult  // Katz 中心性
  betweennessCentrality(): CentralityResult            // Betweenness 中心性 (O(V·E))
  leidenCommunity(): CommunityResult                   // Leiden 社区检测 (O(V·logV))
  deltaGraph(old: GraphSnapshot, curr: GraphSnapshot): DeltaResult  // 差分图
  temporalCoupling(history: GitHistory): CouplingResult  // 时间耦合
  topologicalSort(): string[]                          // 拓扑排序 (O(V+E))
  couplingMetrics(): MetricsResult                     // 内聚/耦合度量

  // ── 符号角色分类 ── (借鉴 ops-codegraph)
  classifyRoles(): Map<string, RoleType>  // entry/core/utility/adaptor/dead/leaf
}

type RoleType = 'entry' | 'core' | 'utility' | 'adaptor' | 'dead' | 'leaf'
```

### 2.3 图存储层

```typescript
// GraphStore.ts
export class GraphStore {
  // 内存模式（<50K 节点）：纯 Map 邻接表
  // SQLite 模式（≥50K 节点）：单文件数据库 + FTS5 全文搜索

  static async load(projectRoot: string): Promise<GraphStore>
  getNode(id: string): NodeMetadata | undefined
  getNeighbors(id: string, direction: 'out' | 'in'): string[]
  search(query: string, limit?: number): SearchResult[]  // BM25 搜索
  snapshot(): GraphSnapshot                              // 快照（用于 deltaGraph）
}
```

### 2.4 三级增量同步

借鉴 ops-codegraph 的三级检测策略：

```typescript
// IncrementalSync.ts
export class IncrementalSync {
  // Level 1: journal（O(changed)）— git diff 检测变更文件
  // Level 2: mtime+size（O(n) stat）— 文件修改时间和大小
  // Level 3: content hash（O(changed) reads）— SHA256 内容哈希

  async detectChanges(): Promise<ChangeSet>
  async applyChanges(changes: ChangeSet): Promise<void>
}
```

## 3. 新增 Tool Operations

### 3.1 CodeGraph 新增操作

| Operation | 描述 | 算法 |
|-----------|------|------|
| `codegraph_slice` | 反向程序切片：给定节点，追踪所有影响它的数据流和控制流 | BackwardSlice (SDG) |
| `codegraph_scc` | 强连通分量：发现循环依赖和相互递归 | Tarjan SCC |
| `codegraph_community` | 社区检测：自动发现架构模块边界 | Leiden |
| `codegraph_centrality` | 中心性分析：找出核心节点和瓶颈 | Katz + Betweenness |
| `codegraph_impact_v2` | 增强影响分析：基于支配树 + 切片的精确影响范围 | DominatorTree + Slice |
| `codegraph_roles` | 角色分类：entry/core/utility/adaptor/dead/leaf | Degree + Reachability |
| `codegraph_delta` | 差分图：两次索引之间的结构变化 | DeltaGraph |
| `codegraph_coupling` | 耦合度量：模块内聚性、扇入扇出、不稳定度 | CouplingMetrics |
| `codegraph_toposort` | 拓扑排序：依赖加载顺序、构建顺序 | TopologicalSort |
| `codegraph_temporal` | 时间耦合：哪些文件总是同时修改 | TemporalCoupling (git log) |

### 3.2 Grok 新增操作

| Operation | 描述 |
|-----------|------|
| `grok_architecture` | 架构洞察：基于社区检测 + 角色分类自动生成架构摘要 |
| `grok_hotspots` | 热点分析：结合 git 历史 + 中心性找出高风险文件 |

## 4. 双层 Agent 路由

### 4.1 Goal 系统 L3 主动调用

在 `src/utils/goal/goalToolTier.ts` 中扩展：

```typescript
// 自动触发规则
const GRAPH_AUTO_TRIGGERS = {
  codegraph_slice:    { when: '修改函数签名/接口', debounce: '30s' },
  codegraph_scc:      { when: '检测到循环依赖', debounce: '60s' },
  codegraph_community:{ when: '任务涉及多模块', debounce: '120s' },
  codegraph_impact_v2:{ when: '大规模重构', debounce: '30s' },
  codegraph_roles:    { when: '架构审查', debounce: '120s' },
}
```

### 4.2 System Prompt 指导

在系统提示中添加工具选择指南：

```
当需要理解代码结构时：
- 简单查找 → codegraph_search / Grep
- 调用链 → codegraph_callers / codegraph_callees
- 影响范围 → codegraph_impact_v2（精确）vs codegraph_impact（快速）
- 架构理解 → codegraph_community + codegraph_roles
- 循环依赖 → codegraph_scc
- 修改影响 → codegraph_slice + codegraph_delta
```

## 5. 性能目标

| 指标 | 目标 | 对标 |
|------|------|------|
| 全量索引 (100K LOC) | <30s | codebase-memory-mcp: 3min/28M LOC |
| 增量更新 | <500ms (单文件) | IntelliJ: 毫秒级 |
| 图查询延迟 | <10ms | codebase-memory-mcp: <1ms |
| 内存占用 | <200MB (100K 节点) | graphology: 内存型 |
| 算法复杂度 | 全部 ≤O(V·E) | 学术最优 |

## 6. 实施计划

### Phase 1: GraphEngine 核心 (3 天)
- [ ] `GraphEngine.ts` — 邻接表 + 10 个算法实现
- [ ] `GraphEngine.test.ts` — 每个算法 3+ 测试用例
- [ ] 基础 BFS/DFS + BackwardSlice + TarjanSCC

### Phase 2: 存储与增量 (2 天)
- [ ] `GraphStore.ts` — 内存/SQLite 双模式
- [ ] `IncrementalSync.ts` — 三级检测
- [ ] 集成 CodegraphManager 的 `.codegraph/` 数据

### Phase 3: Tool Operations (2 天)
- [ ] CodeGraph 10 个新 operation
- [ ] Grok 2 个新 operation
- [ ] 进度条 + verbose 模式

### Phase 4: 路由与集成 (1 天)
- [ ] Goal L3 自动触发
- [ ] System prompt 指导
- [ ] BM25 searchHint 优化

### Phase 5: 测试与优化 (2 天)
- [ ] 集成测试（真实项目端到端）
- [ ] 性能基准测试
- [ ] 文档更新

**总计: 10 天**

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Leiden 算法 TS 实现复杂 | Phase 1 延期 | 先用 Louvain 替代，功能等价 |
| SQLite 集成增加构建复杂度 | 构建失败 | 使用 better-sqlite3，bun 原生支持 |
| 大项目内存溢出 | OOM | SQLite 模式自动切换阈值 |
| git log 解析慢 | temporalCoupling 超时 | 限制最近 1000 commits |

## 8. 参考工具

| 工具 | Stars | 借鉴内容 |
|------|-------|---------|
| Joern | 3.2K | CPG 联合图、污点分析 |
| codebase-memory-mcp | 3K | SQLite+FTS5、Louvain 社区检测、11信号混合评分 |
| Axon | 708 | KuzuDB、三策略搜索融合、执行流检测 |
| ops-codegraph | 67 | 三级增量检测、角色分类、数据流图 |
| Graphify | 59K | Leiden 社区检测、JSON 图存储 |
| Jelly | 431 | 指向分析、访问路径追踪 |
| graphology | 1.7K | 统一图接口、事件系统 |
| code2flow | 4.6K | 7步调用图构建算法 |
