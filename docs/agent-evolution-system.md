# Agent + Skill 自进化系统

> 混合架构：TypeScript 算法基础设施 + Markdown Skill 工作流
> 基于 ASAEF 五源框架 + EmbodiSkill/SkillEvolver 论文算法实现
> 更新日期：2026-05-27

---

## 一、系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  用户层 (Shell)                                                      │
│  /orion-score, /orion-repair, /orion-crystallize, /orion-review     │
│  /orion-create, /orion-dashboard, /orion-deep-audit                 │
│  (orion-using 决策中枢自动分发上述命令)                               │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ Skill 调用
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Skill 层 (~/.ola-cc/skills/orion-*/)                              │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │ scoring │ │ repairing│ │reviewing │ │crystalliz│               │
│  │ [P55]   │ │ [P58]    │ │ [P57]    │ │ [P59]    │               │
│  └────┬────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘               │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │ assessor│ │gap-detect│ │deep-audit│ │ creating │               │
│  │ [P54]   │ │ [P54]    │ │ [P54]    │ │ [P60]    │               │
│  └─────────┘ └──────────┘ └──────────┘ └──────────┘               │
│                                                                    │
│  每个 Skill 是 Markdown 文件，定义触发条件、工作流步骤、输出格式    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ 程序 API 调用
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TypeScript 基础设施层 (src/tools/AgentTool/ + src/services/)       │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 评分与门控引擎                                                │   │
│  │  rubricEvaluator.ts   — 5维 AND 门控 + 论文综合评分公式        │   │
│  │  maturityPolicy.ts    — draft→tested→hardened→crystallized   │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │ 静态代码审计                                                  │   │
│  │  codeAuditor.ts       — 5项静态分析（AST/白名单/循环/死代码/   │   │
│  │                         复杂度）                              │   │
│  │  orion-deep-audit     — 4项LLM审计（Silent-bypass/约束违反/    │   │
│  │   (skill)               内部矛盾/安全)                        │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │ 执行记录与学习                                                │   │
│  │  LearningSystem.ts    — ExecutionRecord 双缓冲区              │   │
│  │                         contrastAnalysis（winners\losers）     │   │
│  │                         JSONL 持久化                         │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │ Agent 反思分析                                                │   │
│  │  AgentAnalyzer.ts     — analyzeSkillExecution()              │   │
│  │                         四类型反思（Discovery/Optimization/    │   │
│  │                         Defect/Lapse）                       │   │
│  │                         analyzeBatch() 批量合并              │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │ 进化循环状态机                                               │   │
│  │  EvolutionEngine.ts   — ASAEF 8阶段：                         │   │
│  │                         P0→P1→P2→P3→P4→P5→P6→P7→P8          │   │
│  │                         Layer Promotion + Early Stopping     │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │ 持久化                                                       │   │
│  │  storage.ts           — JSONL append-only 存储               │   │
│  │                         防污染 train/test split             │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 设计原理：两层分离

| 层 | 编写语言 | 调用方式 | 职责 |
|----|---------|---------|------|
| **TypeScript 基础设施** | `.ts` | 程序 API | 算法引擎、数据持久化、评分计算、状态机逻辑 |
| **Skill 工作流** | `SKILL.md` | `/orion-*` 命令 | 用户交互、对话式诊断、修复决策、报告展示 |

**为什么要这样分？**

| 不适合放 Skill 的 | 不适合放 TypeScript 的 |
|-------------------|----------------------|
| 需要被程序自动调用的逻辑（如：goal 完成时自动记录 ExecutionRecord） | 需要人类判断的决策（如：确认是否固化技能） |
| 结构化数据操作（JSONL 读写、分数计算） | 对话式诊断和修复方向判断 |
| 状态机流转控制（8阶段不能跳步） | 展示报告给用户 |
| 评分公式（需要精确计算） | 询问用户意图 |

---

## 二、核心组件详解

### 2.1 评分与门控引擎

**文件:** `src/tools/AgentTool/rubricEvaluator.ts`

#### 5维 AND 门控 (`evaluateQuality`)

```typescript
const result = evaluateQuality({
  tokenBudget: 10000,        // token 预算
  tokensUsed: 8500,          // 实际消耗
  baselineTokens: 10000,     // 基线消耗（无 skill 时）
  testResults: [
    { passed: true, name: 'test1', regression: false },
    { passed: true, name: 'test2', regression: false },
  ],
  triggerAccuracy: 0.92,     // 触发准确率
})

result.passed // true = 所有5维通过
result.dimensions.holdout_floor  // 留出集通过率 >= 0.60?
result.dimensions.min_delta      // 改进幅度 >= 0.05?
result.dimensions.trigger_f1     // 触发准确率 >= 0.85?
result.dimensions.cost_budget    // 成本 <= 基线x1.2?
result.dimensions.regression_check // 0回归失败?
```

#### 论文综合评分 (`calculateComprehensiveScore`)

```typescript
// Score(v) = w1 * passRate - w2 * normCost - w3 * overfitRisk
const score = calculateComprehensiveScore(
  0.85,    // passRate
  1.1,     // normCost（实际/基线）
  0.15,    // overfitRisk
)
// score ≈ 68.5
```

#### 配置（环境变量覆盖）

```
RUBRIC_HOLDOUT_FLOOR=0.65    # 默认 0.60
RUBRIC_MIN_DELTA=0.08        # 默认 0.05
RUBRIC_TRIGGER_F1=0.90       # 默认 0.85
RUBRIC_MAX_COST_RATIO=1.5    # 默认 1.2
```

### 2.2 成熟度模型

**文件:** `src/tools/AgentTool/maturityPolicy.ts`

```
draft → tested → hardened → crystallized
```

| 等级 | 条件 | 含义 |
|------|------|------|
| `draft` | 默认 | 刚创建，不够数据评估 |
| `tested` | ≥3次执行，avg≥60 | 有基本使用记录 |
| `hardened` | ≥5次执行，avg≥80，有 edge case | 经过实战检验 |
| `crystallized` | ≥5次执行，avg≥90，有 edge case | 锁定为不可变版本 |

```typescript
const level = getMaturity(executionCount, avgScore, edgeCasesHandled)
// level = 'tested' | 'hardened' | 'crystallized' | 'draft'

const hint = getNextMaturityHint('tested', 3, 75, 0, 'zh')
// hint = "需要记录至少一个 edge case"
```

**配置（环境变量）:**
```
MATURITY_TESTED_RUNS=5       # tested 所需最少执行次数
MATURITY_TESTED_AVG=65       # tested 所需最低平均分
MATURITY_HARDENED_RUNS=8     # hardened 所需最少执行次数
MATURITY_HARDENED_AVG=85     # hardened 所需最低平均分
```

### 2.3 代码审计

**文件:** `src/tools/AgentTool/codeAuditor.ts` + `orion-deep-audit` skill

| 类型 | 检查项 | 位置 | 耗时 |
|------|--------|------|------|
| **静态** | Syntax & Format | `codeAuditor.ts` | 毫秒 |
| **静态** | Hallucinated API | `codeAuditor.ts` | 毫秒 |
| **静态** | Infinite Loop | `codeAuditor.ts` | 毫秒 |
| **静态** | Dead Code | `codeAuditor.ts` | 毫秒 |
| **静态** | Complexity Limit | `codeAuditor.ts` | 毫秒 |
| **LLM** | Silent-bypass | `orion-deep-audit skill` | 秒级 |
| **LLM** | Constraint Violation | `orion-deep-audit skill` | 秒级 |
| **LLM** | Internal Contradiction | `orion-deep-audit skill` | 秒级 |
| **LLM** | Safety / Harmful | `orion-deep-audit skill` | 秒级 |

```typescript
const results = await runAudit(code, 'tsx', {
  apiWhitelist: ['fetch', 'console.log', 'JSON.parse'],
})

const summary = getAuditSummary(results)
// { total: 5, passed: 4, failed: 1, criticalFailures: [...] }
```

### 2.4 学习系统与对比分析

**文件:** `src/tools/AgentTool/LearningSystem.ts`

#### 执行记录

```typescript
const ls = new LearningSystem({ enablePersistence: true })

ls.logExecution({
  skill: 'code-review',
  taskDescription: 'Review PR #123',
  outcome: 'success',
  score: 85,
  signal: { signal_type: 'DISCOVERY', ... },  // 四类型反思结果
  edgeCases: ['网络超时'],
  timestamp: new Date(),
  duration_ms: 5000,
})
```

#### 对比分析（SkillEvolver Algorithm 1 Contrast 步骤）

```typescript
// Δ = winners \ losers
const result = ls.contrastAnalysis('code-review', 20)

result.delta = {
  uniqueToWinners: ['DISCOVERY'],     // 胜者独有的信号
  uniqueToLosers: ['EXECUTION_LAPSE'], // 败者独有的信号
  scoreDelta: 45.2,                    // 平均分差
  winnerCount: 8,
  loserCount: 5,
}
```

#### 持久化

```
~/.ola-cc/singularity/execution-history/<skill-name>.jsonl
```

每行一个 JSON 对象，追加写入。支持 `trainTestSplit()` 按时间划分训练/测试集。

### 2.5 Agent 反思分析

**文件:** `src/tools/AgentTool/AgentAnalyzer.ts`

#### 四类型反思（EmbodiSkill Algorithm 1 SKILLAWAREFLECT）

| 类型 | 触发 | 含义 | 更新目标 |
|------|------|------|---------|
| `DISCOVERY` | 成功轨迹 | 技能缺少必要内容 | SKILL.md 新增 |
| `OPTIMIZATION` | 成功轨迹 | 有更好的实现方式 | SKILL.md 修改 |
| `SKILL_DEFECT` | 失败轨迹 | 技能本身不正确 | SKILL.md 修正 |
| `EXECUTION_LAPSE` | 失败轨迹 | 技能正确但执行者没遵循 | 附录强调 |

```typescript
const result = await analyzer.analyzeSkillExecution(
  'code-review',
  'Review PR #123',
  executionTrace,
  'failure',
  skillContent,
)
// result.signal_type = 'EXECUTION_LAPSE'
```

#### 批量合并（CONSOLIDATEREVISIONS）

```typescript
const consolidated = await analyzer.analyzeBatch('code-review', traces, skillContent)
// 去重 + 优先级合并: SKILL_DEFECT > OPTIMIZATION > DISCOVERY
// EXECUTION_LAPSE 强制分流到附录
```

### 2.6 进化循环状态机

**文件:** `src/services/singularity/EvolutionEngine.ts`

#### 8阶段确定性工作流

```
P0(准备) → P1(回顾) → P2(构思) → P3(修改) → P4(提交) → P5(验证) → P6(门控) → P7(记录) → P8(循环)
```

| Phase | 名称 | 输入 | 输出 |
|-------|------|------|------|
| P0 | 准备 | skill 名称 | 初始化 workspace |
| P1 | 回顾 | 历史快照 | 诊断上下文 |
| P2 | 构思 | trace 证据 | mutation_proposal |
| P3 | 修改 | proposal | patched skill |
| P4 | 提交 | patch | git commit + tag |
| P5 | 验证 | skill | eval_report |
| P6 | 门控 | report | KEEP/DISCARD/ROLLBACK |
| P7 | 记录 | decision | trace.jsonl |
| P8 | 循环 | history | 下一轮 or 终止 |

#### 分层变异

| Layer | 成本 | 修改范围 |
|-------|------|---------|
| L1 | 毫秒级 | description, metadata |
| L2 | 秒级 | body, instruction 逻辑 |
| L3 | 分钟级 | scripts, 工具链 |

**规则:** L1 失败 3 次后升 L2，L2 失败 3 次后升 L3。连续 N 次无改进触发 Early Stopping。

```typescript
const engine = new EvolutionEngine('code-review', {
  maxIterations: 10,
  layerPromotionThreshold: 3,
  earlyStoppingPatience: 5,
})

// 注册各阶段执行器
engine.registerExecutor(EvolutionPhase.P0_PREPARE, myPrepExecutor)
engine.registerExecutor(EvolutionPhase.P5_VERIFY, myVerifyExecutor)
// ...

// 运行到终止
const { finalState, iterationsExecuted } = await engine.runToCompletion()
```

---

## 三、使用方法

### 3.1 日常使用：Skill 命令

| 命令 | 什么时候用 | 效果 |
|------|-----------|------|
| `/orion-score` | 每次 skill 执行后 | 5维评分 + 记录 + 成熟度更新 |
| `/orion-review` | 想了解 skill 健康状态 | 综合报告 + 推荐操作 |
| `/orion-repair` | skill 持续低分 | 诊断 → 分层修复 → 验证 |
| `/orion-crystallize` | skill 稳定高分 | 锁定不可变版本 |
| `/orion-deep-audit` | 需要代码安全审计 | 4项LLM语义审计 |
| `/orion-dashboard` | 想概览所有 skill | 表格 + 告警 |
| `/orion-create` | 需要新 skill | 四步问答创建 |
| `/orion-using` | 自动决策中枢 | 判断是否有匹配 skill → 执行或创建 |
| `/orion-assess` | （orion-scoring 内部调用） | 5维评分引擎，Haiku 模型快速评估 |

> 注: `orion-assess` 和 `orion-gap-detect` 是内部技能，由其他 orion skill 自动调用，用户无需直接触发。

#### 10个 Skill 功能总览

| Skill | 优先级 | trigger 关键词 | 调用关系 |
|-------|--------|---------------|---------|
| `orion-using` | P50 | 需要技能、能力缺口、重复任务 | 入口：自动分发到其他 skill |
| `orion-scoring` | P55 | 评分、打分、skill score | 内部调用 orion-assessor |
| `orion-assessor` | P54 | 评分、评估、assess | 被 orion-scoring 调用（Haiku model） |
| `orion-repairing` | P58 | 修复技能、低分、自动修复 | 独立命令 |
| `orion-reviewing` | P57 | 技能健康、质量审查、成熟度评估 | 独立命令 |
| `orion-crystallizing` | P59 | 固化技能、锁定版本、结晶 | 独立命令 |
| `orion-creating` | P60 | 创建技能、新建技能、能力缺口 | 独立命令 |
| `orion-dashboard` | P56 | 技能总览、仪表盘 | 独立命令 |
| `orion-deep-audit` | P54 | 深层审计、语义审计 | 独立命令 + codeAuditor.ts 补充 |
| `orion-gap-detect` | P54 | 缺口、gap、检测能力 | 被 orion-using/orion-reviewing 调用 |

#### 自动决策流程（orion-using）

当用户提出任务时，`orion-using` 自动运行以下决策：

```
任务到达
  ├── 有匹配 skill？→ 是 → 执行 → /orion-score
  │                        └── avg<50且≥2次 → 建议 /orion-repair
  │                        └── avg≥90且≥5次 → 建议 /orion-crystallize
  │                        └── 否则 → 继续使用
  └── 无匹配 skill？→ 判断是否为可复现需求
       ├── 是 → /orion-create 创建新 skill
       └── 否 → 手动执行
```

#### 评分子流程（orion-score 内部）

```
/orion-score <skill-name>
  Step 1: 确认 skill 已注册 → 未注册则询问是否注册
  Step 2: 调用 orion-assessor 进行5维评分（Haiku model，快速廉价）
  Step 3: 评分写入 score-manager + 计算成熟度
  Step 4: 阈值检查（avg<50→建议修复，avg≥90→建议固化）
  Step 5: 更新 registry
  Step 6: 写入 telemetry
  Step 7: 展示报告
```

#### 修复子流程（orion-repair 内部）

```
/orion-repair <skill-name>
  Step 1: 诊断（读评分历史 + telemetry）
          （可选：检查 LearningSystem 的 contrastAnalysis 数据）
  Step 2: 读当前 SKILL.md
  Step 3: 识别修复目标（按分层策略 L1→L2→L3）
  Step 4: 手术式修复（非全文重写）
  Step 5: 升版本号
  Step 6: 测试（用之前失败的场景）
  Step 7: 评分
  Step 8: 比较（train/test split 防污染）
  Step 9: 写入 telemetry
```

#### 创建子流程（orion-create 内部）

```
/orion-create
  Step 1: 需求收集（逐个问题询问用户）
           ① 这个 skill 做什么？（一句话核心功能）
           ② 什么时候触发？（条件、错误信息）
           ③ 需要什么工具？（Read/Write/Edit/Bash/Agent 等）
           ④ 输出什么？（文件、代码修改、分析结果）
  Step 2: 检查 ~/.ola-cc/singularity/registry.json 确保无重复
  Step 3: 生成 SKILL.md（name 驼峰式 + 动词开头，description 只写触发条件）
  Step 4: 写入 ~/.ola-cc/skills/orion-<name>/SKILL.md
  Step 5: registry.json 注册 + 初始化评分文件
  Step 6: Skill tool 调用验证技能加载
  Step 7: 运行 /orion-score 设基线
  Step 8: telemetry 写入
```

#### 审查子流程（orion-review 内部）

```
/orion-review <skill-name>
  Step 1: 加载数据（评分历史 + registry + telemetry）
  Step 2: 计算健康指标
           - 版本 / 成熟度 / 平均分
           - 趋势（最近3次：上升↑/下降↓/稳定→）
           - 最低维度 / edge cases / 陈旧度
  Step 3: 生成推荐
           趋势下降 → 建议 /orion-repair
           avg<50, ≥2次 → 建议 /orion-repair
           avg≥90, ≥5次, hardened, 有 edge case → 建议 /orion-crystallize
           执行<3 → "需要更多使用数据"
           30天未用 → "技能已过期，检查是否仍相关"
           单维度持续低 → "XX维度是短板，建议针对性修复"
  Step 4: 展示报告（版本 / 成熟度 / 平均分/趋势 / 执行次数 / 最近使用 / edge cases / 各维度平均分 / 最低维度 / 修复次数 / 推荐操作）
```

#### 固化子流程（orion-crystallize 内部）

```
/orion-crystallize <skill-name>
  Step 1: 验证条件
           - avg >= crystallizationThreshold（默认 90）
           - 执行次数 >= 5
           - 至少记录 1 个 edge case
           - 成熟度为 hardened
  Step 2: 用户确认（"准备好固化 XXX vX.X 吗？"）
  Step 3: 创建 Git tag（orion/<skill-name>/vX.X）或备份到
            ~/.ola-cc/singularity/crystallized/<skill-name>/vX.X/
  Step 4: 更新记录（maturity → crystallized）
  Step 5: telemetry 写入
```

#### 仪表盘子流程（orion-dashboard 内部）

```
/orion-dashboard
  Step 1: 加载 registry → 所有 skill 列表
  Step 2: 收集各 skill 数据（评分 + 趋势计算）
  Step 3: 展示表格（Skill | Version | Maturity | Avg | Runs | Trend | Last Used）
  Step 4: 告警
           avg<50且≥2次 → ⚠ 建议 /orion-repair
           avg≥90且≥5次且hardened → ✦ 建议 /orion-crystallize
           30天未用 → ⏳ 审查相关性
  Step 5: 汇总统计
           总数 / draft数 / tested数 / hardened数 / crystallized数
           平均健康分 / 告警数
```

#### 深层审计子流程（orion-deep-audit 内部）

```
/orion-deep-audit
  Step 1: 4项 LLM 语义审计
           ① Silent-bypass — 核心函数是否被绕过
           ② Constraint Violation — 硬性约束是否被违反
           ③ Internal Contradiction — 逻辑矛盾
           ④ Safety / Harmful — 危险操作
  Step 2: 检查后输出（✅PASS / ❌FAIL + 证据）
  Step 3: 汇总报告
```

### 3.2 程序调用：API 使用

```typescript
import { evaluateQuality, calculateComprehensiveScore } from './AgentTool/rubricEvaluator'
import { getMaturity, getNextMaturityHint } from './AgentTool/maturityPolicy'
import { LearningSystem } from './AgentTool/LearningSystem'
import { EvolutionEngine } from '../services/singularity/EvolutionEngine'
import { runAudit } from './AgentTool/codeAuditor'

// 典型调用链路
const ls = new LearningSystem({ enablePersistence: true })

// 1. 执行 skill → 记录
ls.logExecution({ skill, taskDescription, outcome, score, ... })

// 2. 对比分析（积累足够数据后）
const contrast = ls.contrastAnalysis(skill)

// 3. 检查成熟度
const level = getMaturity(execCount, avgScore, edgeCases)

// 4. 5维门控评估
const gate = evaluateQuality({ tokenBudget, tokensUsed, baselineTokens, ... })
```

### 3.3 模型可调用 Tool

除了用户直接使用的 `/orion-*` 命令外，系统还注册了一个可供 AI 模型自动调用的底层工具：

| Tool | 名称 | 功能 |
|------|------|------|
| `agentDetector` | 智能代码检测工具 | 接收 code + fileType，输出5项静态审计 + 可选4项LLM审计 |

**`agentDetector` 内部流程:**

```
model 调用 agentDetector({ code, fileType, runAudit: true })
  │
  ├── 路径 A: runAudit=true（默认）
  │     codeAuditor.runAudit() → 5项静态检查（毫秒级）
  │     + orion-deep-audit skill → 4项LLM检查（秒级）
  │     返回 9 项审计结果的完整报告
  │
  └── 路径 B: runAudit=false（纯 Agent 分析）
        AgentToolSystem.detect() → AgentAnalyzer 意图分析
        + AdaptiveDetector 风险检测
        返回意图 + 风险 + 置信度

system_prompt 中对 agentDetector 的描述:
"智能代码检测工具，替代37个硬编码detector + SkillEvolver 9项审计，
提供意图识别、风险评估和问题检测能力，支持SkillEvolver 9项审计清单"
```

这个 Tool 通过 `src/tools.ts` 注册到工具系统，任何需要代码质量分析的情境下模型都可以自动调用。它整合了 `codeAuditor.ts` 的静态审计和 `AgentToolSystem` 的 Agent 分析两条路径。

### 3.3 数据存储位置

```
~/.ola-cc/
├── singularity/
│   ├── registry.json                  # skill 注册表
│   ├── config.json                    # 阈值配置
│   ├── scores/*.json                  # 评分历史（兼容 singularity-score-v1 schema）
│   ├── execution-history/*.jsonl       # 执行记录（append-only）
│   └── crystallized/*/                # 固化备份
└── skills/orion-*/SKILL.md           # skill 定义
```

---

## 四、设计约束

### 4.1 进化不可逆

- P0→P1→P2→P3→P4→P5→P6→P7→P8 严格顺序
- 禁止跨阶段跳跃
- DISCARD/ROLLBACK 只能回到 P2，不能回 P0

### 4.2 评分必须可追溯

- 所有评分必须有对应的执行轨迹证据
- 评分维度必须区分：技能缺陷 vs 执行失误（EmbodiSkill 核心贡献）
- 对比分析必须在训练集上计算，验证集评估泛化

### 4.3 分层变异成本理性

- 先试 L1（毫秒级），失败升 L2（秒级），再失败升 L3（分钟级）
- 禁止跳层直接修改 scripts/
- 每次修改必须是原子 Patch，非全文重写

### 4.4 防污染

- 训练/测试集按时间分割（默认 80/20）
- workspace 前缀白名单
- Git 隔离：进化在独立 workspace 中进行，不污染主项目

---

## 六、数据流全景：ExecutionRecord 生命周期

```
┌─────────────────────────────────────────────────────────────────────────┐
│  执行开始                                                                │
│                                                                         │
│  ① Skill 被触发 (via Skill tool 或 /orion-* 命令)                        │
│     ↓                                                                   │
│  ② Skill 执行完成 → /orion-score 被调用                                   │
│     ↓                                                                   │
│  ③ orion-assessor (Haiku) 5维评分                                         │
│     ↓                                                                   │
│  ④ ╔═══════════════════════════════════════════════════════╗            │
│    ║   TypeScript: LearningSystem.logExecution()           ║            │
│    ║   如果 AgentAnalyzer 可用还会调用 analyzeSkillExecution ║            │
│    ║   ↓                                                    ║            │
│    ║   ExecutionRecord 写入内存双缓冲区 + JSONL 持久化       ║            │
│    ╚═══════════════════════════════════════════════════════╝            │
│     ↓                                                                   │
│  ⑤ maturityPolicy.getMaturity() 计算新成熟度                              │
│     ↓                                                                   │
│  ⑥ 阈值检查:                                                            │
│     ├── avg<50, ≥2次 → Skill: 建议 /orion-repair                          │
│     ├── avg≥90, ≥5次, hardened → Skill: 建议 /orion-crystallize           │
│     └── 正常 → Skill: 报告当前状态                                        │
│                                                                         │
│  ⑦ 当积累足够数据（≥10条后）:                                            │
│     TypeScript: LearningSystem.contrastAnalysis()                        │
│     输出 Δ = winners \ losers 信号差异                                    │
│     下游: orion-repair 使用此数据诊断根因                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 各阶段数据格式

| 阶段 | 数据格式 | 存储位置 |
|------|---------|---------|
| 评分 | JSON (5维0-100) | `~/.ola-cc/singularity/scores/<skill>.json` |
| 执行记录 | JSONL (追加) | `~/.ola-cc/singularity/execution-history/<skill>.jsonl` |
| 四类型反思 | `StructuredAnalysisResult` | 内存 + 可选持久化 |
| 对比分析 | `ContrastResult { delta, insight }` | 内存计算，不持久化 |
| 门控评估 | `GateResult` | 内存计算，不持久化 |

| 文档 | 位置 |
|------|------|
| ASAEF 五源框架规范 | `docs/skill-evolution-framework-asaef-spec.md` |
| 论文算法对比 | `docs/papers/skill-evolution-algorithms-comparison.md` |
| Singularity 集成分析 | `docs/papers/singularity-claude-integration-analysis.md` |
| 实现路线图 | `docs/implementation-roadmap.md` |
| 设计约束引擎 | `docs/design-constraints/` |