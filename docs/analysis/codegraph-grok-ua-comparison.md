# CodeGraph + Grok vs Understand-Anything 完整能力对比分析

> 日期: 2026-06-05 | 修正: 2026-06-05 (代码级验证后修正)
> 分析范围: codegraph v0.9.6 (colbymchenry/codegraph) + ola-cc GraphEngine/GrokManager + Understand-Anything v2.7.6 (Lum1104/Understand-Anything)
>
> **验证说明**: 本文档经代码级验证后修正了三处不准确结论：(1) 边类型"丢失"→"降级为 control"；(2) token 浪费比例标注为估算值；(3) TUI 进度集成标注为已修复。详见各节修正注释。

---

## 一、三方架构定位

| 维度 | CodeGraph (上游) | ola-cc (本地) | Understand-Anything |
|------|:---:|:---:|:---:|
| 核心定位 | 精确 AST 静态分析 | 双引擎融合 | LLM 驱动架构理解 |
| 索引方式 | tree-sitter (外部二进制) | tree-sitter (via codegraph CLI) | tree-sitter (WASM) + LLM |
| 查询延迟 | 毫秒级 (SQLite) | 毫秒级 + 秒级 (LLM) | 秒级 (LLM) |
| LLM 依赖 | 无 | Grok 阶段性调用 | 全流程 LLM |
| 节点粒度 | 函数/方法/变量/字段 | 同 CodeGraph + LLM 语义 | 文件/模块级 + LLM 语义 |

---

## 二、节点类型对比 (CodeGraph 22 种 vs UA 21 种)

### 代码节点

| 节点类型 | CodeGraph | UA | ola-cc 已继承 | 说明 |
|---------|:---:|:---:|:---:|------|
| file | ✅ | ✅ | ✅ | |
| function | ✅ | ✅ | ✅ | |
| class | ✅ | ✅ | ✅ | |
| module | ✅ | ✅ | ✅ | |
| method | ✅ | ❌ | ✅ | CodeGraph 独有 |
| property | ✅ | ❌ | ✅ | CodeGraph 独有 |
| field | ✅ | ❌ | ✅ | CodeGraph 独有 |
| variable | ✅ | ❌ | ✅ | CodeGraph 独有 |
| constant | ✅ | ❌ | ✅ | CodeGraph 独有 |
| enum | ✅ | ❌ | ✅ | CodeGraph 独有 |
| enum_member | ✅ | ❌ | ✅ | CodeGraph 独有 |
| type_alias | ✅ | ❌ | ✅ | CodeGraph 独有 |
| interface | ✅ | ❌ | ✅ | CodeGraph 独有 (kind=interface) |
| struct | ✅ | ❌ | ❌ | CodeGraph 有, ola-cc 未暴露 |
| trait | ✅ | ❌ | ❌ | CodeGraph 有, ola-cc 未暴露 |
| protocol | ✅ | ❌ | ❌ | CodeGraph 有, ola-cc 未暴露 |
| parameter | ✅ | ❌ | ❌ | CodeGraph 有, ola-cc 未暴露 |
| import | ✅ | ❌ | ✅ | CodeGraph 独有 |
| export | ✅ | ❌ | ✅ | CodeGraph 独有 |
| namespace | ✅ | ❌ | ❌ | CodeGraph 有, ola-cc 未暴露 |
| route | ✅ | ❌ | ❌ | CodeGraph 有, ola-cc 未暴露 (框架解析器生成) |
| component | ✅ | ❌ | ❌ | CodeGraph 有, ola-cc 未暴露 (React/Vue/Svelte) |
| concept | ❌ | ✅ | ❌ | UA 独有 (编程概念) |

### 非代码节点

| 节点类型 | CodeGraph | UA | ola-cc 已继承 | 说明 |
|---------|:---:|:---:|:---:|------|
| config | ❌ | ✅ | ❌ | UA 独有 |
| document | ❌ | ✅ | ❌ | UA 独有 |
| service | ❌ | ✅ | ❌ | UA 独有 (Docker) |
| table | ❌ | ✅ | ❌ | UA 独有 (SQL) |
| endpoint | ❌ | ✅ | ❌ | UA 独有 (OpenAPI) |
| pipeline | ❌ | ✅ | ❌ | UA 独有 (CI/CD) |
| schema | ❌ | ✅ | ❌ | UA 独有 (GraphQL/Protobuf) |
| resource | ❌ | ✅ | ❌ | UA 独有 (Terraform) |

### 领域节点

| 节点类型 | CodeGraph | UA | ola-cc 已继承 | 说明 |
|---------|:---:|:---:|:---:|------|
| domain | ❌ | ✅ | ❌ | UA 独有 |
| flow | ❌ | ✅ | ❌ | UA 独有 |
| step | ❌ | ✅ | ❌ | UA 独有 |

### 知识节点 (UA 独有)

| 节点类型 | CodeGraph | UA | ola-cc 已继承 |
|---------|:---:|:---:|:---:|
| article | ❌ | ✅ | ❌ |
| entity | ❌ | ✅ | ❌ |
| topic | ❌ | ✅ | ❌ |
| claim | ❌ | ✅ | ❌ |
| source | ❌ | ✅ | ❌ |

---

## 三、边类型对比 (CodeGraph 12 种 vs UA 35 种)

### 重叠边 (7 种)

| 边类型 | CodeGraph | UA | ola-cc GraphStore 映射 |
|--------|:---:|:---:|:---:|
| contains | ✅ | ✅ | ✅ contains→contains |
| calls | ✅ | ✅ | ✅ calls→calls |
| imports | ✅ | ✅ | ✅ imports→imports |
| extends/inherits | ✅ | ✅ | ✅ extends→inherits |
| implements | ✅ | ✅ | ✅ implements→implements |
| references/depends_on | ✅ | ✅ | ✅ references→data |
| exports | ✅ | ✅ | ⚠️ **降级为 control** (未显式映射，fallback) |

### CodeGraph 独有边 (5 种, ola-cc 未继承)

| 边类型 | CodeGraph | UA | ola-cc GraphStore | 实际 DB 数据 |
|--------|:---:|:---:|:---:|:---:|
| type_of | ✅ | ❌ | ⚠️ 降级为 control | 0 条 (未生成) |
| returns | ✅ | ❌ | ⚠️ 降级为 control | 0 条 (未生成) |
| instantiates | ✅ | ❌ | ⚠️ 映射为 calls | 819 条 |
| overrides | ✅ | ❌ | ⚠️ 降级为 control | 0 条 (未生成) |
| decorates | ✅ | ❌ | ⚠️ 降级为 control | 0 条 (未生成) |

> **修正说明 (2026-06-05)**: 原文称"未映射 (丢失)"，经代码验证：(1) 这 5 种边类型在 `CODEGRAPH_EDGE_MAP` 中无显式映射，走 `?? 'control'` fallback，语义被降级而非丢弃；(2) 经 `sqlite3 .codegraph/codegraph.db` 验证，实际数据库中只有 7 种边类型 (calls/imports/contains/references/extends/implements/instantiates)，type_of/returns/overrides/decorates/exports 在当前 codegraph v0.9.6 中未被生成。见 `src/services/graph/GraphStore.ts:46-63`。

### UA 独有边 (23 种, ola-cc 完全缺失)

| 类别 | 边类型 | 说明 |
|------|--------|------|
| Behavioral | subscribes | 事件订阅 |
| Behavioral | publishes | 事件发布 |
| Behavioral | middleware | 中间件链 |
| Data Flow | reads_from | 数据读取 |
| Data Flow | writes_to | 数据写入 |
| Data Flow | transforms | 数据转换 |
| Data Flow | validates | 数据验证 |
| Dependencies | tested_by | 测试覆盖 |
| Dependencies | configures | 配置关系 |
| Semantic | related | 相关关系 |
| Semantic | similar_to | 相似关系 |
| Infrastructure | deploys | 部署关系 |
| Infrastructure | serves | 服务关系 |
| Infrastructure | provisions | 资源配置 |
| Infrastructure | triggers | 触发关系 |
| Schema/Data | migrates | 数据迁移 |
| Schema/Data | documents | 文档化 |
| Schema/Data | routes | 路由关系 |
| Schema/Data | defines_schema | Schema 定义 |
| Domain | contains_flow | 域包含流程 |
| Domain | flow_step | 流程步骤 |
| Domain | cross_domain | 跨域交互 |
| Knowledge | cites/contradicts/builds_on/exemplifies/categorized_under/authored_by | 知识图谱边 (6种) |

---

## 四、语言支持对比

### CodeGraph: 29 种语言

编程语言 (19): TypeScript, JavaScript, TSX, JSX, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, Swift, Kotlin, Dart, Lua, Luau, Objective-C

框架/模板 (5): Svelte, Vue, Liquid, Pascal, Scala

配置/标记 (5): YAML, Twig, XML, Properties, Unknown

### Understand-Anything: 14 种代码语言 + 41 种语言配置

代码语言有 tree-sitter WASM (11): TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, PHP, C, C++, C#

代码语言有配置无 WASM (3): Swift, Kotlin, Lua

语言配置 (41): 包含上述 + OpenAPI, Kubernetes, Docker Compose, JSON Schema, CSV/TSV, GitHub Actions, HTML, CSS/SCSS/SASS/LESS, Jenkinsfile, PowerShell, Batch, Plaintext 等

### ola-cc 当前继承

- 通过 CodeGraph CLI: 全部 29 种语言 ✅
- 通过 UA: 未继承 ❌ (Grok 不使用 tree-sitter)

---

## 五、非代码文件解析器对比

### UA 有 12 个解析器, ola-cc 完全缺失

| 解析器 | 文件类型 | 提取结构 | ola-cc 继承 |
|--------|---------|---------|:---:|
| MarkdownParser | .md, .mdx, .rst | sections | ❌ |
| YAMLConfigParser | .yaml, .yml | definitions | ❌ |
| JSONConfigParser | .json, .jsonc | definitions | ❌ |
| TOMLParser | .toml | definitions | ❌ |
| EnvParser | .env | definitions | ❌ |
| DockerfileParser | Dockerfile | services, steps | ❌ |
| SQLParser | .sql | definitions (table/view) | ❌ |
| GraphQLParser | .graphql, .gql | definitions | ❌ |
| ProtobufParser | .proto | definitions | ❌ |
| TerraformParser | .tf | resources | ❌ |
| MakefileParser | Makefile | steps | ❌ |
| ShellParser | .sh, .bash | steps | ❌ |

### CodeGraph 有 5 个非代码解析器, ola-cc 已继承

| 解析器 | 文件类型 | ola-cc 继承 |
|--------|---------|:---:|
| DFM/FMX Extractor | Delphi 表单 | ✅ (通过 CLI) |
| MyBatis Extractor | MyBatis XML | ✅ (通过 CLI) |
| Liquid Extractor | Liquid 模板 | ✅ (通过 CLI) |
| Svelte Extractor | Svelte 组件 | ✅ (通过 CLI) |
| Vue Extractor | Vue SFC | ✅ (通过 CLI) |

---

## 六、图算法对比

### CodeGraph 原生: 6 种基础遍历

BFS, DFS, 最短路径, 调用图 (双向), 类型层次, 影响半径

### ola-cc GraphEngine: 15 种算法 (自研)

BFS, DFS, backwardReachability, tarjanSCC, topologicalSort, pageRank, dominatorTree, deltaGraph, classifyRoles, backwardDataSlice, couplingMetrics, katzCentrality, betweennessCentrality, louvainCommunity, temporalCoupling

### UA: 有限图算法

- Louvain 社区检测 (graphology 库)
- 无 PageRank/SCC/中心性等

### 对比: ola-cc 图算法能力最强 ✅

---

## 七、LLM 语义增强能力对比

| 能力 | CodeGraph | UA | ola-cc Grok |
|------|:---:|:---:|:---:|
| 节点摘要 (summary) | ❌ | ✅ | ⚠️ 有但质量差 |
| 标签 (tags) | ❌ | ✅ | ❌ |
| 复杂度 (complexity) | ❌ | ✅ | ❌ |
| 架构层 (layer) | ❌ | ✅ | ⚠️ 有但粗糙 |
| 业务域 (domain) | ❌ | ✅ | ❌ (空字符串) |
| 引导式 Tour | ❌ | ✅ | ⚠️ 有但质量差 |
| 图验证 | ❌ | ✅ (9项检查) | ❌ |
| 自然语言问答 | ❌ | ✅ | ✅ |
| 代码解释 | ❌ | ✅ | ✅ |
| 变更影响分析 | ❌ | ✅ | ✅ |
| Dashboard 可视化 | ❌ | ✅ (React) | ⚠️ 基础版 |

---

## 八、搜索能力对比

| 能力 | CodeGraph | UA | ola-cc |
|------|:---:|:---:|:---:|
| FTS5 全文搜索 | ✅ | ❌ | ✅ (通过 CLI) |
| 模糊搜索 (编辑距离) | ✅ | ✅ (Fuse.js) | ✅ (通过 CLI) |
| 结构化查询 (kind:/lang:) | ✅ | ❌ | ✅ (通过 CLI) |
| 向量语义搜索 | ❌ | ✅ (cosine) | ❌ |
| 语义搜索 | ❌ | ✅ | ❌ |

---

## 九、增量更新对比

| 能力 | CodeGraph | UA | ola-cc |
|------|:---:|:---:|:---:|
| 文件监视 (chokidar) | ✅ | ❌ | ❌ |
| 增量索引 (content hash) | ✅ | ✅ (fingerprint) | ✅ (SHA-256) |
| git diff 检测 | ❌ | ✅ (staleness) | ✅ (IncrementalSync) |
| mtime 检测 | ❌ | ❌ | ✅ |
| 结构指纹 | ❌ | ✅ | ❌ |
| 变更分类器 | ❌ | ✅ | ❌ |

---

## 十、Agent 系统对比

### UA: 9 个 Agent

1. project-scanner — 文件枚举 + 语言/框架检测
2. file-analyzer — tree-sitter + LLM 两阶段分析
3. architecture-analyzer — 架构层识别
4. tour-builder — 学习路径设计
5. graph-reviewer — 图谱验证 (9项检查)
6. assemble-reviewer — 合并审查
7. domain-analyzer — 业务域分析
8. article-analyzer — Wiki 文章分析
9. knowledge-graph-guide — 图谱使用指南

### ola-cc Grok: 5 个阶段 (复刻 UA 部分 Agent 提示词)

1. Scanner — 文件发现 + 语言检测 (复刻 project-scanner)
2. Analyzer — LLM 源码分析 (复刻 file-analyzer, 但跳过 tree-sitter)
3. Architecture — 架构层 (复刻 architecture-analyzer)
4. Tour — 学习路径 (复刻 tour-builder)
5. Review — 审查 (复刻 graph-reviewer, 但无验证脚本)

### 缺失的 Agent

| UA Agent | ola-cc 继承 | 缺失影响 |
|----------|:---:|---------|
| project-scanner | ⚠️ 部分 | 缺 import map 生成、.understandignore |
| file-analyzer | ⚠️ 部分 | **跳过 tree-sitter Phase 1**, 直接 LLM 分析源码 |
| architecture-analyzer | ⚠️ 部分 | 缺目录分组 + import 邻接矩阵计算 |
| tour-builder | ⚠️ 部分 | 缺 fan-in/fan-out 排名、依赖链分析 |
| graph-reviewer | ❌ 未继承 | 缺 9 项验证检查、审批/拒绝决策 |
| assemble-reviewer | ❌ 未继承 | 缺合并审查、ID 规范化 |
| domain-analyzer | ❌ 未继承 | 缺三层业务域模型 (domain/flow/step) |
| article-analyzer | ❌ 未继承 | 缺 Wiki 文章知识提取 |
| knowledge-graph-guide | ❌ 未继承 | 缺图谱使用指南 |

---

## 十一、CodeGraph 上游能力继承清单

### ola-cc 已继承 (通过 CodegraphTool + CodegraphManager)

- ✅ 21 个 CLI 操作 (context/search/callers/callees/impact/trace/explore/status/init/files/sync)
- ✅ 10 个 MCP 工具
- ✅ 22 种 NodeKind 中的 17 种 (缺 struct/trait/protocol/parameter/namespace/route/component)
- ✅ 12 种 EdgeKind 中的 7 种 (缺 type_of/returns/overrides/decorates/exports)
- ✅ 29 种语言支持
- ✅ 21 种框架解析器
- ✅ 动态回调边合成 (callback-synthesizer)
- ✅ Swift-ObjC 桥接解析
- ✅ 7 种引用解析策略
- ✅ FTS5 全文搜索 + 模糊搜索
- ✅ SQLite WAL 存储 + Schema 迁移
- ✅ 文件监视 (chokidar)
- ✅ MCP 服务器 (3 种模式)

### ola-cc 未继承的 CodeGraph 上游能力

- ⚠️ 5 种 EdgeKind (type_of, returns, overrides, decorates, exports) — 未显式映射，降级为 control (实际 DB 中仅 instantiates 存在 819 条，其余 4 种未生成)
- ❌ 5 种 NodeKind (struct, trait, protocol, parameter, namespace, route, component)
- ❌ callback-synthesizer 的完整回调模式 (EventEmitter/React/Vue/RN/MyBatis)
- ❌ FrameworkResolver.postExtract() — 框架后处理
- ❌ FrameworkResolver.claimsReference() — 动态分发引用声明
- ❌ extractReExports() — re-export 链追踪
- ❌ loadCppIncludeDirs() — C++ include 目录发现
- ❌ ExtractionOrchestrator.sync() — 基于 stat 的增量同步

---

## 十二、Understand-Anything 能力继承清单

### ola-cc 已继承 (通过 GrokManager LLM Pipeline)

- ⚠️ 5 个 Agent 系统提示词 (scanner/analyzer/architecture/tour/review)
- ⚠️ knowledge-graph.json 数据格式
- ⚠️ 存储路径 .understand-anything/
- ⚠️ Dashboard HTTP 服务器 (基础版)

### ola-cc 未继承的 UA 能力

- ❌ 12 个非代码文件解析器 (Docker/CI/Terraform/OpenAPI/GraphQL/Protobuf/SQL/Markdown/YAML/JSON/TOML/Env/Makefile/Shell)
- ❌ 9 个专用 tree-sitter extractor (TypeScript/Python/Go/Rust/Java/Ruby/PHP/C-C++/C#)
- ❌ PluginRegistry + LanguageRegistry 架构
- ❌ 结构指纹 (fingerprint.ts) 增量更新
- ❌ 变更分类器 (change-classifier.ts)
- ❌ 过期检测 (staleness.ts) + 图谱合并
- ❌ 图谱验证 (graph-reviewer Agent + 验证脚本)
- ❌ 领域分析 (domain-analyzer Agent + 三层模型)
- ❌ 向量语义搜索 (embedding-search.ts)
- ❌ Fuse.js 模糊搜索 (search.ts)
- ❌ 图谱 schema 验证 (Zod) + 75+ 别名规范化
- ❌ Louvain 社区检测批次计算 (compute-batches.mjs)
- ❌ 多语言输出 (en/zh/zh-TW/ja/ko/ru)
- ❌ assemble-reviewer 合并审查
- ❌ article-analyzer Wiki 知识提取
- ❌ knowledge-graph-guide 使用指南
- ❌ Tour 的 fan-in/fan-out 排名 + 依赖链分析
- ❌ Architecture 的目录分组 + import 邻接矩阵

---

## 十三、优先级排序的缺失项

### P0 — 核心架构缺陷

| 缺失项 | 影响 | 来源 | 验证状态 |
|--------|------|------|:---:|
| Grok Analyzer 跳过 tree-sitter | LLM 浪费 (估算 ~50%，原始源码 30KB vs 理论元数据 5-8KB) | UA file-analyzer | ✅ 代码确认: `buildFileAnalyzerPrompt` 直接 `readFileSync`，零 tree-sitter 依赖 |
| GraphStore 5 种 EdgeKind 未映射 | 语义降级为 control (实际 DB 仅 instantiates 819 条存在，其余 4 种当前未生成) | CodeGraph 上游 | ✅ 代码确认: `CODEGRAPH_EDGE_MAP` 7/12 映射，`?? 'control'` fallback |
| 无图验证 | 质量无保障 | UA graph-reviewer | 未验证 |

> **修正说明 (2026-06-05)**: (1) "50% LLM 浪费"为估算值，未经实际 token 计数验证，实际浪费比例取决于 LLM 输出中结构信息 vs 语义信息的比例；(2) "丢失"修正为"降级"，且经 DB 验证 5 种中 4 种在当前版本未生成；(3) 系统提示词 (`AGENT_SYSTEM_PROMPTS.analyzer`) 声称 "Parse source files using Tree-sitter" 但实际无 tree-sitter 调用，存在 prompt-implementation 不一致。

### P1 — 重要能力缺失

| 缺失项 | 影响 | 来源 |
|--------|------|------|
| 无非代码文件解析 | 丢失基础设施层 | UA 12 解析器 |
| 无 LLM 语义增强 (summary/tags/complexity) | 节点无摘要 | UA file-analyzer Phase 2 |
| 无领域分析 (domain/flow/step) | 无业务视角 | UA domain-analyzer |
| 无结构指纹增量更新 | 每次全量分析 | UA fingerprint.ts |
| 无向量语义搜索 | 搜索能力弱 | UA embedding-search.ts |

### P2 — 增强能力

| 缺失项 | 影响 | 来源 |
|--------|------|------|
| 无 assemble-reviewer | 合并可能丢失节点 | UA assemble-reviewer |
| 无 Tour 增强 (fan-in/fan-out) | 学习路径质量差 | UA tour-builder |
| 无多语言输出 | 只支持英文 | UA i18n |
| 无 article-analyzer | Wiki 知识未提取 | UA article-analyzer |
| 无 Dashboard 增强 (React) | 可视化简陋 | UA dashboard |

### P3 — codegraph init TUI 进度集成 ✅ 已修复

| 缺失项 | 影响 | 来源 | 状态 |
|--------|------|------|:---:|
| codegraph init -i 的交互式 TUI | 用户看不到索引进度 | CodeGraph 上游 | ✅ 已实施 |
| 索引进度条 (文件计数/阶段/耗时) | 体验差 | CodeGraph 上游 | ✅ 已实施 |

> **修正说明 (2026-06-05)**: 3 处代码修改已全部实施到位，解析链 (shimmer-worker stdout → 行缓冲 → parseCodegraphStderr → renderToolUseProgressMessage) 已贯通。详见 `codegraph-init-tui-integration.md`。
