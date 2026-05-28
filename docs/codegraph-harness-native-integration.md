# 原生集成设计方案（已实施）

> CodeGraph 语义代码理解 + Claude Code Harness 结构化工作流 + ola-cc/Orion 自进化系统
> 设计日期：2026-05-27
> **实施日期：2026-05-28**
> **实施状态：Phase 1 + Phase 2 完成**

---

## 一、设计目标

1. **零配置** — 安装 ola-cc 即自带 codegraph 能力，无需手动安装或 MCP 配置
2. **零侵入** — 不修改 codegraph/harness 源代码，仅作为依赖消费其公开 API
3. **可渐进** — 每个模块可独立启用/禁用，不强制全有或全无

---

## 二、架构总览（实施版）

```
┌─────────────────────────────────────────────────────────────────────────┐
│  用户层                                                                  │
│  /orion-* 命令 + AgentTool 子代理 + 自然语言交互                          │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────────┐
│  ✅ 已实施：CodeGraphTool（原生集成，CLI 子进程模式）                        │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ CodegraphTool.ts — 包装 codegraph CLI 为 ola-cc Tool                │ │
│  │ • codegraph_context  — 任务上下文映射                                 │ │
│  │ • codegraph_search   — 符号查找                                      │ │
│  │ • codegraph_callers  — 调用链分析                                     │ │
│  │ • codegraph_callees  — 被调用分析                                     │ │
│  │ • codegraph_impact   — 影响范围分析                                   │ │
│  │ • codegraph_trace    — 完整调用路径追踪                               │ │
│  │ • codegraph_explore  — 批量符号源码                                   │ │
│  │ • codegraph_init     — 项目初始化                                     │ │
│  │ • codegraph_status   — 索引状态                                      │ │
│  │ • codegraph_files    — 已索引文件列表                                  │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│  增强：下载可靠性（重试 + 超时 + 状态码检查 + 文件大小校验）                  │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────────┐
│  ✅ 已实施：Harness 设计模式融入 Orion EvolutionEngine                     │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ P0 增强：createSpecContract() — spec.md 契约模式                      │ │
│  │ • 定义进化任务的范围、验收标准和约束条件                                │ │
│  │ • 自动生成 SpecContract 对象并注入状态上下文                           │ │
│  │                                                                   │ │
│  │ P5 增强：executeIndependentReview() — 独立评审模式                    │ │
│  │ • 评审者 ≠ 实现者，避免自我审查偏差                                    │ │
│  │ • 检查验收标准、停止条件、弱维度                                       │ │
│  │ • 生成 ReviewReport 并注入状态上下文                                  │ │
│  │                                                                   │ │
│  │ P7 增强：packageEvidence() — 证据打包模式                            │ │
│  │ • 结构化验证证据，而非仅靠记忆                                        │ │
│  │ • 包含 spec、review、testResults、artifacts、metrics                │ │
│  │ • 生成 EvidencePackage 并注入状态上下文                               │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────────┐
│  增强：Orion 进化系统（ASAEF 8阶段）                                      │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ P2(构思) 增强：使用 codegraph_impact 做精确依赖分析                    │ │
│  │ P5(验证) 增强：使用独立评审模式（来自 Harness）                        │ │
│  │ P6(门控) 增强：结合 codegraph 影响范围 + rubricEvaluator 5维门控      │ │
│  │ P7(记录) 增强：使用证据打包模式（来自 Harness）                        │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 三、CodeGraph 原生集成（已实施）

### 3.1 实施架构

```
CodegraphTool.ts (Tool 入口)
       ↓
CodegraphManager.ts (管理层)
       ↓
spawn(codegraph CLI)  ← 子进程调用模式
       ↓
codegraph 二进制 (tree-sitter + node:sqlite)
```

### 3.2 自动下载增强（Phase 1.5）

**新增特性：**
- HTTP 状态码检查（404/500 等错误处理）
- 指数退避重试机制（最多 3 次）
- 网络超时保护（60 秒）
- 下载进度日志
- 文件大小校验（最小 1MB）

**配置常量：**
```typescript
const DOWNLOAD_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  timeoutMs: 60_000,
  minFileSize: 1024 * 1024, // 1MB 最小文件大小检查
};
```

### 3.3 自启动流程

```
用户首次调用 codegraph_* 操作
       ↓
CodegraphTool.call()
       ↓
CodegraphManager.isCodegraphInitialized(projectRoot)  // 检查 .codegraph/codegraph.db
       ↓ (不存在)
CodegraphManager.ensureReady(projectRoot)
       ↓
ensureCodegraphBinary()  // 检查 ~/.ola-cc/vendor/codegraph/
       ↓ (不存在)
downloadWithRetry(GitHub Releases)  // ~45MB 下载，带重试
       ↓
extractTarGz()  // 解压
       ↓
runCodegraph(binPath, projectRoot, ['init', projectRoot, '--index'], 120_000, true)
       ↓
CI=1 + stdin.write('y\n')  // 自动确认交互式提示
       ↓
初始化完成，返回结果
```

### 3.4 文件结构

```
src/tools/CodegraphTool/
├── CodegraphTool.ts          # 主 Tool 定义（10 个操作）
└── CodegraphManager.ts       # CLI 管理 + 自动下载 + 重试机制
```

---

## 四、Harness 设计模式融入 Orion（已实施）

### 4.1 设计决策

**原设计：** 引入独立的 HarnessTool（5 动词）
**实施决策：** 将 Harness 设计理念融入 Orion EvolutionEngine

**原因：**
1. Harness 与 Orion 功能高度重叠（90% 重叠度）
2. 独立 Tool 增加用户认知负担
3. 融入 Orion 保持单一进化循环

### 4.2 新增类型定义

```typescript
// SpecContract — 来自 Harness harness_plan 的契约模式
export interface SpecContract {
  title: string
  scope: string
  acceptanceCriteria: string[]
  unknowns: string[]
  stopConditions: string[]
  dependencies: string[]
  createdAt: Date
  iteration: number
}

// ReviewReport — 来自 Harness harness_review 的独立评审模式
export interface ReviewReport {
  taskId: string
  reviewer: 'independent-auditor'
  passed: boolean
  findings: {
    severity: 'blocker' | 'advisory' | 'info'
    dimension: string
    description: string
    evidence: string
  }[]
  score: number
  recommendation: 'approve' | 'revise' | 'reject'
  reviewedAt: Date
}

// EvidencePackage — 来自 Harness harness_release 的证据打包模式
export interface EvidencePackage {
  skill: string
  iteration: number
  spec: SpecContract
  review: ReviewReport | null
  testResults: {
    passed: number
    failed: number
    total: number
    details: { name: string; passed: boolean; duration: number }[]
  }
  artifacts: {
    type: 'diff' | 'log' | 'screenshot' | 'metric'
    name: string
    content: string
  }[]
  metrics: {
    scoreDelta: number
    costRatio: number
    passRate: number
  }
  packagedAt: Date
}
```

### 4.3 新增 API 方法

#### P0 增强：createSpecContract()

```typescript
/**
 * P0 增强：创建 spec.md 契约（来自 Harness harness_plan）
 *
 * 在准备阶段定义进化任务的范围、验收标准和约束条件
 */
createSpecContract(params: {
  title: string
  scope: string
  acceptanceCriteria: string[]
  unknowns?: string[]
  stopConditions?: string[]
  dependencies?: string[]
}): SpecContract
```

#### P5 增强：executeIndependentReview()

```typescript
/**
 * P5 增强：执行独立评审（来自 Harness harness_review）
 *
 * 评审者 ≠ 实现者，避免自我审查偏差
 */
async executeIndependentReview(params: {
  taskId: string
  testResults: { passed: boolean; name: string; regression: boolean }[]
  score: number
  weakDimensions: string[]
}): Promise<ReviewReport>
```

#### P7 增强：packageEvidence()

```typescript
/**
 * P7 增强：打包证据（来自 Harness harness_release）
 *
 * 结构化验证证据，而非仅靠记忆
 */
packageEvidence(params: {
  testResults: EvidencePackage['testResults']
  artifacts?: EvidencePackage['artifacts']
  scoreDelta: number
  costRatio: number
}): EvidencePackage
```

#### 契约验证：validateContractCompletion()

```typescript
/**
 * 验证契约完成度
 *
 * 检查所有验收标准是否满足，所有停止条件是否达成
 */
validateContractCompletion(): {
  passed: boolean
  blockers: string[]
  advisories: string[]
}
```

---

## 五、数据流全景（实施版）

```
┌─────────────────────────────────────────────────────────────────────┐
│  用户提出任务                                                         │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  orion-using 决策                                                     │
│  ├── 有匹配 skill？→ 执行                                            │
│  └── 无匹配 skill？→ 判断是否可复现 → 创建                              │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
          ▼                         ▼
┌──────────────────┐     ┌──────────────────────┐
│ CodeGraph 辅助    │     │ Orion P0 契约建立      │
│ codegraph_context│     │ createSpecContract()  │
│ 自动代码理解      │     │ spec.md 契约模式       │
└───────┬──────────┘     └──────────┬───────────┘
        │                          │
        └────────────┬─────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  AgentTool 子代理执行                                                 │
│  ├── 工具池：Bash/Read/Edit/Grep + codegraph_*                       │
│  ├── codegraph 减少探索成本 35%                                      │
│  └── Orion 契约保证执行在范围内                                        │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  完成 → Orion P5 独立评审                                             │
│  ├── executeIndependentReview() — 评审者 ≠ 实现者                    │
│  ├── rubricEvaluator 5维门控                                         │
│  └── codegraph_impact 确认无意外影响                                   │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Orion P7 证据打包                                                    │
│  ├── packageEvidence() — 结构化验证证据                               │
│  ├── validateContractCompletion() — 契约完成度检查                    │
│  └── 阈值检查 → 建议 repair 或 crystallize                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 六、实施状态总结

| 阶段 | 内容 | 状态 | 文件 |
|------|------|------|------|
| **Phase 1** | CodeGraph 原生集成 | ✅ 完成 | `CodegraphTool.ts`, `CodegraphManager.ts` |
| **Phase 1.5** | 下载可靠性增强 | ✅ 完成 | `CodegraphManager.ts` |
| **Phase 2** | Harness 设计模式融入 Orion | ✅ 完成 | `EvolutionEngine.ts` |
| **Phase 3** | Orion 进化循环增强（P2/P5/P7） | ✅ 完成 | `EvolutionEngine.ts` |
| **Phase 4** | AgentTool 子代理自动注入 | ⏳ 待实施 | — |
| **Phase 5** | SingularityTool 修复 | ⏳ 待实施 | — |

**已实施代码量：**
- `CodegraphManager.ts`: ~250 行（增强版）
- `EvolutionEngine.ts`: ~200 行新增（Harness 融合）
- 总计：~450 行新增/修改代码

---

## 七、关键设计决策记录

### 7.1 CodeGraph 架构选择

**决策：** CLI 子进程模式（非 SDK 集成）

**原因：**
1. 避免引入 45MB npm 依赖
2. 二进制隔离，不影响主进程
3. 自带 Node 运行时 + node:sqlite

**代价：**
- 每次调用启动新进程（50-200x 延迟）
- 无内存级 watcher 能力

### 7.2 Harness 集成方式

**决策：** 融入 Orion EvolutionEngine（非独立 Tool）

**原因：**
1. Harness 与 Orion 功能高度重叠（90%）
2. 独立 Tool 增加用户认知负担
3. 融入 Orion 保持单一进化循环

**收益：**
- 保持 Orion 作为唯一进化框架
- Harness 设计理念（契约/评审/证据）自然融入
- 无额外 Tool 注册和维护成本

### 7.3 下载可靠性策略

**决策：** 指数退避重试 + 状态码检查 + 文件大小校验

**配置：**
- 最大重试次数：3
- 基础延迟：1000ms（指数增长）
- 超时时间：60 秒
- 最小文件大小：1MB

---

## 八、后续工作

### 8.1 短期（Phase 4-5）

1. AgentTool 子代理自动注入 codegraph 工具
2. SingularityTool 修复（bytecode crash 问题）
3. CodeGraph 操作暴露给 SingularityTool

### 8.2 中期

1. 评估是否可恢复 SDK 集成（降低延迟）
2. 添加 SHA256 完整性校验
3. 添加 fallback 镜像源

### 8.3 长期

1. CodeGraph watcher 集成（增量更新）
2. 多项目实例管理优化
3. 性能监控和指标收集

---

*文档更新时间：2026-05-28*
*实施版本：v2.0 (Phase 1 + Phase 2 完成)*
