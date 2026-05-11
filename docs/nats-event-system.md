# NATS Event System

## 概述

NATS 事件系统为 Claude Code 提供跨进程事件传递、事件持久化和多实例支持。

## 快速开始

### 安装 NATS 服务器

```bash
./scripts/setup-nats.sh install
```

### 启动 NATS 服务器

```bash
./scripts/setup-nats.sh start
```

### 检查状态

```bash
./scripts/setup-nats.sh status
```

### 停止 NATS 服务器

```bash
./scripts/setup-nats.sh stop
```

## 架构

```
工具/组件 → EventEmitter → EventRouter → NATS Publisher → NATS Server (JetStream)
                                    ↓                              ↓
                          SdkEventQueue(内存 Fallback)    NATS Subscriber
                                    ↓                              ↓
                          drainSdkEvents()              外部消费者/多实例
```

## 配置

### 环境变量

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `CLAUDE_ENABLE_NATS` | `true` | 是否启用 NATS |
| `CLAUDE_NATS_SERVER` | `nats://localhost:4222` | NATS 服务器 URL |
| `CLAUDE_NATS_CONNECT_TIMEOUT` | `5000` | 连接超时 (ms) |
| `CLAUDE_NATS_RECONNECT_INTERVAL` | `2000` | 重连间隔 (ms) |
| `CLAUDE_NATS_MAX_RECONNECT_ATTEMPTS` | `10` | 最大重连次数 |
| `CLAUDE_NATS_JETSTREAM` | `true` | 是否启用 JetStream |
| `CLAUDE_NATS_STREAM` | `CLAUDE_EVENTS` | JetStream 流名称 |

## Fallback 机制

当 NATS 服务器不可用时，系统自动降级到内存队列：

1. 事件首先尝试发布到 NATS
2. 如果 NATS 不可用，事件进入内存队列
3. NATS 恢复连接后，自动刷新暂存事件

## 事件主题

| 主题 | 描述 |
|------|------|
| `claude.<session>.task_started` | 任务启动 |
| `claude.<session>.task_progress` | 任务进度 |
| `claude.<session>.task_notification` | 任务通知 |
| `claude.<session>.session_state` | 会话状态 |
| `claude.<session>.goal.*` | 目标事件 |
| `claude.<session>.compact.*` | Compact 事件 |
| `claude.<session>.tool.*` | 工具事件 |

## 开发模式

使用开发模式启动时，NATS 服务器会自动尝试连接：

```bash
bun run dev
```

如果不需要 NATS，设置 `CLAUDE_ENABLE_NATS=false`：

```bash
CLAUDE_ENABLE_NATS=false bun run dev
```

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/services/eventBus/types.ts` | 类型定义 |
| `src/services/eventBus/config.ts` | 配置管理 |
| `src/services/eventBus/NatsEventBus.ts` | NATS 事件总线核心实现 |
| `src/services/eventBus/EventRouter.ts` | 事件路由器（NATS ↔ 内存队列） |
| `src/services/eventBus/natsServer.ts` | 本地 NATS 服务器管理 |
| `src/utils/sdkEventQueue.ts` | SDK 事件队列（集成点） |
| `src/ink/events/emitter.ts` | EventEmitter（转发器） |
| `scripts/setup-nats.sh` | 一键启动脚本 |
