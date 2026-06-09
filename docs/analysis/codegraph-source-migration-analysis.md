# CodeGraph 源码深度分析与代码移植方案

> 日期: 2026-06-05
> 分析范围: codegraph v0.9.6 编译源码 (`node_modules/@colbymchenry/codegraph-darwin-arm64/lib/dist/`)
> 目标: 6 项 codegraph 能力的代码级移植到 ola-cc

---

## 一、EdgeKind 完整映射 (types.d.ts)

### 12 种 EdgeKind 定义

| # | EdgeKind | 语义 | GraphStore 映射 | 状态 |
|---|----------|------|----------------|:----:|
| 1 | `contains` | 层级包含 (文件→类→方法) | `contains` | ✅ 已映射 |
| 2 | `calls` | 函数/方法调用 | `calls` | ✅ 已映射 |
| 3 | `imports` | 模块导入 | `imports` | ✅ 已映射 |
| 4 | `exports` | 模块导出 | `control` (降级) | ❌ 未映射 |
| 5 | `extends` | 类/接口继承 | `inherits` | ✅ 已映射 |
| 6 | `implements` | 接口实现 | `implements` | ✅ 已映射 |
| 7 | `references` | 泛化引用 (变量/类型/装饰器) | `data` | ✅ 已映射 |
| 8 | `type_of` | 变量/参数类型声明 | `control` (降级) | ❌ 未映射 |
| 9 | `returns` | 函数返回类型 | `control` (降级) | ❌ 未映射 |
| 10 | `instantiates` | `new Foo()` 实例化 | `calls` (语义降级) | ⚠️ 降级映射 |
| 11 | `overrides` | 子类方法覆写 | `control` (降级) | ❌ 未映射 |
| 12 | `decorates` | 装饰器/注解应用 | `control` (降级) | ❌ 未映射 |

**统计**: 5 精确映射 + 1 降级映射 + 6 未映射 = 50% 语义损失

### 语义损失分析

| 丢失的 EdgeKind | 影响 |
|----------------|------|
| `exports` | 无法追踪模块公开 API 表面 |
| `type_of` | 无法做类型依赖分析 (如"哪些变量使用了某类型") |
| `returns` | 无法构建返回类型图 (如"哪些函数返回 Promise") |
| `overrides` | 多态分析、虚方法调用链不可用 |
| `decorates` | 无法追踪装饰器影响范围 (如 `@auth` 保护的路由) |

### 移植方案: 扩展 GraphStore 规范边类型

**当前**: 7 种规范类型 (calls/imports/data/control/inherits/implements/contains)
**目标**: 12 种规范类型 (+ exports/type_of/returns/overrides/decorates)

```typescript
// GraphStore.ts 扩展映射
const CODEGRAPH_EDGE_MAP: Record<string, EdgeMeta['type']> = {
  contains: 'contains',
  calls: 'calls',
  imports: 'imports',
  exports: 'exports',       // 新增
  extends: 'inherits',
  implements: 'implements',
  references: 'data',
  type_of: 'type_of',       // 新增
  returns: 'returns',       // 新增
  instantiates: 'instantiates', // 从 calls 升级
  overrides: 'overrides',   // 新增
  decorates: 'decorates',   // 新增
}
```

**复杂度**: 低 (~30 行修改)
**风险**: 需确认所有图算法能处理新边类型 (多数算法不区分类型)

### EdgeKind 生成状态 (源码验证)

**验证方法**: 追踪 `/tmp/codegraph/src/extraction/tree-sitter.ts` 中所有 `unresolvedReferences.push()` 调用的 `referenceKind` 值，以及 `resolution/index.ts:createEdges()` 中 `ref.original.referenceKind` → `edge.kind` 的传递逻辑。

#### 提取器实际生成的 referenceKind (5 种)

| referenceKind | 生成位置 | 说明 |
|:---:|---------|------|
| `imports` | tree-sitter.ts:1617, 1668 | import 语句 (`import X from 'Y'`, `require('Y')`) |
| `calls` | tree-sitter.ts:1863, 2138 | 函数/方法调用 (`foo()`, `obj.method()`) |
| `instantiates` | tree-sitter.ts:1914 | 实例化 (`new Foo()`) |
| `extends` | tree-sitter.ts:1978, 2208 | 类继承 (`class B extends A`) |
| `decorates` | **tree-sitter.ts:2050** | **装饰器应用 (`@Controller()`, `@Injectable()`) — 已实现** |

> **纠正**: 原分析误判 `decorates` 为"未生成"。实际上 `extractDecoratorsFor()` 方法在 tree-sitter.ts:2050 生成 `referenceKind: 'decorates'` 的 unresolved reference，经 `name-matcher.ts:620` 的装饰器优先评分逻辑解析后持久化为 `kind: 'decorates'` 边。DB 中 0 条记录是因为 ola-cc 测试项目无装饰器，非上游缺失。

#### EdgeKind 类型定义存在但提取器不生成的种类 (4 种)

| EdgeKind | 状态 | 原因 |
|:---:|:---:|------|
| `type_of` | ❌ 提取器不生成 | `extractTypeAnnotations()` 将类型注解统一生成为 `references` 边 (设计选择，非缺失) |
| `returns` | ❌ 提取器不生成 | 同上，返回类型也被归为 `references` 边 |
| `overrides` | ❌ 提取器不生成 | 子类方法覆写边从未被创建 (C++ override 由 callback-synthesizer Phase 4 合成为 `calls` 边) |
| `exports` | ❌ 提取器不生成 | 模块导出边从未被创建 (context/index.ts:1320 仅查询用) |

#### 设计分析: `type_of`/`returns` 为何归为 `references`

`extractTypeAnnotations()` (tree-sitter.ts:2570) 的设计意图是将所有类型引用统一为 `references` 边，而非细分为 `type_of`/`returns`。这意味着：
- `x: string` → 生成 `references` 边 (x → string)，而非 `type_of`
- `function foo(): Promise<void>` → 生成 `references` 边 (foo → Promise)，而非 `returns`
- 图算法层面：`references` 边已包含类型依赖信息，`type_of`/`returns` 的语义区分在当前实现中不存在

**结论**: 在 GraphStore 中添加 `type_of`/`returns` 映射无实际意义 — codegraph 源码不生成这两种 kind 的边。

#### 可自行实现的子集 (仅 2 种)

| EdgeKind | 实现方案 | 复杂度 | 优先级 |
|----------|---------|:------:|:------:|
| `exports` | 扩展 Phase 6e 的 `extractReExports`，生成 `exports` 边 | 低 | P2 |
| `overrides` | 遍历 `extends` 边 → 查找子类/基类同名方法 → 生成 `overrides` 边 (参考 callback-synthesizer Phase 4 逻辑) | 中 | P2 |

> `decorates` 无需自行实现 — codegraph 已实现，有装饰器的项目会自动生成。
> `type_of`/`returns` 无需自行实现 — codegraph 设计上用 `references` 覆盖这两种语义。

### 上游未暴露的 NodeKind (5 种)

CodeGraph 定义 22 种 NodeKind，但 ola-cc 的 GraphStore 仅处理 17 种。以下 5 种在 codegraph DB 中可能存在但 ola-cc 未显式处理:

| NodeKind | 说明 | ola-cc 处理 | 影响 |
|----------|------|:-----------:|------|
| `struct` | 结构体 (Go/Rust/C) | 降级为 generic node | 可见但无类型特定处理 |
| `trait` | Trait (Rust) | 降级为 generic node | 可见但无类型特定处理 |
| `protocol` | Protocol (Swift) | 降级为 generic node | 可见但无类型特定处理 |
| `parameter` | 函数/方法参数 | 降级为 generic node | 可见但无类型特定处理 |
| `namespace` | 命名空间 | 降级为 generic node | 可见但无类型特定处理 |
| `route` | 路由 (Web 框架) | 降级为 generic node | 可见但无类型特定处理 |
| `component` | 组件 (React/Vue/Svelte) | 降级为 generic node | 可见但无类型特定处理 |

**修复方案**: 在 GraphStore 的 `normalizeKind()` 中添加这 7 种 kind 的显式映射，确保它们在图算法中有正确的语义角色分类。

---

## 二、callback-synthesizer 系统 (923 行)

### 架构概述

**入口**: `resolution/callback-synthesizer.js:887` — `synthesizeCallbackEdges(queries, ctx)`
**调用时机**: `resolution/index.js:727` — 在 `resolveAndPersistBatched()` 末尾
**设计模式**: 后处理合成器 — 静态调用边已持久化后，补充回调/调度边
**统一属性**: 所有合成边 `kind='calls'`, `provenance='heuristic'`, 通过 `metadata.synthesizedBy` 区分

### 11 种回调模式

| Phase | 模式 | synthesizedBy | 匹配规则 | 精度门控 | ola-cc 覆盖 |
|-------|------|--------------|---------|---------|:-----------:|
| 1 | Field-backed Observer | `callback` | `this.<field>.(add\|push\|set)(` + `emit\|trigger\|notify` | 40边/channel | ❌ |
| 2 | EventEmitter | `event-emitter` | `emit('event')` 配对 `on('event', handler)` | 6/event | ❌ |
| 3 | React Class Render | `react-render` | `this.setState(` → `render()` | 40/class | ❌ |
| 3b | Flutter Build | `flutter-build` | `.setState(` → `build()` (Dart) | 40/class | ❌ |
| 4 | C++ Virtual Override | `cpp-override` | 基类→子类同名方法配对 | 40/class | ❌ |
| 4b | Interface Override | `interface-impl` | 接口→实现类同名方法 (Java/Kotlin) | 40/class | ❌ |
| 5 | React JSX Children | `jsx-render` | `<Component/>` PascalCase 标签 | 30/parent | ❌ |
| 6 | Vue SFC Templates | `jsx-render`/`vue-handler` | kebab-case 组件 + `@click` 事件 + composable 解构 | 30/component | ❌ |
| 7 | RN Event Channel | `rn-event-channel` | 跨语言: ObjC/Swift `sendEventWithName` → JS `on('event')` | 6/event | ❌ |
| 8 | Fabric Native Impl | `fabric-native-impl` | `fabric-component:` → native class 后缀匹配 | 无限制 | ❌ |
| 9 | MyBatis Java↔XML | `mybatis-java-xml` | `<ClassName>::<methodName>` 匹配 `<namespace>::<id>` | 歧义丢弃 | ❌ |

### 关键常量

```javascript
MAX_CALLBACKS_PER_CHANNEL = 40  // 每 channel/class 边上限
EVENT_FANOUT_CAP = 6            // 泛化事件名扇出门控
MAX_JSX_CHILDREN = 30           // JSX 子组件上限
```

### 移植方案

**方案 A**: 直接移植 (从 codegraph JS 源码翻译为 TypeScript)
- 优势: 逻辑完整，精度门控已验证
- 劣势: 923 行 JS→TS 翻译工作量大，依赖 tree-sitter AST 节点查询

**方案 B**: 基于 codegraph.db 已持久化边 (推荐)
- codegraph CLI 已运行时，callback-synthesizer 合成的边已写入 codegraph.db
- GraphStore 加载时自动获取这些合成边（含 `provenance='heuristic'` 标记）
- ola-cc 只需在 codegraph CLI 未运行/失败时，做后备合成

**推荐**: 方案 B — 80% 场景已覆盖（codegraph CLI 正常运行），仅需实现高价值子集的后备合成

**高价值子集** (Phase 1 优先):
1. EventEmitter (`event-emitter`) — 通用模式，Node.js 项目必备
2. React JSX Children (`jsx-render`) — React 项目核心
3. Vue SFC Templates (`jsx-render`/`vue-handler`) — Vue 项目核心

**复杂度**: 方案 A: 高 (923 行翻译) | 方案 B: 中 (~300 行后备合成)

---

## 三、FrameworkResolver 系统

### 接口定义

```typescript
interface FrameworkResolver {
  name: string;
  languages?: Language[];
  detect(context: ResolutionContext): boolean;
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  claimsReference?(name: string): boolean;  // 动态引用声明
  extract?(filePath: string, content: string): FrameworkExtractionResult;
  postExtract?(context: ResolutionContext): Node[];  // 跨文件后处理
}
```

### 全部 20 个框架解析器 (源码: `/tmp/codegraph/src/resolution/frameworks/`)

| # | 框架 | 文件 | 行数 | detect | resolve | extract | postExtract | claimsReference | 移植优先级 |
|---|------|------|:----:|:------:|:-------:|:-------:|:-----------:|:---------------:|:---------:|
| 1 | React | react.ts | 403 | ✅ | ✅ (3模式) | ✅ (4组件+3路由+Next.js) | - | - | P1 |
| 2 | Vue | vue.ts | 338 | ✅ | ✅ (6模式) | ✅ (Nuxt路由+API+中间件) | - | - | P1 |
| 3 | Svelte | svelte.ts | 279 | ✅ | ✅ (4模式) | ✅ (SvelteKit路由) | - | - | P1 |
| 4 | NestJS | nestjs.ts | 766 | ✅ | ✅ | ✅ (装饰器) | ✅ (RouterModule) | - | P2 |
| 5 | React Native | react-native.ts | 434 | ✅ | ✅ | ✅ (ObjC/Java/TS桥接) | - | ❌ (始终false) | P2 |
| 6 | Fabric | fabric.ts | 411 | ✅ | ✅ | ✅ (Fabric组件) | - | - | P2 |
| 7 | Expo | expo-modules.ts | 193 | ✅ | ✅ | ✅ | - | - | P2 |
| 8 | Express | express.ts | 336 | ✅ | ✅ | ✅ (路由) | - | - | P2 |
| 9 | Java/Spring | java.ts | 538 | ✅ | ✅ | ✅ (注解路由) | - | ✅ | P2 |
| 10 | Python/Django | python.ts | 419 | ✅ | ✅ | ✅ | - | ✅ | P3 |
| 11 | Ruby/Rails | ruby.ts | 337 | ✅ | ✅ | ✅ | - | ✅ | P3 |
| 12 | Laravel | laravel.ts | 298 | ✅ | ✅ | ✅ | - | ✅ | P3 |
| 13 | Drupal | drupal.ts | 414 | ✅ | ✅ | ✅ | - | ✅ | P3 |
| 14 | Play | play.ts | 112 | ✅ | ✅ | ✅ | - | ✅ | P3 |
| 15 | Go | go.ts | 184 | ✅ | ✅ | ✅ | - | - | P3 |
| 16 | Rust | rust.ts | 335 | ✅ | ✅ | ✅ | - | - | P3 |
| 17 | Cargo Workspace | cargo-workspace.ts | 244 | ✅ | ✅ | ✅ | - | - | P3 |
| 18 | C# | csharp.ts | 275 | ✅ | ✅ | ✅ | - | - | P3 |
| 19 | Swift | swift.ts | 454 | ✅ | ✅ | ✅ | - | - | P3 |
| 20 | Swift-ObjC | swift-objc.ts | 299 | ✅ | ✅ | ✅ | - | ✅ | P3 |
| — | 注册中心 | index.ts | 142 | — | — | — | — | — | — |
| — | **总计** | — | **7211** | | | | | | |

### postExtract 分析

**唯一实现者**: NestJS (nestjs.ts:184-232)
**作用**: 跨文件最终化 — `RouterModule.register()` 路由前缀需要 `app.module.ts` 信息
**调用**: `runPostExtract()` 在所有 `extract()` 完成后调用，遍历所有框架

### claimsReference 分析

**8 个框架实现**:

| 框架 | 文件 | 声明逻辑 |
|------|------|---------|
| Python/Django | python.ts | `name === '_iterable_class'` |
| Laravel | laravel.ts | Controller@method 模式 |
| React Native | react-native.ts | 始终 false |
| Drupal | drupal.ts | 钩子函数名模式 |
| Ruby/Rails | ruby.ts | Rails 路由动态分发 |
| Java/Spring | java.ts | Spring 注入模式 |
| Play | play.ts | 路由反向引用 |
| Swift-ObjC | swift-objc.ts | 跨语言桥接方法 |

### 移植方案 (按优先级分 3 批)

**批次 1 (P1, 3 个框架, ~1020 行)**: 前端三大框架
- React (403行): 4 种组件模式 + 3 种路由模式 + Next.js 约定路由
- Vue (338行): 编译器宏 + Nuxt 自动导入 + 别名解析 + Nuxt 路由/API/中间件
- Svelte (279行): Runes + Store 自动订阅 + SvelteKit 路由文件映射

**批次 2 (P2, 6 个框架, ~2678 行)**: 后端 + 移动端
- NestJS (766行): 装饰器解析 + postExtract 跨文件处理
- React Native (434行): 跨语言桥接 (ObjC/Java/Kotlin/TS) + TurboModule
- Fabric (411行): Fabric 组件→原生类映射
- Expo (193行): Expo 模块解析
- Express (336行): 路由提取
- Java/Spring (538行): 注解路由 + Spring DI

**批次 3 (P3, 11 个框架, ~3513 行)**: 其他语言生态
- Python/Django (419行), Ruby/Rails (337行), Laravel (298行), Drupal (414行), Play (112行)
- Go (184行), Rust (335行), Cargo Workspace (244行)
- C# (275行), Swift (454行), Swift-ObjC (299行)

**复杂度**: 批次 1 中等 | 批次 2 中-高 | 批次 3 中等 (多数逻辑类似)

---

## 四、增量同步系统 (sync/)

### FileWatcher (watcher.js: 397 行)

**核心特性**:
- 基于 chokidar，`ignored` 回调在注册 inotify watch 前过滤目录
- 2000ms 默认防抖
- `pendingFiles` 追踪 (firstSeenMs/lastSeenMs) — 用于 MCP 工具报告过期结果
- chokidar `ready` 事件门控 — 初始爬取的 `add` 事件不计入 pendingFiles
- LockUnavailableError — 跨进程写锁失败静默重试

**对比 ola-cc IncrementalSync**:

| 特性 | CodeGraph FileWatcher | ola-cc IncrementalSync |
|------|----------------------|----------------------|
| 文件监视 | chokidar (实时) | 无 (仅手动触发) |
| 变更检测 | stat(size+mtime) → content hash | git diff → mtime → hash |
| 防抖 | 2000ms | N/A |
| 过期追踪 | pendingFiles Map | 无 |
| 跨进程锁 | ✅ (LockUnavailableError) | 无 |
| WSL2 检测 | ✅ (watchDisabledReason) | 无 |
| Git worktree | ✅ (detectWorktreeIndexMismatch) | 无 |

### ExtractionOrchestrator.sync() (extraction/index.js)

**核心逻辑**: 文件系统级 reconcile (不依赖 git)
1. 枚举当前源文件 (scanDirectoryAsync)
2. 从 DB 加载已索引文件的 (size, mtime) 映射
3. stat 预过滤: size + mtime 都匹配 → 跳过 (不读取/不hash)
4. 不匹配 → 读取 + SHA-256 hash 对比 → 确认真实变更
5. 检测删除文件 (DB 中有但磁盘上无)
6. 仅处理变更文件: 重新提取 + 重新解析

**关键设计**: 永远以文件系统为真相源，不依赖 `git status`。这捕获了 `git pull/checkout/merge/rebase` 引起的变更。

### 移植方案

**优先级 1**: FileWatcher 集成
- 复用 ola-cc 已有的 chokidar 依赖
- 添加 pendingFiles 追踪
- 集成到 CodegraphManager

**优先级 2**: stat 预过滤优化
- 在 IncrementalSync 中添加 (size, mtime) 预过滤
- 减少不必要的 SHA-256 hash 计算

**复杂度**: 优先级 1 中等 (~200 行) | 优先级 2 低 (~50 行)

---

## 五、C++ Include 目录发现 (import-resolver.js)

### loadCppIncludeDirs 逻辑

**策略**:
1. **编译数据库优先**: 扫描 `compile_commands.json` (5 个候选路径)
   - `<root>/compile_commands.json`
   - `<root>/build/compile_commands.json`
   - `<root>/cmake-build-debug/compile_commands.json`
   - `<root>/cmake-build-release/compile_commands.json`
   - `<root>/out/compile_commands.json`
   - 解析 `-I` 和 `-isystem` 编译器标志
2. **启发式回退**: 常规目录 (include/src/lib/api/inc) + 扫描含 .h/.hpp 的顶层目录

**缓存**: `cppIncludeDirCache` Map, 按 projectRoot 缓存

### extractReExports 逻辑

**范围**: JS/TS/TSX/JSX
**模式**: `export { X } from './module'` 和 `export * from './module'`
**用途**: 追踪 re-export 链，解析跨模块的符号传播

### 移植方案

**loadCppIncludeDirs**: 直接翻译 (~80 行)
- Node.js `fs.existsSync` + JSON 解析
- 启发式目录扫描

**extractReExports**: 直接翻译 (~100 行)
- 正则匹配 re-export 语法
- 注释剥离 (避免注释中的 re-export 产生幻影边)

**复杂度**: 低 (~180 行总计)

---

## 六、移植优先级总结

### Phase A: GraphStore 边类型扩展 (1 天)

| 任务 | 行数 | 复杂度 |
|------|:----:|:-----:|
| 扩展 CODEGRAPH_EDGE_MAP (6 种新类型) | ~30 | 低 |
| EdgeMeta type union 扩展 | ~10 | 低 |
| 图算法兼容性验证 | ~50 | 低 |
| **小计** | ~90 | |

### Phase B: callback-synthesizer 完整移植 (5 天, 1233 行)

从 `/tmp/codegraph/src/resolution/callback-synthesizer.ts` (1233行) 完整移植全部 11 种回调模式:

| 任务 | 行数 | 复杂度 |
|------|:----:|:-----:|
| Phase 1: Field-backed Observer | ~120 | 中 |
| Phase 2: EventEmitter | ~80 | 中 |
| Phase 3: React Class Render + Flutter Build | ~100 | 中 |
| Phase 4: C++ Virtual Override + Interface Override | ~120 | 中 |
| Phase 5: React JSX Children | ~60 | 中 |
| Phase 6: Vue SFC Templates | ~100 | 中 |
| Phase 7: RN Event Channel | ~120 | 高 (跨语言) |
| Phase 8: Fabric Native Impl | ~80 | 中 |
| Phase 9: MyBatis Java↔XML | ~80 | 中 |
| 统一去重 + 持久化 + 测试 | ~373 | 中 |
| **小计** | **1233** | |

### Phase C: FrameworkResolver 全量移植 (10 天, 7211 行)

从 `/tmp/codegraph/src/resolution/frameworks/` 完整移植全部 20 个框架解析器:

| 批次 | 框架 | 行数 | 天数 | 复杂度 |
|------|------|:----:|:----:|:-----:|
| 批次 1 (P1) | React (403) + Vue (338) + Svelte (279) | 1020 | 3 | 中 |
| 批次 2 (P2) | NestJS (766) + RN (434) + Fabric (411) + Expo (193) + Express (336) + Java (538) | 2678 | 4 | 中-高 |
| 批次 3 (P3) | Django (419) + Rails (337) + Laravel (298) + Drupal (414) + Play (112) + Go (184) + Rust (335) + Cargo (244) + C# (275) + Swift (454) + Swift-ObjC (299) | 3513 | 3 | 中 |
| 辅助模块 | 注册中心 (142) + name-matcher (712) + path-aliases (242) + strip-comments (469) + workspace-packages (180) + swift-objc-bridge (276) | 2021 | (含在上述天数内) | |
| **小计** | **7211** (不含辅助) | **10** | |

### Phase D: 同步系统完整移植 (2 天, 1068 行)

从 `/tmp/codegraph/src/sync/` 完整移植:

| 任务 | 文件 | 行数 | 复杂度 |
|------|------|:----:|:-----:|
| FileWatcher 集成 | watcher.ts | 639 | 中 |
| Git hooks 备用同步 | git-hooks.ts | 210 | 低 |
| WSL 检测 + 监视策略 | watch-policy.ts | 104 | 低 |
| Worktree 索引错配检测 | worktree.ts | 115 | 低 |
| **小计** | | **1068** | |

### Phase E: C++ include + re-export + 边自实现 (1 天, ~400 行)

| 任务 | 来源 | 行数 | 复杂度 |
|------|------|:----:|:-----:|
| loadCppIncludeDirs | import-resolver.ts:307-470 | ~160 | 低 |
| extractReExports | import-resolver.ts:870-1000 | ~130 | 低 |
| extractCppImports | import-resolver.ts:774-792 | ~20 | 低 |
| exports 边自实现 | 新增 | ~40 | 低 |
| overrides 边自实现 | 新增 | ~50 | 中 |
| **小计** | | **~400** | |

### 总计

| Phase | 天数 | 源码行数 | 说明 |
|-------|:----:|:-------:|------|
| Phase A: EdgeKind 映射 + NodeKind 规范化 | 1 | ~100 | GraphStore 映射扩展 |
| Phase B: callback-synthesizer | 5 | 1233 | 11 种回调模式完整移植 |
| Phase C: FrameworkResolver (批次1) | 3 | 1020 | React+Vue+Svelte |
| Phase C: FrameworkResolver (批次2) | 4 | 2678 | NestJS+RN+Fabric+Expo+Express+Java |
| Phase C: FrameworkResolver (批次3) | 3 | 3513 | 11 个其他语言框架 |
| Phase D: 同步系统 | 2 | 1068 | FileWatcher+hooks+WSL+worktree |
| Phase E: C++ + re-export + 边自实现 | 1 | ~400 | include+re-export+overrides+exports |
| **总计** | **19** | **~10012** | 从 codegraph 源码全量移植 |

---

## 七、关键源码文件索引

**源码位置**: `/tmp/codegraph/src/` (完整 TypeScript 源码)

### resolution/ — 引用解析系统

| 文件 | 行数 | 内容 |
|------|:----:|------|
| `resolution/callback-synthesizer.ts` | 1233 | 11 种回调模式合成 |
| `resolution/import-resolver.ts` | 1353 | C++ include + re-export + 路径解析 + import 映射 |
| `resolution/index.ts` | 959 | 解析协调器 (postExtract/claimsReference/resolveAndPersist) |
| `resolution/name-matcher.ts` | 712 | 引用名称匹配 + 置信度评分 |
| `resolution/strip-comments.ts` | 469 | JS/TS 注释剥离 |
| `resolution/path-aliases.ts` | 242 | 路径别名解析 (@/ ~/) |
| `resolution/swift-objc-bridge.ts` | 276 | Swift-ObjC 跨语言桥接 |
| `resolution/workspace-packages.ts` | 180 | monorepo workspace 包发现 |
| `resolution/go-module.ts` | 47 | Go 模块路径解析 |
| `resolution/lru-cache.ts` | 62 | LRU 缓存 |
| `resolution/types.ts` | 209 | FrameworkResolver/ResolvedRef 类型定义 |

### resolution/frameworks/ — 20 个框架解析器

| 文件 | 行数 | 框架 |
|------|:----:|------|
| `nestjs.ts` | 766 | NestJS (装饰器 + postExtract) |
| `java.ts` | 538 | Java/Spring |
| `swift.ts` | 454 | Swift |
| `react-native.ts` | 434 | React Native (跨语言桥接) |
| `python.ts` | 419 | Python/Django |
| `drupal.ts` | 414 | Drupal |
| `fabric.ts` | 411 | Fabric (RN 新架构) |
| `react.ts` | 403 | React/Next.js |
| `vue.ts` | 338 | Vue/Nuxt |
| `express.ts` | 336 | Express |
| `rust.ts` | 335 | Rust |
| `ruby.ts` | 337 | Ruby/Rails |
| `laravel.ts` | 298 | Laravel |
| `swift-objc.ts` | 299 | Swift-ObjC 桥接 |
| `svelte.ts` | 279 | Svelte/SvelteKit |
| `csharp.ts` | 275 | C#/.NET |
| `cargo-workspace.ts` | 244 | Cargo workspace |
| `expo-modules.ts` | 193 | Expo |
| `go.ts` | 184 | Go |
| `play.ts` | 112 | Play/Scala |
| `index.ts` | 142 | 注册中心 |

### sync/ — 同步系统

| 文件 | 行数 | 内容 |
|------|:----:|------|
| `sync/watcher.ts` | 639 | chokidar 文件监视 + pendingFiles |
| `sync/git-hooks.ts` | 210 | Git hook 备用同步 |
| `sync/worktree.ts` | 115 | Worktree 索引错配检测 |
| `sync/watch-policy.ts` | 104 | WSL 检测 + 监视策略 |

### extraction/ — 提取系统

| 文件 | 行数 | 内容 |
|------|:----:|------|
| `extraction/tree-sitter.ts` | 3242 | 主提取器 (所有语言) |
| `extraction/index.ts` | 1550 | 提取协调器 + sync() |
| `extraction/grammars.ts` | 394 | tree-sitter grammar 加载 |
| `extraction/liquid-extractor.ts` | 352 | Liquid 模板提取 |
| `extraction/svelte-extractor.ts` | 323 | Svelte 组件提取 |
| `extraction/vue-extractor.ts` | 290 | Vue SFC 提取 |
| `extraction/mybatis-extractor.ts` | 198 | MyBatis XML 提取 |
| `extraction/dfm-extractor.ts` | 159 | Delphi 表单提取 |
| `extraction/tree-sitter-types.ts` | 227 | 提取器类型定义 |
| `extraction/parse-worker.ts` | 101 | Worker 线程解析 |
| `extraction/wasm-runtime-flags.ts` | 110 | WASM 运行时标志 |
| `extraction/tree-sitter-helpers.ts` | 80 | AST 辅助函数 |
| `extraction/generated-detection.ts` | 78 | 自动生成文件检测 |

### 其他

| 文件 | 行数 | 内容 |
|------|:----:|------|
| `types.ts` | ~150 | NodeKind/EdgeKind/Language 类型定义 |
| `db/queries.ts` | ~800 | SQLite 查询层 |
| `graph/traversal.ts` | ~200 | 图遍历 (BFS/DFS) |
| `context/index.ts` | ~1300 | 上下文构建 + 图查询 |
