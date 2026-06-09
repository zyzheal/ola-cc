# 评审、风险与排错指南

> 原文档: 2026-06-05-codegraph-grok-unified-plan.md

---

## 6. 风险与缓解

### 6.1 图算法风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Louvain 实现复杂 | Phase 3c 延期 | 参考 graphology-communities-louvain，300-400 行 |
| Betweenness 采样精度不足 | 排名偏差 | 默认 sampleSize=200，可配置，精度取决于图拓扑 |
| bun:sqlite 兼容性 | Node.js 环境不可用 | 优先验证 bun:sqlite 在 compile 模式下的行为；降级为 sqlite3 -json CLI 导出 |
| git log 解析慢 | temporal 超时 | 滑动时间窗口 + 增量缓存 + 30s 超时 |
| 递归栈溢出 (Tarjan) | 大图崩溃 | 所有 DFS 算法使用显式栈迭代 |
| Grok->GraphEngine 调用开销 | 两次加载 | GraphStore 单例 + 内存缓存 |

### 6.2 UA 移植风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 结构指纹 tree-sitter 依赖 | 增加外部依赖 | 使用 codegraph CLI 的 tree-sitter 输出，不直接依赖 tree-sitter WASM |
| 非代码解析器覆盖不全 | 遗漏文件类型 | 分批实施（P0/P1/P2），ParserRegistry 支持按需扩展 |
| 领域分析 LLM 调用开销 | 延迟增加 | 仅在 Grok pipeline 中调用，不影响 CodeGraph 实时查询 |
| GraphValidator 误报 | 用户信任度下降 | 每项检查可配置严重级别，支持忽略特定规则 |
| 结构指纹持久化文件过大 | 磁盘占用 | 仅存储哈希值，不含 AST 全量数据 |

---

## 7. 兼容性

### 7.1 向后兼容

- 新增操作不修改现有 `codegraph_impact`、`codegraph_callers` 等行为
- `operationEnum` 仅追加新值，Zod schema 向后兼容（新字段均为 optional）
- 现有 CodegraphManager 的 CLI 调用路径不变
- GraphEngine 仅在新操作中被调用，现有操作继续走 CLI 直接查询

### 7.2 数据格式兼容

- GraphStore 输出格式与现有 GrokManager knowledge-graph.json 兼容
- 非代码解析器输出的 ParsedNode/ParsedEdge 与 GraphStore NodeMetadata/EdgeMeta 兼容
- 结构指纹文件 (fingerprints.json) 为新增文件，不影响现有数据

### 7.3 环境兼容

- bun:sqlite 为主路径，sqlite3 CLI 为降级方案
- 所有新模块零外部依赖（不引入 graphology/fuse.js 等）
- 解析器按文件扩展名启用，不影响不使用对应技术栈的项目

---

## 8. 错误处理

### 8.1 数据源缺失

| 场景 | 行为 |
|------|------|
| `.codegraph/codegraph.db` 不存在 | 返回 `{ error: true, message: "CodeGraph 索引未初始化", suggestion: "执行 codegraph_init" }` |
| `.understand-anything/knowledge-graph.json` 不存在 | 返回 `{ error: true, message: "Grok 知识图谱未生成", suggestion: "执行 grok_generate" }` |
| 两个数据源都不存在 | 返回合并错误信息，建议先初始化其中一个 |
| SQLite 文件损坏 | 捕获 bun:sqlite 异常，返回 `{ error: true, message: "索引文件损坏", suggestion: "执行 codegraph_init 重建" }` |
| JSON 解析失败 | 捕获 JSON parse 错误，返回 `{ error: true, message: "知识图谱格式异常", suggestion: "执行 grok_generate 重建" }` |

### 8.2 算法执行错误

| 场景 | 行为 |
|------|------|
| 目标符号不存在 | 返回 `{ error: true, message: "未找到符号: X", suggestion: "执行 codegraph_search 查找" }` |
| 图为空（0 节点） | 返回空结果 `{ data: { ... }, metadata: { nodeCount: 0, truncated: false } }` |
| 超时（30s） | 返回 `{ error: true, message: "分析超时", partial?: { 已完成的部分结果 } }` |
| 内存超限 | 捕获 OOM，返回 `{ error: true, message: "图规模过大，请缩小范围" }` |
| SCC/TopSort 无限循环 | 显式栈 + 最大迭代计数器（10 * |V|），超限返回部分结果 |

### 8.3 UA 移植错误

| 场景 | 行为 |
|------|------|
| 结构指纹文件损坏 | 重新计算全量指纹，记录警告日志 |
| 非代码解析器解析失败 | 跳过该文件，记录警告日志，继续处理其他文件 |
| 领域分析 LLM 调用失败 | 降级为纯图分析（无 LLM 摘要），返回结构化数据 |
| GraphValidator 检查超时 | 跳过超时检查项，返回已完成的检查结果 |

### 8.4 进度回调

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

---

## 10. 操作验证与排错指南

### 10.1 新 Operation 验证

| 操作 | 验证命令 | 预期结果 | 常见故障 | 排错步骤 |
|------|---------|---------|---------|---------|
| `codegraph_scc` | `codegraph_scc` (无参) | 返回 SCC 列表，metadata.nodeCount > 0 | 返回空列表但图非空 | 1. 检查 codegraph.db 是否有 edges 表 2. 执行 codegraph_status 确认索引状态 |
| `codegraph_toposort` | `codegraph_toposort` | 返回拓扑序，有环时附带 cycles | 超时 | 1. 检查图规模 2. 缩小 maxNodes 参数 |
| `codegraph_pagerank` | `codegraph_pagerank` | 返回 scores 数组，score 之和约等于 1.0 | 所有 score 为 0 | 1. 检查图是否有边 2. 检查 damping 参数 |
| `codegraph_community` | `codegraph_community` | 返回 communities + modularity | modularity < 0.1 | 1. 图可能无明显社区结构 2. 尝试调整 resolution 参数 |
| `codegraph_impact_deep` | `codegraph_impact_deep(symbol: "已知符号")` | 返回受影响节点 + 数据流 | "未找到符号" | 1. 先 codegraph_search 确认符号存在 2. 检查符号名是否包含类前缀 |
| `codegraph_roles` | `codegraph_roles` | 返回 6 种角色分类 | 所有节点都是 utility | 1. 检查 entry 点识别 2. 调整 corePercentile 参数 |
| `codegraph_temporal` | `codegraph_temporal` | 返回耦合对 + 时间窗口 | git log 解析超时 | 1. 缩短 since 时间窗口 2. 减小 maxCommits |

### 10.2 UA 移植功能验证

| 功能 | 验证方法 | 预期结果 |
|------|---------|---------|
| 结构指纹 | 对同一文件计算两次指纹 | 哈希值相同 |
| 结构指纹 | 修改函数签名后重新计算 | 哈希值不同 |
| 变更分类 | 修改函数签名 | 返回 signature_change |
| 变更分类 | 修改函数体 | 返回 implementation_change |
| 图验证 | 对空图执行验证 | 返回 0 个 Error，若干 Warning |
| 领域分析 | 对小图执行分析 | 返回至少 1 个 domain |
| Tour 增强 | 执行 Grok Tour | 输出包含 PageRank 排名 |

### 10.3 通用排错流程

1. 执行 `codegraph_status` 确认索引状态（已初始化 / 最后更新时间）
2. 执行 `grok_status` 确认 Grok 知识图谱状态
3. 检查 `.codegraph/codegraph.db` 文件是否存在且非空
4. 若报 "图为空": 确认 GraphStore.load() 成功加载了节点（nodeMeta.size > 0）
5. 若报超时: 检查图规模，100K 节点的深度分析应 <10s，超出说明需要缩小范围
6. 若结构指纹异常: 检查 `.codegraph/fingerprints.json` 是否存在且格式正确
7. 若非代码解析器失败: 检查文件扩展名是否在 ParserRegistry 注册列表中

---

## 11. 参考工具

| 工具 | Stars | 借鉴内容 |
|------|-------|---------|
| Joern | 3.2K | CPG 联合图、污点分析 |
| codebase-memory-mcp | 3K | SQLite+FTS5、Louvain 社区检测、11 信号混合评分 |
| Axon | 708 | KuzuDB、三策略搜索融合、执行流检测 |
| ops-codegraph | 67 | 三级增量检测、角色分类、数据流图 |
| Graphify | 59K | Leiden 社区检测、JSON 图存储 |
| Jelly | 431 | 指向分析、访问路径追踪 |
| graphology | 1.7K | 统一图接口、Louvain/PageRank 实现参考 |
| code2flow | 4.6K | 7 步调用图构建算法 |
| Understand-Anything | -- | 结构指纹、变更分类、图验证、领域分析、非代码解析器 |

---

## 12. 三方专家评审结论

> 评审日期: 2026-06-05
> 评审团队: Agent 工具专家 + 算法专家 + 架构师
> 评审范围: GraphStore 无损化改造方案

### 12.1 评审共识

三位专家一致确认：
1. **方案方向正确** -- 数组存储消除 mergedKey 是根本解法
2. **最大风险在两点** -- 权重聚合策略必须统一 + 身份桥接可靠性
3. **发现 2 个已有 Bug** -- BFS 邻居膨胀 + topoSort SCC 边丢失（数组化自动修复）

### 12.2 问题汇总

#### P0 -- 必须在实施前确定 (6 项)

| # | 问题 | 共识度 | 决策 |
|---|------|:------:|------|
| 1 | EdgeMeta[] 同类型合并策略 | 3/3 | 同 (from,to,type) -> max(weight)，不同类型 -> 数组不同元素 |
| 2 | 权重聚合策略必须统一 | 3/3 | 统一 `sum(weights)`，提供 `getWeightedOutDegree()` |
| 3 | 新边类型在算法中的参与矩阵 | 2/3 | contains 排除（已有），新类型默认参与 |
| 4 | 身份桥接 fileKeyToId 可靠性 | 2/3 | 分层匹配策略，<50% 告警 |
| 5 | CodeGraph 加载失败降级路径 | 1/3 | 降级为仅 Grok 图，标记 degraded |
| 6 | addEdge 正反向原子性 | 1/3 | 计算-应用两阶段 |

#### P1 -- 实施中同步修复 (8 项)

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

#### P2 -- 后续迭代 (5 项)

| # | 问题 |
|---|------|
| 1 | EdgeMeta 扩展 `source: 'codegraph' \| 'grok'` 调试字段 |
| 2 | ~~DataSourceAdapter 接口~~ → 已提升到 P1 (F-95, Phase Z1) |
| 3 | 性能 benchmark 对比（54K 节点规模） |
| 4 | identityMap 持久化缓存 |
| 5 | 边类型注册机制 |

### 12.3 实施顺序

> **注**: 以下为 GraphStore 无损化改造的实施子阶段，已整合到主计划 Phase 1a(5d) + Phase 1b(7d) 中。

```
Phase 1a (5d, P0 修复):
  1a-1: 算法修复 (1.5d) — Louvain 归一化 + Betweenness mulberry32 + Katz 自适应 + DominatorTree
  1a-2: 基础设施修复 (2d) — GraphData 类型对齐 + schema 验证 + 数组存储 + 14处适配
  1a-3: Tool Schema 重构 (1.5d) — operation 合并 + 三层 description + deferred 注册

Phase 1b (7d, GraphEngine 核心):
  GraphStore 无损化加载 + GraphEngine 适配 + 结构指纹 + GrokManager 拆分
  含 testHelpers 重写 + 无损性验证 + 正反向一致性测试
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

### 12.5 三方对比评审 (vs codegraph / UA)

#### 综合评分

| 维度 | ola-cc | codegraph | UA |
|------|:------:|:---------:|:---:|
| 架构清晰度 | 9/10 | 7/10 | 5/10 |
| 数据完整性 | 6/10 | 9/10 | 4/10 |
| 扩展性 | 9/10 | 5/10 | 6/10 |
| 维护成本 | 6/10 | 8/10 | 7/10 |
| 部署简易度 | 9/10 | 7/10 | 3/10 |
| 算法丰富度 | 10/10 | 3/10 | 1/10 |
| **综合** | **8.2** | **6.5** | **4.3** |

#### ola-cc 独有优势
1. 双引擎互补 (codegraph AST + Grok LLM)
2. 15 种内置图算法 (零外部依赖)
3. 渐进式增强 (任一数据源缺失不阻塞)
4. Tool 层双入口 (精确查询 + 语义分析)

#### 遗漏能力

| # | 能力 | 来源 | 说明 | 建议 |
|---|------|------|------|------|
| 1 | MCP Server 模式 | codegraph | `src/mcp/` 含 daemon/proxy/session/transport，支持独立服务被其他工具调用 | P2 — 当前 Tool 层够用 |
| 2 | 搜索系统 FTS5 + 模糊匹配 | codegraph | `search/query-parser.ts` + `search/query-utils.ts` + FTS5 全文搜索 + 编辑距离 | P1 — 增强 codegraph_search |
| 3 | import-resolver 完整模块解析 | codegraph | `resolution/import-resolver.ts` 含路径别名 + workspace packages + C++ include | P1 — Phase 6c-0 已移植 path-aliases 和 workspace-packages，但 import-resolver 本身未覆盖 |
| 4 | go-module 解析 | codegraph | `resolution/go-module.ts` Go 模块路径解析 | P2 — Phase 6c-3 有 go.ts 但未包含模块解析 |
| 5 | 多 Agent 协作模式 | UA | 9 个 Agent 独立 prompt + 工具，可自适应分析策略 | 不适用 — ola-cc 选择 TS 模块化，牺牲灵活性换取确定性 |
| 6 | LRU 缓存 | codegraph | `resolution/lru-cache.ts` 缓存解析结果 | P2 — GraphStore 单例已够用，细粒度缓存按需添加 |

#### 过度设计风险
1. Phase 6f 全量移植 20300 行 ROI 低 -> 建议按需推迟
2. Louvain 多分辨率 3x 开销 -> 建议默认单分辨率
3. 14 种非代码解析器 -> 建议先做 P0 批 4 种
4. 时间耦合 O(C*F^2) -> 建议降级为 P2

#### 建议优先级调整
1. Phase 1-5 (22.5 天): 核心价值，立即执行
2. Phase 6a-6e (13 天): 有价值，Phase 5 后评估
3. Phase 6f (7.5 天): 仅在 CLI 确实不可用时执行

---

## 13. 四专家评审 (第九轮)

> 评审日期: 2026-06-05
> 评审团队: Agent 工具专家 + 算法专家 + 架构师 + Agent 产品专家
> 综合评分: 7.0/10 → 修复后预估 8.5/10

### 13.1 各专家评分

| 专家 | 评分 | 关注点 |
|------|:----:|--------|
| Agent 工具专家 | 7.2/10 | Tool Schema 过载、错误恢复缺失 |
| 算法专家 | 6.8/10 | Louvain 公式缺陷、Betweenness 非确定性、正确性测试缺失 |
| 架构师 | 7.5/10 | EdgeMeta[] 破坏性变更、回滚策略缺失、工期乐观 |
| Agent 产品专家 | 6.5/10 | 验收标准缺失、成功指标缺失、成本估算缺失 |

### 13.2 P0 问题修复

| # | P0 问题 | 修复方案 | 功能点 | 工期 |
|---|---------|---------|:------:|:----:|
| 1 | EdgeMeta[] 破坏性变更 ~50 处代码+226 测试 | F-113: 兼容层 getEdgeMeta() + 渐进迁移 | F-113 | 2d |
| 2 | 缺少错误恢复策略 | F-111: 四层错误恢复 (算法超时+DB损坏+Grok降级+同步冲突) | F-111 | 1d |
| 3 | Louvain modularity 缺少 1/(2m) 归一化 | Phase 1a-1 修正 (已有) | — | — |
| 4 | Betweenness Math.random() 非确定性 | Phase 1a-1 mulberry32 PRNG (已有) | — | — |
| 5 | 缺少算法正确性测试套件 | F-112: PageRank/modularity/Katz/Betweenness 验证 | F-112 | 1d |
| 6 | Tool Schema 32+ operations 无分层 | F-93 三层分层 (已有) | — | — |
| 7 | 缺少回滚策略 | F-114: git tag + feature flag + graph_rollback op | F-114 | 0.5d |
| 8 | 用户故事缺少验收标准 | F-115: 验收矩阵 + 成功指标 | F-115 | 0.5d |

### 13.3 P1 问题修复

| # | P1 问题 | 修复方案 |
|---|---------|---------|
| 1 | Katz alpha=0.1 可能不收敛 | Phase 1a-1: alpha = 0.9/sqrt(maxDegree) (已有) |
| 2 | Tool operation 参数语义泄漏 | F-93: 三层 description 重新编写 (已有) |
| 3 | MCP 模式无查询沙箱 | F-89: 安全层 2d (已有) |
| 4 | Prompt injection via Grok JSON | F-89: 输入清洗 + 长度限制 (已有) |
| 5 | 工期估算过于乐观 | 94d→99d (+5d P0 修复) |
| 6 | 缺少性能预算表 | 主计划新增性能预算表 |
| 7 | 缺少数据源可用性矩阵 | 主计划新增数据源可用性矩阵 |
| 8 | 缺少成功指标 | F-115: 主计划新增成功指标定义 |
| 9 | Leiden 自适应分辨率公式需验证 | F-112: 测试覆盖 |
| 10 | GraphSnapshot 接口变更级联 | F-113: 兼容层统一处理 |
| 11 | testHelpers.ts 11 工厂函数重写 | F-113: 渐进迁移 |
| 12 | 20% 缓冲未计入 | 99d × 1.2 ≈ 119d (含缓冲) |
| 13 | 缺少数据源降级路径 | F-111: Grok 降级为纯图分析 |
| 14 | 成本估算缺失 | 主计划新增成本估算表 |

### 13.4 新增功能点 (F-111~F-115)

| # | 功能 | Phase | 天数 | 依赖 | 来源 |
|---|------|:-----:|:----:|------|:----:|
| F-111 | 错误恢复策略 (算法超时+DB损坏恢复+Grok降级+同步冲突+资源限制) | 2 | 1 | F-01 | 四专家评审 P0 |
| F-112 | 算法正确性测试套件 (PageRank收敛+modularity+Katz收敛+Betweenness确定性) | 5 | 1 | F-05,F-12,F-13,F-14 | 四专家评审 P0 |
| F-113 | EdgeMeta[] 兼容层 + 渐进迁移 (Map→Map[] 迁移, ~50处代码+226测试适配) | 1a | 2 | F-31 | 四专家评审 P0 |
| F-114 | 回滚策略 (git tag + feature flag + codegraph_rollback op + 数据备份) | 5 | 0.5 | F-01 | 四专家评审 P0 |
| F-115 | 用户故事验收矩阵 + 成功指标 (6 用户故事验收标准 + 数据源可用性矩阵) | 1 | 0.5 | 无 | 四专家评审 P0 |

### 13.5 性能预算表

| 操作类型 | 延迟目标 | 内存上限 | 超时策略 |
|---------|:--------:|:--------:|---------|
| 查询类 (bfs/dfs/search/scc/toposort) | <10ms | 无额外 | 无 |
| 分析类 (pagerank/katz/coupling/roles) | <2s | 200MB | 30s 硬超时 |
| 深度分析 (betweenness/leiden/temporal) | <10s | 500MB | 60s 超时→单社区回退 |
| 结构指纹 (单文件) | <100ms | 无额外 | 无 |
| 变更分类 (单文件) | <50ms | 无额外 | 无 |
| 图验证 (100K 节点) | <10s | 300MB | 30s 部分结果 |
| 领域分析 (100K 节点) | <30s | 500MB | 60s 降级 |
| FTS5 搜索 | <5ms | 无额外 | 无 |
| RRF 融合搜索 | <20ms | 无额外 | 无 |

### 13.6 数据源可用性矩阵

| 数据源 | 必需性 | 不可用时行为 | 降级路径 |
|--------|:------:|------------|---------|
| codegraph.db | 可选 | 仅 Grok 图模式 | 标记 degraded, 返回 Grok 数据 |
| knowledge-graph.json | 可选 | 仅 CodeGraph 模式 | 标记 degraded, 返回 AST 数据 |
| 两者都不存在 | — | 返回错误 + 初始化建议 | codegraph_init 或 grok_generate |
| SQLite 损坏 | — | 捕获异常 + 重建建议 | codegraph_init 重建 |
| JSON 解析失败 | — | 捕获错误 + 重建建议 | grok_generate 重建 |
| git 仓库不存在 | 可选 | 跳过 temporal/authored_by | 返回空结果 |
| tree-sitter WASM | 可选 | 跳过代码提取 | 降级为正则解析 |
| Embedding API | 可选 | 跳过语义搜索 | FTS5+BM25 仍可用 |

### 13.7 成功指标

| 指标 | 目标值 | 测量方法 |
|------|:------:|---------|
| codegraph 能力覆盖率 | 12/12 (100%) | 逐项验证 |
| UA 能力覆盖率 | 20/20 (100%) | 逐项验证 |
| 边类型数量 | 40 种 | EdgeType 枚举计数 |
| 图算法数量 | 15 种 | GraphEngine 方法计数 |
| 零 CLI 依赖 | Phase Z4 后无外部调用 | grep 验证 |
| 数据完整性 | 9/10 | NodeMetadata 21/21 + EdgeType 40/40 |
| 54K 节点 PageRank | <3s | 性能基准测试 |
| 54K 节点 Leiden | <15s | 性能基准测试 |
| 端到端 init→query | <30s | 集成测试 |
| 测试通过率 | 226+ 测试全部通过 | bun test |

### 13.8 成本估算

| 资源 | 零 LLM 模式 | Grok 增强模式 |
|------|:-----------:|:------------:|
| 内存峰值 | 200MB | 500MB |
| 磁盘 (codegraph.db) | ~50MB (54K 节点) | ~50MB |
| LLM API 调用 | 0 | ~$0.05/次 Grok 生成 |
| Embedding API | 0 (Mock) | ~$0.01/次索引 |
| CPU (init, 54K 节点) | ~30s | ~60s (含 Grok) |
| CPU (查询) | <100ms | <100ms |
