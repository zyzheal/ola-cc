# Ola CC (Ola Claude Code)

AI 编码助手，运行在你的终端中。

## 快速开始

### 安装

```bash
npm install -g @zyzheal/ola-cc
```

安装完成后，终端中运行 `ola-cc` 即可启动。

### 首次使用

1. **配置 API 密钥** — 选择以下任一方式：

   **方式 A：通过 session.json（推荐）**

   创建 `~/.claude/session.json`：

   ```bash
   mkdir -p ~/.claude
   cat > ~/.claude/session.json << 'EOF'
   {
     "env": {
       "OPENAI_API_KEY": "你的API密钥",
       "OPENAI_BASE_URL": "https://api.openai.com/v1",
       "OPENAI_MODEL": "gpt-4o"
     }
   }
   EOF
   ```

   **方式 B：通过环境变量**

   ```bash
   export OPENAI_API_KEY="你的API密钥"
   export OPENAI_BASE_URL="https://api.openai.com/v1"
   export OPENAI_MODEL="gpt-4o"
   ola-cc
   ```

2. **启动 Ola CC**

   ```bash
   ola-cc
   ```

## 架构说明

本项目采用 **包装器 + 原生二进制分发** 模式：

- **主包** `@zyzheal/ola-cc` — 包含安装脚本和 Node.js 兼容的 JS bundle，安装时自动下载对应平台的原生二进制（macOS/Linux）或 JS bundle（Windows）
- **平台子包** `@zyzheal/ola-cc-darwin-arm64` 等 — 每个平台一个独立包

### 平台运行方式

| 平台 | 运行方式 | 说明 |
|------|----------|------|
| macOS | Bun 编译原生二进制 | 高性能，单进程 |
| Linux | Bun 编译原生二进制 | 高性能，单进程 |
| Windows | Node.js JS bundle | 稳定可靠，避免 Bun 编译二进制在 Windows 上的兼容性问题 |

### 支持的平台

| 平台包名 | 操作系统 | CPU |
|----------|----------|-----|
| `@zyzheal/ola-cc-darwin-arm64` | macOS | Apple Silicon (M1/M2/M3/M4) |
| `@zyzheal/ola-cc-darwin-x64` | macOS | Intel |
| `@zyzheal/ola-cc-linux-x64` | Linux | x64 (glibc) |
| `@zyzheal/ola-cc-linux-arm64` | Linux | ARM64 (glibc) |
| `@zyzheal/ola-cc-linux-x64-musl` | Linux | x64 (musl/Alpine) |
| `@zyzheal/ola-cc-linux-arm64-musl` | Linux | ARM64 (musl/Alpine) |
| `@zyzheal/ola-cc-win32-x64` | Windows | x64 |
| `@zyzheal/ola-cc-win32-arm64` | Windows | ARM64 |

## 配置文件详解

Ola CC 的配置存储在 `~/.claude/` 目录中。

### 配置目录结构

```
~/.claude/
├── settings.json           # 用户设置（MCP 服务器、偏好等）
├── session.json            # 会话级环境配置（API 密钥、模型、环境变量等）
├── CLAUDE.md               # 项目级指令文件
└── chrome/                 # Chrome 扩展原生主机文件
    ├── chrome-native-host  # Unix: 包装脚本
    └── chrome-native-host.bat  # Windows: 包装脚本
```

### 配置读取优先级

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | 命令行参数 | 启动时 `--` 传入的参数 |
| 2 | 环境变量 | 当前 shell 环境中的变量 |
| 3 | `~/.claude/session.json` | 会话级配置（API 密钥、模型、环境变量等） |
| 4 | `~/.claude/settings.json` | 用户级持久化设置（MCP 服务器、偏好设置等） |
| 5 | `.claude/CLAUDE.md` | 项目级指令（仅影响当前项目） |

> 高优先级的配置会覆盖低优先级的同名设置。

### session.json 配置（会话级）

`~/.claude/session.json` 用于配置会话级别的环境变量和模型设置。

#### 完整示例

```json
{
  "env": {
    "OPENAI_API_KEY": "sk-xxx",
    "OPENAI_BASE_URL": "https://api.openai.com/v1",
    "OPENAI_MODEL": "gpt-4o",
    "CLAUDE_CODE_FORCE_FULL_LOGO": "true"
  },
  "model": {
    "name": "gpt-4o",
    "provider": "openai"
  }
}
```

#### env 字段 — 环境变量注入

`env` 对象中的键值对会在会话启动时注入为环境变量。常用配置：

| 变量 | 说明 | 必填 |
|------|------|------|
| `OPENAI_API_KEY` | API 密钥 | 是 |
| `OPENAI_BASE_URL` | API 基础 URL | 是 |
| `OPENAI_MODEL` | 模型名称 | 推荐 |
| `CLAUDE_CODE_USE_OPENAI` | 启用 OpenAI 协议（设为 `1`） | 是 |
| `CLAUDE_CODE_ENABLE_CFC` | 启用 Chrome 集成（1=启用，0=禁用） | 否 |
| `CLAUDE_CHROME_HTTP` | 启用 Chrome HTTP 桥接（1=启用） | 否 |
| `CLAUDE_CHROME_HTTP_PORT` | HTTP 桥接端口（默认 12306） | 否 |

#### model 字段 — 模型选择

```json
{
  "model": {
    "name": "gpt-4o",
    "provider": "openai"
  }
}
```

- **name** — 模型名称，取决于你的 API 服务
- **provider** — 提供商类型：`openai`、`bedrock`、`vertex` 等

### settings.json 配置（用户级）

`~/.claude/settings.json` 用于持久化用户设置。

#### MCP 服务器配置

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

#### 宠物（SprocketDudot）配置

```json
{
  "sprocketDudot": {
    "enabled": true
  }
}
```

### CLAUDE.md 配置（项目级）

在项目根目录创建 `.claude/CLAUDE.md`，用于定义项目特定的指令和行为：

```markdown
# 项目指令

你正在协助开发一个 Node.js 项目。请遵循以下规则：

- 使用 TypeScript
- 遵循 ESLint 规范
- 编写单元测试
```

## OpenAI 协议支持

当设置 `CLAUDE_CODE_USE_OPENAI=1` 时，CLI 使用 OpenAI 兼容协议与 API 通信。

### 支持的 API 端点

| 服务 | OPENAI_BASE_URL | 说明 |
|------|----------------|------|
| OpenAI 官方 | `https://api.openai.com/v1` | GPT-4o、o1 等 |
| 阿里云百炼 DashScope | `https://coding.dashscope.aliyuncs.com/v1` | 通义千问系列 |
| Ollama (本地) | `http://127.0.0.1:11434/v1` | 本地开源模型 |
| vLLM | `http://localhost:8000/v1` | 兼容 OpenAI 格式 |

### 使用示例

```bash
# OpenAI 官方 API
OPENAI_API_KEY="sk-xxx" OPENAI_BASE_URL="https://api.openai.com/v1" OPENAI_MODEL="gpt-4o" ola-cc

# 阿里云百炼
OPENAI_API_KEY="your-key" OPENAI_BASE_URL="https://coding.dashscope.aliyuncs.com/v1" OPENAI_MODEL="qwen3.6-plus" ola-cc

# Ollama 本地模型
OPENAI_BASE_URL="http://127.0.0.1:11434/v1" OPENAI_MODEL="llama3.1" ola-cc
```

### 模型选择优先级

| 优先级 | 来源 |
|--------|------|
| 1 | `/model` 命令（会话中动态切换） |
| 2 | `--model` 启动参数 |
| 3 | `ANTHROPIC_MODEL` 环境变量 |
| 4 | `OPENAI_MODEL` 环境变量 |
| 5 | `~/.claude/settings.json` 中的 `model` 字段 |
| 6 | 内置默认值 |

## 环境变量总览

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `OPENAI_BASE_URL` | OpenAI 兼容 API 基础 URL |
| `OPENAI_MODEL` | 模型名称 |
| `CLAUDE_CODE_USE_OPENAI` | 启用 OpenAI 协议（1=启用） |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥（直连 Anthropic 时使用） |
| `CLAUDE_CODE_ENABLE_CFC` | 启用 Chrome 集成（1=启用） |
| `CLAUDE_CHROME_HTTP` | 启用 Chrome HTTP 桥接（1=启用） |
| `CLAUDE_CHROME_HTTP_PORT` | HTTP 桥接端口（默认 12306） |
| `CLAUDE_CODE_EXTRA_BODY` | API 请求的额外 body 参数 |
| `SPROCKET_DUDOT_ENABLED` | 开启宠物功能（1=启用） |

## Chrome 扩展（可选）

浏览器自动化需要安装 Claude in Chrome 扩展：

1. Ola CC 会自动安装原生主机清单
2. 从 Chrome 应用商店安装扩展
3. 设置 `CLAUDE_CODE_ENABLE_CFC=1` 或使用 `--chrome` 参数

## 构建

```bash
# 构建包装器包
bun run build:bin:wrapper

# 构建平台二进制包（当前平台）
bun run build:bin:platform

# 完整构建（包装器 + 当前平台二进制）
bun run build:bin
```

> **注意**：Windows 平台构建会使用 Node.js JS bundle 而非 Bun 编译二进制，以确保稳定性。

## 故障排除

### Windows 安装问题

如果 Windows 安装后运行 `ola-cc` 出现问题：

**方案 1：检查 Node.js 版本**

确保 Node.js >= 18：

```bash
node --version
```

**方案 2：手动启动 JS bundle**

绕过 npm bin shim，直接运行 JS bundle：

```bash
node "%APPDATA%\npm\node_modules\@zyzheal\ola-cc\cli.js"
```

或本地安装时：

```bash
node node_modules/@zyzheal/ola-cc/cli.js
```

**方案 3：使用降级启动器**

```bash
node node_modules/@zyzheal/ola-cc/cli-wrapper.cjs
```

### macOS/Linux 原生二进制问题

如果原生二进制无法运行：

```bash
# 手动重新安装
cd node_modules/@zyzheal/ola-cc
node install.cjs
```

## 许可证

详见 LICENSE.md。
