# Chrome MCP 使用指南

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 启动 Claude Code with Chrome MCP

```bash
# 轻量模式（默认）
claude --chrome

# 或设置环境变量
CLAUDE_CODE_ENABLE_CFC=1 claude
```

### 3. 验证安装

```bash
# 运行端到端测试
bash scripts/test-chrome-mcp-e2e.sh
```

---

## 架构概述

```
Claude Code CLI
    │
    ├─→ MCP Server (stdio)
    │       └─→ 35+ 浏览器工具
    │               │
    │               └─→ Unix Domain Socket
    │                       │
    ├─→ Native Host (双协议)
    │       ├─→ OLA 协议
    │       ├─→ mcp-chrome 协议
    │       ├─→ 心跳机制 (30s)
    │       └─→ 请求超时 (60s)
    │               │
    └─→ Chrome Extension (mcp-chrome)
            ├─→ 35 个浏览器工具
            ├─→ Flow 录制/回放
            └─→ CDP 底层控制
```

---

## 配置选项

### CLI 参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `--chrome` | 启用 Chrome MCP | `claude --chrome` |
| `--no-chrome` | 禁用 Chrome MCP | `claude --no-chrome` |

### 环境变量

| 变量 | 说明 | 值 |
|------|------|-----|
| `CLAUDE_CODE_ENABLE_CFC` | 强制启用/禁用 | `1` 或 `0` |
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

## 工具列表

### 浏览器控制

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

### 页面读取

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_read_page` | 读取无障碍树 | `filter`, `depth`, `refId` |
| `chrome_get_web_content` | 获取页面内容 | `url`, `htmlContent`, `textContent` |
| `chrome_console` | 读取控制台 | `tabId`, `maxMessages` |
| `chrome_get_interactive_elements` | 获取交互元素 | `filter`, `tabId` |
| `chrome_request_element_selection` | 元素选择器 | `elements` |

### 网络操作

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_network_request` | 发送网络请求 | `url`, `method`, `headers`, `body` |
| `chrome_network_capture` | 网络捕获 | `action`, `tabId` |
| `chrome_network_debugger` | 网络调试 | `action`, `tabId` |

### 脚本注入

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_inject_script` | 注入脚本 | `type`, `source`, `tabId` |
| `chrome_send_command_to_inject` | 发送命令到注入脚本 | `command`, `tabId` |
| `chrome_javascript` | 执行 JS | `code`, `tabId` |
| `chrome_userscript` | 用户脚本 | `action`, `args` |

### 文件操作

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_upload_file` | 上传文件 | `selector`, `filePath`, `base64Data` |

### 书签/历史

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `chrome_bookmark_search` | 搜索书签 | `query` |
| `chrome_bookmark_add` | 添加书签 | `url`, `title`, `parentId` |
| `chrome_bookmark_delete` | 删除书签 | `id`, `url` |
| `chrome_history` | 历史记录 | `query`, `startTime`, `endTime` |

### 性能分析

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `performance_start_trace` | 开始性能追踪 | `reload`, `autoStop` |
| `performance_stop_trace` | 停止性能追踪 | `saveToDownloads` |
| `performance_analyze_insight` | 分析性能 | `insightName` |

### 标签页管理

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `get_windows_and_tabs` | 获取窗口和标签页 | - |
| `chrome_close_tabs` | 关闭标签页 | `tabIds`, `url` |
| `chrome_switch_tab` | 切换标签页 | `tabId`, `windowId` |
| `search_tabs_content` | 搜索标签页内容 | `query` |

### 录制/回放

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `record_replay_flow_run` | 运行录制流程 | `flowId`, `args` |
| `record_replay_list_published` | 列出已发布流程 | - |

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

## 故障排查

### 问题 1：扩展未连接

**症状**：启动后提示"Browser extension is not connected"

**解决方案**：
1. 确保 Chrome 扩展已安装并启用
2. 重启 Chrome 浏览器
3. 检查扩展白名单是否包含你的扩展 ID

```bash
# 检查白名单
grep "allowed_origins" src/utils/claudeInChrome/setup.ts
```

### 问题 2：Socket 文件不存在

**症状**：启动后找不到 Socket 文件

**解决方案**：
```bash
# 检查 Socket 目录
ls -la /tmp/claude-mcp-browser-bridge-$USER/

# 如果目录不存在，重新启动 CLI
claude --chrome
```

### 问题 3：工具调用失败

**症状**：工具调用返回错误

**解决方案**：
1. 检查工具名称是否正确（使用 `chrome_*` 格式）
2. 检查参数是否符合要求
3. 查看日志输出获取详细错误信息

```bash
# 查看详细日志
claude --chrome 2>&1 | grep -E "ERROR|WARN"
```

### 问题 4：心跳超时

**症状**：心跳超时，连接断开

**解决方案**：
1. 检查 Chrome 扩展是否正常运行
2. 检查 Native Host 进程是否存活
3. 重新启动 CLI

```bash
# 检查进程
ps aux | grep -E "chrome-native-host|claude-in-chrome-mcp"
```

---

## 高级配置

### 自定义扩展 ID

如果需要添加自定义扩展 ID：

1. 编辑 `src/utils/claudeInChrome/setup.ts`：
```typescript
allowed_origins: [
  `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/`, // PROD
  `chrome-extension://pnhielkknjookdjklgahibjafpndhdlc/`, // CUSTOM
  // ... 其他扩展 ID
],
```

2. 编辑 `src/utils/claudeInChrome/setupPortable.ts`：
```typescript
const CUSTOM_EXTENSION_ID = 'pnhielkknjookdjklgahibjafpndhdlc';

function getExtensionIds(): string[] {
  return process.env.USER_TYPE === 'ant'
    ? [PROD_EXTENSION_ID, DEV_EXTENSION_ID, ANT_EXTENSION_ID, CUSTOM_EXTENSION_ID]
    : [PROD_EXTENSION_ID, CUSTOM_EXTENSION_ID];
}
```

3. 重新编译：
```bash
bun run build
```

---

## 测试

### 运行端到端测试

```bash
bash scripts/test-chrome-mcp-e2e.sh
```

### 运行单元测试

```bash
bun test src/utils/chrome-mcp/
```

---

## 架构文档

详细架构设计文档：`src/utils/chrome-mcp/ARCHITECTURE.md`

---

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初始版本，双协议支持 |
