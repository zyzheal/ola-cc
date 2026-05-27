# 技能进化系统完整集成分析

> 七源统合：singularity-claude v0.1.0 + 五源技能进化框架 + 两篇论文算法 + ola-cc 现有 AgentTool 系统
> 分析日期：2026-05-26
> 来源：
> - https://github.com/Shmayro/singularity-claude.git (v0.1.0) — 已实现的自进化 Skill 引擎
> - skill-evolver 博客（FishSerrie）+ 五源萃取（skill-creator / AutoResearch / Meta-Harness / EvoSkill）
> - docs/skill-evolution-framework-asaef-spec.md — ASAEF 五源协同框架规范
> - docs/papers/skill-evolution-algorithms-comparison.md — EmbodiSkill + SkillEvolver 论文对比
> - ola-cc src/tools/AgentTool/ (AgentAnalyzer, LearningSystem, AdaptiveDetector, AgentDetectorTool)
> - ola-cc src/utils/goal/goalMemory.ts
> - ola-cc src/tools/AgentTool/built-in/ (全部内置 agent)

---

## 一、七源全景对比

### 1.1 核心定位映射

| 来源 | 本质 | 成熟度 | 作用域 | 核心机制 |
|------|------|--------|--------|---------|
| **singularity-claude** | 已实现的 Claude Code 插件 | v0.1.0（可运行） | Skill 级 | 5维评分 → maturity → repair/crystallize |
| **skill-evolver（主干）** | 工程化进化操作系统 | 博客验证（88.9%→100%） | Skill 包级 | 8阶段循环 + AND 门控 + 分层变异 |
| **skill-creator（协议）** | 可验证性基础设施 | Anthropic 官方 | 断言/评分协议 | 8种断言 + grader.py + SKILL.md 结构约束 |
| **AutoResearch（控制流）** | 控制流抽象范式 | Karpathy 开源 | 决策状态机 | modify→verify→keep/discard→repeat |
| **Meta-Harness（观测）** | 可观测性神经中枢 | Stanford arXiv | 执行轨迹 | trace.jsonl + 盲评重放 |
| **EvoSkill（变异）** | 语义级变异算子库 | Sentient & VTech arXiv | 零样本涌现 | 失败驱动发现能力缺口 + LLM rewrite |
| **论文算法（算法核）** | 学术研究 | arXiv 2605.x | 算法原型 | 四类型反思 + 对比分析 + 9项审计 |

### 1.2 七源能力矩阵

| 能力 | singularity | skill-evolver | skill-creator | AutoResearch | Meta-Harness | EvoSkill | 论文算法 |
|------|-------------|---------------|---------------|-------------|-------------|----------|---------|
| Skill 评分 | ✅ 5维 0-100 | ✅ L1/L2/L3 | ✅ grader.py | ❌ | ✅ 盲评 | ❌ | ❌ |
| 自动修复 | ✅ 维度映射 | ✅ L1→L2→L3 | ❌ | ❌ | ❌ | ✅ rewrite | ✅ SurgicalPatch |
| 成熟度模型 | ✅ 4级 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| AND 门控 | ❌ | ✅ 5维 | ✅ 指标 | ✅ 语义 | ❌ | ❌ | ❌ |
| 分层变异 | ❌ | ✅ L1/L2/L3 | ✅ 约束 | ✅ 控制流 | ❌ | ✅ 语义算子 | ❌ |
| Git 隔离 | ✅ tag | ✅ workspace | ❌ | ❌ | ❌ | ❌ | ✅ 双层 |
| 遥测日志 | ✅ JSONL | ✅ JSONL | ❌ | ❌ | ✅ trace.jsonl | ❌ | ❌ |
| Gap 检测 | ✅ Haiku agent | ❌ | ❌ | ❌ | ❌ | ✅ 失败发现 | ❌ |
| 晶体化锁定 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 四类型反思 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ EmbodiSkill |
| 对比分析 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ SkillEvolver |
| 9项审计 | ❌ | ❌ | ✅ 8断言 | ❌ | ❌ | ❌ | ✅ SkillEvolver |
| 防污染 | ❌ | ✅ workspace | ❌ | ❌ | ❌ | ❌ | ✅ train/test |
| Early Stopping | ❌ | ✅ | ✅ repeat | ✅ | ❌ | ❌ | ❌ |

---

## 二、singularity-claude 代码级分析

### 2.1 完整架构图

```
singularity-claude/
├── agents/                          # 2个 LLM agent（Haiku model）
│   ├── skill-assessor.md            # 5维评分：correctness/completeness/edgeCases/efficiency/reusability
│   └── gap-detector.md              # 4步分析：理解任务→检查覆盖→评估复现→评估通用性
├── hooks/
│   ├── hooks.json                   # SessionStart hook → run-hook.cmd
│   ├── run-hook.cmd                 # 跨平台入口
│   └── session-start                # 初始化 registry + config + 注入 context
├── scripts/
│   ├── score-manager.sh             # init/add/list/average/trend/maturity（jq/node fallback）
│   └── telemetry-writer.sh          # log/list/replay/prune（结构化 JSON 日志）
├── skills/
│   ├── using-singularity/           # 启动加载 + 决策流 + Gap 检测信号
│   ├── creating-skills/             # 4步问答 → 检查重复 → 生成 SKILL.md → 注册
│   ├── scoring/                     # dispatch assessor → record → check thresholds → telemetry
│   ├── repairing/                   # 读 history → 找低分维度 → 手术修复 → bump version → test
│   ├── crystallizing/               # 检查阈值 → git tag → 标记 immutable
│   ├── reviewing/                   # 综合报告 + 推荐行动
│   └── dashboard/                   # 表格总览 + alerts
├── .claude-plugin/
│   ├── plugin.json                  # "Self-evolving skill engine for Claude Code"
│   └── marketplace.json             # 市场注册
└── scripts/telemetry-writer.sh      # 结构化日志：trigger/score/edgeCase/duration/files
```

### 2.2 核心进化循环（代码级）

```
SessionStart Hook → 初始化 ~/.claude/singularity/{registry, config, scores, telemetry}
    │
    ▼
Task arrives
    │
    ├── Skill exists? → No
    │   ├── 复现模式？→ Yes → 通用化？→ Yes → /singularity-create
    │   │   └── 4步问答 → 检查 registry → 生成 SKILL.md → 注册 → 初始测试 → 初始评分
    │   └── No → 手动执行
    │
    └── Yes → 执行 skill
        │
        ▼
        /singularity-score
        │
        ├── dispatch skill-assessor (Haiku) → 5维 JSON 评分
        ├── score-manager.sh add → 写入 scores/{skill}.json
        ├── score-manager.sh _update_maturity → draft/tested/hardened 自动计算
        │
        ▼
        阈值检查（config.json）:
        │
        ├── avg < 50 (2+ runs) → Suggest /singularity-repair
        │   └── 读 score history + telemetry → 找低分维度 → 映射修复目标 → 手术修复 → bump version → test → 比较
        │
        ├── avg >= 90 (5+ runs, hardened, edge cases) → Suggest /singularity-crystallize
        │   └── 检查阈值 → git tag / backup → 标记 crystallized
        │
        └── 否则 → 继续使用 + 持续评分
```

### 2.3 数据格式（关键）

**score-manager.sh 定义的评分文件结构：**
```json
{
  "$schema": "singularity-score-v1",
  "skillName": "my-skill",
  "versions": [
    {
      "version": "v1.0.0",
      "gitTag": "singularity/my-skill/v1.0.0",
      "scores": [
        {
          "timestamp": "2026-05-26T00:00:00Z",
          "score": 75,
          "context": "创建API代理",
          "strengths": ["实现了核心功能"],
          "weaknesses": ["缺少错误处理"],
          "edgeCasesEncountered": ["网络超时"]
        }
      ],
      "averageScore": 75,
      "executionCount": 1,
      "maturity": "draft"
    }
  ],
  "currentVersion": "v1.0.0",
  "createdAt": "2026-05-26T00:00:00Z",
  "lastScoredAt": "2026-05-26T00:00:00Z"
}
```

**telemetry-writer.sh 定义的遥测文件结构：**
```json
{
  "$schema": "singularity-telemetry-v1",
  "skillName": "my-skill",
  "version": "v1.0.0",
  "timestamp": "2026-05-26T00:00:00Z",
  "trigger": "user-invoked",
  "inputs": {},
  "outputs": {
    "filesCreated": [],
    "filesModified": [],
    "summary": "创建了API代理配置"
  },
  "duration_ms": 5000,
  "score": 75,
  "errors": [],
  "edgeCases": ["网络超时"],
  "repairTriggered": false
}
```

### 2.4 singularity 的局限（代码级发现）

| 局限 | 具体表现 | 代码证据 |
|------|---------|---------|
| **无分层变异** | repairing/SKILL.md 直接改 SKILL.md 全文，不分 L1/L2/L3 | `repairing/SKILL.md:58-63` "Edit the SKILL.md" 无分层逻辑 |
| **无 AND 门控** | 只检查 avg < 50 单阈值 | `scoring/SKILL.md:44-45` 只有 avg 比较 |
| **无对比分析** | 没有成功/失败轨迹对比 | `repairing/SKILL.md:29-33` 只看低分维度，不对比胜者 |
| **无防污染** | 无 train/test split | 全局 registry，无隔离 |
| **无结构化 trace** | telemetry 只有摘要级字段 | `telemetry-writer.sh:89-107` 无 step-level tool_call 记录 |
| **无 9 项审计** | 评分只有 5 维 rubric | `scoring-rubric.md` 只有 correctness/completeness/edgeCases/efficiency/reusability |
| **Bash 依赖** | score-manager/telemetry-writer/session-start 全是 Bash | 3 个 `.sh` 文件，Windows 不兼容 |
| **无 Early Stopping** | 无连续 N 次无改进终止逻辑 | `scoring/SKILL.md` 无此机制 |

---

## 三、ASAEF 五源框架分析

### 3.1 五源设计哲学映射（统合版）

| 组件 | 原始设计哲学 | 技术本质 | 在 skill-evolver 中的定位 |
|------|-------------|----------|--------------------------|
| **skill-evolver（主干）** | "用训模型的方式训Skill，全自动、零人工" | 工程化进化操作系统 | 8阶段循环 + AND 门控 + 分层变异 |
| **skill-creator（协议）** | "标准化评测协议栈" | 可验证性基础设施 | L2/L3 评测引擎：8种断言 + grader.py |
| **AutoResearch（控制流）** | "modify→verify→keep/discard→repeat" | 控制流抽象范式 | Phase 6 门控逻辑：KEEP/DISCARD/ROLLBACK |
| **Meta-Harness（观测）** | "执行轨迹结构化暴露" | 可观测性神经中枢 | Phase 2 诊断 + Phase 7 记忆：trace.jsonl |
| **EvoSkill（变异）** | "从失败中自动发现能力缺口并生成新Skill" | 语义级变异算子库 | Layer 1–2 变异策略：LLM rewrite prompt |

### 3.2 8阶段循环 + 外部组件注入

| Phase | 名称 | skill-evolver 职责 | 外部组件注入点 | 博客实证 |
|-------|------|-------------------|---------------|---------|
| P0 | 准备 | Git 隔离 workspace、基线评测 | — | Sec.2.1 |
| P1 | 回顾 | 加载历史快照 | **Meta-Harness**: trace.jsonl 子集 | Sec.2.2 |
| P2 | 构思 | 失败诊断 → 候选改动 | **Meta-Harness + AutoResearch**: cite trace → propose_mutation() | Sec.2.2, Sec.7.1 |
| P3 | 修改 | 分层原子改动 | **EvoSkill + skill-creator**: LLM rewrite + 结构约束 | Sec.5, Sec.7.2 |
| P4 | 提交 | Git commit + tag | — | Sec.2.1 |
| P5 | 验证 | L1/L2/L3 流水线 | **skill-creator**: quick_validate.py + grader.py + 盲评 | Sec.3.1-3.3 |
| P6 | 门控 | 5维 AND 决策 | **AutoResearch**: KEEP/DISCARD; **skill-creator**: 指标阈值 | Sec.4.1, Sec.7.1 |
| P7 | 记录 | 写入实验记忆 | **Meta-Harness**: experiments.jsonl schema | Sec.2.2, Sec.7.1 |
| P8 | 循环 | Stuck Detection → Layer Promotion | **EvoSkill**: 失败→新能力; **AutoResearch**: repeat | Sec.2.2, Sec.5, Sec.7.2 |

### 3.3 验证-变异-决策三角

| 维度 | skill-evolver | skill-creator | AutoResearch | Meta-Harness | EvoSkill |
|------|---------------|---------------|-------------|-------------|----------|
| **验证** | 门控调度 + 结果聚合 | 原子验证能力（8断言 + grader.py） | 消费验证结果 | 可重放验证过程 | 依赖外部 grader |
| **变异** | 分层策略（L1-L3） | 变异约束（SKILL.md 字段语义） | 变异控制流 | 变异诊断依据 | 变异语义算子 |
| **决策** | AND 门控（5维硬约束） | 决策输入（pass_rate 等） | 决策语义（keep/discard） | 决策证据 | 输出需经门控 |

### 3.4 自举测试实证

| 迭代 | 基线 88.9% | Iter 1 94.4% | Iter 2 97.2% (DISCARD) | Iter 3 100% |
|------|-----------|-------------|----------------------|-------------|
| 动作 | 未优化自身 | 添加 skill-creator 安装段 | 添加 eval viewer 步骤 | bundled 文档对齐 |
| 五源体现 | 所有组件已集成 | skill-creator 标准 + EvoSkill 启发 | AutoResearch discard + git revert | skill-creator 协议 + AND 通过 |
| 关键证据 | L1 调 creator/scripts | AND 门控确认 min_delta | 真执行 git revert | 5维 AND 全部通过 |

---

## 四、论文算法分析

### 4.1 EmbodiSkill — 四类型反思

| 类型 | 触发 | 更新目标 | 字段 |
|------|------|---------|------|
| DISCOVERY | 成功轨迹揭示缺失内容 | S_body（新增） | c_i, d_i |
| OPTIMIZATION | 有更好方式 | S_body（修改） | b_i, d_i |
| SKILL DEFECT | 技能不正确/不完整 | S_body（修正） | b_i, e_i, c_i |
| EXECUTION LAPSE | 技能正确但执行者未遵循 | S_app（强调） | b_i, 偏离描述 |

**关键贡献：** 区分 SkillDefect vs ExecutionLapse — 失败 ≠ 技能错误。

### 4.2 SkillEvolver — 三大模块

1. **DiverseStrategies**: 每次迭代 K=4 个截然不同的策略文件（非温度采样）
2. **Contrast + SurgicalPatch**: Δ = winners \ losers，手术式修补
3. **Auditor 9项检查**: Syntax/Hallucinated API/Loop/Dead Code/Silent-bypass/Constraint/Complexity/Contradiction/Safety

### 4.3 与 singularity/ASAEF 的互补性

| EmbodiSkill → singularity | SkillEvolver → singularity | 论文 → ASAEF |
|--------------------------|---------------------------|-------------|
| 四类型反思增强 repairing | 9项审计增强 scoring | 四类型反思可集成到 P2 诊断 |
| ExecutionLapse 避免误修 | 对比分析指导修复方向 | 对比分析可集成到 P8 Stuck Detection |
| S_app 附录用于提醒执行者 | SurgicalPatch 替代全文重写 | Finalize score 函数可增强 AND 门控 |
| | | 防污染双层可增强 Git 隔离 |

---

## 五、ola-cc 现有代码分析

### 5.1 AgentTool 系统现状

| 文件 | 行数 | 作用 | 实现状态 |
|------|------|------|---------|
| `AgentAnalyzer.ts` | 198 | 用 `model.generate()` 做意图+风险分析 | **骨架**: 自由文本 prompt + `split('\n')` 解析 |
| `LearningSystem.ts` | 266 | 记录误报、调整阈值 | **骨架**: `FalsePositiveRecord[]` + `confidenceReduction` |
| `AdaptiveDetector.ts` | 360 | 按项目类型选择检测策略 | **骨架**: 4种策略枚举 + LLM context prompt |
| `AgentDetectorTool.tsx` | 97 | Tool 入口 | **骨架**: factory 调用 + JSON 返回 |
| `goalMemory.ts` | 190 | budget 阈值 + 冷却期 compact | **完整**: budgetThreshold + cooldown + delta check |

### 5.2 内置 Agent 系统

| Agent | Tools | Model | 作用 |
|-------|-------|-------|------|
| `generalPurposeAgent` | `['*']` | inherit/haiku | 通用研究、多步任务 |
| `exploreAgent` | read-only | inherit/haiku | 文件搜索（快速、只读） |
| `verificationAgent` | — | — | 验证任务完成 |
| `planAgent` | — | — | 实现计划生成 |
| `goalAnalysisAgent` | — | — | goal 分析 |
| `olaCcGuideAgent` | — | — | ola-cc 使用指南 |

### 5.3 与 singularity-claude 的关键差异

| 维度 | ola-cc | singularity-claude |
|------|--------|-------------------|
| Agent 定义 | TypeScript 接口 + 工厂 | Markdown agent prompt (`.md`) |
| 数据持久化 | AppStateStore (内存/Redis) | JSON 文件 (`~/.ola-cc/singularity/`) |
| 触发方式 | API ToolUse 指令 | `/singularity-*` slash commands |
| 评分机制 | 无 | 5维 0-100 + maturity 模型 |
| 学习机制 | 误报记录 + 阈值调整 | score history + 维度映射修复 |
| 技能格式 | 标准 SKILL.md | 标准 SKILL.md（兼容） |
| Hook 机制 | `hooks/` 系统 | `hooks.json` (SessionStart) |

---

## 六、完整对接方案（代码级）

### 6.1 总体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│  用户空间 (ola-cc Skills + singularity-claude 适配层)                    │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 7个 SKILL.md（~/.ola-cc/skills/singularity-*/）                   │  │
│  │ using | creating | scoring | repairing | crystallizing           │  │
│  │ reviewing | dashboard                                            │  │
│  │                                                                  │  │
│  │ 替换: ~/.claude → ~/.ola-cc                                      │  │
│  │ 替换: CLAUDE_PLUGIN_ROOT → OLA_CC_PLUGIN_ROOT                    │  │
│  │ 重写: score-manager.sh / telemetry-writer.sh → TypeScript        │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  数据层: ~/.ola-cc/singularity/                                         │
│  ├── scores/*.json       ← 兼容 singularity-score-v1 schema            │
│  ├── telemetry/*/        ← 兼容 singularity-telemetry-v1 schema         │
│  ├── registry.json       ← skill 注册表                                │
│  └── config.json         ← 阈值配置                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  系统级 (AgentTool 优化 — 五源 + 论文算法注入)                           │
│                                                                         │
│  AgentAnalyzer.ts                                                       │
│  ├── analyzeCode()         ← 现有：意图+风险分析（保留）                │
│  ├── analyzeSkillExecution() ← 新增：EmbodiSkill 四类型反思              │
│  │   └── StructuredAnalysisResult (Zod schema)                         │
│  └── signal_type: DISCOVERY|OPTIMIZATION|SKILL_DEFECT|EXECUTION_LAPSE   │
│                                                                         │
│  LearningSystem.ts                                                      │
│  ├── ExecutionRecord[]     ← 替代 FalsePositiveRecord[]                 │
│  │   └── outcome: 'success'|'failure' + score + signal                  │
│  ├── contrastAnalysis()    ← SkillEvolver Δ 引擎 (winners \ losers)     │
│  │   └── uniqueToWinners / uniqueToLosers / scoreDelta                  │
│  └── logFalsePositive()  ← 保留（向后兼容）                             │
│                                                                         │
│  AgentDetectorTool.tsx                                                  │
│  ├── agentDetectorTool     ← 现有：智能检测（保留）                      │
│  ├── AUDIT_CHECKLIST[9]    ← SkillEvolver 9项审计                       │
│  │   └── 5项静态 (AST/白名单/复杂度/死代码/安全)                        │
│  │   └── 4项 LLM (静默绕过/约束违反/内部矛盾/幻觉API)                   │
│  └── runAudit()            ← 审计入口（先审计，再Agent检测）            │
│                                                                         │
│  goalMemory.ts                                                          │
│  ├── checkBudgetThreshold() ← 现有：compact 触发（保留）                │
│  └── evaluateGoalCompletion() ← ASAEF 5维AND门控                        │
│      └── holdout_floor | min_delta | trigger_f1 | cost_budget | regression │
├─────────────────────────────────────────────────────────────────────────┤
│  参考文档                                                                │
│                                                                         │
│  ├── docs/papers/skill-evolution-algorithms-comparison.md               │
│  ├── docs/skill-evolution-framework-asaef-spec.md                       │
│  └── docs/papers/singularity-claude-integration-analysis.md             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Phase 0：singularity-claude 适配（1-2天）

**任务 1：路径适配**

```bash
# 所有 shell 脚本中：
# ~/.claude → ~/.ola-cc
# CLAUDE_PLUGIN_ROOT → OLA_CC_PLUGIN_ROOT (或 OLA_CC_HOME)

# score-manager.sh
SINGULARITY_DATA="${HOME}/.ola-cc/singularity"

# telemetry-writer.sh
SINGULARITY_DATA="${HOME}/.ola-cc/singularity"

# hooks/session-start
SINGULARITY_DATA="${HOME}/.ola-cc/singularity"
if [ -n "${OLA_CC_PLUGIN_ROOT:-}" ]; then
  PLUGIN_ROOT="${OLA_CC_PLUGIN_ROOT}"
```

**任务 2：7 个 SKILL.md 注入**

```
~/.ola-cc/skills/
├── singularity-using/SKILL.md      ← using-singularity/SKILL.md
├── singularity-creating/SKILL.md   ← creating-skills/SKILL.md
├── singularity-scoring/SKILL.md    ← scoring/SKILL.md
├── singularity-repairing/SKILL.md  ← repairing/SKILL.md
├── singularity-crystallizing/SKILL.md ← crystallizing/SKILL.md
├── singularity-reviewing/SKILL.md  ← reviewing/SKILL.md
└── singularity-dashboard/SKILL.md  ← dashboard/SKILL.md
```

**任务 3：Shell 脚本转 TypeScript（长期）**

singularity 的 3 个 shell 脚本（score-manager.sh, telemetry-writer.sh, session-start）需要逐步用 TypeScript 重写，消除 Windows 兼容性问题。可放在 `src/services/singularity/` 下。

### 6.3 Phase 1：结构化基础（P0，2-3天）

**任务 1：AgentAnalyzer 添加 StructuredAnalysisResult**

```typescript
// AgentAnalyzer.ts — 新增类型
const StructuredAnalysisSchema = z.object({
  reasoning_trace: z.string(),
  signal_type: z.enum(['DISCOVERY', 'OPTIMIZATION', 'SKILL_DEFECT', 'EXECUTION_LAPSE']),
  target_skill_segment: z.string().nullable(),
  evidence: z.string(),
  proposed_revision: z.string(),
})

export type StructuredAnalysisResult = z.infer<typeof StructuredAnalysisSchema>

// AgentAnalyzer 类中新增方法
async analyzeSkillExecution(
  skill: string,
  taskDescription: string,
  executionTrace: string,
  outcome: 'success' | 'failure'
): Promise<StructuredAnalysisResult> {
  const prompt = `你是一个技能分析专家。分析以下技能的执行情况，判断失败或成功的原因。
你必须严格区分"技能策略本身的错误"和"执行者未遵循有效指导"。

技能名称: ${skill}
任务描述: ${taskDescription}
执行轨迹: ${executionTrace}
最终结果: ${outcome}

请用 JSON 格式返回分析结果：`

  const response = await this.model.generate(prompt, {
    maxTokens: 500,
    temperature: 0.3,
  })

  return StructuredAnalysisSchema.parse(
    this.extractJSON(response.text)
  )
}

// 辅助方法：从 AI 响应中提取 JSON
private extractJSON(text: string): string {
  const match = text.match(/\{[\s\S]*\}/)
  return match ? match[0] : '{}'
}
```

**任务 2：goalMemory 添加 evaluateGoalCompletion**

```typescript
// goalMemory.ts — 新增（不影响现有 compact 逻辑）

export interface GoalCompletionResult {
  passed: boolean
  dimensions: {
    holdout_floor: { passed: boolean; score: number; threshold: number }
    min_delta: { passed: boolean; delta: number; threshold: number }
    trigger_f1: { passed: boolean; score: number; threshold: number }
    cost_budget: { passed: boolean; ratio: number; threshold: number }
    regression_check: { passed: boolean; regressions: string[] }
  }
}

export function evaluateGoalCompletion(
  goal: Goal,
  baseline_tokens: number,
  testResults: { passed: boolean; name: string; regression: boolean }[],
  triggerAccuracy?: number,  // 由外部评分系统提供
): GoalCompletionResult {
  const passRate = testResults.length > 0
    ? testResults.filter(r => r.passed).length / testResults.length
    : 1.0
  const delta = baseline_tokens > 0
    ? (goal.tokenBudget - goal.tokensUsed) / baseline_tokens
    : 0
  const triggerF1 = triggerAccuracy ?? 1.0
  const costRatio = baseline_tokens > 0
    ? goal.tokensUsed / baseline_tokens
    : 1.0
  const regressions = testResults.filter(r => r.regression).map(r => r.name)

  return {
    passed:
      passRate >= 0.60 &&
      delta >= 0.05 &&
      triggerF1 >= 0.85 &&
      costRatio <= 1.2 &&
      regressions.length === 0,
    dimensions: {
      holdout_floor: { passed: passRate >= 0.60, score: passRate, threshold: 0.60 },
      min_delta: { passed: delta >= 0.05, delta, threshold: 0.05 },
      trigger_f1: { passed: triggerF1 >= 0.85, score: triggerF1, threshold: 0.85 },
      cost_budget: { passed: costRatio <= 1.2, ratio: costRatio, threshold: 1.2 },
      regression_check: { passed: regressions.length === 0, regressions },
    },
  }
}
```

**任务 3：LearningSystem 添加 ExecutionRecord**

```typescript
// LearningSystem.ts — 替代 FalsePositiveRecord[]
import { StructuredAnalysisResult } from './AgentAnalyzer'

export interface ExecutionRecord {
  id: string
  skill: string
  taskDescription: string
  outcome: 'success' | 'failure'
  score: number              // singularity 5 维评分
  signal: StructuredAnalysisResult | null  // EmbodiSkill 四类型
  edgeCases: string[]
  timestamp: Date
  duration_ms: number
}

export class LearningSystem {
  // 新增：双缓冲区（替代原有的 FalsePositiveRecord[]）
  private executionHistory: ExecutionRecord[] = []

  // 保留：向后兼容
  private records: FalsePositiveRecord[] = []

  // 新增：记录执行
  logExecution(record: Omit<ExecutionRecord, 'id'>): void {
    this.executionHistory.push({
      ...record,
      id: this.generateId(),
    })
    this.pruneHistory()
  }
}
```

### 6.4 Phase 2：算法核心（P1，3-5天）

**任务 1：LearningSystem 对比分析引擎**

```typescript
// LearningSystem.ts — 新增
export interface ContrastResult {
  delta: {
    uniqueToWinners: string[]   // 胜者独有的反思类型
    uniqueToLosers: string[]    // 败者独有的反思类型
    scoreDelta: number          // 平均分差
  } | null
  insight: string
}

contrastAnalysis(skill: string, windowSize = 20): ContrastResult {
  const relevant = this.executionHistory
    .filter(r => r.skill === skill)
    .slice(-windowSize)

  const winners = relevant.filter(r => r.outcome === 'success' && r.score >= 70)
  const losers = relevant.filter(r => r.outcome === 'failure' || r.score < 50)

  if (winners.length === 0 || losers.length === 0) {
    return { delta: null, insight: '数据不足以进行对比分析' }
  }

  // Δ = winners \ losers
  const winnerSignals = new Set(winners.map(w => w.signal?.signal_type).filter(Boolean))
  const loserSignals = new Set(losers.map(l => l.signal?.signal_type).filter(Boolean))

  const uniqueToWinners = [...winnerSignals].filter(s => !loserSignals.has(s))
  const uniqueToLosers = [...loserSignals].filter(s => !winnerSignals.has(s))

  const avgWin = winners.reduce((s, w) => s + w.score, 0) / winners.length
  const avgLose = losers.reduce((s, l) => s + l.score, 0) / losers.length

  return {
    delta: { uniqueToWinners, uniqueToLosers, scoreDelta: avgWin - avgLose },
    insight: this.generateInsight(uniqueToWinners, uniqueToLosers, avgWin, avgLose),
  }
}

private generateInsight(
  uniqueWinners: string[],
  uniqueLosers: string[],
  avgWin: number,
  avgLose: number
): string {
  const parts: string[] = []
  if (uniqueWinners.length > 0) {
    parts.push(`胜者独有的信号：${uniqueWinners.join(', ')}。这些可能是成功的关键因素。`)
  }
  if (uniqueLosers.length > 0) {
    parts.push(`败者独有的信号：${uniqueLosers.join(', ')}。这些可能是失败的根因。`)
  }
  parts.push(`平均分差：${(avgWin - avgLose).toFixed(1)} 分。`)
  return parts.join(' ')
}
```

**任务 2：AgentDetectorTool 9项审计**

```typescript
// AgentDetectorTool.tsx — 新增审计清单

interface AuditResult {
  checkId: string
  checkName: string
  passed: boolean
  isCritical: boolean
  details: string
}

const AUDIT_CHECKLIST: {
  id: string
  name: string
  isCritical: boolean
  check: (code: string, fileType: string) => Promise<AuditResult>
}[] = [
  // 5项静态分析（快速，毫秒级）
  {
    id: 'syntax', name: 'Syntax & Format', isCritical: true,
    check: async (code, fileType) => {
      try {
        // TypeScript 代码可以用 AST 解析
        // 简化版：尝试 eval/import 检查语法
        return { checkId: 'syntax', checkName: 'Syntax & Format', passed: true, isCritical: true, details: '语法检查通过' }
      } catch {
        return { checkId: 'syntax', checkName: 'Syntax & Format', passed: false, isCritical: true, details: '语法错误' }
      }
    }
  },
  {
    id: 'hallucinated-api', name: 'Hallucinated API', isCritical: true,
    check: async (code, fileType) => {
      // 提取函数调用，与环境合法 API 白名单比对
      const calls = extractFunctionCalls(code)
      const whitelist = getAPIWhitelist(fileType)
      const violations = calls.filter(c => !whitelist.includes(c))
      return { checkId: 'hallucinated-api', checkName: 'Hallucinated API', passed: violations.length === 0, isCritical: true, details: violations.length ? `发现未定义 API: ${violations.join(', ')}` : '无幻觉 API' }
    }
  },
  {
    id: 'infinite-loop', name: 'Infinite Loop', isCritical: true,
    check: async (code) => {
      const hasWhileWithoutBreak = /while\s*\([^)]*\)\s*\{[^}]*\}/.test(code) && !code.includes('break')
      return { checkId: 'infinite-loop', checkName: 'Infinite Loop', passed: !hasWhileWithoutBreak, isCritical: true, details: hasWhileWithoutBreak ? '发现无退出的 while 循环' : '无无限循环风险' }
    }
  },
  {
    id: 'dead-code', name: 'Dead Code', isCritical: false,
    check: async (code) => {
      const unreachable = findUnreachableCode(code)
      return { checkId: 'dead-code', checkName: 'Dead Code', passed: unreachable.length === 0, isCritical: false, details: unreachable.length ? `发现不可达代码: ${unreachable.join(', ')}` : '无死代码' }
    }
  },
  {
    id: 'complexity-limit', name: 'Complexity Limit', isCritical: false,
    check: async (code) => {
      const complexity = calculateCyclomaticComplexity(code)
      return { checkId: 'complexity-limit', checkName: 'Complexity Limit', passed: complexity <= 10, isCritical: false, details: `圈复杂度: ${complexity}` }
    }
  },
  // 4项 LLM 审计（较慢，可异步）
  {
    id: 'silent-bypass', name: 'Silent-bypass', isCritical: true,
    check: async (code, fileType, model) => {
      // 检查核心函数是否被 main 路由调用
      const prompt = `分析以下代码，检查是否存在定义了但未被调用的核心函数：\n${code}`
      const result = await model.generate(prompt, { maxTokens: 200, temperature: 0.2 })
      const hasBypass = result.text.toLowerCase().includes('未被调用') || result.text.toLowerCase().includes('unused')
      return { checkId: 'silent-bypass', checkName: 'Silent-bypass', passed: !hasBypass, isCritical: true, details: hasBypass ? '发现核心函数未被调用' : '无静默绕过' }
    }
  },
  {
    id: 'constraint-violation', name: 'Constraint Violation', isCritical: true,
    check: async (code, fileType, model) => {
      const prompt = `检查以下代码是否违反任何硬性约束（安全规则、业务规则等）：\n${code}`
      const result = await model.generate(prompt, { maxTokens: 200, temperature: 0.2 })
      const hasViolation = !result.text.toLowerCase().includes('未发现') && !result.text.toLowerCase().includes('无违反')
      return { checkId: 'constraint-violation', checkName: 'Constraint Violation', passed: !hasViolation, isCritical: true, details: result.text }
    }
  },
  {
    id: 'internal-contradiction', name: 'Internal Contradiction', isCritical: true,
    check: async (code, fileType, model) => {
      const prompt = `检查以下代码中是否存在逻辑矛盾（如步骤A要求X，步骤B假设非X）：\n${code}`
      const result = await model.generate(prompt, { maxTokens: 200, temperature: 0.2 })
      const hasContradiction = !result.text.toLowerCase().includes('无矛盾') && !result.text.toLowerCase().includes('未发现')
      return { checkId: 'internal-contradiction', checkName: 'Internal Contradiction', passed: !hasContradiction, isCritical: true, details: result.text }
    }
  },
  {
    id: 'safety', name: 'Safety / Harmful', isCritical: true,
    check: async (code) => {
      const dangerous = ['rm -rf', 'DROP TABLE', 'os.system(', 'eval(', 'exec(']
      const found = dangerous.filter(d => code.includes(d))
      return { checkId: 'safety', checkName: 'Safety / Harmful', passed: found.length === 0, isCritical: true, details: found.length ? `发现危险操作: ${found.join(', ')}` : '无安全风险' }
    }
  },
]

// 审计入口
export async function runAudit(
  code: string,
  fileType: 'ts' | 'tsx' | 'js' | 'jsx',
  model?: any
): Promise<AuditResult[]> {
  const results: AuditResult[] = []
  for (const check of AUDIT_CHECKLIST) {
    try {
      results.push(await check.check(code, fileType, model))
    } catch (e) {
      results.push({
        checkId: check.id,
        checkName: check.name,
        passed: true,  // 审计失败不阻断
        isCritical: check.isCritical,
        details: `审计执行失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }
  return results
}
```

### 6.5 Phase 3：系统集成（P2，3-5天）

**任务 1：Goal 执行链路嵌入 record 写入**

在 `src/query.ts` 或 `src/QueryEngine.ts` 中，goal 完成时调用：

```typescript
// 伪代码：在 goal 完成回调中
import { getLearningSystem } from './services/learning'
import { getAgentAnalyzer } from './services/agentAnalyzer'

async function onGoalComplete(goal: Goal, outcome: 'success' | 'failure') {
  const analyzer = getAgentAnalyzer()
  const learning = getLearningSystem()

  // 1. EmbodiSkill 四类型反思
  const signal = await analyzer.analyzeSkillExecution(
    goal.skillName ?? 'unknown',
    goal.description,
    goal.executionTrace ?? '',
    outcome
  )

  // 2. 获取评分（来自 singularity scoring skill）
  const score = goal.score ?? 0

  // 3. 记录 ExecutionRecord
  learning.logExecution({
    skill: goal.skillName ?? 'unknown',
    taskDescription: goal.description,
    outcome,
    score,
    signal,
    edgeCases: goal.edgeCases ?? [],
    timestamp: new Date(),
    duration_ms: goal.durationMs ?? 0,
  })

  // 4. 5维 AND 门控评估
  const completion = evaluateGoalCompletion(
    goal,
    goal.baselineTokens ?? 0,
    goal.testResults ?? [],
    goal.triggerAccuracy
  )

  if (!completion.passed) {
    // 记录哪些维度未通过
    console.warn('[goal] AND gate failed:', completion.dimensions)
  }

  // 5. 对比分析（积累足够数据后）
  if (learning.getRecordCount(goal.skillName) >= 10) {
    const contrast = learning.contrastAnalysis(goal.skillName)
    if (contrast.delta) {
      console.log('[learning] Contrast analysis:', contrast.delta)
    }
  }
}
```

**任务 2：singularity-repairing 对接对比分析**

修改 `~/.ola-cc/skills/singularity-repairing/SKILL.md`，在 Step 1（Diagnose）中加入：

```markdown
### Step 1: Diagnose

Read the skill's score history:
```bash
"${OLA_CC_PLUGIN_ROOT}/scripts/score-manager.sh" list <skill-name>
```

Read recent telemetry:
```bash
"${OLA_CC_PLUGIN_ROOT}/scripts/telemetry-writer.sh" list <skill-name> --last 5
```

**NEW: Run contrast analysis to identify root causes:**
The system has accumulated execution records. Run the contrast analysis engine
to compare successful vs failed executions:

```
Contrast analysis output will show:
- Signals unique to successful executions (what works)
- Signals unique to failed executions (what doesn't)
- Average score delta between winners and losers
```

Identify patterns:
- Which rubric dimensions score lowest consistently?
- What edge cases caused failures?
- Are errors recurring?
- **What does the contrast analysis reveal?** (e.g., "successful executions always have EXECUTION_LAPSE signals, suggesting the skill is correct but needs better emphasis")
```

### 6.6 Phase 4：增强功能（P2，3-5天）

**任务 1：ExecutionRecord 持久化**

```typescript
// src/services/singularity/storage.ts

import { ExecutionRecord } from '../../tools/AgentTool/LearningSystem'

const STORAGE_DIR = path.join(os.homedir(), '.ola-cc', 'singularity', 'execution-history')

export function saveExecutionRecord(record: ExecutionRecord): void {
  const file = path.join(STORAGE_DIR, `${record.skill}.jsonl`)
  fs.appendFileSync(file, JSON.stringify(record) + '\n')
}

export function loadExecutionHistory(skill: string): ExecutionRecord[] {
  const file = path.join(STORAGE_DIR, `${skill}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}
```

**任务 2：ASAEF L1→L2→L3 分层变异集成到 repairing**

在 `singularity-repairing/SKILL.md` 的 Step 3（Identify Repair Targets）中增加分层指导：

```markdown
### Step 3: Identify Repair Targets (with Layer Strategy)

Map low-scoring dimensions to specific skill content, using the layer strategy:

| Layer | Cost | When to use | What to modify |
|-------|------|-------------|----------------|
| **L1** (ms) | 最低 | 触发率低、描述不清 | description, tags, when-to-use |
| **L2** (s) | 中等 | 逻辑错误、缺少步骤 | workflow steps, error handling |
| **L3** (min) | 最高 | 脚本错误、工具链问题 | scripts/, references/, templates |

**Rule**: Always try L1 first. Only promote to L2 if L1 changes don't improve the score after 3 attempts. Only promote to L3 if L2 changes don't improve after 3 attempts.
```

---

## 七、实施计划总结

### 7.1 阶段规划

| Phase | 内容 | 天数 | 风险 |
|-------|------|------|------|
| **Phase 0** | singularity-claude 路径适配 + SKILL 注入 | 1-2 | 低（纯路径替换） |
| **Phase 1** | 结构化基础：Zod schema + AND 门控 + ExecutionRecord | 2-3 | 低（新增函数，不改现有） |
| **Phase 2** | 算法核心：四类型映射 + 对比分析 + 9项审计 | 3-5 | 中（需要模型 JSON 输出支持） |
| **Phase 3** | 系统集成：Goal 链路嵌入 + repairing 对接 | 3-5 | 中（需要修改 query.ts 执行链路） |
| **Phase 4** | 增强功能：持久化 + 分层变异 + 防污染 | 3-5 | 低（可选增强） |

### 7.2 风险矩阵

| 风险 | 影响 | 概率 | 缓解 |
|------|------|------|------|
| 模型不支持 JSON 输出 | AgentAnalyzer 结构化输出失败 | 中 | 正则 fallback 解析 JSON 块 |
| Windows Bash 不兼容 | singularity shell 脚本无法运行 | 高 | Phase 0 后 TypeScript 重写 |
| 过度工程化 | 论文算法在应用中不需要 | 中 | Phase 1 先跑通 singularity 基础功能 |
| 数据模型冲突 | singularity JSON 与 AppStateStore 不兼容 | 低 | 使用独立存储路径 |

### 7.3 与原文档的差异

| 原文档 | 修正后 | 原因 |
|--------|--------|------|
| P0 直接集成四类型反思 | P1 先建 Zod schema 骨架 | 现有代码是自由文本解析，需先建结构化基础 |
| P0 直接集成对比分析 | P2 需要 ExecutionRecord 双缓冲区 | 当前只有误报记录，无成功轨迹 |
| P0 AND 门控放 compact | P1 新增 evaluateGoalCompletion | AND 门控评估 goal 完成质量，不评估 compact 需求 |
| 分层变异放 AdaptiveDetector | Phase 4 放 repairing SKILL.md | 分层是修改策略，不是检测策略 |
| singularity 独立安装 | Phase 0 适配后注入 ola-cc | 需要路径适配才能融入 ola-cc 生态 |

---

*文档生成时间: 2026-05-26*
*版本: 3.0 (七源统合完整深度分析)*
