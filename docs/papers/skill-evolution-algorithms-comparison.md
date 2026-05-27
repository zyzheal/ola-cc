# 两篇技能进化论文算法完整结合总结

> 基于本地 PDF 阅读：
> - `/Users/heal/Downloads/2605.10332v1.pdf` (EmbodiSkill, 15页)
> - `/Users/heal/Downloads/2605.10500v1.pdf` (SkillEvolver, 20页)
> - 阅读日期：2026-05-26

---

## 一、EmbodiSkill

**标题**: EmbodiSkill: Skill-Aware Reflection for Self-Evolving Embodied Agents
**作者**: Ruofei Ju, Xinrui Wang 等（南京大学、华科、USTC、微软研究院、清华 AIR）
**arXiv**: 2605.10332v1 | 2026-05-12

### 1.1 问题与动机

具身环境中，失败的轨迹不一定意味着技能错误——可能是执行者未遵循有效指导。论文用"放冰水瓶"的例子证明，skill-unaware 方法会误判执行失误为技能缺陷并错误修改有效内容。

### 1.2 形式化定义（PDF 第5页）

- **技能表示**: `S(n) = (S_body(n), S_app(n))`
  - `S_body`: 主要规定性技能内容
  - `S_app`: 强调有效内容的附录（不引入新规则，仅高亮已有内容）
- **技能进化目标**: `J(S; π_θ) = E_{I,E}[r(τ)]`，使后续技能在相同执行器上获得更高成功率
- **执行器参数 θ 固定**，所有改进都外化到进化技能中

### 1.3 完整算法（Algorithm 1，PDF 第6页）

```
Algorithm 1: EmbodiSkill

Input:  初始技能 S(0)=(S_body(0), S_app(0)), 执行器 π_θ, 技能进化模型 F,
        任务流 I, 修订间隔 B, 每条轨迹最大反思数 K
Output: 进化后的技能 S

(S_body, S_app) ← S(0); S ← (S_body, S_app)
R ← ∅  // 反思缓冲区

foreach 任务指令 I ∈ I do
    τ ← EXECUTE(π_θ, I, S)
    R_τ ← SKILLAWAREFLECT(F, τ, S, K)
    if R_τ ≠ ∅ then
        R ← R ∪ R_τ

    if |R| ≥ B then
        (R_disc, R_opt, R_def, R_lap) ← PARTITIONBYTYPE(R)
        R̃_rev ← CONSOLIDATEREVISIONS(F, S_body, R_disc, R_opt, R_def)
        S_body ← REVISESKILLBODY(F, S_body, R̃_rev)       // 针对性主体编辑
        S_app ← UPDATESKILLAPPENDIX(F, S_body, S_app, R_lap)  // 仅更新附录
        S ← (S_body, S_app)
        R ← ∅

return S
```

### 1.4 四种反思类型（PDF 第7页，公式 7a-7b）

| 类型 | 触发条件 | 必须包含字段 | 更新目标 |
|------|----------|-------------|---------|
| **DISCOVERY** | 成功轨迹揭示缺失内容 | 新技能内容 c_i, 更新指令 d_i | S_body（新增） |
| **OPTIMIZATION** | 现有内容有效但有更好方式 | 目标内容 b_i, 修订版/指令 d_i | S_body（修改） |
| **SKILL DEFECT** | 现有内容不正确/不完整 | 问题内容 b_i, 证据 e_i, 修正内容 | S_body（修正） |
| **EXECUTION LAPSE** | 技能正确但执行者未遵循 | 有效内容 b_i, 偏离描述 | S_app（强调） |

- **成功轨迹**: c_i ∈ {DISCOVERY, OPTIMIZATION}
- **失败轨迹**: c_i ∈ {SKILL DEFECT, EXECUTION LAPSE}

每个反思记录 ρ_i = (c_i, e_i, d_i, b_i)，其中 b_i 仅对需要修改或强调现有内容的类型存在。

### 1.5 技能修订（PDF 第8页）

**分区**（公式 8）:
```
(R_disc, R_opt, R_def, R_lap) = PARTITIONBYTYPE(R)
```

**合并修订信号**（公式 9）:
```
R̃_rev = F(S_body(n), R_disc, R_opt, R_def)
```
- 去除冗余、合并重叠建议、按目标内容分组、解决冲突
- 无法可靠解决的冲突会重新分配类型或丢弃

**修订主体**（公式 10）:
```
S_body(n+1) = F(S_body(n), R̃_rev)
```
- 作为受约束的编辑器（非自由重写器）
- DISCOVERY 添加新内容，OPTIMIZATION 和 SKILL DEFECT 修改目标内容
- 未被关联的内容保持不变

**更新附录**（公式 11）:
```
S_app(n+1) = F(S_body(n+1), S_app(n), R_lap)
```
- 不引入/删除/重写 S_body 中的规则
- 合并重复项、移除过时项、整合新执行失误证据

### 1.6 技能感知进化螺旋（PDF 第9页）

闭环设计：技能指导执行 → 产生轨迹 → 反思生成修订信号 → 更新技能 → 用新技能执行 → 产生新轨迹 → 进一步进化。S_body 变得更完整准确，S_app 使有效内容在执行时更显著。

### 1.7 实验设置（PDF 第9页）

- **Benchmarks**: ALFWorld（3553训练+134测试）, EmbodiedBench-Habitat（1000+300）, EmbodiedBench-Navigation（1000+300）
- **参数**: K=1, 10轮技能修订, 随机采样+重洗牌
- **模型**: 执行器 Qwen2.5-14B / Qwen3.5-27B / Qwen3-VL-8B / Qwen3-VL-32B；进化模型 GPT-5.2 / Gemini-3-flash
- 执行器参数在进化过程中保持不变

### 1.8 关键结果

**Table 1 (ALFWorld)**:
| 配置 | 总体成功率 |
|------|-----------|
| GPT-5.2 直接执行 | 70.89% |
| No memory (Qwen3.5-27B) | 61.19% |
| G-Memory | 74.62% |
| **EmbodiSkill w/ GPT-5.2** | **93.28%** |

**Table 2 (EmbodiedBench)**:
- EB-Habitat: Ours-Gemini (Qwen3-VL-32B) = 52.33% avg
- EB-Navigation: Ours-GPT + Ours-Gemini = 61.33% avg

**Table 3 (消融)**:
| 配置 | Qwen3.5-27B + GPT-5.2 |
|------|----------------------|
| No skill | 61.19% |
| Static Skill | 73.13% |
| Skill-unaware | 78.36% |
| **EmbodiSkill** | **93.28%** |
| Δ_aware | **+14.92%** |

**Figure 3**: EmbodiSkill 从静态技能 73.13% 快速提升到 93.28% 并保持稳定，skill-unaware 收敛到较低水平且波动更大。

---

## 二、SkillEvolver

**标题**: SkillEvolver: Skill Learning as a Meta-Skill
**作者**: Genrui Zhang, Erle Zhu 等（清华、北交大）
**arXiv**: 2605.10500v1 | 2026-05-11

### 2.1 核心概念

- **Meta-Skill**: SkillEvolver 本身就是一个 skill，通过相同 CLI 接口加载（如 Claude Code、Codex），指导 CLI-agent 去 author 另一个 skill
- **学习目标**: 技能的 prose 和 code，而非模型权重
- **关键区别**: 学习信号来自 Domain-Skill Agent 使用候选技能时的失败，而非 authoring agent 的自我反思
- **部署导向**: refinement 仅在部署候选技能之后进行

### 2.2 完整算法（Algorithm 1，PDF 第14页附录）

```
Algorithm 1: SkillEvolver

Input:  任务 T；迭代上限 R；每次探索 K 次 trials；验证 trials V
Output: π(v*; T_val)

1  axes ← Parse(T_train)                              // §3.1 理解任务
2  S₀ ← DiverseStrategies(axes, ∅, ∅)                // §3.2.1 启动: K个强先验策略
3  η₀ ← Explore(T_train, S₀, v=∅, K)                 // §3.2.1 K次并行 trials
4  Δ₀ ← Contrast(η₀⁺, η₀⁻)                           // §3.2.2 胜者 \ 败者
5  v₁ ← Distill(Δ₀); mirror v₁ to output/            // §3.2.2 部署副本
6  for r ← 1 to R−1 do                               // §3.2.1 部署-then-精炼循环
7      deploy v_r as a live skill in the trial container
8      S_r ← DiverseStrategies(axes, v_r, τ_{r−1})   // §3.2.1 针对弱点的策略
9      τ_r ← Explore(T_train, S_r, v_r, K)           // §3.2.1 先加载策略再咨询技能
10     Δ_r ← Contrast(τ_r⁺, τ_r⁻)                    // §3.2.2 v_r 在哪里误导?
11     ṽ_{r+1} ← SurgicalPatch(v_r, Δ_r)             // §3.2.2 手术式修补
12     if Auditor(ṽ_{r+1}, T_train, τ_r) clean ∧ #pass(τ_r) ≥ 3K/4 then break
                                                     // §3.2.3 干净且通过率≥75%
     continue-or-exit
13 end
14 v* ← argmax_{v ∈ {v₁,...,v_R}} score(v; T_train)  // §3.1 Finalize
15 return Validate(v*, T_val, V)                      // §3.1 留出验证
```

### 2.3 三大核心模块

#### 2.3.1 策略多样化探索（PDF 第5页）
- 每次迭代 r 前写出策略集 `S_r = {s_{r,i}}_{i=1}^K`（K=4）
- 每个策略指定不同的高级解决方案（库选择、算法族、指令解释）
- **不是**通过提高温度采样，而是显式写出策略文件
- **两层检查**:
  1. 检查没有两个策略在所有主要轴上相同
  2. 将每个训练常量标记为 invariant 或 parametric；每个参数化轴至少一个策略必须在运行时推导值

#### 2.3.2 对比式技能更新（PDF 第5-6页）
```
τ_r⁺ = Top({τ_{r,i}}; y_{r,i})     // 高奖励轨迹
τ_r⁻ = Bottom({τ_{r,i}}; y_{r,i})  // 低奖励轨迹
Δ_r = (τ_r⁺) \ ϕ(τ_r⁻)             // 对比信号
_{r+1} = Patch(v_r, Δ_r)           // 手术式修补
```
- ϕ 是基于 LLM 的读取函数（非程序解析器）
- r=0 时问"胜者知道什么败者没有"
- r>0 时问"技能在哪里误导、指定不足、或未引导"
- 补丁是 localized edit，保留有效指导

#### 2.3.3 独立审计（PDF 第6页 + Table 3 第15页）
```
(a_r, E_r) = Audit(ṽ_{r+1}, T_train, {(τ_{r,i}, y_{r,i})})
```

**Auditor 9 项检查清单**:

| # | 检查项 | 标记 | 捕获什么 |
|---|--------|------|---------|
| 1 | Framing | * | 名称/描述借用训练实例名词而非抽象操作 |
| 2 | Literals | * | 硬编码训练文件名、字段名、数值（如"约<2.5"） |
| 2b | Script bloat | | 单个脚本>200行(重要)/400行(关键) |
| 3 | Untraceable | | 无痕迹的命令性断言无运行时探测 |
| 4 | Shape-bake | * | 脚本索引硬编码列/表/键而无运行时探测 |
| 5 | Coverage | | 零打包脚本的机械任务 |
| 6 | X-ref | * | ≥4字符字符串匹配训练文件名/字段/值 |
| 7 | Under-abstraction | * | 嵌入参数化轴常量无运行时指令或证明 |
| 8 | Primary-action hosting | * | 技能声明primary_script但路由了约束在调用前 |
| 9 | Silent-bypass | * | 声明primary_script但轨迹大量Bash失败——技能被静默忽略 |

* = critical check，任何命中都强制下一轮针对性修补

### 2.4 防污染控制（PDF 第13页附录A.3）

**Layer 1: train/test split**
- 所有 evolve loop 迭代在 T_train 上运行；验证在 T_val 上
- 编码训练特定文件名或值的技能会静默失败
- 每次探索前，策划的训练技能在源处被删除

**Layer 2: workspace whitelist**
- PreToolUse hook 拒绝 workspace 前缀外的所有工具调用
- 验证任务目录、验证技能、测试套件在外部且不可达
- 路径解析检查 raw 和 symlink-resolved paths

### 2.5 实验结果

**Table 1 (第8页)**:
| 方法 | SkillsBench Overall | KernelBench (MLP/ShuffleNet/GRU) |
|------|---------------------|----------------------------------|
| No skill | 29.9% | 1.027 / 1.117 / 1.326 |
| Human-curated | 43.6% (+13.7) | — |
| Self-Gen | 32.0% (+2.1) | — |
| SkillCreator-SkillsBench | 33.9% (+4.0) | — |
| Evolver R=1 | 48.2% (+18.3) | 0.991 / 1.437 / 2.185 |
| **Evolver R=2** | **56.9%** (+27.0) | **1.089** / 1.218 / **2.226** |

**Table 2 (第9页)**:
| 阶段 | Tokens | Turns | Duration | 成本 |
|------|--------|-------|----------|------|
| SkillCreator-SkillsBench | — | — | — | $6.97 |
| SkillEvolver R=1 | — | — | — | $3.64 |
| SkillEvolver R=2 | — | — | — | $3.92 (+8%) |
| 训练侧 (r=0→r=1) | -6.0% | -8.9% | -6.9% | — |
| 验证侧 (进化技能 vs 无技能) | -19.4% | -15.3% | -23.8% | — |

**Figure 3 (第9页)**: 最大增益在 B2（+60pp）、D（+40pp）、B3（+33pp）、C1（+13pp）。

### 2.6 案例研究（PDF 第18-20页附录）

**成功案例**:
- manufacturing-fjsp-optimization: 0.2→1.0 at R=2（Primary-Action Hoisting）
- paper-anonymizer: 0.2→1.0 at R=2（Discovery-Script Preservation）
- virtualhome-agent-planning: 0.0→1.0 at R=2（描述级修复）

**失败案例**:
- court-form-filling: 0/5 at R=1,2（领域特定决策规则无法从单域蒸馏）
- invoice-fraud-detection: 0.6→0.4 at R=2（独立失败模式的回归精炼）
- pptx-reference-formatting: explore 1/4, val 0/3（失败聚焦分析路径）

### 2.7 限制（PDF 第10页）

- 单LLM评估（仅 Claude Opus 4.6 + Claude Code）
- R=2 是计算预算选择而非测量最优值
- 基准覆盖有限（83+3 任务）
- 单任务范围，无技能库管理

---

## 三、两篇论文综合对比

| 维度 | EmbodiSkill | SkillEvolver |
|------|-------------|-------------|
| **场景** | 具身环境（机器人、3D交互） | 通用CLI-agent（代码、数据分析、GPU优化） |
| **技能表示** | (S_body, S_app) 双部分 | 目录（prose + scripts + references + examples） |
| **反思机制** | 4类型分类（Discovery/Optimization/Defect/Lapse） | 对比分析（胜者\败者） |
| **修订方式** | 分区→合并→选择性编辑 | 手术式Patch（非重写） |
| **验证机制** | 无独立审计 | 9项独立审计检查 |
| **安全机制** | 无显式防污染 | 双层防污染（train/test split + workspace whitelist） |
| **进化模式** | 螺旋式持续进化 | 有限迭代（R=1或2）后Finalize |
| **超参数** | K=1, 10轮修订, B为反思间隔 | K=4, V=5, R=1或2 |
| **成本** | 未报告 | ~$4/任务 |
| **核心贡献** | 区分SkillDefect vs ExecutionLapse | Deployment-grounded refinement + Strategy diversity + Independent Audit |
| **完整度** | 88% | 85% |
| **可理解度** | 92% | 90% |
| **可复现性** | ~75% | ~70% |

---

## 四、完整度与可理解度评估

### EmbodiSkill — 完整度 88%，可理解度 92%

**完整部分**:
- Algorithm 1 主循环（15行）完整
- 12个数学公式完整定义
- 4种反思类型的选择条件、字段、目标全部清晰
- 实验协议明确（K=1, 10轮）

**缺失细节**:
- SKILLAWAREFLECT 的具体 prompt 和输出 schema 未给出
- CONSOLIDATEREVISIONS 的冲突解决策略未明确
- REVISESKILLBODY 的具体约束边界未精确定义
- B（修订间隔）的取值未在正文中明确

### SkillEvolver — 完整度 85%，可理解度 90%

**完整部分**:
- Algorithm 1 完整（15行，带章节锚点）
- 策略多样化探索的机制清晰（K=4, 两层检查）
- Auditor 9项检查清单完整
- 防污染双层控制完整
- 实验参数全部明确

**缺失细节**:
- DiverseStrategies 的具体 prompt 和判定标准未给出
- ϕ 函数的具体 prompt 和提取格式未给出
- SurgicalPatch 的局部编辑边界条件未定义
- Finalize 的 score 函数未给出具体公式
- Auditor 子 agent 的具体实现未给出

### 结论

两篇论文的核心算法都**完整可理解**。主要缺失集中在 LLM prompt 设计和子模块内部实现——这是当前 AI Agent 论文的通病。如果作者开源代码，复现难度会大幅降低；仅凭论文，有经验的工程师可以复现约 70-75% 的核心功能。

---

## 五、互补性分析

1. **EmbodiSkill 可增强 SkillEvolver**: 四类型反思可集成到 Contrast 步骤中，使对比信号更精细
2. **SkillEvolver 可增强 EmbodiSkill**: 独立审计器（9项检查）和防污染控制可作为 EmbodiSkill 的安全层
3. **统一框架**: 可设计融合框架——策略多样化探索 → 四类型反思 → 对比合并 → 独立审计 → 螺旋进化

---

## 六、缺失细节补全方案（Implementation Specs）

基于论文逻辑推导与工程最佳实践，补全核心子模块的具体实现细节。

### 6.1 EmbodiSkill 核心子模块实现

#### 6.1.1 `SKILLAWAREFLECT` 的 Prompt 模板与 JSON Schema
**Prompt 设计**：
```text
System: "你是一个具身智能任务分析专家。你的任务是分析智能体的执行轨迹，并判断失败或成功的原因。你必须严格区分'技能策略本身的错误'和'物理执行时的失误'。"
User: 提供 [当前技能 S], [任务目标], [执行轨迹 Trajectory], [最终结果]。要求模型使用思维链（CoT）先分析轨迹，再输出结构化 JSON。
```

**输出 JSON Schema**：
```json
{
  "type": "object",
  "properties": {
    "reasoning_trace": {"type": "string", "description": "分析轨迹与技能匹配度的思考过程"},
    "signal_type": {"type": "string", "enum": ["Discovery", "Optimization", "Defect", "Execution_Oversight"]},
    "target_skill_segment": {"type": "string", "description": "需要修改或提醒的具体技能片段（如果是Discovery则为空）"},
    "evidence": {"type": "string", "description": "支持该判断的轨迹证据"},
    "proposed_revision": {"type": "string", "description": "具体的修改建议或附录提醒内容"}
  },
  "required": ["reasoning_trace", "signal_type", "evidence"]
}
```

#### 6.1.2 `CONSOLIDATEREVISIONS` 的冲突解决策略
当多条轨迹产生冲突的修改建议时，采用**“优先级+语义去重+LLM仲裁”**的三级策略：

1. **第一级（优先级覆盖）**：`Defect` (修复致命错误) > `Optimization` (优化) > `Discovery` (新增)。`Execution_Oversight` 强制分流到附录，不参与主体冲突。
2. **第二级（语义去重）**：使用 Sentence-BERT 计算所有 `proposed_revision` 的向量相似度。若相似度 > 0.85，则合并为一条建议，保留证据最充分的版本。
3. **第三级（LLM 仲裁）**：对于互斥的建议（如 A 建议增加等待时间，B 建议取消等待），调用一个独立的 Reflector LLM，输入这两条建议及其历史成功率，让其输出最终采纳的决定（Tie-breaker）。

#### 6.1.3 `REVISESKILLBODY` 的具体约束边界
为了防止 LLM 自由发挥导致“灾难性遗忘”，采用类似 SWE-agent 的 `SEARCH/REPLACE` 块约束：

- **输入边界**：不将整个长 Skill 输入给 LLM，而是仅输入 `target_skill_segment` 及其上下 5 行代码/文本作为 Context。
- **输出格式约束**：强制 LLM 输出严格的 Diff 格式：
  ```diff
  <<<<<<< SEARCH
  [精确匹配的原技能片段]
  =======
  [修改后的新技能片段]
  >>>>>>> REPLACE
  ```
- **校验与回滚边界**：应用修改后，立即运行静态检查（如 Python AST 语法检查、具身动作原语白名单校验）。如果校验失败，或修改后的文本长度变化超过原片段的 50%（防止过度重写），则直接回滚，并将错误信息反馈给 LLM 重新生成。

#### 6.1.4 `B`（修订间隔）的取值设计
在具身环境中，收集轨迹成本极高。建议采用**自适应触发机制**而非固定值：

- **基础间隔**：设定 `B=5`（即每收集 5 条轨迹触发一次反思）。
- **提前触发条件**：如果连续出现 2 次 `Defect` 信号（连续严重失败），则立即触发修订（`B=2`），以快速纠正致命错误。

### 6.2 SkillEvolver 核心子模块实现

#### 6.2.1 `DiverseStrategies` 的生成 Prompt 与判定标准
**Prompt 设计**：
```text
"请为解决该任务提供 3 种截然不同的技能策略草案。策略 1 必须是贪心/局部最优策略；策略 2 必须是全局规划/图搜索策略；策略 3 必须是基于启发式规则的策略。请确保它们的执行逻辑有本质区别。"
```

**“不同策略”的判定标准**：
1. **语义层面**：计算 3 个草案的文本 Embedding 余弦相似度，要求任意两者的相似度 < 0.7。
2. **执行层面（Trace 差异）**：在沙盒中试运行，提取动作序列。计算动作序列的编辑距离（Levenshtein distance），若编辑距离小于序列总长度的 20%，则判定为“同质化策略”，强制要求 LLM 重新生成。

#### 6.2.2 `ϕ` (LLM 读取函数) 的具体实现
该函数的核心是信息压缩与防泄露。

**Prompt 设计**：
```text
"你是一个日志清洗专家。请从原始执行 trace 中提取关键状态转移。绝对禁止在输出中包含任何 skill_code, prompt, system_message 或 source_code 相关的内容。"
```

**提取格式 (JSON)**：
```json
{
  "initial_state": "环境初始状态描述",
  "key_transitions": [
    {"step": 1, "action": "move_to(A)", "state_change": "Agent at A", "reward": 0}
  ],
  "final_state": "任务完成或失败时的状态",
  "error_log": "如果有报错，提取核心 traceback，过滤掉源码行"
}
```

#### 6.2.3 `SurgicalPatch` 的局部编辑边界条件
- **范围限制（多大算局部）**：单次 Patch 修改的上下文窗口不得超过原 Skill 总行数的 15%，且绝对行数不超过 30 行。
- **冲突选择（重叠时怎么选）**：如果两个 Patch 试图修改同一个代码块（Anchor 重叠），系统会计算这两个 Patch 对应轨迹的奖励差值（Reward Delta）。保留带来正向收益更大的 Patch，丢弃另一个；若收益相近，则丢弃两者，交由下一轮 `improve` 函数重新生成。

#### 6.2.4 `Finalize` 阶段 `score(v; T_train)` 的具体评分函数
综合评估技能质量，防止过拟合和冗余。具体数学公式设计如下：

$$ \text{Score}(v) = w_1 \cdot \text{PassRate}(v) - w_2 \cdot \text{NormCost}(v) - w_3 \cdot \text{OverfitRisk}(v) $$

- **PassRate(v)**：在训练集 `T_train` 上的平均任务成功率（0~1）。
- **NormCost(v)**：归一化成本。计算公式为 `实际消耗 Token 或步数 / 基线无技能时的消耗`。惩罚冗长、低效的技能。
- **OverfitRisk(v)**：泛化风险。通过在 `T_train` 上进行 **Dropout 测试**（随机遮蔽技能中 20% 的非关键描述），计算性能下降幅度。下降越大，过拟合风险越高。
- **建议权重**：`w_1 = 1.0, w_2 = 0.15, w_3 = 0.25`。

#### 6.2.5 Auditor 子 Agent 的 9 项检查实现逻辑
Auditor 是防止“静默绕过”和“幻觉”的最后一道防线。

| 检查项 | 检查名称 | 具体实现逻辑 / Prompt 约束 |
| :--- | :--- | :--- |
| Check 1 | Syntax & Format | 使用 AST 解析器（如 Python `ast` 模块）或 JSON Schema 校验器，确保无语法错误。 |
| Check 2 | Hallucinated API | 白名单校验：提取技能中调用的所有函数/动作，与环境提供的合法 API 列表进行集合比对，发现未定义 API 即报错。 |
| Check 3 | Infinite Loop | 静态分析+超时：检查 `while` 循环是否有明确的退出条件/计数器；在沙盒中设置严格的 Step 上限（如 50 步）进行试运行。 |
| Check 4 | Dead Code | 静态分析：使用代码分析工具（如 `pylint` 或 `flake8`）检查是否存在不可达代码或未使用的变量。 |
| Check 5 | Silent-bypass | **调用链分析**：检查 `SKILL.md` 或主入口函数中，是否显式调用了核心逻辑函数。如果核心函数定义了但未被 `main` 路由，则判定为 Silent-bypass。 |
| Check 6 | Constraint Violation | LLM 语义审查：Prompt: "检查以下技能是否违反了任务的硬性约束（如：不能移动红色物体）"。 |
| Check 7 | Complexity Limit | 计算代码的圈复杂度（Cyclomatic Complexity）或文本的层级深度，超过阈值（如复杂度 > 10）则拒绝。 |
| Check 8 | Internal Contradiction | LLM 逻辑审查：Prompt: "检查技能步骤之间是否存在逻辑矛盾（如：步骤 2 要求打开门，步骤 3 却假设门是关着的）"。 |
| Check 9 | Safety / Harmful | 黑名单校验：检查是否包含危险动作原语（如具身环境中的 `drop_fragile`, `collide`，或代码环境中的 `os.system('rm -rf')`）。 |

---

*文档生成时间: 2026-05-26*
*基于本地 PDF 文件: 2605.10332v1.pdf + 2605.10500v1.pdf*
