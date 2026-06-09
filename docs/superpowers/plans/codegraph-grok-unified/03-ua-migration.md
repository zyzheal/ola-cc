# UA 能力移植设计

> 原文档: 2026-06-05-codegraph-grok-unified-plan.md
> Phase: 1/2/4
> 天数: 12.5 (7 + 3.5 + 2)

---

## Phase 1: 结构指纹 + 变更分类 + Grok 优化 + GrokManager 拆分

### StructuralFingerprint 设计

- 对比 IncrementalSync 的三级检测（git diff → mtime → hash），增加 AST 结构哈希层
- **数据来源**: 直接使用 codegraph.db 的 nodes/edges 表（bun:sqlite 查询），不引入 tree-sitter WASM 依赖
- 哈希输入: `{name, kind, signature, start_line, end_line}` + 出入边列表
- 计算结构哈希，区分"签名变更"（哈希变化 → 需重建调用图）和"实现变更"（行号变化但哈希不变 → 仅需更新节点）
- 持久化到 `.codegraph/fingerprints.json`
- **精度说明**: 基于 codegraph.db 的哈希精度低于原始 AST（只能检测到 codegraph 已提取的结构变化），但满足零依赖约束且覆盖 95%+ 的实际变更场景

### ChangeClassifier 设计

- 输入: 文件路径 + 旧/新 AST
- 输出: `ChangeType` 枚举 + 影响范围描述
- 分类规则:
  - `signature_change`: 函数签名、类型定义、接口变更 -- 需重建调用图
  - `implementation_change`: 函数体、控制流变更 -- 仅需更新节点内容
  - `import_change`: import/export 变更 -- 需更新依赖边
  - `comment_change`: 注释/文档变更 -- 无需重建

### Grok Analyzer 两阶段优化设计

当前问题：`GrokManager.analyzeFilesBatch()` 直接将完整源码（~30KB/文件）发送给 LLM，token 浪费严重（估算 ~50%）。UA 的 file-analyzer 采用两阶段模式更高效：先用 tree-sitter 提取结构化元数据，再将元数据（~5-8KB）发送给 LLM 做语义增强。

优化方案：
- **Phase 1 (元数据提取)**: 通过 bun:sqlite 直接查询 codegraph.db 的 nodes/edges 表，获取 AST 元数据（函数签名、类声明、import 列表、参数类型）。**不使用 codegraph CLI 子进程**，避免 100 个文件 = 100 次子进程 spawn 的开销（Phase 0 已验证 87ms 全量读取）
- **Phase 2 (LLM 语义增强)**: 将 AST 元数据（~5-8KB/文件，而非原始源码 ~30KB/文件）发送给 LLM，仅请求 summary/complexity/tags/domain 等语义字段
- **降级策略**: 若 codegraph.db 不存在（未初始化），回退到当前的直接源码分析模式
- **token 节省**: 预计从 ~30KB/文件降至 ~8KB/文件（~73% 减少），总 pipeline token 消耗降低 ~50%

实现位置：修改 `GrokManager.analyzeFilesBatch()` 方法，新增 `buildMetadataPrompt()` 辅助函数，使用 GraphStore 已加载的节点数据构建 prompt。

### GrokManager 模块拆分设计

当前 GrokManager.ts 已 1800+ 行，继续膨胀将违反单一职责。拆分为 3 个子模块：

| 模块 | 职责 | 预计行数 |
|------|------|---------|
| `GrokAnalyzer.ts` | 文件发现 + LLM 批量分析 + 两阶段优化 | ~600 |
| `GrokAssembler.ts` | 图谱组装 + Zod 校验 + assemble-reviewer + 增量合并 | ~500 |
| `GrokTourBuilder.ts` | Tour 增强 (PageRank + 依赖链) + 学习路径生成 | ~300 |
| `GrokManager.ts` | 门面类，协调三个子模块 + 错误处理 + 进度回调 | ~400 |

拆分原则：每个模块可独立测试，GrokManager 仅做编排不做实现。

---

## Phase 2: 图验证 + re-export 链 + Zod 校验 + assemble-reviewer + 缓存失效

### GraphValidator 9 项检查

| # | 检查项 | 实现方式 | 严重级别 |
|---|--------|---------|---------|
| 1 | 孤立节点 | fanIn=0 && fanOut=0（排除 file 节点） | Warning |
| 2 | 类型安全 | 检查函数调用的目标类型是否匹配 | Error |
| 3 | 边一致性 | 检查边的 from/to 节点是否存在 | Error |
| 4 | 环检测 | 调用 GraphEngine.tarjanSCC()，标记非平凡 SCC | Info |
| 5 | 未解析引用 | 检查 references 边的目标是否存在 | Warning |
| 6 | 重复边 | 检查同一对节点的同类型边是否重复 | Warning |
| 7 | 悬挂边 | 边的 from 或 to 节点指向不存在的节点 | Error |
| 8 | 缺失实现 | implements 边的目标接口是否有实现类 | Warning |
| 9 | 模块边界 | 调用 GraphEngine.louvainCommunity() 检查社区结构 | Info |

### re-export 链追踪设计

当前问题：`export { Foo } from './foo'` 形式的 re-export 不被追踪，导致模块对外暴露的 API 不完整。codegraph.db 的 `exports` 边数量有限（当前 0 条），re-export 关系隐藏在 `imports` 边中。

追踪方案：
- 在 GraphStore.load() 完成后，执行 `extractReExports()` 后处理
- 规则：若节点 A 有 `imports` 边到节点 B，且 A 所在文件有 `export` 语句引用 B 的 name → 生成 `re_exports` 边（A → B，type=exports）
- 实现：遍历所有 `imports` 边，检查 from 节点的 file 中是否有匹配的 export 语句（从 codegraph.db 的 export 节点推导）
- 复杂度：O(E_imports)，约 17K 边，<10ms
- 输出：新增 `re_exports` 边类型，GraphStore.adjacency 中可见

### Grok knowledge-graph.json Zod 校验设计

当前问题：`GrokManager.extractNewNodes()` 直接将 LLM 输出写入 `knowledge-graph.json`，无 schema 校验。LLM 可能输出格式异常数据（缺少必填字段、类型错误、ID 重复），污染图谱。

校验方案：
- 定义 `GraphNodeSchema` 和 `GraphEdgeSchema` (Zod)，覆盖 `id/name/kind/file/line/signature/summary/layer/domain` 字段
- **别名规范化**: 在 Zod 校验层增加 `normalizeKind()` 映射函数，处理 LLM 输出的 75+ 种 kind 变体（如 `fn`→`function`, `proc`→`procedure`, `const`→`constant`, `class_method`→`method`）。映射表基于 UA 的 `normalize-node-kind.ts` + codegraph 实际 kind 值
- 在 `assembleGraph()` 写入前执行 `GraphDataSchema.safeParse()`
- 校验失败时：记录错误 + 跳过异常节点（不阻断 pipeline）+ 在 `metadata.errors` 中上报
- 校验通过率 < 80% 时：触发告警日志，提示 LLM 输出质量下降

### assemble-reviewer 合并审查设计

当前问题：`GrokManager.analyzeFilesBatch()` 分 3 批并行分析，`mergeIncrementalNodes()` 合并时可能丢失节点（同一符号在不同批次中产生不同 ID）。

审查方案：
- **ID 规范化**: 统一 `file:name` 格式，消除 `file:name#counter` 后缀歧义
- **去重检查**: 合并后检查 `{file, name}` 二元组唯一性，重复时保留最新批次的结果
- **边完整性**: 检查合并后所有边的 from/to 节点是否存在，移除悬挂边
- **统计上报**: 合并前后节点/边数量对比，在 `metadata.review` 中记录去重/修复统计

实现位置：新增 `assembleReview()` 方法，在 `assembleGraph()` 最后一步调用。

### GraphStore 缓存失效策略

- **dirty 传播**: IncrementalSync.detect() → 返回 `{dirty, changedFiles, reason}` → 调用方决定是否 reload
- **单例保护**: `GraphStore.getInstance(projectRoot)` 返回同一实例，并发调用共享同一 Promise（避免重复加载）
- **并发保护**: load() 内部使用 `loadingPromise` 锁，首个调用触发加载，后续调用等待同一 Promise
- **缓存失效**: dirty 标记后，下次 `getInstance()` 返回 stale 实例 + 设置 `needsReload` 标志，由调用方显式调用 `store.reload()`

---

## Phase 4: Tour 增强 + 非代码解析

**目标**: 增强 GrokManager Tour 阶段 + 非代码文件解析能力

| 任务 | 文件 | 说明 | 天数 |
|------|------|------|------|
| Tour 增强 | `src/tools/GrokTool/GrokManager.ts` | fan-in/fan-out 排名 + 依赖链分析 | 0.5 |
| 非代码解析器（P0 批） | `src/services/graph/parsers/` | Dockerfile + CI + YAML + JSON | 1 |
| 非代码解析器（P1 批） | `src/services/graph/parsers/` | Terraform + OpenAPI + GraphQL + Protobuf + SQL | 0.5 |

### Tour 增强设计

（UA 移植）:
- 当前 GrokManager Tour 阶段仅使用 LLM 生成学习路径，缺乏数据支撑
- 增强方案:
  1. 调用 `GraphEngine.pageRank()` 获取核心节点排名
  2. 调用 `GraphEngine.backwardReachability()` 获取依赖链
  3. 结合 fan-in/fan-out 排名，生成有数据支撑的学习路径
  4. 优先展示 PageRank 高 + fan-in 大的节点（入口点 → 核心节点 → 工具函数）

### 非代码解析器设计

- 每个解析器实现统一接口 `ParserResult { nodes: ParsedNode[], edges: ParsedEdge[] }`
- ParsedNode: `{ id, name, kind, file, line, metadata? }`
- ParsedEdge: `{ from, to, type, metadata? }`
- ParserRegistry 统一注册，按文件扩展名分发
- **注入时机**: GraphStore.load() 完成 codegraph.db + knowledge-graph.json 加载后，按需调用 ParserRegistry 解析非代码文件，结果合并到同一 adjacency + nodeMeta 中
- **缓存策略**: 解析结果随 GraphStore 实例缓存，仅在 reload() 时重新解析（与 codegraph.db 同生命周期）
- **按需启用**: ParserRegistry 根据项目中实际存在的文件类型自动启用对应解析器，不解析不存在的文件类型

### 解析器优先级

| 优先级 | 解析器 | 理由 |
|--------|--------|------|
| P0 | Dockerfile, CI (GitHub Actions), YAML, JSON | 基础设施配置，几乎所有项目都有 |
| P1 | Terraform, OpenAPI, GraphQL, Protobuf, SQL | 特定技术栈，按需启用 |
| P2 | Markdown, TOML, Env, Makefile, Shell | 辅助文件，优先级最低 |

### Phase 4 验收条件

- [ ] Tour 阶段输出包含 PageRank 排名和依赖链
- [ ] P0 解析器正确提取 Dockerfile services、CI steps、YAML/JSON definitions
- [ ] P1 解析器正确提取 Terraform resources、OpenAPI endpoints、GraphQL schemas、Protobuf messages、SQL tables
- [ ] 解析结果正确注入 GraphStore
