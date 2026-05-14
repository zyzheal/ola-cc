---
name: chrome-mcp-fusion-architecture
description: Claude-in-chrome 与 mcp-chrome HTTP 完美融合架构设计
type: project
---

# Chrome MCP 融合架构设计文档

> 目标：融合 claude-in-chrome 与 mcp-chrome HTTP 两套架构，实现功能互补，用户只需启动 cli 即可使用全部功能。

---

## 一、融合架构总览

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
│                    │    │ - Extension → MCP │   │                              │
│                    │    │ - Extension → HTTP│   │                              │
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
│                    │                             │                              │
│                    │  角色 3: 发起者              │                              │
│                    │  - 发送 CALL_TOOL           │                              │
│                    │  - 推送 notification        │                              │
│                    └──────────────┬──────────────┘                              │
│                                   │                                             │
│                                   ↓                                             │
│                    ┌─────────────────────────────┐                              │
│                    │      Chrome Browser         │                              │
│                    │      (执行页面操作)          │                              │
│                    └─────────────────────────────┘                              │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐│
│  │  外部调用入口:                                                              ││
│  │  1. MCP Client (Claude Code AI) → Socket → 实时交互                        ││
│  │  2. HTTP Client (Python/Bash/Webhook/CI) → HTTP → 自动化调用               ││
│  │  3. Extension → 直接控制 Native Host                                       ││
│  └───────────────────────────────────────────────────────────────────────────┘│
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、核心改动清单

### 2.1 Native Host 改动 (chromeNativeHost.ts)

| 改动项 | 说明 | 新增代码量 |
|--------|------|-----------|
| HTTP Server | 新增 HTTP 监听 (12306) | ~100 行 |
| 消息协议扩展 | START/STOP/CALL_TOOL 处理 | ~50 行 |
| 工具路由 | 工具执行位置判断 | ~80 行 |
| 状态管理 | SERVER_STARTED/STOPPED 状态 | ~30 行 |
| requestId 映射 | HTTP 请求与 Native 请求的 requestId 映射 | ~40 行 |

### 2.2 Extension 改动 (background.ts)

| 改动项 | 说明 | 新增代码量 |
|--------|------|-----------|
| 控制者消息发送 | START/STOP 发送逻辑 | ~20 行 |
| CALL_TOOL 发送 | Extension 主动发起工具调用 | ~50 行 |
| 状态接收处理 | SERVER_STARTED/STOPPED 处理 | ~30 行 |
| 连接状态 UI | 连接状态指示器 | ~40 行 |

---

## 三、消息协议设计

### 3.1 Extension → Native Host 消息

```typescript
// 控制类消息
{ type: 'START', payload: { port?: number } }      // 启动 HTTP Server
{ type: 'STOP' }                                    // 停止 HTTP Server
{ type: 'ping' }                                    // 心跳检测

// 工具调用类消息
{ type: 'CALL_TOOL', requestId: string, payload: { name: string, args: any } }

// 响应类消息
{ type: 'tool_response', ...data }                 // 工具执行结果
{ type: 'notification', event: string, data: any } // 事件推送
```

### 3.2 Native Host → Extension 消息

```typescript
// 状态通知消息
{ type: 'SERVER_STARTED', payload: { port: number } }
{ type: 'SERVER_STOPPED' }
{ type: 'pong', timestamp: number }
{ type: 'status_response', native_host_version: string }

// 工具请求消息
{ type: 'tool_request', method: string, params: any }    // 来自 MCP Client
{ type: 'CALL_TOOL', requestId: string, payload: {...} } // 来自 HTTP Client
{ type: 'mcp_connected' }
{ type: 'mcp_disconnected' }
```

### 3.3 HTTP API 设计

```
POST http://127.0.0.1:12306/api/{tool_name}
Body: { args: {...} }
Response: { success: boolean, result: any, error?: string }

工具列表:
- /api/browser_navigate     → { url: string }
- /api/browser_click        → { selector: string, waitForNavigation?: boolean }
- /api/browser_fill_form    → { selector: string, value: string }
- /api/browser_screenshot   → { fullPage?: boolean, selector?: string }
- /api/read_console_messages → { pattern?: string }
- /api/browser_close_tabs   → { tabIds: number[] }
- ... (所有 BROWSER_TOOLS)
```

---

## 四、工具路由设计

```typescript
const TOOL_ROUTING: Record<string, 'extension' | 'native_host' | 'both'> = {
  // Extension 执行的浏览器操作类工具
  'browser_click': 'extension',
  'browser_fill_form': 'extension',
  'browser_screenshot': 'extension',
  'browser_navigate': 'extension',
  'read_page': 'extension',
  'read_console_messages': 'extension',
  'browser_close_tabs': 'extension',
  'browser_switch_tab': 'extension',
  'keyboard': 'extension',
  'file_upload': 'extension',
  'handle_dialog': 'extension',
  'gif_recorder': 'extension',
  'element_picker': 'extension',
  'inject_script': 'extension',
  
  // Native Host 执行的网络类工具
  'web_fetcher': 'native_host',
  'network_request': 'native_host',
  
  // 两者都可执行
  'screenshot': 'both',
  'history': 'both',
  'bookmark_search': 'both',
};
```

---

## 五、启动流程设计

```
用户启动 Claude Code CLI
    │
    ├─→ CLI 启动 MCP Server
    │       │
    │       └─→ 调用 setupClaudeInChrome()
    │               │
    │               ├─→ 创建 wrapper script (~/.claude/chrome/chrome-native-host)
    │               ├─→ 安装 Native Host Manifest
    │               └─→ 返回 MCP Config
    │
    ├─→ MCP Server 作为子进程启动
    │       │
    │       └─→ cli --claude-in-chrome-mcp
    │               │
    │               └─→ runClaudeInChromeMcpServer()
    │                       │
    │                       └─→ 等待 MCP Client 连接
    │
    └─→ CLI 主进程继续运行
            │
            └─→ 用户操作 → MCP tool call → Native Host → Extension → 执行

Chrome Extension 启动 (独立)
    │
    ├─→ initNativeHostListener() 自动调用
    │       │
    │       ├─→ ensureNativeConnected('sw_startup')
    │       │       │
    │       │       └─→ chrome.runtime.connectNative(HOST_NAME)
    │       │               │
    │       │               └─→ 触发 Native Host 启动
    │       │                       │
    │       │                       ├─→ 启动 Socket Server (MCP)
    │       │                       ├─→ 启动 HTTP Server (12306)
    │       │                       └─→ 发送 SERVER_STARTED
    │       │                               │
    │       │                               └─→ Extension 收到，显示"已连接"
    │       │
    │       └─→ 用户点击连接按钮 → 发送 START (可选，默认已启动)
    │
    └─→ Extension 可用状态
            │
            ├─→ MCP Client 可实时调用工具
            ├─→ HTTP Client 可调用 API
            └─→ Extension 可主动发起 CALL_TOOL
```

---

## 六、关键实现细节

### 6.1 requestId 映射机制

```
HTTP 请求进来的 requestId: http-req-uuid-xxx
    │
    └─→ Native Host 存储映射
    │       pendingHttpRequests.set('http-req-uuid-xxx', httpResponseCallback)
    │
    └─→ 发送给 Extension 时使用 nativeRequestId: native-req-uuid-yyy
    │       sendChromeMessage({
    │         type: 'CALL_TOOL',
    │         requestId: 'native-req-uuid-yyy',
    │         httpRequestId: 'http-req-uuid-xxx',  // 内部关联
    │         payload: {...}
    │       })
    │
    └─→ Extension 返回时
    │       responseToRequestId: 'native-req-uuid-yyy'
    │
    └─→ Native Host 匹配并返回 HTTP Response
    │       const mapping = getRequestIdMapping('native-req-uuid-yyy')
    │       httpResponseCallback({ success: true, result: data })
```

### 6.2 Extension 主动发起 CALL_TOOL

```typescript
// Extension 想主动执行某个工具（如录制回放触发）
async function extensionCallTool(toolName: string, args: any): Promise<any> {
  const requestId = generateRequestId();
  
  nativePort.postMessage({
    type: 'CALL_TOOL',
    requestId: requestId,
    payload: {
      name: toolName,
      args: args,
      source: 'extension'  // 标记来源
    }
  });
  
  // 等待结果
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject, timeout });
  });
}

// Native Host 收到 CALL_TOOL 后的处理
case 'CALL_TOOL': {
  const { requestId, payload, source } = message;
  
  if (source === 'extension') {
    // Extension 自己发起的请求，工具在哪里执行？
    const routing = TOOL_ROUTING[payload.name];
    
    if (routing === 'extension') {
      // 执行位置在 Extension，需要转发回 Extension 自己执行？
      // 这种情况下，Native Host 只是作为消息路由
      sendChromeMessage({
        type: 'EXECUTE_TOOL',
        requestId: requestId,
        payload: payload
      });
    } else if (routing === 'native_host') {
      // Native Host 本地执行
      const result = await executeLocalTool(payload);
      sendChromeMessage({
        type: 'tool_response',
        requestId: requestId,
        payload: result
      });
    }
  } else {
    // 来自 HTTP Client 或 MCP Client 的请求
    // 转发给 Extension 执行
    sendChromeMessage(message);
  }
}
```

---

## 七、实施步骤

### Phase 1: Native Host 核心改动
1. 新增 HTTP Server
2. 扩展消息协议处理
3. requestId 映射机制
4. 工具路由实现

### Phase 2: Extension 适配改动
1. 状态接收处理
2. CALL_TOOL 发送逻辑
3. EXECUTE_TOOL 接收处理
4. UI 状态指示

### Phase 3: 测试验证
1. MCP 模式测试
2. HTTP API 测试
3. Extension 控制测试
4. 融合场景测试

---

## 八、预期效果

```
用户使用流程:

1. 安装 Claude Code CLI
2. 安装 Chrome Extension (pnhielkknjookdjklgahibjafpndhdlc)
3. 启动 cli → 自动启动 Native Host
4. Extension 自动连接 → 显示"已连接"
5. 立即可用:
   - Claude Code AI 可实时操作浏览器
   - 外部程序可通过 HTTP API 调用
   - Extension 可主动发起操作
   - 录制回放系统可用

零额外操作，一键可用。
```