# Chrome MCP — 浏览器自动化（完整版）

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
| **MCP Server Stub** | `shims/ant-claude-for-chrome-mcp/index.ts` | MCP 协议适配层 |

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
| `notification` | 事件推送 |
| `get_status` | 查询状态 |

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

### Socket 通信协议

Native Host 使用自定义二进制协议：
1. 4 字节长度头（UInt32LE）
2. JSON 消息体

MCP 使用 JSON-RPC 2.0：
1. `initialize` / `initialize/result`
2. `tools/list` / `tools/list/result`
3. `tools/call` / `tools/call/result`

需要在两者之间做协议转换。

---

## 工具列表

### 完整工具表（从 Native Host 的 TOOL_ROUTING 同步）

| 工具名称 | 执行位置 | 说明 |
|---|---|---|
| browser_click | Extension | 点击页面元素 |
| browser_fill_form | Extension | 填写表单 |
| browser_navigate | Extension | 导航到 URL |
| browser_screenshot | Extension | 截图 |
| browser_type | Extension | 键盘输入 |
| browser_select_option | Extension | 选择选项 |
| read_console_messages | Extension | 读取浏览器控制台 |
| read_page | Extension | 读取页面内容 |
| browser_close_tabs | Extension | 关闭标签页 |
| browser_switch_tab | Extension | 切换标签页 |
| keyboard | Extension | 键盘控制 |
| file_upload | Extension | 文件上传 |
| handle_dialog | Extension | 处理弹窗 |
| gif_recorder | Extension | GIF 录制 |
| element_picker | Extension | 元素选择器 |
| inject_script | Extension | 注入 JS |
| web_fetcher | Native Host | 网页抓取 |
| network_request | Native Host | 网络请求 |

### 浏览器控制工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_navigate` | 导航到 URL | `url`, `tabId`, `windowId` |
| `chrome_screenshot` | 截图 | `selector`, `fullPage`, `storeBase64` |
| `chrome_computer` | 鼠标/键盘控制 | `action`, `coordinates`, `ref` |
| `chrome_click_element` | 点击元素 | `selector`, `ref`, `coordinates` |
| `chrome_fill_or_select` | 填写表单 | `selector`, `value` |
| `chrome_keyboard` | 键盘输入 | `keys`, `selector` |
| `chrome_handle_dialog` | 处理弹窗 | `action`, `promptText` |
| `chrome_handle_download` | 处理下载 | `action` |

### 页面读取工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_read_page` | 读取无障碍树 | `filter`, `depth`, `refId` |
| `chrome_get_web_content` | 获取页面内容 | `url`, `htmlContent`, `textContent` |
| `chrome_console` | 读取控制台 | `tabId`, `maxMessages` |
| `chrome_get_interactive_elements` | 获取交互元素 | `filter`, `tabId` |
| `chrome_request_element_selection` | 元素选择器 | `elements` |

### 网络操作工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_network_request` | 发送网络请求 | `url`, `method`, `headers`, `body` |
| `chrome_network_capture` | 网络捕获 | `action`, `tabId` |
| `chrome_network_debugger` | 网络调试 | `action`, `tabId` |

### 脚本注入工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_inject_script` | 注入脚本 | `type`, `source`, `tabId` |
| `chrome_send_command_to_inject` | 发送命令到注入脚本 | `command`, `tabId` |
| `chrome_javascript` | 执行 JS | `code`, `tabId` |
| `chrome_userscript` | 用户脚本 | `action`, `args` |

### 文件操作工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_upload_file` | 上传文件 | `selector`, `filePath`, `base64Data` |

### 书签/历史工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_bookmark_search` | 搜索书签 | `query` |
| `chrome_bookmark_add` | 添加书签 | `url`, `title`, `parentId` |
| `chrome_bookmark_delete` | 删除书签 | `id`, `url` |
| `chrome_history` | 历史记录 | `query`, `startTime`, `endTime` |

### 性能分析工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `performance_start_trace` | 开始性能追踪 | `reload`, `autoStop` |
| `performance_stop_trace` | 停止性能追踪 | `saveToDownloads` |
| `performance_analyze_insight` | 分析性能 | `insightName` |

### 标签页管理工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `get_windows_and_tabs` | 获取窗口和标签页 | - |
| `chrome_close_tabs` | 关闭标签页 | `tabIds`, `url` |
| `chrome_switch_tab` | 切换标签页 | `tabId`, `windowId` |
| `search_tabs_content` | 搜索标签页内容 | `query` |

### 录制/回放工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `record_replay_flow_run` | 运行录制流程 | `flowId`, `args` |
| `record_replay_list_published` | 列出已发布流程 | - |

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

## 配置选项

### CLI 参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `--chrome` | 启用 Chrome MCP | `claude --chrome` |
| `--no-chrome` | 禁用 Chrome MCP | `claude --no-chrome` |
| `--claude-in-chrome-mcp` | 以 MCP Server 模式启动 | - |
| `--chrome-native-host` | 作为 Chrome Native Host 运行 | - |

### 环境变量

| 变量 | 说明 | 值 |
|------|------|-----|
| `OLA_CC_ENABLE_CFC` | 强制启用/禁用 | `1` 或 `0` |
| `CLAUDE_CHROME_PERMISSION_MODE` | 权限模式 | `ask`, `skip_all_permission_checks`, `follow_a_plan` |

### 配置文件

```json
// ~/.claude.json
{
  "claudeInChromeDefaultEnabled": true,
  "cachedChromeExtensionInstalled": true
}
```

---

## 使用流程

### 快速开始

```bash
# 安装依赖
bun install

# 启动 Claude Code with Chrome MCP
claude --chrome

# 或设置环境变量
OLA_CC_ENABLE_CFC=1 claude

# Native Host 自动启动，HTTP Server 自动监听 12306
# Extension 自动连接
```

### Extension 安装

安装 Chrome Extension (开发版或生产版)，点击连接按钮即可使用。

### 验证连接

```
Extension 点击连接 → Native Host 启动 → 显示"已连接"
```

### 运行测试

```bash
# 端到端测试
bash scripts/test-chrome-mcp-e2e.sh

# 单元测试
bun test src/utils/chrome-mcp/
```

---

## 使用示例

### 示例 1：导航到网页

```
用户：帮我打开 https://example.com

AI：好的，我来帮你打开。

调用工具：chrome_navigate
参数：{ "url": "https://example.com" }
```

### 示例 2：读取页面内容

```
用户：这个页面上有什么内容？

AI：让我读取一下页面内容。

调用工具：chrome_read_page
参数：{}

返回：页面无障碍树...
```

### 示例 3：点击元素

```
用户：点击登录按钮

AI：好的，我来点击登录按钮。

调用工具：chrome_click_element
参数：{ "selector": "#login-button" }
```

### 示例 4：填写表单

```
用户：填写用户名和密码

AI：好的，我来填写表单。

调用工具：chrome_fill_or_select
参数：{ "selector": "#username", "value": "myuser" }

调用工具：chrome_fill_or_select
参数：{ "selector": "#password", "value": "mypass" }
```

### 示例 5：截图

```
用户：给我截个图

AI：好的，我来截图。

调用工具：chrome_screenshot
参数：{ "storeBase64": true, "fullPage": false }
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

### Native Host 名称

```json
{
  "name": "com.anthropic.claude_code_browser_extension",
  "allowed_origins": [
    "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/",
    "chrome-extension://pnhielkknjookdjklgahibjafpndhdlc/"
  ]
}
```

---

## 调试

### 日志位置

```
~/.claude/debug/chrome-native-host.txt  (Ant 用户)
stderr                                   (所有用户)
```

### 自定义扩展 ID

如果需要添加自定义扩展 ID：

1. 编辑 `src/utils/claudeInChrome/setup.ts` 和 `setupPortable.ts`
2. 重新编译：`bun run build`

### 常见问题

| 问题 | 解决方案 |
|------|----------|
| 扩展未连接 | 重启 Chrome、检查 Native Host 清单 |
| HTTP API 无响应 | 检查 12306 端口是否被占用 |
| Socket 连接失败 | 检查 `/tmp/claude-mcp-browser-bridge-*` 权限 |
| 心跳超时 | 检查 Chrome 扩展是否正常运行，检查 Native Host 进程 |
| 工具调用失败 | 检查工具名称（使用 `chrome_*` 格式），查看日志 |

### 查看进程

```bash
ps aux | grep -E "chrome-native-host|claude-in-chrome-mcp"
```

### 查看详细日志

```bash
claude --chrome 2>&1 | grep -E "ERROR|WARN"
```

---

## MCP Server 设计补充

### 架构总览

```
Claude Code ─(MCP stdio)→ MCP Server ←(Unix socket)→ Native Host ←(Native Messaging)→ Chrome Extension
```

- **Native Host**（已实现）：Socket Server + HTTP Server + 工具路由 + Chrome 扩展通信
- **MCP Server**（补充层）：MCP 协议适配层，连接 socket，注册工具，转发调用

### 缺失功能清单

| 缺失项 | 说明 |
|--------|------|
| `BROWSER_TOOLS` | 需要从 Native Host 的 `TOOL_ROUTING` 表同步生成工具列表 |
| `createClaudeForChromeMcpServer()` | MCP 协议实现的三个核心方法：`connect()`, `setRequestHandler()`, `close()` |
| MCP 工具定义 | 每个工具需要 `name`, `description`, `inputSchema` |

### 推荐实现方案

在 stub 中实现 MCP 协议适配层（socket 通信）：
1. 启动时连接 Native Host 的 socket
2. 实现 MCP `initialize` 方法
3. 实现 `tools/list` — 返回工具列表
4. 实现 `tools/call` — 通过 socket 转发到 Native Host

原因：Native Host 的 socket 协议已实现（JSON-RPC over socket），实时性更好，支持双向通信。

---

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初始版本，双协议支持 |

---

## 相关文档

- [Chrome Native Messaging 协议规范](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [架构文档](src/utils/chrome-mcp/ARCHITECTURE.md)
