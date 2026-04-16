# Chrome MCP — 浏览器自动化（融合版）

> 源码位置：`src/utils/claudeInChrome/`、`shims/ant-claude-for-chrome-mcp/`

通过 **Chrome Native Messaging 协议** 实现的浏览器自动化能力，允许 Claude Code 直接控制用户的 Chrome 浏览器。

**融合架构**：结合 MCP Client 实时通信 + HTTP API 外部调用，一次启动全部可用。

---

## 功能概述

Claude in Chrome MCP 融合版提供完整的浏览器自动化系统：

- **MCP 模式** - Claude Code AI 实时控制浏览器
- **HTTP API** - 外部程序可通过 HTTP 调用（端口 12306）
- **Extension 控制** - 扩展可控制服务器启动/停止

### 浏览器操作能力

- **页面导航** - 打开/关闭标签页、前后进后退
- **DOM 操作** - 点击元素、填写表单、选择选项、拖拽
- **截图捕获** - 全屏/可见区域/元素截图
- **日志调试** - 读取控制台输出、网络请求
- **GIF 录制** - 录制操作过程生成 GIF
- **JavaScript 执行** - 在页面上下文中运行自定义脚本
- **弹窗处理** - 处理 alert/confirm/prompt 对话框

---

## 融合架构设计

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           融合后的 Chrome MCP 架构                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                         Claude Code CLI (统一入口)                               │
│                               │                                                 │
│                               │ 启动时自动运行                                    │
│                               ↓                                                 │
│                    ┌─────────────────────────────┐                              │
│                    │     Native Host (融合版)     │                              │
│                    │                             │                              │
│                    │  ┌─────────┐  ┌─────────┐  │                              │
│                    │  │ Socket  │  │  HTTP   │  │                              │
│                    │  │ Server  │  │ Server  │  │                              │
│                    │  │ (MCP)   │  │ (12306) │  │                              │
│                    │  └────┬────┘  └────┬────┘  │                              │
│                    │       │            │       │                              │
│                    │       └──────┬─────┘       │                              │
│                    │              │             │                              │
│                    │    ┌─────────▼─────────┐   │                              │
│                    │    │   消息路由层       │   │                              │
│                    │    │                   │   │                              │
│                    │    │ - MCP → Extension │   │                              │
│                    │    │ - HTTP → Extension│   │                              │
│                    │    └─────────┬─────────┘   │                              │
│                    └──────────────┼─────────────┘                              │
│                                   │ stdin/stdout                                │
│                                   ↓                                             │
│                    ┌─────────────────────────────┐                              │
│                    │   Extension (改造版)        │                              │
│                    │                             │                              │
│                    │  角色 1: 控制者              │                              │
│                    │  - START/STOP 控制          │                              │
│                    │                             │                              │
│                    │  角色 2: 执行者              │                              │
│                    │  - 接收 tool_request        │                              │
│                    │  - 接收 CALL_TOOL           │                              │
│                    │  - 返回 tool_response       │                              │
│                    └──────────────┬──────────────┘                              │
│                                   │                                             │
│                                   ↓                                             │
│                    ┌─────────────────────────────┐                              │
│                    │      Chrome Browser         │                              │
│                    └─────────────────────────────┘                              │
│                                                                                 │
│  外部调用入口:                                                                  │
│  1. MCP Client (Claude Code AI) → Socket → 实时交互                             │
│  2. HTTP Client (Python/Bash/Webhook/CI) → HTTP → 自动化调用                    │
│  3. Extension → 直接控制 Native Host                                            │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 核心组件

| 组件 | 位置 | 说明 |
|------|------|------|
| **Native Host 融合版** | `src/utils/claudeInChrome/chromeNativeHost.ts` | Socket Server + HTTP Server + 消息路由 |
| **Extension 改造版** | `mcp-chrome/.../native-host.ts` | 处理新消息类型 (CALL_TOOL, EXECUTE_TOOL) |
| **Setup** | `src/utils/claudeInChrome/setup.ts` | 安装 Native Host 清单、包装脚本 |
| **Skill** | `src/skills/bundled/claudeInChrome.ts` | 注册 `/claude-in-chrome` skill |

---

## 消息协议

### Extension → Native Host

| 类型 | 说明 |
|------|------|
| `START` | 启动 HTTP Server |
| `STOP` | 停止 HTTP Server |
| `ping` | 心跳检测 |
| `CALL_TOOL` | Extension 主动发起工具调用 |
| `tool_response` | 工具执行结果返回 |

### Native Host → Extension

| 类型 | 说明 |
|------|------|
| `SERVER_STARTED` | HTTP Server 已启动 |
| `SERVER_STOPPED` | HTTP Server 已停止 |
| `mcp_connected` | MCP Client 已连接 |
| `mcp_disconnected` | MCP Client 已断开 |
| `tool_request` | 来自 MCP Client 的工具请求 |
| `CALL_TOOL` | 来自 HTTP Client 的工具请求 |
| `EXECUTE_TOOL` | Extension 自发起的工具执行命令 |

---

## HTTP API

外部程序可通过 HTTP API 调用浏览器工具：

```bash
# 导航到 URL
curl -X POST http://127.0.0.1:12306/api/browser_navigate \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# 点击元素
curl -X POST http://127.0.0.1:12306/api/browser_click \
  -H "Content-Type: application/json" \
  -d '{"selector": "#submit-btn"}'

# 截图
curl -X POST http://127.0.0.1:12306/api/browser_screenshot \
  -H "Content-Type: application/json" \
  -d '{"fullPage": true}'
```

### 可用 API

| API | 参数 |
|-----|------|
| `/api/browser_navigate` | `{ url: string }` |
| `/api/browser_click` | `{ selector: string, waitForNavigation?: boolean }` |
| `/api/browser_fill_form` | `{ selector: string, value: string }` |
| `/api/browser_screenshot` | `{ fullPage?: boolean, selector?: string }` |
| `/api/browser_type` | `{ text: string }` |
| `/api/browser_select_option` | `{ selector: string, value: string }` |
| `/api/read_console_messages` | `{ pattern?: string }` |

---

## 工具路由

工具执行位置根据类型决定：

| 工具 | 执行位置 |
|------|----------|
| browser_click | Extension |
| browser_fill_form | Extension |
| browser_navigate | Extension |
| browser_screenshot | Extension |
| read_console_messages | Extension |
| web_fetcher | Native Host |
| network_request | Native Host |

---

## 支持的浏览器

支持所有 Chromium 内核浏览器：

| 浏览器 | macOS | Linux | Windows |
|--------|-------|-------|---------|
| Google Chrome | ✅ | ✅ | ✅ |
| Brave | ✅ | ✅ | ✅ |
| Arc | ✅ | ❌ | ✅ |
| Microsoft Edge | ✅ | ✅ | ✅ |
| Chromium | ✅ | ✅ | ✅ |
| Vivaldi | ✅ | ✅ | ✅ |
| Opera | ✅ | ✅ | ✅ |

### Native Messaging 路径

**macOS/Linux**: `~/{BrowserData}/NativeMessagingHosts/`
**Windows**: `%APPDATA%/Claude Code/ChromeNativeHost/` + 注册表项

---

## 使用流程

### 1. 启动

```bash
# 启动 CLI
./cli

# Native Host 自动启动，HTTP Server 自动监听 12306
# Extension 自动连接
```

### 2. Extension 安装

安装 Chrome Extension (开发版或生产版)，点击连接按钮即可使用。

### 3. 验证连接

```
Extension 点击连接 → Native Host 启动 → 显示"已连接"
```

---

## 安全机制

### 权限模式

| 模式 | 说明 |
|------|------|
| `ask` | 每次操作前询问用户确认 |
| `skip_all_permission_checks` | 跳过所有权限检查 |

### 扩展 ID

```json
allowed_origins: [
  "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/",  // 生产环境
  "chrome-extension://pnhielkknjookdjklgahibjafpndhdlc/"   // 开发环境
]
```

---

## 配置选项

### CLI 参数

```bash
--claude-in-chrome-mcp   # 以 MCP Server 模式启动
--chrome-native-host     # 作为 Chrome Native Host 运行
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_ENABLE_CFC` | 启用/禁用 Chrome 功能 |
| `CLAUDE_CHROME_PERMISSION_MODE` | 权限检查模式 |

---

## 调试

### 日志位置

```
~/.claude/debug/chrome-native-host.txt  (Ant 用户)
stderr                                   (所有用户)
```

### 常见问题

| 问题 | 解决方案 |
|------|----------|
| 扩展未连接 | 重启 Chrome、检查 Native Host 清单 |
| HTTP API 无响应 | 检查 12306 端口是否被占用 |
| Socket 连接失败 | 检查 `/tmp/claude-mcp-browser-bridge-*` 权限 |

---

## 相关文档

- [融合架构设计](chrome-mcp-fusion-architecture.md)
- [融合实现总结](chrome-mcp-fusion-implementation.md)
- [Chrome Native Messaging 协议规范](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)