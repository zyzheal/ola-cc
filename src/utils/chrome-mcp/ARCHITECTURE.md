# Chrome MCP 架构设计文档

## 一、架构概述

### 设计目标

1. **双协议兼容**：同时支持 OLA 协议和 mcp-chrome 协议
2. **模块化设计**：清晰的职责分离，便于维护和扩展
3. **高可靠性**：心跳检测、请求超时、自动重连
4. **可扩展性**：未来添加新协议或新功能不影响现有代码

### 核心架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome MCP 架构                          │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  入口层 (Entry)                      │   │
│  │  chromeNativeHost.ts - CLI 入口                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  协议层 (Protocol)                   │   │
│  │  ┌──────────────┐  ┌──────────────┐                │   │
│  │  │ Native Host  │  │ Message      │                │   │
│  │  │ 核心实现     │  │ Handler      │                │   │
│  │  └──────────────┘  └──────────────┘                │   │
│  │  ┌──────────────┐  ┌──────────────┐                │   │
│  │  │ Request      │  │ Heartbeat    │                │   │
│  │  │ Tracker      │  │ Manager      │                │   │
│  │  └──────────────┘  └──────────────┘                │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  传输层 (Transport)                  │   │
│  │  ┌──────────────┐  ┌──────────────┐                │   │
│  │  │ Socket       │  │ Native       │                │   │
│  │  │ Server       │  │ Messaging    │                │   │
│  │  └──────────────┘  └──────────────┘                │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  工具层 (Tools)                      │   │
│  │  ┌──────────────┐  ┌──────────────┐                │   │
│  │  │ Name Mapper  │  │ Registry     │                │   │
│  │  └──────────────┘  └──────────────┘                │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  工具函数 (Utils)                    │   │
│  │  Logger, ErrorHandler, Validators                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  常量 (Constants)                    │   │
│  │  MessageTypes, Timeouts, Defaults                  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、文件目录结构

```
src/utils/chrome-mcp/
├── index.ts                          # 统一导出入口
├── types.ts                          # 类型定义
├── constants/                        # 常量配置
│   ├── message-types.ts              # 消息类型枚举（双协议）
│   ├── timeouts.ts                   # 超时配置
│   └── defaults.ts                   # 默认值配置
├── protocol/                         # 协议层
│   ├── native-host.ts                # Native Host 核心实现
│   ├── message-handler.ts            # 消息路由和处理
│   ├── request-tracker.ts            # 请求/响应跟踪（requestId）
│   └── heartbeat.ts                  # 心跳机制
├── tools/                            # 工具层
│   ├── name-mapper.ts                # 工具名称映射
│   ├── registry.ts                   # 工具注册表（待实现）
│   └── cache.ts                      # 工具列表缓存（待实现）
└── utils/                            # 工具函数
    ├── logger.ts                     # 日志工具
    ├── error-handler.ts              # 错误处理（待实现）
    └── validators.ts                 # 消息验证（待实现）
```

---

## 三、核心模块说明

### 3.1 Native Host（核心实现）

**职责**：
- 管理 Socket 服务器
- 处理 Native Messaging 通信
- 协调各子模块工作

**关键方法**：
- `start()` - 启动 Native Host
- `stop()` - 停止 Native Host
- `sendToExtension()` - 发送消息到扩展
- `getConnectionStatus()` - 获取连接状态
- `getHealthStatus()` - 获取健康状态

### 3.2 Message Handler（消息处理）

**职责**：
- 路由不同类型的消息
- 处理双协议消息
- 调用相应的处理逻辑

**支持的消息类型**：
| 协议 | 消息类型 | 处理方式 |
|------|---------|---------|
| OLA | `tool_request` | 转发到扩展 |
| OLA | `tool_response` | 转发到 MCP Clients |
| OLA | `mcp_connected` | 更新连接状态 |
| mcp-chrome | `call_tool` | 执行工具调用 |
| mcp-chrome | `responseToRequestId` | 处理响应 |
| mcp-chrome | `EXECUTE_TOOL` | 执行工具调用 |
| 共有 | `start/stop/ping` | 标准处理 |

### 3.3 Request Tracker（请求跟踪）

**职责**：
- 管理带 requestId 的请求
- 处理超时和取消
- 请求/响应匹配

**关键特性**：
- UUID 生成 requestId
- 可配置超时时间
- 最大待处理请求限制（默认 100）
- 自动清理过期请求

### 3.4 Heartbeat Manager（心跳管理）

**职责**：
- 定期发送心跳检测连接
- 超时检测
- 自动重连触发

**配置参数**：
- 心跳间隔：30 秒（默认）
- 心跳超时：10 秒（默认）
- 最大失败次数：3 次（默认）

### 3.5 Tool Name Mapper（工具名称映射）

**职责**：
- OLA 格式 ↔ mcp-chrome 格式转换
- 标准化工具名称

**映射规则**：
```
OLA 格式：mcp__claude-in-chrome__browser_navigate
mcp-chrome 格式：chrome_navigate
```

---

## 四、双协议兼容机制

### 4.1 消息协议对比

| 特性 | OLA 协议 | mcp-chrome 协议 |
|------|---------|----------------|
| 工具调用 | `tool_request` (method, params) | `call_tool` (requestId, payload) |
| 工具响应 | `tool_response` (data) | `responseToRequestId` (requestId, payload) |
| 请求跟踪 | 无 requestId | 有 requestId |
| 心跳 | 无 | `heartbeat_ping/pong` |
| 启动 | 无 | `start/server_started` |

### 4.2 兼容策略

1. **消息识别**：通过 `getProtocolForMessage()` 识别消息来源
2. **统一处理**：MessageHandler 统一处理两种协议
3. **名称映射**：ToolNameMapper 自动转换工具名称
4. **响应适配**：根据请求协议格式返回响应

---

## 五、使用示例

### 5.1 基本使用

```typescript
import { createNativeHost } from './chrome-mcp';

// 创建 Native Host 实例
const nativeHost = createNativeHost({
  logLevel: 'info',
});

// 设置工具调用回调
nativeHost.setOnToolCallCallback(async (request) => {
  // 调用扩展工具
  const result = await callExtensionTool(request.name, request.args);
  return result;
});

// 启动
await nativeHost.start();
```

### 5.2 检查健康状态

```typescript
const health = nativeHost.getHealthStatus();
console.log(health);
// {
//   status: 'ok',
//   version: '1.0.0',
//   mode: 'socket',
//   pendingRequests: 0,
//   uptime: 123456,
// }
```

### 5.3 优雅关闭

```typescript
process.on('SIGINT', async () => {
  await nativeHost.stop();
  process.exit(0);
});
```

---

## 六、扩展指南

### 6.1 添加新消息类型

1. 在 `constants/message-types.ts` 中添加枚举值
2. 在 `protocol/message-handler.ts` 中添加处理逻辑
3. 更新 `PROTOCOL_MAP` 映射

### 6.2 添加工具支持

1. 在 `tools/name-mapper.ts` 中添加映射规则
2. 在扩展侧实现工具执行逻辑

### 6.3 添加新传输层

1. 在 `transport/` 目录下创建新文件
2. 实现统一的传输接口
3. 在 `native-host.ts` 中集成

---

## 七、测试指南

### 7.1 单元测试

```bash
# 运行单元测试
bun test src/utils/chrome-mcp/
```

### 7.2 集成测试

```bash
# 启动 Native Host
cli --chrome-native-host

# 检查健康状态
curl http://127.0.0.1:12306/health
```

---

## 八、性能指标

| 指标 | 值 | 说明 |
|------|-----|------|
| 启动时间 | < 1 秒 | 冷启动 |
| 内存占用 | ~30 MB | 基础运行 |
| 消息延迟 | < 10 ms | 本地 Socket |
| 最大并发 | 100 | 待处理请求 |
| 心跳间隔 | 30 秒 | 可配置 |

---

## 九、故障排查

### 9.1 Socket 文件不存在

```bash
# 检查 Socket 目录
ls -la /tmp/claude-mcp-browser-bridge-$USER/
```

### 9.2 扩展未连接

```bash
# 检查扩展日志
# Chrome: chrome://extensions/ → Service Worker 日志
```

### 9.3 心跳超时

```bash
# 检查进程状态
ps aux | grep chrome-native-host
```

---

## 十、版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初始版本，双协议支持 |
