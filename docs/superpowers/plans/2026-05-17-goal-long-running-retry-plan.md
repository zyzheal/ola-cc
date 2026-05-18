# Goal 长时间兜底重试机制实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/goal` 命令添加长时间兜底重试机制，在 10 次指数退避重试全部失败后，以固定间隔（默认 10 分钟）重新执行 goal。

**Architecture:** 在 goal command handler 中实现兜底逻辑，检测 `CannotRetryError` 后进入固定间隔重试循环。每次重试输出进度信息，包含重试次数、下次重试时间、上次错误。

**Tech Stack:** TypeScript, React/Ink (CLI UI),现有 withRetry.ts 机制

---

## 文件结构

```
src/commands/goal/
├── goal.tsx              # 修改：添加参数解析和兜底重试逻辑
├── types.ts              # 修改：添加重试配置类型
└── index.ts              # 无需修改

src/services/api/
└── withRetry.ts          # 复用：检测 CannotRetryError
```

---

## Task 1: 添加重试配置类型

**Files:**
- Modify: `src/commands/goal/types.ts:52-53`
- Test: N/A (类型定义)

- [ ] **Step 1: 在 Goal 接口中添加重试配置字段**

在 `Goal` 接口中添加：
```typescript
export interface Goal {
  // ... existing fields
  retryConfig?: {
    enabled: boolean;
    intervalMs: number;
    maxRetryHours: number;
  };
}
```

- [ ] **Step 2: 添加 getRetryConfig 函数**

在 `types.ts` 文件末尾添加：
```typescript
// 默认配置
const DEFAULT_RETRY_INTERVAL_MS = 600000; // 10 分钟
const DEFAULT_MAX_RETRY_HOURS = 24;

export interface RetryConfig {
  enabled: boolean;
  intervalMs: number;
  maxRetryHours: number;
}

export function getRetryConfig(args: {
  retryInterval?: string;
  maxRetryHours?: number;
}): RetryConfig {
  // 环境变量
  const envInterval = parseInt(process.env.OLA_CC_GOAL_RETRY_INTERVAL_MS || '', 10);
  const envMaxHours = parseInt(process.env.OLA_CC_GOAL_MAX_RETRY_HOURS || '', 10);

  // 参数解析
  let intervalMs = DEFAULT_RETRY_INTERVAL_MS;
  if (args.retryInterval) {
    const match = args.retryInterval.match(/^(\d+)(m|s|h)$/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      const multipliers = { m: 60000, s: 1000, h: 3600000 };
      intervalMs = value * (multipliers[unit as keyof typeof multipliers] || 60000);
    }
  } else if (!isNaN(envInterval)) {
    intervalMs = envInterval;
  }

  const maxRetryHours = args.maxRetryHours ?? (isNaN(envMaxHours) ? DEFAULT_MAX_RETRY_HOURS : envMaxHours);

  return {
    enabled: true, // /goal 发起时默认启用兜底
    intervalMs,
    maxRetryHours,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/goal/types.ts
git commit -m "feat(goal): add retry config type and getRetryConfig function"
```

---

## Task 2: 解析 /goal 命令的新参数

**Files:**
- Modify: `src/commands/goal/goal.tsx:29-38`, `src/commands/goal/goal.tsx:40-80`
- Test: N/A (CLI 命令测试)

- [ ] **Step 1: 扩展 GoalCommandArgs 接口**

在 `goal.tsx` 第 29-38 行，修改 `GoalCommandArgs` 接口：
```typescript
interface GoalCommandArgs {
  objective?: string
  action?: 'status' | 'pause' | 'resume' | 'clear' | 'edit' | 'budget' | 'mode'
  tokenBudget?: number
  autoAccept?: boolean
  autoEdit?: boolean
  mode?: GoalMode
  editObjective?: string
  newBudget?: number
  // 新增
  retryInterval?: string  // e.g., "5m", "10m", "30s"
  maxRetryHours?: number
}
```

- [ ] **Step 2: 扩展 parseGoalArgs 函数**

在 `parseGoalArgs` 函数中添加参数解析（第 40-80 行），在 `const budgetIndex = args.indexOf('--budget')` 之前添加：

```typescript
  // 解析 --retry-interval / -r
  const retryIntervalIndex = args.findIndex(a => a === '--retry-interval' || a === '-r')
  let retryInterval: string | undefined
  if (retryIntervalIndex !== -1 && args[retryIntervalIndex + 1]) {
    retryInterval = args[retryIntervalIndex + 1]
    args = args.filter((_, i) => i !== retryIntervalIndex && i !== retryIntervalIndex + 1)
  }

  // 解析 --max-hours / -t
  const maxHoursIndex = args.findIndex(a => a === '--max-hours' || a === '-t')
  let maxRetryHours: number | undefined
  if (maxHoursIndex !== -1 && args[maxHoursIndex + 1]) {
    maxRetryHours = parseInt(args[maxHoursIndex + 1], 10)
    args = args.filter((_, i) => i !== maxHoursIndex && i !== maxHoursIndex + 1)
  }
```

- [ ] **Step 3: 在返回对象中添加新字段**

在 `parseGoalArgs` 函数返回对象中添加 `retryInterval` 和 `maxRetryHours`：
- 找到 `return { objective: args.join(' '), tokenBudget, autoAccept, autoEdit, mode }`
- 修改为 `return { objective: args.join(' '), tokenBudget, autoAccept, autoEdit, mode, retryInterval, maxRetryHours }`

- [ ] **Step 4: 在 call 函数中提取新参数**

在第 107 行附近，修改解构：
```typescript
const { objective, action, tokenBudget, autoAccept, autoEdit, mode, editObjective, newBudget, retryInterval, maxRetryHours } = parseGoalArgs(argsArray)
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/goal/goal.tsx
git commit -m "feat(goal): add --retry-interval and --max-hours parameters"
```

---

## Task 3: 实现 goal 兜底重试逻辑

**Files:**
- Modify: `src/commands/goal/goal.tsx:198-305` (创建新 goal 的逻辑)
- Test: N/A (集成测试)

- [ ] **Step 1: 导入必要的模块**

在 `goal.tsx` 顶部添加导入：
```typescript
import { CannotRetryError } from '../../services/api/withRetry.js'
import { sleep } from '../../utils/sleep.js'
import { getRetryConfig, type RetryConfig } from './types.js'
```

- [ ] **Step 2: 创建 executeGoalWithFallback 函数**

在 `goal.tsx` 文件中，在 `createDefaultGoalTasks` 函数之后添加：
```typescript
async function executeGoalWithFallback(
  context: { getAppState: () => any; setAppState: (updater: (s: any) => any) => void },
  goal: Goal,
  retryConfig: RetryConfig,
  onDone: (message: string, options?: any) => void,
): Promise<void> {
  const startTime = Date.now()
  let retryNumber = 0
  const sessionId = goal.todoListId || goal.id

  while (true) {
    try {
      // 设置 goal 为运行中状态
      context.setAppState(s => ({
        ...s,
        goal: { ...s.goal, status: ThreadGoalStatus.Active, updatedAt: Date.now() }
      })

      // 触发查询执行（包含阶段 1 的 10 次重试）
      // 这里通过 shouldQuery: true 让 QueryEngine 执行
      // 成功时 QueryEngine 会更新 goal 状态为 Complete
      return // 成功执行后返回
    } catch (error) {
      // 检查是否是所有重试都失败了
      const isAllRetriesFailed = error instanceof CannotRetryError
      
      if (!isAllRetriesFailed) {
        throw error // 非 CannotRetryError，原样抛出
      }

      const now = Date.now()
      const elapsed = now - startTime

      // 检查是否超过最大时间
      if (elapsed > retryConfig.maxRetryHours * 3600000) {
        throw new Error('Goal retry timeout: exceeded maximum retry hours')
      }

      // 检查是否是永久错误（401/403）
      if (error.originalError && typeof error.originalError === 'object') {
        const status = (error.originalError as any).status
        if (status === 401 || status === 403) {
          throw error // 永久错误，不再重试
        }
      }

      retryNumber++

      // 输出兜底重试信息
      const nextRetryAt = new Date(now + retryConfig.intervalMs)
      const retryMessage = `🔄 Goal 正在重试 (第 ${retryNumber} 次)
   上次错误: ${error.message || 'Unknown error'}
   下次重试: ${nextRetryAt.toLocaleTimeString()} (${Math.round(retryConfig.intervalMs / 60000)} 分钟后)
   已耗时: ${Math.round(elapsed / 60000)} 分钟`

      onDone(retryMessage, { display: 'system' })

      // 等待固定间隔
      await sleep(retryConfig.intervalMs)
      // 继续循环重试
    }
  }
}
```

注意：上述函数是伪代码，因为 goal 的执行是通过 `shouldQuery: true` 触发的，实际的兜底逻辑需要在更高层实现。

- [ ] **Step 3: 在 Goal 创建后添加兜底逻辑**

在 `goal.tsx` 第 302-304 行附近，找到创建 goal 后的逻辑。需要重新设计这部分：

当前逻辑：
```typescript
const message = `目标已创建：${objective}...`
onDone(message, { display: 'system', metaMessages: [continuationPrompt], shouldQuery: true })
```

修改为：创建一个包装函数来处理兜底重试。实际上，由于 goal 是通过 QueryEngine 异步执行的，兜底逻辑需要在 QueryEngine 层面处理。

- [ ] **Step 4: 在 Goal 类型中保存重试配置**

在创建 `newGoal` 时（第 205-216 行），添加：
```typescript
const newGoal: Goal = {
  // ... existing fields
  retryConfig: getRetryConfig({ retryInterval, maxRetryHours }),
}
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/goal/goal.tsx
git commit -m "feat(goal): integrate retry config into goal creation"
```

---

## Task 4: 在 QueryEngine 中实现兜底检测

**Files:**
- Modify: `src/QueryEngine.ts`
- Test: N/A (集成测试)

- [ ] **Step 1: 找到 CannotRetryError 处理位置**

在 `QueryEngine.ts` 中搜索 `CannotRetryError` 或 tool completed 事件的处理位置。

- [ ] **Step 2: 添加 goal 兜底检测逻辑**

在检测到 `CannotRetryError` 后，检查当前是否有活跃的 goal，如果有，则触发兜底重试逻辑。

```typescript
// 在 QueryEngine 中，当收到 CannotRetryError 时
if (error instanceof CannotRetryError) {
  const appState = getAppState()
  const goal = appState.goal

  if (goal && goal.status === ThreadGoalStatus.Active && goal.retryConfig?.enabled) {
    // 触发 goal 层面的兜底重试
    // 需要记录当前 goal 的状态，并在固定间隔后重新触发查询
    scheduleGoalRetry(goal, error, getRetryConfigFromGoal(goal))
  }
}
```

- [ ] **Step 3: 实现 scheduleGoalRetry 函数**

在 QueryEngine 或单独的文件中实现：
```typescript
async function scheduleGoalRetry(
  goal: Goal,
  lastError: CannotRetryError,
  retryConfig: RetryConfig,
): Promise<void> {
  const retryNumber = (goal.retryCount || 0) + 1
  const nextRetryAt = Date.now() + retryConfig.intervalMs

  // 输出重试信息
  outputRetryStatus(retryNumber, retryConfig.intervalMs, lastError.message)

  // 更新 goal 的重试计数
  setAppState(s => ({
    ...s,
    goal: { ...s.goal, retryCount: retryNumber }
  }))

  // 等待固定间隔
  await sleep(retryConfig.intervalMs)

  // 重新触发查询执行
  // 通过设置 shouldQuery: true 来重新启动 goal 执行
}
```

- [ ] **Step 4: Commit**

```bash
git add src/QueryEngine.ts
git commit -m "feat(goal): add fallback retry detection in QueryEngine"
```

---

## Task 5: 输出格式优化

**Files:**
- Modify: `src/commands/goal/goal.tsx`
- Test: N/A

- [ ] **Step 1: 实现结构化输出**

每次兜底重试时，输出结构化的系统消息：
```typescript
const retryStatus = {
  type: 'system' as const,
  subtype: 'goal_retry',
  retryNumber,
  nextRetryAt: new Date(Date.now() + retryConfig.intervalMs).toISOString(),
  lastError: error.message,
  elapsedMinutes: Math.round(elapsed / 60000),
}
onDone(retryMessage, { display: 'system', metadata: retryStatus })
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/goal/goal.tsx
git commit -m "feat(goal): add structured retry status output"
```

---

## Task 6: 更新文档和测试

**Files:**
- Modify: `docs/feature-guide-users.md` 或新建 `docs/05-goal.md`
- Test: 手动测试

- [ ] **Step 1: 添加用户文档**

在 `docs/` 中添加或更新 goal 文档：
```markdown
## Goal 长时间兜底重试

当使用 `/goal` 命令时，如果遇到 API 请求失败：
- 阶段 1：系统会自动进行 10 次指数退避重试（0.5s → 32s）
- 阶段 2：如果 10 次都失败，将自动进入兜底模式，每 10 分钟重新执行 goal

### 配置选项

```bash
# 使用默认配置（10 分钟间隔，24 小时上限）
/goal "帮我写一个排序算法"

# 自定义重试间隔（5 分钟）
/goal "帮我写一个排序算法" --retry-interval 5m

# 自定义最大重试时间（48 小时）
/goal "帮我写一个排序算法" --max-hours 48

# 组合使用
/goal "帮我写一个排序算法" -r 5m -t 48
```

也可以通过环境变量配置：
```bash
OLA_CC_GOAL_RETRY_INTERVAL_MS=300000     # 5 分钟
OLA_CC_GOAL_MAX_RETRY_HOURS=48            # 48 小时
```

### 终止条件

兜底重试会在以下情况终止：
- goal 成功完成
- 用户手动取消（`/clear`）
- 超过最大重试时间
- 遇到永久性错误（401/403 认证错误）
```

- [ ] **Step 2: 手动测试**

1. 使用 `--retry-interval 10s` 参数快速测试兜底机制
2. 验证每次重试都输出进度信息
3. 验证 goal 完成后兜底终止
4. 验证 `/clear` 后兜底终止

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: add goal fallback retry documentation"
```

---

## 实现顺序总结

1. **Task 1**: 添加重试配置类型 (`types.ts`)
2. **Task 2**: 解析 /goal 命令的新参数 (`goal.tsx`)
3. **Task 3**: 在 Goal 创建时保存配置
4. **Task 4**: 在 QueryEngine 中实现兜底检测
5. **Task 5**: 输出格式优化
6. **Task 6**: 文档和测试

---

## 注意事项

1. 由于 goal 是通过 `shouldQuery: true` 异步执行的，兜底逻辑需要在 QueryEngine 层面检测 `CannotRetryError` 并触发
2. 需要确保兜底期间用户输入能立即终止重试
3. 401/403 错误应立即终止兜底，避免无限重试
4. 建议用户使用 `--bg` 模式运行长时间 goal