# 三方专家深度评审报告

> 日期: 2026-06-05
> 评审角色: 算法专家 + Agent工具专家 + 架构师
> 评审范围: 统一实施方案全部 10 份文档 + 三项目源码
> 评审方法: 源码级验证 + 数学分析 + 架构评估

---

## 1. 评审结论总览

### 1.1 三方评分

| 维度 | 算法专家 | Agent工具专家 | 架构师 | 综合 |
|------|:--------:|:------------:|:------:|:----:|
| 算法正确性 | 7/10 | — | — | 7/10 |
| 数学严谨性 | 6/10 | — | — | 6/10 |
| Tool 设计 | — | 7/10 | — | 7/10 |
| 用户体验 | — | 6/10 | — | 6/10 |
| 架构合理性 | — | — | 8/10 | 8/10 |
| 安全性 | — | — | 5/10 | 5/10 |
| 可扩展性 | — | — | 7/10 | 7/10 |
| **综合** | **6.5/10** | **6.5/10** | **6.7/10** | **6.6/10** |

### 1.2 三方共识（3 项）

| # | 共识 | 算法专家 | 工具专家 | 架构师 |
|---|------|:--------:|:--------:|:------:|
| 1 | **Louvain 必须升级为 Leiden** | 缺少 refinement phase + 多级聚合 | — | 100K 节点超时风险 |
| 2 | **安全层工期严重不足** | — | MCP 模式需查询沙箱 | 0.5天→2天，覆盖 SSRF+注入+资源限制 |
| 3 | **Phase 1 破坏性变更风险最高** | EdgeMeta[] 影响全部 15 种算法 | 影响 21 个 operation 返回值 | 14 处适配 + 11 测试工厂 + 接口级联 |

### 1.3 关键发现（按严重性排序）

| # | 发现 | 来源 | 严重性 | 影响 |
|---|------|------|:------:|------|
| 1 | Louvain modularity 公式缺少 `1/(2m)` 归一化 | 算法专家 | **P0** | 社区质量偏差 |
| 2 | Betweenness 采样无确定性种子 | 算法专家 | **P0** | 每次运行结果不同 |
| 3 | Katz alpha=0.1 可能在高 hub 图上不收敛 | 算法专家 | **P1** | 需要自适应 alpha |
| 4 | Tool 21 个 operation 参数语义泄漏 | 工具专家 | **P1** | token 浪费 + 选择错误 |
| 5 | MCP 模式无查询沙箱和资源限制 | 架构师 | **P1** | 无限遍历攻击 |
| 6 | Prompt injection 通过 Grok JSON | 架构师 | **P1** | 恶意指令执行 |
| 7 | codegraph.db schema 未验证 | 架构师 | **P1** | Phase 1 实施可能失败 |
| 8 | deduplicateTraces 子串匹配不精确 | 算法专家 | **P2** | 可能误删非子集 trace |
| 9 | 熵门控 2.5 bits/char 几乎无过滤效果 | 算法专家 | **P3** | 计算资源浪费 |

---

## 2. 算法专家评审详情

### 2.1 Leiden vs Louvain 深度对比

**ola-cc Louvain 实现缺陷**:

1. **缺少 `1/(2m)` 归一化因子**。公式 `gain = resolution * (sigmaIn - (nodeDeg * sigmaTot) / totalWeight)` 中，当 `totalWeight` 已经是 `2m` 时，正确公式应为 `(sigmaIn / totalWeight) - (nodeDeg * sigmaTot) / totalWeight^2`。当前写法分子分母不匹配。

2. **缺少多级聚合**。只有单层节点移动，没有社区聚合成超级节点后的第二阶段。收敛到局部最优，modularity 比完整 Louvain 低 10-20%。

3. **没有随机化节点遍历顺序**。确定性顺序使结果对节点输入顺序敏感。

4. **没有 Leiden 的 refinement phase**。Leiden 在每次迭代后有 refinement 阶段，将节点从过大的社区拆出，避免 Louvain 的"不良连接"问题。

**CRG 的 resolution 自适应公式最优**: `max(0.05, 1/log10(N))`。100 节点图 resolution=0.5，10K 节点图 resolution=0.25，30K+ 节点图 resolution=0.18。正确解决大图碎片化问题。

**Graphify 的 cohesion 二次分割是独特增值**: `cohesion_score < 0.05` 检测文档中心节点连接不相关子系统的场景。

### 2.2 RRF 搜索数学分析

**K=60 理论依据**: 来自 Cormack et al. (2014) TREC 实验的经验最优值。K 控制排名差异敏感度：K >> rank 时差异被抹平，K << rank 时高位排名获得不成比例优势。

**CRG Boost 启发式偏差分析**:
- PascalCase→Class 1.5x, snake_case→Function 1.5x: 有偏但合理
- **级联乘法风险**: 混合大小写查询（如 `APIHandler`）同时匹配 PascalCase 规则和 Class boost，产生 `1.5 * 2.0 = 3.0x` 级联效应
- `_qualified` 2.0x boost 过大: RRF 分数在 `1/61 ~ 1/110` 范围内，2.0x 可将 rank 50 推到约 rank 25

### 2.3 执行流入口点评分公式

**GitNexus 公式 `calleeCount/(callerCount+1) * exportMult * nameMult * frameworkMult`**:
- `calleeCount/(callerCount+1)` 无上界，100 个 callee 且 0 caller 得分为 100
- utility-pattern 惩罚 0.3x 会导致 `get*`/`set*` 前缀函数被严重低估
- **CRG 版本更简洁**，使用细粒度权重体系（0.1-1.5 范围），避免乘法爆炸

**BFS max_depth 10 vs 15**: 代码调用图直径通常 8-12，depth 10 覆盖 92-95%，depth 15 覆盖 97-99%。差距 3-5% 但额外成本主要是内存而非时间。

### 2.4 PageRank/Katz/Betweenness 审查

| 算法 | 正确性 | 关键问题 |
|------|:------:|---------|
| PageRank | ✅ | 悬挂节点处理正确，归一化正确 |
| Katz | ⚠️ | alpha=0.1 可能不收敛（需 `alpha < 1/lambda_max`），未使用边权重 |
| Betweenness | ⚠️ | Brandes 算法正确，但 **采样无确定性种子** |
| Louvain | ❌ | 缺少归一化因子 + 无多级聚合 |

### 2.5 6 层去重参数评估

| 参数 | 值 | 评估 |
|------|:--:|------|
| MinHash permutations | 128 | ✅ 标准值，5% Jaccard 估计误差 |
| LSH threshold | 0.7 | ✅ 对应约 80-85% 字符相似度 |
| Jaro-Winkler 阈值 | 92.0 | ✅ 允许 2-3 字符编辑距离 |
| 熵门控 | 2.5 bits/char | ⚠️ 过于宽松，几乎不过滤正常标识符 |
| 短标签阻断 | DL≤1 | ✅ 正确的保守策略 |

---

## 3. Agent 工具专家评审详情

### 3.1 Tool Schema 设计问题

**核心问题**: 21 个 operation 共享一个扁平 `z.object`，所有参数对模型可见。

| 问题 | 影响 | 建议 |
|------|------|------|
| 参数语义泄漏 | token 浪费 + 选择错误 | 分层：核心 5 个扁平，分析 4 个简述，高级 12 个隐藏 |
| `codegraph_` 前缀冗余 | 每个 operation 浪费 10 字符 | 去掉前缀，改为 `context`/`search`/`scc` |
| `impact` + `impact_deep` 冗余 | 增加选择困难 | 合并为 `impact` + `depth` 参数 |
| `explore` 是 `search` 子集 | 无独立价值 | 去掉 |
| trace 自然语言解析脆弱 | 含空格符号解析失败 | 改为显式 `from`/`to` 参数 |

### 3.2 MCP 服务器模式

**GitNexus 的 Resource+Tool 混合模式值得借鉴**:
- 只读数据（status/files）通过 Resource 暴露
- 写操作（init/sync）通过 Tool 暴露
- 减少 tool_use token 消耗

**安全约束缺失**:
- `codegraph_temporal` 使用 `execSync('git log ...')` 阻塞事件循环
- 无速率限制（`codegraph_sync` 可被模型重复触发）

### 3.3 Agent 编排模式

**ola-cc 缺乏引导式编排**: 模型需自行决定调用顺序，对不熟悉工具的模型导致低效试错。

**建议**:
1. description 中添加推荐工作流: `context → search → callers/impact → community`
2. 考虑 `codegraph_workflow` 复合 operation，接收意图自动编排
3. QueryEngine 识别 graph 查询，注入 "先用 graph tools" 的 prompt 片段

### 3.4 用户体验

**分层揭示建议**:

| 层级 | operation | 描述策略 |
|------|-----------|---------|
| 核心 (5) | context/search/callers/impact/sync | 完整描述 |
| 分析 (4) | trace/community/pagerank/coupling | 简短提及 |
| 高级 (12) | scc/toposort/delta/roles/slice/centrality/temporal/... | "15+ advanced algorithms available" |

**智能默认值**: `maxNodes` 应按 operation 设置不同默认值（scc/toposort 应返回全部）。

---

## 4. 架构师评审详情

### 4.1 模块依赖关系

**风险评级: Medium**

- **Z 系列与 Phase 6 重叠**: Phase Z1 已重新定义 EdgeType，Phase 6a 仍独立做 EdgeKind 映射验证。两套映射表可能不一致。
- **OperationRouter 依赖模糊**: 应明确为纯消费者（只读），不被其他模块反向依赖。
- **DataSourceAdapter 缺失**: 当前硬编码两个数据源，Z1-Z5 的内置 extraction 是第三种加载路径。

**建议**: 将 Phase 6a 的 EdgeKind 验证合并到 Z1 验收条件；DataSourceAdapter 从 P2 提升到 P1。

### 4.2 数据模型一致性

**风险评级: High**

- **mergedKey 污染**: 当前 `addEdge()` 使用 `${to}::${type}` 合并 key，GraphEngine 需 `filter(k => !k.includes('::'))` hack。EdgeMeta[] 改造需彻底清理。
- **codegraph.db schema 未验证**: `loadCodegraph()` 只 SELECT 7 个字段，扩展到 21 字段需验证 db 是否实际包含这些列。
- **接口变更级联**: `adjacency` 类型变更影响全部 15 种算法 + GraphSnapshot + CodegraphTool 全部返回值。

**建议**: 实施前验证 codegraph.db 实际 schema；为 GraphData 接口变更编写 adapter 层。

### 4.3 性能工程

**风险评级: Medium**

- **EdgeMeta[] 内存增长约 30%**: 54K 节点从 120MB→156MB，仍在 200MB 预算内。
- **LRU 1000 节点命中率**: 对于全图遍历算法（PageRank 等）命中率接近 0。应定位为节点详情查询缓存。
- **FTS5 索引**: Z1-Z5 内置 extraction 生成的 db 需包含 FTS5 索引，否则搜索失效。

### 4.4 安全架构

**风险评级: High**

| 攻击面 | 风险 | 缓解 |
|--------|------|------|
| MCP 查询无限遍历 | 环路中 BFS 540K 次迭代 | 查询结果大小上限 10K 节点 |
| Prompt injection via Grok JSON | docstring/signature 含注入指令 | label sanitization (HTML 转义) |
| bun:sqlite 路径注入 | projectRoot 拼接路径遍历 | 路径规范化 + 白名单 |
| 资源耗尽 | 无并发限制、无速率限制 | 单用户速率限制 + 并发查询上限 |
| MCP 认证缺失 | 外部进程可访问图数据 | API key 或本地 socket 限制 |

**建议**: F-89 工期从 0.5 天提升到 2 天；增加查询结果大小上限；GraphStore 返回给 LLM 的字段需 sanitization。

---

## 5. 三方综合建议

### 5.1 立即修复 (P0, 阻塞 Phase 1)

| # | 修复项 | 来源 | 工期 | 具体行动 |
|---|--------|------|:----:|---------|
| 1 | Louvain modularity 归一化修复 | 算法专家 | 0.5d | 添加 `1/(2m)` 因子 + 多级聚合 |
| 2 | Betweenness 确定性种子 | 算法专家 | 0.5d | 使用 mulberry32 PRNG |
| 3 | 验证 codegraph.db schema | 架构师 | 0.5d | 检查 nodes 表实际列数 |
| 4 | GraphStore EdgeMeta[] 改造 | 架构师 | 1.5d | addEdge/loadCodegraph/loadGrok/14处适配 |

### 5.2 Phase 1 内修复 (P1)

| # | 修复项 | 来源 | 工期 | 具体行动 |
|---|--------|------|:----:|---------|
| 5 | 安全层工期提升 | 架构师 | +1.5d | F-89 从 0.5d→2d，覆盖 MCP 查询沙箱 |
| 6 | Tool operation 分层揭示 | 工具专家 | 0.5d | 核心 5 / 分析 4 / 高级 12 |
| 7 | 合并冗余 operation | 工具专家 | 0.5d | impact+impact_deep, 去掉 explore |
| 8 | DataSourceAdapter 接口 | 架构师 | 0.5d | 从 P2 提升到 P1 |
| 9 | Katz 自适应 alpha | 算法专家 | — | 已合并到 Phase 1a-1 (0.25d) |

### 5.3 后续优化 (P2)

| # | 修复项 | 来源 | 工期 |
|---|--------|------|:----:|
| 10 | deduplicateTraces 子数组精确匹配 | 算法专家 | 0.5d |
| 11 | 推荐工作流 description | 工具专家 | 0.5d |
| 12 | MCP Resource+Tool 混合模式 | 工具专家 | 1d |
| 13 | Prompt injection sanitization | 架构师 | 1d |
| 14 | LRU 缓存策略文档化 | 架构师 | 0.5d |

### 5.4 工期影响

| 类别 | 原工期 | 新增 | 调整后 |
|------|:------:|:----:|:------:|
| P0 修复 | — | +3d | 3d |
| P1 修复 | — | +3.5d | 3.5d |
| P2 优化 | — | +3.5d | 3.5d |
| **总计** | 75.5d | **+10d** | **85.5d** |

### 5.5 更新后的时间线建议

```
Phase 0 (已完成)
  └── Phase 1a: P0 修复 (3d) ← 新增
        └── Phase 1b: GraphStore + GraphEngine + 结构指纹 (7d)
              ├── Phase 2: 增量同步 + 图验证 + 安全层(2d) + diff 增强
              ├── Phase 3a → 3b → 3c (Leiden替换 + 执行流 + 知识缺口)
              ├── Phase 4 (Tour + 非代码解析) → Phase 5 (路由 + MCP)
              └── Phase Z1 → Z2 → Z3 → Z4 → Z5 (零依赖 + 数据完整性)
                    └── Phase 6a → 6e (codegraph 移植)
```

---

## 6. 附录：三方分歧记录

| # | 议题 | 算法专家 | 工具专家 | 架构师 |
|---|------|---------|---------|--------|
| 1 | CRG Boost 2.0x 是否过大 | 是（级联风险） | 未关注 | 未关注 |
| 2 | operation 粒度 | — | 应合并 | 未关注 |
| 3 | LRU 定位 | — | — | 应限定为节点查询缓存 |
| 4 | Leiden 工期 | 1d 足够 | — | 需含回归测试 |

**分歧处理**: 无重大分歧，各方关注点互补。

---

## 7. 修复状态跟踪

> 以下记录三方专家评审发现的问题在设计文档中的修复状态。

### P0 修复状态

| # | 问题 | 修复文档 | 状态 |
|---|------|---------|:----:|
| 1 | Louvain modularity 缺少 `1/(2m)` 归一化 | 02-graphengine-algorithms.md §Leiden升级设计 | ✅ 已修复 |
| 2 | Betweenness 采样无确定性种子 | 02-graphengine-algorithms.md §Betweenness确定性采样 | ✅ 已修复 |
| 3 | 验证 codegraph.db schema | 01-graphstore-redesign.md §修复0 | ✅ 已修复 |
| 4 | GraphStore EdgeMeta[] 改造 | 01-graphstore-redesign.md §修复3 | ✅ 已修复 |

### P1 修复状态

| # | 问题 | 修复文档 | 状态 |
|---|------|---------|:----:|
| 5 | 安全层工期提升 0.5d→2d | 2026-06-05-plan.md F-89 | ✅ 已修复 |
| 6 | Tool operation 分层揭示 | 2026-06-05-plan.md F-93 | ✅ 已修复 |
| 7 | 合并冗余 operation | 待 Phase 1a 实施时处理 | ⏳ 待实施 |
| 8 | DataSourceAdapter 接口 | 01-graphstore-redesign.md + 07文档 | ✅ 已修复 |
| 9 | Katz 自适应 alpha | 02-graphengine-algorithms.md §Katz自适应alpha | ✅ 已修复 |

### P2 修复状态

| # | 问题 | 状态 |
|---|------|:----:|
| 10 | deduplicateTraces 子数组精确匹配 | ⏳ 待实施 |
| 11 | 推荐工作流 description | ⏳ 待实施 |
| 12 | MCP Resource+Tool 混合模式 | ⏳ 待实施 |
| 13 | Prompt injection sanitization | ⏳ 待实施 |
| 14 | LRU 缓存策略文档化 | ⏳ 待实施 |

### 时间线修复

| 项目 | 修复前 | 第一轮修复 | 第二轮修复 | 变化 |
|------|:------:|:----------:|:----------:|:----:|
| 总工期 | 75.5d | 85.5d | **87.5d** | +12d |
| Phase 1a | — | 3d | **5d** | +2d |
| Phase 1 | 7d | 1a(3d)+1b(7d) | **1a(5d)+1b(7d)** | +5d |
| Phase 2 | 4.5d | 6d | 6d | +1.5d |
| F-93 工期 | — | 0.5d | **1.5d** | +1d |
| 功能点 | 92 | 95 | **95** | +3 |

---

## 8. 第二轮评审新增问题 (2026-06-05)

### 新增 P0

| # | 问题 | 来源 | 修复状态 |
|---|------|------|:--------:|
| P0-5 | GraphData 接口 `EdgeMeta[]` 与类实例 `EdgeMeta` 类型不一致 | 架构师 | ✅ 已纳入 Phase 1a-2 |

### 新增 P1

| # | 问题 | 来源 | 修复状态 |
|---|------|------|:--------:|
| P1-10 | Phase 1a 3d→5d 工期扩展 | 架构师 | ✅ 已修复 |
| P1-11 | F-93 0.5d→1.5d 工期扩展 | 工具专家 | ✅ 已修复 |
| P1-12 | Leiden Phase 1a vs 3c 职责边界明确化 | 算法专家 | ✅ 已修复 (1a-1修正后Louvain在3c时被完整替换) |
| P1-13 | Katz maxDegree O(V) 预计算性能标注 | 算法专家 | ✅ 已修复 |
| P1-14 | 安全层查询沙箱遍历中截断 vs 结果后截断 | 工具专家 | ⏳ 待实施 |

### 新增 P2

| # | 问题 | 来源 | 修复状态 |
|---|------|------|:--------:|
| P2-15 | 边权表 TESTED_BY 不在 EdgeType 中 | 算法专家 | ✅ 已标注 |
| P2-16 | 多分辨率并集合并策略未定义 | 算法专家 | ⏳ 待 Phase 3c |
| P2-17 | mulberry32 参考实现未给出 | 算法专家 | ✅ 已补充 |
| P2-18 | DominatorTree const→let bug 未在 Phase 1a 列出 | 架构师 | ✅ 已纳入 Phase 1a-1 |

---

## 9. 第三轮评审 (2026-06-05) — 跨文档一致性 + 源码验证

### 9.1 评审方法

- 跨文档一致性检查（Phase 编号、天数、功能计数）
- 二轮修复正确性验证
- 源码级确认（7 项 P0/P1 问题与 `GraphEngine.ts` / `GraphStore.ts` 完全对应）

### 9.2 三方评分更新

| 维度 | 二轮评分 | 三轮评分 | 变化原因 |
|------|:-------:|:-------:|---------|
| 算法正确性 | 7/10 | **9/10** | Leiden/mulberry32/Katz/归一化全部修复 |
| 数学严谨性 | 6/10 | **8/10** | 归一化因子 + 确定性种子 + 自适应 alpha |
| Tool 设计 | 7/10 | **8/10** | 三层揭示 + operation 合并 |
| 架构合理性 | 8/10 | **9/10** | DataSourceAdapter + schema 验证 + 类型对齐 |
| 安全性 | 5/10 | **7/10** | 2d 安全层 + MCP 沙箱 |
| 跨文档一致性 | — | **6/10** | 发现并修复 3 P0 + 7 P1 |
| **综合** | **6.6/10** | **8.5/10** | +1.9 |

### 9.3 P0 跨文档一致性修复

| # | 问题 | 涉及文档 | 修复 |
|---|------|---------|------|
| P0-1 | Phase Z1-Z5 总天数不一致 | 07文档 | 15.5d→17.5d (含 F-85/82/86/95) |
| P0-2 | 功能计数不一致 | 09文档 | 92→95 (含 F-93/94/95) |
| P0-3 | Phase Z1 天数不一致 | 07文档 | 3d→3.5d (含 F-95) |

### 9.4 P1 跨文档一致性修复

| # | 问题 | 涉及文档 | 修复 |
|---|------|---------|------|
| P1-1 | Phase 实施顺序过时 | 05文档 §12.3 | 更新为 1a(5d)+1b(7d) 新版结构 |
| P1-2 | DataSourceAdapter 仍列 P2 | 05文档 | 标注已提升到 P1 (F-95) |
| P1-3 | Phase 6f 描述过时 | 04文档 | 标注"已并入 Phase Z1-Z5" |
| P1-4 | 安全层天数未更新 | 03文档 | 03文档不含安全层，主计划已正确显示 2d |
| P1-5 | TESTED_BY 归属未定 | 02文档 | 决策: 不新增类型，跳过未映射边权 |
| P1-6 | Leiden 职责边界文档重复 | 主计划 | 明确 1a-1 修正的 Louvain 在 3c 时被完整替换 |
| P1-7 | Katz 修复重复 | 10文档 P1 #9 | 标注已合并到 Phase 1a-1 |

### 9.5 源码验证结果

| 问题 | 文件:行号 | 现状 | 设计修复 |
|------|-----------|------|---------|
| Louvain 归一化 | GraphEngine.ts:908 | 缺 `1/(2m)` | Phase 1a-1 |
| Betweenness 种子 | GraphEngine.ts:860 | Math.random() | Phase 1a-1 mulberry32 |
| Katz 硬编码 | GraphEngine.ts:784 | alpha=0.1 | Phase 1a-1 自适应 |
| DominatorTree bug | GraphEngine.ts:463 | const changed 死代码 | Phase 1a-1 |
| GraphData 类型 | GraphStore.ts:95 vs 135 | 接口[] vs 实例 | Phase 1a-2 |
| mergedKey 污染 | GraphStore.ts:367 | ${to}::${type} | Phase 1a-2 数组存储 |
| Schema 未验证 | GraphStore.ts:215 | 仅 SELECT 7 字段 | Phase 1a-2 |

**结论**: 设计文档修复方案与源码问题一一对应。代码未修改是预期行为（Phase 1a 尚未启动）。

### 9.6 遗留 P2 观察项

| # | 问题 | 状态 |
|---|------|------|
| P2-1 | Phase 2 天数精确值存疑 (6d vs 6.5d) | 四舍五入吸收 |
| P2-2 | 07文档与主计划 Z 阶段任务列表同步 | ✅ 已修复 |
| P2-3 | 多分辨率并集合并策略未定义 | ⏳ 待 Phase 3c |
