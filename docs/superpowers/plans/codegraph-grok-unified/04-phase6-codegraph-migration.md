# Phase 6: CodeGraph 源码能力移植

> 原文档: 2026-06-05-codegraph-grok-unified-plan.md
> Phase: 6a-6f
> 天数: 29

---

### 3.9 Phase 6: CodeGraph 源码能力移植 -- 13.5 天

**目标**: 从 codegraph 开源源码 (`/tmp/codegraph/src/`) 全量移植 ~20300 行核心代码，实现完全零 CLI 依赖

**源码位置**: `/tmp/codegraph/src/` (完整 TypeScript 源码)
**分析文档**: `docs/analysis/codegraph-source-migration-analysis.md`

| 任务 | 说明 | 天数 |
|------|------|------|
| **Phase 6a: EdgeKind 映射验证 + NodeKind 规范化** | 验证 Phase 1 的 12 种无损映射在真实项目中正确，7 种 NodeKind 显式映射，overrides/exports 边自实现 | 1 |
| **Phase 6b: callback-synthesizer 完整移植** | 从 `resolution/callback-synthesizer.ts` (1233行) 移植全部 11 种回调模式 | 5 |
| **Phase 6c-0: 辅助模块移植** | resolution/index.ts (959) + name-matcher.ts (712) + strip-comments.ts (469) + path-aliases.ts (242) + swift-objc-bridge.ts (276) + workspace-packages.ts (180) + types.ts (209) + frameworks/index.ts (142) — Phase 6c 的必要前置依赖 | 2 |
| **Phase 6c-1: FrameworkResolver 批次 1** | React (403行) + Vue (338行) + Svelte (279行) — 前端三大框架 | 3 |
| **Phase 6c-2: FrameworkResolver 批次 2** | NestJS (766) + RN (434) + Fabric (411) + Expo (193) + Express (336) + Java (538) | 4 |
| **Phase 6c-3: FrameworkResolver 批次 3** | Django (419) + Rails (337) + Laravel (298) + Drupal (414) + Play (112) + Go (184) + Rust (335) + Cargo (244) + C# (275) + Swift (454) + Swift-ObjC (299) | 3 |
| **Phase 6d: 同步系统完整移植 + CLI 降级** | FileWatcher (639行) + git-hooks (210行) + WSL检测 (104行) + worktree (115行) + ensureReady() stale DB 降级 + IncrementalSync markClean | 2.5 |
| **Phase 6e: C++ include + re-export + 边自实现** | loadCppIncludeDirs + extractReExports + overrides/exports 边自实现 | 1 |
| **Phase 6f-1 → Z1+Z5** | (已并入 Phase Z1-Z5) tree-sitter WASM + Worker 线程 | — |
| **Phase 6f-2 → Z2** | (已并入 Phase Z2) 主提取器 + 编排器 | — |
| **Phase 6f-3 → Z3** | (已并入 Phase Z3) 专用提取器 | — |

**EdgeKind 生成状态** (源码验证):

| EdgeKind | 提取器生成 | 说明 |
|----------|:---------:|------|
| contains/calls/imports/extends/implements/references | ✅ | 原生已实现 |
| instantiates | ✅ | 原生已实现 (819条) |
| decorates | ✅ | 原生已实现 (tree-sitter.ts:2050) |
| type_of/returns | — | 设计选择: 归为 `references`，无需单独实现 |
| overrides | ❌ | Phase 6e 自实现 |
| exports | ❌ | Phase 6e 自实现 |

**Phase 6b callback-synthesizer 完整范围** (11 种模式):

| Phase | 模式 | synthesizedBy | 精度门控 |
|-------|------|--------------|---------|
| 1 | Field-backed Observer | `callback` | 40/channel |
| 2 | EventEmitter | `event-emitter` | 6/event |
| 3 | React Class Render | `react-render` | 40/class |
| 3b | Flutter Build | `flutter-build` | 40/class |
| 4 | C++ Virtual Override | `cpp-override` | 40/class |
| 4b | Interface Override | `interface-impl` | 40/class |
| 5 | React JSX Children | `jsx-render` | 30/parent |
| 6 | Vue SFC Templates | `jsx-render`/`vue-handler` | 30/component |
| 7 | RN Event Channel | `rn-event-channel` | 6/event |
| 8 | Fabric Native Impl | `fabric-native-impl` | 无限制 |
| 9 | MyBatis Java↔XML | `mybatis-java-xml` | 歧义丢弃 |

**Phase 6c-0 辅助模块** (8 个模块, 3189 行, Phase 6c 的必要前置依赖):

| 模块 | 行数 | 依赖者 | 说明 |
|------|:----:|--------|------|
| `resolution/index.ts` | 959 | 所有 FrameworkResolver | 解析协调中枢: resolveAndPersistBatched()/postExtract()/claimsReference() |
| `name-matcher.ts` | 712 | 所有 FrameworkResolver | 引用名称匹配 + 置信度评分 |
| `strip-comments.ts` | 469 | import-resolver, extractReExports | JS/TS 注释剥离，防止幻影边 |
| `path-aliases.ts` | 242 | Vue, NestJS, React | `@/` `~/` 路径别名解析 |
| `swift-objc-bridge.ts` | 276 | swift-objc resolver | Swift-ObjC 跨语言桥接 |
| `workspace-packages.ts` | 180 | Cargo, Expo, NestJS | monorepo workspace 包发现 |
| `resolution/types.ts` | 209 | 所有 FrameworkResolver | FrameworkResolver/ResolvedRef 接口定义 |
| `frameworks/index.ts` | 142 | Phase 6c 全部 | 框架注册中心 |

**Phase 6c FrameworkResolver 全量范围** (20 个框架, 7211 行):

| 批次 | 框架 | 行数 | 核心能力 |
|------|------|:----:|---------|
| 批次 1 (P1) | React + Vue + Svelte | 1020 | 组件/Hook/路由/composable |
| 批次 2 (P2) | NestJS + RN + Fabric + Expo + Express + Java | 2678 | 装饰器/跨语言桥接/路由 |
| 批次 3 (P3) | Django + Rails + Laravel + Drupal + Play + Go + Rust + Cargo + C# + Swift + Swift-ObjC | 3513 | 多语言生态 |

**Phase 6d CLI 降级设计**:

当前问题: `ensureReady()` 在 CLI 二进制不可用时直接失败，图算法功能（bun:sqlite 直读）也无法使用。

降级方案:
- `ensureReady(options?: { allowStaleDb?: boolean })` 增加 `allowStaleDb` 参数
- CLI 二进制不可用 + `allowStaleDb=true` → 跳过 init/sync，从已有 codegraph.db 加载
- 返回 `{ stale: true, lastSync?: timestamp, message: "使用已有索引，部分数据可能过期" }`
- GraphStore.load() 正常执行，图算法功能完整可用
- 查询操作（callers/callees/impact）降级为 bun:sqlite 直查（GraphStore 已有此能力）

**IncrementalSync markClean 设计**:

当前问题: IncrementalSync 检测到 dirty 后调用 CLI sync，但 sync 完成后文件仍标记为 dirty，下次检测重复触发。

修复方案:
- `IncrementalSync.markClean(files: string[])` — CLI sync 成功后调用，更新文件的 hash/mtime 缓存
- 避免对已同步文件重复调用 CLI sync

**验收条件**:
- [ ] Phase 6a: 12 种 EdgeKind 全部精确映射，7 种 NodeKind 在角色分类中正确处理
- [ ] Phase 6b: 11 种回调模式全部移植，合成边正确生成
- [ ] Phase 6c-1: React/Vue/Svelte 项目 extract() 输出正确节点
- [ ] Phase 6c-2: NestJS/RN/Fabric/Express/Java 框架解析正确
- [ ] Phase 6c-3: 11 个其他语言框架解析正确
- [ ] Phase 6c-0: resolution/index.ts 调度 FrameworkResolver 正确，name-matcher 匹配准确，strip-comments 防止幻影边
- [ ] Phase 6d: FileWatcher 监视文件变更，git hooks 备用同步，WSL/worktree 感知，CLI 不可用时 stale DB 降级可用
- [ ] Phase 6e: C++ include 目录正确发现，re-export 链追踪，overrides/exports 边自实现

**tree-sitter 策略说明** (能力 vs 数据):

tree-sitter WASM 是**解析引擎**（能力），不是数据：
```
tree-sitter WASM = 解析运行时 (源码 → AST) + grammar 文件 (语言规则定义)
```

整个 codegraph 数据流水线：
```
源码文件 ──→ tree-sitter WASM + grammar ──→ AST 语法树 ──→ 提取节点/边 ──→ codegraph.db
           (解析能力: Phase 6f)              (中间产物)      (解析结果: 数据)
```

本方案对 tree-sitter 的分层策略：

| 模块 | 是否引入 tree-sitter WASM | 原因 |
|------|:------------------------:|------|
| StructuralFingerprint (Phase 1) | **否** — 复用 codegraph.db 数据 | codegraph CLI 已用 tree-sitter 解析过，结果存在 DB 里，直接查 DB 避免重复解析 |
| callback-synthesizer (Phase 6b) | **否** — 移植 JS 解析逻辑 | 移植的是合成边的规则逻辑，不涉及 AST 解析 |
| FrameworkResolver (Phase 6c) | **否** — 移植框架检测逻辑 | 框架 detect/resolve/extract 逻辑不依赖 tree-sitter 运行时 |
| **extraction 系统 (Phase 6f)** | **是** — 需要解析引擎 | 目标是零 CLI 依赖，必须自己解析源码，所以必须有 tree-sitter WASM |

**核心原则**: 能复用 codegraph.db 已有解析结果的 → 不引入（数据复用）；需要自己解析源码的 → 引入（能力需要）。

**Phase 6f extraction 系统移植设计** (7104 行, **已并入 Phase Z1-Z5**):

> **重要**: Phase 6f 已与 Phase D1-D4 合并为 Phase Z1-Z5 (零依赖 + 数据完整性统一方案)。
> 详见 `07-zero-dependency-data-completeness.md`。以下保留原始设计供参考。

当前问题: 所有提取操作（init/sync）依赖外部 codegraph CLI 二进制。CLI 不可用时无法更新索引。

目标: 移植完整 extraction 系统，实现 init/sync 完全内建，零 CLI 依赖。

**Phase 6f-1: 核心基础设施** (990 行, 2 天):

| 文件 | 行数 | 说明 |
|------|:----:|------|
| `tree-sitter-types.ts` | 227 | 提取器类型定义 (UnresolvedRef/ExtractedNode/ParseResult) |
| `tree-sitter-helpers.ts` | 80 | AST 辅助函数 (getChildByType/getText/queryCapture) |
| `wasm-runtime-flags.ts` | 110 | WASM 运行时标志 (init/health-check/error-recovery) |
| `grammars.ts` | 394 | 29 种语言 tree-sitter grammar 加载 (按需下载 + 缓存) |
| `generated-detection.ts` | 78 | 自动生成文件检测 (node_modules/dist/build 等) |
| `parse-worker.ts` | 101 | Worker 线程解析 (bun worker_threads 并行提取) |

关键风险: tree-sitter WASM 在 bun:compile 模式下的加载行为需额外验证。grammar 文件需要打包策略（内嵌 vs 按需下载）。

**Phase 6f-2: 主提取器 + 编排器** (4792 行, 4 天):

| 文件 | 行数 | 说明 |
|------|:----:|------|
| `tree-sitter.ts` | 3242 | 核心提取器: 29 种语言的 AST→节点/边提取，含 extractDecoratorsFor/extractTypeAnnotations 等 |
| `extraction/index.ts` | 1550 | 提取协调器: scanDirectory + sync() + resolveAndPersistBatched + 增量提取 |

关键设计:
- `sync()` 实现真正的增量提取: stat 预过滤 → SHA-256 确认 → 仅重解析变更文件（vs CLI 的全目录扫描）
- `extract()` 按语言分发到 tree-sitter.ts 的对应解析函数
- 与 Phase 6c 的 FrameworkResolver 集成: extract() 完成后调用 runPostExtract()

**Phase 6f-3: 专用提取器** (1322 行, 1.5 天):

| 文件 | 行数 | 说明 |
|------|:----:|------|
| `vue-extractor.ts` | 290 | Vue SFC `<template>`/`<script>`/`<style>` 拆分提取 |
| `svelte-extractor.ts` | 323 | Svelte 组件 `{#if}`/`{#each}` + store 自动订阅 |
| `liquid-extractor.ts` | 352 | Liquid 模板 `{% include %}`/`{% render %}` 引用提取 |
| `mybatis-extractor.ts` | 198 | MyBatis XML `<select>`/`<insert>` SQL→Java 方法映射 |
| `dfm-extractor.ts` | 159 | Delphi 表单 DFM/FMX 对象树提取 |

**Phase 6f 验收条件**:
- [ ] Phase 6f-1: tree-sitter WASM 加载成功，29 种语言 grammar 可用
- [ ] Phase 6f-2: `init` 内建执行生成 codegraph.db，结果与 CLI 一致
- [ ] Phase 6f-2: `sync` 增量提取仅处理变更文件，性能优于 CLI 全目录扫描
- [ ] Phase 6f-3: Vue/Svelte/Liquid/MyBatis/DFM 项目正确提取节点和边
- [ ] Phase 6f 全部: 零 CLI 依赖下完整的 init→extract→resolve→persist 流程贯通

---

## Phase 6 评审新增问题 (三方专家)

### P1 — 过度设计评估

**Phase 6f 全量移植 ROI 低** (三方共识):
- 20300 行全量移植需要 29 天，但核心用户场景是**分析已有索引**，而非**建立新索引**
- codegraph CLI 已经提供了 init/sync 能力，Phase 6f 只在 CLI 不可用时才有价值
- 建议：Phase 6f 按需推迟，先做 Phase 6a-6e（~13 天），Phase 6f 仅在 CLI 确实不可用时执行
- 这样核心交付时间从 51.5 天缩短到 35.5 天（Phase 1-5 + Phase 6a-6e）

**tree-sitter WASM bun:compile 兼容性未验证** (架构师):
- Phase 6f 引入 tree-sitter WASM，但 bun:compile 模式下的 WASM 加载行为未验证
- grammar 文件打包策略（内嵌 vs 按需下载）未确定
- 建议：在 Phase 6f 启动前先做 spike 验证 bun:compile + tree-sitter WASM
