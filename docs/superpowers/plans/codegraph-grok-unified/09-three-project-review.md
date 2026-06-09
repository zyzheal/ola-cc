# 三项目多专家深度评审分析

> 日期: 2026-06-05
> 评审项目: code-review-graph, graphify, GitNexus
> 评审维度: 设计哲学、架构原理、功能定位、可移植性、模块化、增强价值
> 评审角色: Agent工具专家 + 算法专家 + 架构师

---

## 1. 三项目概览

### 1.1 基本信息

| 维度 | code-review-graph | graphify | GitNexus |
|------|-------------------|----------|----------|
| 语言 | Python 3.10+ | Python 3.10+ | TypeScript (Node 22+) |
| 包名 | code-review-graph | graphifyy | gitnexus |
| 协议 | MCP stdio | MCP stdio | MCP + HTTP + CLI |
| 核心依赖 | tree-sitter, networkx, sqlite | tree-sitter, networkx, datasketch | tree-sitter, graphology, ladybugdb |
| 代码规模 | ~12K 行 + 32 测试 | ~15K 行 + 75 测试 | ~30K 行 + eval 框架 |
| 节点类型 | 5 (File/Class/Function/Type/Test) | 动态 (33 种语言 AST) | 30 种 |
| 边类型 | 8 种 | 动态 (import/call/inherit) | 21 种 |
| 图存储 | SQLite | NetworkX (内存) | LadybugDB (嵌入式) |
| 社区检测 | Leiden (igraph) | Leiden/Louvain | Leiden (graphology) |
| 搜索 | FTS5 + 向量 + RRF | IDF 加权三优先级 | BM25 + 向量 + RRF |
| 增量更新 | git diff + SHA-256 | manifest.json mtime+hash | git diff + staleness |

### 1.2 设计哲学对比

| 项目 | 核心问题 | 核心方法 | 独特价值 |
|------|---------|---------|---------|
| **code-review-graph** | AI 代码审查时 token 浪费 | 预计算影响半径，缩小审查范围 | 变更影响分析 + 风险评分 + 重构预览 |
| **graphify** | AI 助手不理解大型代码库 | 代码→知识图谱，71.5x token 压缩 | 33 种语言 AST + 6 层去重 + 安全层 |
| **GitNexus** | AI 不了解代码结构关系 | 预计算关系智能 (Precomputed Relational Intelligence) | 12 阶段 DAG 管道 + 跨仓库影响分析 |

---

## 2. 能力逐项分析

### 2.1 三项目独有能力

| # | 能力 | 来源 | ola-cc 是否具备 | 价值评估 |
|---|------|------|:--------------:|---------|
| 1 | **Leiden 社区检测 + 稳定性保证** | 三者均有 | ⚠️ 有 Louvain，无 Leiden | P1 |
| 2 | **RRF 混合搜索融合** | CRG + GitNexus | ❌ 仅有 FTS5 | P1 |
| 3 | **变更影响风险评分** | CRG | ❌ 仅有影响半径 | P1 |
| 4 | **执行流检测 (BFS 追踪)** | CRG + GitNexus | ❌ | P1 |
| 5 | **边置信度三级标记** | CRG + GitNexus | ❌ | P2 |
| 6 | **6 层去重管线** | graphify | ❌ | P2 |
| 7 | **预计算关系智能** | GitNexus | ❌ | P1 |
| 8 | **12 阶段 DAG 管道** | GitNexus | ❌ | P2 |
| 9 | **跨仓库影响分析** | GitNexus + CRG | ❌ | P3 |
| 10 | **重构预览/应用工作流** | CRG | ❌ | P2 |
| 11 | **知识缺口分析** | CRG | ❌ | P2 |
| 12 | **惊喜连接评分** | CRG | ❌ | P3 |
| 13 | **Hub/Bridge 节点检测** | CRG | ⚠️ 有 classifyRoles | P2 |
| 14 | **Token 节省度量** | CRG + graphify | ❌ | P3 |
| 15 | **安全层 (SSRF/prompt injection)** | graphify | ❌ | P2 |
| 16 | **图快照 diff** | CRG | ⚠️ 有 delta 操作 | P2 |
| 17 | **Wiki 自动生成** | CRG + GitNexus | ❌ | P3 |
| 18 | **MCP 服务器模式** | 三者均有 | ❌ | P2 |
| 19 | **多格式导出** | graphify + CRG | ❌ | P3 |
| 20 | **SWE-bench 评估** | GitNexus | ❌ | P3 |

---

## 3. 专家评审结论

### 3.1 Agent 工具专家评审

**评审焦点**: 与 ola-cc Tool 系统的集成性、MCP 协议兼容性、用户体验

#### 可直接移植的能力 (P1)

| # | 能力 | 来源 | 移植目标 | 预估工期 | 理由 |
|---|------|------|---------|:-------:|------|
| 1 | **Leiden 社区检测** | 三者 | GraphEngine.ts | 1 天 | 替换现有 Louvain，确定性种子 + 稳定性保证 |
| 2 | **RRF 混合搜索** | CRG | GraphStore.ts | 0.5 天 | FTS5 + 语义向量融合，K=60 |
| 3 | **执行流检测** | CRG/GitNexus | GraphEngine.ts | 1 天 | BFS 追踪入口点→终端，关键性评分 |
| 4 | **变更影响风险评分** | CRG | CodegraphTool | 0.5 天 | 多因素风险矩阵 (流参与/社区穿越/测试覆盖) |
| 5 | **预计算上下文** | GitNexus | CodegraphTool | 1 天 | 索引时预计算聚类/流/评分，查询一次返回 |

#### 建议独立模块的能力 (P2)

| # | 能力 | 来源 | 模块位置 | 理由 |
|---|------|------|---------|------|
| 1 | **MCP 服务器** | 三者 | `src/services/mcp/` | 独立于 Tool 系统，可选启用 |
| 2 | **边置信度系统** | CRG/GitNexus | GraphStore.ts 扩展 | EdgeMeta 增加 confidence 字段 |
| 3 | **知识缺口分析** | CRG | GraphEngine.ts | 孤立节点/薄社区/未测试热点检测 |
| 4 | **重构预览/应用** | CRG | `src/tools/RefactorTool/` | 独立 Tool，预览→确认→应用 |
| 5 | **安全层** | graphify | `src/utils/security.ts` | SSRF 防护、prompt injection 防护 |

#### 不建议移植的能力

| # | 能力 | 来源 | 理由 |
|---|------|------|------|
| 1 | 28+ 平台技能安装 | graphify | ola-cc 自有 Skill 系统 |
| 2 | 跨仓库影响分析 | GitNexus | 复杂度高，当前无多仓库需求 |
| 3 | 向量嵌入 | 三者 | 设计决策排除，FTS5+BM25 替代 |
| 4 | LadybugDB | GitNexus | SQLite 已满足，引入新 DB 增加复杂度 |
| 5 | LLM 后端抽象 | graphify | ola-cc 已有 API client 层 |

### 3.2 算法专家评审

**评审焦点**: 算法正确性、性能特征、与 GraphEngine 的兼容性

#### Leiden vs Louvain 对比

| 维度 | Louvain (当前) | Leiden (建议) |
|------|:-------------:|:------------:|
| 连通性保证 | ❌ 可能产生断开社区 | ✅ 保证社区连通 |
| 运行时间 | O(n log n) | O(n log n) |
| 确定性 | ⚠️ 依赖实现 | ✅ 固定种子 PRNG |
| 稳定性 | ❌ 每次运行可能不同 | ✅ 图重映射保证 ID 稳定 |
| ola-cc 现状 | 已实现 (Louvain) | 需新增 |

**结论**: Leiden 是 Louvain 的严格改进，建议替换。三项目均选择 Leiden 而非 Louvain，印证了这一选择。

#### RRF 混合搜索算法

```
RRF_score(doc) = Σ 1/(K + rank_i(doc))
其中 K=60 (标准值)
```

**优势**: 无需归一化不同信号的分数，天然融合异构排序。
**与 FTS5 集成**: FTS5 BM25 提供文本相关性排序，RRF 融合额外信号（类型匹配、路径匹配）。

#### 执行流检测算法

```
1. 入口点评分: score = (callees/(callers+1)) × exportMult × nameMult × frameworkMult
2. BFS 追踪: maxDepth=10, maxBranch=4, minSteps=3
3. 去重: 子集移除 + 端点对去重 (保留最长路径)
4. 关键性评分: 文件扩展/外部调用/安全敏感度/测试覆盖/深度
```

**与 ola-cc 集成**: GraphEngine 已有 BFS/DFS，可复用。入口点评分可加入 classifyRoles。

#### 边置信度系统

| 置信度层级 | 分数范围 | 来源 | 含义 |
|-----------|---------|------|------|
| EXTRACTED | 1.0 | AST 显式声明 | 确定关系 |
| INFERRED | 0.55-0.95 | 启发式推断 | 可能关系 |
| AMBIGUOUS | 0.1-0.5 | 弱信号 | 不确定关系 |

**与 ola-cc 集成**: EdgeMeta 已有 weight 字段，可增加 confidence 字段。GraphEngine 算法可利用 confidence 做加权计算。

### 3.3 架构师评审

**评审焦点**: 模块化、可维护性、与现有架构的兼容性

#### 模块化建议

```
src/services/graph/
├── GraphEngine.ts              # [增强] +Leiden, +执行流检测, +知识缺口
├── GraphStore.ts               # [增强] +RRF搜索, +边置信度, +安全层
├── IncrementalSync.ts          # [不变]
├── StructuralFingerprint.ts    # [不变]
├── ChangeClassifier.ts         # [增强] +风险评分
├── GraphValidator.ts           # [不变]
├── DomainAnalyzer.ts           # [不变]
├── OperationRouter.ts          # [新增]
├── ProcessDetector.ts          # [新增] 执行流检测 (来自 CRG/GitNexus)
├── KnowledgeGapAnalyzer.ts     # [新增] 知识缺口分析 (来自 CRG)
└── parsers/                    # [不变]

src/tools/
├── CodegraphTool/              # [增强] +预计算上下文, +风险评分
├── GrokTool/                   # [不变]
├── RefactorTool/               # [新增] 重构预览/应用 (来自 CRG)
└── McpServer/                  # [新增] MCP 服务器 (可选)
```

#### 数据模型扩展

```typescript
// EdgeMeta 扩展 (与统一方案 F-53 合并)
export interface EdgeMeta {
  type: EdgeType
  weight: number
  confidence?: number        // [新增] 来自 CRG/GitNexus
  confidenceTier?: 'extracted' | 'inferred' | 'ambiguous'  // [新增]
  sourceLine?: number        // [新增] 来自统一方案
  provenance?: string        // [新增] 来自统一方案
}

// NodeMetadata 扩展 (与统一方案 F-52 合并)
export interface NodeMetadata {
  // ... 现有字段 + 统一方案 13 新字段 ...
  communityId?: number       // [新增] 来自 CRG/GitNexus
  processIds?: string[]      // [新增] 来自 GitNexus
  knowledgeGap?: string      // [新增] 来自 CRG
}
```

#### 新增功能清单

| # | 功能 | 来源 | Phase | 天数 | 依赖 |
|---|------|------|:-----:|:----:|------|
| F-81 | Leiden 社区检测替换 Louvain | 三者 | 3c | 1 | F-12 |
| F-82 | RRF 混合搜索融合 | CRG/GitNexus | Z3 | 0.5 | F-60 |
| F-83 | 执行流检测 (BFS 追踪) | CRG/GitNexus | 3b | 1 | F-02 |
| F-84 | 变更影响风险评分 | CRG | 3b | 0.5 | F-83 |
| F-85 | 边置信度系统 | CRG/GitNexus | Z1 | 0.5 | F-53 |
| F-86 | 预计算上下文 (索引时) | GitNexus | Z4 | 1 | F-73 |
| F-87 | 知识缺口分析 | CRG | 3c | 0.5 | F-81 |
| F-88 | 重构预览/应用工作流 | CRG | 5 | 1 | F-01 |
| F-89 | 安全层 (SSRF/prompt injection) | graphify | 2 | 0.5 | 无 |
| F-90 | MCP 服务器模式 | 三者 | 5 | 1 | F-16 |
| F-91 | Hub/Bridge 节点检测增强 | CRG | 3b | 0.5 | F-05, F-06 |
| F-92 | 图快照 diff 增强 | CRG | 2 | 0.5 | F-08 |

**新增**: 12 个功能点，8 天

---

## 4. 移植优先级矩阵

### 4.1 立即移植 (P1, 与统一方案 Phase 合并)

| # | 能力 | 来源 | 合并到 | 额外工期 | 价值 |
|---|------|------|--------|:-------:|------|
| 1 | Leiden 社区检测 | 三者 | Phase 3c | +1 天 | 社区质量提升 |
| 2 | RRF 混合搜索 | CRG | Phase Z3 | +0.5 天 | 搜索精度提升 |
| 3 | 执行流检测 | CRG/GitNexus | Phase 3b | +1 天 | 新增核心能力 |
| 4 | 变更影响风险评分 | CRG | Phase 3b | +0.5 天 | 审查效率提升 |
| 5 | 边置信度系统 | CRG/GitNexus | Phase Z1 | +0.5 天 | 数据质量提升 |
| 6 | 预计算上下文 | GitNexus | Phase Z4 | +1 天 | 查询效率提升 |

**合并后工期变化**: Phase 3b +1.5 天, Phase 3c +1 天, Phase Z1 +0.5 天, Phase Z3 +0.5 天, Phase Z4 +1 天 = **总计 +4.5 天**

### 4.2 评估后移植 (P2)

| # | 能力 | 来源 | 模块 | 工期 | 前置条件 |
|---|------|------|------|:----:|---------|
| 7 | 知识缺口分析 | CRG | GraphEngine | 0.5 天 | Leiden 完成 |
| 8 | 重构预览/应用 | CRG | RefactorTool | 1 天 | GraphStore 完成 |
| 9 | 安全层 | graphify | utils | 0.5 天 | 无 |
| 10 | MCP 服务器 | 三者 | McpServer | 1 天 | 所有 Tool 完成 |
| 11 | Hub/Bridge 增强 | CRG | GraphEngine | 0.5 天 | PageRank 完成 |
| 12 | 图快照 diff 增强 | CRG | GraphEngine | 0.5 天 | delta 完成 |

**P2 工期**: 4 天

### 4.3 不建议移植

| # | 能力 | 来源 | 理由 |
|---|------|------|------|
| — | 28+ 平台技能安装 | graphify | ola-cc 自有 Skill 系统 |
| — | 跨仓库影响分析 | GitNexus | 复杂度高，当前无需求 |
| — | 向量嵌入 | 三者 | 设计决策排除 |
| — | LadybugDB | GitNexus | SQLite 已满足 |
| — | LLM 后端抽象 | graphify | 已有 API client |
| — | Wiki 自动生成 | CRG/GitNexus | 非核心功能 |
| — | Token 节省度量 | CRG/graphify | 锦上添花 |
| — | 多格式导出 | graphify | 非核心功能 |
| — | SWE-bench 评估 | GitNexus | 特定场景 |

---

## 5. 统一方案增强汇总

### 5.1 合并后的新功能清单

| 原方案 | 三项目新增 | 专家评审新增 | 合并后总计 |
|:------:|:--------:|:----------:|:---------:|
| 80 功能点 | +12 | +3 (F-93/94/95) | **95 功能点** |
| 67.5 天 | +8 | +12 (含两轮评审) | **87.5 天** |

### 5.2 合并后的模块结构

```
src/services/graph/
├── GraphEngine.ts              # 15+ 种算法 +Leiden +执行流 +知识缺口
├── GraphStore.ts               # 双数据源 +RRF搜索 +边置信度 +安全层
├── IncrementalSync.ts          # 三级增量同步
├── StructuralFingerprint.ts    # 结构指纹
├── ChangeClassifier.ts         # 变更分类 +风险评分
├── GraphValidator.ts           # 图验证 9 项
├── DomainAnalyzer.ts           # 领域分析三层模型
├── OperationRouter.ts          # 智能 operation 推荐
├── ProcessDetector.ts          # [新增] 执行流检测
├── KnowledgeGapAnalyzer.ts     # [新增] 知识缺口分析
└── parsers/                    # 14 种非代码解析器

src/tools/
├── CodegraphTool/              # 16+ ops +预计算上下文 +风险评分
├── GrokTool/                   # 2 ops + GrokManager 拆分
├── RefactorTool/               # [新增] 重构预览/应用
└── McpServer/                  # [新增] MCP 服务器 (可选)
```

### 5.3 综合评分更新

| 维度 | 原统一方案 | 增强后 | 提升原因 |
|------|:---------:|:------:|---------|
| 架构清晰度 | 9/10 | **9.5/10** | Leiden 稳定性 + 预计算模式 |
| 数据完整性 | 9/10 | **9.5/10** | 边置信度 + 执行流 |
| 算法丰富度 | 10/10 | **10/10** | 已饱和 |
| 搜索精度 | 8/10 | **9/10** | RRF 融合 |
| 安全性 | 7/10 | **8/10** | 安全层 + prompt injection 防护 |
| 变更分析 | 7/10 | **9/10** | 风险评分 + 执行流 |
| **综合** | **9.2/10** | **9.5/10** | — |

---

## 6. 实施建议

### 6.1 合并到统一方案 Phase

| 新增功能 | 合并到 Phase | 额外工期 | 理由 |
|---------|-------------|:-------:|------|
| Leiden 替换 Louvain | Phase 3c | +1 天 | 与社区检测同 Phase |
| RRF 混合搜索 | Phase Z3 | +0.5 天 | 与 FTS5 同 Phase |
| 执行流检测 | Phase 3b | +1 天 | 与中复杂度算法同 Phase |
| 变更影响风险评分 | Phase 3b | +0.5 天 | 依赖执行流 |
| 边置信度系统 | Phase Z1 | +0.5 天 | 与 EdgeMeta 扩展同 Phase |
| 预计算上下文 | Phase Z4 | +1 天 | 与操作集成同 Phase |
| 知识缺口分析 | Phase 3c | +0.5 天 | 依赖 Leiden |
| 重构预览/应用 | Phase 5 | +1 天 | 与路由集成同 Phase |
| 安全层 | Phase 2 | +0.5 天 | 与图验证同 Phase |
| MCP 服务器 | Phase 5 | +1 天 | 与路由集成同 Phase |
| Hub/Bridge 增强 | Phase 3b | +0.5 天 | 与角色分类同 Phase |
| 图快照 diff 增强 | Phase 2 | +0.5 天 | 与差分图同 Phase |

### 6.2 更新后的时间线

| Phase | 原工期 | 新增 | 合并后 |
|-------|:------:|:----:|:------:|
| Phase 1 | 7 | — | 7 |
| Phase 2 | 3.5 | +1 | 4.5 |
| Phase 3a | 1.5 | — | 1.5 |
| Phase 3b | 1.5 | +2 | 3.5 |
| Phase 3c | 3 | +1.5 | 4.5 |
| Phase 4 | 2 | — | 2 |
| Phase 5 | 3 | +2 | 5 |
| Phase Z1-Z5 | 15.5 | +2 | 17.5 |
| Phase 6a-6e | 21.5 | — | 21.5 |
| **总计** | **67.5** | **+20** (含两轮评审+12d) | **87.5** |

---

## 7. 结论

### 7.1 三项目价值总结

| 项目 | 最大价值 | 可移植能力数 | 建议移植工期 |
|------|---------|:----------:|:----------:|
| **code-review-graph** | 变更影响分析 + 风险评分 + 重构预览 | 8 | 4 天 |
| **graphify** | 33 种语言 AST + 安全层 + 6 层去重 | 2 | 1 天 |
| **GitNexus** | 预计算关系智能 + 12 阶段管道 + 执行流 | 4 | 3 天 |

### 7.2 核心发现

1. **三项目共同验证了 Leiden > Louvain**: 全部选择 Leiden 算法，印证统一方案应升级
2. **RRF 是搜索融合的标准方法**: CRG 和 GitNexus 均使用 RRF，graphify 使用 IDF 加权，方向一致
3. **预计算是 AI 工具的关键模式**: GitNexus 的"索引时计算，查询时返回"模式值得借鉴
4. **执行流是缺失的核心能力**: ola-cc 统一方案完全没有执行流检测，这是重要补充
5. **边置信度被普遍采用**: CRG 和 GitNexus 都有置信度系统，统一方案应纳入

### 7.3 最终建议

**合并 12 个新功能 + 3 个专家评审新增到统一方案，总工期 87.5 天，综合评分 9.5/10。**

新增功能全部与现有 Phase 合并执行，不增加 Phase 数量，不改变依赖关系。

---

## 8. 源码级实现细节（代码验证）

> 以下内容基于对三项目源码的直接分析，提供可移植的实现参考。

### 8.1 Leiden 社区检测 — 三项目对比

| 维度 | CRG (`communities.py`) | graphify (`cluster.py`) | GitNexus (`community-processor.ts`) |
|------|------------------------|-------------------------|-------------------------------------|
| 库 | igraph Leiden | graspologic Leiden / networkx Louvain | vendored graphology Leiden |
| 种子 | `_LEIDEN_SEED=42` (env 可覆盖) | `random_seed=42` | mulberry32 `seed=0xc0de` |
| 分辨率 | 自适应: `max(0.05, 1.0/log10(max(n,10)))` | 默认 1.0 | 大图(>10K)=2.0, 小图=1.0 |
| 迭代 | `n_iterations=2` (防指数爆炸) | 默认 | 大图=3, 小图=0(无限) |
| 确定性 | RNG 重设 + 边去重 `(min,max)` | 节点/边稳定排序 + ID 重映射 | 确定性 PRNG + 超时保护(60s) |
| 过大社区 | >25% 节点递归拆分(resolution=0.5) | >25% 且 ≥10 二次 Leiden | — |
| 回退 | igraph 不可用→按目录分组 | Leiden 不可用→Louvain | 超时→单社区 |
| 边权 | CALLS=1.0, INHERITS=0.8, IMPLEMENTS=0.7, DEPENDS_ON=0.6, IMPORTS=0.5, TESTED_BY=0.4, CONTAINS=0.3 | — | CALLS/EXTENDS/IMPLEMENTS |
| 增量 | `incremental_detect_communities` 检查变更文件影响 | `remap_communities_to_previous` 贪心匹配 | — |
| 内聚度 | `_compute_cohesion_batch` O(edges) 单遍 | — | 采样(最多50成员), `internalEdges/totalEdges` |

**移植建议 (ola-cc)**:
```typescript
// src/services/graph/GraphEngine.ts — louvainCommunity → leidenCommunity
// 1. 实现 Leiden phase 1+2 (refine + aggregation)
// 2. 固定种子: seedPRNG(0xc0de) 或 seed=42
// 3. 分辨率自适应: resolution = Math.max(0.05, 1.0 / Math.log10(Math.max(n, 10)))
// 4. 过大社区拆分: >25% 节点 → 子图重新 Leiden(resolution=0.5)
// 5. 确定性输入: nodes.sort() + edges.sort((a,b) => a[0]-[b[0] || a[1]-b[1])
```

### 8.2 RRF 混合搜索 — 代码级参考

**CRG `search.py` 核心实现**:
```python
# RRF 公式
def rrf_score(ranks: list[int], k: int = 60) -> float:
    return sum(1.0 / (k + rank + 1) for rank in ranks)

# 三层降级
1. FTS5 BM25 + 向量嵌入 → RRF 合并
2. 仅 FTS5 (嵌入不可用)
3. LIKE 匹配 (精确=3.0, 前缀=2.0, 包含=1.0)
```

**CRG Boost 启发式 (`detect_query_kind_boost`)**:
| 查询模式 | 目标节点类型 | 乘数 | 正则 |
|---------|------------|:----:|------|
| PascalCase | Class/Type | 1.5x | `/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/` |
| snake_case | Function | 1.5x | `/^[a-z]+(?:_[a-z]+)+$/` |
| 含 `.` | qualified_name | 2.0x | `/\./` |
| 提取标识符 | qualified_name 包含 | 2.0x | dotted/snake/CamelCase 三种正则, ≥3 字符 |
| context_files | 对应节点 | 1.5x | 文件路径匹配 |

**FTS5 配置**:
- 索引字段: `name, qualified_name, file_path, signature`
- 分词器: `porter unicode61` (Porter 词干 + Unicode)
- 查询防护: 双引号包裹防 FTS5 操作符注入
- BM25 取反: FTS5 返回负值，取反后越高越好

**GitNexus `hybrid-search.ts` 补充**:
- BM25 对每个文件取 top-3 最高分节点求和（避免低质量大量匹配膨胀）
- 优雅降级: FTS 不可用→纯语义搜索；两个输入都防御 null/undefined

**移植建议 (ola-cc Phase Z3)**:
```typescript
// src/services/graph/FtsSearch.ts
// 1. FTS5 虚拟表: CREATE VIRTUAL TABLE nodes_fts USING fts5(name, qualified_name, file_path, signature)
// 2. RRF: score = Σ 1/(60 + rank_i), K=60
// 3. Boost: PascalCase→Class 1.5x, snake_case→Function 1.5x, 含.→qualified_name 2.0x
// 4. 降级: FTS5→LIKE (精确=3.0, 前缀=2.0, 包含=1.0)
```

### 8.3 执行流检测 — 代码级参考

**CRG `flows.py` 入口点检测**:
```
三种机制:
1. 无入边: qualified_name ∉ CALLS 边目标集合 (排除 File→ 边)
2. 框架装饰器: 35 个正则 (Flask/FastAPI/Django/Celery/Click/pytest/Spring/JAX-RS/Express/Angular/React/Hilt/Compose/pydantic-ai/LangChain)
3. 命名约定: main, __main__, test_*, TestX*, on_*, handle_*, handler, lambda_handler, upgrade/downgrade, lifespan
```

**CRG 关键性评分 5 维**:
| 因子 | 权重 | 归一化 |
|------|:----:|--------|
| File spread | 0.30 | 1 file=0.0, 5+ files=1.0 |
| External calls | 0.20 | 0=0.0, 5+=1.0 |
| Security sensitivity | 0.25 | 安全关键词节点占比 |
| Test coverage gap | 0.15 | 1 - (有测试节点/总节点) |
| Depth | 0.10 | 0=0.0, 10+=1.0 |

**GitNexus `process-processor.ts` 入口点评分公式**:
```
score = baseScore × exportMultiplier × nameMultiplier × frameworkMultiplier

baseScore = calleeCount / (callerCount + 1)
exportMultiplier: exported=2.0, 否则=1.0
nameMultiplier: utility pattern=0.3, entry pattern=1.5, 其他=1.0
frameworkMultiplier: 基于文件路径的框架检测 (Next.js/Express/Django 等)
```

**GitNexus BFS 参数**: maxTraceDepth=10, maxBranching=4, minSteps=3, MIN_TRACE_CONFIDENCE=0.5

**GitNexus 去重策略**:
1. 子集移除: 若 path_A ⊂ path_B，移除 path_A
2. 端点对去重: 同一 (entry, terminal) 对保留最长路径

**GitNexus 动态限制**: `maxProcesses = max(20, min(300, symbolCount/10))`

**移植建议 (ola-cc Phase 3b)**:
```typescript
// src/services/graph/ProcessDetector.ts
// 1. findEntryPoints(): 复用 classifyRoles(entry) + 框架装饰器正则 + 命名约定
// 2. traceProcess(): 复用 GraphEngine.bfs(), maxDepth=10, maxBranch=4
// 3. computeCriticality(): 5 维评分 (CRG 模型, 权重: 0.30/0.20/0.25/0.15/0.10)
// 4. deduplicate(): 子集移除 + 端点对去重 (GitNexus 模型)
// 5. 持久化: Process 节点 + STEP_IN_PROCESS 边 + ENTRY_POINT_OF 边
```

### 8.4 安全层 — 代码级参考

**graphify `security.py` SSRF 多层防护**:

| 层级 | 机制 | 实现 |
|------|------|------|
| URL scheme | 白名单 | 仅允许 `http`/`https`，阻断 `file://`/`data:` |
| DNS 解析 | IP 验证 | `getaddrinfo` 后检查 private/reserved/loopback/link-local/CGN |
| TOCTOU | socket monkey-patch | `_ssrf_guarded_socket()` 在连接阶段再次验证 IP，防 DNS rebinding |
| 重定向 | 逐跳验证 | `_NoFileRedirectHandler` 对每次重定向重新执行 `validate_url` |
| NAT64 | 内嵌 IPv4 提取 | `64:ff9b::/96` 内嵌地址再判断 |
| 云元数据 | 黑名单 | 封堵 `metadata.google.internal` 等 |

**资源限制**: 二进制 50MB, 文本 10MB, 图 512MB (流式读取 + 累计字节计数)

**标签消毒**:
- `sanitize_label`: 去控制字符 + 截断 256 字符
- `sanitize_metadata`: 递归消毒, HTML 转义 + 列表截断 50 项 + 值截断 512 字符

**移植建议 (ola-cc Phase 2)**:
```typescript
// src/utils/security.ts
// 1. validateUrl(): scheme 白名单 + DNS resolve + IP 范围检查
// 2. ssrfGuard(): 连接阶段二次验证 (Node.js dns.resolve + net.isIP)
// 3. sanitizeLabel(): 去控制字符 + 截断 256
// 4. sanitizeMetadata(): 递归消毒 + HTML 转义
// 5. 资源限制: 图查询结果 maxNodes=100, 遍历 maxDepth=10
```

### 8.5 图快照 diff — 代码级参考

**CRG `graph_diff.py` 快照结构**:
```python
{
    "node_count": int,
    "edge_count": int,
    "nodes": { qualified_name: {"kind", "file", "community_id"} },
    "edges": set[str]  # "source_qualified->target_qualified:kind"
}
```

**差异计算**: 节点/边纯集合差集，社区变更比较 `community_id`
**输出限制**: 新增/移除节点各 100 条, 边各 100 条, 社区变更 50 条

### 8.6 6 层去重管线 — 代码级参考

**graphify `dedup.py` 管线**:

| 层 | 名称 | 算法 | 参数 |
|:--:|------|------|------|
| 1 | ID 预去重 | 首次出现保留 | — |
| 2 | 精确归一化 | NFKC + 大小写折叠 + 非字母数字折叠 | 同文件内合并 |
| 3 | 熵门控 | Shannon entropy | < 2.5 bits/char 跳过模糊匹配 |
| 4 | MinHash/LSH | 3-gram shingles + 128 permutations | threshold=0.7 |
| 5 | Jaro-Winkler | 验证 + 变体后缀检测 | 92.0 分阈值 |
| 6 | Union-Find | 路径压缩合并 | 无 chunk 后缀优先、短 ID 优先 |

**安全规则**: 跨项目拒绝、同名跨文件不合并、社区同名 +5.0 分 (≥12 字符)

### 8.7 预计算关系智能 — 代码级参考

**GitNexus `augmentation/engine.ts`**:
- **目标**: <500ms 冷启动, <200ms 热启动
- **策略**: 仅用 BM25 (不用 embedding) 追求速度
- **流程**: BM25 搜索 → 映射符号 → 批量获取 callers/callees/processes/cohesion → 按 cohesion 排序
- **关键**: Cluster 信息仅内部排序用，**从不暴露在输出中**
- **批量**: Cypher `WHERE n.id IN [...]` 减少 DB 往返

**移植建议 (ola-cc Phase Z4)**:
```typescript
// 索引时预计算:
// 1. PageRank 分数 → nodeMeta.pagerank
// 2. 社区 ID → nodeMeta.community_id
// 3. 执行流成员 → nodeMeta.process_ids
// 4. 内聚度 → community.cohesion
// 查询时: 一次 GraphStore.getNode() 返回完整上下文
```

---

## 9. 代码验证后的评审修正

### 9.1 新增 P0 问题

| 编号 | 问题 | 来源 | 影响 |
|:----:|------|------|------|
| P0-4 | ola-cc Louvain 缺乏确定性保证 | 三项目均有固定种子，ola-cc 无 | 每次运行结果不同，无法复现 |

### 9.2 新增 P1 问题

| 编号 | 问题 | 来源 | 影响 |
|:----:|------|------|------|
| P1-6 | 缺少执行流检测能力 | 三项目共同具备，ola-cc 完全缺失 | 无法追踪入口点→终端的关键路径 |
| P1-7 | RRF 搜索缺少 Boost 启发式 | CRG 有 5 种 Boost 模式 | 搜索精度低于 CRG |
| P1-8 | 安全层设计过于简略 | graphify 有 6 层 SSRF 防护 | MCP 服务器模式存在安全风险 |

### 9.3 三项目确定性保证对比

| 项目 | 算法 | 种子机制 | 排序保证 | 超时保护 |
|------|------|---------|---------|---------|
| CRG | Leiden | `_LEIDEN_SEED=42` + env 覆盖 | 边 `(min,max)` 去重 | — |
| graphify | Leiden/Louvain | `random_seed=42` | 节点/边稳定排序 + ID 重映射 | — |
| GitNexus | Leiden | mulberry32 `seed=0xc0de` | — | 60s 超时→单社区 |
| **ola-cc** | **Louvain** | **❌ 无** | **❌ 无** | **❌ 无** |
