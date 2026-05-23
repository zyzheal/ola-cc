# Skill 多层防混淆体系设计方案

**日期**: 2026-05-23
**状态**: 待评审
**作者**: ola-cc

## 背景

当前 skill 选择完全由 LLM 基于 `description` 字段驱动。当多个 skill 的描述存在语义重叠时（如 `design-doc-reviewer`、`design-constraint`、`code-design-analyzer`），模型可能选错 skill，导致执行结果不符合预期。

## 目标

构建五层防线，确保 skill 选择的准确性和可预测性：

1. **命名隔离** — 利用 plugin 命名空间防止冲突（已存在）
2. **触发词互斥** — 规范化 trigger 词，冲突检测
3. **描述差异化** — 强制描述包含排除性声明和场景限定
4. **优先级声明** — 允许重叠 skill 间声明优先级，**注入 listing 让模型可见**
5. **用户确认** — 多候选时列出选项让用户选择

## 架构总览

```
用户输入 "评审这个文档"
    │
    ▼
第一层：命名隔离 — 同名？→ 按层级覆盖规则选一个
    │ 不同名，继续
    ▼
第二层：触发词互斥 — trigger 词冲突？→ 标记冲突，要求整改
    │ 无冲突，继续
    ▼
第三层：描述差异化 — 多个匹配？→ Claude 按描述具体度自动选
    │ 仍不确定，继续
    ▼
第四层：优先级声明 — listing 中有 priority？→ 模型选高的
    │ 没有，继续
    ▼
第五层：用户确认 — 列出候选让用户选
```

## 字段职责边界（P0 修复）

系统中存在三个与"触发"相关的字段，必须明确各自职责：

| 字段 | 消费者 | 用途 | 示例 |
|------|--------|------|------|
| `trigger` | **程序**（冲突检测引擎） | 声明式的触发词集合，用于自动检测 skill 间冲突 | `trigger: 评审文档, review doc` |
| `description` | **LLM 模型**（skill listing） | 一句话描述 skill 做什么+不做什么，是模型选择的唯一依据 | `description: 评审架构设计文档...不做代码分析` |
| `when_to_use` | **LLM 模型**（skill 展开后） | skill 被调用后的详细执行指导，告诉模型什么时候用、怎么用 | `Use when: 用户指出文档不够深入` |

**关键规则**：
- 模型选择 skill 时只看 `description`（system-reminder 中展示的字段）
- `trigger` 仅供程序做冲突检测，**不注入 prompt，模型看不到**
- `when_to_use` 在 skill 被选中并展开后才可见，不影响选择阶段

## 详细设计

### 第一层：命名隔离（已有，无需改动）

**现状**: 官方已通过 `plugin-name:skill-name` 实现命名空间隔离。
**规则**: 同一项目内不允许 skill 目录名重复。Plugin 自带命名空间隔离。
**结论**: 这部分已存在，不需要额外工作。

### 第二层：触发词互斥

#### 2.1 新增 frontmatter 字段

在 `SKILL.md` 中增加 `trigger`、`priority`、`conflicts-with` 字段：

```yaml
---
name: design-doc-reviewer
description: >-
  评审架构设计文档、API文档、运维手册的深度问题（交互链路、跨系统串联、大厂对标）。
  不做代码分析（用 code-design-analyzer），不做任务拆分（用 task-decomposer）。
trigger: 评审设计文档, review architecture, 文档深度评审, 设计评审
priority: 1
conflicts-with: [design-constraint, code-design-analyzer]
---
```

#### 2.2 触发词冲突检测

- 构建 trigger 词冲突扫描工具
- **调用时机**：会话启动时，在 `getSkillDirCommands()`（`loadSkillsDir.ts` 约 931 行）返回前，所有 skill 加载完成后执行一次全量冲突检测
- 发现冲突时，在 skill 加载日志中标记 WARNING
- 冲突结果缓存在内存中，供后续 `formatCommandsWithinBudget` 生成 listing 时参考

#### 2.3 冲突检测算法（P0 修复：中文分词策略）

中文 trigger 词不适合纯编辑距离算法（"评审文档"和"文档评审"编辑距离为 4 但语义相同）。采用**关键词分词 + 子串匹配**策略：

```typescript
// 冲突检测核心逻辑（伪代码）

function detectTriggerConflicts(allSkills: Skill[]): Conflict[] {
  const conflicts: Conflict[] = []

  for (let i = 0; i < allSkills.length; i++) {
    for (let j = i + 1; j < allSkills.length; j++) {
      const skillA = allSkills[i]!
      const skillB = allSkills[j]!

      const triggersA = tokenizeTriggers(skillA.trigger)
      const triggersB = tokenizeTriggers(skillB.trigger)

      const overlap = findOverlap(triggersA, triggersB)
      if (overlap.length > 0) {
        conflicts.push({
          skillA: skillA.name,
          skillB: skillB.name,
          overlappingTerms: overlap,
          severity: computeSeverity(overlap)
        })
      }
    }
  }
  return conflicts
}

// 分词策略：简单有效的关键词拆分
function tokenizeTriggers(rawTriggers: string): string[] {
  return rawTriggers
    .split(',')                    // 按逗号拆分
    .map(t => t.trim())            // 去空格
    .filter(t => t.length > 0)     // 去空
    .flatMap(t => expandSynonyms(t)) // 展开同义词（见下表）
}

// 重叠判断：子串匹配 + 同义词表
function findOverlap(triggersA: string[], triggersB: string[]): string[] {
  const overlap: string[] = []
  for (const a of triggersA) {
    for (const b of triggersB) {
      if (a === b) {
        // 精确匹配（含同义词展开后）
        overlap.push(`${a} (精确匹配)`)
      } else if (a.includes(b) || b.includes(a)) {
        // 子串匹配：触发词互为子串
        overlap.push(`"${a}" <-> "${b}" (子串匹配)`)
      }
    }
  }
  return overlap
}
```

**同义词扩展表**（硬编码，覆盖常见 review 类同义）：

| 基础词 | 同义词扩展 | 说明 |
|--------|-----------|------|
| 评审 | review | 1:1 映射，移除"审查/检查/审计"等歧义词 |
| 设计 | design, architecture | "架构"在技术文档语境中等效于"设计" |
| 代码 | code, implementation | "实现"在开发语境中等效于"代码" |
| 文档 | doc, document | 仅英文缩写，中文"说明/手册"不纳入 |
| 分析 | analyze, analysis | 仅英文变形 |

**规则**：
- 仅保留 **明确的 1:1 或语言变形** 映射
- 移除"检查/审查/审计"等可能独立成义的歧义词
- 如果两个 skill 的 trigger 分别是"评审文档"和"检查文档"，**不视为冲突**，交由第三层描述差异化处理

**最小长度过滤**：
- trigger 词 < 2 个字符（如"评"、"审"）不参与子串匹配，避免误报
- 单字 trigger 仅参与精确匹配

**冲突严重度计算**：

| 条件 | 严重度 | 行为 |
|------|--------|------|
| 精确匹配（含同义词展开后相同） | `error` | WARNING 日志 + 建议在 conflicts-with 中声明 |
| 子串匹配（一个 trigger 包含另一个） | `warning` | WARNING 日志 |
| 仅基础词重叠（未展开同义词） | `info` | DEBUG 日志 |

#### 2.4 conflicts-with 字段用途（P1 修复）

`conflicts-with` 字段的用途：

1. **启动时告警**：加载 skill 时，如果实际检测到的冲突与 `conflicts-with` 声明不一致，输出 WARNING
   - 声明了冲突但实际没检测到 → INFO "声明的冲突项不存在，可移除"
   - 实际检测到冲突但未声明 → WARNING "检测到与 X 的 trigger 冲突，建议在 conflicts-with 中声明"
2. **skill 作者自查**：作者明确知道可能冲突的 skill，主动调整 trigger 词
3. **不影响运行时**：这个字段**不参与 skill 选择逻辑**，仅用于日志告警和文档记录

### 第三层：描述差异化

#### 3.1 描述规范

在 skill 加载时验证描述格式，要求包含：

1. **排除性声明**: 说明"不做什么"
2. **场景限定**: 说明"什么时候用/什么时候不该用"

#### 3.2 验证规则（P1 修复：灵活匹配策略）

使用正则模式匹配而非硬编码关键词，覆盖中英文变体：

```
规则: description 验证

排除性声明检测（满足任一即可通过）:
  - 包含 "不做/不使用/不负责/不涉及/not responsible/exclude/does not handle/不是"
  - 包含 "用 XXX 替代/用 XXX 代替/use XXX instead"
  - 包含 "转交/交给/delegate to/转交 XXX"

场景限定检测（满足任一即可通过）:
  - 包含 "当/当用户/使用场景/适用于/use when/when user/适用于"
  - 包含 "Trigger:" 或 "触发:" 或 "触发词:"
  - when_to_use 字段非空（视为等效于场景限定）
```

**注意**: 验证为 WARNING 级别，不阻止 skill 加载，但会在日志中输出建议。

### 第四层：优先级声明（P0 修复：模型可见性）

#### 4.1 Frontmatter 字段

```yaml
priority: 1  # 数字越高越优先，仅在与 trigger 词重叠的 skill 间比较
conflicts-with: [design-constraint, code-design-analyzer]  # 声明可能与哪些 skill 冲突
```

#### 4.2 优先级注入 listing（关键修复）

**问题**：模型选择 skill 时只看 system-reminder 中的 `name: description` 格式，priority 字段默认不可见。

**方案**：将 priority 编码到 skill listing 展示中：

```
// 无 priority 冲突的正常 skill
- design-doc-reviewer: 评审架构设计文档、API文档...

// 有 priority 的 skill（priority > 0）
- design-doc-reviewer: [P1] 评审架构设计文档、API文档...
- design-constraint:   [P0] 检查 14 维 196 项设计约束...

// 有冲突的 skill（在 listing 中额外提示）
- design-doc-reviewer: [P1] 评审架构设计文档... ⚠️ 与 design-constraint 触发词重叠
```

#### 4.3 Listing 格式模板（P1 修复）

**与现有代码的关系**：

当前 `formatCommandDescription`（`prompt.ts:52-66`）通过 `getCommandDescription` 拼接 `description` + `whenToUse`：

```typescript
// 现有逻辑（prompt.ts:43-49）
function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026'
    : desc
}
```

新增 priority 和冲突标记时，需要在 `formatCommandDescription` 的外层包装，**不修改** `getCommandDescription` 内部逻辑：

```typescript
// 增强后的 formatCommandDescription（prompt.ts:52-66 修改）
function formatCommandDescription(cmd: Command): string {
  let desc = `- ${cmd.name}: `

  // 1. Priority 标记（新增）
  if (cmd.priority && cmd.priority > 0) {
    desc += `[P${cmd.priority}] `
  }

  // 2. 描述（复用现有 getCommandDescription，内部已拼接 whenToUse）
  desc += getCommandDescription(cmd)

  // 3. 冲突警告（新增，仅在检测到冲突时展示）
  const conflicts = getConflictsForSkill(cmd.name)
  if (conflicts.length > 0) {
    const conflictNames = conflicts.map(c => c.skillB).join(', ')
    desc += ` [!] 触发词与 ${conflictNames} 重叠`
  }

  return desc
}
```

**字段拼接优先级**：
1. `description` — 核心描述（必须有）
2. `whenToUse` — 追加到 description 后，用 ` - ` 连接（可选）
3. `[P{n}]` — 前缀，在 `name: ` 之后、description 之前
4. `[!]` — 后缀，在描述末尾

**效果示例**（system-reminder 中展示）：

```
Available skills:
- design-doc-reviewer: [P1] 评审架构设计文档、API文档、运维手册的深度问题。不做代码分析（用 code-design-analyzer），不做任务拆分（用 task-decomposer）。[!] 触发词与 design-constraint 重叠
- design-constraint: [P0] 检查 14 维 196 项设计约束。不做文档深度评审（用 design-doc-reviewer），不做代码分析（用 code-design-analyzer）。[!] 触发词与 design-doc-reviewer 重叠
- code-design-analyzer: 分析代码与设计文档的差异。不做文档评审（用 design-doc-reviewer），不做约束检查（用 design-constraint）。
```

这样模型在 listing 中就能同时看到：
- 排除性声明（第三层）
- 优先级标记 `[P1]`（第四层）
- 冲突警告 `[!]`（第二层可视化）

#### 4.4 优先级比较规则

- 仅在 trigger 词重叠的 skill 间比较 priority
- 数字越高越优先
- 未声明 priority 的 skill 默认为 0
- `conflicts-with` 用于日志提示，不影响运行时选择

### 第五层：用户确认机制

#### 5.1 多候选检测

当 LLM 看到系统提醒中的 skill listing 后，如果多个 skill 的描述都能匹配用户请求，由 LLM 自行判断是否需要用户确认。

#### 5.2 用户确认流程（P1 修复）

当检测到多个相关 skill 且模型无法确定时，通过 `AskUserQuestion` 工具列出候选让用户选择：

```
检测到多个相关 skill，请选择：
  [1] design-doc-reviewer — [P1] 评审文档深度和完整性（不做代码分析）
  [2] design-constraint   — [P0] 检查 14 维 196 项设计约束（不做文档评审）
  [3] code-design-analyzer — 分析代码与设计文档的差异（不做文档评审）

回复数字选择，或直接描述具体需求。
```

#### 5.3 冲突 WARNING 的用户处理流程

当用户在日志中看到 `trigger conflict` WARNING 时：

```
[!] Skill 'design-doc-reviewer' trigger conflicts with 'design-constraint':
   重叠触发词: "评审设计文档" <-> "设计评审" (子串匹配)

建议处理方式（任选一种）:
  1. 细化 trigger 词，避免重叠
  2. 在 conflicts-with 字段中声明冲突
  3. 如果不需要模型自动调用，设置 disable-model-invocation: true
```

**不需要代码改动**，只需要通过描述规范化让 LLM 能做出更好的判断。

## 实施计划

### 阶段 1: 基础设施（类型和解析）

| 序号 | 文件 | 改动 |
|------|------|------|
| 1 | `src/utils/frontmatterParser.ts` | `FrontmatterData` 类型增加 `trigger`, `priority`, `conflicts-with` 字段定义 |
| 2 | `src/types/command.ts` | `CommandBase` 增加 `trigger?: string[]`, `priority?: number`, `conflictsWith?: string[]` 字段 |
| 3 | `src/skills/loadSkillsDir.ts` | `parseSkillFrontmatterFields` 解析新字段，`createSkillCommand` 传递新字段 |

### 阶段 2: 冲突检测

| 序号 | 文件 | 改动 |
|------|------|------|
| 4 | `src/skills/triggerConflict.ts` | **新建** — trigger 词冲突检测引擎（分词 + 子串匹配 + 同义词扩展） |
| 5 | `src/skills/loadSkillsDir.ts` | 在 `getSkillDirCommands()` 返回前调用 `detectTriggerConflicts()`，结果缓存到内存 |
| 6 | `src/bootstrap/state.ts` | 新增全局冲突状态存储 `skillConflicts: Conflict[]` |

### 阶段 3: 描述验证

| 序号 | 文件 | 改动 |
|------|------|------|
| 7 | `src/skills/descriptionValidator.ts` | **新建** — 描述格式验证器（正则模式匹配排除性声明和场景限定） |
| 8 | `src/skills/loadSkillsDir.ts` | 在 `createSkillCommand` 前调用描述验证 |

### 阶段 4: Skill listing 增强

| 序号 | 文件 | 改动 |
|------|------|------|
| 9 | `src/tools/SkillTool/prompt.ts` | `formatCommandDescription` 增加 priority 和冲突警告标记 |
| 10 | `src/tools/SkillTool/prompt.ts` | `formatCommandsWithinBudget` 中保留 priority 标记（不截断） |

### 阶段 5: 文档和示例

| 序号 | 文件 | 改动 |
|------|------|------|
| 11 | `CLAUDE.md` | 更新 Skill 系统描述，新增 trigger/priority 字段说明 |
| 12 | `docs/superpowers/` | 新增 skill-authoring-guide.md，包含 trigger/priority 最佳实践 |
| 13 | 现有 superpowers skills | 批量补充 `trigger` 和 `description` 规范化（后续迭代） |

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 触发词检测误报 | skill 作者体验差 | 使用子串匹配+同义词表，降低误报；严重度分三级，info 仅 DEBUG 日志 |
| 描述验证过于严格 | 现有 skill 大量 WARNING | 初始阶段仅 WARNING，不阻止加载；正则模式覆盖中英文变体 |
| 性能影响 | skill 加载变慢 | 冲突检测在启动时执行一次，O(n²) 但 n 通常 < 100，子串匹配比编辑距离快 |
| 向后兼容 | 旧 skill 没有新字段 | 所有新字段可选，默认值安全 |
| **listing 变长** | **priority+冲突标记增加 token 消耗** | **仅在冲突时加 `[!]` 标记；priority 标记仅 3 字符；总增量 < 5%** |
| **模型忽略 priority** | **第四层防线失效** | **通过 listing 格式直接可见 + 描述中排除性声明配合，双重保障** |
| **同义词误报** | **"检查"等歧义词导致假冲突** | **缩小同义词表仅保留明确 1:1 映射，移除歧义词** |
| **emoji 终端兼容性** | **`⚠️` 在某些终端显示为方块** | **使用 ASCII `[!]` 替代 emoji** |

## 向后兼容

所有新字段都是**可选的**：
- `trigger`: 默认 `[]`（空数组，不参与冲突检测）
- `priority`: 默认 `0`（不显示 P 标记）
- `conflicts-with`: 默认 `[]`

现有 skill 无需任何修改即可正常工作。

## 验收标准

| 指标 | 目标 | 测量方式 |
|------|------|---------|
| 冲突检测准确率 | > 90% 的真实重叠被检测到 | 手动构造 10 对已知冲突的 skill 对，验证检测率 |
| 冲突误报率 | < 10% 的误报 | 对 50+ 现有 skill 执行全量检测，人工复核 WARNING |
| 模型选错 skill 率降低 | 相比基线降低 > 50% | 构造 20 个模糊请求测试用例，对比修改前后的选择准确率 |
| 启动性能影响 | < 50ms 额外开销 | `console.time()` 测量冲突检测耗时 |
| listing token 增量 | < 5% | 对比修改前后的 `formatCommandsWithinBudget` 输出长度 |
