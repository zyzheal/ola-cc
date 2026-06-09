# GraphStore 无损化改造设计

> 原文档: 2026-06-05-codegraph-grok-unified-plan.md
> Phase: 1
> 天数: 1.5 (GraphStore) + 适配

---

### 2.2 数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                         数据源（外部索引）                            │
│  codegraph CLI → .codegraph/codegraph.db (SQLite)                  │
│  Grok pipeline → .understand-anything/knowledge-graph.json          │
│  非代码文件 → parsers/ 解析 → 内存节点/边                            │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ GraphStore.load() 数据适配器
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      GraphStore（统一图表示）                         │
│  adjacency: Map<string, Map<string, EdgeMeta[]>>                   │
│  reverse:   Map<string, Map<string, EdgeMeta[]>>                   │
│  nodeMeta:  Map<string, NodeMetadata>                              │
│  EdgeType:  12 种 codegraph EdgeKind + 1 种 control fallback       │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  GraphEngine     │ │ Structural       │ │ GraphValidator   │
│  15 种算法       │ │ Fingerprint      │ │ 9 项检查         │
│                  │ │ + Change         │ │                  │
│                  │ │ Classifier       │ │                  │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                      │
         ▼                    ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         应用层                                       │
│  CodegraphTool (11 新 op)  │  GrokManager (Tour 增强)               │
│  DomainAnalyzer (三层模型)  │  GraphValidator (质量报告)             │
│  返回结构化 JSON            │  调用 GraphEngine + LLM                │
└───────────────────────────────┘─────────────────────────────────────┘
```

**数据流说明**:
1. GraphStore.load() 从两个数据源加载并合并（符号身份匹配 + 属性合并 + 边去重）
2. StructuralFingerprint 为每个文件计算 AST 结构哈希，用于增量检测
3. ChangeClassifier 对变更文件分类，决定是否需要重新分析
4. GraphValidator 调用 GraphEngine 算法执行 9 项质量检查
5. DomainAnalyzer 调用 GraphEngine 的 community/roles 算法构建三层模型
6. GrokManager Tour 阶段调用 GraphEngine.pageRank() + backwardReachability() 增强学习路径

---

**GraphStore NodeKind 完整映射设计**:

当前问题：codegraph.db 有 22 种 NodeKind，但 GraphStore.load() 未映射其中 6 种（struct/trait/protocol/parameter/namespace/route/component），导致这些节点的 kind 字段丢失。

映射方案：
- 在 GraphStore 节点加载逻辑中增加完整 kind 映射表，保留 codegraph.db 原始 kind 值
- 新增 kind：`struct`, `trait`, `protocol`, `parameter`, `namespace`, `route`, `component`
- 不截断 kind 值，`classifyRoles()` 通过 kind 前缀匹配而非严格枚举

---

**GraphStore 无损化改造设计** (三方专家评审确认):

当前问题：GraphStore 存在 5 处有损压缩，破坏 codegraph AST 精确语义：

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | EdgeType 仅 7 种 | `EdgeMeta.type` | exports/type_of/returns/instantiates/overrides/decorates 全部丢失 |
| 2 | instantiates→calls 降级 | `CODEGRAPH_EDGE_MAP` | 实例化 ≠ 调用，语义混淆 |
| 3 | mergedKey 污染 | `addEdge()` | `${to}::${type}` 破坏 Map key 语义，GraphEngine 需 filter hack |
| 4 | 身份不匹配 | `loadGrok()` | Grok `file:name` ≠ CodeGraph `kind:hash`，同一实体两个节点 |
| 5 | 无并发锁 | `load()` | 并发调用可能重复加载 |

**修复方案** (5 项):

**修复 0: codegraph.db schema 验证** (三方专家 P1):
在 loadCodegraph() 扩展到 21 字段前，必须先验证 db 实际包含这些列：
```typescript
// loadCodegraph() 开头添加 schema 验证
const tableInfo = db!.query("PRAGMA table_info(nodes)").all() as Array<{name: string}>
const existingColumns = new Set(tableInfo.map(r => r.name))
const requiredColumns = ['id', 'kind', 'name', 'qualified_name', 'file_path', 'start_line', 'end_line', 'signature', 'docstring', 'language', 'visibility', 'is_exported', 'is_async', 'is_static', 'is_abstract', 'decorators', 'type_parameters', 'start_column', 'end_column', 'updated_at', 'provenance']
const missingColumns = requiredColumns.filter(c => !existingColumns.has(c))
if (missingColumns.length > 0) {
  logForDebugging(`[GraphStore] codegraph.db missing columns: ${missingColumns.join(', ')}`)
  // 降级: 只 SELECT 存在的列，缺失字段设为 undefined
}
```

**修复 1: EdgeType 扩展为 12+1 种** — codegraph 12 种 EdgeKind 1:1 映射，无降级：
```
calls | imports | contains | data | inherits | implements | exports | type_of | returns | instantiates | overrides | decorates | control(fallback)
```

**修复 2: CODEGRAPH_EDGE_MAP 完整 12 项** — 每种 EdgeKind 精确映射到对应 EdgeType：
```typescript
const CODEGRAPH_EDGE_MAP = {
  calls: 'calls', imports: 'imports', contains: 'contains', references: 'data',
  extends: 'inherits', implements: 'implements', exports: 'exports',
  type_of: 'type_of', returns: 'returns', instantiates: 'instantiates',
  overrides: 'overrides', decorates: 'decorates',
}
```

**修复 3: 邻接表改为数组存储** — 消除 mergedKey 污染：

> **第二轮评审发现**: GraphData 接口已声明为 `EdgeMeta[]`，但类实例仍为 `EdgeMeta`（单值）。
> Phase 1a-2 必须统一类型，否则 GraphEngine 适配基于错误假设。

```
当前: Map<string, Map<string, EdgeMeta>>     — mergedKey "${to}::${type}" 污染 key
     (类实例类型，与 GraphData 接口的 EdgeMeta[] 不一致)
改为: Map<string, Map<string, EdgeMeta[]>>   — 数组存储，key 始终为纯 node ID
     (统一接口和实现)
```
- 同 (from, to, type) 边：保留最高权重（与当前行为一致）
- 同 (from, to) 不同 type 边：数组中不同元素
- GraphEngine 的 `filter(k => !k.includes('::'))` hack 自然消除

**修复 4: fileKeyToId 桥接索引** — 分层匹配策略：
```
Level 1: qualified_name 精确匹配（最可靠）
Level 2: file + name + kind 三元组匹配（次可靠）
Level 3: file + name 二元组匹配（有歧义风险）
Level 4: 不匹配 → Grok 独立节点
```
- loadCodegraph() 时构建 `file:name → codegraph id` 索引
- loadGrok() 时用此索引匹配，合并 layer/domain 语义字段
- 匹配率日志统计，<50% 时告警

**修复 5: loadingPromise 并发锁** — 标准 Promise 单次执行模式

**新增公共 API**:
| 方法 | 返回 | 用途 |
|------|------|------|
| `getOutNeighborIds(nodeId)` | `string[]` | 无重复邻居（无 mergedKey） |
| `getInNeighborIds(nodeId)` | `string[]` | 入边邻居 |
| `getEdgeBetween(from, to)` | `EdgeMeta[]` | 两节点间所有边类型 |
| `getOutDegree(nodeId)` | `number` | 出度（邻居数） |
| `getInDegree(nodeId)` | `number` | 入度 |
| `getWeightedOutDegree(nodeId, excludeTypes?)` | `number` | 加权出度（权重之和） |

**算法权重聚合策略** (三方专家一致确认):
| 算法 | 策略 | 理由 |
|------|------|------|
| PageRank | `sum(weights)` 排除 contains | 出度 = 有效边权重之和 |
| Louvain | `sum(weights)` | 模块度公式 2m = 总权重 |
| couplingMetrics | `edges.length` | fanIn/fanOut 是拓扑度量 |
| backwardDataSlice | 遍历数组中 `type === 'data'` | 保持现有语义 |
| classifyRoles | fanIn/fanOut = 邻居数 (map.size) | 语义修正：邻居数 > 边条目数 |

**自动修复的已有 Bug**:
| Bug | 位置 | 影响 |
|-----|------|------|
| BFS/DFS 邻居膨胀 | GraphEngine:134 | A→B 有 calls+data 时 B 被遍历两次 |
| topoSort SCC 边丢失 | GraphEngine:337-346 | mergedKey 导致 nodeToScc.get() 返回 undefined |

**GraphEngine 适配清单** (14 处):

邻接表从 `Map<string, EdgeMeta>` 改为 `Map<string, EdgeMeta[]>` 后，GraphEngine 中所有边迭代必须适配：

| # | 文件:行 | 方法 | 当前模式 | 适配方式 | 改动量 |
|---|---------|------|---------|---------|:------:|
| 1 | GraphEngine:134 | bfs | `for (const [target] of outEdges)` | 不变（key 已是纯 node ID） | 无 |
| 2 | GraphEngine:150 | dfs | 同上 | 不变 | 无 |
| 3 | GraphEngine:186 | backwardReachability | `for (const [target] of inEdges)` | 不变 | 无 |
| 4 | GraphEngine:337 | topologicalSort | `for (const [to] of outMap)` | 不变（key 不再含 `::`） | 无 |
| 5 | GraphEngine:397 | pageRank | `for (const [, edge] of outEdges)` + `edge.weight` | 嵌套循环 + `sum(edges.map(e=>e.weight))` | 中 |
| 6 | GraphEngine:419 | pageRank | `for (const [u, edge] of inEdges)` | 嵌套循环 | 中 |
| 7 | GraphEngine:572 | classifyRoles | `[...inEdges.keys()].length` | 改为 `map.size`（邻居数） | 低 |
| 8 | GraphEngine:682 | backwardDataSlice | `edge.type === 'data'` | 遍历数组中 `type === 'data'` 的元素 | 中 |
| 9 | GraphEngine:714 | couplingMetrics | `[...getInEdges().keys()].length` | 改为 `map.size` | 低 |
| 10 | GraphEngine:739 | couplingMetrics | `for (const [target, edge] of outEdges)` | 嵌套循环 | 中 |
| 11 | GraphEngine:916 | louvainCommunity | `for (const [, edge] of outMap) totalWeight += edge.weight` | 嵌套循环 + `sum(edges.map(e=>e.weight))` | 中 |
| 12 | GraphEngine:927 | louvainCommunity | `for (const [, edge] of getOutEdges)` | 嵌套循环 | 中 |
| 13 | GraphEngine:1065 | kahnSort | `for (const [target] of outMap)` | 不变 | 无 |
| 14 | GraphEngine:1092 | snapshotToEdgeSet | `for (const [to, edge] of outMap)` | 嵌套循环展开数组 | 中 |

**GraphSnapshot 接口同步变更**:
```typescript
// 当前
interface GraphSnapshot { adjacency: Map<string, Map<string, EdgeMeta>> }
// 改为
interface GraphSnapshot { adjacency: Map<string, Map<string, EdgeMeta[]>> }
```
影响: `deltaGraph()`、`snapshotToEdgeSet()`、CodegraphTool `codegraph_delta` 操作

**testHelpers.ts 适配**:
11 个工厂函数（dag/cycle/multiSCC/star/chain/weightedGraph/emptyGraph/completeGraph/bipartite）的边注入从 `fromMap.set(to, { type, weight })` 改为 `fromMap.set(to, [{ type, weight }])`

---

## 12. 三方专家评审结论

> 评审日期: 2026-06-05
> 评审团队: Agent 工具专家 + 算法专家 + 架构师
> 评审范围: GraphStore 无损化改造方案

### 12.1 评审共识

三位专家一致确认：
1. **方案方向正确** — 数组存储消除 mergedKey 是根本解法
2. **最大风险在两点** — 权重聚合策略必须统一 + 身份桥接可靠性
3. **发现 2 个已有 Bug** — BFS 邻居膨胀 + topoSort SCC 边丢失（数组化自动修复）

### 12.2 问题汇总

#### P0 — 必须在实施前确定 (6 项)

| # | 问题 | 共识度 | 决策 |
|---|------|:------:|------|
| 1 | EdgeMeta[] 同类型合并策略 | 3/3 | 同 (from,to,type) → max(weight)，不同类型 → 数组不同元素 |
| 2 | 权重聚合策略必须统一 | 3/3 | 统一 `sum(weights)`，提供 `getWeightedOutDegree()` |
| 3 | 新边类型在算法中的参与矩阵 | 2/3 | contains 排除（已有），新类型默认参与 |
| 4 | 身份桥接 fileKeyToId 可靠性 | 2/3 | 分层匹配策略，<50% 告警 |
| 5 | CodeGraph 加载失败降级路径 | 1/3 | 降级为仅 Grok 图，标记 degraded |
| 6 | addEdge 正反向原子性 | 1/3 | 计算-应用两阶段 |

#### P1 — 实施中同步修复 (8 项)

| # | 问题 | 工作量 |
|---|------|:------:|
| 1 | GraphEngine 14 处边迭代适配 | 中 |
| 2 | GraphSnapshot 接口变更级联 | 中 |
| 3 | testHelpers.ts 11 个工厂函数重写 | 中 |
| 4 | size.edges 计算逻辑重写 | 低 |
| 5 | loadingPromise 并发锁实现 | 低 |
| 6 | fanIn/fanOut 语义修正为邻居数 | 低 |
| 7 | fileKeyToId 桥接索引 + 分层匹配 | 中 |
| 8 | validateConsistency() 正反向一致性校验 | 低 |

#### P1+ — 实施中同步修复 (新增)

| # | 问题 | 工作量 |
|---|------|:------:|
| 9 | **DataSourceAdapter 接口提取** (三方专家建议从 P2 提升) | 中 |
| 10 | **codegraph.db schema 验证** (三方专家 P1) | 低 |

**DataSourceAdapter 接口设计** (三方专家建议 P1):
当前 GraphStore 硬编码两个数据源 (codegraph.db + Grok JSON)。Phase Z1-Z5 的内置 extraction 是第三种加载路径，需要统一接口：
```typescript
interface DataSourceAdapter {
  readonly name: string
  isAvailable(): boolean
  load(store: GraphStore): Promise<void>
  watch?(callback: () => void): void
}
// 实现: CodegraphDbAdapter, GrokJsonAdapter, ExtractionAdapter
```

#### P2 — 后续迭代 (4 项)

| # | 问题 |
|---|------|
| 1 | EdgeMeta 扩展 `source: 'codegraph' \| 'grok'` 调试字段 |
| 2 | 性能 benchmark 对比（54K 节点规模） |
| 3 | identityMap 持久化缓存 |
| 4 | 边类型注册机制 |

### 12.3 实施顺序

```
Phase 1a: GraphStore 数据模型 (EdgeType 12+1 + EdgeMeta[] + addEdge + loadingPromise + fileKeyToId)
Phase 1b: GraphEngine 适配 (14 处边迭代 + 权重辅助方法 + Snapshot 接口)
Phase 1c: 测试 (testHelpers 重写 + 无损性验证 + 回归测试 + 正反向一致性)
```

### 12.4 测试策略

| 测试类型 | 内容 | 优先级 |
|---------|------|:------:|
| 无损性验证 | 12 种 EdgeKind 全部精确映射（非 control fallback） | P0 |
| mergedKey 消除 | adjacency 所有 key 为纯 node ID（无 `::`） | P0 |
| 正反向一致性 | 每条正向边都有对应反向边 | P0 |
| 权重聚合正确性 | PageRank/Louvain 使用 sum(weights) | P0 |
| GraphEngine 回归 | 构造 10-20 节点小图验证每个算法输出 | P1 |
| 身份桥接匹配率 | 对实际项目统计 file:name 匹配率 | P1 |
| 性能对比 | 54K 节点规模 benchmark | P2 |

---

## GraphStore 评审新增问题 (三方专家)

### P2 — 后续迭代

**GraphStore 单例无 LRU 淘汰** (架构师):
- `GraphStore.getInstance(projectRoot)` 返回同一实例，永不释放
- 如果用户切换多个项目，旧实例不会被 GC，内存持续增长
- 修复：添加 LRU 淘汰机制（最多缓存 N 个 projectRoot 的实例），或添加 `dispose()` 显式释放
