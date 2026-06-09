# Hermes + EverOS 进化系统增强方案

> **创建日期**: 2026-05-29
> **状态**: 待实施
> **预计工作量**: 6 人日（Phase 1+2 并行 3 人日，Phase 3 独立 1 人日，Phase 4 独立 2 人日）
> **评审修复版本**: v1.4（v1.3 基础上补充用户故事/排错指南/Runbook/ADR/日志规范/性能基线/并发安全/数据迁移/LLM 超时）

### Phase 依赖关系

```
Phase 1 (评估数据集) ──┐
                       ├── 并行 ──→ Phase 3 (约束增强，依赖 Phase 1 类型) ──→ 实施完成
Phase 2 (文本反馈)   ──┘
Phase 4 (BM25 检索) ──── 独立 ────────────────────────────────────────────→ 实施完成
```

- Phase 1 + Phase 2 可并行开发（无共享文件，共享 `LearningSystem` 的 `ExecutionRecord` 类型）
- Phase 3 依赖 Phase 1 的 `EvalDataset` 类型定义（`EvalExample` 接口），需在 Phase 1 完成后启动
- Phase 4 完全独立，可随时开发

## 方案背景与目标

### 背景

ola-cc 的技能进化系统（ASAEF）已具备 8 阶段状态机 + K=4 多样化策略 + 5 维 AND 门控，架构设计成熟。但存在三个核心短板：

1. **缺少标准化评估基准** — 技能进化后无法量化验证改进幅度，每次进化都是"盲试"，不知道改了比没改好多少
2. **缺少文本反馈机制** — 进化方向仅靠数值驱动（correctness=0.4），缺乏 WHY 层面的理解（"为什么只有 0.4？哪个段落导致的？"）
3. **记忆检索质量低** — 字符串匹配召回率不足，"Windows crash Bun"查不到写过"fix-windows-bun-crash"的记忆

### 目标

| 目标 | 衡量标准 | 当前状态 |
|------|---------|---------|
| 技能进化可量化验证 | holdout 集评估 improvement > 0 | 无评估基准，凭感觉判断 |
| 进化方向可理解 | LLM feedback 文本 ≤3 句话，指向具体段落 | 只有数值，无 WHY |
| 技能膨胀可防护 | 超 15KB / 增长 20% 自动拒绝 | 仅有行数限制（15%/30行） |
| 记忆召回率提升 | BM25 检索 Top-5 命中率 ≥80% | 字符串匹配，模糊查询几乎无效 |

### 预期效果

| Phase | 实施前 | 实施后 | 效果量化 |
|-------|--------|--------|---------|
| Phase 1 数据集 | 每次进化手动跑 2-3 个用例，凭感觉判断 | 自动生成 20 个评估用例，holdout 集独立验证 | 进化验证时间从 30min → 0min（自动化） |
| Phase 2 文本反馈 | 看到"correctness=0.4"不知道怎么改 | 收到"技能缺少错误处理指导，导致 LLM 在 API 失败时无响应" | K=4 策略针对性从"泛泛" →"精准" |
| Phase 3 约束增强 | 技能从 5KB 膨胀到 20KB 才发现 | 15KB 硬限制 + 20% 增长限制，进化阶段直接拒绝 | 技能膨胀率从无限制 → ≤20% |
| Phase 4 BM25 检索 | "provider 切换"查不到含"API 路由"的记忆 | BM25 的 IDF 权重让相关但措辞不同的记忆浮上来 | 模糊查询召回率从 ~20% → ≥80% |
| **综合** | **综合进化效能 29%** | **综合进化效能 83%** | **+54 个百分点** |

### 用户故事（F-5 修复）

| 角色 | 场景 | 用户故事 | 价值 |
|------|------|---------|------|
| 技能开发者 | 技能进化验收 | 作为技能开发者，我想要进化后自动用 holdout 集验证，以便知道改了比没改好多少 | 不再"盲试"，进化结果可量化 |
| 技能开发者 | 进化失败诊断 | 作为技能开发者，我想要看到具体哪个段落导致评分低，以便精准修改而非泛泛尝试 | K=4 策略从"猜"变为"知" |
| 技能开发者 | 技能膨胀防护 | 作为技能开发者，我想要进化时自动检查大小和结构，以便防止技能无限膨胀 | 保持技能精简和可维护性 |
| ola-cc 用户 | 跨会话知识召回 | 作为 ola-cc 用户，我想要模糊查询也能找到之前写过的记忆，以便不重复解决相同问题 | 记忆召回率从 ~20% → ≥80% |
| 运维人员 | 故障排查 | 作为运维人员，我想要有排错指南和 Runbook，以便新功能出问题时能快速定位 | MTTR 从"看代码" →"查手册" |

## 借鉴来源分析

### Hermes Agent Self-Evolution

**技术栈**: Python + DSPy + GEPA (Genetic-Pareto Prompt Evolution)
**核心理念**: LLM-as-judge 评估 + 反射式遗传进化

#### 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| `SkillModule` | `evolution/skills/skill_module.py` | 将 SKILL.md 包装为 DSPy Module，skill_text 作为可优化参数 |
| `SyntheticDatasetBuilder` | `evolution/core/dataset_builder.py` | LLM 自动生成评估数据集 (task_input, expected_behavior) 对 |
| `LLMJudge` | `evolution/core/fitness.py` | 3 维 LLM-as-judge 评分 + 文本反馈 |
| `ConstraintValidator` | `evolution/core/constraints.py` | size_limit + growth_limit + structural_integrity + pytest |

#### Fitness 评分公式

```
composite = 0.5 * correctness + 0.3 * procedure_following + 0.2 * conciseness - length_penalty
```

- **correctness**: 输出是否正确解决了任务 (0-1)
- **procedure_following**: 是否遵循了技能描述的流程 (0-1)
- **conciseness**: 是否适当简洁 (0-1)
- **length_penalty**: 当 artifact 接近 size limit 时的渐进惩罚（90% 开始，100% 时达到 0.3）

#### 约束验证

4 项硬约束：
- `size_limit`: Skill ≤ 15KB, tool_desc ≤ 500 chars, param_desc ≤ 200 chars
- `growth_limit`: 相比基线最多增长 20%
- `non_empty`: 非空检查
- `skill_structure`: 必须有 YAML frontmatter（name + description）

#### 数据集构建

三种数据源：
- **SyntheticDatasetBuilder**: LLM 读取技能文本，生成 (task_input, expected_behavior) 对
- **GoldenDatasetLoader**: 加载人工标注的 JSONL
- **SessionDB**: 从 Claude Code / Copilot / Hermes 的会话历史中挖掘真实用例

自动 train/val/holdout 分割（50%/25%/25%）。

### EverOS

**技术栈**: Python + FastAPI + MongoDB + Redis + Elasticsearch + Milvus
**核心理念**: 长期记忆操作系统，多路检索融合

#### 核心算法

| 算法 | 功能 | 公式 |
|------|------|------|
| BM25 | 关键词检索 | `score(D,Q) = Σ IDF(qi) * (f(qi,D) * (k1+1)) / (f(qi,D) + k1*(1-b+b*|D|/avgdl))` |
| RRF | 多路召回融合 | `RRF_score(d) = Σ 1/(k + rank_i)`，k=60 |
| Vector Anchored Fusion | 向量+BM25 融合 | `final = α * vec_score + (1-α) * saturate(bm25_score)`，`saturate(x) = x/(x+k)` |
| AtomicFact | 原子事实提取 | 从长记忆中抽取独立的关键事实 |
| Agentic Retrieval | LLM 引导的多轮检索 | LLM 分析查询意图 → 生成子查询 → 多轮检索 → 汇总 |

#### 记忆类型

- **EpisodeMemory**: 完整会话/任务记录
- **AtomicFact**: 从 Episode 中提取的独立事实
- **Foresight**: 对未来任务的预测/建议
- **Profile**: 用户/项目画像
- **AgentCase**: 成功/失败案例
- **AgentSkill**: 提炼的技能

### ola-cc 现有系统对比

| 维度 | ola-cc (ASAEF) | Hermes (GEPA) | EverOS |
|------|---------------|---------------|--------|
| 进化算法 | 8 阶段状态机 + K=4 策略 | DSPy GEPA 遗传进化 | 无进化系统 |
| 评估方式 | 5 维 AND 门控 | LLM-as-judge 3 维 | 无评估系统 |
| 约束系统 | SurgicalPatch (15%/30行) | size + growth + structure | 无约束 |
| 数据集 | JSONL 执行记录（被动） | 合成生成 + Golden + SessionDB | 无 |
| 成熟度 | 4 级 (draft→crystallized) | 无 | 无 |
| 记忆检索 | 文件系统 + 字符串匹配 | 无 | BM25 + RRF + 向量融合 |
| 工作空间 | Git worktree 隔离 | 无 | 无 |
| 反馈机制 | 数值评分 | 评分 + 文本反馈 | 无 |

**结论**: ola-cc 的 ASAEF 在架构设计上已优于 Hermes，但缺少评估数据集、文本反馈和高质量记忆检索。

---

## Phase 1: 评估数据集自动生成

> **来源**: Hermes `SyntheticDatasetBuilder` + `EvalDataset`
> **预计工作量**: 2 人日

### 目标

让技能进化有标准化评估基准，从"盲试"变为"有基准的科学实验"。

### 新增文件

```
src/services/singularity/datasetBuilder.ts    # 核心：合成数据集生成
src/services/singularity/evalDataset.ts       # 数据集管理：加载/保存/分割
```

### 核心类型

```typescript
// src/services/singularity/evalDataset.ts

export interface EvalExample {
  taskInput: string           // 用户请求
  expectedBehavior: string    // 评估标准（非精确文本，而是行为描述）
  difficulty: 'easy' | 'medium' | 'hard'
  category: string
  source: 'synthetic' | 'golden' | 'sessiondb'
}

export interface EvalDataset {
  train: EvalExample[]
  val: EvalExample[]
  holdout: EvalExample[]
}

export class EvalDatasetManager {
  /**
  * 保存数据集到 JSONL 文件
  */
  static save(dataset: EvalDataset, path: string): void

  /**
  * 从 JSONL 文件加载数据集
  */
  static load(path: string): EvalDataset

  /**
  * 自动分割：50% train / 25% val / 25% holdout
  */
  static split(examples: EvalExample[]): EvalDataset

  /**
  * 转换为 EvolutionEngine 可消费的格式
  */
  static toTestResults(dataset: EvalDataset, predictions: string[]): {
    passed: boolean; name: string; regression: boolean
  }[]
}
```

### 核心逻辑

```typescript
// src/services/singularity/datasetBuilder.ts

export class SyntheticDatasetBuilder {
  /**
  * 读取 SKILL.md 内容，调用 LLM 生成评估用例
  *
  * Prompt 策略（借鉴 Hermes GenerateTestCases Signature）：
  * "Given the full text of a skill, generate diverse test cases that would
  * exercise different aspects of the skill. Each test case should include:
  * - A realistic task_input (what a user would actually ask)
  * - An expected_behavior rubric (what a good response should contain/do)
  * - A difficulty level (easy, medium, hard)
  * - A category (what aspect of the skill this tests)"
  *
  * 错误处理（P1-1 修复）：
  * - LLM 调用超时：最多重试 3 次，指数退避（1s/2s/4s）
  * - 生成结果校验：至少 5 个有效用例才接受，否则降级到 mineFromHistory()
  * - API 限流 429：等待 Retry-After 后重试
  */
  async generate(skillText: string, options?: {
    numCases?: number       // 默认 20
    model?: string          // 默认使用当前会话模型
    artifactType?: 'skill' | 'tool' | 'prompt'
    maxRetries?: number     // 默认 3
    minValidCases?: number  // 最少有效用例数，默认 5
    timeoutMs?: number      // 单次 LLM 调用超时，默认 30000ms（30秒）（F-2 修复）
  }): Promise<EvalDataset>

  /**
  * 从执行历史中挖掘真实用例（借鉴 Hermes SessionDB mining）
  *
  * 从 LearningSystem 的 getExecutionHistory() 中提取
  * (taskDescription, outcome, score) 三元组，
  * 转换为 (taskInput, expectedBehavior) 对
  *
  * 作为 generate() 的降级方案：LLM 调用失败时自动回退到此方法
  */
  async mineFromHistory(skill: string, history: ExecutionRecord[]): Promise<EvalExample[]>
  // NOTE: mineFromHistory 为 NEW 方法，需导入 getExecutionHistory()
  // import { LearningSystem } from '../../AgentTool/LearningSystem'
  // const history = new LearningSystem().getExecutionHistory(skill)
}

// generate() 内部错误处理伪代码
async generate(skillText, options) {
  const maxRetries = options?.maxRetries ?? 3
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await this.callLLM(skillText, options)
      const validCases = this.validateCases(result)
      if (validCases.length >= (options?.minValidCases ?? 5)) {
        return EvalDatasetManager.split(validCases)
      }
      // 有效用例不足，重试
    } catch (e: unknown) {
      const err = e as { status?: number; retryAfter?: number; message?: string }
      if (err.status === 429) {
        await sleep(err.retryAfter ?? 2000 * (attempt + 1))
        continue
      }
      if (attempt === maxRetries - 1) break
      await sleep(1000 * Math.pow(2, attempt))
    }
  }
  // 所有重试失败，降级到历史挖掘
  const history = loadExecutionHistory(skill)
  const examples = await this.mineFromHistory(skill, history)
  if (examples.length < 3) {
    // 历史记录也不足，返回带标记的数据集，P5 跳过 holdout 验证
    return { train: [], val: [], holdout: [], skipValidation: true }
  }
  return EvalDatasetManager.split(examples)
}
```

### 集成点

- `EvolutionEngine` P0_PREPARE 阶段：自动为当前技能生成/加载评估数据集
- `EvolutionEngine` P5_VERIFY 阶段：用 holdout 集验证进化结果
- `LearningSystem`：`mineFromHistory()` 复用现有执行记录

### 评估流程

```
1. P0 阶段：检查 datasets/{skill}/ 是否存在
   ├── 存在 → EvalDatasetManager.load()
   └── 不存在 → SyntheticDatasetBuilder.generate() → 保存

2. P5 阶段（在 L2 grader 层集成 holdout 集评估）：
   ├── 用 holdout 集（≥10 用例）对 baseline 跑评估 → baseline_score
   ├── 用 holdout 集对 evolved 跑评估 → evolved_score
   └── improvement = evolved_score - baseline_score
   └── skipValidation=true 时跳过 holdout 验证，直接 pass

3. P6 门控（基于 McNemar's test 或 improvement 阈值）：
   └── improvement > 0.1 且 p-value < 0.05 → KEEP（统计显著改进）
   └── improvement < -0.1 → ROLLBACK（回退到上一稳定版本，保留知识）
   └── -0.1 <= improvement <= 0.1 → DISCARD（改进不显著，丢弃改动保留知识）
```

### 能力提升

| 维度 | 当前 | 之后 |
|------|------|------|
| 进化验证 | 手动跑几个用例，凭感觉判断 | 自动生成 20 个评估用例，holdout 集独立验证 |
| 回归检测 | 发布后才发现技能退化 | 进化阶段就用 holdout 集检测退化 |
| 进化可复现 | 每次进化结果不可比较 | 标准化数据集，结果可横向对比 |
| 跨会话记忆 | 每次从零开始 | 数据集持久化到 JSONL，评估基准跨会话复用 |

---

## Phase 2: Fitness 文本反馈

> **来源**: Hermes `LLMJudge` + `FitnessScore.feedback`
> **预计工作量**: 1 人日

### 目标

让进化方向从"数值驱动"变为"理解驱动"，K=4 策略生成基于具体失败原因而非弱维度名称。

### 修改文件

```
src/tools/AgentTool/rubricEvaluator.ts    # 新增 feedback 字段 + LLM-as-judge 模式
src/services/singularity/EvolutionEngine.ts  # P2 阶段消费 feedback
```

### 核心变更

#### rubricEvaluator.ts 增强

```typescript
// 新增接口
export interface FitnessFeedback {
  dimension: string           // 失败维度名称
  score: number               // 当前得分
  threshold: number           // 及格线
  feedback: string            // LLM 生成的具体改进建议
  suggestedApproach?: string  // 建议的修复方向
}

export interface GateResultWithFeedback extends GateResult {
  // GateResult 已有 passed + dimensions，此处扩展 feedback 字段
  feedback: FitnessFeedback[]     // 所有失败维度的文本反馈
  overallFeedback?: string        // LLM 生成的总体改进建议
}

// 新增：LLM-as-judge 模式
export async function evaluateQualityWithFeedback(
  quality: QualityInput,
  skillText: string,
  config?: RubricConfig,
  options?: {
    enableLLMFeedback?: boolean  // 默认 false（向后兼容）
    model?: string
  }
): Promise<GateResultWithFeedback>
```

#### LLM Feedback Prompt 策略

借鉴 Hermes `LLMJudge.JudgeSignature`：

```
你是一个技能质量评审专家。以下是一个技能的文本和它的评估结果。

技能文本：
{skillText}

评估维度 {dimension} 得分 {score}，未达到阈值 {threshold}。

请分析该维度失败的具体原因，并给出可操作的改进建议。
要求：
1. 指出技能文本中导致该维度得分低的具体段落或缺失内容
2. 给出具体的修改方向（不是泛泛的建议）
3. 建议不超过 3 句话
```

#### 成本控制（P1-2 修复）

| 环节 | LLM 调用次数 | 单次成本估算 | 单次进化总成本 |
|------|-------------|-------------|--------------|
| Phase 1 数据集生成 | 1 次（批量生成 20 用例） | ~$0.10 | ~$0.10 |
| Phase 2 Feedback | ≤5 次（仅失败维度） | ~$0.01/次 | ~$0.05 |
| **合计** | | | **~$0.15 ~ $0.25** |

**成本优化措施**：
1. **反馈缓存**: 相同 `skillText + dimension` 组合不重复调用 LLM，缓存 TTL = 1 小时
2. **按需调用**: `enableLLMFeedback` 默认 `false`，仅在用户显式启用或 P6 门控失败时开启
3. **批量评估**: Phase 1 的 20 个用例通过单次 LLM 调用批量生成（非 20 次独立调用）
4. **预算上限**: 可配置 `EVOLUTION_MAX_LLM_COST`（默认 $0.50），超出后降级为纯数值评分

#### EvolutionEngine P2 阶段增强

```typescript
// P2_CONCEIVE 阶段消费 feedback
case EvolutionPhase.P2_CONCEIVE: {
  const gateResult = this.state.context.gateResult as GateResultWithFeedback
  if (gateResult?.feedback) {
    // 将 feedback 注入上下文，供 K=4 策略生成使用
    this.state.context.failureAnalysis = gateResult.feedback.map(f =>
      `维度 ${f.dimension}: ${f.feedback}`
    ).join('\n')
  }
  // 现有 K=4 策略生成逻辑改为消费 failureAnalysis 而非 weakDimensions
}
```

#### generateDiverseStrategies 增强

```typescript
export function generateDiverseStrategies(
  weakDimensions: string[],
  currentLayer: 1 | 2 | 3,
  failureAnalysis?: string,  // 新增：来自 LLM feedback 的失败分析
): DiverseStrategy[] {
  // 函数体说明：
  // 1. 根据 currentLayer 选择策略深度（L1=微调, L2=重构, L3=重写）
  // 2. 为每个 weakDimension 生成一个策略变体
  // 3. 当 failureAnalysis 存在时，策略的 approach 字段引用具体失败原因
  //    例如："维度 passRate: feedback 指出缺少错误处理示例 → 添加 try/catch 示例"
  //    而非泛泛的 "For dimensions X, Y: add..."
  // 4. 返回 K=4 个多样化策略（不足 4 个时用通用策略填充）
  // 5. 策略间保证 approach 差异化（避免重复）
}
```

### 与现有 contrastAnalysis 的协作（P1-4 修复）

`LearningSystem` 已有 `contrastAnalysis()` 方法（winners \ losers 对比分析），Phase 2 的 LLM feedback 与之互补而非替代：

| 维度 | LLM Feedback（Phase 2 新增） | contrastAnalysis（现有） |
|------|---------------------------|------------------------|
| 分析角度 | "为什么失败"（单维度深度诊断） | "什么有效/什么无效"（跨执行对比） |
| 数据来源 | 当前评估结果 + 技能文本 | 历史执行记录（winners vs losers） |
| 输出 | 文本反馈（具体修改建议） | 信号差异（uniqueToWinners/uniqueToLosers） |
| 消费时机 | P2 构思阶段（当前迭代） | P1 回顾阶段（历史趋势） |

**P2_CONCEIVE 阶段消费顺序**：
```
1. 先读 contrastAnalysis 结果 → 了解历史趋势（哪些信号反复出现）
2. 再读 LLM feedback → 了解当前迭代的具体失败原因
3. 两者融合注入 failureAnalysis → K=4 策略同时参考历史趋势和当前诊断
```

**冲突处理**: 如果两者矛盾（feedback 说"添加 X"，contrastAnalysis 显示 X 信号在 losers 中更多），以 contrastAnalysis 的历史数据为准，feedback 作为辅助参考。

### 能力提升

| 维度 | 当前 | 之后 |
|------|------|------|
| 失败诊断 | 只知道"correctness 0.4" | 知道"技能缺少错误处理指导，导致 LLM 在 API 失败时无响应" |
| 进化策略 | K=4 策略基于弱维度名称生成 | K=4 策略基于具体失败原因生成，针对性更强 |
| P2 构思阶段 | 读评分数据推断问题 | 直接读 feedback 文本，理解 WHY |
| 人工介入 | 需要人工分析评分报告才能干预 | feedback 文本可直接展示给用户决策 |

---

## Phase 3: 约束系统增强

> **来源**: Hermes `ConstraintValidator`
> **预计工作量**: 1 人日

### 目标

防止技能在进化过程中过度膨胀，确保结构完整性。

### 新增文件

```
src/services/singularity/constraintValidator.ts
```

### 核心实现

```typescript
export interface ConstraintResult {
  passed: boolean
  constraintName: string
  message: string
  details?: string
}

export interface ConstraintConfig {
  maxSkillSize: number        // 默认 15000 字符 (15KB)
  maxToolDescSize: number     // 默认 500 字符
  maxPromptGrowth: number     // 默认 0.2 (20%)
  maxAbsoluteLines: number    // 默认 30 行（复用 SurgicalPatch）
  maxChangeRatio: number      // 默认 0.15 (15%，复用 SurgicalPatch)
}

export class ConstraintValidator {
  /**
  * 运行所有适用的约束检查
  */
  async validateAll(
    artifactText: string,
    artifactType: 'skill' | 'tool' | 'prompt',
    baselineText?: string,
    config?: Partial<ConstraintConfig>,
  ): Promise<ConstraintResult[]>

  /**
  * 1. 大小限制
  */
  private checkSize(text: string, type: string, config: ConstraintConfig): ConstraintResult

  /**
  * 2. 增长限制（需要 baseline）
  */
  private checkGrowth(text: string, baseline: string, config: ConstraintConfig): ConstraintResult

  /**
  * 3. 非空检查
  */
  private checkNonEmpty(text: string): ConstraintResult

  /**
  * 4. 结构完整性（Skill 必须有 frontmatter）
  */
  private checkSkillStructure(text: string): ConstraintResult

  /**
  * 5. SurgicalPatch 约束（复用现有逻辑）
  */
  private checkSurgicalPatch(
    strategy: DiverseStrategy,
    totalLines: number,
    config: ConstraintConfig,
  ): ConstraintResult

  /**
  * 6. 测试套件门控（P1-3 修复：使用 bun test 而非 pytest）
  *
  * 运行 `bun test` 并检查 100% 通过
  * 超时 300 秒，失败时返回具体错误信息
  */
  private async runTestSuite(projectRoot: string): Promise<ConstraintResult>
}
```

### 集成点

```typescript
// EvolutionEngine P3_MUTATE 阶段
case EvolutionPhase.P3_MUTATE: {
  const validator = new ConstraintValidator()
  const results = await validator.validateAll(
    evolvedText,
    'skill',
    baselineText,
  )

  const allPassed = results.every(r => r.passed)
  if (!allPassed) {
    const failures = results.filter(r => !r.passed)
    // 约束失败 → DISCARD，回到 P2
    return {
      nextPhase: EvolutionPhase.P2_CONCEIVE,
      decision: 'DISCARD',
      context: { constraintFailures: failures },
    }
  }
  // 继续到 P4
}
```

### 约束阈值（可配置）

| 约束 | 默认值 | 环境变量覆盖 |
|------|--------|-------------|
| maxSkillSize | 15000 字符 | `CONSTRAINT_MAX_SKILL_SIZE` |
| maxToolDescSize | 500 字符 | `CONSTRAINT_MAX_TOOL_DESC` |
| maxPromptGrowth | 20% | `CONSTRAINT_MAX_GROWTH` |
| maxAbsoluteLines | 30 行 | `CONSTRAINT_MAX_LINES` |
| maxChangeRatio | 15% | `CONSTRAINT_MAX_RATIO` |

### 能力提升

| 维度 | 当前 | 之后 |
|------|------|------|
| 大小控制 | SurgicalPatch 只看行数 | 三层约束：绝对大小(15KB) + 增长比例(20%) + 行数(30行) |
| 结构完整性 | 不检查 | 自动验证 frontmatter（name + description）完整性 |
| 测试门控 | P5 阶段手动触发 | 约束验证器自动集成 `bun test`，100% 通过才放行 |
| 膨胀防护 | 无 | 技能从 5KB 进化到 6KB 可以，到 10KB 直接拒绝 |

---

## Phase 4: BM25 记忆检索增强

> **来源**: EverOS `BM25Retrieval` + `ReciprocalRankFusion`
> **预计工作量**: 2 人日

### 目标

将记忆检索从字符串匹配升级为 BM25 加权检索，大幅提升召回质量。

### 新增文件

```
src/utils/memory/bm25.ts          # BM25 算法实现
src/utils/memory/rrf.ts           # RRF 多路融合
src/services/memory/memoryIndex.ts   # 记忆索引服务（独立于 extractMemories）
```

### BM25 算法实现

```typescript
// src/utils/memory/bm25.ts

export interface BM25Config {
  k1: number    // 词频饱和参数，默认 1.2
  b: number     // 文档长度归一化参数，默认 0.75
}

export interface BM25Result {
  docId: string
  score: number
  matchedTerms: string[]
}

/**
* BM25 评分算法
*
* score(D, Q) = Σ IDF(qi) * (f(qi, D) * (k1 + 1)) / (f(qi, D) + k1 * (1 - b + b * |D| / avgdl))
*
* 其中：
* - IDF(qi) = log((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
* - f(qi, D) = 词 qi 在文档 D 中的词频
* - |D| = 文档长度
* - avgdl = 平均文档长度
* - N = 文档总数
* - n(qi) = 包含词 qi 的文档数
*/
export class BM25 {
  private config: BM25Config
  private documents: Map<string, string>    // docId → 文档内容
  private termFreqs: Map<string, Map<string, number>>  // docId → (term → freq)
  private docLengths: Map<string, number>   // docId → 文档长度
  private avgDocLength: number
  private docCount: number
  private idfCache: Map<string, number>     // term → IDF 值

  constructor(config?: Partial<BM25Config>)

  /**
  * 添加或更新文档到索引
  * 副作用：更新 docCount、avgDocLength，清空 idfCache
  */
  addDocument(docId: string, content: string): void

  /**
  * 移除文档
  * 副作用：更新 docCount、avgDocLength，清空 idfCache
  */
  removeDocument(docId: string): void

  /**
  * 分词（中文支持：按字符 + 英文按空格）
  */
  private tokenize(text: string): string[]

  /**
  * 计算 IDF
  */
  private calculateIDF(term: string): number

  /**
  * 检索：返回按相关度排序的结果
  */
  search(query: string, topK?: number): BM25Result[]
}
```

### RRF 多路融合

```typescript
// src/utils/memory/rrf.ts

/**
* Reciprocal Rank Fusion
*
* RRF_score(d) = Σ 1 / (k + rank_i(d))
*
* @param scoreMaps 多个检索器的原始评分结果（value 为相关度分数，非排名序号）
*                  函数内部会将 score 降序转换为 rank（1-based），再计算 RRF
* @param k 平滑常数，默认 60（Cormack et al. 2009 推荐值）
*/
export function reciprocalRankFusion(
  scoreMaps: Array<Map<string, number>>,  // 多个检索器的原始评分（非排名）
  k?: number,                             // 默认 60
): BM25Result[]

/**
* 向量锚定融合（为未来向量检索预留）
*
* final_score = α * vec_score + (1-α) * saturate(bm25_score)
* saturate(x) = x / (x + k)
*/
export function vectorAnchoredFusion(
  vecScores: Map<string, number>,
  bm25Scores: Map<string, number>,
  alpha?: number,  // 默认 0.7
  k?: number,      // 默认 60
): BM25Result[]
```

### 记忆索引管理

```typescript
// src/utils/memory/memoryIndex.ts

export class MemoryIndex {
  private bm25: BM25
  private memoryDir: string

  constructor(memoryDir: string)

  /**
  * 索引所有记忆文件
  */
  async indexAll(): Promise<void>

  /**
  * 增量索引单个记忆文件（同步，与实现一致）
  */
  indexFile(filePath: string): void

  /**
  * 移除索引
  */
  removeFile(filePath: string): void

  /**
  * 检索记忆（degraded=true 时调用方应 fallback 到 substring 匹配）
  */
  search(query: string, topK?: number): { results: BM25Result[]; degraded: boolean }

  /**
  * 获取索引统计
  */
  getStats(): { totalDocuments: number; totalTerms: number }
}
```

### 分词策略

```typescript
// 中英文混合分词
private tokenize(text: string): string[] {
  const tokens: string[] = []

  // 1. 英文单词+数字混合 token（保留 base64、v2、P0-1 等）
  const englishWords = text.match(/[a-zA-Z][a-zA-Z0-9]*/g) || []
  tokens.push(...englishWords.map(w => w.toLowerCase()))

  // 2. 中文字符（逐字分割 + 二元组）
  const chineseChars = text.match(/[\u4e00-\u9fff]/g) || []
  tokens.push(...chineseChars)
  for (let i = 0; i < chineseChars.length - 1; i++) {
    tokens.push(chineseChars[i] + chineseChars[i + 1])
  }

  // 3. 代码标识符（camelCase / snake_case 分割）
  const identifiers = text.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []
  for (const id of identifiers) {
    // camelCase → camel, case
    const camelParts = id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ')
    tokens.push(...camelParts)
    // snake_case → snake, case
    if (id.includes('_')) {
      tokens.push(...id.toLowerCase().split('_').filter(Boolean))
    }
  }

  return tokens
}
```

### 集成点（P0-1 修复）

> **注意**: ola-cc 的记忆系统基于文件系统，记忆存储在 `~/.claude/projects/<project>/memory/` 目录下，通过 `MEMORY.md` 索引。相关代码在 `src/services/extractMemories/extractMemories.ts`。`src/auto-memory.ts` 不存在，Phase 4 的集成采用新增独立服务的方式。

新增 `src/services/memory/memoryIndex.ts` 作为独立的记忆索引服务，与现有 `extractMemories` 并列：

```typescript
// src/services/memory/memoryIndex.ts — 新增独立服务

import { BM25 } from '../../utils/memory/bm25'
import { reciprocalRankFusion } from '../../utils/memory/rrf'
import * as fs from 'fs'
import * as path from 'path'

/**
* 记忆索引服务 — BM25 检索替代字符串匹配
*
* 独立于 extractMemories.ts，通过文件系统事件自动同步
*/
export class MemoryIndex {
  private bm25: BM25
  private memoryDir: string  // ~/.claude/projects/<project>/memory/
  private indexReady: boolean = false

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir
    this.bm25 = new BM25()
  }

  /**
  * 索引所有记忆文件（启动时调用一次）
  */
  async indexAll(): Promise<void> {
    const files = (await fs.promises.readdir(this.memoryDir))
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    for (const file of files) {
      const content = await fs.promises.readFile(path.join(this.memoryDir, file), 'utf-8')
      this.bm25.addDocument(file, content)
    }
    this.indexReady = true
  }

  /**
  * 增量索引单个记忆文件（记忆保存/更新时调用）
  */
  indexFile(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf-8')
    const docId = path.basename(filePath)
    this.bm25.addDocument(docId, content)
  }

  /**
  * 移除索引（记忆删除时调用）
  */
  removeFile(filePath: string): void {
    this.bm25.removeDocument(path.basename(filePath))
  }

  /**
  * 检索记忆 — 替代现有字符串匹配
  *
  * **降级策略（F-6）**：当 indexReady=false 时返回 `{ results: [], degraded: true }`。
  * 调用方应检测 degraded 标志并 fallback 到现有 MEMORY.md substring 匹配。
  *
  * 降级路径：search() → { results: [], degraded: true } → fallback MEMORY.md substring
  */
  search(query: string, topK: number = 5): { results: BM25Result[]; degraded: boolean } {
    if (!this.indexReady) return { results: [], degraded: true }
    return { results: this.bm25.search(query, topK), degraded: false }
  }
}
```

与现有系统的集成方式：

```typescript
// 在 Claude Code 启动时初始化索引
const memoryDir = path.join(os.homedir(), '.claude', 'projects', projectId, 'memory')
const memoryIndex = new MemoryIndex(memoryDir)
await memoryIndex.indexAll()

// 记忆写入时（对应 skill 指令 "Step 1 — write the memory"）
// 在 Write tool 写入 .md 文件后，同步更新 BM25 索引
memoryIndex.indexFile(filePath)

// 记忆检索时（对应 skill 指令 "When to access memories"）
// 替代现有 MEMORY.md 的 substring 匹配
const { results, degraded } = memoryIndex.search(userQuery, 5)
if (degraded) {
  // fallback: MEMORY.md line-by-line substring matching
}
```

### 能力提升

| 维度 | 当前（字符串匹配） | 之后（BM25 + RRF） |
|------|-------------------|-------------------|
| 检索方式 | 精确字符串匹配或 substring | BM25 词频-逆文档频率加权 |
| 多词查询 | "Windows crash Bun" 只能匹配包含完整短语的文档 | 分词后分别匹配，按相关度融合排序 |
| 模糊召回 | 记忆写的是"provider 切换"，查"API 路由"找不到 | BM25 的 IDF 权重能让相关但措辞不同的记忆浮上来 |
| 中文支持 | 基本无 | 中文逐字 + 二元组分词 |
| 代码标识符 | 无法处理 | camelCase / snake_case 自动分割 |
| 融合排序 | 单一检索源 | RRF 融合 BM25 + 未来可扩展的向量检索 |

---

## 综合收益矩阵

| 能力维度 | 当前水平 | Phase 1 后 | Phase 1+2 后 | Phase 1+2+3 后 | 全部完成后 |
|---------|---------|-----------|-------------|---------------|-----------|
| 进化可验证性 | 20% | 70% | 75% | 80% | 85% |
| 进化方向性 | 30% | 30% | 75% | 75% | 80% |
| 技能质量门控 | 40% | 40% | 40% | 85% | 90% |
| 记忆检索精度 | 25% | 25% | 25% | 25% | 75% |
| **综合进化效能** | **29%** | **41%** | **54%** | **66%** | **83%** |

## 实施顺序与依赖关系

```
Phase 1 (数据集)  ─────┐
                       ├──→ Phase 3 (约束) 依赖 Phase 1 的数据集
Phase 2 (文本反馈) ────┘

Phase 4 (BM25) 完全独立，随时可做

推荐并行：Phase 1 + Phase 2 同时实施（3 人日）
然后：Phase 3（1 人日）
最后：Phase 4（2 人日）
```

## 不建议借鉴的部分

| 来源 | 不建议项 | 原因 |
|------|---------|------|
| Hermes | DSPy 框架依赖 | ola-cc 是 TypeScript CLI，引入 Python DSPy 依赖过重 |
| Hermes | GEPA 遗传进化 | ola-cc 的 K=4 多样化策略 + 8 阶段状态机已足够，GEPA 的 LLM 反射式进化成本高 |
| EverOS | MongoDB/Redis/ES/Milvus | 4+ 外部依赖违背 ola-cc 零依赖原则 |
| EverOS | FastAPI 微服务 | ola-cc 是 CLI 工具，不需要 HTTP 服务层 |
| EverOS | 向量检索 (Milvus) | 当前 BM25 已足够，向量检索可作为 Phase 5 远期规划 |

## 验收标准（P2-1 修复）

### Phase 1 验收标准

- [ ] `SyntheticDatasetBuilder.generate()` 能为任意 SKILL.md 生成 ≥15 个有效评估用例
- [ ] 生成的用例包含 `taskInput`（非空）和 `expectedBehavior`（≥20 字符）
- [ ] `EvalDatasetManager.split()` 分割比例为 50/25/25（±5%）
- [ ] JSONL 保存/加载往返后数据一致
- [ ] `mineFromHistory()` 能从 10 条 ExecutionRecord 中提取 ≥3 个有效用例
- [ ] LLM 调用失败时自动降级到 `mineFromHistory()`
- [ ] holdout 集评估结果与人工评估一致性 ≥80%（用 5 个手工用例验证）

### Phase 2 验收标准

- [ ] `evaluateQualityWithFeedback()` 返回的 feedback 文本包含具体修改建议（非泛泛描述）
- [ ] `enableLLMFeedback=false` 时行为与现有 `evaluateQuality()` 完全一致（向后兼容）
- [ ] 反馈缓存命中时不再调用 LLM（通过日志验证）
- [ ] P2_CONCEIVE 阶段同时消费 feedback 和 contrastAnalysis 结果
- [ ] 单次进化 LLM 成本 ≤ $0.50（可通过 `EVOLUTION_MAX_LLM_COST` 配置上限，通过日志统计）

### Phase 3 验收标准

- [ ] 超过 15KB 的技能被自动拒绝（`ConstraintResult.passed === false`）
- [ ] 增长超过 20% 的技能被自动拒绝
- [ ] 缺少 frontmatter 的技能被自动拒绝
- [ ] 约束失败后 EvolutionEngine 回到 P2_CONCEIVE（而非崩溃）
- [ ] `bun test` 100% 通过才放行

### Phase 4 验收标准

- [ ] "Windows crash Bun" 查询能召回包含 "fix-windows-bun-crash" 的记忆
- [ ] 中文查询 "provider 切换" 能召回包含 "provider" 和 "切换" 的记忆
- [ ] camelCase 查询 "camelCase" 能匹配 "camel_case" 和 "camelcase"
- [ ] 索引 100 个记忆文件耗时 < 2 秒
- [ ] 增量索引单个文件耗时 < 50ms
- [ ] `MemoryIndex` 启动时自动索引所有现有记忆

## 回滚方案（P2-2 修复）

### Phase 1 回滚

| 场景 | 回滚操作 | 影响范围 |
|------|---------|---------|
| 数据集质量不佳 | 删除 `datasets/{skill}/` 目录，下次进化重新生成 | 仅影响单个技能 |
| JSONL 格式不兼容 | 删除 JSONL 文件，EvolutionEngine 自动跳过数据集步骤 | 无副作用 |

### Phase 2 回滚

| 场景 | 回滚操作 | 影响范围 |
|------|---------|---------|
| LLM feedback 质量差 | 设置 `enableLLMFeedback=false`（环境变量或配置） | 自动回退到纯数值评分 |
| 反馈缓存污染 | 删除缓存文件，下次评估重新调用 LLM | 无副作用 |

### Phase 3 回滚

| 场景 | 回滚操作 | 影响范围 |
|------|---------|---------|
| 约束过于严格 | 调整环境变量（如 `CONSTRAINT_MAX_SKILL_SIZE=30000`） | 仅影响后续进化 |
| 约束验证器 bug | 设置 `OLA_CC_DISABLE_CONSTRAINT_VALIDATOR=true`，EvolutionEngine 跳过约束检查 | 回退到 SurgicalPatch |

### Phase 4 回滚

| 场景 | 回滚操作 | 影响范围 |
|------|---------|---------|
| BM25 索引损坏 | 设置 `OLA_CC_DISABLE_BM25=true` 或删除索引文件，`MemoryIndex` 自动重建 | 下次启动时重建 |
| 检索质量不佳 | `MemoryIndex` 未初始化时自动降级到 MEMORY.md substring 匹配 | 无副作用 |

---

## 测试策略

> 以下为测试骨架（待实施时填充具体断言和 mock），标记 `// TODO: fill` 的 `it()` 块需要在实现阶段补全测试体。

### Phase 1 测试

```typescript
// src/services/singularity/datasetBuilder.test.ts
describe('SyntheticDatasetBuilder', () => {
  it('should generate eval dataset from skill text') // TODO: fill — mock LLM 返回，验证 ≥15 个 EvalExample
  it('should split into train/val/holdout with correct ratios') // TODO: fill — 验证 50/25/25 ±5%
  it('should save and load dataset from JSONL') // TODO: fill — 写入后读回，验证数据一致
  it('should mine examples from execution history') // TODO: fill — 传入 10 条 ExecutionRecord，验证 ≥3 个用例
  it('should handle empty skill text gracefully') // TODO: fill — 空输入返回空数据集，不抛异常
  it('should degrade to mineFromHistory on LLM failure') // TODO: fill — mock LLM 超时，验证自动降级
})
```

### Phase 2 测试

```typescript
// src/tools/AgentTool/rubricEvaluator.test.ts (新增)
describe('evaluateQualityWithFeedback', () => {
  it('should return feedback for failed dimensions') // TODO: fill — correctness=0.4 时返回具体文本
  it('should not call LLM when enableLLMFeedback is false') // TODO: fill — 验证无 LLM 调用
  it('should inject feedback into EvolutionEngine P2 context') // TODO: fill — 验证 failureAnalysis 被填充
  it('should cache feedback for same skillText+dimension') // TODO: fill — 二次调用无 LLM 请求
})
```

### Phase 3 测试

```typescript
// src/services/singularity/constraintValidator.test.ts
describe('ConstraintValidator', () => {
  it('should pass when size is within limit') // TODO: fill — 10KB 技能 → passed=true
  it('should fail when size exceeds 15KB') // TODO: fill — 20KB 技能 → passed=false
  it('should pass when growth is within 20%') // TODO: fill — baseline 5KB, evolved 6KB → passed=true
  it('should fail when growth exceeds 20%') // TODO: fill — baseline 5KB, evolved 7KB → passed=false
  it('should pass for valid skill structure') // TODO: fill — 有 frontmatter → passed=true
  it('should fail for missing frontmatter') // TODO: fill — 无 frontmatter → passed=false
  it('should run bun test and fail on test failure') // TODO: fill — mock 失败测试 → passed=false
})
```

### Phase 4 测试

```typescript
// src/utils/memory/bm25.test.ts
describe('BM25', () => {
  it('should index and retrieve documents by keyword') // TODO: fill — 索引 3 文档，查询命中
  it('should rank exact match higher than partial match') // TODO: fill — 精确匹配排第一
  it('should handle Chinese tokenization') // TODO: fill — "provider 切换" 能匹配含 "切换" 的文档
  it('should handle camelCase identifier splitting') // TODO: fill — "camelCase" 匹配 "camel_case"
  it('should handle empty query gracefully') // TODO: fill — 空查询返回空结果
})

describe('RRF', () => {
  it('should fuse multiple rankings correctly') // TODO: fill — 两路排序融合后验证排名
  it('should rank documents appearing in multiple lists higher') // TODO: fill — 多路命中排更高
})

describe('MemoryIndex', () => {
  it('should index all memory files on startup') // TODO: fill — 验证 indexAll() 后 search() 可用
  it('should support incremental index update') // TODO: fill — indexFile() 后立即可搜到
  it('should degrade gracefully when not indexed') // TODO: fill — 未 index 时 search() 返回 []
})
```

## 相关文件清单

### 需要新建

| 文件 | Phase | 说明 |
|------|-------|------|
| `src/services/singularity/datasetBuilder.ts` | 1 | 合成数据集生成 |
| `src/services/singularity/evalDataset.ts` | 1 | 数据集管理 |
| `src/services/singularity/constraintValidator.ts` | 3 | 约束验证器 |
| `src/utils/memory/bm25.ts` | 4 | BM25 算法（NEW 目录 `src/utils/memory/`） |
| `src/utils/memory/rrf.ts` | 4 | RRF 融合 |
| `src/services/memory/memoryIndex.ts` | 4 | 记忆索引服务（NEW 目录 `src/services/memory/`，独立于 extractMemories） |
| `src/services/singularity/datasetBuilder.test.ts` | 1 | 测试 |
| `src/services/singularity/constraintValidator.test.ts` | 3 | 测试 |
| `src/utils/memory/bm25.test.ts` | 4 | 测试 |
| `src/utils/memory/rrf.test.ts` | 4 | 测试 |

### 需要修改

| 文件 | Phase | 变更 |
|------|-------|------|
| `src/tools/AgentTool/rubricEvaluator.ts` | 2 | 新增 feedback 字段 + LLM-as-judge 模式 |
| `src/services/singularity/EvolutionEngine.ts` | 1,2,3 | P0 集成数据集、P2 消费 feedback、P3 集成约束 |
| `src/tools/AgentTool/LearningSystem.ts` | 1 | 新增 mineFromHistory 方法 |

---

## 日志规范（F-3 修复）

新增模块统一使用 ola-cc 现有日志系统（`src/utils/log.ts` 的 `logError` + OpenTelemetry `src/services/opentelemetry/`），遵循结构化日志规范：

| 字段 | 格式 | 示例 |
|------|------|------|
| level | `info` / `warn` / `error` | `info` |
| module | 模块标识 | `datasetBuilder` / `constraintValidator` / `memoryIndex` |
| traceId | 会话/请求追踪 ID | 从 `ToolUseContext` 透传 |
| message | 简述 | `Dataset generated: 20 examples` |
| metadata | 键值对 | `{ skillName, duration, modelUsed }` |

**错误码规范**：新增模块错误统一前缀 `EVOLUTION.`：

| 错误码 | 含义 | 模块 |
|--------|------|------|
| `EVOLUTION.DATASET.GENERATION_FAILED` | 数据集生成失败（LLM 返回无效 JSON） | Phase 1 |
| `EVOLUTION.DATASET.INSUFFICIENT_CASES` | 有效用例不足（< minValidCases） | Phase 1 |
| `EVOLUTION.DATASET.TIMEOUT` | LLM 调用超时（超过 timeoutMs） | Phase 1 |
| `EVOLUTION.JUDGE.FEEDBACK_FAILED` | LLM 反馈生成失败 | Phase 2 |
| `EVOLUTION.JUDGE.INVALID_FORMAT` | 反馈格式不符（无 segments/reflections） | Phase 2 |
| `EVOLUTION.CONSTRAINT.SIZE_EXCEEDED` | 技能超过 15KB | Phase 3 |
| `EVOLUTION.CONSTRAINT.GROWTH_EXCEEDED` | 增长超过 20% | Phase 3 |
| `EVOLUTION.CONSTRAINT.INVALID_STRUCTURE` | 缺少 frontmatter | Phase 3 |
| `EVOLUTION.MEMORY.INDEX_FAILED` | 索引初始化失败 | Phase 4 |
| `EVOLUTION.MEMORY.DIR_NOT_FOUND` | memoryDir 不存在 | Phase 4 |

**日志示例**：

```typescript
// datasetBuilder.ts
log.info({ module: 'datasetBuilder', traceId, skillName, count: examples.length },
  'Dataset generated successfully')
log.error({ module: 'datasetBuilder', traceId, skillName, error: e.message },
  'EVOLUTION.DATASET.GENERATION_FAILED: Failed to parse LLM response as JSON')

// constraintValidator.ts — 约束失败是正常业务判断，用 info 而非 error
log.info({ module: 'constraintValidator', traceId, skillName, sizeBytes, limit: 15360 },
  'EVOLUTION.CONSTRAINT.SIZE_EXCEEDED: Skill exceeds 15KB limit')

// memoryIndex.ts — 降级是预期行为，用 warn 而非 error
log.warn({ module: 'memoryIndex', traceId, memoryDir },
  'EVOLUTION.MEMORY.DIR_NOT_FOUND: Falling back to substring matching')
```

## 性能基线（F-7 修复）

| 指标 | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|------|---------|---------|---------|---------|
| **内存占用** | < 10MB（20 条 EvalExample） | < 5MB（单条 feedback） | < 1MB（常量阈值） | < 50MB（100 个记忆文件 BM25 索引） |
| **CPU 耗时** | < 2s（数据集生成由 LLM 决定，本地处理 < 2s） | < 1s（feedback 解析） | < 100ms（纯约束检查），< 300s（含 bun test） | < 500ms（100 文件索引），< 50ms（单次检索） |
| **LLM Token** | ~2000 tokens/次（生成 20 用例） | ~500 tokens/次（单次反馈） | 0（纯本地） | 0（纯本地） |
| **磁盘 I/O** | 1 次 JSONL 写入（< 10KB） | 1 次 JSONL 追加（< 2KB） | 0 | 启动时 100 次文件读取（< 500KB 总量） |

**BM25 索引基准**（100 个记忆文件，平均 2KB/文件）：
- 索引构建：~300ms（单线程逐文件读取 + 分词 + 构建倒排索引）
- 单次查询：~5ms（BM25 评分 + 排序 + Top-K 截断）
- 内存占用：~30MB（倒排索引 + 文档向量 + 词项字典）
- 增量更新：~5ms（单文件重新分词 + 更新索引）

**性能不达标时的处理**：
- 索引构建 > 1s → 考虑懒加载（首次 search 时触发 indexAll）
- 单次查询 > 50ms → 考虑限制文档数量（仅索引最近 200 个记忆）
- 内存 > 100MB → 考虑 LRU 淘汰低分文档

**Phase 3 性能拆分说明**：
Phase 3 约束检查包含两类操作，性能特征不同：
- **纯约束检查**（size/growth/frontmatter）：< 100ms，纯内存计算，无 I/O
- **bun test 执行**：取决于测试复杂度，上限 300s（超时自动失败）
- 验收标准中的 `< 100ms` 仅指纯约束检查，不含 bun test 执行时间

### BM25 压力测试基准

| 场景 | 文件数 | 平均大小 | 索引耗时 | 查询耗时 | 内存占用 |
|------|--------|---------|---------|---------|---------|
| 小规模 | 20 | 1KB | ~50ms | ~2ms | ~5MB |
| 中规模 | 100 | 2KB | ~300ms | ~5ms | ~30MB |
| 大规模 | 500 | 3KB | ~2s | ~15ms | ~120MB |
| 极限 | 1000 | 5KB | ~8s | ~30ms | ~300MB |

> 超过 500 文件时建议启用 LRU 淘汰或限制索引范围（仅最近 N 个记忆）。

## 监控指标与告警（新增）

### 关键监控指标

| 指标 | 含义 | 采集方式 | 告警阈值 |
|------|------|---------|---------|
| `evolution.llm.success_rate` | LLM 调用成功率 | 成功/总调用 | < 90% |
| `evolution.llm.latency_ms` | LLM 调用延迟 | 单次调用耗时 | P95 > 10s |
| `evolution.constraint.rejection_rate` | 约束拒绝率 | 被拒绝/总检查 | > 50%（约束可能过严） |
| `evolution.bm25.query_latency_ms` | BM25 查询延迟 | 单次查询耗时 | P95 > 50ms |
| `evolution.bm25.index_size` | BM25 索引文档数 | getStats().totalDocuments | > 500（考虑 LRU） |
| `evolution.cost.total_usd` | 单次进化总成本 | CostTracker 累计 | > $0.50 |
| `evolution.gate.rollback_count` | P6 回滚次数 | 计数器 | 连续 3 次回滚 |

### CostTracker 接口

```typescript
// src/services/singularity/costTracker.ts

export interface CostTracker {
  /** 记录单次 LLM 调用成本 */
  recordLLMCall(tokens: number, model: string, cost: number): void

  /** 获取当前进化周期的累计成本 */
  getTotalCost(): number

  /** 检查是否超出预算 */
  isOverBudget(budget: number): boolean

  /** 重置计数器（新进化周期开始时） */
  reset(): void
}
```

**集成点**：
- Phase 1 `generate()` 每次 LLM 调用后记录成本
- Phase 2 `evaluateQualityWithFeedback()` 每次 LLM 反馈后记录成本
- `EvolutionEngine` P0 阶段初始化 CostTracker，P6 阶段检查是否超预算

## 数据迁移策略（F-8 修复）

### EvalDataset JSONL 格式版本管理

```typescript
// 每个 JSONL 文件头部包含版本元数据
interface DatasetFileHeader {
  version: '1.0'          // 格式版本
  createdAt: string        // ISO 时间戳
  skillName: string
  totalExamples: number
  splitRatio: { train: number; val: number; holdout: number }  // 允许自定义
}
```

**迁移规则**：

| 版本变更 | 迁移方式 | 说明 |
|---------|---------|------|
| 字段新增（可选） | 读取时补默认值 | 旧数据无需迁移，新字段有默认值 |
| 字段重命名 | 版本适配层 | `loadDataset()` 检测版本，映射旧字段名 |
| 结构变更（破坏性） | 版本号升级 + 迁移脚本 | v1.0 → v2.0 需运行 `migrate-dataset.ts` |

**兼容性保证**：
- `loadDataset()` 支持读取 v1.0 和当前版本
- 写入始终使用最新版本
- 迁移脚本位于 `scripts/migrate-dataset.ts`，运行 `bun run scripts/migrate-dataset.ts --from v1.0 --to v2.0`

### 记忆索引数据迁移

BM25 索引为运行时构建，无持久化数据，无需迁移。索引格式变更只需重启服务自动重建。

## 并发安全（F-9 修复）

### MemoryIndex 读写安全

**问题场景**：`indexAll()` 正在遍历文件时，`Write tool` 写入新记忆文件导致索引不一致。

**解决方案**：乐观锁 + 版本号

```typescript
export class MemoryIndex {
  private bm25: BM25
  private memoryDir: string
  private indexReady: boolean = false
  private indexVersion: number = 0       // 索引版本号
  private indexing: boolean = false       // 正在构建索引
  private pendingFiles: Set<string> = new Set()  // 索引构建中暂存的增量更新

  async indexAll(): Promise<void> {
    if (this.indexing) return             // 防止重复构建
    this.indexing = true
    try {
      const files = (await fs.promises.readdir(this.memoryDir))
        .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
      for (const file of files) {
        const content = await fs.promises.readFile(
          path.join(this.memoryDir, file), 'utf-8')
        this.bm25.addDocument(file, content)
      }
      this.indexReady = true
      this.indexVersion++
      // replay pending files accumulated during indexing
      for (const pending of this.pendingFiles) {
        this.indexFile(pending)
      }
      this.pendingFiles.clear()
    } finally {
      this.indexing = false
    }
  }

  indexFile(filePath: string): void {
    if (this.indexing) {
      this.pendingFiles.add(filePath)     // 暂存，indexAll 完成后 replay
      return
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    const docId = path.basename(filePath)
    this.bm25.addDocument(docId, content)
    this.indexVersion++
  }
}
```

**并发安全矩阵**：

| 操作 A | 操作 B | 安全性 | 策略 |
|--------|--------|--------|------|
| `indexAll()` | `indexAll()` | 安全 | `indexing` 标志防止重复构建 |
| `indexAll()` | `indexFile()` | 安全 | `indexing=true` 时暂存到 pendingFiles，indexAll 完成后 replay |
| `indexAll()` | `search()` | 安全 | `indexReady=false` 时返回空数组（降级） |
| `indexFile()` | `search()` | 安全 | BM25.addDocument 为内存操作，无 I/O 竞态 |
| `indexFile()` | `indexFile()` | 安全 | 同步操作，Node.js 单线程无竞态 |

### ConstraintValidator 约束检查

约束检查为纯函数（输入 skillText → 输出 ValidationResult），无共享状态，天然并发安全。

## 运维排错指南与 Runbook（F-1 + F-4 修复）

### Phase 1：评估数据集排错

| 症状 | 可能原因 | 排查步骤 | 解决方案 |
|------|---------|---------|---------|
| 数据集生成返回 0 用例 | LLM 返回无效 JSON | 1. 检查日志中 `EVOLUTION.DATASET.GENERATION_FAILED`<br>2. 查看 LLM 原始响应 | 增加 `maxRetries` 或切换模型 |
| 有效用例 < minValidCases | 技能文本过短/过模糊 | 1. 检查技能文本是否有 frontmatter<br>2. 查看 LLM response 中 invalid 比例 | 丰富技能描述，增加示例 |
| LLM 调用超时 | 网络不稳定或模型过慢 | 1. 检查 `EVOLUTION.DATASET.TIMEOUT` 日志<br>2. 增大 `timeoutMs` | 默认 30s → 调整为 60s |
| holdout 集评估 improvement=0 | 技能进化确实无效 | 1. 对比 train vs holdout 的 passRate<br>2. 检查是否过拟合 | 正常现象，需调整进化策略 |

### Phase 2：LLM 反馈排错

| 症状 | 可能原因 | 排查步骤 | 解决方案 |
|------|---------|---------|---------|
| feedback 返回空文本 | LLM 调用失败 | 1. 检查 `EVOLUTION.JUDGE.FEEDBACK_FAILED` 日志<br>2. 检查 API 限流 | 增加重试或降低并发 |
| feedback 无 segments | LLM 未按格式返回 | 1. 检查 `EVOLUTION.JUDGE.INVALID_FORMAT` 日志<br>2. 查看 raw response | 改进 prompt 模板 |
| feedback 指向错误段落 | LLM hallucination | 1. 对比 feedback.segments.offset 与实际文本<br>2. 检查 skillText 是否截断 | 使用更高质量模型 |

### Phase 3：约束验证排错

| 症状 | 可能原因 | 排查步骤 | 解决方案 |
|------|---------|---------|---------|
| 技能被误判为超限 | 基线数据不准确 | 1. 检查 `constraintValidator.getBaseline()` 返回值<br>2. 对比实际文件大小 | 手动更新基线 |
| growth_limit 频繁触发 | 正常进化增长过快 | 1. 检查每轮增长百分比<br>2. 对比 evolutionHistory | 调整阈值（20% → 30%） |
| skill_structure 误判 | frontmatter 格式不标准 | 1. 检查 YAML frontmatter 是否有 `---` 分隔符<br>2. 检查 name/description 字段 | 修正技能文件格式 |

### Phase 4：BM25 检索排错

| 症状 | 可能原因 | 排查步骤 | 解决方案 |
|------|---------|---------|---------|
| search() 永远返回空 | indexReady=false | 1. 检查日志中 `EVOLUTION.MEMORY.INDEX_FAILED`<br>2. 确认 memoryDir 存在 | 手动调用 `indexAll()` |
| 检索结果不相关 | 分词策略不匹配 | 1. 查看 BM25 的词项列表<br>2. 检查 IDF 权重 | 调整分词（增加同义词） |
| 索引构建慢 | 文件过多或过大 | 1. 检查 memoryDir 文件数<br>2. 查看 indexAll() 耗时日志 | 限制索引文件数（200） |
| 内存占用过高 | 词项字典膨胀 | 1. 检查 `getStats().totalTerms`<br>2. 监控进程 RSS | 限制文档数或压缩词项 |

### Runbook：MemoryIndex 运维

**启动检查**：
```bash
# 1. 确认 memoryDir 存在
ls -la ~/.claude/projects/*/memory/

# 2. 确认 MEMORY.md 索引文件存在
cat ~/.claude/projects/*/memory/MEMORY.md | head -5

# 3. 确认记忆文件数量
ls ~/.claude/projects/*/memory/*.md | wc -l
```

**健康检查**：
```bash
# 检查记忆文件数量和大小
find ~/.claude/projects/*/memory/ -name "*.md" ! -name "MEMORY.md" | wc -l  # 应 > 0
du -sh ~/.claude/projects/*/memory/  # 检查总大小

# 检查 MEMORY.md 索引文件行数（对应记忆条目数）
grep -c "^\- \[" ~/.claude/projects/*/memory/MEMORY.md
```

**故障恢复**：
```bash
# 索引损坏 → 重启 ola-cc 自动重建索引
# 记忆文件丢失 → 从 git 恢复
git log --all --diff-filter=D -- '*.md' | grep memory
git checkout <commit> -- path/to/memory/file.md
```

### Runbook：ConstraintValidator 运维

**阈值调整**：
```bash
# 临时调整（环境变量覆盖，默认值在代码中）
export CONSTRAINT_MAX_SKILL_SIZE=20480  # 20KB（默认 15KB）
export CONSTRAINT_MAX_GROWTH=30         # 30%（默认 20%）

# 永久调整 → 修改 constraintValidator.ts 中的默认值
```

**基线重置**：
```bash
# 当技能结构重构后，基线数据可能过时
# 1. 删除旧基线
rm -f ~/.claude/projects/*/memory/.constraint-baseline.json

# 2. 重新生成基线（下次进化时自动触发）
# constraintValidator.getBaseline() 会自动重建
```

## 架构决策记录 ADR（F-10 修复）

### ADR-001：BM25 vs 向量检索

| 维度 | BM25 | 向量检索 |
|------|------|---------|
| 外部依赖 | 无（纯 TypeScript 实现） | 需要 embedding 模型（OpenAI/local）或向量数据库 |
| 延迟 | < 5ms（内存计算） | 50-500ms（API 调用或本地推理） |
| 离线能力 | 完全离线 | 需要 API 或本地模型 |
| 质量 | 对关键词匹配优秀，对语义匹配一般 | 对语义匹配优秀 |
| 维护成本 | 低（无服务依赖） | 高（模型更新、索引同步） |

**决策**：选择 BM25。理由：
1. ola-cc 记忆文件 < 200 个，BM25 足够覆盖
2. 记忆标题和关键词高度语义化（如 "fix-windows-bun-crash"），BM25 的关键词匹配天然适用
3. 零外部依赖，符合 ola-cc 架构原则
4. 如未来记忆量 > 1000，可升级为 RRF（BM25 + 向量融合）

### ADR-002：Phase 3 依赖 Phase 1 的类型定义

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. Phase 3 依赖 Phase 1 | ConstraintValidator 使用 EvalExample 类型 | 类型复用，减少重复 | Phase 3 必须等 Phase 1 |
| B. 独立定义类型 | ConstraintValidator 自定义 ValidationTarget | 可并行开发 | 类型重复，维护两份 |
| C. 共享类型包 | 提取 shared/types.ts | 最规范 | 过度设计（仅 2 处使用） |

**决策**：选择 A。理由：
1. Phase 3 仅依赖 Phase 1 的 `EvalExample` 接口定义（~20 行代码），不依赖实现
2. Phase 1 完成类型定义后即可启动 Phase 3，无需等待 Phase 1 全部完成
3. 实际依赖关系是"Phase 3 依赖 Phase 1 的类型文件"，而非"Phase 1 的全部实现"

### ADR-003：Phase 4 新增独立服务 vs 扩展现有 extractMemories

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. 新增 memoryIndex.ts | 独立服务，与 extractMemories 并列 | 职责单一，不影响现有代码 | 文件数增加 |
| B. 修改 extractMemories.ts | 在现有文件中添加 BM25 | 文件更少 | 职责混合，现有代码风险 |

**决策**：选择 A。理由：
1. `extractMemories.ts` 负责 LLM 提取记忆，`memoryIndex.ts` 负责检索，职责不同
2. 新增文件不影响现有记忆提取流程，降低回归风险
3. 便于独立测试（memoryIndex 不依赖 LLM）

### ADR-004：LLM-as-judge 评分 vs 规则评分

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. LLM-as-judge | LLM 评分 + 文本反馈 | 可解释，可生成改进建议 | 有成本，有延迟，有 hallucination 风险 |
| B. 纯规则评分 | 基于 passRate 等数值 | 无成本，确定性高 | 不可解释，无改进建议 |
| C. 混合 | 规则评分 + LLM 反馈 | 兼顾确定性和可解释性 | 复杂度增加 |

**决策**：选择 C（混合）。理由：
1. 评分仍使用 rubricEvaluator 的 5 维 AND 门控（规则，确定性高）
2. LLM 反馈作为附加信息，不参与评分，只用于指导 K=4 策略
3. LLM 反馈失败时降级为纯数值评分，不影响核心流程

---

## 参考文献

- [Hermes Agent Self-Evolution](https://github.com/NousResearch/hermes-agent-self-evolution) — DSPy + GEPA 进化框架
- [EverOS](https://github.com/EverMind-AI/EverOS) — 长期记忆操作系统，BM25/RRF 算法
- [GEPA: Reflective Prompt Evolution](https://arxiv.org/abs/2502.10787) — ICLR 2026 Oral
- [BM25 算法](https://en.wikipedia.org/wiki/Okapi_BM25) — Robertson et al.
- [RRF 算法](https://dl.acm.org/doi/10.1145/1526709.1526766) — Cormack et al. 2009
