# LSP 架构优化 — 新老架构对比

## 背景

在长时间 AI Agent 会话中，Claude Code 进程内存持续增长（可达 3703MB+）。经过深度排查，发现两个主要泄漏源：
1. **LSP `openedFiles` Map** — 对话压缩流程从未关闭已追踪文件，Map 无限增长
2. **CCRClient `paginatedGet`** — 分页事件无界累积

在此基础上进行了系统性架构优化，涵盖 LSP 文件追踪、结果缓存、并发去重、压缩清理等维度。

---

## 老架构问题清单

| # | 组件 | 问题 | 影响 |
|---|------|------|------|
| 1 | `LSPServerManager.openedFiles` | Map 只增不减，无淘汰机制 | 长期会话中无限增长 |
| 2 | LSP 结果 | 每次查询都发 LSP RPC，无缓存 | 重复请求浪费 CPU + 网络 |
| 3 | `LSPTool.call` | 每次独立读文件，未复用 `fileReadCache` | 冗余 I/O |
| 4 | `FileEditTool` | 编辑后不通知 LSP 缓存失效 | LSP 返回旧诊断/符号 |
| 5 | `postCompactCleanup` | 不清 LSP 相关状态 | 压缩后缓存数据过期 |
| 6 | `CCRClient.paginatedGet` | 分页事件无上限累积 | 长会话 OOM |
| 7 | LSP 并发 | 多 Agent 并行时相同查询发多次 | 重复 LSP RPC |
| 8 | 缓存安全 | （如果加了缓存）原始引用存储，下游可篡改 | 缓存污染 |
| 9 | `didClose` 驱逐 | LRU 驱逐时发 `didClose`，LSP 丢弃 AST | CPU 重建成本 |
| 10 | 路径碰撞 | `invalidateFile` 子串匹配 | `.ts` 误删 `.tsx` 缓存 |

---

## 新架构设计

### 1. LSP 结果缓存 (`lspResultCache.ts` — 新文件)

| 特性 | 设计 |
|------|------|
| **序列化存储** | `jsonStringify` → 存储字符串 → `JSON.parse` 返回新实例，防止下游篡改 |
| **TTL** | 5 分钟 — 覆盖单轮重查询，短于 Agent 编辑周期 |
| **容量** | 500 条目，批量驱逐 10%（避免逐条 thrashing） |
| **单条上限** | 500KB — 防止 `workspaceSymbol` 大结果占满缓存 |
| **LRU** | Map 插入顺序模拟：`delete` + `set` 移到末尾（MRU），驱逐头部（LRU） |
| **文件失效** | `invalidateFile` 扫描 `${filePath}::` 前缀，O(N) 但 N≤500 < 1ms |

### 2. In-flight 请求去重

| 场景 | 老架构 | 新架构 |
|------|--------|--------|
| 多 Agent 并行同 key | N 次 LSP RPC | 1 次 LSP RPC，N 个调用者复用同一 Promise |
| 实现 | 无 | `pendingRequests: Map<key, Promise>` |
| 竞态防护 | N/A | `invalidationGen` 计数器 — 文件编辑后跳过过期结果的缓存 |
| 异常处理 | N/A | `.catch()` 清理 pending，防止"黑洞" |

### 3. `openedFiles` LRU 追踪

| 特性 | 老架构 | 新架构 |
|------|--------|--------|
| 结构 | `Map<uri, serverName>` | `Map<uri, {serverName, version}>` |
| 上限 | 无 | MAX_OPEN_FILES = 50 |
| 驱逐 | 无 | 静默删除跟踪条目（不发 `didClose`，保留 LSP AST） |
| 版本号 | 无 | `changeFile` 递增，LSP 协议合规 |
| LRU 触碰 | 无 | `isFileOpen` 时 `delete` + `set` 移到 MRU 端 |

### 4. 文件编辑联动

```
FileEditTool.write()
    ├── clearDeliveredDiagnosticsForFile(fileUri)  // 已有
    ├── lspResultCache.invalidateFile(filePath)    // 新增
    ├── lspManager.changeFile(filePath, content)   // 已有
    └── lspManager.saveFile(filePath)              // 已有
```

### 5. 对话压缩清理

```
runPostCompactCleanup()
    ├── resetMicrocompactState()
    ├── lspResultCache.clear()          // 新增（仅主线程）
    ├── resetContextCollapse()          // 已有
    ├── getUserContext.cache.clear()    // 已有
    ├── ...                             // 已有
    └── lspManager.closeAllFiles()      // 新增（已存在的修复）
```

### 6. CCRClient 事件上限

| 特性 | 老架构 | 新架构 |
|------|--------|--------|
| 上限 | 无 | 10,000 事件 |
| 策略 | 无 | FIFO 驱逐（`splice(0, excess)`） |

---

## 内存预算对比

| 组件 | 老架构 | 新架构 | 说明 |
|------|--------|--------|------|
| LSP openedFiles Map | 无限增长 | ~5KB (50 条) | 仅存 `{uri → {serverName, version}}` 字符串 |
| LSP 结果缓存 | 无 | ~2-5MB (典型) | 500 条 × 500KB 上限，实际每条 10-50KB |
| CCRClient 事件 | 无限增长 | ~10-50MB | 10K 事件上限 |
| LSP 子进程 AST | 不变 | 不变 | 不在主进程，不受本次影响 |

---

## 架构对比图

### 老架构

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  LSPTool    │────▶│  LSPManager  │────▶│ LSP子进程    │
│  (无缓存)   │     │  openedFiles │     │ (AST解析)    │
└─────────────┘     │  (无淘汰)    │     └──────────────┘
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ CCRClient    │
                    │ (无界累积)   │
                    └──────────────┘
```

### 新架构

```
┌─────────────────────────────────────────────────────┐
│  LSPTool                                            │
│  ┌─────────────────┐    ┌──────────────────────┐   │
│  │ lspResultCache  │    │ getOrFetch()          │   │
│  │ - JSON序列化    │◄──►│ - in-flight去重       │   │
│  │ - 5min TTL      │    │ - invalidationGen防护 │   │
│  │ - 500条LRU      │    └──────────┬───────────┘   │
│  │ - 500KB单条上限 │               │               │
│  └─────────────────┘               │               │
└──────────────────┬──────────────────┼───────────────┘
                   │                  │
┌──────────────────▼──────────────────▼───────────────┐
│  LSPServerManager                                   │
│  ┌──────────────────────────┐                       │
│  │ openedFiles (MAX=50)     │                       │
│  │ - {serverName, version}  │                       │
│  │ - LRU静默驱逐            │                       │
│  │ - isFileOpen触碰MRU      │                       │
│  └──────────────────────────┘                       │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│  LSP子进程 (AST解析 — 独立进程，不受影响)            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  FileEditTool ──▶ invalidateFile(filePath)          │
│  postCompactCleanup ──▶ cache.clear() + closeAll()  │
│  CCRClient ──▶ maxEvents=10,000 + FIFO驱逐          │
└─────────────────────────────────────────────────────┘
```

---

## 关键设计决策

| 决策 | 理由 |
|------|------|
| TTL 5 分钟而非 30 分钟 | Agent 高频对话，30 分钟 = 300+ 轮，数据严重过期 |
| JSON 序列化存储 | 防止下游代码（formatResult）篡改缓存对象 |
| LRU 驱逐不发 `didClose` | LSP 会丢弃 AST，重建成本远超 Map 条目内存 |
| 批量驱逐 10% | 避免逐条插入时频繁触发驱逐（thrashing） |
| O(N) 扫描失效文件 | N≤500，~500 次字符串比较 < 1ms，无需二级索引 |
| `invalidationGen` 计数器 | 防止文件编辑后旧 factory 结果重新缓存 |
| 压缩时仅主线程清缓存 | 子进程与主进程共享模块状态，不清避免污染 |

---

## 文件变更清单

| 文件 | 类型 | 变更说明 |
|------|------|----------|
| `src/services/lsp/lspResultCache.ts` | 新建 | LSP 结果缓存核心实现 |
| `src/services/lsp/LSPServerManager.ts` | 修改 | openedFiles 结构改版 + LRU 追踪 |
| `src/tools/LSPTool/LSPTool.ts` | 修改 | 缓存集成 + getOrFetch 去重 |
| `src/tools/FileEditTool/FileEditTool.ts` | 修改 | 编辑后 cache invalidation |
| `src/services/compact/postCompactCleanup.ts` | 修改 | 压缩时清缓存 + 关闭 LSP 文件 |
| `src/cli/transports/ccrClient.ts` | 修改 | 分页事件上限 10K |
