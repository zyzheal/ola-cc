# CPU 100% 残余问题解决方案

> 设计时间：2026-06-09
> 状态：✅ 已实施（1846 测试全通过）

---

## 一、问题诊断

### 已修复项（worktree 中已实现）

| 修复项 | 状态 | 验证 |
|--------|------|------|
| `pageRank` timeoutMs (10s) | ✅ | GraphEngine.ts:522 |
| `louvainCommunity` timeoutMs (30s) | ✅ | GraphEngine.ts:1300 |
| `classifyRoles` timeoutMs (15s) | ✅ | GraphEngine.ts:691 |
| `OLA_CC_AST_CHECK` 环境变量 | ✅ | runAgent.ts:1139 |
| `MAX_AST_FILES = 50` | ✅ | runAgent.ts:1196 |
| AST 增量扫描 (git diff 优先) | ✅ | runAgent.ts:1200-1212 |
| Rate limit (5s 冷却) | ✅ | CodegraphTool.ts:283, GrokTool.ts:192 |
| 熔断器 (3次→60s禁用) | ✅ | CodegraphTool.ts:403, GrokTool.ts:375 |

### 未修复项（CPU 100% 残余根因）

#### 根因 A：工具过度曝光（最严重）

**现象**：codegraph searchHint 15 词 + grok searchHint 8 词，BM25 权重 15/词，几乎所有编程查询都会命中。

**影响链**：
```
用户提问 → BM25 命中 3-6 词 (45-90分) → 工具进入 top-25
→ 模型看到 22 个 codegraph 操作 schema → 选择调用 pagerank/community
→ 超时保护生效但已消耗 10-30s CPU
```

**关键**：timeout 是"先触发再拦截"，不能阻止工具被频繁选中和调用。

#### 根因 B：多处 O(N) 热点无保护

| 热点 | 文件 | 复杂度 | 影响 |
|------|------|--------|------|
| `GraphStore.size` getter | GraphStore.ts:606 | O(E) 每次调用 | 频繁访问时累积 |
| `CodegraphWriter.updateFiles()` | CodegraphWriter.ts:395 | O(files × E) | 增量更新慢 |
| `handleDelta()` 深拷贝 | CodegraphHandlers.ts:279 | O(E) 内存+CPU | 快照操作 |
| `handleKindMap()` 无限制 | CodegraphHandlers.ts:537 | O(E + N) | 统计操作 |
| `GrokAnalyzer.discoverFiles()` | GrokAnalyzer.ts:261 | 同步 readdirSync | 阻塞事件循环 |
| `GrokAnalyzer.detectChanges()` | GrokAnalyzer.ts:317 | 同步 readFileSync × N | 阻塞事件循环 |
| `CodegraphManager.ensureReady()` | CodegraphManager.ts:175 | indexAll + load + persist | 首次调用阻塞 |

---

## 二、修复方案

### P0-A：工具曝光控制（影响最大，实施最简单）

#### A1：searchHint 精简

**CodegraphTool** — 从 15 词减到 5 个核心词：

```typescript
// 之前
searchHint: 'code graph AST callers callees impact trace scc toposort pagerank roles coupling community centrality temporal slice delta'

// 之后 — 只保留最核心的查询意图
searchHint: 'code graph dependency call impact structure'
```

**GrokTool** — 从 8 词减到 4 个核心词：

```typescript
// 之前
searchHint: 'knowledge graph code understanding semantic analysis architecture community hotspots'

// 之后
searchHint: 'knowledge graph architecture analysis'
```

**预期效果**：BM25 命中率降低 60-70%，工具选中频率大幅下降。

#### A2：重操作移入 deferred 层

将 PageRank、Louvain 等 CPU 密集操作从 core/analysis 层移入 advanced（deferred）层：

```typescript
// CodegraphTool OPERATION_TIERS 修改
const OPERATION_TIERS = {
  core: ['search', 'status', 'callers', 'callees'],        // 轻量查询
  analysis: ['impact', 'trace', 'context'],                  // BFS 级别
  advanced: [
    // 原有 advanced...
    // 新增 deferred：
    'pagerank',      // O(100 × V × avg_deg)
    'community',     // O(100 × V × avg_deg)
    'roles',         // 含 PageRank
    'centrality',    // Katz + Betweenness
    'scc',           // Tarjan SCC
    'toposort',      // 拓扑排序
    'coupling',
    'temporal',
    'slice',
    'delta',
    'kind_map',
    'init', 'files', 'sync', 'unresolved',
  ],
}
```

**预期效果**：模型不会在常规查询中看到这些操作的 schema，只有通过 ToolSearchTool 主动发现时才会调用。

#### A3：工具级 shouldDefer

```typescript
// CodegraphTool.ts
shouldDefer: true,  // 整个工具延迟加载

// GrokTool.ts
shouldDefer: true,  // 整个工具延迟加载
```

**效果**：工具不在初始 API 调用中发送，模型通过 ToolSearchTool 按需发现。
**风险**：可能降低工具的可发现性。折中方案：只 defer 重操作（见 A2）。

### P0-B：热点保护

#### B1：GraphStore.size 缓存

```typescript
// GraphStore.ts
private _cachedSize: { nodes: number; edges: number } | null = null

get size() {
  if (this._cachedSize) return this._cachedSize
  let edgeCount = 0
  for (const targets of this.adjacency.values()) {
    for (const edges of targets.values()) {
      edgeCount += edges.length
    }
  }
  this._cachedSize = { nodes: this.nodeCount, edges: edgeCount }
  return this._cachedSize
}

// 在 mutation 方法中清除缓存
private invalidateSizeCache() {
  this._cachedSize = null
}
```

#### B2：handleKindMap 限制返回数量

```typescript
// CodegraphHandlers.ts handleKindMap
const MAX_KIND_ENTRIES = 500
let count = 0
for (const [from, targets] of store.adjacency) {
  if (count >= MAX_KIND_ENTRIES) break
  // ... 统计逻辑
  count++
}
```

#### B3：handleDelta 避免深拷贝

```typescript
// CodegraphHandlers.ts handleDelta
// 之前：深拷贝 adjacency (O(E) 内存)
// 之后：只记录变更的节点/边 ID
const snapshot = {
  nodeIds: new Set(store.nodeMeta.keys()),
  edgeHash: computeEdgeHash(store.adjacency),  // 轻量哈希
}
```

#### B4：GrokAnalyzer 异步化

```typescript
// GrokAnalyzer.ts discoverFiles
// 之前：readdirSync (同步阻塞)
// 之后：使用 fs.promises.readdir + async 递归
async discoverFiles(root: string): Promise<string[]> {
  const results: string[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 20) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      // ...
    }
  }
  await walk(root, 0)
  return results
}

// detectChanges 同理
async detectChanges(files: string[]): Promise<ChangeMap> {
  const results = await Promise.all(
    files.map(async f => ({
      file: f,
      hash: await computeFileFingerprintAsync(f),
    }))
  )
  // ...
}
```

### P1：增量保护

#### C1：CodegraphWriter.updateFiles 优化

```typescript
// 之前：对每个 filePath 遍历全部 adjacency (O(files × E))
// 之后：构建 source → edges 反向索引
private sourceIndex = new Map<string, EdgeMeta[]>()  // sourceFile → edges

updateFiles(filePaths: string[]) {
  for (const fp of filePaths) {
    const edges = this.sourceIndex.get(fp) ?? []  // O(1) 查找
    // ... 只处理这些边
  }
}
```

#### C2：ensureReady 进度回传

```typescript
// CodegraphManager.ts ensureReady
async ensureReady(onProgress?: (msg: string) => void) {
  onProgress?.('Indexing source files...')
  await this.indexAll()
  onProgress?.('Loading graph...')
  await this.store.load()
  onProgress?.('Persisting...')
  await this.writer.persist()
  onProgress?.('Ready')
}
```

---

## 三、实施优先级

| 优先级 | 修复项 | 预期 CPU 降低 | 实施难度 | 文件 |
|--------|--------|-------------|---------|------|
| P0-A1 | searchHint 精简 | 60-70% | 低 (2行) | CodegraphTool.ts, GrokTool.ts |
| P0-A2 | 重操作移入 deferred | 50-60% | 低 (10行) | CodegraphTool.ts |
| P0-B1 | GraphStore.size 缓存 | 10-15% | 低 (15行) | GraphStore.ts |
| P0-B2 | handleKindMap 限制 | 5-10% | 低 (5行) | CodegraphHandlers.ts |
| P0-B3 | handleDelta 避免深拷贝 | 10-15% | 中 (20行) | CodegraphHandlers.ts |
| P0-B4 | GrokAnalyzer 异步化 | 15-20% | 中 (30行) | GrokAnalyzer.ts |
| P1-C1 | updateFiles 反向索引 | 10-15% | 中 (25行) | CodegraphWriter.ts |
| P1-C2 | ensureReady 进度回传 | 0% (UX) | 低 (5行) | CodegraphManager.ts |

**组合预期**：P0-A1 + P0-A2 可减少 80%+ 的图算法调用频率，P0-B 系列消除剩余热点。

---

## 四、验证方案

1. **searchHint 验证**：在 BM25 排名测试中，验证 "分析这个函数" 不再命中 codegraph
2. **deferred 验证**：确认 `codegraph_pagerank` 不在初始工具列表中
3. **size 缓存验证**：连续访问 100 次 `store.size`，确认只计算一次
4. **异步验证**：`discoverFiles` 不阻塞事件循环（Spinner 正常动画）
5. **集成测试**：运行 `grok_architecture` 操作，确认 CPU 在 timeout 内回落

---

## 五、实施状态

| 修复项 | 文件 | 状态 |
|--------|------|------|
| searchHint 精简 (15→5 词) | CodegraphTool.ts | ✅ |
| searchHint 精简 (8→4 词) | GrokTool.ts | ✅ |
| OPERATION_TIERS 重构 (6个CPU密集操作→deferred) | CodegraphTool.ts | ✅ |
| GraphStore.size 缓存 | GraphStore.ts | ✅ |
| handleDelta 避免深拷贝 | CodegraphHandlers.ts | ✅ |
| updateFiles 反向索引 | CodegraphWriter.ts | ✅ |
| GrokAnalyzer.discoverFiles 异步化 | GrokAnalyzer.ts | ✅ |
| ensureReady 进度回传 | CodegraphManager.ts | ✅ |
| 测试更新 | CodegraphTool.test.ts | ✅ |

**测试结果**: 1846 pass, 0 fail

---

## 六、不修复项（已确认安全）

| 项目 | 原因 |
|------|------|
| GraphLoader.extractReExports() | 只在首次加载时执行，有 yield 保护 |
| buildSuffixIndex() | 惰性加载，只在首次调用时执行 |
| GrokAssembler.assembleReview() | 三次遍历是必要的去重逻辑 |
| handleImpact BFS | 有 depth 限制 (默认 2) |
