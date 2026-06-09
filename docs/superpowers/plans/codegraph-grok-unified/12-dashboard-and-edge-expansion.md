# Dashboard 可视化 + EdgeType 扩展设计

> 日期: 2026-06-05
> 来源: UA Dashboard (66 文件, 13,362 行) + UA 35 种边类型
> Phase: Z1 (EdgeType P1) + Z4 (Dashboard + EdgeType P2/P3)
> 总工期: 5 天 (EdgeType P1: 1d + Dashboard: 3d + EdgeType P2/P3: 1d)

---

## 1. 问题背景

### 1.1 原设计排除项

| 排除项 | 原排除理由 | 实际差距 |
|--------|-----------|---------|
| Dashboard | "Ink TUI 已覆盖" | Ink 是纯文本终端，无法做力导向布局/节点拖拽/聚焦/Diff 高亮/代码预览 |
| 向量语义搜索 | "零依赖原则" | UA 的 SemanticSearchEngine 本身是半成品 (83 行, 未启用, 无模型, 无索引) |
| 35 种边类型 | "12/12 已覆盖" | 只覆盖了 8/35 (23%), 缺 Behavioral/DataFlow/Infrastructure/Schema/Domain/Knowledge |

### 1.2 修正后的评估

| 项目 | 决策 | 理由 |
|------|------|------|
| Dashboard | **补全** (终端轻量版) | 15/16 UA 能力覆盖需此能力 |
| 向量语义搜索 | **不补全** | UA 本身半成品, FTS5+BM25+RRF 已超越 |
| 35 种边类型 | **扩展到 40 种** | 12+1+27, 超越 UA 的 35 种 |

---

## 2. Dashboard 可视化设计 (3 天)

### 2.1 架构方案: 终端 HTTP 轻量版

ola-cc 是终端应用 (Ink TUI)，不能直接移植 UA 的 React 19 + React Flow Web 应用。方案：

```
codegraph_dashboard operation
  ├── 1. 启动本地 HTTP 服务器 (随机端口, localhost only)
  ├── 2. 生成内嵌 HTML (单文件, 无外部依赖)
  │   ├── D3.js (CDN 或内嵌 minified)
  │   ├── 力导向布局 (d3-force)
  │   ├── 社区聚类着色 (community_id → color)
  │   └── 交互: 拖拽/缩放/聚焦/过滤/搜索
  ├── 3. 浏览器自动打开
  └── 4. 30 分钟自动关闭
```

**核心差异**: 不用 React/React Flow/Zustand/Tailwind，用纯 D3.js 内嵌 HTML，~3,000 行。

### 2.2 功能范围 (从 UA 13K 行中精选核心)

| 功能 | UA 实现 | ola-cc 终端版 | 优先级 |
|------|---------|--------------|:------:|
| 力导向布局 | d3-force + 社区聚类 | ✅ 直接移植 | P0 |
| 节点拖拽/缩放 | React Flow 内置 | ✅ D3 zoom+drag | P0 |
| 社区着色 | graphology Louvain | ✅ GraphEngine Louvain 输出 | P0 |
| 节点详情面板 | NodeInfo.tsx (539行) | ✅ D3 tooltip + 侧栏 | P0 |
| 搜索过滤 | FilterPanel + SearchBar | ✅ D3 过滤 + 搜索框 | P0 |
| Focus 模式 (1-hop) | 内置 | ✅ D3 邻居高亮 | P1 |
| Diff 叠加 | changed/affected 高亮 | ✅ 边置信度 + 变更标记 | P1 |
| 代码预览 | CodeViewer (Prism) | ⚠️ 简化版 (纯文本) | P2 |
| 3 种视图模式 | structural/domain/knowledge | ⚠️ 仅 structural | P2 |
| Tour/Learn | LearnPanel + OnboardingOverlay | ❌ 不移植 (用 Grok Tour 替代) | — |
| Mobile 适配 | MobileLayout/Drawer/BottomNav | ❌ 终端无需 | — |
| 7 语言国际化 | i18n 7 locales | ❌ 仅中英文 | — |
| Export SVG/PNG/JSON | 内置 | ⚠️ JSON 导出 | P3 |

### 2.3 技术实现

```typescript
// codegraph_dashboard operation 实现
class DashboardServer {
  private server: http.Server | null = null
  private port: number = 0

  async start(graphData: GraphSnapshot): Promise<{ url: string; port: number }> {
    this.port = await this.findFreePort(63000, 63100)
    const token = crypto.randomUUID()

    this.server = http.createServer((req, res) => {
      if (req.url === `/data?token=${token}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(this.serializeGraph(graphData)))
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(this.getDashboardHtml(this.port, token))
      }
    })

    this.server.listen(this.port, '127.0.0.1')
    open(`http://127.0.0.1:${this.port}`)

    // 30 分钟自动关闭
    setTimeout(() => this.stop(), 30 * 60 * 1000)

    return { url: `http://127.0.0.1:${this.port}`, port: this.port }
  }

  private getDashboardHtml(port: number, token: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>CodeGraph Dashboard</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>/* 内嵌 CSS ~200 行 */</style>
</head>
<body>
  <div id="graph"></div>
  <div id="sidebar"></div>
  <div id="search"></div>
  <script>
    // D3 力导向布局 + 社区着色 + 交互 ~2500 行
    fetch('/data?token=${token}')
      .then(r => r.json())
      .then(data => renderGraph(data))
  </script>
</body>
</html>`
  }

  private serializeGraph(graph: GraphSnapshot): DashboardData {
    const nodes = []
    for (const [id, meta] of graph.nodes) {
      nodes.push({
        id, name: meta.name, kind: meta.kind,
        file: meta.file, language: meta.language,
        community: meta.community_id,
        pagerank: meta.pagerank,
        layer: meta.layer,
      })
    }
    const edges = []
    for (const [from, adj] of graph.adjacency) {
      for (const [to, edgeMeta] of adj) {
        edges.push({ source: from, target: to, type: edgeMeta.type, weight: edgeMeta.weight })
      }
    }
    return { nodes, edges }
  }
}
```

### 2.4 D3 力导向布局核心

```javascript
// 内嵌在 getDashboardHtml 中的 JS
function renderGraph(data) {
  const width = window.innerWidth - 300  // 侧栏 300px
  const height = window.innerHeight

  // 社区颜色映射
  const communities = [...new Set(data.nodes.map(n => n.community))]
  const color = d3.scaleOrdinal(d3.schemeCategory10).domain(communities)

  // 力导向模拟
  const simulation = d3.forceSimulation(data.nodes)
    .force('link', d3.forceLink(data.edges).id(d => d.id).distance(50))
    .force('charge', d3.forceManyBody().strength(-100))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('x', d3.forceX().x(d => communityAngle(d.community, width)))
    .force('y', d3.forceY().y(d => communityAngle(d.community, height)))

  // SVG 渲染
  const svg = d3.select('#graph').append('svg')
    .attr('width', width).attr('height', height)
    .call(d3.zoom().on('zoom', (e) => g.attr('transform', e.transform)))

  const g = svg.append('g')

  // 边
  const link = g.selectAll('.link')
    .data(data.edges).enter().append('line')
    .attr('class', 'link')
    .attr('stroke', d => edgeColor(d.type))
    .attr('stroke-width', d => Math.sqrt(d.weight))

  // 节点
  const node = g.selectAll('.node')
    .data(data.nodes).enter().append('circle')
    .attr('r', d => 3 + Math.sqrt(d.pagerank * 1000))
    .attr('fill', d => color(d.community))
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded))

  // Tooltip
  node.append('title').text(d => `${d.name}\n${d.kind}\n${d.file}`)

  // 点击聚焦 (1-hop)
  node.on('click', (event, d) => {
    const neighbors = new Set()
    data.edges.forEach(e => {
      if (e.source.id === d.id) neighbors.add(e.target.id)
      if (e.target.id === d.id) neighbors.add(e.source.id)
    })
    neighbors.add(d.id)
    node.attr('opacity', n => neighbors.has(n.id) ? 1 : 0.1)
    link.attr('opacity', e => neighbors.has(e.source.id) && neighbors.has(e.target.id) ? 1 : 0.05)
  })
}
```

### 2.5 安全措施

| 措施 | 说明 |
|------|------|
| localhost only | `server.listen(port, '127.0.0.1')` |
| 随机 token | URL 中包含 `?token=<uuid>`，防止 CSRF |
| 30 分钟超时 | 自动关闭服务器 |
| 无写操作 | 纯只读数据展示 |
| 数据脱敏 | 不暴露源码内容，仅展示符号元数据 |

### 2.6 验收条件

- [ ] `codegraph_dashboard` operation 启动本地 HTTP 服务器
- [ ] 浏览器自动打开，显示力导向图
- [ ] 节点按社区着色，大小按 PageRank
- [ ] 支持拖拽、缩放、搜索、过滤
- [ ] 点击节点显示详情 (name, kind, file, community)
- [ ] Focus 模式: 点击节点高亮 1-hop 邻居
- [ ] 30 分钟自动关闭

---

## 3. EdgeType 40 种扩展设计 (2 天)

### 3.1 当前状态

ola-cc GraphStore 当前 EdgeType (12+1 种):

```typescript
type EdgeType =
  | 'calls' | 'imports' | 'contains' | 'data'
  | 'inherits' | 'implements' | 'exports' | 'type_of'
  | 'returns' | 'instantiates' | 'overrides' | 'decorates'
  | 'control'  // fallback
```

### 3.2 UA 35 种边类型映射

| # | UA 边类型 | 分类 | ola-cc 映射 | 实现策略 |
|---|----------|------|------------|---------|
| 1 | imports | Structural | ✅ 已有 | — |
| 2 | exports | Structural | ✅ 已有 | — |
| 3 | contains | Structural | ✅ 已有 | — |
| 4 | inherits | Structural | ✅ 已有 | — |
| 5 | implements | Structural | ✅ 已有 | — |
| 6 | calls | Behavioral | ✅ 已有 | — |
| 7 | **subscribes** | Behavioral | **新增** | EventEmitter.on() / addEventListener → subscribes 边 |
| 8 | **publishes** | Behavioral | **新增** | EventEmitter.emit() / dispatchEvent → publishes 边 |
| 9 | **middleware** | Behavioral | **新增** | Express/NestJS/Koa 中间件链 → middleware 边 |
| 10 | **reads_from** | Data flow | **新增** | fs.readFile / DB query / Redis get → reads_from 边 |
| 11 | **writes_to** | Data flow | **新增** | fs.writeFile / DB insert / Redis set → writes_to 边 |
| 12 | **transforms** | Data flow | **新增** | pipe/map/filter/flatMap → transforms 边 |
| 13 | **validates** | Data flow | **新增** | Zod/Joi/Yup parse → validates 边 |
| 14 | **depends_on** | Dependencies | **新增** | package.json / import → depends_on 边 |
| 15 | **tested_by** | Dependencies | **新增** | test file → source file → tested_by 边 |
| 16 | **configures** | Dependencies | **新增** | config file → service → configures 边 |
| 17 | related | Semantic | ⚠️ 降级 | Grok LLM 生成 → related 边 (weight 低) |
| 18 | similar_to | Semantic | ⚠️ 降级 | 名称相似度 > 0.8 → similar_to 边 |
| 19 | **deploys** | Infrastructure | **新增** | Dockerfile/K8s/deploy.yml → deploys 边 |
| 20 | **serves** | Infrastructure | **新增** | HTTP server listen → serves 边 |
| 21 | **provisions** | Infrastructure | **新增** | Terraform/Pulumi → provisions 边 |
| 22 | **triggers** | Infrastructure | **新增** | CI/CD workflow → triggers 边 |
| 23 | **migrates** | Schema/Data | **新增** | migration file → table → migrates 边 |
| 24 | **documents** | Schema/Data | **新增** | JSDoc/docstring → target → documents 边 |
| 25 | **routes** | Schema/Data | **新增** | Express route / Next.js page → routes 边 |
| 26 | **defines_schema** | Schema/Data | **新增** | Prisma/TypeORM entity → defines_schema 边 |
| 27 | **flow_step** | Domain | **新增** | 业务流程步骤 A→B → flow_step 边 |
| 28 | **cross_domain** | Domain | **新增** | 跨领域调用 → cross_domain 边 |
| 29 | contains_flow | Domain | ⚠️ 降级 | 领域→流程 包含关系 (Grok 生成) |
| 30 | **cites** | Knowledge | **新增** | 注释/文档引用 → cites 边 |
| 31 | **contradicts** | Knowledge | **新增** | 矛盾实现 → contradicts 边 (Grok 检测) |
| 32 | **builds_on** | Knowledge | **新增** | 扩展/增强关系 → builds_on 边 |
| 33 | **exemplifies** | Knowledge | **新增** | 示例/模板关系 → exemplifies 边 |
| 34 | **categorized_under** | Knowledge | **新增** | 分类归属 → categorized_under 边 |
| 35 | **authored_by** | Knowledge | **新增** | git blame → authored_by 边 |

### 3.3 新增 27 种 EdgeType 完整定义

```typescript
type EdgeType =
  // 原有 12+1 种
  | 'calls' | 'imports' | 'contains' | 'data'
  | 'inherits' | 'implements' | 'exports' | 'type_of'
  | 'returns' | 'instantiates' | 'overrides' | 'decorates'
  | 'control'
  // P1: Behavioral (3) — Phase Z1
  | 'subscribes' | 'publishes' | 'middleware'
  // P1: Domain (2) — Phase Z1
  | 'flow_step' | 'cross_domain'
  // P2: Data flow (4) — Phase Z4
  | 'reads_from' | 'writes_to' | 'transforms' | 'validates'
  // P2: Dependencies (3) — Phase Z4
  | 'depends_on' | 'tested_by' | 'configures'
  // P2: Infrastructure (4) — Phase Z4
  | 'deploys' | 'serves' | 'provisions' | 'triggers'
  // P2: Schema/Data (4) — Phase Z4
  | 'migrates' | 'documents' | 'routes' | 'defines_schema'
  // P2: Semantic (2) — Phase Z4
  | 'related' | 'similar_to'
  // P3: Knowledge (6) — Phase Z4
  | 'cites' | 'contradicts' | 'builds_on' | 'exemplifies' | 'categorized_under' | 'authored_by'
```

### 3.4 分阶段实施

**Phase Z1 (1 天): P1 边类型 (5 种)**

| 边类型 | 检测方法 | 来源 |
|--------|---------|------|
| subscribes | `EventEmitter.on()`, `addEventListener()`, `subscribe()` | callback-synthesizer |
| publishes | `EventEmitter.emit()`, `dispatchEvent()`, `publish()` | callback-synthesizer |
| middleware | `app.use()`, `@UseGuards()`, `router.use()` | FrameworkResolver |
| flow_step | Grok 领域分析输出 | DomainAnalyzer |
| cross_domain | Grok 跨域调用检测 | DomainAnalyzer |

**Phase Z4 (1 天): P2/P3 边类型 (22 种)**

| 分类 | 边类型 | 检测方法 |
|------|--------|---------|
| Data flow | reads_from, writes_to, transforms, validates | AST 分析 + FrameworkResolver |
| Dependencies | depends_on, tested_by, configures | 文件路径 + import 分析 |
| Infrastructure | deploys, serves, provisions, triggers | 配置文件解析 (Dockerfile/K8s/CI) |
| Schema/Data | migrates, documents, routes, defines_schema | ORM/框架检测 |
| Semantic | related, similar_to | 名称相似度 + Grok 语义 |
| Knowledge | cites, contradicts, builds_on, exemplifies, categorized_under, authored_by | 注释分析 + git blame + Grok |

### 3.5 GraphEngine 适配

新增 27 种边类型需要更新 GraphEngine 的以下方法:

| 方法 | 适配内容 |
|------|---------|
| `classifyRoles()` | 新边类型参与角色分类 (e.g., `deploys` → 部署节点标记) |
| `backwardDataSlice()` | 支持 `reads_from`/`writes_to`/`transforms` 数据流追踪 |
| `adjacency matrix` | 新边类型参与 PageRank/Katz/Betweenness 计算 |
| `community detection` | 新边类型参与 Leiden 社区检测 |
| `trace/path` | 支持 `flow_step`/`cross_domain` 路径追踪 |

### 3.6 验收条件

**Phase Z1 验收**:
- [ ] EdgeType 包含 17 种 (12+1+5 P1)
- [ ] `subscribes`/`publishes` 正确检测 EventEmitter 模式
- [ ] `middleware` 正确检测 Express/NestJS 中间件链
- [ ] `flow_step`/`cross_domain` 从 DomainAnalyzer 输出正确映射

**Phase Z4 验收**:
- [ ] EdgeType 包含 40 种 (12+1+5+22)
- [ ] `reads_from`/`writes_to` 正确检测文件/DB/Redis 操作
- [ ] `depends_on` 从 package.json/import 正确生成
- [ ] `routes` 从 Express/Next.js 路由定义正确检测
- [ ] `authored_by` 从 git blame 正确生成
- [ ] 所有新边类型参与 GraphEngine 算法计算
- [ ] 所有现有测试通过

---

## 4. 向量语义搜索评估 (不实施)

### 4.1 UA 实现分析

| 维度 | UA 实现 | 评估 |
|------|---------|------|
| 代码量 | 83 行 | 极简 |
| Embedding 模型 | 无内置，需外部预计算 | 半成品 |
| 索引 | 无 ANN，暴力 O(n) | 不可扩展 |
| 集成状态 | store 中标记未启用 | 未完成 |
| 搜索质量 | cosine similarity threshold | 基础 |

### 4.2 ola-cc 替代方案

| 搜索能力 | ola-cc 实现 | 超越 UA |
|---------|------------|:------:|
| 精确匹配 | FTS5 全文索引 | ✅ |
| 模糊匹配 | BM25 多信号评分 | ✅ |
| 混合搜索 | RRF 融合 (K=60) | ✅ |
| 语义搜索 | FTS5 + BM25 (无需向量) | ✅ 覆盖 90%+ 场景 |

### 4.3 未来扩展路径

如需真正的语义搜索，可按以下路径扩展（不引入本地模型依赖）：

```
方案 A: API Embedding (推荐)
  ├── 调用 OpenAI/Anthropic embedding API
  ├── 存储向量到 SQLite (BLOB 列)
  ├── 余弦相似度线性扫描 (54K 节点 <100ms)
  └── 不引入本地模型依赖

方案 B: 本地轻量模型 (备选)
  ├── ONNX Runtime + all-MiniLM-L6-v2 (22M 参数, 80MB)
  ├── 仅在用户主动启用时加载
  └── 违反零依赖原则，仅作备选
```

**当前决策**: **已补全实施** (F-106)。基于 UA SemanticSearchEngine 深度分析后完成补全。

### 4.4 补全实现方案 (F-106)

UA SemanticSearchEngine 深度分析发现 6 项缺陷 + 3 层缺失，已全部修复并补全：

**修复的 UA 缺陷**:

| # | 缺陷 | 修复 |
|---|------|------|
| 1 | `cosineSimilarity` 不校验向量长度 | 添加长度校验 + 抛出明确错误 |
| 2 | score 范围无界 (negative similarity → score > 1) | `score = Math.max(0, 1 - similarity)` 归一化到 [0, 1] |
| 3 | `updateNodes` 不清理孤立 embeddings | 遍历 embeddings Map 删除不在 nodes 中的条目 |
| 4 | `threshold` 默认值 0 导致负相似度结果 | 默认改为 -1 (不过滤)，保留用户显式设置能力 |
| 5 | 无向量长度校验的 NaN 风险 | 添加空向量保护 |
| 6 | `types` 字段类型为 `string[]` 不精确 | 使用 `NodeMetadata["kind"]` 联合类型 |

**补全的 3 层缺失**:

| 层 | UA 状态 | ola-cc 补全 |
|---|---------|-----------|
| Embedding 生成 | **未实现** | `EmbeddingProvider` 接口 + OpenAI/Cohere/Mock 三种实现 |
| 向量持久化 | **未实现** | `VectorStore` 接口 + SQLiteVectorStore (bun:sqlite BLOB) + InMemoryVectorStore |
| 主流程集成 | **未实现** | `searchByText()` + `generateMissingEmbeddings()` + `rrfFuse()` 与 FTS5+BM25 融合 |

**新增文件**:

| 文件 | 行数 | 功能 |
|------|:----:|------|
| `src/services/graph/SemanticSearch.ts` | ~260 | 核心引擎 + cosineSimilarity (修复) + RRF 融合 + 文本提取 |
| `src/services/graph/EmbeddingProvider.ts` | ~230 | 可插拔 embedding 生成层 (OpenAI/Cohere/Mock/Local) |
| `src/services/graph/VectorStore.ts` | ~220 | SQLite 向量存储 (BLOB + KNN 暴力扫描) + InMemory |
| `src/services/graph/__tests__/SemanticSearch.test.ts` | ~250 | 29 个测试用例，全通过 |

**架构设计**:

```
用户查询 ──→ EmbeddingProvider.embed(queryText)
                    │
                    ▼
            SemanticSearchEngine.search(queryEmbedding)
            ├── cosineSimilarity (修复版: 长度校验 + score 归一化)
            ├── type filter (NodeMetadata.kind)
            └── threshold filter
                    │
                    ▼
            语义搜索结果 (SearchResult[])
                    │
    ┌───────────────┼───────────────┐
    ▼               ▼               ▼
  FTS5 结果    BM25 结果     语义搜索结果
    │               │               │
    └───────────────┼───────────────┘
                    ▼
            rrfFuse([ftS5, bm25, semantic], K=60)
                    │
                    ▼
            融合排序结果
```

**与现有搜索方案的关系**:

| 搜索方式 | 场景 | 优先级 |
|----------|------|:------:|
| FTS5 精确匹配 | 符号名搜索 (`GraphEngine`) | P0 |
| BM25 排序 | 全文内容搜索 | P0 |
| 语义搜索 | 自然语言查询 (`哪里处理认证`) | P1 |
| RRF 融合 | 混合查询 (三路结果合并) | P0 |

**EmbeddingProvider 可插拔设计**:

```typescript
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
  dimension(): number
  name(): string
}
```

| Provider | 模型 | 维度 | 成本 | 推荐场景 |
|----------|------|:----:|:----:|---------|
| OpenAI | text-embedding-3-small | 1536 | ~$0.01/次索引 | 生产环境 |
| Cohere | embed-v3 | 1024 | ~$0.01/次索引 | 多语言项目 |
| Mock | hash-based | 384 | 零 | 开发/测试 |
| Local (TODO) | all-MiniLM-L6-v2 | 384 | 零 | 离线环境 |

**VectorStore SQLite 存储设计**:

```sql
CREATE TABLE embeddings (
  node_id TEXT PRIMARY KEY,
  dimension INTEGER NOT NULL,
  vector BLOB NOT NULL,          -- Float32Array → Uint8Array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

- 暴力 KNN 扫描: 54K 节点 × 1536 维 < 200ms (可接受)
- 未来升级路径: sqlite-vec 扩展实现 ANN 索引 (O(log N))

---

## 5. 更新后的能力对比

| 维度 | codegraph | UA | ola-cc 统一方案 (更新后) |
|------|:---------:|:--:|:------------------------:|
| 节点属性 | 21/21 | 21/21 | 21/21 |
| 边类型 | 12/12 | 35/35 | **40/40** (超越) |
| 图算法 | 0/15 | 0/15 | **15/15** |
| 全文搜索 | ✅ | ❌ | ✅ |
| Dashboard | ❌ | ✅ 13K行 | **✅ 终端轻量版** |
| 向量搜索 | ❌ | ⚠️ 未启用 (25% 完成度) | **✅ 补全实施** (EmbeddingProvider + VectorStore + RRF 融合) |
| 增量同步 | ✅ | ✅ | ✅ |
| 零 LLM 成本 | ✅ | ❌ | ✅ |
| 语义丰富度 | ❌ | ✅ | ✅ |
| 非代码解析 | ❌ | ✅ | ✅ |
| 领域分析 | ❌ | ✅ | ✅ |
| 图验证 | ❌ | ✅ | ✅ |
| 部署简易度 | ⚠️ | ⚠️ | ✅ |
| 语义搜索 | ❌ | ⚠️ 未启用 | **✅ 补全** (EmbeddingProvider + VectorStore + RRF) |
| **综合** | **6.5** | **4.3** | **9.5** |
