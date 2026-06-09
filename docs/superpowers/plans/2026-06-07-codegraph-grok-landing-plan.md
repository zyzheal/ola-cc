# CodeGraph + Grok 落地方案（三专家评审修订版）

> 创建日期: 2026-06-07
> 评审日期: 2026-06-07
> 评审方: 方向专家 + 架构师 + 算法专家
> 状态: 待实施
> 预计总工期: 10-12 天

## 背景

通过对比 /tmp 下三个项目 (Understand-Anything、GitNexus、Graphify) 的能力，结合 3 位专家评审，确认：

- **14 项"缺失"能力**中 10 项已在 `codegraph-grok` worktree 中实现
- **1 项全新能力**需要开发（PreToolUse/PostToolUse Hook）
- **3 项可选增强**延后到 v2.0（Wiki、多仓库、Shell/Makefile）

Grok 首次运行基线 **1665s**（batch=3, concurrency=3 硬编码 + 30KB 截断）。

## 三专家评审共识

### P0 必须修复（5 项）

| # | 问题 | 来源 | 影响 |
|---|------|------|------|
| 1 | Phase 顺序应调整 — 性能优化前置 | 方向+架构 | 用户等待 4 天才能获得性能提升 |
| 2 | Hook 集成路径不清晰 — 需复用 `src/utils/hooks.ts` | 架构 | 绕过现有超时保护/权限检查 |
| 3 | Phase 0 合并策略过于乐观 — 40+ 文件 + EdgeMeta[] 破坏性变更 | 架构 | 合并失败风险高 |
| 4 | Louvain 有向图偏差 — modularity 计算错误 | 算法 | 社区检测结果不可靠 |
| 5 | getFileMetadata O(N*M) 线性扫描 | 算法 | 54K 节点时 540K 次比较/批 |

### P1 重要问题（6 项）

| # | 问题 | 来源 |
|---|------|------|
| 6 | 批处理收益估算缺乏推导 — 30KB 截断被低估 | 方向+算法 |
| 7 | 模型路由应复用 `getAgentModel()` | 架构 |
| 8 | RRF 图信号 k 值不匹配 — 图信号主导排序 | 算法 |
| 9 | Dominator Tree 注释与实现不符 | 算法 |
| 10 | Scope MRO 复杂度被低估 — C3 边界情况多 | 方向+算法 |
| 11 | EdgeMeta.confidence 激活需独立设计文档 | 架构 |

### P2 改进建议（7 项）

| # | 问题 | 来源 |
|---|------|------|
| 12 | Phase 3 应标记为 v2.0 | 方向 |
| 13 | Worker 线程池需资源限制和监控 | 方向 |
| 14 | Hook 系统差异化价值需明确 | 方向 |
| 15 | 测试覆盖率目标缺失（建议 ≥80%） | 架构 |
| 16 | PageRank 出度计算 contains 边 bug | 算法 |
| 17 | IncrementalSync hash 全量读取瓶颈 | 算法 |
| 18 | 回滚方案：合并前创建 backup 分支 | 架构 |

---

## Phase 0: 性能优化（~1 天）— 前置

> **评审建议**: 方向专家+架构师一致认为性能优化应前置，用户最迫切痛点是 1665s 首次运行。

### 0.1 性能基准测试（前置条件）

在优化前先 profiling，记录每个 pipeline step 耗时分布：

```bash
# 对 ola-cc 自身项目运行 Grok，记录各 step 耗时
# 目标：确认 LLM 调用 vs 本地计算的时间比例
# 验证 30KB 截断下的实际 batchSize
```

**产出**: 各 step 耗时分布表 + 30KB 限制下实际文件数采样。

### 0.2 O1: 本地 Scanner 替代 LLM

**当前**: `runPipelineInner()` 将前 50 个文件路径发给 LLM 做 scanner。
**优化**: 本地文件系统扫描（`discoverFiles()` 已有），LLM 仅做语言/框架确认（可选）。

| 修改文件 | 变更 |
|----------|------|
| `GrokManager.ts` | 新增 `localScan()` 方法 |
| `GrokAnalyzer.ts` | 复用 `discoverFiles()` |

**收益**: 消除 1 次 LLM round-trip（~5-10s）。

### 0.3 O3: 批处理参数调优

**当前**: `analyzeFilesBatch(files, 3, 3)` — batchSize=3, concurrency=3。
**优化**: 环境变量配置 + 30KB 截断感知的动态调整。

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `OLA_CC_GROK_BATCH_SIZE` | 10 | 每批文件数上限 |
| `OLA_CC_GROK_CONCURRENCY` | 3 | 最大并发批次数 |
| `OLA_CC_GROK_MAX_BATCH_SIZE_KB` | 30 | 每批 token 上限 (KB) |

> **算法专家修正**: 30KB 截断意味着单文件 AST 元数据 ~5-8KB 时，batchSize=10 实际只能放 4-6 个文件。等效 batchSize ~5，提升约 **1.7x** 而非 3.3x。实际收益需基准测试验证。

| 修改文件 | 变更 |
|----------|------|
| `GrokManager.ts` | 读取环境变量替代硬编码 |
| `GrokAnalyzer.ts` | `analyzeFilesBatch()` 接受动态参数 + 30KB 感知 |

### 0.4 M2: 多 Provider 模型路由

> **架构师修正**: 复用 `src/utils/model/agent.ts` 的 `getAgentModel()` 逻辑，通过任务类型参数扩展，避免两套模型选择。

**设计**: 任务分层 + 复用现有模型路由基础设施。

| 任务类型 | 模型选择 | 说明 |
|----------|----------|------|
| primary (analyzer, architecture) | `getAgentModel('grok-primary')` | 高质量分析 |
| fast (tour, review, scanner) | `getAgentModel('grok-fast')` | 低成本 |

**环境变量**（扩展已有命名空间）:
- `OLA_CC_GROK_MODEL` → 映射到 `getAgentModel()` 的 grok-primary
- `OLA_CC_GROK_MODEL_FAST` → 映射到 `getAgentModel()` 的 grok-fast

| 修改文件 | 变更 |
|----------|------|
| `src/utils/model/agent.ts` | 扩展 `getAgentModel()` 支持 grok 任务类型 |
| `GrokAnalyzer.ts` | `model` 属性改为调用 `getAgentModel()` |
| `GrokManager.ts` | pipeline 步骤传递任务类型 |

**收益**: tour/review 使用廉价模型，成本降低 ~40%。

### Phase 0 验证

- 基准测试：100 文件 < 预期时间
- 环境变量生效：`OLA_CC_GROK_BATCH_SIZE=5` 改变行为
- 模型路由：日志确认 primary/fast 分流

---

## Phase 1: 合并 worktree + 算法修复（~3 天）

> **架构师修正**: Phase 0 合并策略过于简略，需拆为 4 个子阶段。worktree 有 40+ 新文件而非 9 个。

### 1a. 接口兼容层（0.5 天）

worktree 的 `GraphStore.ts` 已从 `EdgeMeta` 单对象改为 `EdgeMeta[]` 数组存储，这是**破坏性接口变更**。

| 步骤 | 说明 |
|------|------|
| 对比 main 与 worktree 的 GraphStore 接口差异 | 列出所有签名变更 |
| 评估 EdgeMeta[] 对所有调用方的影响 | `getInEdges()`/`getOutEdges()` 返回类型变更 |
| 创建兼容层或批量更新调用方 | 选择影响最小的方案 |

### 1b. 无冲突文件合并（0.5 天）

```bash
# 1. 列出所有新增文件（worktree 有 40+ 新文件）
git diff main..codegraph-grok --name-status | grep "^A"

# 2. 按目录分组合并：
#    - parsers/ (9+2 个) — 无冲突
#    - resolution/frameworks/ (20 个) — 无冲突
#    - sync/ (4 个) — 无冲突
#    - extraction/ (10+ 个) — 无冲突

# 3. 每组合并后运行局部测试
```

### 1c. 冲突文件解决（1 天）

需要手动解决的关键文件：

| 文件 | 冲突类型 | 策略 |
|------|----------|------|
| `GraphStore.ts` | EdgeMeta → EdgeMeta[] | 以 worktree 版本为准，更新所有调用方 |
| `GraphEngine.ts` | 新增 DominatorTree/Katz/Betweenness | 保留新增算法，检查接口兼容 |
| `CodegraphWriter.ts` | FTS5 写入策略变更 | 以 worktree 版本为准 |
| `Resolver.ts` | 与 20 个框架解析器的集成 | 以 worktree 版本为准 |

**回滚方案**: 合并前创建 `backup-main-pre-merge` 分支，合并后保留 worktree 作为回滚参考。

### 1d. 集成测试 + 算法修复（1 天）

合并后立即修复算法专家发现的 P0 问题：

**修复 1: Louvain 有向图偏差**

| 修改文件 | 变更 |
|----------|------|
| `GraphEngine.ts` | Louvain 前构建无向镜像图：`w(u,v) = max(w(u→v), w(v→u))` |

**修复 2: getFileMetadata O(N*M) 索引**

| 修改文件 | 变更 |
|----------|------|
| `GraphStore.ts` | 新增 `fileToNodes: Map<string, Set<string>>` 索引，加载时构建 |
| `GrokAnalyzer.ts` L394 | `getFileMetadata()` 改用 `fileToNodes` 索引，O(1) 查询 |

**修复 3: PageRank 出度计算 bug**

| 修改文件 | 变更 |
|----------|------|
| `GraphEngine.ts` L446-449 | 修复出度计算：遍历所有邻居，检查是否有非 `contains` 边 |

**修复 4: Dominator Tree 注释修正**

| 修改文件 | 变更 |
|----------|------|
| `GraphEngine.ts` L504 | 注释改为 "iterative dominator computation" 并标注复杂度 O(V²*E) |

**修复 5: RRF 图信号独立 k 值**

| 修改文件 | 变更 |
|----------|------|
| `RrfSearch.ts` L116-120 | 图信号使用独立 k=200，避免与文本信号 k=60 混合 |

### Phase 1 验证

```bash
# 1. 全量测试
bun test src/services/graph/__tests__/

# 2. 零 CLI 依赖
grep -r "execFileSync\|runCodegraph\|ensureCodegraphBinary" src/tools/CodegraphTool/

# 3. 功能验证
# codegraph_init → codegraph_search → codegraph_callers → codegraph_status
```

**里程碑**: 所有 worktree 代码合并到 main，5 个算法 P0 修复，测试全通过。

---

## Phase 2: Hook 集成 + Scope 完善（~4 天）

### 2.1 PreToolUse/PostToolUse Hook（唯一全新能力）

> **架构师修正**: 复用现有 `src/utils/hooks.ts` Hook 基础设施，注册为 managed hook，利用现有的超时保护、取消机制、权限检查。

**集成路径**: 注册到现有 Hook 系统，而非独立实现拦截器。

| 现有基础设施 | 用途 |
|-------------|------|
| `src/utils/hooks.ts` | 通用 Hook 执行引擎（20+ 事件） |
| `src/services/tools/toolHooks.ts` | Tool 级 Hook 执行器 |
| `src/types/hooks.ts` | `PreToolUseHookInput`/`PostToolUseHookInput` 类型 |
| `src/utils/hooks/hooksConfigManager.ts` | Hook 配置管理 |

**设计**:
```
注册为 managed hook:
  hooksConfigManager.registerHook({
    event: 'PreToolUse',
    matcher: { toolNames: ['codegraph_*', 'grok_*'] },
    handler: graphPreToolHandler,
    timeout: 50,  // ms — 不阻塞工具调用
  })
```

| 新建文件 | 用途 |
|----------|------|
| `src/services/graph/hooks/graphHookHandlers.ts` | PreToolUse + PostToolUse 处理器（合并为一个文件） |

| 修改文件 | 变更 |
|----------|------|
| `src/utils/hooks/hooksConfigManager.ts` | 注册 graph hooks |
| `src/tools/CodegraphTool/CodegraphTool.ts` | 配合 hook 暴露元数据 |

> **方向专家修正**: 明确 Hook 系统差异化价值：
> 1. 实时增量更新（非全量重建）
> 2. 基于 PageRank 热点的智能推荐
> 3. 跨工具知识共享（codegraph 查询结果注入 Grok 上下文）

**验证**: E2E 测试 — hook 拦截日志 + 注入行为 + 延迟 < 50ms。

### 2.2 EdgeMeta.confidence 设计

> **架构师修正**: 需独立设计文档，明确语义、传播规则、衰减策略。

**设计文档要点**:
1. **语义**: confidence = 来源可信度（AST 解析=1.0, LLM 推断=0.7, 合成边=0.6）
2. **传播**: 不传播 — 每条边独立 confidence
3. **衰减**: 不衰减 — 静态值
4. **算法适配**: 仅 PageRank 使用加权边，其他算法忽略 confidence

| 修改文件 | 变更 |
|----------|------|
| `GraphStore.ts` | 加载时设置默认 confidence（AST=1.0, LLM=0.7, synthetic=0.6） |
| `GraphEngine.ts` | PageRank 支持加权边（使用 confidence 作为权重） |

### 2.3 Scope 解析 MRO

> **算法专家修正**: MRO C3 linearization 需独立算法文档，先实现 Python/Java 两种语言。

**Phase 2.3 仅实现**:
- Python: C3 linearization（标准算法，处理菱形继承）
- Java/C#: first-wins（接口方法解析）

**延后**: Kotlin/Scala 多继承、Ruby mixin、Go 接口嵌套。

| 修改文件 | 变更 |
|----------|------|
| `ScopeResolver.ts` | 添加 `resolveMRO()` 方法，支持 Python/Java 策略 |

### 2.4 执行流检测

> **架构师修正**: 复用 `GraphEngine.bfs()` 而非独立实现。入口点识别：`kind === 'function'` + `is_exported === true` + `file` 为入口文件。

| 新建文件 | 用途 |
|----------|------|
| `src/services/graph/ExecutionFlowDetector.ts` | 入口点→调用链追踪（复用 GraphEngine.bfs） |

### Phase 2 验证

- Hook E2E: 拦截日志 + 注入验证 + 延迟 < 50ms
- confidence: PageRank 结果与无 confidence 时有差异
- MRO: Python 菱形继承测试用例
- 执行流: 入口点→完整调用链追踪

---

## Phase 3: v2.0 延后功能

> **方向专家修正**: Phase 3 标记为 v2.0，仅在用户明确需求时实施。

| 功能 | 延后原因 |
|------|----------|
| Wiki 生成 | 用户未明确需要 |
| 多仓库支持 | 单仓库覆盖 95% 场景 |
| Shell/Makefile 解析器 | 用户可通过 codegraph_search 查询 |
| Kotlin/Scala MRO | 边界情况复杂，优先级低 |
| Dominator Tree 标准实现 | 当前迭代版本可用，仅最坏情况慢 |

---

## 依赖关系（修订）

```
Phase 0 (性能优化) ← 可独立执行，不依赖 Phase 1
    ↓
Phase 1 (合并 + 算法修复) ← 高风险操作，需 backup 分支
    ↓
Phase 2 (Hook + Scope + confidence)
    ↓
Phase 3 (v2.0 延后)
```

Phase 0 和 Phase 1 **完全独立**，可并行执行。

---

## 风险与缓解（修订）

| 风险 | 影响 | 缓解 | 来源 |
|------|------|------|------|
| EdgeMeta[] 破坏性变更 | Phase 1 大量调用方更新 | 1a 子阶段先评估影响，创建兼容层 | 架构 |
| worktree 40+ 文件合并 | Phase 1 延期 | 1b 无冲突文件先合并，1c 冲突文件逐个解决 | 架构 |
| 30KB 截断限制 | batch 优化收益低于预期 | 0.1 基准测试先行，用实际数据验证 | 算法 |
| Louvain 修复引入新 bug | 社区检测结果变化 | 修复前后对比测试，保留旧结果作为 baseline | 算法 |
| Hook 性能影响 | 工具调用变慢 | 超时 50ms + 异步执行 + 监控日志 | 方向 |
| MRO C3 边界情况 | Python 多继承解析失败 | 先实现标准场景，边界 case 用 fallback | 算法 |
| Worker 线程池资源耗尽 | 系统卡顿 | 并发上限 + 内存监控 + 超时 kill | 方向 |

---

## 测试策略

> **架构师建议**: 每个 Phase 新增代码测试覆盖率 ≥ 80%。

| Phase | 测试类型 | 覆盖率目标 |
|-------|----------|-----------|
| 0 | 单元测试（模型路由、批处理参数） | ≥ 80% |
| 1 | 集成测试（合并后全量回归） + 算法测试 | ≥ 80% |
| 2 | E2E 测试（Hook 拦截） + 单元测试（MRO、confidence） | ≥ 80% |

---

## 量化指标

> **方向专家建议**: 补充可量化验收标准。

| 功能 | 指标 | 目标值 |
|------|------|--------|
| 首次运行 (1000 文件) | 耗时 | < 300s（基准测试后修正） |
| Hook 拦截 | 延迟增加 | < 50ms |
| Scope 解析 | 跨文件引用准确率 | > 90% |
| 变更检测 | 分类准确率 | > 95% |
| Louvain 社区检测 | 与有向图预期一致率 | > 85% |
| 测试覆盖率 | 新增代码 | ≥ 80% |

---

## 文件清单（修订）

### 新建文件（~13 个）

| 文件 | Phase | 行数估计 |
|------|-------|----------|
| `src/services/graph/parsers/*.ts` (9+2 个) | 1b | ~1400 |
| `src/services/graph/StructuralFingerprint.ts` | 1b | ~150 |
| `src/services/graph/ChangeClassifier.ts` | 1b | ~100 |
| `src/services/graph/sync/gitHooks.ts` | 1b | ~80 |
| `src/services/graph/extraction/parse-worker.ts` | 1b | ~200 |
| `src/services/graph/ScopeResolver.ts` | 1b | ~300 |
| `src/services/graph/SemanticModel.ts` | 1b | ~200 |
| `src/services/graph/ContractRegistry.ts` | 1b | ~150 |
| `src/services/graph/ModuleImpactAnalyzer.ts` | 1b | ~200 |
| `src/services/graph/hooks/graphHookHandlers.ts` | 2 | ~200 |
| `src/services/graph/ExecutionFlowDetector.ts` | 2 | ~200 |

### 修改文件（~12 个）

| 文件 | Phase | 变更 |
|------|-------|------|
| `GrokManager.ts` | 0 | 移除硬编码，加环境变量 |
| `GrokAnalyzer.ts` | 0 | 批处理动态参数 + fileToNodes 索引 |
| `src/utils/model/agent.ts` | 0 | 扩展 getAgentModel() 支持 grok 任务类型 |
| `GraphStore.ts` | 1+2 | EdgeMeta[] 兼容 + fileToNodes 索引 + confidence |
| `GraphEngine.ts` | 1 | Louvain 无向镜像 + PageRank 出度修复 + Dominator 注释 |
| `RrfSearch.ts` | 1 | 图信号独立 k=200 |
| `CodegraphWriter.ts` | 1 | FTS5 写入策略 |
| `Resolver.ts` | 1 | 框架解析器集成 |
| `ScopeResolver.ts` | 2 | MRO Python/Java |
| `CodegraphTool.ts` | 2 | Hook 配合 |
| `hooksConfigManager.ts` | 2 | 注册 graph hooks |
| `FtsSearch.ts` | 1 | 复用 DB |
