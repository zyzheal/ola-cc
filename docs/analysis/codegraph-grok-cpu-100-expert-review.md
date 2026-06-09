# CodeGraph/Grok CPU 100% 问题 — 三方专家深度评审报告

> 评审时间：2026-06-09 21:55-22:05
> 评审专家：Agent Tool 资深专家 + 算法专家 + 软件架构师
> 问题现象：PID 42229 `codegraph sync` 占用 100% CPU 运行 44 分钟

---

## 一、执行摘要

三位专家独立评审后，**一致认定** CPU 100% 问题不是表面 bug，而是五个层面的系统性架构缺陷共同导致：

| 层面 | 根因 | 严重度 |
|------|------|--------|
| 进程管理 | SIGKILL 无法杀死进程组，exit handler 不可靠 | **P0 致命** |
| 生命周期 | Fire-and-forget 缺乏 AbortController | **P0 致命** |
| 算法复杂度 | BFS 级联 O(entries×V)、无超时保护 | **P0 严重** |
| 资源隔离 | 全局状态 + 无并发控制 | **P1 高危** |
| 数据结构 | EdgeMeta 类型不一致、缺失方法 | **P1 高危** |

---

## 二、致命问题 (P0)

### 2.1 子进程变成孤儿进程 — 根因

**位置**: `CodegraphManager.ts:455` + `CodegraphManager.ts:527-530`

**三方专家一致认定**:

```
Agent Tool 专家: "SIGKILL 发送给的是子进程本身，而不是进程组"
软件架构师: "detached: false 只是默认值的显式声明，不等于进程组隔离"
算法专家: "codegraph CLI 内部 spawn 的 tree-sitter worker 不在 activeChildren 跟踪范围"
```

**问题链**:
```
ensureReady() → runCodegraph(sync, 60s timeout)
  → setTimeout(60s) 存在于父进程内存
  → 父进程退出 → setTimeout 消失
  → 子进程继续运行 → 44 分钟 CPU 100%
```

**修复方案** (三方一致):
```typescript
// 使用进程组 + AbortController
const ac = new AbortController();
const child = spawn(binPath, args, {
  detached: true,  // 创建新进程组
  signal: ac.signal,
});
process.on('exit', () => ac.abort());
// 超时时杀死整个进程组
setTimeout(() => process.kill(-child.pid, 'SIGKILL'), timeoutMs);
```

---

### 2.2 classifyRoles BFS 级联 — O(entries × (V+E))

**位置**: `GraphEngine.ts:743-748`

**算法专家分析**:
```
对每个 entry 点 (fanIn=0 且 fanOut>0) 执行一次完整 BFS
假设 1000 个 entry 点:
  1000 × (54,273 + 138,105) = ~192,378,000 次操作
加上 PageRank: 100 × 192K = ~19.2M 操作
总计: ~211M 操作 → CPU 100% 持续 10-30 秒
```

**修复方案**:
```typescript
// 改为单次多源 BFS
const queue = [...entryPoints]; // 所有 entry 点同时入队
const visited = new Set(queue);
while (queue.length > 0) {
  const node = queue.shift();
  for (const [target] of this.store.getOutEdges(node)) {
    if (!visited.has(target)) {
      visited.add(target);
      queue.push(target);
    }
  }
}
// 复杂度从 O(entries × (V+E)) 降至 O(V+E)
```

---

### 2.3 三个算法无超时保护

**算法专家发现**:

| 算法 | 复杂度 | 无超时 | 风险 |
|------|--------|--------|------|
| `betweennessCentrality` | O(200 × (V+E)) = 38M | **是** | 严重 |
| `katzCentrality` | O(100 × V × deg) = 13.5M | **是** | 严重 |
| `dominatorTree` | O(V² × E) 最坏 4×10¹⁴ | **是** | 致命 |

**修复方案**: 所有算法添加 `deadline` 参数，每 N 次迭代检查 `Date.now() > deadline`

---

### 2.4 getWeightedOutDegree 方法缺失 — 运行时必崩

**位置**: `GraphEngine.ts:530`

**算法专家发现**:
```typescript
// PageRank 调用了一个不存在的方法
this.store.getWeightedOutDegree(node, ['contains'])
// GraphStore.ts (468 行) 中未定义此方法
```

**影响**: 如果 PageRank 被触发，会抛出 TypeError 并可能被 try-catch 吞掉，导致静默失败或无限重试。

---

## 三、高危问题 (P1)

### 3.1 Fire-and-forget 恶性循环

**Agent Tool 专家分析**:
```
ensureReady() 触发后台 sync (fire-and-forget)
  → 超时触发 child.kill('SIGKILL')
  → Promise reject → syncTriggered.delete()
  → 下次 ensureReady() 再次触发 sync
  → 新旧 sync 子进程并行运行 → CPU 争用
```

**修复**: 将 `syncTriggered` 从 `Set` 改为 `Map<string, Promise<void>>`，让并发调用者 await 同一个 Promise。

---

### 3.2 全局状态 + 无资源隔离

**软件架构师发现**:
```
模块级全局状态:
- activeChildren: Set (子进程跟踪)
- lastSyncTime: Map (同步时间)
- syncTriggered: Set (去重标志)
- downloadPromise: Promise (下载锁)
- lastGraphOpTime: number (速率限制)
- circuitBreakerFailures: number (熔断器)

问题: 多个 agent 共享同一份状态
- 一个 agent 的 circuit breaker 失败影响所有 agent
- rate limiter 是全局的，不是 per-agent
- sync 操作不受 rate limiter 约束
```

---

### 3.3 EdgeMeta 类型不一致

**算法专家发现**:
```
GraphStore 类字段: Map<string, Map<string, EdgeMeta>>     (单值)
GraphData 接口:   Map<string, Map<string, EdgeMeta[]>>    (数组)

PageRank 遍历:
for (const [u, edges] of inEdges) {
  for (const e of edges) {  // edges 是单个 EdgeMeta，不是数组！
    // TypeError: edges is not iterable
  }
}
```

---

### 3.4 addEdge 合并键污染

**算法专家发现**:
```typescript
// GraphStore.ts:364
const mergedKey = `${to}::${type}`

// BFS/DFS 遍历时:
for (const [target] of outEdges)
// target 会是 "nodeId::edgeType" 格式
// 访问不存在的节点 → 浪费内存 + 结果不准确
```

---

## 四、中危问题 (P2)

### 4.1 Louvain 超时粒度太粗

**算法专家分析**:
```
每 1000 节点检查一次 timeout
单次 pass 处理 54K 节点 → 两次检查间执行 2500 次操作
Phase 2 聚合无 timeout 检查
computeModularity 每次 level 切换调用两次
```

**建议**: 减小 maxPasses 默认值从 100 到 30，timeout 检查改为每 500 节点。

---

### 4.2 内存压力

**算法专家分析**:
```
PageRank 每次迭代创建新 Map:
54K 节点 × 64 字节 = 3.4MB/迭代 × 100 迭代 = 340MB 临时分配

Louvain 保留 10 层映射数据
getAllNodeIds() 每次调用创建新数组
```

**建议**: 缓存 `getAllNodeIds()` 结果，PageRank 使用双缓冲而非每次新 Map。

---

### 4.3 execSync 阻塞事件循环

**Agent Tool 专家发现**:
```typescript
// GrokTool.ts:382-386
const gitLog = execSync(
  `git log --name-only --pretty=format:"COMMIT:%H" ${sinceArg}`,
  { cwd: projectRoot, encoding: 'utf-8', timeout: 30000 }
)
// 同步操作，阻塞事件循环最多 30 秒
// 大项目 git log 输出可能很大
// 解析后嵌套循环 O(n × m²)
```

---

## 五、修复优先级矩阵

| 优先级 | 问题 | 影响范围 | 修复难度 | 建议时间 |
|--------|------|---------|---------|---------|
| **P0-1** | 进程组管理 + AbortController | 所有子进程 | 中 | 立即 |
| **P0-2** | BFS 级联改多源 BFS | classifyRoles | 低 | 立即 |
| **P0-3** | 所有算法添加 timeout | GraphEngine | 中 | 立即 |
| **P0-4** | 修复 getWeightedOutDegree | PageRank | 低 | 立即 |
| **P1-1** | syncTriggered 改 Map | ensureReady | 低 | 本周 |
| **P1-2** | 全局资源配额 (Semaphore) | 所有 codegraph 操作 | 高 | 本周 |
| **P1-3** | 修复 EdgeMeta 类型不一致 | GraphStore | 中 | 本周 |
| **P2-1** | Louvain 优化 (maxPasses=30) | louvainCommunity | 低 | 下周 |
| **P2-2** | 内存优化 (缓存+双缓冲) | PageRank/Louvain | 中 | 下周 |
| **P2-3** | execSync 改异步 | grok_hotspots | 低 | 下周 |

---

## 六、修复代码示例

### 6.1 进程组管理 (P0-1)

```typescript
// CodegraphManager.ts
const activeChildren = new Set<ReturnType<typeof spawn>>();

function runCodegraph(...): Promise<CodegraphResult> {
  const ac = new AbortController();
  const child = spawn(binPath, args, {
    detached: true,
    signal: ac.signal,
    // ...
  });

  // 跟踪子进程
  activeChildren.add(child);
  child.on('exit', () => activeChildren.delete(child));

  // 超时杀死进程组
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, timeoutMs);

  // 进程退出时清理
  const exitHandler = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  };
  process.on('exit', exitHandler);
  child.on('exit', () => process.off('exit', exitHandler));

  // ...
}
```

### 6.2 多源 BFS (P0-2)

```typescript
// GraphEngine.ts - classifyRoles()
private multiSourceBFS(entries: string[]): Map<string, Set<string>> {
  const reachable = new Map<string, Set<string>>();
  const globalVisited = new Set<string>();

  // 所有 entry 点同时入队
  const queue: [string, string][] = entries.map(e => [e, e]);
  for (const e of entries) globalVisited.add(e);

  while (queue.length > 0) {
    const [source, current] = queue.shift()!;
    if (!reachable.has(source)) reachable.set(source, new Set());
    reachable.get(source)!.add(current);

    for (const [target] of this.store.getOutEdges(current)) {
      if (!globalVisited.has(target)) {
        globalVisited.add(target);
        queue.push([source, target]);
      }
    }
  }

  return reachable;
}
```

### 6.3 统一超时保护 (P0-3)

```typescript
// GraphEngine.ts - 通用超时检查
private checkTimeout(deadline: number, operation: string): void {
  if (Date.now() > deadline) {
    throw new Error(`Graph operation "${operation}" timed out`);
  }
}

// 在所有算法中使用
betweennessCentrality(opts?: { timeoutMs?: number }): CentralityResult {
  const deadline = Date.now() + (opts?.timeoutMs ?? 15000);
  // ... BFS 循环中:
  if (++counter % 100 === 0) this.checkTimeout(deadline, 'betweennessCentrality');
}
```

---

## 七、架构演进路线

### 短期 (1-2 周): 止血
- P0 修复: 进程组管理、BFS 优化、超时保护
- 目标: 消除孤儿进程，防止 CPU 100%

### 中期 (1-2 月): 加固
- P1 修复: 资源配额、类型修复、并发控制
- 目标: 多 agent 并发安全

### 长期 (3-6 月): 重构
- 将 codegraph sync 内置化 (CodegraphWriter 已实现写入层)
- GraphEngine 移至 Worker 线程
- 增量计算 (PageRank/Louvain)
- 目标: 完全消除子进程依赖，图算法不阻塞主线程

---

## 八、验证清单

修复后需验证：

- [ ] 父进程退出后，所有子进程在 1 秒内被杀死
- [ ] `pkill -f "codegraph.*sync"` 后无残留进程
- [ ] 54K 节点图的 `classifyRoles` 在 5 秒内完成
- [ ] 54K 节点图的 `louvainCommunity` 在 10 秒内完成
- [ ] 多个 agent 同时调用 codegraph 时 CPU 不超过 80%
- [ ] `getWeightedOutDegree` 方法存在且 PageRank 正常工作
- [ ] EdgeMeta 类型统一，BFS/DFS 遍历无 TypeError

---

## 九、附录：专家评审原文

- Agent Tool 专家: `/private/tmp/claude-502/.../tasks/a5aa70f402aff3d9d.output`
- 算法专家: `/private/tmp/claude-502/.../tasks/a931619e7353e329d.output`
- 软件架构师: `/private/tmp/claude-502/.../tasks/a752c939afa14d06a.output`
