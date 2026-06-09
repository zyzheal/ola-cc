# Understand-Anything 深度代码分析

> 日期: 2026-06-05
> 源码: `/tmp/understand-anything/`
> 版本: 2.7.6
> 分析范围: 架构、核心能力、数据模型、Agent 系统、与 codegraph/ola-cc 对比

---

## 1. 项目架构

### 1.1 目录结构

```
/tmp/understand-anything/
├── understand-anything-plugin/           # 核心插件
│   ├── agents/                           # 7 个 Agent 定义 (Markdown)
│   │   ├── project-scanner.md            # 文件发现 + 语言检测
│   │   ├── file-analyzer.md              # 两阶段分析 (tree-sitter + LLM)
│   │   ├── architecture-analyzer.md      # 结构分析 + 语义层分配
│   │   ├── tour-builder.md               # 图拓扑分析 + 教学路径
│   │   ├── graph-reviewer.md             # 9 项验证检查
│   │   ├── domain-analyzer.md            # 三层业务领域模型
│   │   └── article-analyzer.md           # Wiki 文章实体提取
│   ├── skills/                           # 8 个 Skill 定义
│   │   ├── understand/SKILL.md           # 主编排 Skill (854行)
│   │   ├── understand-chat/              # 自然语言问答
│   │   ├── understand-dashboard/         # 可视化面板
│   │   ├── understand-diff/              # 变更分析
│   │   ├── understand-domain/            # 领域分析
│   │   ├── understand-explain/           # 代码解释
│   │   ├── understand-knowledge/         # 知识图谱
│   │   └── understand-onboard/           # 学习路径
│   └── packages/
│       ├── core/                         # 核心库 (@understand-anything/core)
│       │   └── src/
│       │       ├── types.ts (203行)      # 数据模型定义
│       │       ├── schema.ts (664行)     # Zod schema + 验证 + 自动修复
│       │       ├── fingerprint.ts (386行)# 结构指纹系统
│       │       ├── change-classifier.ts (144行) # 变更分类器
│       │       ├── search.ts (66行)      # Fuse.js 模糊搜索
│       │       ├── embedding-search.ts (84行) # 向量语义搜索
│       │       ├── staleness.ts (91行)   # 增量更新检测
│       │       ├── ignore-filter.ts      # .understandignore 过滤
│       │       ├── persistence/ (183行)  # JSON 文件持久化
│       │       ├── analyzer/
│       │       │   ├── graph-builder.ts (337行) # 图构建器
│       │       │   ├── llm-analyzer.ts (187行)  # LLM prompt 构建
│       │       │   ├── layer-detector.ts (285行) # 层检测
│       │       │   ├── tour-generator.ts (294行) # Tour 生成
│       │       │   ├── normalize-graph.ts (330行) # 图标准化
│       │       │   └── language-lesson.ts (211行) # 语言概念检测
│       │       ├── plugins/
│       │       │   ├── registry.ts (82行) # PluginRegistry
│       │       │   ├── tree-sitter-plugin.ts (~100行)
│       │       │   ├── extractors/       # 10 种语言提取器
│       │       │   └── parsers/          # 12 种非代码解析器
│       │       └── languages/            # 语言/框架注册表
│       └── dashboard/                    # 交互式 Web Dashboard
└── homepage/                             # 项目主页 (Astro)
```

### 1.2 整体架构

UA 采用 **7 阶段编排者-工作者 (Orchestrator-Worker)** 模式：

```
SKILL.md (编排者, 854行)
  │
  ├── Phase 0: 预检 (增量 vs 全量判断)
  ├── Phase 1: project-scanner Agent → scan-result.json
  ├── Phase 1.5: compute-batches.mjs → batches.json (语义分批)
  ├── Phase 2: file-analyzer Agent ×N → batch-*.json (最多5并发, 每批20-30文件)
  ├── Phase 3: assemble-reviewer Agent → assemble-review.json
  ├── Phase 4: architecture-analyzer Agent → layers.json
  ├── Phase 5: tour-builder Agent → tour.json
  ├── Phase 6: graph-reviewer Agent → review.json
  └── Phase 7: 保存 + 指纹基线 + 元数据
```

**关键设计决策**:
- **确定性脚本 + LLM 语义** 的混合架构：文件扫描、导入解析、结构提取由 Node.js 脚本完成；摘要、标签、层分类、Tour 设计由 LLM Agent 完成
- **批量并行**: 文件分析支持最多 5 个并发 Agent，每批 20-30 个文件
- **增量更新**: 基于 git diff + 结构指纹的三级变更检测

---

## 2. 核心能力分析

### 2.1 结构指纹 (Structural Fingerprint)

**文件**: `packages/core/src/fingerprint.ts` (386行)

**算法**:
1. **内容哈希**: `crypto.createHash("sha256")` 计算文件内容 SHA-256 哈希
2. **结构提取**: 基于 tree-sitter 的 `StructuralAnalysis` 提取函数签名、类签名、导入、导出
3. **指纹数据结构**:
   ```typescript
   interface FileFingerprint {
     contentHash: string
     functions: { name: string; params: string[]; returnType?: string; line: number }[]
     classes: { name: string; methods: string[]; properties: string[]; line: number }[]
     imports: { source: string; specifiers: string[] }[]
     exports: { name: string; line: number }[]
     totalLines: number
     hasStructuralAnalysis: boolean
   }
   ```

**三级变更检测** (`compareFingerprints`):
| 级别 | 条件 | 含义 |
|------|------|------|
| `NONE` | 内容哈希完全一致 | 文件未变 |
| `COSMETIC` | 内容不同但结构签名一致 | 仅内部逻辑变更，可跳过重新分析 |
| `STRUCTURAL` | 签名级变更 | 需要重新分析 |

**签名比较维度**:
- 函数增删、参数变更、返回类型变更、导出状态变更
- 类的方法/属性变更、导出状态变更
- 导入源和说明符变更
- 导出列表变更
- 函数行数大幅变化 (>50% 增减)

### 2.2 变更分类 (Change Classifier)

**文件**: `packages/core/src/change-classifier.ts` (144行)

**决策矩阵** (`classifyUpdate`):

| 条件 | 动作 |
|------|------|
| 无结构性变更 | `SKIP` |
| 部分结构性变更，同目录 | `PARTIAL_UPDATE` |
| 新增/删除目录 或 >10 个结构性文件 | `ARCHITECTURE_UPDATE` |
| >30 个结构性文件 或 >50% 文件结构性变更 | `FULL_UPDATE` |

**目录变更检测** (`detectDirectoryChanges`): 比较新增/删除文件的顶层目录是否引入了新的目录结构。

### 2.3 图验证 (Graph Validation)

**文件**: `packages/core/src/schema.ts` (664行)

**四层防御体系**:

| 层级 | 处理 | 示例 |
|------|------|------|
| Tier 1: Sanitize | 修正格式问题 | null → 空数组，大小写统一 |
| Tier 2: Auto-fix | 自动补全默认值 | 缺失 type → "file"，复杂度别名映射 |
| Tier 3: Drop | 丢弃无效元素 | 无效节点/边被移除 |
| Tier 4: Fatal | 终止验证 | 非对象输入、无有效节点 |

**9 项验证检查** (定义在 `graph-reviewer.md`):

| # | 检查项 | 级别 | 说明 |
|---|--------|:----:|------|
| 1 | Schema Validation | Critical | 验证每个节点/边的必填字段和类型 |
| 2 | Referential Integrity | Critical | 边的 source/target 必须引用存在的节点 |
| 3 | Completeness | Critical | 至少 1 个节点、1 个边、1 个层、1 个 Tour 步骤 |
| 4 | Layer Coverage | Critical | 文件级节点必须出现在恰好一个层中 |
| 5 | Uniqueness | Critical | 无重复节点 ID |
| 6 | Tour Validation | Warning | 步骤顺序、数量 (5-15)、nodeIds 非空 |
| 7 | Quality Checks | Warning | 摘要质量、自引用边、孤立节点 |
| 8 | Non-Code Node Quality | Warning | 非代码节点应有预期的边类型 |
| 9 | Node Type / ID Prefix | Warning | type 与 ID 前缀匹配 |

**别名系统**:
- 节点类型别名: 43 个映射 (如 `func`→`function`, `interface`→`class`, `container`→`service`)
- 边类型别名: 30 个映射 (如 `extends`→`inherits`, `uses`→`depends_on`)
- 复杂度别名: `low`→`simple`, `medium`→`moderate`, `high`→`complex`

### 2.4 领域分析 (Domain Analysis)

**Agent**: `agents/domain-analyzer.md` (125行)

**三层业务领域模型**:

| 层级 | 节点类型 | 示例 |
|------|----------|------|
| Business Domain | `domain` | "Order Management", "User Authentication" |
| Business Flow | `flow` | "Create Order", "Process Refund" |
| Business Step | `step` | "Validate input", "Check inventory" |

**边类型**:
- `contains_flow`: Domain → Flow (weight: 1.0)
- `flow_step`: Flow → Step (weight: 递增序列，如 0.1, 0.2, 0.3...)
- `cross_domain`: Domain → Domain (weight: 0.6)

**特殊规则**: flow_step 的 weight 编码步骤顺序（单调递增，0-1 范围内）。

### 2.5 Tour 增强 (Guided Tour)

**文件**: `packages/core/src/analyzer/tour-generator.ts` (294行)
**Agent**: `agents/tour-builder.md` (379行)

**双路径生成**:

**路径 1: 启发式 Tour** (`generateHeuristicTour`):
1. 分离 concept 节点和 code 节点
2. 构建邻接表和入度表
3. Kahn 算法拓扑排序
4. 如果有 layers → 按层分组；否则每 3 个节点一步
5. 概念节点作为最后的 "Key Concepts" 步骤
6. 分配顺序编号

**路径 2: LLM Tour** (`buildTourGenerationPrompt`):
- 提供项目元数据、节点摘要、边（前 50 条）、层信息
- 要求从入口点开始，遵循依赖流，分组相关文件
- 输出 5-15 个步骤，每个包含 title/description/nodeIds/languageLesson

**Tour Builder Agent 的图拓扑分析脚本** (Phase 1):
- Fan-In 排名（重要性）
- Fan-Out 排名（作用域）
- 入口点候选评分
- BFS 依赖链遍历
- 非代码文件清单
- 紧密耦合聚类

### 2.6 非代码解析器 (Non-Code Parsers)

**目录**: `packages/core/src/plugins/parsers/`

**12 种解析器**:

| 解析器 | 文件类型 | 提取内容 |
|--------|----------|----------|
| `MarkdownParser` | .md, .mdx | 标题 sections、本地文件/图片引用 |
| `YAMLConfigParser` | .yaml, .yml | 顶层 keys |
| `JSONConfigParser` | .json, .jsonc | 顶层 keys |
| `TOMLParser` | .toml | 顶层 sections |
| `EnvParser` | .env | 变量定义 |
| `DockerfileParser` | Dockerfile | 多阶段构建 stages、EXPOSE 端口、指令步骤 |
| `SQLParser` | .sql | CREATE TABLE/VIEW/INDEX 定义、列名 |
| `GraphQLParser` | .graphql, .gql | type/query/mutation/input/enum/union 定义 |
| `ProtobufParser` | .proto | message/enum/service/oneof 定义 |
| `TerraformParser` | .tf | resource/data/module/output/variable 定义 |
| `MakefileParser` | Makefile | targets |
| `ShellParser` | .sh, .bash | 函数定义 |

所有解析器实现 `AnalyzerPlugin` 接口，返回 `StructuralAnalysis`（包含 `sections`、`definitions`、`services`、`endpoints`、`steps`、`resources` 等可选字段）。

---

## 3. 数据模型

### 3.1 知识图谱结构

```typescript
interface KnowledgeGraph {
  version: string           // "1.0.0"
  kind?: "codebase" | "knowledge"
  project: ProjectMeta      // 项目元数据
  nodes: GraphNode[]        // 节点数组
  edges: GraphEdge[]        // 边数组
  layers: Layer[]           // 架构层
  tour: TourStep[]          // 引导式 Tour
}
```

### 3.2 节点类型 (21 种)

| 类别 | 类型 | 说明 |
|------|------|------|
| 代码 (5) | file, function, class, module, concept | 代码实体 |
| 非代码 (8) | config, document, service, table, endpoint, pipeline, schema, resource | 基础设施/配置 |
| 领域 (3) | domain, flow, step | 业务领域建模 |
| 知识 (5) | article, entity, topic, claim, source | 知识图谱 |

**节点 ID 约定**: `{type}:{path}[:{name}]`
- `file:src/index.ts`
- `function:src/utils.ts:formatDate`
- `config:tsconfig.json`
- `service:Dockerfile`

### 3.3 边类型 (35 种，8 个类别)

| 类别 | 类型 | 说明 |
|------|------|------|
| Structural (5) | imports, exports, contains, inherits, implements | 结构关系 |
| Behavioral (4) | calls, subscribes, publishes, middleware | 行为关系 |
| Data flow (4) | reads_from, writes_to, transforms, validates | 数据流 |
| Dependencies (3) | depends_on, tested_by, configures | 依赖关系 |
| Semantic (2) | related, similar_to | 语义关系 |
| Infrastructure (4) | deploys, serves, provisions, triggers | 基础设施 |
| Schema/Data (4) | migrates, documents, routes, defines_schema | 模式/数据 |
| Domain (3) | contains_flow, flow_step, cross_domain | 领域关系 |

**边权重约定**: 0.0-1.0 浮点数，不同边类型有默认权重。

### 3.4 持久化

存储在 `.understand-anything/` 目录下:

| 文件 | 内容 |
|------|------|
| `knowledge-graph.json` | 完整知识图谱 |
| `domain-graph.json` | 领域图谱 |
| `meta.json` | 分析元数据 (git hash, 时间戳, 文件数) |
| `fingerprints.json` | 结构指纹基线 |
| `config.json` | 项目配置 (autoUpdate, outputLanguage) |

---

## 4. Agent 系统

### 4.1 Agent 架构

UA 使用 **Markdown 定义的 Agent** 模式。每个 Agent 是一个 `.md` 文件，包含:
- `name`: Agent 名称
- `description`: 功能描述
- 详细的任务指令和输出格式要求
- 可调用的工具和脚本

### 4.2 7 个 Agent 职责

| Agent | 文件 | 行数 | 职责 |
|-------|------|:----:|------|
| project-scanner | `project-scanner.md` | ~234 | 文件发现 + 语言检测 + 导入映射 |
| file-analyzer | `file-analyzer.md` | ~521 | 两阶段分析 (tree-sitter + LLM)，批量输出 |
| architecture-analyzer | `architecture-analyzer.md` | ~481 | 结构分析脚本 + 语义层分配 |
| tour-builder | `tour-builder.md` | ~379 | 图拓扑分析脚本 + 教学路径设计 |
| graph-reviewer | `graph-reviewer.md` | ~240 | 9 项验证检查脚本 |
| domain-analyzer | `domain-analyzer.md` | ~125 | 三层业务领域模型 |
| article-analyzer | `article-analyzer.md` | ~93 | Wiki 文章实体/声明/隐式关系提取 |

### 4.3 协作流程

```
SKILL.md (编排者)
  │
  ├── Phase 1: project-scanner
  │     ├── 调用 scan-project.mjs (文件发现)
  │     ├── 调用 extract-import-map.mjs (导入映射)
  │     └── 输出 scan-result.json
  │
  ├── Phase 1.5: compute-batches.mjs
  │     └── 语义分批 → batches.json
  │
  ├── Phase 2: file-analyzer ×N (并行)
  │     ├── tree-sitter 结构提取
  │     ├── LLM 语义分析
  │     └── 输出 batch-*.json
  │
  ├── Phase 3: assemble-reviewer
  │     ├── 合并所有 batch 结果
  │     ├── 去重 + ID 修正
  │     └── 输出 assemble-review.json
  │
  ├── Phase 4: architecture-analyzer
  │     ├── 结构分析脚本 (Fan-In/Out, 入口点)
  │     ├── LLM 语义层分配
  │     └── 输出 layers.json
  │
  ├── Phase 5: tour-builder
  │     ├── 图拓扑分析脚本 (BFS, 耦合聚类)
  │     ├── LLM 教学路径设计
  │     └── 输出 tour.json
  │
  ├── Phase 6: graph-reviewer
  │     ├── 9 项验证检查
  │     └── 输出 review.json
  │
  └── Phase 7: 保存
        ├── knowledge-graph.json
        ├── domain-graph.json
        ├── fingerprints.json
        └── meta.json
```

---

## 5. 与 codegraph / ola-cc 对比

### 5.1 图构建方式

| 维度 | UA | codegraph | ola-cc Grok |
|------|-----|-----------|-------------|
| **结构提取** | tree-sitter (10 种语言 + 12 种非代码) | tree-sitter (通过 bun:sqlite) | LLM Agent |
| **语义分析** | LLM Agent 生成摘要/标签/层分类 | 无 LLM | LLM Agent |
| **边生成** | LLM + 确定性脚本混合 | 确定性 AST 提取 | LLM Agent |
| **节点类型** | 21 种 | 22 种 | ~10 种 |
| **边类型** | 35 种 | 12 种 | ~5 种 |

### 5.2 LLM 依赖度

| 维度 | UA | codegraph | ola-cc Grok |
|------|-----|-----------|-------------|
| **核心流程** | 强依赖 LLM | 零 LLM | 部分依赖 |
| **成本** | 高 (大量 API 调用) | 零 | 中等 |
| **速度** | 慢 (多 Agent 串行/并行) | 快 (纯本地计算) | 中等 |
| **可重复性** | 结构侧可重复，语义侧有随机性 | 完全确定性 | 语义侧有随机性 |

### 5.3 各自优势

**UA 独有优势**:
1. 丰富的语义信息 (摘要、标签、复杂度评估)
2. 业务领域建模 (Domain/Flow/Step 三层模型)
3. 引导式学习路径 (Tour) + 启发式拓扑排序
4. 非代码文件支持 (12 种解析器)
5. 交互式 Dashboard (D3.js, 7 种语言国际化)
6. 四层验证体系 (Sanitize → Auto-fix → Drop → Fatal)
7. 别名系统 (43 节点别名 + 30 边别名)

**codegraph 独有优势**:
1. 零 LLM 成本
2. 极快的分析速度
3. 完全确定性和可重复性
4. SQLite 高效存储 + FTS5 全文搜索
5. 实时增量同步 (git diff → mtime → hash)

**ola-cc Grok 独有优势**:
1. 15 种内置图算法 (PageRank, SCC, Louvain 等)
2. 双引擎合并 (codegraph AST + Grok LLM)
3. GraphStore 统一图存储层
4. 渐进式增强 (任一数据源缺失不阻塞)

### 5.4 互补性分析

```
┌─────────────────────────────────────────────────────────────────┐
│                        三方互补关系                               │
│                                                                  │
│  codegraph (结构精确)                                            │
│    ├── AST 提取: 22 种节点 + 12 种边                             │
│    ├── SQLite 存储 + FTS5 搜索                                   │
│    ├── 实时增量同步                                               │
│    └── 零 LLM 成本                                               │
│           │                                                      │
│           │ 数据合并 (GraphStore)                                 │
│           ▼                                                      │
│  ola-cc (算法引擎)                                               │
│    ├── GraphEngine: 15 种图算法                                  │
│    ├── GraphStore: 双数据源统一                                   │
│    ├── CodegraphTool: 16 个操作                                  │
│    └── GrokTool: 12 个操作                                       │
│           │                                                      │
│           │ 能力移植 (Phase Z1-Z5 + Phase 3)                     │
│           ▼                                                      │
│  UA (语义丰富)                                                   │
│    ├── 结构指纹: SHA-256 + tree-sitter 三级变更检测               │
│    ├── 变更分类: SKIP/PARTIAL/ARCHITECTURE/FULL                  │
│    ├── 图验证: 四层防御 + 9 项检查 + 别名系统                     │
│    ├── 领域分析: Domain→Flow→Step 三层模型                       │
│    ├── Tour 增强: Kahn 拓扑排序 + Fan-In/Out 排名                │
│    └── 非代码解析: 12 种解析器                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. 移植建议

### 6.1 高价值移植模块

| 模块 | 来源 | 行数 | 价值 | 优先级 |
|------|------|:----:|------|:------:|
| 结构指纹 (fingerprint.ts) | UA | 386 | 三级变更检测，跳过注释变更 | P0 |
| 变更分类器 (change-classifier.ts) | UA | 144 | 智能增量更新策略 | P0 |
| 图验证 (schema.ts) | UA | 664 | 四层防御 + 9 项检查 + 别名系统 | P1 |
| Tour 生成器 (tour-generator.ts) | UA | 294 | Kahn 拓扑排序 + Fan-In/Out | P1 |
| 非代码解析器 (parsers/) | UA | ~500 | 12 种解析器 | P2 |
| 领域分析 (domain-analyzer.md) | UA | 125 | 三层业务领域模型 | P2 |
| 层检测 (layer-detector.ts) | UA | 285 | 启发式 + LLM 层分配 | P2 |
| 语言概念检测 (language-lesson.ts) | UA | 211 | 12 种语言概念模式 | P3 |

### 6.2 移植策略

**Phase 1: 结构指纹 + 变更分类 (P0, 2 天)**
- 移植 `fingerprint.ts` 的三级变更检测算法
- 移植 `change-classifier.ts` 的决策矩阵
- 集成到 IncrementalSync

**Phase 2: 图验证增强 (P1, 2 天)**
- 移植 `schema.ts` 的四层防御体系
- 移植别名系统 (43 节点 + 30 边)
- 集成到 GraphValidator

**Phase 3: Tour 增强 (P1, 1 天)**
- 移植 `tour-generator.ts` 的 Kahn 拓扑排序
- 集成 GraphEngine 的 PageRank + backwardReachability
- 增强 Grok Tour 阶段

**Phase 4: 非代码解析器 (P2, 2 天)**
- 移植 12 种解析器
- 实现 ParserRegistry
- 集成到 GraphStore

### 6.3 不需要移植的部分

| 模块 | 原因 |
|------|------|
| Agent 系统 (7 个 .md) | ola-cc 选择 TS 模块化，牺牲灵活性换取确定性 |
| Dashboard | ola-cc 使用 Ink TUI，不需要 Web Dashboard |
| search.ts (Fuse.js) | ola-cc 计划使用 FTS5，更高效 |
| embedding-search.ts | ola-cc 不引入向量搜索 |
| LLM prompt 构建 | ola-cc 的 GrokManager 已有自己的 prompt 体系 |

---

## 7. 关键代码文件清单

### 7.1 数据模型与类型

| 文件 | 行数 | 核心内容 |
|------|:----:|----------|
| `packages/core/src/types.ts` | 203 | KnowledgeGraph, GraphNode(21 types), GraphEdge(35 types) |
| `packages/core/src/schema.ts` | 664 | Zod schema, validateGraph (4层验证), 别名系统 |

### 7.2 分析引擎

| 文件 | 行数 | 核心内容 |
|------|:----:|----------|
| `packages/core/src/fingerprint.ts` | 386 | SHA-256 + tree-sitter 结构提取 → 三级变更检测 |
| `packages/core/src/change-classifier.ts` | 144 | classifyUpdate (SKIP/PARTIAL/ARCHITECTURE/FULL) |
| `packages/core/src/analyzer/graph-builder.ts` | 337 | GraphBuilder 类, addFile/addImportEdge/addCallEdge |
| `packages/core/src/analyzer/llm-analyzer.ts` | 187 | buildFileAnalysisPrompt, parseFileAnalysisResponse |
| `packages/core/src/analyzer/layer-detector.ts` | 285 | detectLayers (启发式), buildLayerDetectionPrompt |
| `packages/core/src/analyzer/tour-generator.ts` | 294 | generateHeuristicTour (Kahn 拓扑排序) |
| `packages/core/src/analyzer/normalize-graph.ts` | 330 | normalizeNodeId, normalizeBatchOutput |
| `packages/core/src/analyzer/language-lesson.ts` | 211 | detectLanguageConcepts (12 种模式) |

### 7.3 搜索与持久化

| 文件 | 行数 | 核心内容 |
|------|:----:|----------|
| `packages/core/src/search.ts` | 66 | SearchEngine (Fuse.js 模糊搜索) |
| `packages/core/src/embedding-search.ts` | 84 | SemanticSearchEngine (余弦相似度) |
| `packages/core/src/persistence/index.ts` | 183 | saveGraph/loadGraph, 路径安全处理 |
| `packages/core/src/staleness.ts` | 91 | getChangedFiles (git diff), isStale |

### 7.4 插件系统

| 文件 | 行数 | 核心内容 |
|------|:----:|----------|
| `packages/core/src/plugins/registry.ts` | 82 | PluginRegistry, 语言→插件映射 |
| `packages/core/src/plugins/tree-sitter-plugin.ts` | ~100 | TreeSitterPlugin (web-tree-sitter 封装) |
| `packages/core/src/plugins/extractors/typescript-extractor.ts` | ~300 | TypeScript/JavaScript 提取器 |
| `packages/core/src/plugins/parsers/index.ts` | 45 | registerAllParsers (12 种解析器注册) |
