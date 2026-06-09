# GraphEngine 算法设计

> 原文档: 2026-06-05-codegraph-grok-unified-plan.md
> Phase: 3a/3b/3c
> 天数: 6 (1.5 + 1.5 + 3)

---

## 算法权重聚合策略 (Section 3.2)

三方专家一致确认的算法权重聚合策略:

| 算法 | 策略 | 理由 |
|------|------|------|
| PageRank | `sum(weights)` 排除 contains | 出度 = 有效边权重之和 |
| Louvain | `sum(weights)` | 模块度公式 2m = 总权重 |
| couplingMetrics | `edges.length` | fanIn/fanOut 是拓扑度量 |
| backwardDataSlice | 遍历数组中 `type === 'data'` | 保持现有语义 |
| classifyRoles | fanIn/fanOut = 邻居数 (map.size) | 语义修正：邻居数 > 边条目数 |

**GraphEngine 适配清单中 classifyRoles 和 backwardDataSlice 相关条目**:

| # | 文件:行 | 方法 | 当前模式 | 适配方式 | 改动量 |
|---|---------|------|---------|---------|:------:|
| 7 | GraphEngine:572 | classifyRoles | `[...inEdges.keys()].length` | 改为 `map.size`（邻居数） | 低 |
| 8 | GraphEngine:682 | backwardDataSlice | `edge.type === 'data'` | 遍历数组中 `type === 'data'` 的元素 | 中 |

---

## Phase 3a: 低复杂度高价值算法 -- 1.5 天

**目标**: 实现 6 种高价值低复杂度算法 + 4 个新 operation

| 任务 | 算法 | 复杂度 | 新 Operation |
|------|------|--------|-------------|
| Tarjan SCC | 强连通分量 | O(V+E) | `codegraph_scc` |
| 拓扑排序 | 依赖加载顺序 | O(V+E) | `codegraph_toposort` |
| 差分图 | 结构变化对比 | O(V+E) | `codegraph_delta` |
| PageRank | 核心节点识别 | O(k*E) | `codegraph_pagerank` |
| 反向可达性 | 影响范围分析 | O(V+E) | -- |
| 支配树 | 关键路径分析 | O(V*alpha(V)+E) | -- |

**Tarjan SCC 关键设计**:
- 显式栈迭代版，避免递归栈溢出
- 三个不变量: index[v] 严格单调递增、onStack 精确等于当前 DFS 路径、lowlink[v] <= index[v]
- 最大迭代计数器: 10 * |V|，超限返回部分结果

**PageRank 关键设计**:
- 收敛度量: L1 范数（业界标准），epsilon=1e-6
- 悬挂节点（出度=0）: 概率质量均匀分配给所有节点
- 公式: PR_new[v] = (1-d)/N + d * (sum(PR[u]/outDeg(u)) + danglingSum/N)

**验收条件**:
- [ ] Tarjan SCC: 含环图返回正确 SCC，无环图每节点独立 SCC
- [ ] 拓扑排序: DAG 返回正确序，有环时返回 SCC
- [ ] PageRank: 收敛后 score 之和约等于 1.0，悬挂节点处理正确
- [ ] 4 个新 operation 的 Zod schema 验证通过

---

## Phase 3b: 中复杂度核心场景 -- 1.5 天

**目标**: 实现 3 种核心分析算法 + 4 个新 operation

| 任务 | 算法 | 复杂度 | 新 Operation |
|------|------|--------|-------------|
| 角色分类 | entry/core/utility/adaptor/dead/leaf | O(V+E) | `codegraph_roles` |
| 数据依赖切片 | 追踪影响变量的所有数据流 | O(V+E) | `codegraph_slice` |
| 耦合度量 | 扇入扇出 + LCOM | O(V+E) | `codegraph_coupling` |
| 深度影响分析 | 支配树 + 数据切片 | O(V+E) | `codegraph_impact_deep` |

**角色分类规则**（按优先级排序，先匹配者胜）:
1. `dead`: 从所有 entry 点反向 BFS 不可达
2. `entry`: fanIn = 0 且 fanOut > 0
3. `leaf`: fanOut = 0 且 fanIn > 0
4. `adaptor`: 跨模块边占比 > 50%
5. `core`: PageRank 排名前 20% 且 fanIn > median
6. `utility`: fanIn > P75 且 fanOut < P25

**数据依赖切片降级策略**:
- DDG 来源: codegraph.db 的 data_flow 边
- 若 DDG 不可用，退化为 backwardReachability（调用图近似切片）

**验收条件**:
- [ ] dead 节点确实从 entry 不可达
- [ ] DDG 可用时走 DDG，不可用时降级
- [ ] LCOM 属于 [0, 2]，instability 属于 [0, 1]
- [ ] 4 个新 operation 的返回格式符合 GraphOperationResult

---

## Phase 3c: 高复杂度增值 + 领域分析 -- 3 天

**目标**: 实现 4 种高复杂度算法 + 领域分析三层模型 + 5 个新 operation

| 任务 | 算法/功能 | 复杂度 | 新 Operation |
|------|----------|--------|-------------|
| Louvain 社区检测 | 社区边界发现 | O(V*logV) | `codegraph_community` |
| Katz 中心性 | 节点重要性 | O(k*E) | `codegraph_centrality` |
| Betweenness 近似 | 桥接节点 | O(k*E) | `codegraph_centrality` |
| 时间耦合 | 文件共现分析 | O(C*F^2) | `codegraph_temporal` |
| 领域分析三层模型 | domain/flow/step | -- | `grok_architecture` 增强 |

**Louvain → Leiden 升级设计** (三方专家共识 P0):

> **重要**: 三方专家一致确认 Louvain 必须升级为 Leiden。Leiden 是 Louvain 的严格改进版，
> 三项目 (CRG/graphify/GitNexus) 全部选择 Leiden 而非 Louvain。

**Leiden 核心改进** (vs 当前 Louvain 缺陷):
1. **添加 `1/(2m)` 归一化因子** — 当前公式 `gain = resolution * (sigmaIn - (nodeDeg * sigmaTot) / totalWeight)` 缺少归一化，正确公式: `gain = (sigmaIn / totalWeight) - (nodeDeg * sigmaTot) / (totalWeight * totalWeight)` 其中 totalWeight = 2m
2. **添加 refinement phase** — Leiden 在每次迭代后有 refinement 阶段，将节点从过大的社区拆出，避免 Louvain 的"不良连接"问题
3. **添加多级聚合** — 社区聚合成超级节点后的第二阶段，当前只有单层节点移动
4. **确定性保证** — 固定种子 PRNG (seed=42 或 mulberry32 seed=0xc0de)，输入排序: `nodes.sort()` + `edges.sort((a,b) => a[0]-b[0] || a[1]-b[1])`
5. **自适应分辨率** — `resolution = Math.max(0.05, 1.0 / Math.log10(Math.max(n, 10)))` (来自 CRG)
6. **过大社区拆分** — >25% 节点的社区递归拆分 (resolution=0.5)

**Leiden 算法三阶段**:
```
Phase 1 (Local Moving): 每个节点尝试移动到邻居社区，选择 ΔQ 最大的
Phase 2 (Refinement): 将过大社区中的节点拆出，检查是否应独立
Phase 3 (Aggregation): 社区→超级节点，重新构建图，重复 Phase 1
```

**收敛条件**: 内层 -- 本轮无节点移动 或 delta Q < epsilon；外层 -- modularity 增益 < epsilon 或达到 maxLevels (默认 10)
**迭代限制**: `n_iterations=2` (防指数爆炸，来自 CRG)
**超时保护**: 60s 超时→单社区回退 (来自 GitNexus)

**resolution 参数**: 默认 1.0，自适应: `max(0.05, 1/log10(N))`
**resolution limit 缓解**: 增加 `minCommunitySize` 参数（默认 3），小于此阈值的社区不合并
**多分辨率支持**: `codegraph_community` operation 支持 `resolutions: number[]` 参数（默认 [0.5, 1.0, 2.0]），多次运行取并集，确保小模块不被吞没
**label** 由上层（CodegraphTool/GrokManager）通过 LLM 生成，GraphEngine 只返回 id+nodes+size

**边权** (来自 CRG): CALLS=1.0, INHERITS=0.8, IMPLEMENTS=0.7, DEPENDS_ON=0.6, IMPORTS=0.5, TESTED_BY=0.4, CONTAINS=0.3

> **TESTED_BY 决策**: TESTED_BY=0.4 不在当前 EdgeType 12 种定义中。**决策: Phase Z1 不新增 `tested_by` 类型**，当前 Leiden 实现跳过未映射的边权类型。TESTED_BY 作为 P2 后续考虑，仅在有实际测试覆盖数据源时才需要。

**Betweenness 确定性采样** (三方专家 P0):
- 默认 sampleSize=200，O(k*E) 约 0.1s
- **确定性种子**: 使用 mulberry32 PRNG (seed=0xc0de)，确保每次运行结果相同
- Fisher-Yates shuffle 使用该 PRNG 而非 Math.random()
- 精度取决于图拓扑，不保证固定误差率

**mulberry32 参考实现** (移植时直接使用):
```typescript
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const random = mulberry32(0xc0de)
// 替换所有 Math.random() 为 random()
```

**Katz 自适应 alpha** (三方专家 P1):
- 当前 alpha=0.1 硬编码，在高 hub 图上可能不收敛
- **修复**: `alpha = 0.9 / Math.sqrt(maxDegree)`，确保 `alpha < 1/lambda_max`
- **性能说明**: maxDegree 计算需要 O(V) 预计算遍历所有节点的出度。图不变时应缓存结果，避免每次调用重复计算
- 未使用边权重的问题：改为 `Katz(v) = Σ α^t * (weighted path count of length t)`

**时间耦合约束**:
- maxCommits=50000, maxFiles=500, 6 个月窗口
- **文件过滤**: 仅分析变更 >3 次的文件（从 ~500 降至 ~100），将 O(C*F^2) 从 12.5G 降至 ~500M
- 增量缓存: `.codegraph/temporal-cache.json` 持久化已解析 commit→files 映射
- git log 命令: `--name-status -M`（含重命名检测）`--no-merges`
- 30s 超时保护 + 进度回调

**DomainAnalyzer 三层模型**（UA 移植）:
- `domain`（业务域）: 通过 GraphEngine.leidenCommunity() 发现的社区映射为业务域
- `flow`（流程）: 域内的关键路径，通过 GraphEngine.dominatorTree() + backwardReachability() 识别
- `step`（步骤）: 流程中的单个操作节点
- 输出: 结构化的 domain→flow→step 层次，供 GrokManager LLM 摘要

**验收条件**:
- [ ] Leiden modularity 属于 [-0.5, 1]，每个节点恰好属于一个社区
- [ ] Leiden 确定性: 同一输入多次运行结果完全相同 (mulberry32 seed)
- [ ] Leiden 多分辨率模式下小模块（<minCommunitySize）不被吞没
- [ ] Leiden >25% 节点社区被正确拆分
- [ ] Katz 收敛后归一化 0-1
- [ ] Betweenness 采样数 <= 总节点数
- [ ] 时间耦合 coChanges >= minCoChanges
- [ ] 领域分析返回 domain/flow/step 三层结构
- [ ] 5 个新 operation（3 CodeGraph + 2 Grok）全部通过

---

## 性能目标 (Section 5)

| 指标 | 目标 | 备注 |
|------|------|------|
| 查询类 (bfs/dfs/search/scc/toposort/delta) | <10ms | O(V+E)，遍历类 |
| 分析类 (pagerank/katz/coupling/roles) | <2s | O(k*E) 或 O(V+E) |
| 深度分析类 (betweenness/louvain/temporal) | <10s | 采样近似 + 超时保护 |
| 结构指纹计算 (单文件) | <100ms | tree-sitter AST 解析 + 哈希 |
| 变更分类 (单文件) | <50ms | AST 对比 + 规则匹配 |
| 图验证 (100K 节点) | <10s | 9 项检查并行执行 |
| 领域分析 (100K 节点) | <30s | community + roles + flow 识别 |
| 非代码解析 (单文件) | <200ms | 正则/JSON 解析 |
| 全量索引 (100K LOC) | <30s | 由 codegraph CLI 处理 |
| 增量更新 | <500ms (单文件) | 三级检测 + 结构指纹 |
| 内存占用 | <200MB (100K 节点) | 加权邻接表 |

**超时保护**:
- 深度分析类操作 30s 超时 + 进度回调
- 递归算法全部使用显式栈迭代
- 最大迭代计数器: 10 * |V|

---

## 算法评审新增问题 (三方专家)

### P1 — 需要修复

**Louvain 升级为 Leiden** (算法专家 P0, 已修复):
- 当前实现缺陷: 缺少 `1/(2m)` 归一化因子 + 无 refinement phase + 无多级聚合 + 无确定性种子
- 影响: 社区质量偏差 10-20%，每次运行结果不同
- 修复: 完整实现 Leiden 三阶段 (Local Moving + Refinement + Aggregation)，见上方详细设计
- 状态: **已修复** — 设计文档已更新为 Leiden 算法

**Dominator Tree `changed` 变量作用域 bug** (架构师 P1, Phase 1a-1):
- `while (changed && iterations < maxIterations)` 中 `changed` 在循环外定义为 `const changed = true`
- `anyChanged` 是局部变量，永远不会赋值给外层 `changed`
- 结果：循环始终执行到 maxIterations，性能退化为 O(V^2)
- 修复：将 `const changed` 改为 `let changed`，循环末尾 `changed = anyChanged`
- **状态**: 已纳入 Phase 1a-1 算法修复 (0.25d)

**temporalCoupling 接口不完整** (架构师):
- `GraphEngine.temporalCoupling()` 直接 `throw new Error`，要求在 Tool 层实现
- `codegraph_temporal` 和 `grok_hotspots` 各自独立实现了 git log 解析（重复 ~50 行）
- 违反"算法层独立于工具层"的设计原则
- 修复：将 git log 解析逻辑下沉到 GraphEngine

**PageRank maxIter 不足** (算法专家):
- `maxIter=100` 在大图上可能不够，导致未收敛就返回
- 修复：改为相对收敛检测（L1 范数 < epsilon 即停止），或增加 maxIter 到 200

### P2 — 可标记 experimental

**Katz 中心性使用频率低** (算法专家):
- 与 PageRank 功能重叠，实际场景很少需要
- 建议：标记为 experimental，降低维护优先级
- **已修复**: alpha 自适应 `0.9/sqrt(maxDegree)`，收敛性问题已解决

**Betweenness 近似精度存疑** (算法专家):
- 采样 sampleSize=200，计算成本高，精度取决于图拓扑
- 建议：标记为 experimental，降低维护优先级
- **已修复**: 确定性种子 mulberry32 (seed=0xc0de)，结果可复现
