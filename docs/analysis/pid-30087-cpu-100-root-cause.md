# PID 30087 CPU 100% 根因分析

> 分析时间：2026-06-09 13:45
> 进程：`/Users/heal/ola-cc/.worktrees/codegraph-grok/cli` (PID 30087)
> 运行时长：~1:42 (启动于 12:03)
> 用户态 CPU：11:27 / 1:41:41 (当前瞬时 100%)

---

## 一、根因

**CPU 100% 由三个独立触发源共同导致：图算法同步阻塞 + AST 全量扫描 + 工具过度曝光。**

### 触发源 1：图算法同步阻塞（最严重，但范围有限）

`feature-dev:code-architect` agent 触发了 `grok_architecture` 操作，在主线程上同步执行了两个 O(N²+) 图算法，54K 节点/138K 边的规模导致计算无法在合理时间内完成。

### 调用链

```
Agent(code-architect)
  → GrokTool(operation: grok_architecture)
    → GrokTool.ts case 'grok_architecture'      ← 注意：非 GrokManager.analyzeArchitecture()
      → GraphEngine.louvainCommunity()           ← O(passes × V × avg_deg)，单层级实现
      → GraphEngine.classifyRoles()
        → GraphEngine.pageRank()                 ← O(maxIter × V × avg_deg)，无超时保护
        → GraphEngine.bfs() × entries            ← O(entries × (V+E))
```

**注意：`traceFeatureChains()` 方法不存在于代码库中，`analyzeArchitecture()` 方法也不存在。实际只调用了 `louvainCommunity` + `classifyRoles` 两个算法。**

### 触发源 2：AST 全量扫描（最频繁，影响所有 agent）

每次 agent 任务完成后，都会对项目**全部 2309 个 .ts/.tsx 文件**运行 AST 检查：

```typescript
// runAgent.ts 第 1181 行
const astResults = await runASTCheck([
  `${projectRoot}/src/**/*.ts`,
  `${projectRoot}/src/**/*.tsx`
])
```

- 每个文件使用 `ts.createSourceFile` 解析 + 5 项检查遍历
- 纯同步 CPU 密集操作，无文件数量上限
- **与用户描述的"只要启动 agent 触发任务就 CPU 100%"高度吻合**

### 触发源 3：codegraph/grok 工具过度曝光（加剧因素）

工具优化后，codegraph 有 22 个操作、grok 有 10 个操作，searchHint 包含 26+8 个关键词。BM25 排名机制（searchHint 匹配权重 15/词）导致这些工具在几乎所有编程相关查询中都会被选中，即使用户不需要图分析。

### 关键数据

| 指标 | 值 |
|------|-----|
| 节点数 (V) | 54,273 |
| 边数 (E) | 138,105 |
| 平均度数 | ~2.5 |
| Louvain maxPasses | 100 |
| Louvain maxLevels | 10（接口声明但代码忽略） |
| PageRank maxIter | 100 |
| Louvain timeoutMs | **无**（接口无 deadline 参数） |
| PageRank timeoutMs | **无**（仅 maxIter 和收敛检查） |
| AST 检查文件数 | 2309 个 .ts/.tsx 文件 |
| codegraph 操作数 | 22 个 |
| grok 操作数 | 10 个 |

### 复杂度估算

| 算法 | 理论复杂度 | 54K 节点估算 | 实测基线 |
|------|-----------|-------------|---------|
| `louvainCommunity` (单层级, 100 passes) | O(100 × V × avg_deg) | 13.5M | 10.4s (基线) |
| `pageRank` | O(100 × V × avg_deg) | 13.5M | 2.8s (基线) |
| `classifyRoles` → BFS × entries | O(entries × (V+E)) | entries × 192K | — |
| AST 检查 (2309 文件 × 5 检查) | O(files × ast_nodes) | ~10M+ | 数秒 |

**注意：**
- `louvainInnerIteration` 和 `buildUndirectedGraph` 不是独立函数，Louvain 算法被压缩在单个 `louvainCommunity` 方法内
- 实现是**单层级 Louvain**（只有 Phase 1 节点移动，无 Phase 2 社区合并），接口声明的 `maxLevels` 被代码忽略
- `traceFeatureChains()` 方法不存在于代码库中
- `epsilon` 参数在接口中定义但从未使用

**总计：~27M+ 次图算法操作 + AST 全量扫描，在主线程同步执行，阻塞事件循环。**

---

## 二、为什么 CPU 100% 而不是正常完成

### 2.1 主线程同步阻塞

所有图算法和 AST 检查在**主线程**上同步运行，没有 Worker/异步处理。这导致：

1. **事件循环完全阻塞** — `setInterval`、`setTimeout`、`Promise` 回调全部无法执行
2. **Ink TUI 冻结** — React 渲染循环被阻塞，Spinner 动画停止
3. **API 流式输出中断** — Agent 的流式 token 无法渲染

### 2.2 timeout 保护完全缺失

**louvainCommunity 没有任何超时检查。** 唯一的退出条件是：
- 达到 `maxPasses`（默认 100）
- 本轮无节点移动（收敛）

```typescript
for (let pass = 0; pass < maxPasses; pass++) {
  // ← 无 Date.now() 检查，无 deadline 参数
  for (const node of nodes) {       // ← 54K 节点的内层循环无超时检查
    // ... modularity gain 计算 ...
  }
  if (!moved) break                 // ← 仅收敛检查
}
```

**pageRank 同样没有超时检查。** 仅有 `maxIter=100` 和 L1 范数收敛检查。

### 2.3 classifyRoles 中的隐藏 PageRank

`classifyRoles()` 内部调用了 `this.pageRank()`（GraphEngine.ts 第 600 行），但：

- **没有 timeout 保护** — PageRank 的 100 次迭代无超时检查
- **没有 skip 选项** — `RoleOpts` 只有 `corePercentile`、`utilityFanInPercentile`、`adaptorCrossModuleRatio`
- **无条件执行** — 即使只需要 dead/entry 角色（不依赖 PR 分数），也会执行完整 PageRank

### 2.4 grok_architecture 无总体超时

GrokTool.ts 的 `grok_architecture` case 没有 timeout 参数，两个重量级算法串行执行：

```typescript
const community = engine.louvainCommunity({ resolution: ... })  // ~10s
const roles = engine.classifyRoles()                            // ~3s (含 PageRank)
```

### 2.5 AST 全量扫描（新发现）

每次 agent 完成后，`runAgent.ts` 第 1181 行执行：

```typescript
const astResults = await runASTCheck([
  `${projectRoot}/src/**/*.ts`,
  `${projectRoot}/src/**/*.tsx`
])
```

- 扫描 **2309 个** .ts/.tsx 文件
- 每个文件运行 5 项检查（unused-variable, unused-import, magic-number, unreachable-code, implicit-any）
- 使用 `ts.createSourceFile` 逐文件解析，纯同步 CPU 密集操作
- **无文件数量上限，无增量机制**

### 2.6 工具过度曝光（新发现）

codegraph/grok 工具优化后，searchHint 包含大量关键词：

```
codegraph: 'code graph AST callers callees impact trace scc toposort pagerank roles coupling community centrality temporal slice delta'  (26 词)
grok: 'knowledge graph code understanding semantic analysis architecture community hotspots'  (8 词)
```

BM25 排名权重：searchHint 匹配 **15 分/词**。用户查询中出现任何常见编程词汇（code、function、call、impact、trace 等）都会使 codegraph 进入 top-25 工具列表，导致模型频繁调用图算法。

---

## 三、sample 调用栈分析

```
4188/4188 采样点全在主线程
热点地址范围：0x2cbf9ac ~ 0x2cc1934
形成紧密递归循环：
  0x2cbeba4 → 0x2cbf9ac → 0x2cc1920 → 0x2cc16e4 → 0x2cc1364 → ...
```

这是 Bun 编译后的 bytecode（无 source map），无法直接解析为 JS 函数名。但调用模式（深层递归 + 紧密循环）与以下两种场景一致：

**场景 A：Louvain 单层级实现**
- 外层 `for (let pass = 0; pass < maxPasses; pass++)` 循环（100 次）
- 内层 `for (const node of nodes)` 循环（54K 迭代）
- 每个节点遍历邻居 `for (const [neighbor, w] of neighbors)` 循环
- **注意：无 `while (level < maxLevels)` 循环，实现是单层级的**

**场景 B：AST 全量扫描**
- 外层遍历 2309 个文件
- 每个文件 `ts.createSourceFile` 解析
- 5 项检查各自遍历 AST 节点

---

## 四、其他排除项

| 假设 | 排除原因 |
|------|---------|
| Ink 渲染无限循环 | `scheduleRender` 有 `throttle(FRAME_INTERVAL_MS=16)` + FrameCoalescer |
| useAnimationFrame 累积 | Clock 有 `setInterval(tick, 33ms)` + `setTimeout(flush, 0)` coalescing |
| React 无限重渲染 | ConcurrentRoot auto-batches setState；throttle 限制渲染频率 |
| SQLite 阻塞 | `lsof` 显示无 SQLite fd 打开（图已加载到内存） |
| API 死循环 | `maxTurns` 限制 + `while(true)` 有退出条件 |
| Bun Pool 死锁 | Pool 线程在 `__ulock_wait2`（等待主线程），非主动阻塞 |
| GraphStore 自动加载 | GraphStore 是完全惰性加载的，仅在工具 `call()` 时触发 |
| ToolSearchTool 开销 | 工具发现是异步的，不会阻塞主线程 |

---

## 五、修复建议

### P0 — 立即修复

1. **AST 检查改为增量式**（影响所有 agent 任务）
   ```typescript
   // runAgent.ts — 只检查 agent 修改的文件
   const modifiedFiles = getModifiedFilesForAgent(agentId)
   if (modifiedFiles.length > 0) {
     const astResults = await runASTCheck(modifiedFiles)
   }
   ```

2. **AST 检查添加文件数量上限**
   ```typescript
   const MAX_AST_FILES = 50
   const files = await resolveGlobPattern(pattern)
   const limitedFiles = files.slice(0, MAX_AST_FILES)
   ```

3. **`louvainCommunity` 添加超时保护**
   ```typescript
   louvainCommunity(opts?: {
     resolution?: number
     maxPasses?: number
     timeoutMs?: number  // 新增，默认 30000
   }) {
     const deadline = Date.now() + (opts?.timeoutMs ?? 30000)
     for (let pass = 0; pass < maxPasses; pass++) {
       if (Date.now() > deadline) break
       for (const node of nodes) {
         if (pass % 10 === 0 && Date.now() > deadline) break
         // ... modularity gain 计算 ...
       }
     }
   }
   ```

4. **`pageRank` 添加超时保护**
   ```typescript
   pageRank(opts?: {
     damping?: number
     maxIter?: number
     timeoutMs?: number  // 新增，默认 10000
   })
   ```

5. **`classifyRoles` 添加 timeout/skip 选项**
   ```typescript
   classifyRoles(opts?: RoleOpts & {
     timeoutMs?: number     // 新增
     skipPageRank?: boolean // 新增，跳过 PageRank 用 fanIn 替代
   })
   ```

6. **AST 检查添加配置开关**（新增）
   ```typescript
   // runAgent.ts — 通过环境变量或配置禁用 AST 检查
   const AST_CHECK_ENABLED = process.env.OLA_CC_AST_CHECK !== '0'
   if (AST_CHECK_ENABLED) {
     const astResults = await runASTCheck([...])
   }
   ```

7. **限制工具连续调用**（新增）
   ```typescript
   // GrokTool/CodegraphTool — 添加调用频率限制
   const graphOps = ['grok_architecture', 'codegraph_community', 'codegraph_pagerank', 'codegraph_roles']
   if (graphOps.includes(input.operation)) {
     const lastCall = this.lastGraphCallTime ?? 0
     if (Date.now() - lastCall < 5000) {
       return { data: { error: true, message: 'Graph operation rate limited, wait 5s' } }
     }
     this.lastGraphCallTime = Date.now()
   }
   ```

### P1 — 短期优化

6. **codegraph/grok searchHint 精简**
   ```typescript
   // 之前：26 个关键词
   searchHint: 'code graph AST callers callees impact trace scc toposort pagerank roles coupling community centrality temporal slice delta'
   // 之后：8 个核心词
   searchHint: 'code graph callers impact structure dependency analysis'
   ```

7. **添加条件门控**
   ```typescript
   // CodegraphTool.ts
   isEnabled() {
     const projectRoot = getProjectRoot()
     return existsSync(join(projectRoot, '.codegraph', 'codegraph.db'))
   }
   ```

8. **图算法移到 Worker 线程**
   - 使用 `Bun.spawn` 或 `worker_threads` 在后台线程执行
   - 主线程只负责进度渲染和结果展示

9. **grok_architecture 添加 maxNodes 默认值**
   ```typescript
   const maxNodes = input.maxNodes ?? 10000  // 限制图规模
   ```

10. **检查 .codegraph/ 与 .understand-anything/ 数据新鲜度**
    ```typescript
    // GraphStore.load() 中添加数据新鲜度检查
    const dbMtime = statSync(dbPath).mtimeMs
    const gitMtime = getLatestGitCommitTime(projectRoot)
    if (dbMtime < gitMtime) {
      // 数据过期，触发增量同步或提示用户
      console.warn('codegraph data is stale, run codegraph_sync')
    }
    ```
    - 增量同步：基于 git diff 只更新变更文件的节点/边
    - 避免每次调用都重新加载全量数据

11. **epsilon 早停机制**（新增）
    ```typescript
    // louvainCommunity — 使用 epsilon 作为增益阈值
    for (let pass = 0; pass < maxPasses; pass++) {
      if (Date.now() > deadline) break
      let totalGain = 0
      for (const node of nodes) {
        const gain = /* 计算 modularity gain */
        totalGain += gain
        // ... 移动节点 ...
      }
      // 早停：增益小于 epsilon 时退出
      if (totalGain < epsilon) break
    }
    ```

12. **BFS/图构建缓存**（新增）
    ```typescript
    // GraphEngine — 缓存 BFS 和图构建结果
    private bfsCache = new Map<string, Map<string, number>>()
    private undirectedGraphCache: Map<string, Map<string, number>> | null = null

    bfs(start: string): Map<string, number> {
      const cacheKey = start
      if (this.bfsCache.has(cacheKey)) return this.bfsCache.get(cacheKey)!
      // ... 计算 BFS ...
      this.bfsCache.set(cacheKey, result)
      return result
    }
    ```

13. **优雅降级（返回部分结果）**（新增）
    ```typescript
    // louvainCommunity — 超时时返回已计算的社区
    const communities = new Map<string, number>()
    for (let pass = 0; pass < maxPasses; pass++) {
      if (Date.now() > deadline) {
        // 返回已计算的部分结果，而不是空结果
        return { communities, modularity: computeModularity(communities), timedOut: true }
      }
      // ... 正常计算 ...
    }
    ```

14. **可观测性指标**（新增）
    ```typescript
    // GraphEngine — 记录算法执行时间
    const start = performance.now()
    const result = this.louvainCommunity(opts)
    const duration = performance.now() - start
    logCpuDiag(`[GraphEngine] louvainCommunity: ${duration.toFixed(1)}ms, nodes=${this.nodeCount}`)
    ```

15. **Agent CPU 预算**（新增）
    ```typescript
    // runAgent.ts — 限制单个 agent 的总 CPU 时间
    const AGENT_CPU_BUDGET_MS = 60000 // 60 秒
    const agentStartTime = Date.now()
    // 在每个工具调用后检查
    if (Date.now() - agentStartTime > AGENT_CPU_BUDGET_MS) {
      yield { type: 'error', message: 'Agent CPU budget exceeded' }
      break
    }
    ```

16. **熔断器模式**（新增）
    ```typescript
    // GrokTool/CodegraphTool — 失败后自动禁用
    private circuitBreaker = { failures: 0, lastFailure: 0, disabled: false }

    async call(input, context) {
      if (this.circuitBreaker.disabled) {
        const cooldown = 60000 // 60 秒冷却
        if (Date.now() - this.circuitBreaker.lastFailure < cooldown) {
          return { data: { error: true, message: 'Tool temporarily disabled due to repeated failures' } }
        }
        this.circuitBreaker.disabled = false
      }
      try {
        const result = await this.execute(input)
        this.circuitBreaker.failures = 0
        return result
      } catch (e) {
        this.circuitBreaker.failures++
        this.circuitBreaker.lastFailure = Date.now()
        if (this.circuitBreaker.failures >= 3) {
          this.circuitBreaker.disabled = true
        }
        throw e
      }
    }
    ```

17. **低频操作 defer**（新增）
    ```typescript
    // CodegraphTool — 将低频操作设为 deferred
    const LOW_FREQ_OPS = ['codegraph_temporal', 'codegraph_slice', 'codegraph_coupling', 'codegraph_centrality']
    // 在 tool 定义中
    shouldDefer: (input) => LOW_FREQ_OPS.includes(input.operation)
    ```

18. **超时测试覆盖**（新增）
    - 添加单元测试验证超时机制在各种场景下正确工作
    - 测试边界条件：超时发生在 pass 中间、node 中间、BFS 中间
    - 测试部分结果的正确性

### P2 — 长期优化

19. **完整 Louvain 实现**（新增）
    - 实现 Phase 2（社区合并为超节点），减少迭代次数
    - 当前单层级实现在密集图上产生过多小社区

20. **增量式 Louvain**
    - 缓存上次的 community 结果
    - 新调用基于缓存增量更新，而非从头计算

21. **WASM 加速图算法**
    - PageRank/Louvain 的核心循环用 C/Rust 编写，通过 WASM 调用
    - 预期 5-10x 加速

22. **图预处理缓存**
    - `louvainCommunity` + `classifyRoles` + `pageRank` 结果持久化到 `.codegraph/` 目录
    - 下次调用直接读取缓存，仅当图变更时重新计算

---

## 六、P0 修复验证状态（2026-06-09）

> 由 3 个 agent 并行验证，确认所有 P0 修复均未实现。

| P0 修复项 | 验证结果 | 验证 agent | 关键证据 |
|-----------|---------|-----------|---------|
| AST 检查添加环境变量开关 | **未实现** | agent-1 | `runAgent.ts` 第 1181 行无 `OLA_CC_AST_CHECK` 判断 |
| AST 检查改为增量式 | **未实现** | agent-1 | 仍扫描 `${projectRoot}/src/**/*.ts` 全量 glob |
| AST 检查添加文件数量上限 | **未实现** | agent-1 | 无 `MAX_AST_FILES` 常量，无 `slice(0, N)` 逻辑 |
| `louvainCommunity` 添加 timeoutMs | **未实现** | agent-2 | `LouvainOpts` 接口无 `timeoutMs` 字段，循环内无 `Date.now()` 检查 |
| `pageRank` 添加 timeoutMs | **未实现** | agent-2 | `pageRank(damping, maxIter)` 签名无 timeout 参数 |
| `classifyRoles` 添加 timeout/skip | **未实现** | agent-2 | `RoleOpts` 仅含 `corePercentile`/`utilityFanInPercentile`/`adaptorCrossModuleRatio` |
| GrokTool/CodegraphTool 添加调用频率限制 | **未实现** | agent-3 | 无 `lastGraphCallTime` 字段，无 `rate limit` 逻辑 |

**结论：所有 P0 修复均未实现，CPU 100% 问题在当前代码中完全未缓解。**

---

## 七、P2 设计方案：Worker 线程渲染

> **TUI 效果设计方案**（Compact 进度条 shimmer、codegraph TUI 效果移植）已迁移至 [`tui-style-interaction-comparison.md`](./tui-style-interaction-comparison.md) 第七节。

### 8.1 设计目标

将 CPU 密集型操作（图算法、AST 检查、compact 摘要生成）移到 Worker 线程，主线程仅负责进度渲染和结果展示。

### 8.2 Worker 线程架构

```
主线程 (React/Ink)
  ├── 用户交互、UI 渲染
  ├── 进度条显示 (shimmer 动画)
  └── 发送任务 → Worker
  
Worker 线程
  ├── 图算法 (louvainCommunity, pageRank, classifyRoles)
  ├── AST 检查 (runASTCheck)
  ├── Compact 摘要生成
  └── 进度回传 → 主线程
```

### 8.3 实现方案

```typescript
// src/workers/graphWorker.ts
import { parentPort } from 'node:worker_threads'
import { GraphEngine } from '../services/graph/GraphEngine.js'

parentPort?.on('message', async (msg) => {
  const { type, payload, taskId } = msg

  try {
    let result: unknown

    switch (type) {
      case 'louvain_community': {
        const engine = new GraphEngine(payload.graph)
        result = engine.louvainCommunity({
          resolution: payload.resolution ?? 1.0,
          maxPasses: payload.maxPasses ?? 100,
          timeoutMs: payload.timeoutMs ?? 30000,
        })
        break
      }
      case 'page_rank': {
        const engine = new GraphEngine(payload.graph)
        result = engine.pageRank(payload.damping ?? 0.85, payload.maxIter ?? 100, payload.timeoutMs ?? 10000)
        break
      }
      case 'classify_roles': {
        const engine = new GraphEngine(payload.graph)
        result = engine.classifyRoles(payload.opts)
        break
      }
      case 'ast_check': {
        const { runASTCheck } = await import('../services/codeQuality/astChecker.js')
        result = await runASTCheck(payload.files, payload.checks, payload.maxFiles ?? 50)
        break
      }
    }

    parentPort?.postMessage({ taskId, type: 'result', data: result })
  } catch (e) {
    parentPort?.postMessage({ taskId, type: 'error', error: (e as Error).message })
  }
})
```

```typescript
// src/workers/WorkerPool.ts
import { Worker } from 'node:worker_threads'

export class WorkerPool {
  private workers: Worker[] = []
  private taskQueue: Array<{ resolve: Function; reject: Function; msg: unknown }> = []
  private busy = new Set<Worker>()

  constructor(
    private workerScript: string,
    private poolSize: number = 2
  ) {
    for (let i = 0; i < poolSize; i++) {
      this.createWorker()
    }
  }

  private createWorker(): Worker {
    const worker = new Worker(this.workerScript)
    worker.on('message', (msg) => {
      this.busy.delete(worker)
      // 处理结果...
      this.processQueue()
    })
    this.workers.push(worker)
    return worker
  }

  async execute<T>(type: string, payload: unknown, timeoutMs: number = 60000): Promise<T> {
    return new Promise((resolve, reject) => {
      const taskId = crypto.randomUUID()
      const timer = setTimeout(() => reject(new Error('Worker timeout')), timeoutMs)

      const worker = this.getIdleWorker()
      if (worker) {
        this.busy.add(worker)
        worker.postMessage({ type, payload, taskId })
      } else {
        this.taskQueue.push({ resolve, reject, msg: { type, payload, taskId } })
      }
    })
  }
}
```

### 8.4 主线程集成

```typescript
// src/services/graph/GraphEngine.ts — 添加 Worker 模式
export class GraphEngine {
  private static workerPool: WorkerPool | null = null

  static getWorkerPool(): WorkerPool {
    if (!this.workerPool) {
      this.workerPool = new WorkerPool(
        join(__dirname, '../../workers/graphWorker.js'),
        2 // 2 个 Worker 线程
      )
    }
    return this.workerPool
  }

  // 异步版本 — 使用 Worker 线程
  async louvainCommunityAsync(opts?: LouvainOpts): Promise<CommunityResult> {
    const pool = GraphEngine.getWorkerPool()
    return pool.execute('louvain_community', {
      graph: this.serialize(),
      ...opts,
    }, opts?.timeoutMs ?? 30000)
  }

  // 同步版本 — 保持向后兼容
  louvainCommunity(opts?: LouvainOpts): CommunityResult {
    // 原有实现，添加 timeoutMs 支持
    const deadline = Date.now() + (opts?.timeoutMs ?? 30000)
    // ...
  }
}
```

### 8.5 进度回传机制

```typescript
// Worker 线程进度回传
parentPort?.on('message', async (msg) => {
  if (msg.type === 'louvain_community') {
    const engine = new GraphEngine(msg.payload.graph)

    // 每 10 个 pass 回传一次进度
    for (let pass = 0; pass < maxPasses; pass++) {
      if (pass % 10 === 0) {
        parentPort?.postMessage({
          type: 'progress',
          taskId: msg.taskId,
          progress: { phase: 'louvain', percent: Math.round((pass / maxPasses) * 100) }
        })
      }
      // ... 计算 ...
    }
  }
})

// 主线程接收进度
worker.on('message', (msg) => {
  if (msg.type === 'progress') {
    updateProgressBar(msg.progress)
  }
})
```

---

## 八、临时缓解

在修复代码之前，可以：

1. **终止进程**：`kill 30087`
2. **禁用 grok_architecture**：在 agent prompt 中添加 "不要使用 grok_architecture 或 codegraph_community/centrality 操作"
3. **减小图规模**：在 `.codegraph/ignore` 中排除 `node_modules`、测试文件等，减少节点数
4. **启用 CPU debug**：`OLA_CC_CPU_DEBUG=1 OLA_CC_CPU_LOG_FILE=/tmp/cpu.log` 运行，获取详细诊断
5. **检查数据新鲜度**：运行 `codegraph sync` 确保 .codegraph/ 数据是最新的，避免过期数据触发不必要的全量重算
6. **禁用 AST 检查**：临时注释 `runAgent.ts` 第 1176-1202 行的 AST 检查代码

---

## 九、总结

### 根因确认

CPU 100% 由三个独立触发源共同导致，形成恶性循环：

```
用户提问（任何编程问题）
  → BM25 排名：codegraph 得分高（searchHint 26 词命中）
  → 模型调用 grok_architecture / codegraph_community
  → 触发 Louvain + PageRank（CPU 100%，10-15 秒）
  → agent 完成
  → AST 检查 2309 个文件（CPU 100%，数秒）
  → 总计：15-20 秒的 CPU 阻塞
```

### 三个触发源

| 触发源 | 影响范围 | CPU 影响 | 修复优先级 |
|--------|---------|---------|-----------|
| AST 全量扫描 | **每个 agent 任务** | 高（持续性） | P0 |
| 图算法同步阻塞 | 仅 grok_architecture 等 | 高（单次） | P0 |
| 工具过度曝光 | 所有编程查询 | 中（加剧） | P1 |

### 关键发现

1. **AST 检查是最频繁的 CPU 消耗源** — 每次 agent 完成都扫描 2309 个文件
2. **图算法完全没有超时保护** — Louvain 和 PageRank 都没有 deadline 检查
3. **工具 searchHint 过于宽泛** — 26 个关键词导致工具被频繁选中
4. **数据新鲜度未检查** — 可能基于过期数据执行不必要的重算
5. **工具调用链放大** — 模型可能连续调用多个图算法操作（新增）
6. **epsilon 未使用** — 接口定义了但从未使用，无法早停（新增）
7. **BFS/图构建重复计算** — 相同的 BFS 结果和图构建未缓存（新增）

### 修复方案完整性

**总计 22 项修复建议 + 1 项设计方案 + TUI 效果方案（独立文档）：**

| 优先级 | 数量 | 关键修复 |
|--------|------|---------|
| P0 | 7 项 | AST 增量检查、AST 配置开关、图算法超时、工具调用限制 |
| P1 | 11 项 | searchHint 精简、条件门控、epsilon 早停、缓存、优雅降级、可观测性、CPU 预算、熔断器、defer、测试 |
| P2 | 4 项 | 完整 Louvain、增量式 Louvain、WASM 加速、图预处理缓存 |
| 设计方案 | 1 项 | Worker 线程渲染（§7） |
| TUI 效果 | 独立文档 | Compact 进度条 shimmer、codegraph TUI 效果移植 → [`tui-style-interaction-comparison.md`](./tui-style-interaction-comparison.md) |

### P0 验证状态

**所有 P0 修复均未实现**（2026-06-09 由 3 个 agent 并行验证）。详见第六节。

### 修复预期效果

| 修复项 | 预期 CPU 降低 | 实施难度 |
|--------|-------------|---------|
| AST 增量检查 + 配置开关 | 95% | 低 |
| 图算法超时保护 | 80%（单次） | 低 |
| 工具调用链限制 | 70%（连续调用） | 低 |
| epsilon 早停 | 40%（迭代次数） | 低 |
| BFS/图构建缓存 | 30%（重复计算） | 低 |
| searchHint 精简 | 50%（调用频率） | 低 |
| 条件门控 | 30%（无数据时） | 低 |
| 优雅降级 | 20%（超时时） | 低 |
| 可观测性指标 | 0%（诊断用） | 低 |
| Agent CPU 预算 | 60%（累积限制） | 中 |
| 熔断器模式 | 50%（失败后） | 中 |
| Worker 线程 | 100%（不阻塞主线程） | 中 |

> TUI 效果相关优化（Compact 进度条 shimmer、codegraph TUI 效果移植）详见 [`tui-style-interaction-comparison.md`](./tui-style-interaction-comparison.md) 第七节。
| 数据新鲜度检查 | 20%（避免过期重算） | 中 |
