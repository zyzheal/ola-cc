# Goal 长时间兜底重试机制设计

## 背景

当前系统的重试机制（`withRetry.ts`）采用指数退避策略，默认 10 次重试后放弃。但在某些场景下（如网络不稳定、API 临时波动、用户离开电脑），用户希望即使 10 次重试都失败，也能继续自动重试，直到任务完成。

## 目标

为 `/goal` 命令添加长时间兜底重试机制：
- 阶段 1：现有指数退避重试（10 次）
- 阶段 2：10 次都失败后，在 goal 内部以固定间隔重新执行 goal

## 架构概述

```
用户发起 /goal
    ↓
阶段 1：指数退避重试（10 次）
    ├── 尝试 1 → 失败 → 等待 0.5s
    ├── 尝试 2 → 失败 → 等待 1s
    ├── 尝试 3 → 失败 → 等待 2s
    ... (指数增长)
    └── 尝试 10 → 失败
    ↓ 10次都失败
阶段 2：Goal 内部兜底（每 10 分钟重新执行 goal）
    ↓
每次兜底重试输出进度
    ↓
Goal 完成/取消/超时 → 兜底终止
```

## 两阶段设计

### 阶段 1：快速重试（现有机制）

- 指数退避：0.5s → 1s → 2s → 4s → ... → 最大 32s
- **固定 10 次重试**
- 读取 `retry-after` header
- 触发条件：API 请求失败

### 阶段 2：兜底重试（新增）

**触发条件**：
- 阶段 1 的 10 次重试全部失败
- 用户通过 `/goal` 发起任务

**实现位置**：
- 在 goal command handler 或 goalRuntime 中实现
- 而非在 `withRetry.ts` 层

**行为**：
1. 每隔配置的间隔（默认 10 分钟）重新执行整个 goal
2. 每次重试都输出进度消息：
   ```json
   { 
     "type": "system", 
     "subtype": "goal_retry", 
     "retryNumber": 1,
     "nextRetryAt": "2026-05-17T10:10:00Z",
     "lastError": "API rate limit exceeded"
   }
   ```
3. 使用 heartbeat 机制（30 秒）避免会话被标记为 idle

**终止条件**：
- goal 成功完成
- 用户手动取消（`/clear` 或 `/cancel`）
- 超过 `maxRetryHours` 设置的最大时间

## 配置项

| 配置项 | 默认值 | 说明 | 优先级 |
|--------|--------|------|--------|
| `OLA_CC_GOAL_RETRY_INTERVAL_MS` | 600000 (10 分钟) | 兜底重试间隔 | 2 |
| `OLA_CC_GOAL_MAX_RETRY_HOURS` | 24 | 兜底最大重试小时数 | 2 |

### /goal 命令参数

| 参数 | 简写 | 说明 | 格式 |
|------|------|------|------|
| `--retry-interval` | `-r` | 兜底重试间隔 | `5m`, `10m`, `30s` |
| `--max-hours` | `-t` | 最大重试小时数 | 数字 |

### 配置优先级

1. `/goal` 命令参数（最高）
2. 环境变量
3. 代码硬编码默认值（600000ms / 24h）

## 实现要点

### 1. 修改 /goal 命令

- 解析 `--retry-interval` 和 `--max-hours` 参数
- 将参数传递给 goal 执行上下文

### 2. Goal 运行时兜底逻辑

在 `src/commands/goal/` 或 `src/utils/goal/goalRuntime.ts` 中：

```typescript
async function executeGoalWithFallback(args: GoalCommandArgs) {
  const retryConfig = getRetryConfig(args)  // 获取配置

  while (true) {
    try {
      // 执行 goal（包含阶段 1 的 10 次重试）
      await executeGoal(args)
      break  // 成功，退出
    } catch (error) {
      // 检查是否所有 10 次重试都失败了
      if (isAllRetriesFailed(error)) {
        const now = Date.now()
        const elapsed = now - startTime

        // 检查是否超过最大时间
        if (elapsed > retryConfig.maxRetryHours * 3600000) {
          throw new Error('Goal retry timeout')
        }

        // 检查是否有永久错误（401/403）
        if (isPermanentError(error)) {
          throw error  // 不再重试
        }

        // 输出兜底重试信息
        outputRetryStatus(retryNumber, retryConfig.intervalMs, error)

        // 等待固定间隔
        await sleep(retryConfig.intervalMs)
        retryNumber++
        continue
      }

      throw error  // 非 10 次全失败，原样抛出
    }
  }
}
```

### 3. 输出格式

每次兜底重试时输出：

```
🔄 Goal 正在重试 (第 1 次)
   上次错误: API rate limit exceeded
   下次重试: 10:10:00 (10 分钟后)
   已耗时: 10 分钟
```

### 4. 与 UNATTENDED_RETRY 的关系

- **阶段 1**：复用现有的 `withRetry.ts` 机制（指数退避，10 次）
- **阶段 2**：独立实现，在 goal 运行时层处理
- 两个机制互补：阶段 1 处理 API 层重试，阶段 2 处理任务层重试

## 边界情况处理

| 场景 | 处理 |
|------|------|
| 401/403 永久错误 | 立即终止兜底，不继续重试 |
| 用户在兜底期间输入内容 | 立即终止兜底，正常响应用户 |
| 网络完全中断 | 兜底继续，等待网络恢复 |
| 进程被 kill | 无法恢复（进程级限制），可配合 `--bg` 模式使用 |
| 兜底期间用户取消 goal | 兜底终止 |

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 进程退出导致任务中断 | 建议使用 `--bg` 模式运行长时间 goal |
| 永久错误无限重试 | 401/403 立即终止兜底 |
| 用户不知道任务在重试 | 每次兜底重试都输出进度 |
| 会话被标记为 idle | 30 秒 heartbeat |

## 测试策略

1. 单元测试：兜底逻辑、配置解析
2. 集成测试：
   - 10 次失败后自动进入兜底
   - 兜底期间按时输出进度
   - goal 完成时兜底终止
   - 手动取消时兜底终止
   - 401/403 错误时立即终止
3. 手动测试：使用 `--bg` 模式运行长时间 goal