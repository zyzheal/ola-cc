# Goal TUI 面板重新设计

> 日期: 2026-05-28
> 状态: Draft v1
> 作者: heal + AI 协作

## 1. 问题

当前 `GoalProgress.tsx` 面板信息密度过低，只展示：
- 目标 + 状态 emoji
- 模式指示器
- 当前/下一个任务
- 任务进度条
- Token 预算
- 时间

无法感知：场景类型、ReAct 阶段、收敛趋势、错误恢复状态、轮次、技能推荐、工具调用。

## 2. 方案

采用 **分层折叠型** 布局，通过 `├── Section ──` 分区标题引导视线：

```
╭─ Goal ───────────────────────────────────────────────────────────────────────╮
│ 🎯 重构 auth 模块并修复 Token 刷新  code_change  FIX ▶  R3/5  12m 34s     │
│ standard | auto-edit | recovery OK                                           │
├── Tasks ─────────────────────────────────────────────────────────────────────┤
│  ✓ 重构 auth接口  ✓ 迁移旧token  ▶ 实现Token刷新逻辑                       │
│  ○ 添加单元测试  ○ 集成测试        [████████░░░░░░░░░░░░] 40%               │
├── Active: FIX ───────────────────────────────────────────────────────────────┤
│  Files: auth/refresh.ts +42-8  auth/types.ts +5                              │
│  Tools: Edit(2) Read(1) Bash(1) | Signals: progress                          │
├── Convergence ───────────────────────────────────────────────────────────────┤
│  IG: 0.18→0.12→0.42↑  QS: 65→78→85↑  CM: 0→5→12↑                          │
│  Status: converging — quality gate passed, waiting for info gain drop         │
├── Budget ────────────────────────────────────────────────────────────────────┤
│  45,230 / 200,000 tokens [██████░░░░░░░░░░░░░░] 23%  Remain: 154.7k       │
│  in: 28.1k out: 12.4k cache: 4.7k | avg 4.2s/turn                           │
├── Skills ────────────────────────────────────────────────────────────────────┤
│  test-driven-development(0.9)  verification(0.8)  review(0.7)               │
│  CodeGraph: ready  Grok: idle                                                │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## 3. 数据源

| 区域 | 数据来源 | 现有/新增 |
|------|---------|----------|
| Header | goal.objective, goalRuntime.currentScenario, goalRuntime.lastObservation.mainPhase, convergenceState.round | currentScenario 新增 |
| Tasks | goalTasks[goalTaskListId] | 已有 |
| Active Phase | goalRuntime.lastObservation.phaseTools, _toolCallsThisTurn | lastObservation 新增 |
| Convergence | goalRuntime.convergenceState.{informationGains, qualityScores, changeMagnitudes} | convergenceState 新增 |
| Budget | goal.totalApiTokens, goal.tokenBudget, turnBuffer | 已有 |
| Skills | goalScenario.skillAffinity, goalSkillRanker 排名结果 | 新增 |

## 4. 渐进实现

Phase 2 实现场景/观测模块后，面板自动获得新数据。面板改动与 orchestrator 模块解耦：
- 没有 orchestrator 时，面板只显示已有数据（降级到当前水平）
- 有 orchestrator 时，面板自动展示收敛/场景/阶段数据

## 5. 文件

- 修改: `src/components/goal/GoalProgress.tsx`
- 新增: 无（纯组件改造）
