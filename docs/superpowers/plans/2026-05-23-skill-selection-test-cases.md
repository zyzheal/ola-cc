# Skill 选择准确率测试用例

**日期**: 2026-05-23
**目的**: 验证 `[P{n}]` 和 `[!]` 标记是否真正影响 LLM 的 skill 选择

## 测试方法

每个用例跑 3 次（模型有随机性），统计选择正确 skill 的比例。

**测试前置条件**：
- 所有 15 个 superpowers skills 已补充 trigger 字段
- `finishing-a-development-branch` 和 `dispatching-parallel-agents` 分配 priority: 1（仅 Group 4 测试需要）
- skill listing 中包含 priority 和冲突警告标记
- 测试范围：仅 superpowers plugin 的 15 个 skills（不包含其他 plugin 或 project skills）

## 测试用例

### Group 1: 明确请求（基线测试）

| ID | 用户输入 | 正确 skill | 干扰 skill | 预期 |
|----|---------|-----------|-----------|------|
| G1-1 | "我要调试一个 bug" | systematic-debugging | - | >95% |
| G1-2 | "帮我 brainstorm 这个功能" | brainstorming | - | >95% |
| G1-3 | "写一个实现计划" | writing-plans | - | >95% |
| G1-4 | "执行这个计划" | executing-plans | - | >95% |
| G1-5 | "用 TDD 方式实现" | test-driven-development | - | >95% |

### Group 2: 模糊请求（核心测试）

| ID | 用户输入 | 正确 skill | 干扰 skill | 预期 |
|----|---------|-----------|-----------|------|
| G2-1 | "开始头脑风暴" | brainstorming | writing-plans | >80% |
| G2-2 | "写个计划" | writing-plans | brainstorming | >80% |
| G2-3 | "代码有问题" | receiving-code-review | systematic-debugging | >80% |
| G2-4 | "这个功能怎么做" | brainstorming | writing-plans | >80% |
| G2-5 | "测试失败了" | systematic-debugging | test-driven-development | >80% |

### Group 3: 冲突场景（重点测试）

| ID | 用户输入 | 正确 skill | 干扰 skill | 冲突 trigger | 预期 |
|----|---------|-----------|-----------|-------------|------|
| G3-1 | "审查这段代码" | receiving-code-review | requesting-code-review | review, 代码审查 | >75% |
| G3-2 | "提交审查请求" | requesting-code-review | receiving-code-review | review, 请求审查 | >75% |
| G3-3 | "执行开发任务" | subagent-driven-development | executing-plans | agent, 子代理 | >75% |
| G3-4 | "设计这个架构" | writing-plans | brainstorming | design, 架构设计 | >75% |

### Group 4: 优先级验证

**前置条件**：以下 skills 需分配 priority 后才能测试。建议临时设置：
- `finishing-a-development-branch` → P1
- `dispatching-parallel-agents` → P1
- `executing-plans` → P0（默认）

| ID | 用户输入 | 正确 skill | 干扰 skill | priority 差异 | 预期 |
|----|---------|-----------|-----------|-------------|------|
| G4-1 | "完成分支合并" | finishing-a-development-branch | executing-plans | P1 vs P0 | 选 P1 |
| G4-2 | "并行处理这些任务" | dispatching-parallel-agents | executing-plans | P1 vs P0 | 选 P1 |

## 结果记录模板

| 用例 ID | 运行 1 | 运行 2 | 运行 3 | 正确率 | 备注 |
|---------|--------|--------|--------|--------|------|
| G1-1 | ✅ | ✅ | ✅ | 100% | - |
| G2-1 | ✅ | ❌ | ✅ | 67% | 运行 2 选择了 writing-plans |

## 验收标准

| 指标 | 目标 | 说明 |
|------|------|------|
| Group 1 正确率 | >95% | 基线必须稳定 |
| Group 2 正确率 | >80% | 模糊请求是主要验证点 |
| Group 3 正确率 | >75% | 冲突场景最 challenging |
| Group 4 正确率 | >70% | 优先级引导效果验证 |
| 总体正确率 | >85% | 综合指标 |

## 失败处理

如果某组正确率低于目标：
1. 分析 listing 格式是否有问题
2. 检查 description 排除性声明是否清晰
3. 调整 priority 或 trigger 词
4. 重新测试
