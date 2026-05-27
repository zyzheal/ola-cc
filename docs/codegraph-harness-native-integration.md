# 原生集成设计方案

> CodeGraph 语义代码理解 + Claude Code Harness 结构化工作流 + ola-cc/Orion 自进化系统
> 设计日期：2026-05-27

---

## 一、设计目标

1. **零配置** — 安装 ola-cc 即自带 codegraph 能力，无需手动安装或 MCP 配置
2. **零侵入** — 不修改 codegraph/harness 源代码，仅作为依赖消费其公开 API
3. **可渐进** — 每个模块可独立启用/禁用，不强制全有或全无

---

## 二、架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│  用户层                                                                  │
│  /orion-* 命令 + AgentTool 子代理 + 自然语言交互                          │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────────┐
│  新增：CodeGraphTool（原生集成，非 MCP）                                   │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ CodeGraphTool.ts — 包装 codegraph 公开 API 为 ola-cc Tool           │ │
│  │ • codegraph_context  — 任务上下文映射                                 │ │
│  │ • codegraph_search   — 符号查找                                      │ │
│  │ • codegraph_callers  — 调用链分析                                     │ │
│  │ • codegraph_callees  — 被调用分析                                     │ │
│  │ • codegraph_impact   — 影响范围分析                                   │ │
│  │ • codegraph_trace    — 完整调用路径追踪                               │ │
│  │ • codegraph_explore  — 批量符号源码                                   │ │
│  │ • codegraph_init     — 项目初始化                                     │ │
│  │ • codegraph_status   — 索引状态                                      │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────────┐
│  新增：HarnessTool（结构化工作流）                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ HarnessTool.ts — 包装 Harness 5 动词为 ola-cc Tool                   │ │
│  │ • harness_plan     — 生成 spec.md + Plans.md 契约                     │ │
│  │ • harness_work     — 执行已批准任务（TDD + 验证）                       │ │
│  │ • harness_review   — 独立评审（与实现分离）                             │ │
│  │ • harness_sync     — 同步契约与实现状态                                │ │
│  │ • harness_release  — 打包证据/准备 PR                                  │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────────┐
│  增强：Orion 进化系统（ASAEF 8阶段）                                      │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ P2(构思) 增强：使用 codegraph_impact 做精确依赖分析                    │ │
│  │ P5(验证) 增强：使用 Harness 独立评审模式                                │ │
│  │ P6(门控) 增强：结合 codegraph 影响范围 + rubricEvaluator 5维门控      │ │
│  │ P7(记录) 增强：使用 Harness 证据打包格式化 telemetry                    │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 三、CodeGraph 原生集成

### 3.1 依赖安装

```bash
bun add @colbymchenry/codegraph  # ~45MB，包含 tree-sitter-wasms
```

codegraph 自带：
- `web-tree-sitter` — AST 解析
- `tree-sitter-wasms` — 20+ 语言 grammar
- `node:sqlite`（Node 内置）— 无需外部数据库
- `chokidar` — 文件 watcher

### 3.2 文件结构

```
src/tools/CodegraphTool/
├── CodegraphTool.ts          # 主 Tool 定义
├── CodegraphManager.ts       # CodeGraph 实例管理（单例 + 多项目）
├── init.ts                   # codegraph init 逻辑
├── index.ts                  # 导出
└── types.ts                  # 类型定义
```

### 3.3 CodegraphManager（单例管理器）

```typescript
import CodeGraph from '@colbymchenry/codegraph';

class CodegraphManager {
  private static instances = new Map<string, CodeGraph>();

  // 获取或创建项目实例
  static async get(projectRoot: string): Promise<CodeGraph> {
    if (this.instances.has(projectRoot)) {
      return this.instances.get(projectRoot)!;
    }
    const cg = await CodeGraph.open(projectRoot, { sync: true });
    cg.watch();  // 启动文件 watcher
    this.instances.set(projectRoot, cg);
    return cg;
  }

  // 检测是否已初始化
  static isInitialized(projectRoot: string): boolean {
    return CodeGraph.isInitialized(projectRoot);
  }

  // 初始化新项目
  static async init(projectRoot: string): Promise<CodeGraph> {
    const cg = await CodeGraph.init(projectRoot, { index: true });
    cg.watch();
    this.instances.set(projectRoot, cg);
    return cg;
  }

  // 清理
  static close(projectRoot: string): void {
    this.instances.get(projectRoot)?.close();
    this.instances.delete(projectRoot);
  }
}
```

### 3.4 CodegraphTool 操作映射

| CodegraphTool 操作 | 底层 CodeGraph API | Agent 意图 |
|---|---|---|
| `codegraph_context` | `buildContext(task, options)` | "这个任务涉及哪些代码？" |
| `codegraph_search` | `searchNodes(query, options)` | "X 符号在哪定义的？" |
| `codegraph_callers` | `getCallers(nodeId)` | "谁调用了 X？" |
| `codegraph_callees` | `getCallees(nodeId)` | "X 调用了什么？" |
| `codegraph_impact` | `getImpactRadius(nodeId, depth)` | "改 X 会影响什么？" |
| `codegraph_trace` | `traverse(startId) → trace(path)` | "X 到 Y 的调用路径" |
| `codegraph_explore` | `searchNodes() + getNode() + getNodesInFile()` | "展示这几个符号的源码" |
| `codegraph_init` | `CodeGraph.init()` | "初始化 codegraph" |
| `codegraph_status` | `getStats()` | "索引状态如何？" |

### 3.5 自动注册

```typescript
// src/tools.ts
import { codegraphTool } from './tools/CodegraphTool/CodegraphTool.js';
import { CodegraphManager } from './tools/CodegraphTool/CodegraphManager.js';
import { getCwd } from './utils/cwd.js';

function isCodegraphAvailable(): boolean {
  return CodegraphManager.isInitialized(getCwd());
}

export function getAllBaseTools(): Tools {
  const tools = [
    AgentTool,
    agentDetectorTool,
    singularityTool,
    // ... 其他工具
  ];

  // 自动注册：当 .codegraph/codegraph.db 存在时
  if (isCodegraphAvailable()) {
    tools.push(codegraphTool);
  }

  return tools;
}
```

### 3.6 与现有 MCP 自动发现的关系

| 方式 | 优点 | 缺点 |
|------|------|------|
| **MCP 自动发现**（已实现） | 零代码侵入，用户可随时切换 | 需要用户手动安装 codegraph CLI |
| **原生集成**（本方案） | 安装即自带，更低延迟 | 增加 ~45MB 依赖体积 |

**决策：** 保留 MCP 自动发现作为 fallback。如果原生 codegraph 可用优先使用原生；如果用户已手动配置了 MCP codegraph，两者去重。

---

## 四、Harness 工作流集成

### 4.1 设计理念

Harness 的核心价值不是代码，而是**设计模式**：

1. **spec.md 契约** — 需求/范围/验收标准作为 source of truth
2. **独立评审** — `/harness-review` 与实现分离，避免自我审查偏差
3. **证据打包** — `/harness-release` 打包验证证据，而非仅靠记忆

### 4.2 集成方式：增强 Orion 进化循环

```
当前 Orion P2(构思) → Harness spec.md 契约模式增强
当前 Orion P5(验证) → Harness 独立评审模式增强
当前 Orion P7(记录) → Harness 证据打包模式增强
```

### 4.3 新增文件结构

```
src/tools/HarnessTool/
├── HarnessTool.ts            # 主 Tool 定义（5 动词）
├── ContractManager.ts        # spec.md / Plans.md 管理
├── ReviewEngine.ts           # 独立评审引擎（受 Harness 启发）
├── EvidencePacker.ts         # 证据打包（受 Harness 启发）
└── types.ts
```

### 4.4 HarnessTool 操作

| 操作 | 功能 | Orion 阶段映射 |
|------|------|---------------|
| `harness_plan` | 生成/更新 spec.md + Plans.md | P0(准备) → P1(回顾) |
| `harness_work` | 执行已批准任务，TDD + 验证 | P2(构思) → P3(修改) → P4(提交) |
| `harness_review` | 独立评审（与实现者分离） | P5(验证) 增强 |
| `harness_sync` | 同步契约与实现状态 | P6(门控) 增强 |
| `harness_release` | 打包证据，PR 就绪检查 | P7(记录) → P8(循环) |

### 4.5 ContractManager

```typescript
interface SpecContract {
  title: string;
  scope: string;           // 本次做什么
  acceptanceCriteria: string[];  // 验收标准
  unknowns: string[];      // 未知项
  stopConditions: string[]; // 停止条件
  dependencies: string[];  // 前置依赖
}

interface PlansContract {
  tasks: {
    id: string;
    description: string;
    acceptanceCriteria: string[];
    status: 'pending' | 'approved' | 'in-progress' | 'done' | 'blocked';
  }[];
}

class ContractManager {
  private projectRoot: string;

  async createSpec(spec: SpecContract): Promise<void>;
  async createPlans(plans: PlansContract): Promise<void>;
  async loadSpec(): Promise<SpecContract | null>;
  async loadPlans(): Promise<PlansContract | null>;
  async updateTaskStatus(taskId: string, status: string): Promise<void>;
  async validateCompletion(): Promise<{ passed: boolean; blockers: string[] }>;
}
```

### 4.6 ReviewEngine（独立评审）

```typescript
class ReviewEngine {
  /**
   * 独立评审：读取 spec.md + Plans.md，对比实现结果
   * 关键设计：评审者 ≠ 实现者
   */
  async review(taskId: string): Promise<ReviewReport> {
    const spec = await this.contractManager.loadSpec();
    const plans = await this.contractManager.loadplans();
    const task = plans?.tasks.find(t => t.id === taskId);

    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== 'done') throw new Error(`Task ${taskId} not completed`);

    // 检查验收标准
    const criteriaResults = await this.checkAcceptanceCriteria(task);

    return {
      taskId,
      passed: criteriaResults.every(r => r.passed),
      findings: criteriaResults.filter(r => !r.passed).map(r => ({
        severity: r.critical ? 'blocker' : 'advisory',
        description: r.details,
      })),
    };
  }
}
```

---

## 五、三系统融合：增强 Agent 能力

### 5.1 AgentTool 子代理增强

当 AgentTool 启动子代理时，自动注入可用工具：

```typescript
// AgentTool.tsx — 子代理工具池增强
function getAgentTools(selectedAgent, appState): Tools {
  const tools = assembleToolPool(...);

  // 自动注入 codegraph（如果可用）
  if (CodegraphManager.isInitialized(appState.projectRoot)) {
    tools.push(codegraphTool);
  }

  // 自动注入 harness（如果 spec.md 存在）
  if (ContractManager.hasContract(appState.projectRoot)) {
    tools.push(harnessTool);
  }

  return tools;
}
```

### 5.2 Orion P2(构思) 增强

```typescript
// EvolutionEngine.ts P2_CONCEIVE 阶段增强
class EvolutionEngine {
  async executeP2(state: EvolutionState): Promise<EvolutionState> {
    // 原有：分析失败模式 → 生成候选改动
    const failureModes = this.analyzeFailures(state.skill);

    // 新增：使用 codegraph 做精确依赖分析
    if (CodegraphManager.isInitialized(state.projectRoot)) {
      const cg = await CodegraphManager.get(state.projectRoot);
      for (const file of failureModes.affectedFiles) {
        const impact = cg.getImpactRadius(file, 2);  // 精确影响范围
        state.mutations.push({
          type: 'impact-aware',
          target: file,
          blastRadius: impact,
        });
      }
    }

    // 新增：使用 Harness 契约模式定义改动范围
    const contract = await this.contractManager.createSpec({
      title: `Fix: ${state.skill}`,
      scope: failureModes.description,
      acceptanceCriteria: failureModes.expectedBehavior,
      unknowns: failureModes.unknowns,
      stopConditions: ['所有测试通过', '无回归'],
      dependencies: failureModes.dependencies,
    });

    return state;
  }
}
```

### 5.3 Orion P5(验证) 增强

```typescript
// EvolutionEngine.ts P5_VERIFY 阶段增强
async executeP5(state: EvolutionState): Promise<EvolutionState> {
  // 原有：三层评测 L1(quick) → L2(grader) → L3(blind)
  const evalResult = await this.runEvaluation(state);

  // 新增：使用 Harness 独立评审
  if (ContractManager.hasContract(state.projectRoot)) {
    const review = await this.reviewEngine.review(state.currentTask);
    state.reviewReport = {
      ...evalResult,
      independentReview: review,
      combinedPass: evalResult.passed && review.passed,
    };
  } else {
    state.reviewReport = evalResult;
  }

  return state;
}
```

---

## 六、数据流全景

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
│ CodeGraph 辅助    │     │ Harness 契约建立      │
│ codegraph_context│     │ harness_plan          │
│ 自动代码理解      │     │ spec.md + Plans.md    │
└───────┬──────────┘     └──────────┬───────────┘
        │                          │
        └────────────┬─────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  AgentTool 子代理执行                                                 │
│  ├── 工具池：Bash/Read/Edit/Grep + codegraph_* + harness_*          │
│  ├── codegraph 减少探索成本 35%                                      │
│  └── harness 保证执行在契约范围内                                      │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  完成 → /orion-score 评分                                            │
│  ├── rubricEvaluator 5维门控                                         │
│  ├── codegraph_impact 确认无意外影响                                   │
│  └── harness_review 独立评审确认                                      │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  阈值检查 → 建议 repair 或 crystallize                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 七、实施路线图

| 阶段 | 内容 | 工作量 |
|------|------|--------|
| **Phase 1** | CodeGraph 原生集成：CodegraphManager + CodegraphTool | 3 文件 ~200 行 |
| **Phase 2** | Harness 契约模式集成：ContractManager + HarnessTool | 3 文件 ~250 行 |
| **Phase 3** | ReviewEngine 独立评审引擎 | 2 文件 ~150 行 |
| **Phase 4** | Orion 进化循环增强（P2/P5/P7） | 修改 2 文件 ~100 行 |
| **Phase 5** | AgentTool 子代理自动注入 | 修改 1 文件 ~30 行 |
| **Phase 6** | SingularityTool 新增 codegraph_* 操作 | 修改 1 文件 ~80 行 |

**总计：** ~810 行新增代码，6 个新文件，4 个文件修改

---

## 八、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| codegraph 依赖增加 ~45MB | 安装包体积 | codegraph 为 optionalDependencies，可按需安装 |
| tree-sitter-wasms 加载慢 | 冷启动 | 懒加载：首次 codegraph 调用时才初始化 |
| Harness 与 Orion 功能重叠 | 用户困惑 | Harness 仅作为设计模式参考，不引入完整框架 |
| 多项目 codegraph 实例冲突 | 数据混乱 | CodegraphManager 按 projectRoot 隔离 |
