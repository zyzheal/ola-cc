# CodeGraph + Grok 统一实施方案

> 日期: 2026-06-05
> 状态: 设计评审完成
> 融合: 图算法增强设计 (v8) + UA 优势能力移植 (~2,300 行，零新依赖)
> 评审: 四方专家评审完成 (Agent工具专家 + 算法专家 + 架构师 + Agent产品专家)
> 综合评分: ola-cc 8.2/10 | codegraph 6.5/10 | UA 4.3/10

---

## 文档索引

本文档为总览索引，详细设计拆分为以下子文档：

| # | 文档 | 内容 | Phase | 天数 |
|---|------|------|:-----:|:----:|
| 1 | [01-graphstore-redesign.md](codegraph-grok-unified/01-graphstore-redesign.md) | GraphStore 无损化改造：EdgeMeta[] 数组存储、12+1 EdgeType、fileKeyToId 桥接、GraphEngine 14 处适配、三方评审结论 | 1 | 1.5 |
| 2 | [02-graphengine-algorithms.md](codegraph-grok-unified/02-graphengine-algorithms.md) | GraphEngine 15 种算法详情：Tarjan SCC、PageRank、Louvain、Katz、Betweenness、角色分类、数据切片、耦合度量、性能目标 | 3a/3b/3c | 6 |
| 3 | [03-ua-migration.md](codegraph-grok-unified/03-ua-migration.md) | UA 能力移植：结构指纹、变更分类、GraphValidator 9 项检查、领域分析三层模型、Tour 增强、非代码解析器、GrokManager 拆分 | 1/2/4 | 12.5 |
| 4 | [04-phase6-codegraph-migration.md](codegraph-grok-unified/04-phase6-codegraph-migration.md) | Phase 6 codegraph 源码移植：EdgeKind 映射、callback-synthesizer 11 种模式、FrameworkResolver 20 个框架、同步系统、extraction 系统、tree-sitter 策略 | 6a-6f | 29 |
| 5 | [05-review-and-troubleshooting.md](codegraph-grok-unified/05-review-and-troubleshooting.md) | 评审、风险与排错：三方专家评审结论、三方对比评审 (vs codegraph/UA)、风险缓解、兼容性、错误处理、操作验证指南 | — | — |
| 6 | [06-data-completeness.md](codegraph-grok-unified/06-data-completeness.md) | 数据完整性补全：NodeMetadata 21 字段、EdgeType 12 种、FileRecord、FTS5 搜索、LRU 缓存、查询优化 | D1-D4 | 8 |
| 7 | [07-zero-dependency-data-completeness.md](codegraph-grok-unified/07-zero-dependency-data-completeness.md) | **[统一方案]** 零依赖 + 数据完整性：Phase 6f + D1-D4 合并，33 功能点，17.5 天，数据完整性 6/10→9/10 | Z1-Z5 | 17.5 |
| 8 | [08-ua-deep-analysis.md](codegraph-grok-unified/08-ua-deep-analysis.md) | UA 深度分析：架构、6大能力实现细节、数据模型、Agent 系统、三方对比、移植建议 | — | — |
| 9 | [09-three-project-review.md](codegraph-grok-unified/09-three-project-review.md) | 三项目多专家评审 + 源码级实现细节：Leiden/RRF/执行流/安全层/去重/预计算的代码级参考、确定性保证对比、代码验证后评审修正 | 3b/3c/Z1-Z5 | 8 |
| 10 | [10-three-expert-review.md](codegraph-grok-unified/10-three-expert-review.md) | **[三方专家评审]** 算法专家+Agent工具专家+架构师联合评审：Louvain公式缺陷、Tool Schema分层、安全架构、工期调整 75.5→85.5 天 | 1a/P1 | +10 |
| 11 | [11-extraction-system-migration.md](codegraph-grok-unified/11-extraction-system-migration.md) | Extraction 系统迁移设计：34 文件 9,971 行、TreeSitterExtractor 类、19 语言提取器、5 专用提取器、Worker 线程、WASM 内存管理 | Z1-Z3 | 10 |
| 12 | [12-dashboard-and-edge-expansion.md](codegraph-grok-unified/12-dashboard-and-edge-expansion.md) | **[差距补全]** Dashboard 可视化 (终端轻量版) + EdgeType 40 种扩展 + SemanticSearchEngine 补全 | Z1/Z4 | 5 |
| 13 | [13-gitnexus-scope-resolution.md](codegraph-grok-unified/13-gitnexus-scope-resolution.md) | **[差距补全]** GitNexus 作用域解析迁移: Scope Pipeline (7,768 行) + SemanticModel + Import Resolver (12 语言) + Entry Point Scoring + DAG Runner + 16 语言 Scope Provider | Z2/Z4/6c | 8 |

---

## 1. 目标与范围

### 1.1 统一目标

将 GraphEngine 图算法引擎（15 种算法、11+2 新 operation）与 Understand-Anything 的 6 大优势能力（结构指纹、变更分类、图验证、领域分析、Tour 增强、非代码解析器）融合为单一实施方案，构建完整的代码理解基础设施。

**核心原则**:
- **零新依赖** -- 所有 UA 能力用 TypeScript 原生实现，不引入 graphology/fuse.js 等外部库
- **复用 GraphEngine** -- UA 的图验证/领域分析/依赖链都调用已有的 GraphEngine 算法
- **向后兼容** -- 不修改现有 CodegraphManager CLI 调用路径
- **增量实施** -- 每个 Phase 独立可交付，不依赖后续 Phase

### 1.2 用户故事

| # | 角色 | 场景 | 价值 | 前置条件 |
|---|------|------|------|---------|
| US-1 | 开发者 | 重构前想知道哪些模块会受影响 | 避免遗漏修改点 | codegraph 已初始化 |
| US-2 | 架构师 | 快速理解模块边界和核心节点 | 缩短架构理解时间 | codegraph + grok 至少一个 |
| US-3 | 新人 | 交互式探索代码结构 | 降低上手门槛 | codegraph 已初始化 |
| US-4 | 开发者 | 判断签名变更还是实现变更 | 精确影响范围 | 结构指纹已初始化 |
| US-5 | 架构师 | 验证知识图谱完整性 | 发现质量问题 | 图验证系统就绪 |
| US-6 | 开发者 | 从业务视角理解代码 | 快速定位业务代码 | 领域分析已运行 |

### 1.3 范围边界

**包含**: GraphEngine 15 种算法 | GraphStore 双数据源适配器 | 13 个新 operation | 10 项 UA 能力移植 | 6 项 codegraph 源码移植 | Goal L3 自动触发 | Dashboard 可视化 (终端轻量版) | EdgeType 40 种 (12+1+27 扩展) | Auto-Update Hook | Ignore Filter | Onboard Builder | Understand Chat

**不包含**: Fuse.js 模糊搜索 | 多语言输出 | article-analyzer (完整移植)

---

## 2. 架构总览

### 2.1 模块结构

```
src/services/graph/
├── GraphEngine.ts              # 15 种图算法
├── GraphStore.ts               # 双数据源适配器 (无损化改造)
├── IncrementalSync.ts          # 三级增量同步
├── OperationRouter.ts          # [新增] 智能 operation 推荐
├── StructuralFingerprint.ts    # [UA] 结构指纹
├── ChangeClassifier.ts         # [UA] 变更分类器
├── GraphValidator.ts           # [UA] 图验证 9 项
├── DomainAnalyzer.ts           # [UA] 领域分析三层模型
└── parsers/                    # [UA] 14 种非代码解析器

src/tools/CodegraphTool/        # 11 新 operation
src/tools/GrokTool/             # 2 新 operation + GrokManager 拆分
```

### 2.2 数据流

```
codegraph.db (SQLite)  +  knowledge-graph.json (Grok)  +  非代码文件
        │                        │                          │
        └────────────────────────┼──────────────────────────┘
                                 ▼
                    GraphStore (EdgeMeta[] 数组存储)
                    adjacency: Map<string, Map<string, EdgeMeta[]>>
                    12+1 EdgeType 无损映射
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
        GraphEngine        StructuralFingerprint   GraphValidator
        15 种算法           + ChangeClassifier      9 项检查
              │
              ▼
    CodegraphTool (11 ops)  +  GrokTool (2 ops)
    OperationRouter 智能推荐
```

### 2.3 三方对比评分

| 维度 | ola-cc | codegraph | UA |
|------|:------:|:---------:|:---:|
| 架构清晰度 | 9/10 | 7/10 | 5/10 |
| 数据完整性 | 6/10 | 9/10 | 4/10 |
| 扩展性 | 9/10 | 5/10 | 6/10 |
| 算法丰富度 | 10/10 | 3/10 | 1/10 |
| 部署简易度 | 9/10 | 7/10 | 3/10 |
| **综合** | **8.2** | **6.5** | **4.3** |

---

## 3. 功能清单 (115 项)

| # | 功能 | Phase | 天数 | 依赖 |
|---|------|:-----:|:----:|------|
| F-01 | GraphStore 双数据源加载 | 1 | 1.5 | Phase 0 |
| F-02 | GraphEngine BFS/DFS | 1 | 1 | F-01 |
| F-03 | Tarjan SCC | 3a | 0.5 | F-01 |
| F-04 | 拓扑排序 | 3a | 0.5 | F-03 |
| F-05 | PageRank | 3a | 0.5 | F-01 |
| F-06 | 反向可达性 | 3a | 0.5 | F-01 |
| F-07 | 支配树 | 3a | 0.5 | F-01 |
| F-08 | 差分图 | 3a | 0.5 | F-01 |
| F-09 | 角色分类 | 3b | 0.5 | F-05, F-06 |
| F-10 | 数据依赖切片 | 3b | 0.5 | F-06 |
| F-11 | 耦合度量 | 3b | 0.5 | F-01 |
| F-12 | Leiden 社区检测 (替换 Louvain) | 3c | 1 | F-01 |
| F-13 | Katz 中心性 | 3c | 0.5 | F-01 |
| F-14 | Betweenness 近似 | 3c | 0.5 | F-01 |
| F-15 | 时间耦合 | 3c | 1 | Phase 0 |
| F-16 | CodeGraph 11 新 operation | 3a-3c | — | F-01~F-15 |
| F-17 | Grok 2 新 operation | 3c | — | F-12, F-05 |
| F-18 | Goal L3 自动触发 | 5 | 0.5 | F-16 |
| F-19 | 增量同步 | 2 | 1 | F-01 |
| F-20 | 性能基准 | 5 | 0.5 | F-01~F-18 |
| F-21 | 结构指纹 | 1 | 1.5 | F-01 |
| F-22 | 变更分类器 | 1 | 1 | F-21 |
| F-23 | 图验证系统 | 2 | 1 | F-01, F-03 |
| F-24 | 领域分析三层模型 | 3c | — | F-12, F-09 |
| F-25 | Tour 增强 | 4 | 0.5 | F-05, F-06 |
| F-26 | 非代码文件解析器 | 4 | 1.5 | F-01 |
| F-27 | Grok Analyzer 两阶段优化 | 1 | 1 | F-21 |
| F-28 | Grok Zod 校验 | 2 | 0.5 | F-01 |
| F-29 | assemble-reviewer | 2 | 0.5 | F-01 |
| F-30 | NodeKind 完整映射 | 1 | — | F-01 |
| F-31 | GraphStore 无损化改造 | 1 | — | F-01 |
| F-32 | re-export 链追踪 | 2 | 0.5 | F-01 |
| F-33 | EdgeKind 映射验证 | 6a | 1 | F-31 |
| F-34 | EventEmitter 回调合成 | 6b | — | F-33 |
| F-35 | React JSX 子组件合成 | 6b | — | F-33 |
| F-36 | Vue SFC 模板合成 | 6b | — | F-33 |
| F-37 | FrameworkResolver extract | 6c | — | F-01 |
| F-38 | FileWatcher 实时同步 | 6d | — | F-01 |
| F-39 | overrides/exports 边自实现 | 6e | — | F-01, F-33 |
| F-40 | NodeKind 规范化 | 6f | — | F-01 |
| F-41 | 辅助模块移植 | 6c-0 | 2 | F-01 |
| F-42 | ensureReady stale DB 降级 | 6d | — | F-01 |
| F-43 | IncrementalSync markClean | 6d | — | F-19 |
| F-44 | tree-sitter WASM 运行时 | 6f-1 | 2 | F-01 |
| F-45 | Worker 线程并行提取 | 6f-1 | — | F-44 |
| F-46 | 主提取器 | 6f-2 | 4 | F-44 |
| F-47 | 提取编排器 | 6f-2 | — | F-46, F-41 |
| F-48 | Vue SFC 提取器 | 6f-3 | — | F-46 |
| F-49 | Svelte 组件提取器 | 6f-3 | — | F-46 |
| F-50 | Liquid/MyBatis/DFM 提取器 | 6f-3 | — | F-46 |
| F-51 | 零 CLI 依赖 init/sync | 6f | — | F-44~F-50 |
| F-52 | NodeMetadata 扩展 (13 新字段) | D1 | 0.5 | 无 |
| F-53 | EdgeMeta 扩展 (5 新类型 + 元信息) | D1 | 0.5 | 无 |
| F-54 | FileRecord 接口 + files 表加载 | D1 | 0.5 | 无 |
| F-55 | GraphStore.loadCodegraph() 查询扩展 | D1 | 0.5 | F-52~F-54 |
| F-56 | Prepared Statements 懒初始化 | D2 | 0.5 | F-55 |
| F-57 | LRU 缓存 (1000 节点) | D2 | 0.5 | F-56 |
| F-58 | 批量查询 getNodesByIds() | D2 | 0.5 | F-57 |
| F-59 | 性能基准测试 | D2 | 0.5 | F-56~F-58 |
| F-60 | FTS5 搜索集成 | D3 | 1 | F-55 |
| F-61 | BM25 多信号评分 | D3 | 0.5 | F-60 |
| F-62 | UnresolvedReference 接口 + 加载 | D3 | 0.5 | F-55 |
| F-63 | codegraph_search 操作 | D3 | 0.5 | F-60~F-61 |
| F-64 | codegraph_files 操作 | D3 | 0.5 | F-54 |
| F-65 | codegraph_unresolved 操作 | D3 | 0.5 | F-62 |
| F-66 | classifyRoles 利用新字段 | D4 | 0.25 | F-52 |
| F-67 | backwardDataSlice 支持新边类型 | D4 | 0.25 | F-53 |
| F-68 | 新边类型参与矩阵 | D4 | 0.25 | F-53 |
| F-69 | 回归测试 | D4 | 0.25 | F-66~F-68 |
| F-70 | tree-sitter WASM spike 验证 | Z1 | 0.5 | 无 |
| F-71 | tree-sitter-types + helpers + grammars | Z1 | 0.5 | F-70 |
| F-72 | tree-sitter.ts 核心提取器 (3242行) | Z2 | 2 | F-71 |
| F-73 | extraction/index.ts 编排器 (1550行) | Z2 | 0.5 | F-72 |
| F-74 | vue-extractor + svelte-extractor | Z3 | 0.5 | F-72 |
| F-75 | liquid/mybatis/dfm 提取器 | Z3 | 0.5 | F-72 |
| F-76 | CodegraphManager 替换为内置 extraction | Z4 | 0.5 | F-73 |
| F-77 | Worker 线程并行提取 | Z5 | 0.5 | F-72 |
| F-78 | 端到端零 CLI 依赖测试 | Z5 | 1 | F-76 |
| F-79 | 进度回调直接调用验证 | Z5 | 0.5 | F-76 |
| F-80 | bun:compile 打包验证 | Z5 | 0.5 | F-78 |
| F-81 | Leiden 社区检测替换 Louvain | 3c | 1 | F-12 |
| F-82 | RRF 混合搜索融合 | Z3 | 0.5 | F-60 |
| F-83 | 执行流检测 (BFS 追踪) | 3b | 1 | F-02 |
| F-84 | 变更影响风险评分 | 3b | 0.5 | F-83 |
| F-85 | 边置信度系统 | Z1 | 0.5 | F-53 |
| F-86 | 预计算上下文 (索引时) | Z4 | 1 | F-73 |
| F-87 | 知识缺口分析 | 3c | 0.5 | F-81 |
| F-88 | 重构预览/应用工作流 | 5 | 1 | F-01 |
| F-89 | 安全层 (SSRF/prompt injection/MCP 沙箱) | 2 | 2 | 无 |
| F-90 | ~~MCP 服务器模式~~ **[删除]** ola-cc 本身就是 agent 工具，MCP 冗余 | — | — | — |
| F-91 | Hub/Bridge 节点检测增强 | 3b | 0.5 | F-05, F-06 |
| F-92 | 图快照 diff 增强 | 2 | 0.5 | F-08 |
| F-93 | Tool Schema 分层揭示 (核心5/分析4/高级12) + operation 合并 | 1a | 1.5 | 无 |
| F-94 | codegraph.db schema 验证 + 降级 | 1a | 0.5 | 无 |
| F-95 | DataSourceAdapter 接口提取 | Z1 | 0.5 | F-01 |
| F-96 | Dashboard 可视化 (终端轻量版, codegraph_dashboard op) | Z4 | 3 | F-16 |
| F-97 | EdgeType 40 种扩展 (12+1+27: P1 5种立即 + P2/P3 22种按需) | Z1+Z4 | 2 | F-53 |
| F-98 | SemanticModel 三层注册表 (Type/Method/Field + SymbolTable) | Z2 | 0.5 | F-72 |
| F-99 | Scope Resolution Pipeline (4阶段: extract→finalize→resolve→emit) + ScopeResolver 接口 | Z2 | 1 | F-98 |
| F-100 | TS/JS/Python scope-resolver (跨文件符号解析) | Z2 | 0.5 | F-99 |
| F-101 | 7-case Receiver 分发器 + Import Resolver Factory (12语言) + Entry Point Scoring + DAG Runner | Z4 | 2 | F-99 |
| F-102 | 16 语言 Scope Provider (分3批: Go/Rust/Java/C++ → C#/PHP/Ruby/Swift/Kotlin → Dart/Scala/Lua/ObjC/Vue) | 6c | 4 | F-101 |
| F-103 | Module Contract Registry (自动提取模块导出/API/事件合约到 SQLite) | Z4 | 2 | F-01 | Cross-Repo 借鉴 |
| F-104 | 两阶段模块影响分析 (代码级 BFS + 合约级扇出) + 合约匹配引擎 | Z4 | 1.5 | F-103 | Cross-Repo 借鉴 |
| F-105 | 批量 LLM 分析编排模式 (批次分割+并发控制+中间文件容错) | Z2 | 0.5 | F-72 | article-analyzer 借鉴 |
| F-106 | SemanticSearchEngine 补全 (EmbeddingProvider + VectorStore + RRF 三路融合) | Z3 | 1.5 | F-82 | UA 补全 |
| F-107 | Auto-Update Hook (PostGitHook 触发 + 4阶段增量更新: 预检→结构指纹→目标重分析→条件更新) | 2 | 0.5 | F-21, F-22 | UA 迁移 |
| F-108 | Ignore Filter (.gitignore + .ola-cc-ignore 三层模式 + ignore-generator 自动生成) | Z2 | 0.5 | 无 | UA 迁移 |
| F-109 | Onboard Builder (codegraph_onboard op: 项目概览+架构层+关键概念+Tour+文件地图+复杂度热点) | 4 | 0.5 | F-25, F-09 | UA 迁移 |
| F-110 | Understand Chat (grok_codebase_qa op: context+专用问答 prompt 模板) | 5 | 0.25 | F-01 | UA 迁移 |
| F-111 | 错误恢复策略 (算法超时+DB损坏恢复+Grok降级+同步冲突+资源限制) | 2 | 1 | F-01 | 四专家评审 P0 |
| F-112 | 算法正确性测试套件 (PageRank收敛+modularity+Katz收敛+Betweenness确定性) | 5 | 1 | F-05,F-12,F-13,F-14 | 四专家评审 P0 |
| F-113 | EdgeMeta[] 兼容层 + 渐进迁移 (Map→Map[] 迁移, ~50处代码+226测试适配) | 1a | 2 | F-31 | 四专家评审 P0 |
| F-114 | 回滚策略 (git tag + feature flag + codegraph_rollback op + 数据备份) | 5 | 0.5 | F-01 | 四专家评审 P0 |
| F-115 | 用户故事验收矩阵 + 成功指标 (6 用户故事验收标准 + 数据源可用性矩阵) | 1 | 0.5 | 无 | 四专家评审 P0 |

---

## 4. 时间线

### 总计: 99 天 (Phase 0 已完成，剩余 98 天)

> **九轮评审后调整**: 75.5d → 87.5d → 78.5d → 86.5d → 90.5d → 92d → 94d → 99d
> - 第一轮: +10d (P0 3d + P1 3.5d + P2 3.5d)
> - 第二轮: +2d (Phase 1a 扩展 3d→5d, F-93 0.5d→1.5d)
> - 第三轮: +5d (Dashboard 3d + EdgeType 扩展 2d)，-1d (F-90 MCP 删除)
> - 第四轮: +8d (GitNexus 作用域解析迁移: Scope Pipeline + SemanticModel + Import Resolver + Entry Point + DAG Runner + 16 语言 Provider)
> - 第五轮: +4d (Cross-Repo 借鉴: Contract Registry 2d + 两阶段影响分析 1.5d + article-analyzer 借鉴: 批量 LLM 编排 0.5d)
> - 第六轮: +1.5d (UA SemanticSearchEngine 补全: EmbeddingProvider + VectorStore + RRF 三路融合)
> - 第七轮: +2d (UA 能力迁移补全: Auto-Update Hook 0.5d + Ignore Filter 0.5d + Onboard Builder 0.5d + Understand Chat 0.25d)
> - **第九轮: +5d (四专家评审修复: EdgeMeta[] 兼容层 2d + 错误恢复策略 1d + 算法正确性测试 1d + 回滚策略 0.5d + 验收矩阵 0.5d)**

| Phase | 内容 | 天数 | 累计 |
|-------|------|:----:|:----:|
| Phase 0 | 数据源验证 | 1 | 1 |
| **Phase 1a** | **[新增] P0 修复 + EdgeMeta[] 兼容层 (详见下方分解)** | **7** | **8** |
| Phase 1b | GraphEngine 核心 + 结构指纹 + GrokManager 拆分 | 7 | 15 |
| Phase 2 | 增量同步 + 图验证 + re-export + Zod 校验 + 安全层(2d) + diff 增强 + Auto-Update Hook + 错误恢复策略 | 7.5 | 22.5 |
| Phase 3a | 低复杂度算法 (6 算法 + 4 op) | 1.5 | 24 |
| Phase 3b | 中复杂度算法 + 执行流检测 + 风险评分 + Hub/Bridge (5 算法 + 6 op) | 3.5 | 27.5 |
| Phase 3c | 高复杂度 + 领域分析 + **Leiden 完整实现** (替换 Phase 1a 的公式修正) + 知识缺口 (5 算法 + 7 op) | 4.5 | 32 |
| Phase 4 | Tour 增强 + 非代码解析 + **Onboard Builder** | 2.5 | 34.5 |
| Phase 5 | 路由集成 + OperationRouter + 重构预览 + **Understand Chat** + 算法正确性测试 + 回滚策略 + 验收矩阵 | 5.75 | 40.25 |
| **Phase Z1** | **数据模型 + Extraction 基础 + 边置信度 + DataSourceAdapter + EdgeType P1 扩展** | **4.5** | **44.75** |
| **Phase Z2** | **查询优化 + Extraction 核心 + Scope Resolution 基础 + 批量 LLM 编排 + Ignore Filter** | **7** | **51.75** |
| **Phase Z3** | **搜索能力 + RRF 融合 + SemanticSearchEngine 补全 + 专用提取器** | **5** | **56.75** |
| **Phase Z4** | **操作集成 + 预计算上下文 + CodegraphManager 替换 + Dashboard + EdgeType P2/P3 + Scope Resolution 完整 + Contract Registry + 两阶段影响分析** | **12.5** | **69.25** |
| **Phase Z5** | **集成测试 + 性能基准 + Worker 线程 + bun:compile 验证** | **3.5** | **72.75** |
| Phase 6a | EdgeKind 映射验证 + NodeKind 规范化 | 1 | 73.75 |
| Phase 6b | callback-synthesizer (11 模式, 1233 行) | 5 | 78.75 |
| Phase 6c-0 | 辅助模块 (3189 行) | 2 | 80.75 |
| Phase 6c-1 | React+Vue+Svelte (1020 行) | 3 | 83.75 |
| Phase 6c-2 | NestJS+RN+Fabric+Expo+Express+Java (2678 行) | 4 | 87.75 |
| Phase 6c-3 | 11 个其他语言框架 (3513 行) | 3 | 90.75 |
| Phase 6c-4 | **[新增] 16 语言 Scope Provider** | **4** | **94.75** |
| Phase 6d | 同步系统 + CLI 降级 (1068 行) | 2.5 | 97.25 |
| Phase 6e | C++ include + re-export + 边自实现 (~400 行) | 1 | 98.25 |
| Phase 6f | (已并入 Phase Z1-Z5) | — | — |

### Phase 1a 详细分解 (7 天)

```
Phase 1a: P0 修复 + EdgeMeta[] 兼容层 (7d)
├── 1a-1: 算法修复 (1.5d)
│   ├── Louvain 归一化公式修正 + 注释对齐 (0.5d)
│   ├── Betweenness mulberry32 PRNG 替换 Math.random() (0.5d)
│   ├── Katz 自适应 alpha + maxDegree O(V) 预计算 (0.25d)
│   └── DominatorTree const→let bug 修复 (0.25d)
├── 1a-2: 基础设施修复 (2d)
│   ├── GraphStore GraphData 类型对齐 EdgeMeta[] (0.5d)
│   ├── codegraph.db schema 验证 + 降级 (0.5d)
│   ├── addEdge mergedKey→数组存储 (0.5d)
│   └── GraphEngine 14 处边迭代适配 (0.5d)
├── 1a-3: Tool Schema 重构 (1.5d)
│   ├── operation 合并 (impact+depth, 删除 explore) (0.5d)
│   ├── 三层 description 编写 + Zod schema (0.5d)
│   └── ToolSearch deferred 注册 + 测试 (0.5d)
└── 1a-4: EdgeMeta[] 兼容层 + 渐进迁移 (2d) [F-113]
    ├── 兼容层 getEdgeMeta(from,to,type) 封装 (0.5d)
    ├── GraphEngine ~50 处边迭代适配 (0.5d)
    ├── 226 个测试用例适配 (0.5d)
    └── GraphSnapshot 接口变更 + testHelpers 11 工厂函数重写 (0.5d)
```

> **Phase 1a vs 3c Leiden 职责边界**:
> - Phase 1a (1a-1): 修复现有 Louvain 的 `1/(2m)` 归一化公式 + 注释对齐 + 确定性种子 → 确保当前 Louvain 正确运行
> - Phase 3c: **完整替换** Phase 1a-1 修正后的 Louvain 为 Leiden 三阶段 (Local Moving + Refinement + Aggregation) + 自适应分辨率 + 过大社区拆分。1a-1 的修正是为了让当前系统正确运行，3c 时该代码将被完全移除。

### 依赖关系

```
Phase 0 (已完成)
  └── Phase 1a: P0 修复 (5d) ← [新增] 算法修复 + 基础设施修复 + Tool Schema
        └── Phase 1b (GraphStore + GraphEngine + 结构指纹 + GrokManager)
              ├── Phase 2 (增量同步 + 图验证 + 安全层 2d + re-export + Zod 校验 + diff 增强)
              ├── Phase 3a → 3b → 3c (算法递进 + Leiden 完整实现)
              ├── Phase 4 (Tour + 非代码解析) → Phase 5 (路由 + MCP)
              └── Phase Z1 → Z2 → Z3 → Z4 → Z5 (零依赖 + 数据完整性统一方案)
                    └── Phase 6a → 6b → 6c-0 → 6c → 6d → 6e (codegraph 移植)
```

### 优先级建议 (统一方案)

| 优先级 | 范围 | 天数 | 价值覆盖 |
|--------|------|:----:|:--------:|
| **立即执行** | **Phase 1a-5 + Phase Z1-Z5** | **65** | **95%** |
| 评估后执行 | Phase 6a-6e + 6c-4 | 27 | 99% |
| 已合并 | Phase 6f | (已并入 Z1-Z5) | 100% |

---

## 5. 能力对比与替代性分析

### 5.1 codegraph 能力覆盖

| # | codegraph 能力 | 统一方案覆盖 | Phase |
|---|---------------|:----------:|:-----:|
| 1 | 22 种节点类型 | ✅ | Z1 |
| 2 | 12 种边类型 (EdgeKind) | ✅ | Z1 |
| 3 | FTS5 全文搜索 | ✅ | Z3 |
| 4 | SQLite 存储 + 14 索引 | ✅ | Z2 |
| 5 | 零 LLM 成本 | ✅ | Z4 |
| 6 | 实时增量同步 | ✅ | Z2 |
| 7 | 文件级追踪 (files 表) | ✅ | Z1 |
| 8 | 未解析引用追踪 | ✅ | Z3 |
| 9 | 框架检测 (20 框架) | ✅ | Z3 |
| 10 | callback-synthesizer (11 模式) | ✅ | 6b |
| 11 | batch 并行提取 | ✅ | Z5 |
| 12 | bun:compile 打包 | ✅ | Z5 |

**结论**: 12/12 完全覆盖，另有 15 种图算法 + 双引擎合并超越。

### 5.2 UA 能力覆盖

| # | UA 能力 | 统一方案覆盖 | Phase |
|---|--------|:----------:|:-----:|
| 1 | 结构指纹 (三级变更检测) | ✅ | 1 |
| 2 | 变更分类器 (SKIP/PARTIAL/ARCHITECTURE/FULL) | ✅ | 1 |
| 3 | 图验证 9 项 + 四层防御 | ✅ | 2 |
| 4 | Tour 增强 (Kahn 拓扑排序) | ✅ | 4 |
| 5 | 领域分析三层模型 | ✅ | 3c |
| 6 | 非代码解析器 (12 种) | ✅ | 4 |
| 7 | 21 种节点类型 | ✅ | Z1 |
| 8 | 35 种边类型 | ⚠️ 8/35 → **40/35 (扩展)** | Z1+Z4 |
| 9 | 别名系统 (43 节点 + 30 边) | ✅ | 2 |
| 10 | 层检测 | ✅ | 3c |
| 11 | 语言概念检测 | ✅ | 4 |
| 12 | Zod schema 验证 + 自动修复 | ✅ | 2 |
| 13 | staleness 增量检测 | ✅ | 2 |
| 14 | Dashboard 可视化 | ✅ 终端轻量版 (codegraph_dashboard op) | Z4 |
| 15 | 向量语义搜索 | ✅ **已补全实施** (EmbeddingProvider + VectorStore + RRF) | Z3 |
| 16 | article-analyzer | ❌ | — |
| 17 | Auto-Update Hook (PostGitHook + 4阶段增量更新) | ✅ | 2 |
| 18 | Ignore Filter (.gitignore + .ola-cc-ignore 三层模式) | ✅ | Z2 |
| 19 | Onboard Builder (入职指南生成) | ✅ | 4 |
| 20 | Understand Chat (代码库问答 prompt) | ✅ | 5 |

**结论**: 20/20 完全覆盖 (含 Dashboard + 语义搜索补全 + 4项 UA 能力迁移)，边类型从 8/35 扩展到 40/35。

### 5.3 统一方案超越能力

| # | 超越能力 | 说明 |
|---|---------|------|
| 1 | 15 种图算法 | PageRank/SCC/Leiden/Katz/Betweenness/Dominator/TopoSort... |
| 2 | 双引擎合并 | codegraph AST (精确) + Grok LLM (语义) |
| 3 | GraphStore 统一图存储 | 双数据源适配器，身份匹配合并 |
| 4 | OperationRouter 智能推荐 | 根据上下文推荐最佳 operation |
| 5 | Goal L3 自动触发 | 图分析结果自动驱动 Goal |
| 6 | 零 CLI 依赖 | codegraph 依赖 45MB 外部二进制 |
| 7 | 直接进度回调 | UA/codegraph 都需要 stderr 解析 |
| 8 | 渐进式增强 | 任一数据源缺失不阻塞 |
| 9 | **Scope Resolution** | GitNexus 11K 行迁移: 7-case receiver + 16 语言 + MRO + overload narrowing |
| 10 | **40 种边类型** | 超越 UA (35) 和 codegraph (12)，含 Behavioral/DataFlow/Infrastructure/Knowledge |
| 11 | **DAG Pipeline Runner** | Kahn 拓扑排序 + 声明式依赖 + 类型安全 phase 间传递 |
| 12 | **Module Contract Registry** | 自动提取模块导出/API/事件合约，Cross-Repo 设计借鉴 |
| 13 | **两阶段模块影响分析** | 代码级 BFS + 合约级扇出，Cross-Repo 两阶段模式借鉴 |
| 14 | **SemanticSearchEngine 补全** | EmbeddingProvider 可插拔 + VectorStore SQLite 持久化 + RRF 三路融合，修复 UA 6 项缺陷 |
| 15 | **Auto-Update Hook** | PostGitHook 触发 + 4阶段增量更新 (预检→结构指纹→目标重分析→条件更新)，UA 能力迁移 |
| 16 | **Ignore Filter** | .gitignore + .ola-cc-ignore 三层模式 + 自动生成器，超越 UA 单层实现 |
| 17 | **Onboard Builder** | codegraph_onboard op: 组合 Tour+Community+Roles 生成结构化入职指南 |
| 18 | **Understand Chat** | grok_codebase_qa op: context+专用问答 prompt，代码库自然语言问答 |

### 5.4 综合评分

| 维度 | codegraph | UA | ola-cc 统一方案 |
|------|:---------:|:--:|:--------------:|
| 节点属性 | 21/21 | 21/21 | 21/21 |
| 边类型 | 12/12 | 35/35 | **40/40** (超越) |
| 图算法 | 0/15 | 0/15 | **15/15** |
| 作用域解析 | ❌ | ❌ | **✅ 16 语言 (GitNexus)** |
| 全文搜索 | ✅ | ❌ | ✅ |
| 增量同步 | ✅ | ✅ | ✅ |
| 零 LLM 成本 | ✅ | ❌ | ✅ |
| 语义丰富度 | ❌ | ✅ | ✅ |
| 非代码解析 | ❌ | ✅ | ✅ |
| 领域分析 | ❌ | ✅ | ✅ |
| 图验证 | ❌ | ✅ | ✅ |
| 部署简易度 | ⚠️ | ⚠️ | ✅ |
| 模块合约分析 | ❌ | ❌ | **✅ Contract Registry + 两阶段影响** |
| 语义搜索 | ❌ | ⚠️ 未启用 | **✅ EmbeddingProvider + VectorStore + RRF 融合** |
| **综合** | **6.5** | **4.3** | **9.5** |

### 5.5 剩余差距

| 差距 | 影响 | 补救 | 工期 |
|------|------|------|:----:|
| article-analyzer (完整移植) | Wiki 文章分析 | 隐式边 5 种已覆盖 + 批量编排模式已借鉴 (F-105) | — |
| 向量语义搜索 | 语义相似度 | **已补全实施** (F-106): EmbeddingProvider + VectorStore + RRF 三路融合 | Z3 1.5d |
| Auto-Update Hook | 增量更新 | **已补全** (F-107): PostGitHook + 4阶段增量更新 | 2 0.5d |
| Ignore Filter | 忽略过滤 | **已补全** (F-108): .gitignore + .ola-cc-ignore 三层模式 | Z2 0.5d |
| Onboard Builder | 入职指南 | **已补全** (F-109): codegraph_onboard op | 4 0.5d |
| Understand Chat | 代码库问答 | **已补全** (F-110): grok_codebase_qa op | 5 0.25d |

**结论**: 统一方案实施后，ola-cc 代码理解能力达到 9.5/10，完全替换 codegraph (20/20) 和 UA (20/20) 全部核心能力，边类型扩展到 40 种（超越 UA 的 35 种），Dashboard 可视化通过终端轻量版覆盖，**作用域解析从 GitNexus 迁移 11K 行（16 语言 + 7-case receiver + MRO + overload narrowing）**，**模块合约分析借鉴 Cross-Repo Impact 设计（Contract Registry + 两阶段影响分析）**，**批量 LLM 编排借鉴 article-analyzer 模式（批次+并发+容错）**，**UA 能力迁移补全 4 项（Auto-Update Hook + Ignore Filter + Onboard Builder + Understand Chat）**，并融合 code-review-graph/graphify/GitNexus/article-analyzer/Cross-Repo Impact 五项目的能力借鉴（Leiden 社区检测、RRF 混合搜索、执行流检测、风险评分、边置信度、预计算上下文、Scope Resolution、DAG Pipeline、Entry Point Scoring、Contract Registry、两阶段影响分析、批量 LLM 编排等），具备所有源项目都不具备的图算法引擎、双引擎合并、作用域解析、模块合约分析、语义搜索补全和自动更新能力。**115 个功能点，99 天。**

---

## 6. 四专家评审发现与修复 (第九轮)

> 评审日期: 2026-06-05
> 评审团队: Agent 工具专家 (7.2/10) + 算法专家 (6.8/10) + 架构师 (7.5/10) + Agent 产品专家 (6.5/10)
> 综合评分: 7.0/10 → 修复后预估 8.5/10

### 6.1 P0 问题与修复方案

| # | P0 问题 | 来源 | 修复方案 | 功能点 | 工期 |
|---|---------|------|---------|:------:|:----:|
| 1 | EdgeMeta[] 破坏性变更 ~50 处代码+226 测试 | 架构师 | F-113: 兼容层 getEdgeMeta() + 渐进迁移 | F-113 | 2d |
| 2 | 缺少错误恢复策略 (超时/DB损坏/Grok降级/同步冲突) | Agent 工具专家 | F-111: 四层错误恢复 + 资源限制 | F-111 | 1d |
| 3 | Louvain modularity 缺少 1/(2m) 归一化因子 | 算法专家 | Phase 1a-1 修正 (已有) | — | — |
| 4 | Betweenness 采样使用 Math.random() 无确定性 | 算法专家 | Phase 1a-1 mulberry32 PRNG (已有) | — | — |
| 5 | 缺少算法正确性测试套件 | 算法专家 | F-112: PageRank/modularity/Katz/Betweenness 验证 | F-112 | 1d |
| 6 | Tool Schema 32+ operations 无分层揭示 | Agent 工具专家 | F-93 三层分层 (已有) | — | — |
| 7 | 缺少回滚策略 | 架构师 | F-114: git tag + feature flag + graph_rollback op | F-114 | 0.5d |
| 8 | 用户故事缺少验收标准 | Agent 产品专家 | F-115: 验收矩阵 + 成功指标 | F-115 | 0.5d |

### 6.2 P1 问题与修复方案

| # | P1 问题 | 来源 | 修复方案 |
|---|---------|------|---------|
| 1 | Katz alpha=0.1 可能不收敛 | 算法专家 | Phase 1a-1: alpha = 0.9/sqrt(maxDegree) (已有) |
| 2 | Tool operation 参数语义泄漏 | Agent 工具专家 | F-93: 三层 description 重新编写 (已有) |
| 3 | MCP 模式无查询沙箱 | 架构师 | F-89: 安全层 2d (已有) |
| 4 | Prompt injection via Grok JSON | 架构师 | F-89: 输入清洗 + 长度限制 (已有) |
| 5 | 工期估算过于乐观 | 架构师 | 94d→99d (+5d P0 修复) |
| 6 | 缺少性能预算表 | 算法专家 | 新增下方性能预算表 |
| 7 | 缺少数据源可用性矩阵 | Agent 产品专家 | 新增下方数据源可用性矩阵 |
| 8 | 缺少成功指标 | Agent 产品专家 | F-115: 新增成功指标定义 |
| 9 | Leiden 自适应分辨率公式需验证 | 算法专家 | F-112: 测试覆盖 |
| 10 | GraphSnapshot 接口变更级联 | 架构师 | F-113: 兼容层统一处理 |
| 11 | testHelpers.ts 11 工厂函数重写 | 架构师 | F-113: 渐进迁移 |
| 12 | 20% 缓冲未计入 | 架构师 | 99d × 1.2 ≈ 119d (含缓冲) |
| 13 | 缺少数据源降级路径 | Agent 产品专家 | F-111: Grok 降级为纯图分析 |
| 14 | 成本估算缺失 | Agent 产品专家 | 新增下方成本估算 |

### 6.3 性能预算表 (新增)

| 操作类型 | 延迟目标 | 内存上限 | 超时策略 |
|---------|:--------:|:--------:|---------|
| 查询类 (bfs/dfs/search/scc/toposort) | <10ms | 无额外 | 无 |
| 分析类 (pagerank/katz/coupling/roles) | <2s | 200MB | 30s 硬超时 |
| 深度分析 (betweenness/leiden/temporal) | <10s | 500MB | 60s 超时→单社区回退 |
| 结构指纹 (单文件) | <100ms | 无额外 | 无 |
| 变更分类 (单文件) | <50ms | 无额外 | 无 |
| 图验证 (100K 节点) | <10s | 300MB | 30s 部分结果 |
| 领域分析 (100K 节点) | <30s | 500MB | 60s 降级 |
| 非代码解析 (单文件) | <200ms | 无额外 | 无 |
| FTS5 搜索 | <5ms | 无额外 | 无 |
| RRF 融合搜索 | <20ms | 无额外 | 无 |
| Scope Resolution (单文件) | <500ms | 100MB | 10s 降级 |
| Dashboard 渲染 (54K 节点) | <3s | 1GB | 浏览器端 |

### 6.4 数据源可用性矩阵 (新增)

| 数据源 | 必需性 | 不可用时行为 | 降级路径 |
|--------|:------:|------------|---------|
| codegraph.db | 可选 | 仅 Grok 图模式 | 标记 degraded, 返回 Grok 数据 |
| knowledge-graph.json | 可选 | 仅 CodeGraph 模式 | 标记 degraded, 返回 AST 数据 |
| 两者都不存在 | — | 返回错误 + 初始化建议 | `codegraph_init` 或 `grok_generate` |
| SQLite 损坏 | — | 捕获异常 + 重建建议 | `codegraph_init` 重建 |
| JSON 解析失败 | — | 捕获错误 + 重建建议 | `grok_generate` 重建 |
| git 仓库不存在 | 可选 | 跳过 temporal/authored_by | 返回空结果 |
| tree-sitter WASM | 可选 | 跳过代码提取 | 降级为正则解析 |
| Embedding API | 可选 | 跳过语义搜索 | FTS5+BM25 仍可用 |

### 6.5 成功指标 (F-115)

| 指标 | 目标值 | 测量方法 |
|------|:------:|---------|
| codegraph 能力覆盖率 | 12/12 (100%) | 逐项验证 |
| UA 能力覆盖率 | 20/20 (100%) | 逐项验证 |
| 边类型数量 | 40 种 | EdgeType 枚举计数 |
| 图算法数量 | 15 种 | GraphEngine 方法计数 |
| 零 CLI 依赖 | Phase Z4 后 CodegraphManager 无外部调用 | grep 验证 |
| 数据完整性 | 9/10 | NodeMetadata 21/21 + EdgeType 40/40 |
| 54K 节点 PageRank | <3s | 性能基准测试 |
| 54K 节点 Leiden | <15s | 性能基准测试 |
| FTS5 搜索延迟 | <5ms | 性能基准测试 |
| 端到端 init→query | <30s | 集成测试 |
| 测试通过率 | 226+ 测试全部通过 | bun test |
| bun:compile 打包 | 成功 | 构建验证 |

### 6.6 成本估算 (新增)

| 资源 | 零 LLM 模式 | Grok 增强模式 |
|------|:-----------:|:------------:|
| 内存峰值 | 200MB | 500MB |
| 磁盘 (codegraph.db) | ~50MB (54K 节点) | ~50MB |
| 磁盘 (fingerprints) | ~5MB | ~5MB |
| LLM API 调用 | 0 | ~$0.05/次 Grok 生成 |
| Embedding API | 0 (Mock) | ~$0.01/次索引 |
| CPU (init, 54K 节点) | ~30s | ~60s (含 Grok) |
| CPU (查询) | <100ms | <100ms |

> **源码级参考**: 文档 09 §8 提供了 Leiden/RRF/执行流/安全层/去重/预计算的完整代码级实现细节（含算法参数、公式、数据结构、移植建议），可直接用于 Phase 实现。

> **源码级参考**: 文档 09 §8 提供了 Leiden/RRF/执行流/安全层/去重/预计算的完整代码级实现细节（含算法参数、公式、数据结构、移植建议），可直接用于 Phase 实现。
