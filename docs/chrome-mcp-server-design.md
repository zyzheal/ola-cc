# Claude in Chrome MCP Server - 补充设计方案

## 架构总览

```
Claude Code ─(MCP stdio)→ MCP Server ←(Unix socket)→ Native Host ←(Native Messaging)→ Chrome Extension
```

- **Native Host**（已实现）：Socket Server + HTTP Server + 工具路由 + Chrome 扩展通信
- **MCP Server**（需要补充）：MCP 协议适配层，连接 socket，注册工具，转发调用

## 缺失功能清单

### 1. `BROWSER_TOOLS` — 工具定义
需要从 Native Host 的 `TOOL_ROUTING` 表同步生成工具列表。

### 2. `createClaudeForChromeMcpServer()` — MCP 协议实现
需要实现三个核心方法：
- `connect(transport)` — 连接 Native Host socket + 建立 StdioServerTransport
- `setRequestHandler(schema, handler)` — 注册 MCP 请求处理器
- `close()` — 关闭连接

### 3. MCP 工具定义
每个工具需要提供：
- `name`：工具名称
- `description`：工具描述
- `inputSchema`：JSON Schema 格式的参数定义

## 实现方案

### 方案 A：在 stub 中实现 MCP 协议适配层

核心逻辑：
1. 启动时连接 Native Host 的 socket
2. 实现 MCP `initialize` 方法
3. 实现 `tools/list` — 返回工具列表
4. 实现 `tools/call` — 通过 socket 转发到 Native Host

### 方案 B：保持 stub + 改用 HTTP 调用 Native Host

核心逻辑：
1. stub 的 `connect()` 建立 HTTP 客户端
2. 工具调用通过 HTTP POST 到 `http://127.0.0.1:12306/api/{tool_name}`
3. 更简单，但需要实现完整的工具定义

## 推荐：方案 A（socket 通信）

原因：
- Native Host 的 socket 协议已经实现（JSON-RPC over socket）
- 实时性更好
- 支持双向通信（Extension 主动推送）

## 实现文件

需要修改的文件：
1. `shims/ant-claude-for-chrome-mcp/index.ts` — 补充完整实现
2. 不需要修改其他文件

## 工具列表（从 Native Host 的 TOOL_ROUTING 同步）

| 工具名称 | 执行位置 | 说明 |
|---|---|---|
| browser_click | Extension | 点击页面元素 |
| browser_fill_form | Extension | 填写表单 |
| browser_screenshot | Extension | 截图 |
| browser_navigate | Extension | 导航到 URL |
| read_page | Extension | 读取页面内容 |
| read_console_messages | Extension | 读取浏览器控制台 |
| browser_close_tabs | Extension | 关闭标签页 |
| browser_switch_tab | Extension | 切换标签页 |
| keyboard | Extension | 键盘输入 |
| file_upload | Extension | 文件上传 |
| handle_dialog | Extension | 处理弹窗 |
| gif_recorder | Extension | GIF 录制 |
| element_picker | Extension | 元素选择器 |
| inject_script | Extension | 注入 JS |
| web_fetcher | Native Host | 网页抓取 |
| network_request | Native Host | 网络请求 |

## Socket 通信协议

Native Host 使用自定义二进制协议：
1. 4 字节长度头（UInt32LE）
2. JSON 消息体

MCP 使用 JSON-RPC 2.0：
1. `initialize` / `initialize/result`
2. `tools/list` / `tools/list/result`
3. `tools/call` / `tools/call/result`

需要在两者之间做协议转换。
