# Chrome Native Host - 可选 HTTP Server 使用指南

## 架构概述

Chrome Native Host 支持两种运行模式：

| 模式 | 传输方式 | 资源占用 | 适用场景 |
|------|---------|---------|---------|
| **轻量模式 (默认)** | Unix Domain Socket | ~30MB 内存，0 端口 | 仅服务 Claude Code CLI |
| **HTTP 模式 (可选)** | Socket + HTTP/SSE | ~80MB 内存，1 端口 | 支持多 AI 客户端 |

## 启用方式

### 1. CLI 参数

```bash
# 轻量模式（默认）
claude --chrome

# 启用 HTTP Server（默认端口 12306）
claude --chrome --http

# 自定义端口
claude --chrome --http --http-port 8080

# 完整配置
claude --chrome \
  --http \
  --http-port 8080 \
  --http-host 127.0.0.1 \
  --cors-origins "http://localhost:3000,http://localhost:5173"
```

### 2. 环境变量

```bash
# 启用 HTTP Server
export CLAUDE_CHROME_HTTP=1

# 自定义端口
export CLAUDE_CHROME_HTTP_PORT=12306

# 绑定地址
export CLAUDE_CHROME_HTTP_HOST=127.0.0.1

# CORS 白名单（逗号分隔）
export CLAUDE_CHROME_CORS_ORIGINS="http://localhost:3000,chrome-extension://*"

# 快捷模式设置
export CLAUDE_CHROME_MODE=full    # 或 light (默认)

# 启动
claude --chrome
```

### 3. 配置文件

```json
// ~/.claude.json
{
  "chromeMcp": {
    "enabled": true,
    "httpServer": {
      "enabled": false,
      "port": 12306,
      "host": "127.0.0.1",
      "corsOrigins": [
        "chrome-extension://*",
        "http://localhost:3000"
      ]
    }
  }
}
```

### 4. 直接启动 Native Host

```bash
# 轻量模式
cli --chrome-native-host

# HTTP 模式
cli --chrome-native-host --http

# 自定义配置
cli --chrome-native-host \
  --http \
  --http-port 8080 \
  --http-host 0.0.0.0
```

## HTTP 模式端点

### 健康检查

```bash
curl http://127.0.0.1:12306/health
```

响应：
```json
{
  "status": "ok",
  "version": "1.0.0",
  "mode": "http",
  "pendingRequests": 0
}
```

### SSE 连接 (MCP over SSE)

```javascript
const eventSource = new EventSource('http://127.0.0.1:12306/sse')

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data)
  console.log('Received:', message)
}

eventSource.addEventListener('connected', (event) => {
  const data = JSON.parse(event.data)
  console.log('Connected with clientId:', data.clientId)
})
```

### MCP 消息端点

```bash
curl -X POST http://127.0.0.1:12306/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "chrome_navigate",
      "arguments": { "url": "https://example.com" }
    }
  }'
```

## 配置优先级

```
CLI 参数 > 环境变量 > 配置文件 > 默认值
```

## 安全注意事项

### CORS 白名单

默认仅允许：
- `chrome-extension://*` (Chrome 扩展)
- `moz-extension://*` (Firefox 扩展)
- `http://127.0.0.1` (本地调试)

**警告**：不要在生产环境使用 `--cors-origins "*"` 或 `--http-host 0.0.0.0`，这会暴露服务到网络。

### Socket 权限

轻量模式下，Unix Domain Socket 文件权限为 `0600`（仅当前用户可访问）。

## 性能对比

| 指标 | 轻量模式 | HTTP 模式 |
|------|---------|----------|
| 启动时间 | ~0.5 秒 | ~2 秒 |
| 内存占用 | ~30 MB | ~80 MB |
| 端口占用 | 无 | 1 个 (默认 12306) |
| 最大连接数 | 无限制 | 取决于 HTTP Server |
| 适用客户端 | Claude Code CLI | 任意 MCP Client |

## 故障排查

### 端口冲突

```bash
# 检查端口占用
lsof -i :12306

# 更换端口
claude --chrome --http --http-port 8080
```

### 连接测试

```bash
# 轻量模式：检查 Socket 文件
ls -la /tmp/claude-mcp-browser-bridge-$USER/

# HTTP 模式：健康检查
curl http://127.0.0.1:12306/health
```

### 调试日志

所有日志输出到 stderr：

```bash
# 查看完整日志
claude --chrome --http 2> chrome-mcp.log

# 仅查看错误
claude --chrome --http 2>&1 | grep ERROR
```
