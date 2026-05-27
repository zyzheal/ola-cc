# AI 技能自动化演进框架 (ASAEF) 设计规范

> 基于五源技术萃取：skill-evolver, skill-creator, AutoResearch, Meta-Harness, EvoSkill
> 版本：1.0.0 | 生成日期：2026-05-26

---

## 一、 框架愿景与四大设计公理
本框架不依赖人工调参或启发式试错，而是将 ML 训练范式（Data→Loss→Optimization→Checkpoint→Early Stopping）完整映射至 Skill 优化场景，确立四条不可妥协的工程公理：

| 公理 | 核心定义 | 工程约束 |
|:---|:---|:---|
| **1. GT即契约** | `evals.json` 不是测试集，而是 Skill 与系统间的形式化服务契约 | 违约即 Discard，无协商余地；所有断言必须可程序化验证 |
| **2. 演化即控制流** | 进化不是随机搜索，而是确定性状态机（DAG） | 每个阶段有明确定义的 I/O 与副作用，禁止跨阶段跳跃 |
| **3. 可观测即诊断力** | 拒绝黑箱猜测，失败必须可索引、可关联、可重放 | 全量输出 `trace.jsonl`，诊断必须引用具体 step/tool_call |
| **4. 分层即成本理性** | 变异策略按计算成本严格排序，先轻后重 | L1(desc/metadata) → L2(body/instruction) → L3(scripts/code)，成本升序 |

---

## 二、 五源协同架构分层
框架采用**"编排层驱动 + 能力层注入"**的插件化架构，五组件按职责解耦：

| 架构层 | 对应组件 | 核心职责 | 框架注入点 |
|:---|:---|:---|:---|
| **编排层 (Orchestrator)** | `skill-evolver` | 8阶段循环调度、AND门控决策、Git隔离与回滚、分层晋升 | 框架主干：定义状态机、门控规则、循环终止条件 |
| **协议层 (Protocol)** | `skill-creator` | 8种断言类型、`grader.py` 混合评分、`SKILL.md` 结构约束 | L2/L3 评测引擎：提供标准化验证接口与评分 Schema |
| **控制层 (Controller)** | `AutoResearch` | `modify → verify → keep/discard` 状态机语义 | Phase 6 门控逻辑：提供决策状态转移与防死循环机制 |
| **观测层 (Telemetry)** | `Meta-Harness` | 执行轨迹结构化暴露 (`trace.jsonl`)、盲评重放 | Phase 2 诊断与 Phase 7 记忆：提供 step-level 证据链 |
| **变异层 (Mutator)** | `EvoSkill` | 失败驱动的能力缺口发现、LLM 语义级 Rewrite | Phase 3 原子改动：提供 Prompt 工程算子与零样本生成策略 |

---

## 三、 确定性工作流：8阶段进化循环
框架执行严格的时序编排，各阶段输入/输出/副作用明确定义：

| Phase | 名称 | 关键动作 | 输入/输出 | 外部组件注入 |
|:---|:---|:---|:---|:---|
| **P0** | 准备 | 创建 Git 隔离 workspace、加载 `evolve_plan.md`、跑基线 | Out: `baseline_score.json` | — |
| **P1** | 回顾 | 读取 `results.tsv`, `experiments.jsonl`, `git log` | In: 历史快照 Out: 诊断上下文 | Meta-Harness 提供结构化轨迹子集 |
| **P2** | 构思 | `cite trace evidence` → 分析失败模式 → 生成候选改动 | In: Trace Out: `mutation_proposal.yaml` | AutoResearch 提供 `propose_mutation()` 语义 |
| **P3** | 修改 | 执行分层原子改动（L1/L2/L3），遵守字段约束 | In: Proposal Out: Patched Skill Dir | EvoSkill 提供 Rewrite 算子；Creator 提供结构约束 |
| **P4** | 提交 | Git commit + tag（如 `evolve/iter-3-layer2`） | Side-effect: Version snapshot | — |
| **P5** | 验证 | 三层评测流水线：L1(quick) → L2(grader) → L3(blind) | In: Skill Out: `eval_report.json` | Creator 提供断言协议与评分脚本 |
| **P6** | 门控 | 5维 AND 决策：质量↑、触发↑、F1↑、成本↓、无回归 | In: Report Out: `KEEP` / `DISCARD` / `ROLLBACK` | AutoResearch 提供状态机；Creator 提供指标阈值 |
| **P7** | 记录 | 写入实验记忆，生成结构化 telemetry | Side-effect: `results.tsv` + `trace.jsonl` | Meta-Harness 定义字段 Schema |
| **P8** | 循环 | Stuck Detection → Layer Promotion → Early Stopping | In: History Out: Next Phase 或 Terminate | EvoSkill 提供失败→新能力映射逻辑 |

---

## 四、 核心算法引擎：验证-变异-决策三角

###  1. 验证引擎 (Verification)
- **三级流水线**：
  - `L1`：秒级语法/结构检查（`quick_validate.py`）
  - `L2`：确定性+LLM混合评分（`grader.py` 输出结构化分数）
  - `L3`：盲评 A/B 测试，验证泛化性
- **断言类型**：`contains`, `regex`, `json_schema`, `latency_threshold`, `tool_call_trace` 等 8 种原子断言。

###  2. 变异引擎 (Mutation)
- **分层约束**：
  - **Layer 1**：修改 `description`/metadata（毫秒级，成本最低）
  - **Layer 2**：修改 `body`/instruction 逻辑（秒级，中成本）
  - **Layer 3**：修改 `scripts/` 或工具链（分钟级，高成本）
- **变异算子**：基于失败 trace 的 LLM Rewrite（如 `rewrite description to improve trigger F1`），禁止全量重写，强制局部 Patch。

### 🔺 3. 决策引擎 (Decision)
- **5维 AND 门控**（任一不达标即 DISCARD）：
  | 维度 | 阈值示例 | 目的 |
  |:---|:---|:---|
  | `holdout_floor` | ≥ 0.60 | 防止过拟合训练集 |
  | `min_delta` | ≥ 5% | 确保改进具有统计显著性 |
  | `trigger_f1_floor` | ≥ 0.85 | 保证技能触发准确率 |
  | `cost_budget` | Token/步数 ≤ 基线×1.2 | 控制推理成本 |
  | `regression_check` | 0 回归失败用例 | 保障向后兼容性 |
- **状态转移**：`KEEP` → 进入 P7/P8；`DISCARD` → 执行 `git revert` → 返回 P2；连续 N 次 DISCARD → 触发 Layer Promotion 或 Early Stopping。

---

## 五、 工程实现蓝图

### 📁 标准目录结构
```text
skill-evolver-workspace/
── evolve_plan.md          # 门控配置、分层策略、终止条件
├── skills/                 # 当前 Skill 包 (SKILL.md, scripts/, assets/)
├── evals/
│   ├── evals.json          # GT 契约（测试用例与断言）
│   └── grader.py           # 评分引擎
├── traces/
│   └── iter-{N}.jsonl      # Meta-Harness 轨迹记录
├── experiments/
│   ├── results.tsv         # 聚合指标表
│   └── decisions.jsonl     # 门控决策日志
└── .git/                   # 严格隔离，禁止污染主项目
```

### ⚙️ 核心配置示例 (`evolve_plan.md`)
```yaml
evolution_config:
  max_iterations: 10
  layer_promotion_threshold: 3  # 连续3次stuck升层
  early_stopping_patience: 5    # 连续5次无改进终止

gating_rules:
  type: AND  # 强制全通过
  thresholds:
    holdout_floor: 0.60
    min_delta: 0.05
    trigger_f1_floor: 0.85
    max_cost_multiplier: 1.2
    regression_allowed: false

mutation_strategy:
  default_layer: 1
  operators:
    - type: description_rewrite
      trigger: low_trigger_f1
    - type: body_logic_patch
      trigger: tool_call_trace_failure
    - type: script_optimization
      trigger: high_latency
```

---

## 六、 框架价值与落地建议

### ✅ 核心优势
1. **零人工干预闭环**：从诊断→变异→验证→决策全自动化，人类仅需定义 GT 契约与初始目标。
2. **生产级安全网**：Git 隔离 + AND 门控 + 自动回滚，确保进化过程不破坏现有系统。
3. **成本可预测**：分层变异与成本阈值强制框架在"改进收益"与"计算开销"间保持理性平衡。
4. **完全可审计**：所有决策基于 `trace.jsonl` 证据链，支持任意迭代的历史重放与根因分析。

###  落地路径建议
1. **Phase 1 (MVP)**：先实现 P0-P8 状态机骨架，接入 `skill-creator` 的 `grader.py` 与 L1/L2 验证。
2. **Phase 2 (Telemetry)**：集成 Meta-Harness 的 `trace.jsonl` 采集，打通 P2 诊断链路。
3. **Phase 3 (Mutation & Gating)**：接入 EvoSkill 语义算子，实现分层变异与 5 维 AND 门控。
4. **Phase 4 (Production)**：引入 Git 隔离工作区、自动回滚、实验记忆持久化，完成端到端自举验证。

该框架已将 AI 技能开发从**"经验驱动的手工调试"**升维至**"GT 驱动的工业级进化"**。它不替代人类设计，而是将人类智慧固化为契约，将重复劳动彻底自动化，是 AI Agent 工程化落地的必经基础设施。

---

*文档生成时间: 2026-05-26*
*基于: skill-evolver 博客 + Anthropic skill-creator + Karpathy AutoResearch + Stanford Meta-Harness + Sentient/VTech EvoSkill 技术萃取*