# 功能清单 — 用户指南

> 最后更新：2026-04-18

## 快速入门

### 启动 Claude Code

```bash
claude           # 启动交互式会话
claude --help    # 查看帮助
claude --version # 查看版本
```

### 基础交互方式

启动后进入交互式终端界面，直接输入文字与 AI 对话。AI 会自动使用工具来完成你的任务：

- **直接提问** — AI 会回答或搜索
- **请求写代码** — AI 会读取文件、编辑、运行测试
- **斜杠命令** — 输入 `/` 开头的命令执行特定操作

### 运行模式

| 模式 | 启动方式 | 说明 |
|------|---------|------|
| 交互模式 | `claude` | 默认，交互式 TUI |
| 非交互模式 | `claude -p "prompt"` | 管道模式，适合脚本 |
| 守护进程 | `claude --daemon` | 后台运行 [DAEMON] |
| 桥接模式 | `claude --bridge` | 远程桥接 [BRIDGE_MODE] |
| 计划模式 | `claude --plan-mode-required` | 只读分析模式 |

---

## 核心功能

### 对话与代码助手

Claude Code 是一个终端 AI 编程助手，具备以下核心能力：

- **自然语言对话** — 直接用中文/英文描述需求
- **代码理解** — 阅读、分析、解释项目代码
- **代码编写** — 创建和修改各类源文件
- **测试与调试** — 运行测试、定位 Bug、修复问题

### 文件读写与编辑

AI 可以使用以下工具操作文件：

| 工具 | 功能 | 说明 |
|------|------|------|
| **FileRead** | 读取文件 | 支持文本、图片(.png/.jpg)、PDF(最多20页)、Jupyter Notebook(.ipynb) |
| **FileEdit** | 精确编辑 | 字符串替换，支持 `replace_all` 全局替换 |
| **FileWrite** | 写入文件 | 创建新文件或覆盖现有文件，自动创建父目录 |
| **NotebookEdit** | 编辑 Notebook | 编辑 Jupyter Notebook 单元格 |

### 命令执行

AI 可以直接在终端执行命令：

| 工具 | 功能 | 说明 |
|------|------|------|
| **Bash** | 执行 Shell 命令 | 支持前台/后台执行，可设置超时 |
| **PowerShell** | 执行 PowerShell 命令 | Windows 平台专用 |

**安全机制**：高风险命令（如 `rm -rf`）需要用户审批；支持沙箱隔离执行。

### 代码搜索

| 工具 | 功能 | 说明 |
|------|------|------|
| **Glob** | 文件名搜索 | 支持 `**/*.ts`、`?`、`{a,b}` 等 glob 模式 |
| **Grep** | 内容搜索 | 基于 ripgrep，支持正则表达式、上下文显示、文件类型过滤 |

### 项目探索

AI 可以自主探索项目结构，理解代码架构：

- 使用 Glob + Grep 定位文件和代码片段
- 使用 Agent 工具委派代码探索任务给子代理
- 通过 LSP 工具获取代码语义信息（跳转定义、引用查找等）

---

## 斜杠命令

### 配置类

| 命令 | 功能 | 示例 |
|------|------|------|
| `/config` | 查看/修改 Claude Code 配置 | `/config set model=opus` |
| `/settings` | 管理用户设置 | `/settings` |
| `/theme` | 切换终端主题 | `/theme dark` |
| `/model` | 切换 AI 模型 | `/model sonnet` |
| `/output-style` | 设置输出风格 | `/output-style verbose` |
| `/permissions` | 管理权限规则 | `/permissions` |
| `/privacy-settings` | 隐私设置 | `/privacy-settings` |

### Git 类

| 命令 | 功能 | 示例 |
|------|------|------|
| `/commit` [内部] | 智能提交代码 | `/commit -m "fix: bug"` |
| `/branch` | 分支管理 | `/branch` |
| `/review` [内部] | 代码审查 | `/review HEAD~1` |
| `/pr_comments` | PR 评论管理 | `/pr_comments` |

### 会话类

| 命令 | 功能 | 示例 |
|------|------|------|
| `/clear` | 清空当前对话历史 | `/clear` |
| `/resume` | 恢复之前中断的会话 | `/resume` |
| `/session` | 管理会话 | `/session` |
| `/rename` | 重命名当前会话 | `/rename "auth refactor"` |
| `/compact` | 压缩对话上下文 | `/compact` |
| `/status` | 查看会话状态 | `/status` |
| `/goal` | 目标管理（支持长时间兜底重试） | `/goal "帮我写一个排序算法"` |

#### /goal 高级选项

| 参数 | 简写 | 功能 | 默认值 |
|------|------|------|--------|
| `--retry-interval` | `-r` | 兜底重试间隔 | 10m (10分钟) |
| `--max-hours` | `-t` | 最大重试小时数 | 24h |
| `--budget` | - | Token 预算 | 无上限 |
| `--auto-edit` | - | 自动批准文件编辑 | 关闭 |
| `--auto-accept` | - | 自动批准所有操作 | 关闭 |

**示例：**
```bash
# 使用默认配置
/goal "帮我写一个排序算法"

# 自定义重试间隔（5分钟）
/goal "帮我写一个排序算法" -r 5m

# 自定义最大重试时间（48小时）
/goal "帮我写一个排序算法" -t 48

# 组合使用
/goal "帮我写一个排序算法" -r 5m -t 48 --budget 100000

# 查看目标状态
/goal status

# 暂停/继续目标
/goal pause
/goal resume

# 清除目标
/goal clear
```

**兜底重试机制：**
- 阶段 1：指数退避重试（10 次，0.5s → 32s）
- 阶段 2：如果 10 次都失败，自动进入兜底模式，每 10 分钟重新执行 goal
- 兜底会在以下情况终止：目标完成、手动取消、超过最大时间、遇到永久错误（401/403）

### 工具管理类

| 命令 | 功能 | 示例 |
|------|------|------|
| `/mcp` | 管理 MCP 服务器 | `/mcp add github` |
| `/skills` | 管理技能 | `/skills list` |
| `/plugin` | 管理插件 | `/plugin install` |
| `/hooks` | 管理 Hook | `/hooks list` |

### 信息类

| 命令 | 功能 | 示例 |
|------|------|------|
| `/help` | 查看帮助文档 | `/help` |
| `/status` | 查看会话状态信息 | `/status` |
| `/usage` | 查看使用量统计 | `/usage` |
| `/cost` | 查看当前会话费用 | `/cost` |
| `/doctor` | 诊断环境问题 | `/doctor` |
| `/version` | 查看版本号 | `/version` |

### 记忆类

| 命令 | 功能 | 示例 |
|------|------|------|
| `/memory` | 管理项目记忆系统 | `/memory show` |

### IDE 类

| 命令 | 功能 | 示例 |
|------|------|------|
| `/ide` | IDE 集成设置 | `/ide` |

### 其他

| 命令 | 功能 | 示例 |
|------|------|------|
| `/init` | 初始化项目 Claude Code 配置 | `/init` |
| `/login` | 登录 Anthropic 账户 | `/login` |
| `/logout` | 登出当前账户 | `/logout` |
| `/feedback` | 提交反馈 | `/feedback` |
| `/issue` | 创建 Issue | `/issue` |
| `/share` | 分享当前会话 | `/share` |
| `/desktop` | 桌面端相关 | `/desktop` |
| `/mobile` | 移动端二维码 | `/mobile` |
| `/copy` | 复制最后一条消息 | `/copy` |
| `/diff` | 查看 Git diff | `/diff` |
| `/files` | 列出项目文件 | `/files` |
| `/vim` | 切换 Vim 模式 | `/vim` |
| `/color` | 设置 Agent 显示颜色 | `/color blue` |
| `/keybindings` | 查看快捷键 | `/keybindings` |
| `/exit` | 退出 Claude Code | `/exit` |
| `/upgrade` | 升级到最新版本 | `/upgrade` |
| `/insights` | 分析你的 Claude Code 使用报告 | `/insights` |
| `/btw` | 快速备注（"by the way"） | `/btw 记得检查权限` |
| `/stickers` | 贴纸功能 | `/stickers` |
| `/tags` | 标签管理 | `/tags` |
| `/export` | 导出会话 | `/export` |
| `/stats` | 统计信息 | `/stats` |
| `/thinkback` | 思维回放 | `/thinkback` |
| `/rewind` | 回退到历史状态 | `/rewind` |
| `/passes` | 传递次数管理 | `/passes` |
| `/peers` | 对等通信 [UDS_INBOX] | `/peers` |
| `/workflows` | 工作流脚本 [WORKFLOW_SCRIPTS] | `/workflows` |
| `/torch` | Torch 功能 [TORCH] | `/torch` |
| `/advisor` | 服务端顾问工具 | `/advisor` |
| `/chrome` | Chrome 浏览器设置 | `/chrome` |
| `/sandbox` | 沙箱开关 | `/sandbox toggle` |
| `/env` | 环境变量管理 | `/env` |
| `/agents` | Agent 管理 | `/agents` |
| `/plan` | 进入/退出计划模式 | `/plan` |
| `/tasks` | 任务管理 | `/tasks list` |

---

## Feature-gated 命令（需特定条件启用）

以下命令需要编译时开启对应特性门才能使用：

| 命令 | 门控 | 功能 |
|------|------|------|
| `/buddy` | `[BUDDY]` | AI 电子宠物，支持 hatch / card / pet / mute |
| `/proactive` | `[PROACTIVE]` | 主动自主模式，AI 自动找活干 |
| `/assistant` | `[KAIROS]` | 持久助手模式，跨会话运行 |
| `/brief` | `[KAIROS_BRIEF]` | 简报模式，精简输出 |
| `/bridge` | `[BRIDGE_MODE]` | 远程控制桥接，从 claude.ai 操控本地 |
| `/voice` | `[VOICE_MODE]` | 语音交互模式，Nova 3 STT |
| `/ultraplan` | `[ULTRAPLAN]` | 云端深度规划，Opus 独立研究 |
| `/fork` | `[FORK_SUBAGENT]` | 子代理分叉 |
| `/remoteControlServer` | `[DAEMON+BRIDGE_MODE]` | 远程控制服务器 |
| `/web` | `[CCR_REMOTE_SETUP]` | Claude Code on the Web 设置 |

---

## 工具系统（AI 可用的工具）

AI 在执行任务时可自动调用以下工具。用户无需手动调用，但可以了解 AI 能做哪些操作。

### 文件操作

| 工具 | 功能 |
|------|------|
| **FileRead** | 读取文件内容，支持文本/图片/PDF/Notebook |
| **FileEdit** | 精确字符串替换编辑文件 |
| **FileWrite** | 创建或覆盖写入文件 |
| **NotebookEdit** | 编辑 Jupyter Notebook 单元格 |

### 搜索

| 工具 | 功能 |
|------|------|
| **Glob** | 按 glob 模式搜索文件名 |
| **Grep** | 按正则表达式搜索文件内容（基于 ripgrep） |

### 命令执行

| 工具 | 功能 |
|------|------|
| **Bash** | 执行 Bash/Shell 命令，支持后台执行 |
| **PowerShell** | 执行 PowerShell 命令（Windows） |

### 网络

| 工具 | 功能 |
|------|------|
| **WebFetch** | 抓取指定 URL 的网页内容 |
| **WebSearch** | 使用搜索引擎搜索信息 |

### 任务管理

| 工具 | 功能 |
|------|------|
| **TaskCreate** | 创建后台任务 |
| **TaskUpdate** | 更新任务状态/进度 |
| **TaskGet** | 获取单个任务详情 |
| **TaskList** | 列出所有任务 |
| **TaskStop** | 停止运行中的任务 |
| **TaskOutput** | 获取任务输出日志 |

### Agent 委派

| 工具 | 功能 |
|------|------|
| **Agent** | 启动子代理执行特定任务 |

**内置 Agent 类型**：

| Agent | 功能 |
|-------|------|
| `general-purpose` | 通用目的（研究、搜索、多步骤任务） |
| `statusline-setup` | 配置终端状态行 |
| `explore` | 代码库探索 |
| `plan` | 任务规划 |
| `claude-code-guide` | Claude Code 使用指南 |
| `verification` | 验证（测试验证）[VERIFICATION_AGENT] |

**动态加载 Agent**（来自技能/插件）：

| Agent | 来源 |
|-------|------|
| `dev-enegine:initializer` | 项目初始化 |
| `dev-enegine:planner` | 需求分析与方案设计 |
| `dev-enegine:coder` | 代码实现与功能验证 |
| `dev-enegine:reviewer` | 代码审查 |
| `long-running-agent:coding` | 增量式功能开发 |
| `long-running-agent:initializer` | 项目初始化（带模板） |

### MCP 集成

| 工具 | 功能 |
|------|------|
| **MCPTool** | 调用 MCP 服务器提供的工具 |
| **ListMcpResources** | 列出已连接 MCP 服务器的资源 |
| **ReadMcpResource** | 从 MCP 服务器读取资源 |
| **McpAuthTool** | MCP 认证工具 |

### LSP 集成

| 工具 | 功能 |
|------|------|
| **LSPTool** | 语言服务器协议（代码跳转、补全、诊断） |

### 用户交互

| 工具 | 功能 |
|------|------|
| **AskUserQuestion** | 向用户提问获取输入 |
| **SendMessage** | 发送消息给用户（不期待回复） |
| **PushNotification** | 发送系统推送通知 |
| **SendUserFile** | 向用户发送文件 |
| **Sleep** | 等待指定时长 |

### 配置类

| 工具 | 功能 |
|------|------|
| **Config** | 读取/修改 Claude Code 配置 |
| **TodoWrite** | 写入 TODO 列表，跟踪任务进度 |
| **BriefTool** | 简报模式工具 [KAIROS_BRIEF] |

### Git 工作流

| 工具 | 功能 |
|------|------|
| **EnterPlanMode** | 进入只读计划模式 |
| **ExitPlanMode** | 退出计划模式，进入执行模式 |
| **EnterWorktree** | 创建/进入 Git 工作树 |
| **ExitWorktree** | 退出当前工作树 |

### 定时任务

| 工具 | 功能 |
|------|------|
| **ScheduleCron** | 创建定时任务（一次性/循环/永久） |
| **MonitorTool** | 监控工具 [MONITOR_TOOL] |
| **RemoteTriggerTool** | 远程触发工具 |

### 工具搜索

| 工具 | 功能 |
|------|------|
| **ToolSearch** | 搜索可用工具 |
| **DiscoverSkills** | 发现技能 |
| **SkillTool** | 调用已注册的技能 |

### 其他工具

| 工具 | 功能 |
|------|------|
| **WorkflowTool** | 执行工作流脚本 |
| **ReviewArtifactTool** | 审查制品 [REVIEW_ARTIFACT] |
| **TeamCreateTool** | 团队代理创建 |
| **TeamDeleteTool** | 团队代理删除 |
| **TerminalCaptureTool** | 终端内容捕获 |
| **SnipTool** | 内容截断 |
| **REPLTool** | REPL 交互工具 |
| **SubscribePRTool** | PR 订阅 |
| **SuggestBackgroundPRTool** | 建议后台 PR |
| **SyntheticOutputTool** | 合成输出 |
| **VerifyPlanExecutionTool** | 验证计划执行 |
| **WebBrowserTool** | 内置浏览器工具 |
| **TungstenTool** | Tungsten 工具 |
| **OverflowTestTool** | 溢出测试工具 |
| **CtxInspectTool** | 上下文检查 |
| **ListPeersTool** | 列出对等会话 |

---

## 特色功能

### Buddy 宠物系统 [BUDDY]

终端里的 AI 电子宠物。每人一只固定宠物，由用户 ID 确定性生成。

- **18 种物种**：鸭子、猫、龙、企鹅、水豚、蘑菇、幽灵、仙人掌等
- **5 级稀有度**：Common(60%) → Legendary(1%)
- **闪光系统**：1% 闪光概率，独立于稀有度
- **外观定制**：6 种眼睛 × 8 种帽子
- **五维属性**：DEBUGGING / PATIENCE / CHAOS / WISDOM / SNARK
- **交互命令**：
  - `/buddy hatch` — 孵化宠物
  - `/buddy card` — 查看宠物卡片
  - `/buddy pet` — 抚摸宠物（爱心动画）
  - `/buddy mute/unmute` — 静音/取消静音
- **ASCII 精灵动画**：idle / fidget / 特殊三帧动画
- **气泡对话**：宠物偶尔会通过气泡说话

### KAIROS 持久助手 [KAIROS]

关掉终端 Claude 仍在后台运行。

- **跨会话持久运行** — 关闭终端后仍在后台工作
- **每日自动日志** — 每天自动记录工作进展
- **做梦机制（Dream）** — 后台子代理整合分散的会话记忆
  - 24 小时 / 5 个新会话 / 无锁时触发
  - 四阶段整合：Orient → Gather → Consolidate → Prune
- **会话恢复** — 自动恢复中断的工作
- **Cron 定时任务** — 支持一次性、循环、永久三种任务类型
- **Jitter 防雷群** — 基于 taskId 的确定性延迟

### Proactive 主动模式 [PROACTIVE]

没人说话时 Claude 自己找活干。

- 启动后 AI 主动探索项目、发现问题、采取行动
- 通过 Sleep 工具控制空闲等待时间
- 按 Esc 暂停，下次输入恢复

### Brief 简报模式 [KAIROS_BRIEF]

精简输出模式，减少冗余信息，提高沟通效率。

### Bridge 远程控制 [BRIDGE_MODE]

从 claude.ai 网页端或手机直接操控本地终端的 Claude Code。

- **双向通信** — 网页/手机输入 → 本地执行 → 输出实时回传
- **权限审批** — 支持远程权限审批
- **模型切换** — 远程切换模型、设置思考 token 上限
- **崩溃恢复** — 4 小时 TTL 的恢复指针，自动恢复中断会话
- **两种模式**：
  - 独立模式 `claude remote-control` — 长运行服务器
  - REPL 内嵌模式 `/remote-control` — 镜像当前对话

### Chrome MCP 浏览器自动化

通过 Chrome Native Messaging 协议实现完整的浏览器自动化。

- **MCP 模式** — AI 实时控制浏览器
- **HTTP API** — 端口 12306，外部程序可通过 HTTP 调用
- **支持浏览器**：Chrome、Brave、Arc、Edge、Chromium、Vivaldi、Opera
- **核心能力**：
  - 页面导航（打开/关闭标签页）
  - DOM 操作（点击、填表、选择、拖拽）
  - 截图（全屏/元素截图）
  - JavaScript 执行
  - 控制台/网络日志读取
  - GIF 录制
  - 弹窗处理

**启动方式**：
```bash
claude --chrome              # 启用 Chrome MCP
OLA_CC_ENABLE_CFC=1 claude  # 通过环境变量启用
```

### Voice 语音模式 [VOICE_MODE]

通过语音与 Claude Code 交互。

- **STT 引擎**：Nova 3（Anthropic 语音识别）
- **录音规格**：16kHz 单声道，16-bit
- **静音检测**：2 秒静音自动停止
- **多平台**：macOS (CoreAudio)、Linux (cpal/arecord)、Windows (CoreAudio)
- **备选方案**：SoX `rec`（跨平台命令行录音）

### Ultraplan 云端规划 [ULTRAPLAN]

将复杂任务发送到云端 Opus 模型独立研究 10-30 分钟。

1. 输入 `/ultraplan <prompt>`
2. 云端 Opus 独立研究（最长 30 分钟）
3. 用户在浏览器中查看/修改方案
4. 批准执行或传送回本地

### Coordinator 多代理编排 [COORDINATOR_MODE]

将 Claude 分为指挥官和工作者两个角色。

| 角色 | 职责 | 工具 |
|------|------|------|
| **Coordinator** | 理解目标、拆解任务、综合结果 | 仅 Agent、SendMessage、TaskStop |
| **Worker** | 具体代码操作 | 完整工具集 |

**四阶段流程**：Research → Synthesis → Implementation → Verification

### Teleport 传送会话

跨设备会话迁移。

| 方向 | 方式 | 说明 |
|------|------|------|
| 本地 → 远程 | `--remote [desc]` | 创建远程 CCR 会话 |
| 远程 → 本地 | `--teleport [id]` | 恢复远程会话到本地 |

传送时自动将代码上下文打包为 Git Bundle。

### 自动记忆 (Auto-Memory)

自动持久化项目信息。

- **记忆类型**：用户信息 / 反馈指导 / 项目上下文 / 外部资源引用
- **自动保存**：可配置 `autoSaveFeedback` / `autoSaveProject`
- **存储位置**：`~/.claude/projects/<project-hash>/memory/`

### 插件系统

从多种来源加载扩展能力：

| 来源 | 位置 |
|------|------|
| 内置技能 | `src/skills/bundled/` |
| 用户技能 | `~/.claude/skills/` |
| 插件 | `~/.claude/plugins/` |
| MCP 技能 | MCP 服务器提供 |
| 工作流 | 工作流脚本 |

**内置技能列表**：

| 技能 | 功能 |
|------|------|
| `/update-config` | 修改 Claude Code 配置 |
| `/verify` | 验证改动正确性 |
| `/debug` | 调试辅助 |
| `/remember` | 记忆管理 |
| `/simplify` | 代码简化与优化 |
| `/stuck` | 卡住时的帮助 |
| `/batch` | 批量操作 |
| `/skillify` | 将指令转换为技能 |
| `/keybindings` | 快捷键参考 |
| `/dream` | 记忆整合 [KAIROS] |
| `/loop` | 循环执行 [AGENT_TRIGGERS] |

### LSP 集成

语言服务器协议支持：

- 跳转定义
- 查找引用
- 代码诊断
- 悬停提示

### 沙箱

隔离执行环境，防止命令影响宿主机：

- 文件系统读写限制
- 网络访问控制（可配置允许域名）
- 可通过 `/sandbox toggle` 开关

---

## 配置选项

### 配置文件位置

| 文件 | 作用域 | 优先级 |
|------|--------|--------|
| `~/.claude.json` | 用户全局 | 高 |
| `.claude/settings.local.json` | 项目级 | 中 |
| `.claude.local.json` | 项目根目录 | 中 |
| `~/.claude/settings.json` | 用户级 | 高 |

### 主要配置项

| 配置项 | 说明 | 示例值 |
|--------|------|--------|
| `model` | 默认 AI 模型 | `"claude-sonnet-4-6"` |
| `permissionMode` | 权限模式 | `"default"` / `"auto"` / `"bypass"` |
| `permissions` | 权限规则 | `{ "alwaysAllow": [...], "alwaysDeny": [...] }` |
| `theme` | 终端主题 | `"dark"` / `"light"` |
| `outputStyle` | 输出风格 | `"default"` / `"verbose"` |
| `language` | 界面语言 | `"zh-CN"` |
| `sandbox.enabled` | 沙箱开关 | `true` / `false` |
| `compactThreshold` | 上下文压缩阈值 | `0.8` |
| `claudeInChromeDefaultEnabled` | Chrome 默认启用 | `true` |
| `memory.autoSaveFeedback` | 自动保存反馈 | `true` |
| `memory.autoSaveProject` | 自动保存项目信息 | `true` |

### MCP 配置

位置：`~/.claude/mcp.json`

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

### Provider Models 配置

通过 `~/.claude.json` 的 `model` 和 `providerModels` 字段，可以自定义 `/model` 命令的模型列表，替代内置的 Claude 模型。适用于 Anthropic 和 OpenAI 两种协议。

#### 全局配置

编辑 `~/.claude.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-provider.example.com",
    "ANTHROPIC_API_KEY": "sk-xxx"
  },
  "model": "qwen3.6-plus",
  "providerModels": ["qwen3.6-plus", "qwen3.5-plus", "glm-5", "kimi-k2.5"]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | `string` | 默认使用的模型 ID |
| `providerModels` | `string[]` | `/model` 命令展示的可切换模型列表 |

#### OpenAI 协议配置

```json
{
  "env": {
    "CLAUDE_CODE_USE_OPENAI": "1",
    "OPENAI_BASE_URL": "https://api.deepseek.com/v1",
    "OPENAI_API_KEY": "sk-xxx"
  },
  "model": "deepseek-chat",
  "providerModels": ["deepseek-chat", "deepseek-reasoner"]
}
```

#### 项目级配置

在 `~/.claude.json` 的 `projects` 下为特定项目配置不同的模型：

```json
{
  "projects": {
    "/path/to/my-project": {
      "model": "glm-5",
      "providerModels": ["glm-5", "glm-4.7"]
    }
  }
}
```

项目级配置存在时**完全覆盖**全局配置，不合并。

#### 优先级

模型选择优先级（从高到低）：

1. 运行时 override（`/model` 命令已选择的）
2. `config.model` 字段（项目级优先于全局）
3. 环境变量（`ANTHROPIC_MODEL` / `OPENAI_MODEL`）
4. 用户设置（`settings.model`）

#### 边界情况

- `providerModels` 为空数组 `[]` — 视为未配置，回退到内置 Claude 模型列表
- `model` 指向 `providerModels` 之外的模型 — 允许（视为自定义模型）
- 未配置 `providerModels` — 保持现有行为不变，显示内置 Claude 模型

### Hook 配置

位置：`~/.claude/settings.json` 或 `.claude.local.json`

| 事件 | 触发时机 |
|------|---------|
| `SessionStart` | 会话开始 |
| `ToolCall` | 工具调用前/后 |
| `UserPromptSubmit` | 用户提交提示前 |
| `Message` | 收到消息时 |

---

## 环境变量速查

### 模型与行为

| 环境变量 | 功能 |
|----------|------|
| `ANTHROPIC_MODEL` | 覆盖默认模型 |
| `OLA_CC_MAX_OUTPUT_TOKENS` | 最大输出 token 数 |
| `OLA_CC_DISABLE_THINKING` | 禁用思考过程 |
| `OLA_CC_DISABLE_ADAPTIVE_THINKING` | 禁用自适应思考 |
| `OLA_CC_SYNTAX_HIGHLIGHT` | 语法高亮主题 |
| `OLA_CC_DISABLE_AUTO_MEMORY` | 禁用自动记忆 |
| `OLA_CC_IDLE_THRESHOLD_MINUTES` | 空闲阈值（默认 75 分钟） |
| `OLA_CC_MAX_TOOL_USE_CONCURRENCY` | 最大工具并发数 |

### 模式开关

| 环境变量 | 功能 |
|----------|------|
| `OLA_CC_PROACTIVE` | 启用主动模式 |
| `OLA_CC_COORDINATOR_MODE` | 启用协调器模式 |
| `OLA_CC_BRIEF` | 启用简报模式 |
| `OLA_CC_ENABLE_CFC` | 强制启用 Chrome MCP (1/0) |
| `CLAUDE_CHROME_PERMISSION_MODE` | Chrome 权限模式 (ask/skip_all/follow_a_plan) |

### 第三方模型

| 环境变量 | 功能 |
|----------|------|
| `CLAUDE_CODE_USE_BEDROCK` | 使用 AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | 使用 Google Vertex |
| `CLAUDE_CODE_USE_FOUNDRY` | 使用 Foundry |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | 跳过 Bedrock 认证 |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH` | 跳过 Vertex 认证 |

### API 扩展

| 环境变量 | 功能 |
|----------|------|
| `OLA_CC_EXTRA_BODY` | API 请求附加 JSON body |
| `OLA_CC_EXTRA_METADATA` | API 请求附加元数据 |
| `OLA_CC_CLIENT_CERT` | 客户端证书 |

### 会话与身份

| 环境变量 | 功能 |
|----------|------|
| `OLA_CC_OAUTH_TOKEN` | OAuth 令牌 |
| `OLA_CC_OAUTH_REFRESH_TOKEN` | OAuth 刷新令牌 |
| `OLA_CC_ACCOUNT_UUID` | 帐户 UUID |
| `OLA_CC_CUSTOM_OAUTH_URL` | 自定义 OAuth URL |

---

## CLI 参数速查

### 常用参数

| 参数 | 功能 |
|------|------|
| `--model <model>` | 指定 AI 模型（如 `sonnet`、`opus`、`claude-sonnet-4-6`） |
| `--permission-mode <mode>` | 权限模式（`default` / `auto` / `bypass`） |
| `--output-style <style>` | 输出风格 |
| `--effort <level>` | 努力程度（`low` / `medium` / `high` / `max`） |
| `-p "<prompt>"` / `--print` | 非交互模式，执行后退出 |
| `--version` | 显示版本号 |
| `--help` | 显示帮助信息 |

### 模式参数

| 参数 | 功能 |
|------|------|
| `--chrome` | 启用 Chrome MCP 浏览器自动化 |
| `--no-chrome` | 禁用 Chrome MCP |
| `--proactive` | 启动主动自主模式 |
| `--brief` | 启用简报模式 |
| `--assistant` | 强制助手模式（Agent SDK daemon 用） |
| `--remote [description]` | 创建远程 CCR 会话 |
| `--teleport [session-id]` | 恢复传送会话 |
| `--remote-control [name]` / `--rc` | 启动远程桥接 |
| `--plan-mode-required` | 要求先进入计划模式 |
| `--daemon` | 守护进程模式 |
| `--bridge` | 桥接模式 |

### 团队/Agent 参数

| 参数 | 功能 |
|------|------|
| `--agent-id <id>` | 队友代理 ID |
| `--agent-name <name>` | 队友显示名称 |
| `--team-name <name>` | 团队名称 |
| `--agent-color <color>` | 队友 UI 颜色 |
| `--agent-type <type>` | 自定义代理类型 |
| `--parent-session-id <id>` | 父会话 ID |
| `--teammate-mode <mode>` | 队友生成方式 |

### 其他参数

| 参数 | 功能 |
|------|------|
| `--sdk-url <url>` | WebSocket 端点（管道模式） |
| `--advisor <model>` | 服务端顾问工具 |
| `--messaging-socket-path <path>` | UDS 通信路径 [UDS_INBOX] |

---

## 快捷键参考

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+C` | 中断当前操作 |
| `Esc` | 暂停主动模式 / 关闭弹出窗口 |
| `Ctrl+L` | 清屏 |
| `Shift+Up/Down` | 浏览历史消息 |
| `Shift+Down` | 打开后台任务对话框 |
| `Tab` | 自动补全（命令/文件路径） |

---

*文档版本：1.0 | 基于源码分析生成*
