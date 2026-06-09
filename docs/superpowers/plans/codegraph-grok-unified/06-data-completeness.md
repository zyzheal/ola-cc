# 数据完整性补全方案

> 日期: 2026-06-05
> 目标: ola-cc 数据完整性从 6/10 → 8.5/10
> 参考: codegraph (9/10) 数据模型

---

## 1. 差距分析

### 1.1 综合评分对比

| 维度 | codegraph (9/10) | ola-cc 当前 (6/10) | 差距 |
|------|------------------|-------------------|------|
| 节点属性完整度 | 21 属性 | 8 属性 | -13 属性 |
| 边类型覆盖 | 12 种 | 7 种 | -5 种 |
| 文件级追踪 | 7 字段完整 | 无 | 缺失 |
| 未解析引用 | 完整追踪 | 无 | 缺失 |
| 全文搜索 | FTS5 多字段 | 无 | 缺失 |
| 查询优化 | 14 索引 + Prepared Stmts | 线性扫描 | 较弱 |
| 缓存策略 | LRU 1000 + 64MB 页缓存 | 内存 Map | 较弱 |

### 1.2 节点属性差距

**codegraph NodeMetadata (21 字段)**:
```
id, kind, name, qualifiedName, filePath, language,
startLine, endLine, startColumn, endColumn,
docstring, signature, visibility, isExported,
isAsync, isStatic, isAbstract, decorators,
typeParameters, updatedAt, provenance
```

**ola-cc NodeMetadata 当前 (8 字段)**:
```
id, name, kind, file, line, signature, qualified_name, layer/domain (Grok)
```

**缺失 13 个字段**:

| 缺失字段 | 类型 | 影响 | 优先级 |
|----------|------|------|:------:|
| language | string | 无法按语言过滤/分析 | P1 |
| endLine | number | 无法精确定位代码范围 | P1 |
| docstring | string? | 无法搜索文档字符串 | P1 |
| visibility | enum? | 无法分析访问控制 | P2 |
| isExported | boolean? | 无法识别导出符号 | P1 |
| isAsync | boolean? | 无法识别异步函数 | P2 |
| isStatic | boolean? | 无法识别静态成员 | P2 |
| isAbstract | boolean? | 无法识别抽象类/方法 | P2 |
| decorators | string[]? | 无法识别装饰器 | P3 |
| typeParameters | string[]? | 无法识别泛型参数 | P3 |
| startColumn | number | 无法精确定位列范围 | P3 |
| endColumn | number | 无法精确定位列范围 | P3 |
| updatedAt | number | 无法追踪更新时间 | P2 |

### 1.3 边类型差距

**codegraph 12 种 EdgeKind**:
```
contains, calls, imports, exports, extends, implements,
references, type_of, returns, instantiates, overrides, decorates
```

**ola-cc 当前 7 种 EdgeType**:
```
calls, imports, contains, data(=references), inherits(=extends), implements, control(fallback)
```

**缺失 5 种边类型**:

| 缺失边类型 | 语义 | 降级行为 | 影响 |
|------------|------|---------|------|
| exports | 文件导出符号 | 丢失 | 无法追踪模块导出关系 |
| type_of | 变量/参数的类型 | 丢失 | 无法进行类型分析 |
| returns | 函数返回类型 | 丢失 | 无法追踪返回值类型 |
| overrides | 方法重写 | 丢失 | 无法追踪继承链重写 |
| decorates | 装饰器应用 | 丢失 | 无法追踪装饰器关系 |
| instantiates | 实例化 | 降级为 calls | 语义混淆 |

### 1.4 功能差距

| 功能 | codegraph | ola-cc | 影响 |
|------|-----------|--------|------|
| 文件级追踪 | files 表 (7 字段) | 无 | 无法检测文件变更、追踪语言分布 |
| 未解析引用 | unresolved_refs 表 (8 字段) | 无 | 跨文件引用断裂、动态导入丢失 |
| FTS5 全文搜索 | nodes_fts 虚拟表 + BM25 | 无 | 无法搜索符号名、文档、签名 |
| 框架检测 | detectFrameworks() | 无 | 框架特定符号缺失 |
| LRU 缓存 | 1000 节点缓存 | 无 | 重复查询性能差 |
| Prepared Statements | 懒初始化 | 无 | 查询优化不足 |
| 批量查询 | getNodesByIds() | 无 | 批量操作效率低 |

---

## 2. 补全方案

### 2.1 NodeMetadata 扩展

**扩展后接口** (21 字段，与 codegraph 对齐):

```typescript
export interface NodeMetadata {
  // 核心标识
  id: string
  name: string
  kind: string
  qualified_name?: string

  // 位置信息
  file: string
  line: number           // startLine
  end_line?: number      // [新增] endLine
  start_column?: number  // [新增] startColumn
  end_column?: number    // [新增] endColumn

  // 语言信息
  language?: string      // [新增] 编程语言

  // 文档信息
  signature?: string
  docstring?: string     // [新增] 文档字符串

  // 访问控制
  visibility?: 'public' | 'private' | 'protected' | 'internal'  // [新增]
  is_exported?: boolean  // [新增] 是否导出

  // 类型修饰
  is_async?: boolean     // [新增] 是否异步
  is_static?: boolean    // [新增] 是否静态
  is_abstract?: boolean  // [新增] 是否抽象

  // 高级特性
  decorators?: string[]      // [新增] 装饰器/注解
  type_parameters?: string[] // [新增] 泛型参数

  // 元信息
  updated_at?: number    // [新增] 更新时间戳
  provenance?: string    // [新增] 来源追踪

  // Grok 语义字段 (保留)
  layer?: string
  domain?: string
}
```

**SQL 查询扩展**:
```sql
-- 当前
SELECT id, kind, name, qualified_name, file_path, start_line, signature FROM nodes

-- 扩展后
SELECT id, kind, name, qualified_name, file_path, language,
       start_line, end_line, start_column, end_column,
       docstring, signature, visibility, is_exported,
       is_async, is_static, is_abstract, decorators,
       type_parameters, updated_at, provenance
FROM nodes
```

### 2.2 EdgeMeta 扩展

**扩展后接口**:

```typescript
export type EdgeType =
  | 'calls' | 'imports' | 'contains' | 'data'
  | 'inherits' | 'implements' | 'exports'      // [新增]
  | 'type_of' | 'returns' | 'instantiates'     // [新增]
  | 'overrides' | 'decorates'                   // [新增]
  | 'control'  // fallback

export interface EdgeMeta {
  type: EdgeType
  weight: number
  confidence?: number        // [新增] 置信度 (0-1)
  source_line?: number       // [新增] 关系发生位置
  source_column?: number     // [新增] 关系发生列
  provenance?: string        // [新增] 来源: 'tree-sitter' | 'scip' | 'heuristic'
  metadata?: Record<string, unknown>  // [新增] 附加上下文
}
```

**CODEGRAPH_EDGE_MAP 完整 12 项**:
```typescript
const CODEGRAPH_EDGE_MAP: Record<string, EdgeType> = {
  calls: 'calls',
  imports: 'imports',
  contains: 'contains',
  references: 'data',
  extends: 'inherits',
  implements: 'implements',
  exports: 'exports',         // [新增]
  type_of: 'type_of',         // [新增]
  returns: 'returns',         // [新增]
  instantiates: 'instantiates', // [修正] 不再降级为 calls
  overrides: 'overrides',     // [新增]
  decorates: 'decorates',     // [新增]
}
```

### 2.3 文件级追踪

**新增 FileRecord 接口**:

```typescript
export interface FileRecord {
  path: string
  content_hash: string    // SHA-256 内容哈希
  language: string        // 编程语言
  size: number            // 文件大小 (bytes)
  modified_at: number     // 文件修改时间
  indexed_at: number      // 索引时间
  node_count: number      // 节点数量
  errors?: string         // 提取错误
}
```

**GraphStore 新增**:
```typescript
export class GraphStore {
  // 新增文件追踪
  public readonly files = new Map<string, FileRecord>()

  // 新增方法
  getFileRecord(path: string): FileRecord | undefined
  getFilesByLanguage(language: string): FileRecord[]
  getFileLanguages(): Map<string, number>  // language → count
}
```

**SQL 查询**:
```sql
SELECT path, content_hash, language, size, modified_at, indexed_at, node_count, errors
FROM files
```

### 2.4 未解析引用管理

**新增 UnresolvedReference 接口**:

```typescript
export interface UnresolvedReference {
  id: number
  from_node_id: string
  reference_name: string
  reference_kind: string
  line: number
  col: number
  candidates?: string      // JSON 数组
  file_path: string
  language: string
}
```

**GraphStore 新增**:
```typescript
export class GraphStore {
  // 新增未解析引用
  public readonly unresolvedRefs = new Map<number, UnresolvedReference>()

  // 新增方法
  getUnresolvedRefs(nodeId: string): UnresolvedReference[]
  getUnresolvedRefsByFile(filePath: string): UnresolvedReference[]
  getUnresolvedRefCount(): number
}
```

### 2.5 FTS5 全文搜索

**Schema 扩展** (在 codegraph.db 中已有，直接使用):

```sql
-- codegraph.db 已包含
CREATE VIRTUAL TABLE nodes_fts USING fts5(
    id, name, qualified_name, docstring, signature,
    content='nodes', content_rowid='rowid'
);
```

**GraphStore 新增搜索方法**:

```typescript
export class GraphStore {
  /**
   * 全文搜索节点
   * @param query 搜索关键词
   * @param options 选项 (limit, language, kind)
   * @returns 匹配结果 (按 BM25 相关性排序)
   */
  searchNodes(query: string, options?: {
    limit?: number
    language?: string
    kind?: string
  }): SearchResult[]
}

export interface SearchResult {
  node: NodeMetadata
  score: number       // BM25 相关性分数
  highlights?: {      // 高亮信息
    name?: string
    qualified_name?: string
    docstring?: string
    signature?: string
  }
}
```

**SQL 查询**:
```sql
-- FTS5 搜索 (codegraph.db 已支持)
SELECT n.*, bm25(nodes_fts) as score
FROM nodes_fts
JOIN nodes n ON n.id = nodes_fts.id
WHERE nodes_fts MATCH ?
ORDER BY score
LIMIT ?
```

### 2.6 查询优化

**Prepared Statements**:
```typescript
export class GraphStore {
  private stmts = {
    getNode: null as PreparedStatement | null,
    getEdges: null as PreparedStatement | null,
    searchNodes: null as PreparedStatement | null,
    getFilesByLanguage: null as PreparedStatement | null,
  }

  // 懒初始化
  private getStmt(name: keyof typeof this.stmts, sql: string): PreparedStatement {
    if (!this.stmts[name]) {
      this.stmts[name] = this.db.prepare(sql)
    }
    return this.stmts[name]!
  }
}
```

**LRU 缓存**:
```typescript
export class GraphStore {
  private nodeCache = new Map<string, NodeMetadata>()
  private readonly CACHE_MAX = 1000

  getNode(nodeId: string): NodeMetadata | undefined {
    // LRU 缓存命中
    const cached = this.nodeCache.get(nodeId)
    if (cached) {
      // 移到最新 (LRU)
      this.nodeCache.delete(nodeId)
      this.nodeCache.set(nodeId, cached)
      return cached
    }

    // 缓存未命中，查询 DB
    const node = this.queryNodeFromDb(nodeId)
    if (node) {
      // 缓存淘汰
      if (this.nodeCache.size >= this.CACHE_MAX) {
        const firstKey = this.nodeCache.keys().next().value
        this.nodeCache.delete(firstKey)
      }
      this.nodeCache.set(nodeId, node)
    }
    return node
  }
}
```

**批量查询**:
```typescript
export class GraphStore {
  /**
   * 批量获取节点 (减少 DB 查询次数)
   */
  getNodesByIds(ids: string[]): Map<string, NodeMetadata> {
    const result = new Map<string, NodeMetadata>()
    const uncached: string[] = []

    // 先查缓存
    for (const id of ids) {
      const cached = this.nodeCache.get(id)
      if (cached) {
        result.set(id, cached)
      } else {
        uncached.push(id)
      }
    }

    // 批量查询未缓存的
    if (uncached.length > 0) {
      const placeholders = uncached.map(() => '?').join(',')
      const nodes = this.db!.query(
        `SELECT * FROM nodes WHERE id IN (${placeholders})`
      ).all(...uncached) as NodeMetadata[]

      for (const node of nodes) {
        result.set(node.id, node)
        this.nodeCache.set(node.id, node)
      }
    }

    return result
  }
}
```

---

## 3. GraphEngine 适配

### 3.1 新字段利用

| 算法 | 新字段 | 用途 |
|------|--------|------|
| classifyRoles | is_exported, visibility | 导出符号更可能是 hub |
| classifyRoles | language | 按语言分组角色 |
| pageRank | instantiates (不再降级) | 实例化关系独立权重 |
| backwardDataSlice | type_of, returns | 类型依赖链追踪 |
| couplingMetrics | language | 跨语言耦合检测 |
| louvainCommunity | language | 语言内社区发现 |

### 3.2 新边类型参与矩阵

| 算法 | calls | imports | contains | data | inherits | implements | exports | type_of | returns | instantiates | overrides | decorates |
|------|:-----:|:-------:|:--------:|:----:|:--------:|:----------:|:-------:|:-------:|:-------:|:------------:|:---------:|:---------:|
| BFS/DFS | Y | Y | - | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| PageRank | Y | Y | - | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Louvain | Y | Y | - | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| SCC | Y | Y | - | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| TopoSort | Y | Y | - | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| backwardDataSlice | - | - | - | Y | - | - | - | Y | Y | - | - | - |
| classifyRoles | Y | Y | - | Y | Y | Y | Y | - | - | Y | Y | - |

**说明**: `contains` 排除（已有设计），其余新类型默认参与。

---

## 4. CodegraphTool 操作扩展

### 4.1 新增搜索操作

```typescript
// codegraph_search — 全文搜索
{
  name: 'codegraph_search',
  description: '全文搜索代码符号 (FTS5 + BM25 相关性排序)',
  inputSchema: z.object({
    query: z.string().describe('搜索关键词'),
    limit: z.number().optional().default(20),
    language: z.string().optional().describe('按语言过滤'),
    kind: z.string().optional().describe('按节点类型过滤'),
  }),
}

// codegraph_files — 文件级查询
{
  name: 'codegraph_files',
  description: '查询文件级信息 (语言分布、变更状态、错误)',
  inputSchema: z.object({
    action: z.enum(['languages', 'changed', 'errors', 'stats']),
    language: z.string().optional(),
  }),
}

// codegraph_unresolved — 未解析引用查询
{
  name: 'codegraph_unresolved',
  description: '查询未解析的跨文件引用',
  inputSchema: z.object({
    nodeId: z.string().optional().describe('按节点过滤'),
    filePath: z.string().optional().describe('按文件过滤'),
    limit: z.number().optional().default(50),
  }),
}
```

### 4.2 增强现有操作

| 现有操作 | 增强内容 |
|---------|---------|
| codegraph_impact | 返回结果包含 language、visibility、is_exported |
| codegraph_callers | 返回结果包含 call_site (行号/列号) |
| codegraph_callees | 返回结果包含 confidence 置信度 |
| codegraph_status | 返回文件语言分布、未解析引用数量 |
| codegraph_delta | 返回结果包含 provenance 来源追踪 |

---

## 5. 实施阶段

### Phase 1: 数据模型对齐 (2 天)

**目标**: NodeMetadata 21 字段 + EdgeType 12 种 + 文件级追踪

| 任务 | 天数 | 依赖 |
|------|:----:|------|
| F-52: NodeMetadata 扩展 (13 新字段) | 0.5 | 无 |
| F-53: EdgeMeta 扩展 (5 新类型 + 元信息) | 0.5 | 无 |
| F-54: FileRecord 接口 + files 表加载 | 0.5 | 无 |
| F-55: GraphStore.loadCodegraph() 查询扩展 | 0.5 | F-52, F-53, F-54 |

**验收条件**:
- [ ] NodeMetadata 包含 21 个字段
- [ ] EdgeType 包含 12 种 (无降级)
- [ ] FileRecord 包含 7 个字段
- [ ] GraphStore.load() 成功加载所有新字段

### Phase 2: 查询优化 (2 天)

**目标**: Prepared Statements + LRU 缓存 + 批量查询

| 任务 | 天数 | 依赖 |
|------|:----:|------|
| F-56: Prepared Statements 懒初始化 | 0.5 | F-55 |
| F-57: LRU 缓存 (1000 节点) | 0.5 | F-56 |
| F-58: 批量查询 getNodesByIds() | 0.5 | F-57 |
| F-59: 性能基准测试 | 0.5 | F-56~F-58 |

**验收条件**:
- [ ] Prepared Statements 懒初始化
- [ ] LRU 缓存命中率 > 80%
- [ ] 批量查询性能提升 > 50%
- [ ] 54K 节点规模 benchmark 达标

### Phase 3: 搜索能力 (3 天)

**目标**: FTS5 全文搜索 + 多信号评分 + 未解析引用

| 任务 | 天数 | 依赖 |
|------|:----:|------|
| F-60: FTS5 搜索集成 | 1 | F-55 |
| F-61: BM25 多信号评分 | 0.5 | F-60 |
| F-62: UnresolvedReference 接口 + 加载 | 0.5 | F-55 |
| F-63: codegraph_search 操作 | 0.5 | F-60, F-61 |
| F-64: codegraph_files 操作 | 0.5 | F-54 |
| F-65: codegraph_unresolved 操作 | 0.5 | F-62 |

**验收条件**:
- [ ] FTS5 搜索支持前缀匹配
- [ ] BM25 相关性排序正确
- [ ] 未解析引用加载正确
- [ ] 三个新操作功能正常

### Phase 4: GraphEngine 适配 (1 天)

**目标**: 算法利用新字段 + 新边类型参与矩阵

| 任务 | 天数 | 依赖 |
|------|:----:|------|
| F-66: classifyRoles 利用 is_exported/visibility | 0.25 | F-52 |
| F-67: backwardDataSlice 支持 type_of/returns | 0.25 | F-53 |
| F-68: 新边类型参与矩阵实现 | 0.25 | F-53 |
| F-69: 回归测试 | 0.25 | F-66~F-68 |

**验收条件**:
- [ ] classifyRoles 导出符号识别正确
- [ ] backwardDataSlice 类型依赖链正确
- [ ] 新边类型参与矩阵正确
- [ ] 所有现有测试通过

---

## 6. 功能清单补充

| # | 功能 | Phase | 天数 | 依赖 |
|---|------|:-----:|:----:|------|
| F-52 | NodeMetadata 扩展 (13 新字段) | D1 | 0.5 | 无 |
| F-53 | EdgeMeta 扩展 (5 新类型 + 元信息) | D1 | 0.5 | 无 |
| F-54 | FileRecord 接口 + files 表加载 | D1 | 0.5 | 无 |
| F-55 | GraphStore.loadCodegraph() 查询扩展 | D1 | 0.5 | F-52~F-54 |
| F-56 | Prepared Statements 懒初始化 | D2 | 0.5 | F-55 |
| F-57 | LRU 缓存 (1000 节点) | D2 | 0.5 | F-56 |
| F-58 | 批量查询 getNodesByIds() | D2 | 0.5 | F-57 |
| F-59 | 性能基准测试 | D2 | 0.5 | F-56~F-58 |
| F-60 | FTS5 搜索集成 | D3 | 1 | F-55 |
| F-61 | BM25 多信号评分 | D3 | 0.5 | F-60 |
| F-62 | UnresolvedReference 接口 + 加载 | D3 | 0.5 | F-55 |
| F-63 | codegraph_search 操作 | D3 | 0.5 | F-60~F-61 |
| F-64 | codegraph_files 操作 | D3 | 0.5 | F-54 |
| F-65 | codegraph_unresolved 操作 | D3 | 0.5 | F-62 |
| F-66 | classifyRoles 利用新字段 | D4 | 0.25 | F-52 |
| F-67 | backwardDataSlice 支持新边类型 | D4 | 0.25 | F-53 |
| F-68 | 新边类型参与矩阵 | D4 | 0.25 | F-53 |
| F-69 | 回归测试 | D4 | 0.25 | F-66~F-68 |

**总计**: 18 个新功能点，8 天

---

## 7. 预期效果

| 维度 | 当前 | 补全后 | 提升 |
|------|:----:|:------:|:----:|
| 节点属性完整度 | 8/21 (38%) | 21/21 (100%) | +62% |
| 边类型覆盖 | 7/12 (58%) | 12/12 (100%) | +42% |
| 文件级追踪 | 0/7 (0%) | 7/7 (100%) | +100% |
| 全文搜索 | 无 | FTS5 + BM25 | 新增 |
| 查询优化 | 线性扫描 | LRU + Prepared | 新增 |
| **数据完整性评分** | **6/10** | **8.5/10** | **+42%** |

---

## 8. 与现有方案的集成

### 8.1 与 Phase 1 (GraphStore 无损化改造) 的关系

本方案的 **Phase 1 (数据模型对齐)** 与 `01-graphstore-redesign.md` 的 Phase 1a 合并执行：

| 01-graphstore-redesign.md | 本方案 | 合并后 |
|---------------------------|--------|--------|
| EdgeType 12+1 种 | EdgeMeta 扩展 5 新类型 | 统一执行 |
| EdgeMeta[] 数组存储 | EdgeMeta 元信息扩展 | 统一执行 |
| fileKeyToId 桥接 | NodeMetadata 扩展 | 统一执行 |
| loadingPromise 并发锁 | — | 保留 |

### 8.2 与 Phase 2 (增量同步) 的关系

本方案的 **FileRecord** 与 IncrementalSync 集成：

```
IncrementalSync.detectDirty()
  ├── git diff (已有)
  ├── mtime 检测 (已有)
  ├── hash 检测 (已有)
  └── FileRecord.content_hash (新增) — 更精确的变更检测
```

### 8.3 与 Phase 3 (算法) 的关系

本方案的 **新边类型参与矩阵** 与 GraphEngine 算法集成：

```
GraphEngine.pageRank()
  ├── 当前: calls + imports + data + inherits + implements
  └── 扩展后: + exports + type_of + returns + instantiates + overrides + decorates
```

### 8.4 与 Phase 6 (codegraph 移植) 的关系

本方案的 **FTS5 搜索** 依赖 codegraph.db 已有的 FTS5 索引：

- Phase 6f (extraction 系统) 需要在 init 时创建 FTS5 索引
- 本方案直接使用已有索引，无需额外创建
