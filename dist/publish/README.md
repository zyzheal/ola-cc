# Ola-CC (Ola Claude Code)

AI 编码助手，运行在你的终端中。

## 安装

```bash
npm install -g @zyzheal/ola-cc
```

## 使用

```bash
# 启动交互式会话
ola-cc

# 或使用 npx
npx @zyzheal/ola-cc
```

## 配置文件

Ola-CC 的配置存储在 `~/.claude/` 目录中。

### 配置目录结构

```
~/.claude/
├── settings.json           # 用户设置（MCP 服务器、偏好等）
├── session.json            # 会话级环境配置（API 密钥、模型、环境变量）
├── CLAUDE.md               # 项目级指令文件
└── chrome/                 # Chrome 扩展原生主机文件
    ├── chrome-native-host  # Unix: 包装脚本
    └── chrome-native-host.bat  # Windows: 包装脚本
```

### 读取优先级

配置文件的读取优先级如下（从高到低）：

1. **命令行参数** — 启动时传入的 `--` 参数，优先级最高
2. **环境变量** — 当前 shell 环境中设置的变量
3. **`~/.claude/session.json`** — 会话级配置，包含 API 密钥、模型选择、环境变量等
4. **`~/.claude/settings.json`** — 用户级持久化设置，包含 MCP 服务器、偏好设置等
5. **项目根目录 `.claude/CLAUDE.md`** — 项目级指令，仅影响当前项目的行为

> **注意**：`session.json` 中的配置会覆盖 `settings.json` 中的同名设置，但不会覆盖命令行参数和系统环境变量。

### session.json 配置详解

`~/.claude/session.json` 用于配置会话级别的环境变量和模型设置。典型结构如下：

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-api03-REDACTED-xxxxx...xxxxx",
    "API_BASE_URL": "http://127.0.0.1:11434",
    "CLAUDE_CODE_FORCE_FULL_LOGO": "true"
  },
  "model": {
    "name": "qwen/qwen3-235b-a22b",
    "provider": "openai"
  }
}
```

#### env 字段

`env` 对象中的键值对会在会话启动时注入为环境变量。常用配置：

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | API 密钥（必填），使用远程代理时填代理服务的 key |
| `API_BASE_URL` | API 代理地址，使用本地模型时指向本地代理端口 |
| `CLAUDE_CODE_ENABLE_CFC` | 启用 Chrome 集成（1=启用，0=禁用） |
| `CLAUDE_CHROME_HTTP` | 启用 Chrome HTTP 桥接模式（1=启用） |
| `CLAUDE_CHROME_HTTP_PORT` | HTTP 服务器端口（默认 12306） |

#### model 字段

`model` 对象用于指定使用的模型。使用本地模型代理时的参考配置：

```json
{
  "model": {
    "name": "qwen/qwen3-235b-a22b",
    "provider": "openai"
  }
}
```

- **name** — 模型名称，格式取决于代理服务的 API。本地 Ollama 代理通常为 `qwen/qwen3-235b-a22b` 或 `llama3.1`
- **provider** — 提供商类型，本地 OpenAI 兼容代理填 `openai`，也支持 `bedrock`、`vertex` 等

### settings.json 配置示例

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

## MCP 服务器配置

在 `~/.claude/settings.json` 的 `mcpServers` 中添加 MCP 服务器：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | API 密钥 |
| `CLAUDE_CODE_ENABLE_CFC` | 启用 Chrome 集成（1=启用，0=禁用） |
| `CLAUDE_CHROME_HTTP` | 启用 Chrome HTTP 桥接模式（1=启用） |
| `CLAUDE_CHROME_HTTP_PORT` | HTTP 服务器端口（默认 12306） |
| `ENABLE_TOOL_SEARCH` | 工具搜索模式：`tst`（默认）、`tst-auto`、`standard` |
| `CLAUDE_CODE_EXTRA_BODY` | API 请求的额外 body 参数 |

## 开启"宠物"功能

"宠物"（SprocketDudot）是 Ola-CC 的伴随功能。开启方式：

1. **通过 session.json 配置**：

   在 `~/.claude/session.json` 的 `env` 中添加：

   ```json
   {
     "env": {
       "SPROCKET_DUDOT_ENABLED": "1"
     }
   }
   ```

2. **通过环境变量**：

   在启动 Ola-CC 前设置环境变量：

   ```bash
   export SPROCKET_DUDOT_ENABLED=1
   ola-cc
   ```

3. **通过 settings.json 配置**：

   在 `~/.claude/settings.json` 中添加：

   ```json
   {
     "sprocketDudot": {
       "enabled": true
     }
   }
   ```

## Chrome 扩展（可选）

浏览器自动化需要安装 Claude in Chrome 扩展：

1. Ola-CC 会自动安装原生主机清单
2. 从 Chrome 应用商店安装扩展
3. 设置 `CLAUDE_CODE_ENABLE_CFC=1` 或使用 `--chrome` 参数

## 许可证

详见 LICENSE.md。
