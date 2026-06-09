# 零依赖 + 数据完整性统一方案

> 日期: 2026-06-05
> 目标: 零 CLI 依赖 + 数据完整性 6/10 → 9/10
> 合并: Phase 6f (extraction) + Phase D1-D4 (数据完整性)
> 总工期: 32 天 (含 Dashboard + EdgeType 扩展 + Scope Resolution + Contract Registry + 两阶段影响分析 + SemanticSearchEngine 补全)

---

## 1. 合并动机

### 1.1 Phase 6f 单独不够

Phase 6f 只解决 init/sync 内置，但：
- NodeMetadata 仍只有 8 字段
- EdgeType 仍只有 7 种
- 无 FTS5 搜索
- 无 LRU 缓存
- 查询操作仍需 CLI

### 1.2 Phase D1-D4 单独不够

Phase D1-D4 解决数据完整性，但：
- init/sync 仍依赖外部 CLI
- CLI 版本硬编码 `0.9.6`
- 进度解析依赖 stderr 格式
- 外部二进制 ~45MB

### 1.3 合并后价值

| 维度 | 仅 6f | 仅 D1-D4 | **合并** |
|------|:-----:|:--------:|:--------:|
| 零 CLI 依赖 | ✅ | ❌ | ✅ |
| 数据完整性 | 6/10 | 8.5/10 | **9/10** |
| 版本可控 | ✅ | ❌ | ✅ |
| 进度直接回调 | ✅ | ❌ | ✅ |
| 全文搜索 | ❌ | ✅ | ✅ |
| 查询优化 | ❌ | ✅ | ✅ |
| **总天数** | 7.5 | 8 | **17.5** (含三项目+评审新增) |

---

## 2. 统一架构

### 2.1 合并后的模块结构

```
src/services/graph/
├── GraphStore.ts              # [D1] 21字段 + 12边类型 + FileRecord + LRU + Prepared Stmts
├── GraphEngine.ts             # [D4] 15种算法 + 新边类型参与矩阵 + Leiden
├── DataSourceAdapter.ts       # [P1] 数据源统一接口 (CodegraphDb/GrokJson/Extraction)
├── IncrementalSync.ts         # [D1] 集成 FileRecord.content_hash
├── FtsSearch.ts               # [D3] FTS5 全文搜索 + BM25 评分
├── UnresolvedRefManager.ts    # [D3] 未解析引用管理
│
├── extraction/                # [6f] 内置提取系统
│   ├── index.ts               #     提取编排器 (scanDirectory + sync + resolve)
│   ├── tree-sitter.ts         #     核心提取器 (29种语言)
│   ├── tree-sitter-types.ts   #     类型定义
│   ├── tree-sitter-helpers.ts #     AST 辅助
│   ├── grammars.ts            #     grammar 加载
│   ├── parse-worker.ts        #     Worker 线程
│   └── extractors/            #     专用提取器
│       ├── vue-extractor.ts
│       ├── svelte-extractor.ts
│       ├── liquid-extractor.ts
│       ├── mybatis-extractor.ts
│       └── dfm-extractor.ts
│
└── parsers/                   # [6f] 非代码解析器

src/tools/CodegraphTool/
├── CodegraphTool.ts           # [D3] 新增 search/files/unresolved 操作
└── CodegraphManager.ts        # [6f] 替换为内置 extraction 调用
```

### 2.2 数据流（合并后）

```
源码文件 ──→ tree-sitter WASM + grammar ──→ AST ──→ 提取节点/边
                                                      │
                                                      ▼
                                            GraphStore.load()
                                            ├── NodeMetadata (21字段)
                                            ├── EdgeMeta[] (12种 + 元信息)
                                            ├── FileRecord (7字段)
                                            ├── UnresolvedReference
                                            └── FTS5 索引
                                                      │
                              ┌────────────────────────┼────────────────────────┐
                              ▼                        ▼                        ▼
                        GraphEngine              FtsSearch              UnresolvedRef
                        15种算法                  BM25评分              引用管理
                        + 新边类型矩阵            + 高亮
                              │                        │                        │
                              ▼                        ▼                        ▼
                    CodegraphTool (16 ops)
                    ├── scc/toposort/pagerank/roles/community/...
                    ├── search (FTS5)
                    ├── files (FileRecord)
                    └── unresolved (UnresolvedRef)
```

---

## 3. 实施阶段

### Phase Z1: 数据模型 + Extraction 基础 (4.5 天)

**目标**: NodeMetadata 21字段 + EdgeType 17种 (12+1+5 P1) + tree-sitter WASM 基础设施 + 边置信度 + DataSourceAdapter

| 任务 | 天数 | 依赖 | 来源 |
|------|:----:|------|:----:|
| F-52: NodeMetadata 扩展 (13 新字段) | 0.5 | 无 | D1 |
| F-53: EdgeMeta 扩展 (5 新类型 + 元信息) | 0.5 | 无 | D1 |
| F-54: FileRecord 接口 + files 表加载 | 0.5 | 无 | D1 |
| F-55: GraphStore.loadCodegraph() 查询扩展 | 0.5 | F-52~F-54 | D1 |
| F-70: tree-sitter WASM spike 验证 | 0.5 | 无 | 6f-1 |
| F-71: tree-sitter-types + helpers + grammars | 0.5 | F-70 | 6f-1 |
| F-85: 边置信度系统 (EXTRACTED/INFERRED/AMBIGUOUS) | 0.5 | F-53 | 三项目评审 |
| F-95: DataSourceAdapter 接口提取 | 0.5 | F-01 | 专家评审 |
| F-97-P1: EdgeType P1 扩展 (subscribes/publishes/middleware/flow_step/cross_domain) | 1 | F-53 | UA 差距分析 |

**验收条件**:
- [ ] NodeMetadata 包含 21 个字段
- [ ] EdgeType 包含 17 种 (12+1+5 P1)
- [ ] FileRecord 包含 7 个字段
- [ ] tree-sitter WASM 在 bun:compile 模式下加载成功
- [ ] 29 种语言 grammar 可用
- [ ] subscribes/publishes 正确检测 EventEmitter 模式
- [ ] middleware 正确检测 Express/NestJS 中间件链

### Phase Z2: 查询优化 + Extraction 核心 + Scope Resolution 基础 + 批量 LLM 编排 (6.5 天)

**目标**: LRU/Prepared Stmts + 主提取器 + 编排器 + SemanticModel + Scope Pipeline + TS/JS/Python scope-resolver + 批量 LLM 编排模式

| 任务 | 天数 | 依赖 | 来源 |
|------|:----:|------|:----:|
| F-56: Prepared Statements 懒初始化 | 0.5 | F-55 | D2 |
| F-57: LRU 缓存 (1000 节点) | 0.5 | F-56 | D2 |
| F-58: 批量查询 getNodesByIds() | 0.5 | F-57 | D2 |
| F-72: tree-sitter.ts 核心提取器 (3242行) | 2 | F-71 | 6f-2 |
| F-73: extraction/index.ts 编排器 (1550行) | 0.5 | F-72 | 6f-2 |
| F-98: SemanticModel 三层注册表 (Type/Method/Field + SymbolTable) | 0.5 | F-72 | GitNexus |
| F-99: Scope Resolution Pipeline (4阶段) + ScopeResolver 接口 | 1 | F-98 | GitNexus |
| F-100: TS/JS/Python scope-resolver (跨文件符号解析) | 0.5 | F-99 | GitNexus |
| F-105: 批量 LLM 分析编排模式 (批次分割+并发控制+中间文件容错) | 0.5 | F-72 | article-analyzer 借鉴 |

**验收条件**:
- [ ] LRU 缓存命中率 > 80%
- [ ] Prepared Statements 懒初始化
- [ ] `init` 内建执行生成 codegraph.db，结果与 CLI 一致
- [ ] `sync` 增量提取仅处理变更文件
- [ ] SemanticModel 注册表支持 Type/Method/Field 三种符号
- [ ] ScopeResolver 接口定义完整 (9 必需字段)
- [ ] TS/JS/Python scope-resolver 能解析基本的跨文件调用
- [ ] 批量 LLM 编排模式: 批次分割 10-15 节点/批次，并发上限 3，中间文件容错

### Phase Z3: 搜索能力 + RRF 融合 + SemanticSearchEngine 补全 + 专用提取器 (5 天)

**目标**: FTS5 搜索 + RRF 混合搜索融合 + SemanticSearchEngine 补全 (EmbeddingProvider + VectorStore) + 未解析引用 + Vue/Svelte/Liquid/MyBatis/DFM 提取器

| 任务 | 天数 | 依赖 | 来源 |
|------|:----:|------|:----:|
| F-60: FTS5 搜索集成 | 1 | F-55 | D3 |
| F-61: BM25 多信号评分 | 0.5 | F-60 | D3 |
| F-62: UnresolvedReference 接口 + 加载 | 0.5 | F-55 | D3 |
| F-82: RRF 混合搜索融合 (K=60) | 0.5 | F-60 | 三项目评审 |
| F-74: vue-extractor + svelte-extractor | 0.5 | F-72 | 6f-3 |
| F-75: liquid/mybatis/dfm 提取器 | 0.5 | F-72 | 6f-3 |
| F-106: SemanticSearchEngine 补全 (EmbeddingProvider + VectorStore + RRF 融合) | 1.5 | F-82 | UA 补全 |

**验收条件**:
- [ ] FTS5 搜索支持前缀匹配
- [ ] BM25 相关性排序正确
- [ ] RRF 融合 K=60，Boost 启发式 (PascalCase→Class, snake_case→Function)
- [ ] 未解析引用加载正确
- [ ] SemanticSearchEngine: EmbeddingProvider 可插拔 (OpenAI/Cohere/Mock)
- [ ] SemanticSearchEngine: SQLiteVectorStore 持久化 + KNN 搜索
- [ ] SemanticSearchEngine: searchByText 自然语言查询
- [ ] SemanticSearchEngine: RRF 三路融合 (FTS5+BM25+Semantic)
- [ ] Vue/Svelte/Liquid/MyBatis/DFM 项目正确提取

### Phase Z4: 操作集成 + 预计算上下文 + Dashboard + EdgeType P2/P3 + Scope Resolution 完整 + Contract Registry + 两阶段影响分析 (12.5 天)

**目标**: CodegraphTool 新操作 + GraphEngine 新边类型矩阵 + CodegraphManager 替换 + Dashboard + EdgeType 40 种 + Scope Resolution 完整 + Module Contract Registry + 两阶段模块影响分析

| 任务 | 天数 | 依赖 | 来源 |
|------|:----:|------|:----:|
| F-63: codegraph_search 操作 (FTS5) | 0.5 | F-60, F-61 | D3 |
| F-64: codegraph_files 操作 | 0.5 | F-54 | D3 |
| F-65: codegraph_unresolved 操作 | 0.5 | F-62 | D3 |
| F-66: classifyRoles 利用 is_exported/visibility | 0.25 | F-52 | D4 |
| F-67: backwardDataSlice 支持 type_of/returns | 0.25 | F-53 | D4 |
| F-68: 新边类型参与矩阵实现 | 0.25 | F-53 | D4 |
| F-86: 预计算上下文 (索引时 PageRank/社区/流) | 1 | F-73 | 三项目评审 |
| F-76: CodegraphManager 替换为内置 extraction | 0.5 | F-73 | 6f |
| F-96: Dashboard 可视化 (终端轻量版, codegraph_dashboard op) | 3 | F-16 | 差距补全 |
| F-97-P2: EdgeType P2/P3 扩展 (22 种) | 1 | F-53 | 差距补全 |
| F-101: 7-case Receiver + Import Resolver + Entry Point Scoring + DAG Runner | 2 | F-99 | GitNexus |
| F-103: Module Contract Registry (自动提取模块导出/API/事件合约到 SQLite) | 2 | F-01 | Cross-Repo 借鉴 |
| F-104: 两阶段模块影响分析 (代码级 BFS + 合约级扇出) + 合约匹配引擎 | 1.5 | F-103 | Cross-Repo 借鉴 |

**验收条件**:
- [ ] codegraph_search/files/unresolved 操作正常
- [ ] classifyRoles 导出符号识别正确
- [ ] 新边类型参与矩阵正确
- [ ] CodegraphManager 不再调用外部 CLI
- [ ] Dashboard 终端轻量版: 力导向布局 + 社区着色 + 搜索过滤
- [ ] EdgeType 包含 40 种 (12+1+5+22)
- [ ] `a.b.c.method()` 复合接收者调用正确解析到目标方法
- [ ] Entry Point Scoring 对 Next.js/Express/Django 项目正确识别入口
- [ ] Module Contract Registry: 自动从 codegraph.db 提取导出/API/事件合约
- [ ] 两阶段模块影响分析: 代码级 BFS + 合约级扇出正确，匹配引擎支持精确+通配符
- [ ] 所有现有测试通过

### Phase Z5: 集成测试 + 性能基准 (3.5 天)

**目标**: 端到端验证 + 性能基准 + Worker 线程

| 任务 | 天数 | 依赖 | 来源 |
|------|:----:|------|:----:|
| F-59: 性能基准测试 | 0.5 | 全部 | D2 |
| F-69: 回归测试 | 0.5 | 全部 | D4 |
| F-77: Worker 线程并行提取 | 0.5 | F-72 | 6f-1 |
| F-78: 端到端零 CLI 依赖测试 | 1 | F-76 | 6f |
| F-79: 进度回调直接调用验证 | 0.5 | F-76 | 6f |
| F-80: bun:compile 打包验证 | 0.5 | F-78 | 6f |

**验收条件**:
- [ ] 54K 节点规模 benchmark 达标
- [ ] 零 CLI 依赖下 init→extract→resolve→persist 流程贯通
- [ ] 进度回调直接调用，无 stderr 解析
- [ ] bun:compile 打包后 WASM 加载正常
- [ ] 所有现有测试通过

---

## 4. 功能清单

| # | 功能 | Phase | 天数 | 依赖 | 来源 |
|---|------|:-----:|:----:|------|:----:|
| F-52 | NodeMetadata 扩展 (13 新字段) | Z1 | 0.5 | 无 | D1 |
| F-53 | EdgeMeta 扩展 (5 新类型 + 元信息) | Z1 | 0.5 | 无 | D1 |
| F-54 | FileRecord 接口 + files 表加载 | Z1 | 0.5 | 无 | D1 |
| F-55 | GraphStore.loadCodegraph() 查询扩展 | Z1 | 0.5 | F-52~F-54 | D1 |
| F-56 | Prepared Statements 懒初始化 | Z2 | 0.5 | F-55 | D2 |
| F-57 | LRU 缓存 (1000 节点) | Z2 | 0.5 | F-56 | D2 |
| F-58 | 批量查询 getNodesByIds() | Z2 | 0.5 | F-57 | D2 |
| F-59 | 性能基准测试 | Z5 | 0.5 | 全部 | D2 |
| F-60 | FTS5 搜索集成 | Z3 | 1 | F-55 | D3 |
| F-61 | BM25 多信号评分 | Z3 | 0.5 | F-60 | D3 |
| F-62 | UnresolvedReference 接口 + 加载 | Z3 | 0.5 | F-55 | D3 |
| F-63 | codegraph_search 操作 (FTS5) | Z4 | 0.5 | F-60~F-61 | D3 |
| F-64 | codegraph_files 操作 | Z4 | 0.5 | F-54 | D3 |
| F-65 | codegraph_unresolved 操作 | Z4 | 0.5 | F-62 | D3 |
| F-66 | classifyRoles 利用新字段 | Z4 | 0.25 | F-52 | D4 |
| F-67 | backwardDataSlice 支持新边类型 | Z4 | 0.25 | F-53 | D4 |
| F-68 | 新边类型参与矩阵 | Z4 | 0.25 | F-53 | D4 |
| F-69 | 回归测试 | Z5 | 0.5 | 全部 | D4 |
| F-70 | tree-sitter WASM spike 验证 | Z1 | 0.5 | 无 | 6f-1 |
| F-71 | tree-sitter-types + helpers + grammars | Z1 | 0.5 | F-70 | 6f-1 |
| F-72 | tree-sitter.ts 核心提取器 (3242行) | Z2 | 2 | F-71 | 6f-2 |
| F-73 | extraction/index.ts 编排器 (1550行) | Z2 | 0.5 | F-72 | 6f-2 |
| F-74 | vue-extractor + svelte-extractor | Z3 | 0.5 | F-72 | 6f-3 |
| F-75 | liquid/mybatis/dfm 提取器 | Z3 | 0.5 | F-72 | 6f-3 |
| F-76 | CodegraphManager 替换为内置 extraction | Z4 | 0.5 | F-73 | 6f |
| F-77 | Worker 线程并行提取 | Z5 | 0.5 | F-72 | 6f-1 |
| F-78 | 端到端零 CLI 依赖测试 | Z5 | 1 | F-76 | 6f |
| F-79 | 进度回调直接调用验证 | Z5 | 0.5 | F-76 | 6f |
| F-80 | bun:compile 打包验证 | Z5 | 0.5 | F-78 | 6f |
| F-82 | RRF 混合搜索融合 (K=60) | Z3 | 0.5 | F-60 | 三项目评审 |
| F-85 | 边置信度系统 (EXTRACTED/INFERRED/AMBIGUOUS) | Z1 | 0.5 | F-53 | 三项目评审 |
| F-86 | 预计算上下文 (索引时 PageRank/社区/流) | Z4 | 1 | F-73 | 三项目评审 |
| F-95 | DataSourceAdapter 接口提取 | Z1 | 0.5 | F-01 | 专家评审 |
| F-96 | Dashboard 可视化 (终端轻量版, codegraph_dashboard op) | Z4 | 3 | F-16 | 差距补全 |
| F-97-P1 | EdgeType P1 扩展 (subscribes/publishes/middleware/flow_step/cross_domain) | Z1 | 1 | F-53 | UA 差距分析 |
| F-97-P2 | EdgeType P2/P3 扩展 (22 种) | Z4 | 1 | F-53 | 差距补全 |
| F-98 | SemanticModel 三层注册表 (Type/Method/Field + SymbolTable) | Z2 | 0.5 | F-72 | GitNexus |
| F-99 | Scope Resolution Pipeline (4阶段) + ScopeResolver 接口 | Z2 | 1 | F-98 | GitNexus |
| F-100 | TS/JS/Python scope-resolver (跨文件符号解析) | Z2 | 0.5 | F-99 | GitNexus |
| F-101 | 7-case Receiver + Import Resolver + Entry Point Scoring + DAG Runner | Z4 | 2 | F-99 | GitNexus |
| F-102 | 16 语言 Scope Provider (分3批) | 6c | 4 | F-101 | GitNexus |
| F-103 | Module Contract Registry (自动提取模块导出/API/事件合约到 SQLite) | Z4 | 2 | F-01 | Cross-Repo 借鉴 |
| F-104 | 两阶段模块影响分析 (代码级 BFS + 合约级扇出) + 合约匹配引擎 | Z4 | 1.5 | F-103 | Cross-Repo 借鉴 |
| F-105 | 批量 LLM 分析编排模式 (批次分割+并发控制+中间文件容错) | Z2 | 0.5 | F-72 | article-analyzer 借鉴 |
| F-106 | SemanticSearchEngine 补全 (EmbeddingProvider + VectorStore + RRF 三路融合) | Z3 | 1.5 | F-82 | UA 补全 |

**总计**: 45 个功能点 (F-52 ~ F-106)，32 天

---

## 5. 依赖关系

```
Phase Z1 (4.5天): 数据模型 + Extraction 基础 + EdgeType P1 + 边置信度 + DataSourceAdapter
  ├── F-52 NodeMetadata 21字段 ─────────────────────┐
  ├── F-53 EdgeMeta 17种 ──────────────────────────┤
  ├── F-54 FileRecord ─────────────────────────────┤
  ├── F-55 GraphStore 查询扩展 ←── F-52,53,54 ──────┤
  ├── F-70 tree-sitter WASM spike ─────────────────┤
  ├── F-71 tree-sitter 基础 ←── F-70 ──────────────┤
  ├── F-85 边置信度系统 ←── F-53 ──────────────────┤
  ├── F-95 DataSourceAdapter 接口 ←── F-01 ────────┤
  └── F-97-P1 EdgeType P1 (5种) ←── F-53 ──────────┤
                                                    │
Phase Z2 (6.5天): 查询优化 + Extraction 核心 + Scope Resolution 基础 + 批量 LLM 编排
  ├── F-56 Prepared Stmts ←── F-55 ────────────────┤
  ├── F-57 LRU 缓存 ←── F-56 ─────────────────────┤
  ├── F-58 批量查询 ←── F-57 ──────────────────────┤
  ├── F-72 tree-sitter.ts ←── F-71 ────────────────┤
  ├── F-73 extraction/index.ts ←── F-72 ───────────┤
  ├── F-98 SemanticModel ←── F-72 ─────────────────┤
  ├── F-99 Scope Pipeline + 接口 ←── F-98 ─────────┤
  ├── F-100 TS/JS/Python scope-resolver ←── F-99 ──┤
  └── F-105 批量 LLM 编排 ←── F-72 ────────────────┤
                                                    │
Phase Z3 (5天): 搜索能力 + RRF 融合 + SemanticSearchEngine 补全 + 专用提取器
  ├── F-60 FTS5 搜索 ←── F-55 ─────────────────────┤
  ├── F-61 BM25 评分 ←── F-60 ─────────────────────┤
  ├── F-62 UnresolvedRef ←── F-55 ─────────────────┤
  ├── F-82 RRF 混合搜索 ←── F-60 ──────────────────┤
  ├── F-106 SemanticSearchEngine 补全 ←── F-82 ─────┤
  ├── F-74 vue/svelte 提取器 ←── F-72 ─────────────┤
  └── F-75 liquid/mybatis/dfm ←── F-72 ────────────┤
                                                    │
Phase Z4 (12.5天): 操作集成 + 预计算上下文 + Dashboard + EdgeType P2/P3 + Scope Resolution 完整 + Contract Registry + 两阶段影响分析
  ├── F-63 codegraph_search ←── F-60,61 ───────────┤
  ├── F-64 codegraph_files ←── F-54 ───────────────┤
  ├── F-65 codegraph_unresolved ←── F-62 ──────────┤
  ├── F-66 classifyRoles ←── F-52 ─────────────────┤
  ├── F-67 backwardDataSlice ←── F-53 ─────────────┤
  ├── F-68 边类型矩阵 ←── F-53 ────────────────────┤
  ├── F-86 预计算上下文 ←── F-73 ──────────────────┤
  ├── F-76 CodegraphManager 替换 ←── F-73 ──────────┤
  ├── F-96 Dashboard 可视化 ←── F-16 ──────────────┤
  ├── F-97-P2 EdgeType P2/P3 (22种) ←── F-53 ──────┤
  ├── F-101 Receiver/Import/EntryPoint/DAG ←── F-99 ┤
  ├── F-103 Contract Registry ←── F-01 ────────────┤
  └── F-104 两阶段模块影响分析 ←── F-103 ───────────┤
                                                    │
Phase Z5 (3.5天): 集成测试 + 性能基准                │
  ├── F-59 性能基准 ←── 全部 ──────────────────────┘
  ├── F-69 回归测试 ←── 全部
  ├── F-77 Worker 线程 ←── F-72
  ├── F-78 端到端测试 ←── F-76
  ├── F-79 进度回调验证 ←── F-76
  └── F-80 bun:compile 验证 ←── F-78

Phase 6c (4天): 16 语言 Scope Provider
  └── F-102 16 语言 Scope Provider ←── F-101
```

---

## 6. 预期效果

| 维度 | 当前 | 合并后 | 提升 |
|------|:----:|:------:|:----:|
| CLI 依赖 | 外部二进制 ~45MB | **零依赖** | 100% |
| 版本管理 | 硬编码 0.9.6 | **跟随 ola-cc** | 100% |
| 进度交互 | stderr ANSI 解析 | **直接回调** | 100% |
| 节点属性 | 8/21 (38%) | **21/21 (100%)** | +62% |
| 边类型 | 7/12 (58%) | **40/40 (100%)** | +233% |
| 文件级追踪 | 0/7 (0%) | **7/7 (100%)** | +100% |
| 全文搜索 | 无 | **FTS5 + BM25 + RRF** | 新增 |
| 语义搜索 | 无 (UA 25% 未完成) | **SemanticSearchEngine + EmbeddingProvider + VectorStore** | 新增 |
| 查询优化 | 线性扫描 | **LRU + Prepared** | 新增 |
| 作用域解析 | 无 | **16 语言 Scope Pipeline** | 新增 |
| 模块合约分析 | 无 | **Contract Registry + 两阶段影响** | 新增 |
| Dashboard | 无 | **终端轻量版 (D3.js)** | 新增 |
| **数据完整性** | **6/10** | **9/10** | **+50%** |

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| tree-sitter WASM bun:compile 不兼容 | Phase 6f 全部阻塞 | Z1 阶段先做 spike 验证 |
| grammar 文件打包策略未定 | 文件大小 / 按需下载 | 参考 codegraph 的 grammars.ts 实现 |
| 3242 行 tree-sitter.ts 移植复杂 | Z2 延期 | 按语言分批移植，先 TS/JS/Python |
| LRU 缓存一致性 | 脏读 | reload() 时清空缓存 |
| FTS5 索引维护 | 增量更新 | codegraph.db 已有触发器自动同步 |

---

## 8. 与原有 Phase 的关系

| 原 Phase | 合并后 | 说明 |
|---------|--------|------|
| Phase D1 | Z1 | 数据模型对齐 |
| Phase D2 | Z2 | 查询优化 |
| Phase D3 | Z3 | 搜索能力 |
| Phase D4 | Z4 | GraphEngine 适配 |
| Phase 6f-1 | Z1 + Z5 | WASM 基础 + Worker 线程 |
| Phase 6f-2 | Z2 | 主提取器 + 编排器 |
| Phase 6f-3 | Z3 | 专用提取器 |
| Phase 6f 集成 | Z4 + Z5 | Manager 替换 + 端到端测试 |
| 三项目评审 F-85 | Z1 | 边置信度系统 |
| 三项目评审 F-82 | Z3 | RRF 混合搜索融合 |
| 三项目评审 F-86 | Z4 | 预计算上下文 |
| 专家评审 F-95 | Z1 | DataSourceAdapter 接口 |
