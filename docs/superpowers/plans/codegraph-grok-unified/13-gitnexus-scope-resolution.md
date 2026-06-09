# GitNexus 作用域解析 + 预计算关系智能迁移设计

> 日期: 2026-06-05
> 来源: /tmp/GitNexus (355,838 行, 1536 文件)
> Phase: Z2 (Scope 基础) + Z4 (Scope 完整 + 预计算) + 6c (语言 provider)
> 总工期: 8 天

---

## 1. 迁移范围评估

### 1.1 GitNexus 能力分级

| # | 能力 | 代码量 | ola-cc 现状 | 移植决策 | 理由 |
|---|------|:------:|-----------|:--------:|------|
| 1 | **Scope Resolution Pipeline** | 7,768 行 | 无 (仅基础 qualifiedName) | ✅ 移植 | 核心差距，解决 `a.b.c.method()` 解析 |
| 2 | **SemanticModel 三层注册表** | ~2,000 行 | 无 | ✅ 移植 | Scope 的基础设施 |
| 3 | **Import Resolver Factory** | 1,124 行 (12 语言) | 无 | ✅ 移植 | 跨文件符号解析必需 |
| 4 | **Entry Point Scoring** | 240 行 | 无 | ✅ 移植 | 执行流检测增强 |
| 5 | **12-Stage DAG Runner** | ~800 行 | 无 | ✅ 移植 | 提取编排架构升级 |
| 6 | **Graph Bridge** | ~500 行 | 基础边发射 | ✅ 移植 | Reference→Edge 映射 |
| 7 | **Community Detection** | ~300 行 | Phase 3c Leiden | ⚠️ 合并 | 与 Phase 3c Leiden 合并 |
| 8 | **Process Detection** | ~400 行 | F-83 执行流 | ⚠️ 合并 | 与 F-83 合并 |
| 9 | **Hybrid Search** | ~400 行 | FTS5+BM25+RRF | ⚠️ 合并 | 与 Phase Z3 RRF 合并 |
| 10 | **Cross-Repo Impact** | 653 行 | 无 | ❌ 不移植 | 当前无多仓库需求 |
| 11 | **16 语言 Scope Provider** | 3,404 行 | 无 | ✅ 分批移植 | 与 extraction 语言优先级对齐 |
| 12 | **MCP Server** | ~2,000 行 | 已删除 (F-90) | ❌ 不移植 | ola-cc 本身是 agent |
| 13 | **Web UI** | 25,157 行 | Dashboard 设计 | ❌ 不移植 | 已有 Dashboard 方案 |
| 14 | **LadybugDB** | ~1,000 行 | SQLite (bun:sqlite) | ❌ 不移植 | SQLite 已满足 |

### 1.2 移植总量

| 类别 | 行数 | 说明 |
|------|-----:|------|
| Scope Resolution 核心 | 3,236 | contract + passes + graph-bridge + pipeline |
| SemanticModel + Registries | 2,000 | 三层注册表 + SymbolTable |
| Import Resolver (12 语言) | 1,124 | 策略链 factory + configs |
| Entry Point Scoring | 240 | 4 因子公式 + 17 框架检测 |
| DAG Runner | 800 | Kahn 拓扑排序 + phase 管理 |
| Graph Bridge | 500 | Reference→Edge + 去重 |
| 16 语言 Scope Provider | 3,404 | 每语言 ~213 行 |
| **总计** | **~11,304** | |

---

## 2. Scope Resolution 系统设计

### 2.1 架构总览

```
src/services/graph/scope-resolution/
├── contract/
│   └── scope-resolver.ts          # ScopeResolver 接口 (9 必需 + 20+ 可选 hooks)
├── pipeline/
│   ├── run.ts                     # 编排器 (4 阶段: extract → finalize → resolve → emit)
│   ├── registry.ts                # SCOPE_RESOLVERS Map (16 语言注册表)
│   └── reconcile-ownership.ts     # 所有权协调 (Python class-body methods)
├── model/
│   ├── semantic-model.ts          # 三层注册表 (Type/Method/Field + SymbolTable)
│   ├── scope-resolution-indexes.ts # 预计算索引束 (16 种索引)
│   └── workspace-index.ts         # O(1) classScopeByDefId / moduleScopeByFile
├── passes/
│   ├── receiver-bound-calls.ts    # 7-case receiver 分发器 (1108 行)
│   ├── free-call-fallback.ts      # 全局 callable fallback + ADL (793 行)
│   ├── compound-receiver.ts       # 链式 receiver: a.b.c.method() (568 行)
│   ├── overload-narrowing.ts      # 重载候选筛选 (508 行)
│   ├── imported-return-types.ts   # SCC 逆拓扑序跨文件返回类型传播 (238 行)
│   └── mro.ts                     # MRO 辅助 (110 行)
├── graph-bridge/
│   ├── edges.ts                   # Reference.kind → EdgeType 映射
│   ├── references-to-edges.ts     # ReferenceIndex → graph edges
│   └── imports-to-edges.ts        # ImportEdge → File→File IMPORTS 边
├── scope/
│   ├── walkers.ts                 # 作用域链遍历
│   └── namespace-targets.ts       # namespace 目标收集
└── resolvers/                     # 16 种语言 scope-resolver
    ├── typescript.ts
    ├── python.ts
    ├── go.ts
    ├── java.ts
    ├── rust.ts
    ├── c-cpp.ts
    ├── csharp.ts
    ├── php.ts
    ├── ruby.ts
    ├── swift.ts
    ├── kotlin.ts
    ├── dart.ts
    ├── vue.ts
    ├── scala.ts
    ├── lua.ts
    └── objc.ts
```

### 2.2 ScopeResolver 接口

```typescript
interface ScopeResolver {
  // === 9 必需字段 ===
  language: Language
  languageProvider: LanguageProvider
  importEdgeReason: string

  resolveImportTarget(
    targetRaw: string, fromFile: string,
    allFiles: Map<string, string>, config: ProjectConfig
  ): string | null

  mergeBindings(
    existing: BindingRef[], incoming: BindingRef[],
    scopeId: string
  ): BindingRef[]

  arityCompatibility(callsite: ArityInfo, def: ArityInfo): ArityResult

  buildMro(
    graph: KnowledgeGraph, parsedFiles: ParsedFile[],
    nodeLookup: NodeLookupIndex
  ): Map<string, string[]>

  populateOwners(parsed: ParsedFile): void

  isSuperReceiver(receiverText: string): boolean

  // === 20+ 可选 hooks (按需实现) ===
  emitHeritageEdges?(): void              // Ruby include/extend
  emitImplicitImportEdges?(): void        // Swift 同模块隐式可见性
  emitPostResolutionEdges?(): void        // Vue 模板派生边
  emitUnresolvedReceiverEdges?(): void    // 动态语言 untyped receiver
  detectInterfaceImplementations?(): void // Go 结构化接口
  populateNamespaceSiblings?(): void      // C# namespace 跨文件可见性
  mirrorNamespaceTypeBindings?(): void    // Go 跨包 typeBinding
  populateRangeBindings?(): void          // Go for-range 变量
  collectScopeContextPaths?(): void       // Vue TS/JS import 闭包
  resolveAdlCandidates?(): void           // C++ ADL (Koenig lookup)
  resolveQualifiedReceiverMember?(): void // C++ inline namespace
  isSuperReceiverInContext?(): void       // C++ context-aware super
  isFileLocalDef?(): void                 // C static 函数过滤
  isCallableVisibleFromCaller?(): void    // PHP namespace 可见性门控
  isStaticOnly?(): void                   // Kotlin companion object
  conversionRankFn?(): void               // C++ 重载转换排序
  constraintCompatibility?(): void        // C++ SFINAE/requires
}
```

### 2.3 4 阶段 Pipeline

```
Phase 1: Extract (per file)
  ├── tree-sitter AST → ScopeCapture[]
  ├── populateOwners() → 填充 deferred ownerId
  └── SymbolTable.add() → 扇出到 TypeRegistry/MethodRegistry/FieldRegistry

Phase 2: Finalize (cross-file)
  ├── buildMethodRegistry / buildClassRegistry / buildFieldRegistry
  ├── reconcileOwnership() → Python class-body methods 修正
  ├── finalizeScopeModel() → 生成 ScopeResolutionIndexes (16 种索引)
  └── 冻结 SemanticModel (readonly)

Phase 3: Resolve (reference resolution)
  ├── resolveReferenceSites() → 按 kind 路由到 Registry
  │   ├── call / inherits → MethodRegistry.lookup / ClassRegistry.lookup
  │   ├── read / write → FieldRegistry.lookup
  │   ├── type-reference → ClassRegistry.lookup
  │   └── import-use → 全部三个
  └── 输出 ReferenceIndex (bySourceScope + byTargetDef)

Phase 4: Emit (graph edges)
  ├── emitReceiverBoundCalls() — 7-case receiver 分发 (FIRST)
  │   ├── super receiver → 父类方法
  │   ├── compound receiver → a.b.c.method() 链式解析
  │   ├── namespace receiver → namespace 内查找
  │   ├── class-name receiver → 静态方法调用
  │   ├── dotted-typeBinding receiver → 类型绑定链
  │   ├── chain-typeBinding receiver → 链式类型绑定
  │   ├── simple-typeBinding receiver → 简单类型绑定
  │   └── value-receiver → 值类型 receiver
  ├── emitFreeCallFallback() — 全局 callable fallback (THEN)
  │   ├── ADL (C++ Koenig lookup)
  │   └── overload narrowing (arity + type + constraint)
  ├── emitReferencesViaLookup() — 剩余 reference (LAST)
  └── emitImportEdges() — Import 边发射
```

### 2.4 与现有 tree-sitter 提取器的关系

| 维度 | tree-sitter 提取器 | Scope Resolution | 关系 |
|------|-------------------|-----------------|------|
| 输入 | 源码文件 | tree-sitter AST + 符号表 | 串行: extraction → scope |
| 输出 | 节点 + 边 (粗粒度) | 精确的 CALLS/ACCESSES/INHERITS/USES 边 | 互补 |
| `a.b.c.method()` | 只识别 `method()` 调用 | 精确解析到目标类方法 | **Scope 替代** |
| 跨文件符号 | 无 (仅 import 边) | 完整跨文件解析 | **Scope 新增** |
| 重载解析 | 无 | arity + type + constraint | **Scope 新增** |
| MRO | 无 | C3 / first-wins / ruby-mixin | **Scope 新增** |

**集成策略**: tree-sitter 提取器生成粗粒度图，Scope Resolution 在其上精化边。

---

## 3. SemanticModel 设计

### 3.1 三层注册表

```typescript
class SemanticModel {
  readonly types: TypeRegistry      // 类/接口/结构体
  readonly methods: MethodRegistry  // 函数/方法
  readonly fields: FieldRegistry    // 属性/字段/变量
  readonly symbols: SymbolTable     // 统一符号表 (file + callable indexes)

  // 写入阶段 (Phase 1: parse)
  addSymbol(def: SymbolDefinition): void {
    this.symbols.add(def)
    // 扇出到三个 registry
    if (def.kind === 'class' || def.kind === 'interface' || def.kind === 'struct')
      this.types.register(def)
    if (def.kind === 'function' || def.kind === 'method')
      this.methods.register(def)
    if (def.kind === 'field' || def.kind === 'property' || def.kind === 'variable')
      this.fields.register(def)
  }

  // 所有权修正 (Phase 2: scope-resolution)
  reconcileOwnership(defId: string, newOwnerId: string): void { ... }

  // 冻结 (Phase 2 finalize)
  attachScopeIndexes(indexes: ScopeResolutionIndexes): void { ... }

  // 读取阶段 (Phase 3+)
  lookup(kind: 'type' | 'method' | 'field', name: string, scope?: ScopeId): SymbolDefinition[] { ... }
}
```

### 3.2 ScopeResolutionIndexes (16 种索引)

```typescript
interface ScopeResolutionIndexes {
  scopeTree: ScopeTree                              // ScopeId → Scope
  defs: DefIndex                                    // DefId → SymbolDefinition
  qualifiedNames: QualifiedNameIndex                // 限定名查找
  moduleScopes: ModuleScopeIndex                    // 文件 → 模块 scope
  methodDispatch: MethodDispatchIndex               // MRO + implements 物化视图
  imports: Map<ScopeId, ImportEdge[]>               // 每模块 finalized import 边
  bindings: Map<ScopeId, Map<string, BindingRef[]>> // finalize-output 绑定 (冻结)
  bindingAugmentations: Map<ScopeId, Map<string, BindingRef[]>> // 后 finalize 追加 (可变)
  workspaceFqnBindings: Map<string, BindingRef[]>   // 全局 FQN 绑定
  workspaceTypeBindings: Map<string, TypeRef>       // 全局类型绑定
  namespaceFqnBindings: Map<string, Map<string, BindingRef[]>>
  namespaceTypeBindings: Map<string, Map<string, TypeRef>>
  accessibleNamespacesByScope: Map<ScopeId, string[]>
  referenceSites: ReferenceSite[]                   // 预解析使用事实
  sccs: FinalizedScc[]                              // 文件级 import 图 SCC 凝结
  stats: FinalizeStats
}
```

### 3.3 写入/读取阶段契约

```
Phase 1 (parse):        symbolTable.add() → 写入 types/methods/fields
Phase 2 (scope-res):    reconcileOwnership() → 修正 ownerId
Phase 2 (finalize):     attachScopeIndexes() → 冻结
Phase 3+ (resolve/emit): readonly → 任何写操作是类型错误
```

---

## 4. Import Resolver 设计

### 4.1 Factory 模式

```typescript
type ImportResolverFn = (
  rawImportPath: string,
  filePath: string,
  ctx: ImportResolutionContext
) => string | null

function createImportResolver(config: ImportResolutionConfig): ImportResolverFn {
  const { strategies } = config
  return (rawImportPath, filePath, ctx) => {
    for (const strategy of strategies) {
      const result = strategy(rawImportPath, filePath, ctx)
      if (result) return result
    }
    return null
  }
}
```

### 4.2 12 种语言配置

| 语言 | 策略链 |
|------|--------|
| TypeScript/JavaScript | node_modules, tsconfig paths, relative, index files |
| Python | relative, package, sys.path, namespace |
| Go | go.mod module path |
| Java/Kotlin | classpath, maven/gradle |
| Rust | cargo workspace, mod.rs |
| C# | namespace, project references |
| PHP | composer.json autoload |
| Ruby | gem paths, bundler |
| C/C++ | include paths, header search |
| Swift | SPM targets, implicit imports |
| Dart | package: URI, relative |

### 4.3 统一 3 层解析算法

| 层 | 置信度 | 机制 |
|---|:------:|------|
| Tier 1 — 同文件 | 0.95 | 调用者文件的符号表 |
| Tier 2 — import 范围 | 0.9 | NamedImportMap 链 (named) 或 importMap 全部文件 (wildcard) |
| Tier 3 — 全局 | 0.5 | O(1) 索引查找: class, impl, callable。仅 fallback |

| Import 策略 | 语言 | 行为 |
|---|---|---|
| `named` | TS, JS, Java, C#, Rust, PHP, Kotlin | 仅显式导入的名称可见 |
| `wildcard-leaf` | Go, Ruby, Swift, Dart | 整包导入，无传递重导出 |
| `wildcard-transitive` | C, C++ | `#include` 闭包链穿过重导出 |
| `namespace` | Python | 模块别名在调用点解析 |

---

## 5. Entry Point Scoring 设计

### 5.1 评分公式

```
finalScore = baseScore × exportMultiplier × nameMultiplier × frameworkMultiplier
```

| 因子 | 计算 | 值域 |
|------|------|:----:|
| `baseScore` | `calleeCount / (callerCount + 1)` | 0 ~ ∞ |
| `exportMultiplier` | exported ? 2.0 : 1.0 | 1.0 ~ 2.0 |
| `nameMultiplier` | utility 模式 → 0.3; entry 模式 → 1.5; 否则 1.0 | 0.3 ~ 1.5 |
| `frameworkMultiplier` | `detectFrameworkFromPath(filePath)` | 1.0 ~ 3.0 |

**前置条件**: `calleeCount === 0` → score = 0 (必须有出调用才能成为入口)

### 5.2 名称模式

**正向模式** (13 个 + 每语言自定义):
- `main/init/bootstrap/start/run/setup/configure`
- `handle*`, `on*`, `*Handler`, `*Controller`
- `process*`, `execute*`, `perform*`, `dispatch*`, `trigger*`, `fire*`, `emit*`

**负向模式** (17 个):
- `get/set/is/has/can/should/will/did*` — accessor/predicate
- `_` 前缀 — 私有约定
- `format/parse/validate/convert/transform*`
- `*Helper`, `*Util`, `*Utils`

### 5.3 框架检测

| 框架 | 文件路径模式 | multiplier |
|------|------------|:----------:|
| Next.js Pages | `/pages/*.tsx` | 3.0 |
| Next.js App | `/app/**/page.tsx` | 3.0 |
| Next.js API | `/pages/api/` 或 `/app/**/route.ts` | 3.0 |
| Express | `app.get/post/put/delete` | 2.5 |
| Django | `views.py` | 2.5 |
| FastAPI | `@app.get/post` | 2.5 |
| Laravel | `routes/web.php` | 2.5 |
| Rails | `config/routes.rb` | 2.5 |
| Spring | `@RestController` | 2.5 |

---

## 6. DAG Pipeline Runner 设计

### 6.1 Phase 注册

```typescript
interface PhaseDefinition<T = unknown> {
  name: string
  deps: string[]           // 声明式依赖 (Kahn 拓扑排序)
  run: (ctx: PhaseContext) => Promise<T>
}

// 注册
pipeline.register({ name: 'scan', deps: [], run: scanPhase })
pipeline.register({ name: 'structure', deps: ['scan'], run: structurePhase })
pipeline.register({ name: 'parse', deps: ['structure'], run: parsePhase })
pipeline.register({ name: 'scopeResolution', deps: ['parse', 'crossFile'], run: scopePhase })
// ...
```

### 6.2 ola-cc 适配的 Phase 管线

```
scan → structure → parse (tree-sitter extraction)
  → crossFile (拓扑序跨文件类型传播)
  → scopeResolution (精确符号解析)
  → mro (方法解析顺序)
  → communities (Leiden 社区检测)
  → processes (执行流检测)
  → persist (写入 GraphStore + SQLite)
```

### 6.3 与现有 ExtractionOrchestrator 的关系

| 维度 | ExtractionOrchestrator | DAG Pipeline Runner |
|------|----------------------|-------------------|
| 职责 | 文件扫描 + 提取 + 存储 | Phase 编排 + 依赖管理 |
| 依赖管理 | 隐式 (硬编码顺序) | 显式 (Kahn 拓扑排序) |
| 类型安全 | 无 | `getPhaseOutput<T>(deps, 'name')` |
| 单图累加器 | 无 (每个文件独立) | 共享 KnowledgeGraph |
| 循环检测 | 无 | DFS 找出具体循环路径 |

**集成策略**: ExtractionOrchestrator 改用 DAG Runner 作为编排内核。

---

## 7. Graph Bridge 设计

### 7.1 Reference.kind → EdgeType 映射

```typescript
function mapReferenceKindToEdgeType(kind: ReferenceKind): EdgeType {
  switch (kind) {
    case 'call':         return 'calls'
    case 'read':
    case 'write':        return 'data'       // ola-cc 用 'data' 代替 'ACCESSES'
    case 'inherits':     return 'inherits'
    case 'type-reference': return 'type_of'  // ola-cc 用 'type_of' 代替 'USES'
    case 'macro':        return 'type_of'
    case 'import-use':   return 'imports'    // provenance on IMPORTS edge
    default:             return 'control'    // fallback
  }
}
```

### 7.2 去重机制

```typescript
function tryEmitEdge(
  edges: Edge[],
  seen: Set<string>,
  from: string, to: string,
  type: EdgeType,
  line?: number, col?: number
): boolean {
  const key = `${type}:${from}->${to}:${line ?? 0}:${col ?? 0}`
  if (seen.has(key)) return false
  seen.add(key)
  edges.push({ source: from, target: to, type, sourceLine: line })
  return true
}
```

### 7.3 7-case Receiver 分发器

这是 Scope Resolution 最复杂的 pass (1108 行):

```
emitReceiverBoundCalls(receiver, callSite)
  ├── 1. super receiver → 父类方法查找
  ├── 2. compound receiver → a.b.c.method() 链式解析
  │   ├── 解析 a → 类型 A
  │   ├── 解析 a.b → 类型 B
  │   ├── 解析 a.b.c → 类型 C
  │   └── 查找 C.method()
  ├── 3. namespace receiver → namespace 内查找
  ├── 4. class-name receiver → 静态方法调用
  ├── 5. dotted-typeBinding receiver → 类型绑定链
  ├── 6. chain-typeBinding receiver → 链式类型绑定
  ├── 7. simple-typeBinding receiver → 简单类型绑定
  └── 8. value-receiver → 值类型 receiver
```

---

## 8. 分阶段实施

### Phase Z2: Scope Resolution 基础 (2 天新增)

| 任务 | 天数 | 依赖 | 说明 |
|------|:----:|------|------|
| SemanticModel 三层注册表 | 0.5 | F-72 | TypeRegistry + MethodRegistry + FieldRegistry + SymbolTable |
| ScopeResolver 接口 + contract | 0.5 | — | 9 必需 + 20 可选 hooks |
| 4 阶段 Pipeline 编排器 | 0.5 | — | extract → finalize → resolve → emit |
| TS/JS/Python scope-resolver | 0.5 | 上述 | 最高频 3 种语言 |

### Phase Z4: Scope Resolution 完整 (2 天新增)

| 任务 | 天数 | 依赖 | 说明 |
|------|:----:|------|------|
| 7-case receiver 分发器 | 0.5 | Z2 | receiver-bound-calls pass |
| Import Resolver Factory (12 语言) | 0.5 | Z2 | 策略链 + 3 层解析 |
| Entry Point Scoring | 0.5 | Z2 | 4 因子公式 + 框架检测 |
| DAG Pipeline Runner | 0.5 | Z2 | 替换 ExtractionOrchestrator 编排 |

### Phase 6c: 语言 Scope Provider (4 天新增)

| 批次 | 语言 | 行数 | 天数 |
|------|------|-----:|:----:|
| 第一批 | Go, Rust, Java, C/C++ | 859 | 1 |
| 第二批 | C#, PHP, Ruby, Swift, Kotlin | 920 | 1 |
| 第三批 | Dart, Scala, Lua, ObjC, Vue | 1,625 | 2 |

---

## 9. 验收条件

### Phase Z2 验收

- [ ] SemanticModel 注册表支持 Type/Method/Field 三种符号
- [ ] ScopeResolver 接口定义完整 (9 必需字段)
- [ ] 4 阶段 Pipeline 编排器运行正确
- [ ] TS/JS/Python scope-resolver 能解析基本的跨文件调用

### Phase Z4 验收

- [ ] 7-case receiver 分发器覆盖 super/compound/namespace/class-name
- [ ] Import Resolver 支持 12 种语言的策略链
- [ ] `a.b.c.method()` 复合接收者调用正确解析到目标方法
- [ ] Entry Point Scoring 对 Next.js/Express/Django 项目正确识别入口
- [ ] DAG Runner 替换 ExtractionOrchestrator 后所有现有测试通过

### Phase 6c 验收

- [ ] 16 种语言 scope-resolver 全部通过集成测试
- [ ] Go 结构化接口实现检测正确
- [ ] Python C3 线性化 MRO 正确
- [ ] Ruby mixin-aware 线性化正确
- [ ] C++ ADL (Koenig lookup) 正确

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 11,304 行移植复杂度 | Z2/Z4 延期 | 分批移植: 先核心 pipeline (3,236 行), 再语言 provider |
| Scope 与 tree-sitter 边冲突 | 重复/矛盾边 | Scope 精化策略: 有 Scope 边时替换 tree-sitter 粗粒度边 |
| MRO 实现语言差异大 | 每语言独立逻辑 | 先 first-wins (简单), 再 C3 (Python), 最后 ruby-mixin |
| 跨文件符号解析内存增长 | 大项目 OOM | SemanticModel 冻结 + LRU scope 缓存 |
| 16 语言 provider 维护成本 | 持续更新 | 接口隔离，每语言独立 PR + 测试 |

---

## 11. 与现有设计的整合

### 11.1 更新后的模块结构

```
src/services/graph/
├── GraphEngine.ts              # 15 种图算法
├── GraphStore.ts               # 双数据源适配器
├── IncrementalSync.ts          # 三级增量同步
├── OperationRouter.ts          # 智能 operation 推荐
├── StructuralFingerprint.ts    # 结构指纹
├── ChangeClassifier.ts         # 变更分类器
├── GraphValidator.ts           # 图验证 9 项
├── DomainAnalyzer.ts           # 领域分析三层模型
├── ProcessDetector.ts          # 执行流检测 [GitNexus 增强]
├── EntryPointScorer.ts         # [新增] 入口点评分 (GitNexus)
│
├── scope-resolution/           # [新增] Scope Resolution 系统 (~6,000 行)
│   ├── contract/               #   ScopeResolver 接口
│   ├── pipeline/               #   4 阶段编排器
│   ├── model/                  #   SemanticModel + 索引
│   ├── passes/                 #   6 个解析 pass
│   ├── graph-bridge/           #   Reference→Edge 映射
│   └── resolvers/              #   16 语言 scope-resolver
│
├── extraction/                 # tree-sitter 提取系统
│   ├── index.ts                #   ExtractionOrchestrator (改用 DAG Runner)
│   ├── tree-sitter.ts          #   核心提取器
│   └── ...
│
└── parsers/                    # 非代码解析器
```

### 11.2 数据流 (更新后)

```
源码文件 → tree-sitter 提取 (粗粒度图)
                │
                ▼
        Scope Resolution (精化边)
        ├── SemanticModel 注册表
        ├── Import Resolver (12 语言)
        ├── 7-case Receiver 分发
        ├── Overload Narrowing
        └── MRO 解析
                │
                ▼
        Entry Point Scoring (4 因子)
                │
                ▼
        Process Detection (BFS 追踪)
                │
                ▼
        Community Detection (Leiden)
                │
                ▼
        GraphStore (持久化)
```

### 11.3 工期更新

| 原 Phase | 原天数 | 新增 | 更新后 |
|----------|:------:|:----:|:------:|
| Phase Z2 | 4 | +2 | **6** |
| Phase Z4 | 7 | +2 | **9** |
| Phase 6c | 10 | +4 | **14** |
| **总计** | — | **+8** | — |

**总工期**: 78.5d + 8d = **86.5 天**
