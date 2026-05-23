# Skill Trigger 批量补充建议

**日期**: 2026-05-23
**来源**: 从现有 superpowers skills 的 description 中自动提取
**状态**: 待审核

## 提取规则

1. 从 `description` 的 `Trigger:` 字段提取
2. 去重（移除重复词）
3. 过滤无效词（如 "to", "how", "before" 等停用词）

---

## 建议清单

### 1. using-git-worktrees
```yaml
trigger: git worktree, 工作树, worktree
```
**排除性声明建议**: 不创建分支（用 Git 分支工具），不合并代码（用 finishing-a-development-branch）

### 2. test-driven-development
```yaml
trigger: TDD, test-driven, 测试驱动, test first
```
**排除性声明建议**: 不做需求分析（用 brainstorming），不写实现计划（用 writing-plans）

### 3. systematic-debugging
```yaml
trigger: debug, 系统性调试, bug, test failure, root cause
```
**排除性声明建议**: 不写修复代码（先完成 Phase 1 根因分析后再修复），不做功能开发（用 test-driven-development）

### 4. design-constraint
```yaml
trigger: 设计约束检查, 完整性检查, 交互审查, design constraint, design check
```
**排除性声明建议**: 不做文档深度评审（用 design-doc-reviewer），不做代码分析（用 code-design-analyzer）

### 5. using-superpowers
```yaml
trigger: superpowers, skill, 使用技能
```
**排除性声明建议**: 不执行具体任务，仅指导如何使用技能系统

### 6. dispatching-parallel-agents
```yaml
trigger: parallel, agent dispatch, 并行 agent, independent tasks
```
**排除性声明建议**: 不执行有依赖的任务（用 executing-plans），不串行处理任务

### 7. executing-plans
```yaml
trigger: execute plan, implementation, 执行计划, 实现
```
**排除性声明建议**: 不写计划（用 writing-plans），不 brainstorm（用 brainstorming）

### 8. finishing-a-development-branch
```yaml
trigger: finish branch, merge, PR, complete, 完成分支, 合并
```
**排除性声明建议**: 不执行开发（用 subagent-driven-development），不写代码

### 9. brainstorming
```yaml
trigger: brainstorm, design, feature idea, 头脑风暴, 创意
```
**排除性声明建议**: 不写代码，不实现功能，不创建文件（仅探索需求和设计）

### 10. writing-plans
```yaml
trigger: write plan, architecture design, 写计划, 架构设计
```
**排除性声明建议**: 不执行计划（用 executing-plans），不做需求探索（用 brainstorming）

### 11. requesting-code-review
```yaml
trigger: request review, PR review, 请求审查
```
**排除性声明建议**: 不接收审查反馈（用 receiving-code-review），不执行开发

### 12. receiving-code-review
```yaml
trigger: code review feedback, implement review, 代码审查
```
**排除性声明建议**: 不请求审查（用 requesting-code-review），不主动发起审查

### 13. writing-skills
```yaml
trigger: write skill, skill quality, 写技能, 技能质量
```
**排除性声明建议**: 不执行技能（用 using-superpowers），不使用其他技能

### 14. verification-before-completion
```yaml
trigger: verify completion, test before finish, 验证完成
```
**排除性声明建议**: 不执行开发，不写计划，仅验证已完成的工作

### 15. subagent-driven-development
```yaml
trigger: subagent, agent development, 子代理
```
**排除性声明建议**: 不手动执行任务（用 dispatching-parallel-agents），不写计划

---

## 冲突检测结果（预检）

基于上述 trigger 词，以下 skill 对存在潜在冲突：

| Skill A | Skill B | 重叠 trigger | 严重度 | 处理建议 |
|---------|---------|-------------|--------|---------|
| requesting-code-review | receiving-code-review | review | warning | 在 description 中明确区分"请求"和"接收" |

**说明**：
- `executing-plans` vs `subagent-driven-development` 的 trigger 分别为 `execute plan, 执行计划` 和 `subagent, 子代理`，无重叠
- `writing-plans` vs `brainstorming` 的 trigger 分别为 `write plan, architecture design, 写计划` 和 `brainstorm, feature idea, 头脑风暴`，无重叠
- 原预检中的 `design` 和 `agent` 重叠已通过停用词过滤消除

## Priority 分配建议（用于 Group 4 测试）

| Skill | Priority | 理由 |
|-------|----------|------|
| finishing-a-development-branch | 1 | 完成阶段的最终操作，应该在"完成"相关请求中优先于 executing-plans |
| dispatching-parallel-agents | 1 | 并行任务分发是 specialized 场景，应该在"并行"相关请求中优先于 executing-plans |
| executing-plans | 0 | 默认值，通用执行器 |
