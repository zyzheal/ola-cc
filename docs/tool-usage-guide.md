# 工具使用详解

**项目**: Claude Code 源码分析  
**文档类型**: 工具使用指南  
**更新日期**: 2026-04-12

---

## 目录

1. [文件操作工具](#1-文件操作工具)
2. [命令行执行工具](#2-命令行执行工具)
3. [Agent 工具系统](#3-agent 工具系统)
4. [任务管理工具](#4-任务管理工具)
5. [MCP 集成工具](#5-mcp 集成工具)
6. [用户交互工具](#6-用户交互工具)
7. [Web 工具](#7-web 工具)
8. [配置工具](#8-配置工具)
9. [计划与工作树](#9-计划与工作树)
10. [配置机制详解](#10-配置机制详解)

---

## 1. 文件操作工具

### 1.1 Read (文件读取)

**功能**: 读取文件内容，支持文本、图片、PDF、Jupyter Notebook

**命令语法**:
```
/Read <file_path> [options]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `file_path` | string | ✅ | - | 文件绝对路径 |
| `limit` | number | ❌ | 2000 | 最大读取行数 |
| `offset` | number | ❌ | 0 | 起始行号 |
| `pages` | string | ❌ | - | PDF 页码范围 (如 "1-5") |

**示例**:
```bash
# 读取完整文件
/Read /Users/heal/devops/claude-code/src/index.ts

# 读取文件的一部分 (第 100-200 行)
/Read /Users/heal/devops/claude-code/src/index.ts --limit 100 --offset 100

# 读取 PDF 文件的第 3-5 页
/Read /path/to/document.pdf --pages "3-5"

# 读取 Jupyter Notebook
/Read /path/to/notebook.ipynb
```

**支持格式**:
- 文本：`.ts`, `.tsx`, `.js`, `.md`, `.json`, `.yaml`, `.py`, `.go`, `.rs` 等
- 图片：`.png`, `.jpg`, `.jpeg`, `.gif` (视觉模型处理)
- PDF: `.pdf` (最多 20 页/次)
- Notebook: `.ipynb` (包含代码和输出)

---

### 1.2 Edit (文件编辑)

**功能**: 精确字符串替换编辑文件内容

**命令语法**:
```
/Edit <file_path> --old_string "<原字符串>" --new_string "<新字符串>" [options]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `file_path` | string | ✅ | - | 文件绝对路径 |
| `old_string` | string | ✅ | - | 要替换的原始字符串 |
| `new_string` | string | ✅ | - | 替换后的新字符串 |
| `replace_all` | boolean | ❌ | false | 替换所有匹配项 |

**示例**:
```bash
# 基本编辑
/Edit /Users/heal/src/app.ts \
  --old_string "function oldName() {}" \
  --new_string "function newName() {}"

# 替换所有出现
/Edit /Users/heal/src/app.ts \
  --old_string "const DEBUG = true" \
  --new_string "const DEBUG = false" \
  --replace_all true
```

**注意事项**:
- `old_string` 必须完全匹配（包括缩进和空格）
- 如果字符串不唯一，编辑会失败
- 使用 `replace_all` 可替换所有匹配项

---

### 1.3 Write (文件写入)

**功能**: 创建新文件或覆盖现有文件

**命令语法**:
```
/Write <file_path> --content "<文件内容>"
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `file_path` | string | ✅ | - | 文件绝对路径 |
| `content` | string | ✅ | - | 文件完整内容 |

**示例**:
```bash
# 创建新文件
/Write /Users/heal/project/src/utils.ts \
  --content "export function helper() {\n  return 42;\n}"

# 覆盖现有文件
/Write /Users/heal/project/config.json \
  --content "{\"name\": \"my-app\", \"version\": \"1.0.0\"}"
```

**安全机制**:
- 敏感文件检测（`.env`, `credentials.json` 等）会警告
- 自动创建不存在的父目录

---

### 1.4 Glob (文件搜索)

**功能**: 使用 glob 模式搜索文件

**命令语法**:
```
/Glob --pattern "<glob 模式>" [--path "<搜索目录>"]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `pattern` | string | ✅ | - | glob 模式（如 `**/*.ts`） |
| `path` | string | ❌ | cwd | 搜索目录 |

**示例**:
```bash
# 搜索所有 TypeScript 文件
/Glob --pattern "**/*.ts"

# 在指定目录搜索
/Glob --pattern "**/*.tsx" --path "/Users/heal/src/components"

# 搜索多层目录
/Glob --pattern "src/**/utils/*.ts"
```

**支持的模式**:
- `*` - 匹配单个目录内的任意字符
- `**` - 匹配任意深度目录
- `?` - 匹配单个字符
- `{a,b}` - 匹配 a 或 b

---

### 1.5 Grep (内容搜索)

**功能**: 使用正则表达式搜索文件内容

**命令语法**:
```
/Grep --pattern "<正则表达式>" [options]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `pattern` | string | ✅ | - | 正则表达式 |
| `path` | string | ❌ | cwd | 搜索目录 |
| `glob` | string | ❌ | - | 文件模式过滤（如 `*.ts`） |
| `type` | string | ❌ | - | 文件类型（如 `js`, `py`, `rust`） |
| `-n` | boolean | ❌ | true | 显示行号 |
| `-i` | boolean | ❌ | false | 忽略大小写 |
| `output_mode` | string | ❌ | files_with_matches | `content`/`files_with_matches`/`count` |
| `-A` | number | ❌ | 0 | 显示匹配后 N 行 |
| `-B` | number | ❌ | 0 | 显示匹配前 N 行 |
| `-C` | number | ❌ | 0 | 显示匹配前后 N 行 |

**示例**:
```bash
# 搜索包含 "function" 的行
/Grep --pattern "function\s+\w+"

# 在 TypeScript 文件中搜索
/Grep --pattern "interface.*{" --type ts

# 显示上下文
/Grep --pattern "useState" -A 2 -B 2 --output_mode content

# 统计匹配数
/Grep --pattern "TODO" --output_mode count

# 忽略大小写搜索
/Grep --pattern "error" -i
```

---

## 2. 命令行执行工具

### 2.1 Bash (Shell 命令)

**功能**: 执行 Bash/Shell 命令

**命令语法**:
```
/Bash --command "<命令>" [options]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `command` | string | ✅ | - | 要执行的命令 |
| `timeout` | number | ❌ | 120000 | 超时时间 (ms) |
| `run_in_background` | boolean | ❌ | false | 后台执行 |
| `description` | string | ❌ | - | 命令描述（用于日志） |

**示例**:
```bash
# 基本命令
/Bash --command "git status"

# 带超时的长时间命令
/Bash --command "npm run build" --timeout 300000

# 后台执行（完成后通知）
/Bash --command "npm test" --run_in_background true

# 链式命令
/Bash --command "git add . && git commit -m 'fix: bug'"
```

**安全机制**:
- 路径验证（防止越狱）
- 破坏性命令警告（`rm -rf`, `dd` 等）
- 沙箱隔离（如启用）
- 用户批准（中高风险命令）

---

### 2.2 PowerShell (Windows)

**功能**: 执行 PowerShell 命令

**命令语法**:
```
/PowerShell --command "<命令>" [options]
```

**参数**: 同 Bash

**示例**:
```powershell
# 基本命令
/PowerShell --command "Get-ChildItem"

# 获取进程
/PowerShell --command "Get-Process | Where-Object {$_.CPU -gt 100}"

# Git 操作
/PowerShell --command "git status"
```

**注意事项**:
- 不使用 `&&`, `||`, `?:` 等 PowerShell 7+ 语法
- 使用 `; if ($?) { B }` 进行条件执行
- 原生 exe 用 `& "path.exe"` 调用

---

## 3. Agent 工具系统

### 3.1 Agent (启动子代理)

**功能**: 启动专用 Agent 处理复杂任务

**命令语法**:
```
/Agent --description "<任务描述>" --prompt "<详细指令>" [--subagent_type "<类型>"]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `description` | string | ✅ | - | 简短描述（3-5 词） |
| `prompt` | string | ✅ | - | 详细任务指令 |
| `subagent_type` | string | ❌ | general-purpose | Agent 类型 |
| `isolation` | string | ❌ | - | `worktree` 隔离模式 |

**内置 Agent 类型**:
| 类型 | 功能 |
|------|------|
| `general-purpose` | 通用 Agent（研究、搜索、多步骤任务） |
| `statusline-setup` | 配置状态行 |
| `claude-code-guide` | Claude Code 使用指南 |
| `dev-enegine:initializer` | 项目初始化 |
| `dev-enegine:planner` | 需求分析与技术方案设计 |
| `dev-enegine:coder` | 代码实现与功能验证 |
| `dev-enegine:reviewer` | 代码审查 |
| `long-running-agent:coding` | 增量式功能开发 |
| `long-running-agent:initializer` | 项目初始化（带模板） |

**示例**:
```bash
# 启动通用 Agent 进行研究
/Agent \
  --description "研究项目结构" \
  --prompt "分析当前项目的目录结构，找出所有 TypeScript 文件并按功能分类"

# 使用专用 Agent
/Agent \
  --description "代码审查" \
  --prompt "审查 src/auth.ts 的安全性、性能和规范性" \
  --subagent_type dev-enegine:reviewer

# 隔离模式（临时工作树）
/Agent \
  --description "实验性功能" \
  --prompt "实现新功能 X" \
  --isolation worktree
```

---

### 3.2 后台 Agent

**功能**: 在后台运行 Agent 任务

**命令语法**:
```
/Agent --description "<描述>" --prompt "<指令>" --run_in_background true
```

**示例**:
```bash
# 后台运行耗时任务
/Agent \
  --description "分析代码库" \
  --prompt "全面分析 src/ 目录下的所有文件" \
  --run_in_background true
```

---

## 4. 任务管理工具

### 4.1 TaskCreate (创建任务)

**功能**: 创建新的后台任务

**命令语法**:
```
/TaskCreate --description "<任务描述>" --command "<命令>"
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `description` | string | ✅ | - | 任务描述 |
| `command` | string | ✅ | - | 要执行的命令 |

**示例**:
```bash
/TaskCreate \
  --description "构建项目" \
  --command "npm run build"
```

---

### 4.2 TaskList (列出任务)

**功能**: 查看所有任务状态

**命令语法**:
```
/TaskList
```

**输出示例**:
```
| ID | 描述 | 状态 | 进度 |
|----|------|------|------|
| 1 | 构建项目 | running | 50% |
| 2 | 运行测试 | pending | 0% |
```

---

### 4.3 TaskUpdate (更新任务)

**功能**: 更新任务状态或进度

**命令语法**:
```
/TaskUpdate --taskId <ID> --progress <0-100> [--status "<状态>"]
```

**参数**:
| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `taskId` | string | ✅ | 任务 ID |
| `progress` | number | ❌ | 进度百分比 |
| `status` | string | ❌ | `pending`/`in_progress`/`completed`/`stopped` |

**示例**:
```bash
/TaskUpdate --taskId "1" --progress 75
```

---

### 4.4 TaskStop (停止任务)

**功能**: 停止运行中的任务

**命令语法**:
```
/TaskStop --taskId <ID>
```

---

### 4.5 TaskOutput (获取任务输出)

**功能**: 获取后台任务的输出日志

**命令语法**:
```
/TaskOutput --taskId <ID>
```

---

## 5. MCP 集成工具

### 5.1 ListMcpResourcesTool (列出 MCP 资源)

**功能**: 列出已连接的 MCP 服务器资源

**命令语法**:
```
/ListMcpResources
```

**输出**:
```
MCP Servers:
- GitHub: issues, pull_requests, repos
- FileSystem: read, write, list
```

---

### 5.2 ReadMcpResourceTool (读取 MCP 资源)

**功能**: 从 MCP 服务器读取资源

**命令语法**:
```
/ReadMcpResource --server "<服务器名>" --resource "<资源类型>" --id "<资源 ID>"
```

**示例**:
```bash
# 读取 GitHub Issue
/ReadMcpResource --server "github" --resource "issues" --id "123"

# 读取文件系统内容
/ReadMcpResource --server "filesystem" --resource "file" --path "/path/to/file.txt"
```

---

### 5.3 MCPTool (MCP 工具调用)

**功能**: 调用 MCP 服务器提供的工具

**命令语法**:
```
/MCP --server "<服务器名>" --tool "<工具名>" --args "<参数 JSON>"
```

**示例**:
```bash
# 调用 GitHub API
/MCP --server "github" --tool "create_issue" \
  --args '{"repo": "owner/repo", "title": "Bug", "body": "Description"}'
```

---

## 6. 用户交互工具

### 6.1 AskUserQuestion (向用户提问)

**功能**: 向用户提出问题获取输入

**命令语法**:
```
/AskUserQuestion --question "<问题文本>"
```

**示例**:
```bash
/AskUserQuestion \
  --question "你想使用哪种数据库？(PostgreSQL/MySQL/MongoDB)"
```

---

### 6.2 SendMessage (发送消息)

**功能**: 发送消息给用户（不期待回复）

**命令语法**:
```
/SendMessage --message "<消息内容>" [--status "<状态>"]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `message` | string | ✅ | - | 消息内容 |
| `status` | string | ❌ | normal | `normal`/`proactive` |

**示例**:
```bash
# 普通消息
/SendMessage --message "任务已完成"

# 主动通知
/SendMessage \
  --message "后台构建已完成，发现 3 个错误" \
  --status proactive
```

---

### 6.3 Sleep (等待)

**功能**: 等待指定时间

**命令语法**:
```
/Sleep --duration <毫秒>
```

**示例**:
```bash
# 等待 5 秒
/Sleep --duration 5000

# 等待 1 分钟
/Sleep --duration 60000
```

---

### 6.4 PushNotification (推送通知)

**功能**: 发送系统推送通知

**命令语法**:
```
/PushNotification --title "<标题>" --body "<内容>" [--priority "<优先级>"]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `title` | string | ✅ | - | 通知标题 |
| `body` | string | ✅ | - | 通知内容 |
| `priority` | string | ❌ | normal | `low`/`normal`/`high` |

**示例**:
```bash
/PushNotification \
  --title "构建完成" \
  --body "项目已成功构建，无错误"
```

---

## 7. Web 工具

### 7.1 WebSearch (Web 搜索)

**功能**: 使用搜索引擎搜索

**命令语法**:
```
/WebSearch --query "<搜索词>" [--num_results <数量>]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | ✅ | - | 搜索关键词 |
| `num_results` | number | ❌ | 10 | 返回结果数 |

**示例**:
```bash
/WebSearch --query "TypeScript best practices 2026"
```

---

### 7.2 WebFetch (网页抓取)

**功能**: 抓取网页内容

**命令语法**:
```
/WebFetch --url "<URL>" [--include_images <boolean>]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | string | ✅ | - | 要抓取的 URL |
| `include_images` | boolean | ❌ | false | 是否包含图片 |

**示例**:
```bash
/WebFetch --url "https://example.com/docs"
```

**安全限制**:
- 内网访问受限
- 需要用户批准未知域名

---

## 8. 配置工具

### 8.1 Config (修改配置)

**功能**: 修改 Claude Code 配置

**命令语法**:
```
/Config --set "<key>=<value>" [--file "<配置文件>"]
```

**参数**:
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `set` | string | ✅ | - | 键值对设置 |
| `file` | string | ❌ | user | `user`/`system`/`project` |

**示例**:
```bash
# 设置默认模型
/Config --set "model=claude-sonnet-4-6"

# 修改项目配置
/Config --set "permissionMode=auto" --file project
```

**支持的配置项**:
| 配置 | 说明 |
|------|------|
| `model` | 默认 AI 模型 |
| `permissionMode` | 权限模式 (`default`/`auto`/`bypass`) |
| `sandbox.enabled` | 是否启用沙箱 |
| `theme` | 界面主题 |

---

## 9. 计划与工作树

### 9.1 EnterPlanMode (进入计划模式)

**功能**: 进入只读分析模式

**命令语法**:
```
/EnterPlanMode
```

**特性**:
- 只读文件访问
- 无破坏性操作
- 适合代码审查

---

### 9.2 ExitPlanMode (退出计划模式)

**功能**: 退出计划模式，返回执行模式

**命令语法**:
```
/ExitPlanMode
```

---

### 9.3 EnterWorktree (进入工作树)

**功能**: 创建/进入 Git 工作树

**命令语法**:
```
/EnterWorktree --branch "<分支名>" [--path "<路径>"]
```

**示例**:
```bash
/EnterWorktree --branch "feature/new-auth"
```

---

### 9.4 ExitWorktree (退出工作树)

**功能**: 退出当前工作树

**命令语法**:
```
/ExitWorktree
```

---

## 10. 配置机制详解

### 10.1 配置文件层次

```
1. 管理设置 (最高优先级)
   └── 企业/团队策略，用户无法覆盖

2. 系统设置
   └── /etc/claude-code/config.json

3. 用户设置
   └── ~/.claude/settings.json

4. 项目设置
   └── .claude.local.json (项目根目录)

5. 命令行参数 (最低优先级，但可覆盖上述所有)
   └── --model claude-opus-4-6
```

---

### 10.2 用户配置文件

**位置**: `~/.claude/settings.json`

**示例**:
```json
{
  "model": "claude-sonnet-4-6",
  "permissionMode": "default",
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "allowWrite": ["./.git/**", "./node_modules/**"],
      "denyWrite": ["./src/**"]
    },
    "network": {
      "allowManagedDomainsOnly": true,
      "allowedHosts": ["api.anthropic.com"]
    }
  },
  "permissionRules": {
    "alwaysAllow": ["Bash(ls *)", "Glob(**/*.ts)"],
    "alwaysDeny": ["Bash(rm -rf *)"]
  },
  "theme": "dark",
  "compactThreshold": 0.8
}
```

---

### 10.3 项目配置文件

**位置**: `.claude.local.json` (项目根目录)

**示例**:
```json
{
  "memory": {
    "autoSaveFeedback": true,
    "autoSaveProject": true
  },
  "skills": {
    "enabled": ["commit", "review-pr"]
  },
  "hooks": {
    "ToolCall": {
      "pre": "echo 'Calling tool: $TOOL_NAME'"
    }
  }
}
```

---

### 10.4 Feature Gates (编译开关)

**说明**: 内部功能开关，外部版本默认关闭

**主要开关**:
| 开关 | 功能 | 外部可用 |
|------|------|----------|
| `BUDDY` | 宠物系统 | ❌ |
| `KAIROS` | 持久助手 | ❌ |
| `ULTRAPLAN` | 云端规划 | ❌ |
| `COORDINATOR_MODE` | 多 Agent 编排 | ❌ |
| `BRIDGE_MODE` | 远程控制 | ❌ |
| `VOICE_MODE` | 语音模式 | ❌ |
| `BASH_CLASSIFIER` | Bash 命令分类器 | ❌ |

---

### 10.5 权限模式配置

**命令**: `/config` 或直接编辑配置文件

**支持的模式**:
| 模式 | 说明 |
|------|------|
| `default` | 默认模式：危险操作需批准 |
| `auto`/`yolo` | 自动模式：分类器决定 |
| `bypass` | 绕过模式：无需批准（高风险） |

**配置示例**:
```json
{
  "permissionMode": "default",
  "permissionRules": {
    "alwaysAllow": [
      "Bash(ls -la)",
      "Bash(git status)",
      "Glob(**/*.ts)",
      "Grep(pattern, type=ts)"
    ],
    "alwaysDeny": [
      "Bash(rm -rf /)",
      "Bash(dd if=...)"
    ]
  }
}
```

---

### 10.6 MCP 配置

**位置**: `~/.claude/mcp.json`

**示例**:
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-filesystem"],
      "config": {
        "allowedPaths": ["/Users/heal/projects"]
      }
    }
  }
}
```

---

### 10.7 技能配置

**位置**: `~/.claude/skills/` 目录

**示例技能文件**: `~/.claude/skills/commit.md`

```markdown
# /commit: 提交代码

执行 git 提交流程：
1. 运行 git status 查看变更
2. 运行 git diff 查看具体内容
3. 生成提交信息
4. 执行 git add 和 git commit
```

**使用方式**:
```bash
/commit -m "feat: add user authentication"
```

---

### 10.8 Hook 配置

**位置**: `.claude.local.json` 或 `~/.claude/settings.json`

**支持的 Hook 事件**:
| 事件 | 触发时机 |
|------|----------|
| `SessionStart` | 会话开始 |
| `ToolCall` | 工具调用前/后 |
| `UserPromptSubmit` | 用户提交提示前 |
| `Message` | 收到消息时 |

**配置示例**:
```json
{
  "hooks": {
    "SessionStart": {
      "pre": "echo 'Starting session at $(date)'"
    },
    "ToolCall": {
      "pre": "echo 'Calling $TOOL_NAME with args: $TOOL_ARGS' >> ~/.claude/tool.log"
    }
  }
}
```

---

### 10.9 记忆系统配置

**位置**: `~/.claude/projects/<project-hash>/memory/`

**记忆类型**:
| 类型 | 说明 | 示例 |
|------|------|------|
| `user` | 用户信息 | 角色、偏好、知识 |
| `feedback` | 反馈指导 | 工作方式偏好 |
| `project` | 项目上下文 | 目标、截止日期 |
| `reference` | 外部资源 | Linear、Grafana 链接 |

**配置**:
```json
{
  "memory": {
    "autoSaveFeedback": true,
    "autoSaveProject": true,
    "maxMemorySize": 100
  }
}
```

---

## 附录：快速参考卡

### 常用工具速查

| 工具 | 命令示例 |
|------|----------|
| Read | `/Read /path/to/file.ts` |
| Edit | `/Edit file.ts --old "x" --new "y"` |
| Write | `/Write file.ts --content "..."` |
| Glob | `/Glob --pattern "**/*.ts"` |
| Grep | `/Grep --pattern "TODO" --type ts` |
| Bash | `/Bash --command "git status"` |
| Agent | `/Agent --desc "分析" --prompt "..."` |
| TaskCreate | `/TaskCreate --desc "构建" --cmd "npm build"` |
| Config | `/Config --set "model=opus"` |

### 常用配置速查

| 配置 | 命令 |
|------|------|
| 更改模型 | `/config --set "model=claude-opus-4-6"` |
| 权限模式 | `/config --set "permissionMode=auto"` |
| 启用沙箱 | `/config --set "sandbox.enabled=true"` |
| 查看配置 | `/config` |

---

*文档版本：1.0 | 最后更新：2026-04-12*
