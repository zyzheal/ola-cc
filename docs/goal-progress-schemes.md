# Goal Progress Display 方案对比

## 方案展示样例

### 方案 A: Simple Progress Percentage（简洁进度百分比）

```
╭────────────────────────────────────────────────────────────╮
│ 🎯 Migrate Express to Fastify (active)                     │
│                                                            │
│ 📊 Task Progress: 45%                                      │
│ [█████████░░░░░░░░░░░]                                     │
│                                                            │
│ 💾 Budget Usage:                                           │
│   Tokens: 12,500 / 50,000 (25% used)                       │
│   [█████░░░░░░░░░░░░░░░]                                   │
│   Remaining: 37,500 tokens                                 │
│                                                            │
│ ⏱️  Time: 1m 30s                                           │
╰────────────────────────────────────────────────────────────╯
```

**特点：**
- ✅ 简洁明了，一目了然
- ✅ 双进度条：Task Progress + Budget Usage
- ✅ 模型自主报告进度百分比
- ⚠️ 进度百分比可能主观，不够精确

**适用场景：** 追求简洁性，快速查看进度概览

---

### 方案 B: Full Task List（完整任务列表）

```
╭────────────────────────────────────────────────────────────╮
│ 🎯 Migrate Express to Fastify (active)                     │
│                                                            │
│ 📊 Tasks Progress: 3/7 completed (42%)                     │
│ [███████░░░░░░░░░░░░░░]                                    │
│                                                            │
│ ✅ 1. Analyze current Express code structure               │
│ ✅ 2. Design new Fastify architecture                      │
│ ✅ 3. Create JWT authentication utility                    │
│ 🔄 4. Update middleware layer (in progress)                │
│ ⏳  5. Refactor route handlers                             │
│ ⏳  6. Update integration tests                             │
│ ⏳  7. Create migration documentation                      │
│                                                            │
│ 💾 Budget: 12,500 / 50,000 tokens (25% used)               │
│ ⏱️  Time: 1m 30s                                           │
╰────────────────────────────────────────────────────────────╯
```

**特点：**
- ✅ 进度精确（完成的任务数/总任务数）
- ✅ 显示具体任务状态（✅ 已完成、🔄 进行中、⏳ 待处理）
- ✅ 任务列表可视化，用户可看到具体进展
- ⚠️ 实现复杂，需要任务管理逻辑
- ⚠️ 占用较多屏幕空间

**适用场景：** 复杂任务，需要精确跟踪每个子任务进度

---

### 方案 C: Integration with TodoWrite（集成 TodoWrite）

```
╭────────────────────────────────────────────────────────────╮
│ 🎯 Migrate Express to Fastify (active)                     │
│                                                            │
│ 📋 Linked Todo List:                                       │
│   ┌──────────────────────────────────────┐                │
│   │ ✅ Analyze Express structure          │                │
│   │ ✅ Design Fastify architecture        │                │
│   │ 🔄 Create JWT utility                 │                │
│   │ ⏳  Update middleware                  │                │
│   │ ⏳  Refactor routes                    │                │
│   └──────────────────────────────────────┘                │
│   Progress: 2/5 completed (40%)                            │
│                                                            │
│ 💾 Budget: 12,500 / 50,000 tokens                          │
│ ⏱️  Time: 1m 30s                                           │
│ ℹ️  View full list: /todos                                 │
╰────────────────────────────────────────────────────────────╯
```

**特点：**
- ✅ 利用现有 TodoWrite 系统，无需重复实现
- ✅ 用户可用 `/todos` 命令查看完整列表
- ✅ Goal 和 TodoWrite 关联，进度实时同步
- ⚠️ 需要关联两个系统（Goal + TodoWrite）
- ⚠️ TodoWrite 可能不总是启用

**适用场景：** 已使用 TodoWrite 系统的项目，自然集成

---

### 方案 D: Smart Progress Inference（智能进度推断）

```
╭────────────────────────────────────────────────────────────╮
│ 🎯 Migrate Express to Fastify (active)                     │
│                                                            │
│ 📊 Estimated Progress: ~30%                                │
│ [██████░░░░░░░░░░░░░░░░]                                   │
│                                                            │
│ 📈 Multi-dimensional Analysis:                             │
│   ├ Budget Usage: 25% (12,500 / 50,000 tokens)            │
│   ├ Time Progress: 15% (90s / ~600s estimated)            │
│   ├ Tool Calls: 28 / ~100 estimated                        │
│   ├ Conversation Turns: 3 / ~10 estimated                  │
│   └ Composite Score: 30%                                   │
│                                                            │
│ 📝 Recent Activity:                                        │
│   • Analyzed Express router structure                      │
│   • Designed Fastify migration plan                        │
│   • Created JWT utility skeleton                           │
│                                                            │
│ ⏱️  Total Time: 1m 30s                                     │
╰────────────────────────────────────────────────────────────╯
```

**特点：**
- ✅ 全自动，无需模型报告进度
- ✅ 多维度评估（Budget、Time、Tool Calls、Turns）
- ✅ 显示详细分析数据和最近活动
- ⚠️ 不够直观（用户关心的是任务完成度）
- ⚠️ 计算逻辑复杂，估算可能不准确

**适用场景：** 自动化场景，不想让模型手动报告进度

---

### 混合方案: Progress Percentage + Progress Notes（进度百分比 + 进度备注）

```
╭────────────────────────────────────────────────────────────╮
│ 🎯 Migrate Express to Fastify (active)                     │
│                                                            │
│ 📊 Task Progress: 45%                                      │
│ [█████████░░░░░░░░░░░]                                     │
│                                                            │
│ ✅ Completed Steps:                                        │
│   • Analyzed Express router structure                      │
│   • Designed Fastify architecture                          │
│   • Created JWT authentication utility                     │
│                                                            │
│ 🔄 Current Activity:                                       │
│   • Updating middleware layer                              │
│                                                            │
│ 💾 Budget: 12,500 / 50,000 tokens (25% used)               │
│ ⏱️  Time: 1m 30s                                           │
╰────────────────────────────────────────────────────────────╯
```

**特点：**
- ✅ 进度百分比 + 完成的步骤列表
- ✅ 模型报告进度 + 自动累积备注
- ✅ 平衡简洁性和详细信息
- ⚠️ 需要模型定期报告进度

**适用场景：** 想要进度概览 + 具体完成内容

---

## 无预算场景对比

所有方案在无预算时都显示 Token 消耗信息，但进度条语义不同：

**方案 A（无预算）：**
```
│ 📊 Task Progress: 20%                                      │
│ [████░░░░░░░░░░░░░░░░░░]                                   │
│ 📊 Tokens Consumed: 15,000 (unbounded budget)              │
```

**方案 B（无预算）：**
```
│ 📊 Tasks Progress: 1/5 completed (20%)                     │
│ [████░░░░░░░░░░░░░░░░░░]                                   │
│ ✅ 1. 检查测试文件完整性                                   │
│ 🔄 2. 分析修复内容 (in progress)                           │
│ ⏳  3-5 ...                                                │
```

**关键差异：**
- 方案 A：进度条表示任务完成百分比
- 方案 B：进度条表示任务完成数量
- 方案 D：进度条表示多维度推断进度

---

## 对比总结表

| 方案 | 进度精确度 | 视觉空间 | 实现复杂度 | 自动化程度 | 推荐场景 |
|------|-----------|---------|-----------|-----------|---------|
| **A** | Medium（主观百分比） | Compact | Simple | ❌ Manual | 追求简洁 |
| **B** | High（精确计数） | Large | Complex | ❌ Manual | 复杂任务跟踪 |
| **C** | High（TodoWrite） | Medium | Medium | ❌ Manual | 集成 TodoWrite |
| **D** | Medium（推断） | Medium | Complex | ✅ Auto | 自动化场景 |
| **Hybrid** | Medium+Notes | Medium | Medium | ❌ Manual | 平衡方案 |

---

## 实现建议

### 推荐选择

1. **最简单实现：方案 A**
   - 添加 `progress: number` 字段
   - 修改 `update_goal` 工具接受进度参数
   - GoalProgress 显示进度条

2. **最精确实现：方案 B**
   - 添加 `tasks: GoalTask[]` 字段
   - 实现任务管理逻辑（创建、更新、删除）
   - GoalProgress 显示任务列表和进度条

3. **最平衡实现：混合方案**
   - 添加 `progress: number` + `progressNotes: string[]`
   - 修改 `update_goal` 工具接受进度和备注
   - GoalProgress 显示进度条和备注列表

### 技术要点

**Goal 结构修改：**
```typescript
export interface Goal {
  // 现有字段
  id: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number

  // 方案 A/Hybrid 新增字段
  progress?: number              // 0-100 任务完成百分比
  progressNotes?: string[]       // 进度备注列表（完成的步骤）
}
```

**update_goal 工具修改：**
```typescript
z.strictObject({
  status: z.enum(['active', 'paused', 'complete']),
  summary: z.string().optional(),
  progress: z.number().min(0).max(100).optional(),        // 新增
  progressNote: z.string().optional(),                     // 新增（单条备注）
})
```

---

## 运行样例

```bash
bun test-goal-schemes.ts
```

查看所有方案的可视化对比。

---

**你的选择？**

请告诉我你倾向哪个方案，我可以立即开始实现！