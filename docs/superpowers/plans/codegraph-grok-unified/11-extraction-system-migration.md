# Extraction 系统迁移设计

> 日期: 2026-06-05
> 来源: /tmp/codegraph/src/extraction/ (9,971 行)
> Phase: Z1 (基础) + Z2 (核心) + Z3 (专用提取器)
> 总工期: 10 天 (Z1: 1d + Z2: 5d + Z3: 4d)

---

## 1. 迁移范围

### 1.1 代码统计

| 模块 | 文件 | 行数 | Phase | 天数 |
|------|------|-----:|:-----:|:----:|
| 类型定义 | tree-sitter-types.ts | 227 | Z1 | 0.25 |
| 辅助函数 | tree-sitter-helpers.ts | 80 | Z1 | 0.25 |
| Grammar 加载 | grammars.ts | 394 | Z1 | 0.5 |
| **核心提取器** | **tree-sitter.ts** | **3,242** | **Z2** | **3** |
| 提取编排器 | extraction/index.ts | 1,550 | Z2 | 1.5 |
| Worker 线程 | parse-worker.ts | 101 | Z2 | 0.5 |
| 语言提取器 (19种) | languages/*.ts | 2,055 | Z2 | (含在核心提取器中) |
| Vue 提取器 | vue-extractor.ts | 290 | Z3 | 0.5 |
| Svelte 提取器 | svelte-extractor.ts | 323 | Z3 | 0.5 |
| Liquid 提取器 | liquid-extractor.ts | 352 | Z3 | 0.5 |
| MyBatis 提取器 | mybatis-extractor.ts | 198 | Z3 | 0.5 |
| DFM 提取器 | dfm-extractor.ts | 159 | Z3 | 0.5 |
| **总计** | **34 个文件** | **9,971** | | **10** |

### 1.2 目录结构

```
src/services/graph/extraction/
├── tree-sitter-types.ts          # 类型定义 (LanguageExtractor, ExtractionResult, etc.)
├── tree-sitter-helpers.ts        # 工具函数 (generateNodeId, getNodeText, etc.)
├── grammars.ts                   # WASM grammar 加载 + 语言检测 + 扩展名映射
├── tree-sitter.ts                # 核心提取器 (TreeSitterExtractor 类)
├── index.ts                      # 提取编排器 (ExtractionOrchestrator)
├── parse-worker.ts               # Worker 线程 (WASM 隔离 + 内存回收)
│
├── languages/                    # 19 种语言提取器
│   ├── index.ts                  # EXTRACTORS 注册表
│   ├── typescript.ts             # TS/JS (118 行)
│   ├── javascript.ts             # JS 特定 (84 行)
│   ├── python.ts                 # Python (53 行)
│   ├── go.ts                     # Go (67 行)
│   ├── rust.ts                   # Rust (116 行)
│   ├── java.ts                   # Java (67 行)
│   ├── c-cpp.ts                  # C/C++ (163 行)
│   ├── csharp.ts                 # C# (68 行)
│   ├── php.ts                    # PHP (105 行)
│   ├── ruby.ts                   # Ruby (111 行)
│   ├── swift.ts                  # Swift (83 行)
│   ├── kotlin.ts                 # Kotlin (244 行)
│   ├── dart.ts                   # Dart (195 行)
│   ├── scala.ts                  # Scala (143 行)
│   ├── lua.ts                    # Lua (152 行)
│   ├── luau.ts                   # Luau (36 行)
│   ├── pascal.ts                 # Pascal (62 行)
│   └── objc.ts                   # Objective-C (136 行)
│
└── extractors/                   # 5 种专用提取器 (非 tree-sitter)
    ├── vue-extractor.ts          # Vue SFC (290 行)
    ├── svelte-extractor.ts       # Svelte (323 行)
    ├── liquid-extractor.ts       # Liquid 模板 (352 行)
    ├── mybatis-extractor.ts      # MyBatis XML (198 行)
    └── dfm-extractor.ts          # Delphi DFM (159 行)
```

---

## 2. 类型适配策略

### 2.1 codegraph → ola-cc 类型映射

| codegraph 类型 | ola-cc 类型 | 适配说明 |
|---------------|------------|---------|
| `Node` (id, kind, name, qualifiedName, filePath, language, startLine, endLine, ...) | `ExtractionNode` (id, kind, name, qualified_name, file, language, line, end_line, ...) | 字段名 snake_case 对齐 GraphStore NodeMetadata |
| `Edge` (source, target, kind, weight?) | `ExtractionEdge` (source, target, type, weight?, sourceLine?) | `kind` → `type` 对齐 GraphStore EdgeType |
| `EdgeKind` (12 种) | `EdgeType` (12+1 种) | 直接映射，`references` → `data` |
| `NodeKind` (22 种) | `NodeKind` (22 种) | 直接对齐 |
| `Language` (28 种) | `Language` (28 种) | 直接对齐 |
| `UnresolvedReference` | `UnresolvedReference` | 直接对齐 |
| `ExtractionError` | `ExtractionError` | 直接对齐 |

### 2.2 ExtractionResult → GraphStore 转换

```typescript
// 提取结果写入 GraphStore 的流程:
function extractionResultToGraphStore(result: ExtractionResult, store: GraphStore): void {
  for (const node of result.nodes) {
    store.addNode({
      id: node.id,
      name: node.name,
      kind: node.kind,
      qualified_name: node.qualified_name,
      file: node.file,
      line: node.line,
      end_line: node.end_line,
      start_column: node.start_column,
      end_column: node.end_column,
      language: node.language,
      signature: node.signature,
      docstring: node.docstring,
      visibility: node.visibility,
      is_exported: node.is_exported,
      is_async: node.is_async,
      is_static: node.is_static,
      updated_at: node.updated_at ?? Date.now(),
      provenance: 'extraction',
    })
  }
  for (const edge of result.edges) {
    store.addEdge(edge.source, edge.target, {
      type: edge.type,
      weight: edge.weight ?? 1.0,
      sourceLine: edge.sourceLine,
      provenance: 'extraction',
    })
  }
}
```

---

## 3. 核心提取器设计 (tree-sitter.ts, 3,242 行)

### 3.1 TreeSitterExtractor 类结构

```typescript
class TreeSitterExtractor {
  private filePath: string
  private language: Language
  private source: string
  private tree: Tree | null = null
  private nodes: ExtractionNode[] = []
  private edges: ExtractionEdge[] = []
  private unresolvedReferences: UnresolvedReference[] = []
  private errors: ExtractionError[] = []
  private extractor: LanguageExtractor | null = null
  private nodeStack: string[] = []

  constructor(filePath: string, source: string, language?: Language)

  // 主入口
  extract(): ExtractionResult

  // 核心遍历
  private visitNode(node: SyntaxNode): void

  // 提取方法 (14 种)
  private extractFunction(node: SyntaxNode, nameOverride?: string): void
  private extractClass(node: SyntaxNode, kind?: NodeKind): void
  private extractMethod(node: SyntaxNode): void
  private extractInterface(node: SyntaxNode): void
  private extractStruct(node: SyntaxNode): void
  private extractEnum(node: SyntaxNode): void
  private extractTypeAlias(node: SyntaxNode): boolean
  private extractProperty(node: SyntaxNode): void
  private extractField(node: SyntaxNode): void
  private extractVariable(node: SyntaxNode): void
  private extractImport(node: SyntaxNode): void
  private extractCall(node: SyntaxNode): void
  private extractInstantiation(node: SyntaxNode): void
  private extractDecoratorsFor(node: SyntaxNode, targetId: string): void

  // 辅助方法
  private createNode(kind: NodeKind, name: string, node: SyntaxNode, extra?: Partial<ExtractionNode>): ExtractionNode | null
  private buildQualifiedName(name: string): string
  private isInsideClassLikeNode(): boolean
  private extractInheritance(node: SyntaxNode, classId: string): void
  private extractTypeAnnotations(node: SyntaxNode, parentId: string): void
  private visitFunctionBody(body: SyntaxNode, functionId: string): void
  private makeExtractorContext(): ExtractorContext
}
```

### 3.2 visitNode 分发逻辑

```
visitNode(node)
  ├── extractor.visitNode (语言特定 hook, 可跳过默认分发)
  ├── Pascal 特殊处理
  ├── functionTypes → extractFunction / extractMethod
  ├── classTypes → extractClass / extractStruct / extractEnum / extractInterface
  ├── extraClassNodeTypes → extractClass
  ├── methodTypes → extractMethod
  ├── interfaceTypes → extractInterface
  ├── structTypes → extractStruct
  ├── enumTypes → extractEnum
  ├── typeAliasTypes → extractTypeAlias
  ├── propertyTypes (在 class 内) → extractProperty
  ├── fieldTypes (在 class 内) → extractField
  ├── variableTypes (顶层) → extractVariable
  ├── importTypes → extractImport
  ├── callTypes → extractCall
  ├── instantiationKinds → extractInstantiation
  ├── impl_item (Rust) → extractRustImplItem
  └── 默认 → 遍历子节点
```

### 3.3 关键移植决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | **直接移植，不重写** | 3,242 行代码经过 codegraph 生产验证，重写引入风险 |
| 2 | **类型适配层在入口** | `extract()` 返回 `ExtractionNode[]`，上层负责转换为 GraphStore |
| 3 | **保留 web-tree-sitter 依赖** | 零依赖原则不适用于基础设施（WASM runtime 是必需的） |
| 4 | **Worker 线程保留在 Z5** | 先单线程验证正确性，再并行化 |
| 5 | **语言提取器逐个移植** | 先 TS/JS/Python（最高频），再 Go/Rust/Java，最后其余 |

---

## 4. 提取编排器设计 (index.ts, 1,550 行)

### 4.1 ExtractionOrchestrator 类结构

```typescript
class ExtractionOrchestrator {
  private db: Database           // bun:sqlite
  private projectRoot: string
  private ignoreFilter: Ignore   // .understandignore / .gitignore

  // 主入口
  async indexAll(options: IndexOptions): Promise<IndexResult>
  async indexFiles(files: string[], options: IndexOptions): Promise<IndexResult>
  async sync(options: SyncOptions): Promise<SyncResult>

  // 内部方法
  private async scanDirectory(dir: string): Promise<string[]>
  private async parseFile(filePath: string): Promise<ExtractionResult>
  private async storeResults(results: ExtractionResult[]): Promise<void>
  private async resolveReferences(): Promise<void>
  private detectLanguage(filePath: string, source: string): Language
  private isSourceFile(filePath: string): boolean
  private shouldIgnore(filePath: string): boolean
}
```

### 4.2 关键参数

| 参数 | 值 | 来源 |
|------|:--:|------|
| MAX_FILE_SIZE | 1MB | 防止 WASM 堆溢出 |
| PARSE_TIMEOUT_MS | 10,000 | 单文件解析超时 |
| FILE_IO_BATCH_SIZE | 10 | 并行文件读取数 |
| WORKER_RECYCLE_INTERVAL | 250 | Worker 回收间隔 |

### 4.3 增量同步流程

```
sync()
  ├── 1. git diff --name-status HEAD~1 → changedFiles[]
  ├── 2. 对每个 changedFile:
  │   ├── a. 读取文件内容 + 计算 SHA256
  │   ├── b. 对比 files 表中的 content_hash
  │   ├── c. 若 hash 不同 → 重新提取
  │   └── d. 若 hash 相同 → 跳过
  ├── 3. 删除 files 表中已不存在的文件记录
  └── 4. 更新 files 表 (content_hash, mtime, size)
```

---

## 5. Worker 线程设计 (parse-worker.ts, 101 行)

### 5.1 Worker 职责

```
Worker 线程:
  ├── 1. 接收文件路径 + 源码 + 语言
  ├── 2. 加载对应 WASM grammar (懒加载)
  ├── 3. 调用 TreeSitterExtractor.extract()
  ├── 4. 返回 ExtractionResult
  └── 5. 每 250 文件回收一次 (防 WASM 内存泄漏)
```

### 5.2 WASM 内存管理

| 机制 | 说明 |
|------|------|
| tree.delete() | 每次解析后立即释放 AST (原生堆内存，V8 GC 不可见) |
| source = '' | 释放源码字符串，减少 GC 压力 |
| Worker 回收 | 每 250 文件终止 Worker + 重新创建 (WASM 线性内存只能增长不能收缩) |
| 超时保护 | 10s 超时后强制重启 Worker |

---

## 6. 语言提取器设计 (languages/*.ts, 2,055 行)

### 6.1 语言覆盖

| # | 语言 | 文件 | 行数 | 复杂度 | 移植优先级 |
|---|------|------|-----:|:------:|:----------:|
| 1 | TypeScript | typescript.ts | 118 | 中 | P0 |
| 2 | JavaScript | javascript.ts | 84 | 低 | P0 |
| 3 | Python | python.ts | 53 | 低 | P0 |
| 4 | Go | go.ts | 67 | 中 | P1 |
| 5 | Rust | rust.ts | 116 | 高 | P1 |
| 6 | Java | java.ts | 67 | 中 | P1 |
| 7 | C/C++ | c-cpp.ts | 163 | 高 | P1 |
| 8 | C# | csharp.ts | 68 | 中 | P2 |
| 9 | PHP | php.ts | 105 | 中 | P2 |
| 10 | Ruby | ruby.ts | 111 | 中 | P2 |
| 11 | Swift | swift.ts | 83 | 中 | P2 |
| 12 | Kotlin | kotlin.ts | 244 | 高 | P2 |
| 13 | Dart | dart.ts | 195 | 高 | P3 |
| 14 | Scala | scala.ts | 143 | 高 | P3 |
| 15 | Lua | lua.ts | 152 | 中 | P3 |
| 16 | Luau | luau.ts | 36 | 低 | P3 |
| 17 | Pascal | pascal.ts | 62 | 高 | P3 |
| 18 | Obj-C | objc.ts | 136 | 高 | P3 |

### 6.2 LanguageExtractor 接口

每种语言实现 `LanguageExtractor` 接口，提供:

| 字段 | 说明 | 示例 (TypeScript) |
|------|------|-------------------|
| functionTypes | 函数 AST 节点类型 | `['function_declaration', 'arrow_function', 'function_expression']` |
| classTypes | 类 AST 节点类型 | `['class_declaration', 'abstract_class_declaration']` |
| methodTypes | 方法 AST 节点类型 | `['method_definition', 'public_field_definition']` |
| interfaceTypes | 接口 AST 节点类型 | `['interface_declaration']` |
| importTypes | 导入 AST 节点类型 | `['import_statement']` |
| callTypes | 调用 AST 节点类型 | `['call_expression']` |
| nameField | 名称字段名 | `'name'` |
| bodyField | 主体字段名 | `'body'` |
| getSignature | 签名提取 hook | `(node, source) => string` |
| getVisibility | 可见性 hook | `(node) => 'public' | 'private' | ...` |
| isExported | 导出检测 hook | `(node, source) => boolean` |

### 6.3 移植策略

1. **Phase Z2 第一批**: TS + JS + Python (3 种, 255 行) — 覆盖 80%+ 项目
2. **Phase Z2 第二批**: Go + Rust + Java + C/C++ (4 种, 413 行) — 覆盖系统编程
3. **Phase Z2 第三批**: C# + PHP + Ruby + Swift + Kotlin (5 种, 531 行) — 覆盖企业/移动
4. **Phase Z3 延期**: Dart + Scala + Lua + Luau + Pascal + ObjC (6 种, 756 行) — 低频语言

---

## 7. 专用提取器设计 (extractors/*.ts, 1,322 行)

### 7.1 Vue SFC 提取器 (290 行)

```
Vue SFC 解析:
  ├── 1. 分离 <script> / <script setup> / <template> 块
  ├── 2. script 块 → 作为 TypeScript 提取
  ├── 3. template 块 → 正则提取组件引用 (kebab→Pascal 转换)
  └── 4. 生成 component 节点 + contains 边
```

### 7.2 Svelte 提取器 (323 行)

```
Svelte 解析:
  ├── 1. 分离 <script> / <script context="module"> 块
  ├── 2. script 块 → 作为 TypeScript 提取
  ├── 3. template 块 → 提取组件引用 + Svelte 5 rune 过滤
  └── 4. 生成 component 节点
```

### 7.3 Liquid 提取器 (352 行)

```
Liquid 解析:
  ├── 1. 提取 {% render 'snippet' %} / {% include 'snippet' %}
  ├── 2. 提取 {% section 'name' %} 引用
  ├── 3. 提取 {% schema %} 块中的 JSON 定义
  └── 4. 生成 route/component 节点
```

### 7.4 MyBatis 提取器 (198 行)

```
MyBatis XML 解析:
  ├── 1. 解析 <mapper namespace="..."> → 接口桥接
  ├── 2. 提取 <select>/<insert>/<update>/<delete> → SQL 语句节点
  ├── 3. 提取 <resultMap> / <sql> 片段
  └── 4. 生成 namespace→interface 桥接边
```

### 7.5 DFM 提取器 (159 行)

```
Delphi DFM 解析:
  ├── 1. 解析 object/end 块 → 组件节点
  ├── 2. 提取 OnClick/OnChange 等事件绑定
  └── 3. 生成 component 节点 + calls 边 (事件→处理函数)
```

---

## 8. 验收条件

### Phase Z1 验收

- [ ] `tree-sitter-types.ts` 导出 `LanguageExtractor` 接口，与 codegraph 完全对齐
- [ ] `tree-sitter-helpers.ts` 导出 `generateNodeId`/`getNodeText`/`getChildByField`/`getPrecedingDocstring`
- [ ] `grammars.ts` 支持 21 种 WASM grammar 懒加载
- [ ] bun:compile 模式下 WASM 加载成功
- [ ] 对 TypeScript 源文件执行 `getParser('typescript')` 返回有效 parser

### Phase Z2 验收

- [ ] `TreeSitterExtractor.extract()` 对 TS/JS/Python 源文件返回正确节点和边
- [ ] 提取结果包含 function/class/method/interface/enum/import/call 节点
- [ ] 提取结果包含 contains/calls/imports/extends/implements 边
- [ ] `ExtractionOrchestrator.indexAll()` 对 100 文件项目 <5s
- [ ] 增量同步 `sync()` 仅处理变更文件
- [ ] 所有现有 GraphEngine 测试通过（不因 extraction 引入回归）

### Phase Z3 验收

- [ ] Vue SFC 项目正确提取 `<script>` 中的符号 + `<template>` 中的组件引用
- [ ] Svelte 项目正确提取组件引用（含 Svelte 5 rune 过滤）
- [ ] Liquid 模板正确提取 render/include/section 引用
- [ ] MyBatis XML 正确提取 SQL 语句节点 + namespace→interface 桥接
- [ ] DFM 正确提取组件节点 + 事件绑定边

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| web-tree-sitter WASM bun:compile 不兼容 | 全部 extraction 阻塞 | Z1 spike 验证，备选: 独立进程 + IPC |
| 3,242 行移植复杂度超预期 | Z2 延期 | 分批移植 (先 TS/JS/Python)，按语言分 PR |
| WASM 内存泄漏 | 大项目 OOM | Worker 每 250 文件回收 + tree.delete() |
| 语言提取器 grammar 特定 bug | 提取错误 | 每种语言一个独立 PR + 测试 |
| 专用提取器正则脆弱 | 模板解析错误 | 降级为 file 级节点（无符号提取） |

---

## 10. 与 codegraph 的差异

| 维度 | codegraph | ola-cc extraction | 说明 |
|------|-----------|-------------------|------|
| 存储目标 | SQLite (5 表, 17 索引) | GraphStore (内存图) + SQLite (持久化) | ola-cc 需同时写入 GraphStore |
| 类型系统 | `Node` + `Edge` (camelCase) | `ExtractionNode` + `ExtractionEdge` (snake_case) | 对齐 GraphStore |
| Worker 管理 | 主进程管理 Worker 生命周期 | 同 | 直接移植 |
| 框架 Resolver | 21 个 Resolver (Phase 6c) | Phase 6c 独立移植 | extraction 不含 Resolver |
| callback-synthesizer | 14 阶段 (Phase 6b) | Phase 6b 独立移植 | extraction 不含 synthesizer |
| 进度回调 | stderr 解析 | 直接回调 (`_onProgress`) | ola-cc 优势 |
| 错误处理 | 抛出 + 捕获 | 结构化 `ExtractionError[]` | 对齐 GraphStore |
