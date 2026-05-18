# Ola-CC (Ola Claude Code)

AI 编码助手，运行在你的终端中。

<p align="center">
  <img src="preview.png?raw=true" alt="Claude Code CLI" width="700">
</p>

## 快速开始

```bash
bun install              # 安装依赖（需要 Bun >= 1.3.5）
bun run dev              # 启动开发模式
bun run dev:buddy        # 启动开发模式（带宠物功能）
```

### 宠物功能

| 子命令 | 说明 |
|--------|------|
| `/buddy hatch` | 领养宠物 |
| `/buddy card` | 查看宠物卡片 |
| `/buddy pet` | 互动（抚摸） |
| `/buddy mute` | 静音宠物 |
| `/buddy unmute` | 取消静音 |
| `/buddy reset` | 放生宠物（需重新领养） |
| `/buddy reroll` | 重新随机宠物 |

宠物系统包含 18 种物种、5 级稀有度（普通/非凡/稀有/史诗/传说）、1% 闪光概率，使用确定性生成（FNV-1a 哈希 + Mulberry32 PRNG）。

---

## 完整功能清单

### 一、公开命令（默认启用）

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/config` | 查看/修改配置 |
| `/mcp` | 管理 MCP 服务器连接 |
| `/skills` | 查看可用技能列表 |
| `/model` | 切换使用的模型 |
| `/theme` | 切换终端主题 |
| `/color` | 修改 AI 显示颜色 |
| `/vim` | 切换 Vim 模式 |
| `/compact` | 压缩/清理上下文 |
| `/clear` | 清屏/清除对话 |
| `/diff` | 显示当前代码差异 |
| `/status` | 显示会话状态 |
| `/cost` | 显示当前会话费用 |
| `/doctor` | 诊断环境配置 |
| `/login` / `/logout` | 登录/登出 |
| `/memory` | 查看/管理 AI 记忆 |
| `/init` | 初始化项目配置 |
| `/keybindings` | 查看快捷键绑定 |
| `/usage` | 显示使用统计 |
| `/stats` | 显示会话统计 |
| `/copy` | 复制最后一条消息 |
| `/share` | 分享当前会话 |
| `/summary` | 生成对话摘要 |
| `/rename` | 重命名会话 |
| `/resume` | 恢复之前的会话 |
| `/session` | 会话管理 |
| `/commit` | 提交代码（标准版） |
| `/commit-push-pr` | 提交、推送并创建 PR |
| `/review` / `/ultrareview` | 代码审查 |
| `/security-review` | 安全性审查 |
| `/permissions` | 权限管理 |
| `/plan` | 切换规划模式 |
| `/hooks` | 管理 Hook 钩子 |
| `/files` | 列出跟踪的文件 |
| `/branch` | 分支管理 |
| `/agents` | Agent 管理 |
| `/plugin` | 插件管理 |
| `/reload-plugins` | 重新加载插件 |
| `/rewind` | 回退到之前的对话 |
| `/desktop` | 桌面端集成 |
| `/mobile` | 移动端二维码 |
| `/stickers` | 贴纸 |
| `/sandbox` | 沙箱模式切换 |
| `/chrome` | Chrome 扩展集成 |
| `/advisor` | AI 顾问模式 |
| `/btw` | 快速备注 |
| `/release-notes` | 查看版本更新说明 |
| `/terminal-setup` | 终端环境配置 |
| `/web-setup` | Web 远程设置 |
| `/upgrade` | 升级版本 |
| `/effort` | 努力程度设置 |
| `/statusline` | 状态栏设置 |
| `/rate-limit-options` | 速率限制配置 |
| `/extra-usage` | 额外使用说明 |
| `/privacy-settings` | 隐私设置 |
| `/passes` | 传递设置 |
| `/tasks` | 任务管理 |
| `/export` | 导出数据 |
| `/remote-env` | 远程环境变量 |
| `/output-style` | 输出样式设置 |
| `/remoteControlServer` | 远程控制服务器 |
| `/install-github-app` | 安装 GitHub 应用 |
| `/install-slack-app` | 安装 Slack 应用 |
| `/add-dir` | 添加目录到项目 |
| `/think-back` | 回顾之前的对话 |
| `/heapdump` | 生成堆转储 |
| `/pr-comments` | PR 评论管理 |
| `/insights` | 会话分析报告 |

### 二、Feature-gated 隐藏命令（需编译时开启）

默认只启用 `VOICE_MODE` 和 `BUDDY`，以下功能需编译时添加 `--feature` 参数：

| 命令 | 所需 Feature | 说明 |
|------|-------------|------|
| `/buddy` | `BUDDY` (默认) | 电子宠物系统 |
| `/voice` | `VOICE_MODE` (默认) | 语音交互模式 |
| `/bridge` | `BRIDGE_MODE` | 远程控制桥接，从 claude.ai/手机操控本地终端 |
| `/proactive` | `PROACTIVE` 或 `KAIROS` | 主动自主模式，没任务时自动找活干 |
| `/assistant` | `KAIROS` | 持久助手模式，关闭终端也继续运行 |
| `/brief` | `KAIROS_BRIEF` | 简报模式 |
| `/fork` | `FORK_SUBAGENT` | 子代理分叉，并行执行任务 |
| `/peers` | `UDS_INBOX` | 对等通信，跨 Claude 会话消息传递 |
| `/workflows` | `WORKFLOW_SCRIPTS` | 工作流脚本 |
| `/torch` | `TORCH` | Torch 功能 |
| `/force-snip` | `HISTORY_SNIP` | 强制历史截断 |

### 三、INTERNAL_ONLY 内部专属命令

这些命令在 `USER_TYPE === 'ant'` 时才可用，外部版中 `isEnabled` 直接返回 `false` 或被硬编码过滤：

| 命令 | 说明 |
|------|------|
| `/backfill-sessions` | 回填历史会话数据 |
| `/break-cache` | 强制清除缓存 |
| `/bughunter` | 内部 Bug 猎人工具 |
| `/commit` | 提交代码（内部版带特殊逻辑） |
| `/commit-push-pr` | 一键提交、推送并创建 PR（内部版） |
| `/ctx_viz` | 上下文可视化工具 |
| `/good-claude` | 内部反馈收集 |
| `/issue` | 内部 Issue 上报 |
| `/init-verifiers` | 初始化验证器 |
| `/force-snip` | 强制历史截断（内部版） |
| `/mock-limits` | 模拟速率限制（调试用） |
| `/bridge-kick` | 踢出桥接连接 |
| `/version` | 版本信息（内部增强版） |
| `/ultraplan` | 云端深度规划（永远不可用，`"external" === 'ant'` 死代码消除） |
| `/subscribe-pr` | 订阅 PR 通知 |
| `/reset-limits` | 重置速率限制 |
| `/onboarding` | 新手引导（内部版） |
| `/teleport` | 传送会话到远程/本地 |
| `/ant-trace` | 内部追踪调试工具 |
| `/perf-issue` | 性能问题诊断 |
| `/env` | 环境变量调试 |
| `/oauth-refresh` | OAuth 刷新 |
| `/debug-tool-call` | 调试工具调用 |
| `/agents-platform` | 智能体平台管理 |
| `/autofix-pr` | 自动修复 PR |
| `/tag` | 标签管理 |
| `/files` | 文件列表（内部增强版） |
| `/thinkback-play` | Thinkback 回放 |

### 四、隐藏 CLI 参数

```
--teleport [session]    恢复传送会话
--remote [description]  创建远程会话
--proactive             主动模式
--assistant             助手模式
--brief                 简报模式
--remote-control        远程控制
--agent-teams           多代理团队
--hard-fail             硬失败模式
```

---

## 系统架构

### 整体结构

```
src/                    # 核心源码
├── entrypoints/        # 入口文件（cli.tsx, dev-entry.ts）
├── tools/              # 53+ 工具（Bash/FileEdit/Agent/MCP...）
├── commands/           # 87+ 斜杠命令实现
├── services/           # API 调用 / MCP / analytics / autoDream
├── components/         # 148 终端 UI 组件（React + Ink）
├── hooks/              # 87 自定义 React Hooks
├── buddy/              # 宠物系统
├── assistant/          # KAIROS 持久助手模式
├── coordinator/        # 多 Agent 协调编排
├── bridge/             # 远程控制桥接
├── proactive/          # 主动自主模式
├── vim/                # Vim 模式引擎
├── voice/              # 语音交互
└── utils/              # 通用工具函数
shims/                  # 原生模块兼容替代
vendor/                 # 原生绑定二进制文件
scripts/                # 构建和发布脚本
```

### 三层门控机制

项目通过三层门控控制功能的启用与裁剪：

#### 第一层：编译时开关（feature()，50+ 个）

构建时决定代码包含/排除。默认启用：`VOICE_MODE`、`BUDDY`。

**默认启用的 Feature:**

| Feature | 说明 |
|---------|------|
| `VOICE_MODE` | 语音交互 |
| `BUDDY` | 宠物系统 |

**实验性 Feature（需手动开启）:**

| Feature | 说明 | Feature | 说明 |
|---------|------|---------|------|
| `BRIDGE_MODE` | 远程控制桥接 | `KAIROS` | 持久助手模式 |
| `KAIROS_BRIEF` | 简报模式 | `KAIROS_CHANNELS` | 通道通知 |
| `PROACTIVE` | 主动自主模式 | `DAEMON` | 守护进程模式 |
| `COORDINATOR_MODE` | 多 Agent 编排 | `FORK_SUBAGENT` | 子代理分叉 |
| `UDS_INBOX` | Unix Socket 收件箱 | `BG_SESSIONS` | 后台会话 |
| `WORKFLOW_SCRIPTS` | 工作流脚本 | `TORCH` | Torch 功能 |
| `HISTORY_SNIP` | 历史截断 | `BASH_CLASSIFIER` | Bash 分类器 |
| `TEMPLATES` | 模板/分类器 | `CACHED_MICROCOMPACT` | 缓存微压缩 |
| `CONTEXT_COLLAPSE` | 上下文折叠 | `REACTIVE_COMPACT` | 响应式压缩 |
| `EXTRACT_MEMORIES` | 自动提取记忆 | `TEAMMEM` | 团队记忆同步 |
| `MCP_SKILLS` | MCP 技能系统 | `EXPERIMENTAL_SKILL_SEARCH` | 实验性技能搜索 |
| `QUICK_SEARCH` | 快速搜索 | `TOKEN_BUDGET` | Token 预算 |
| `STREAMLINED_OUTPUT` | 精简输出 | `NATIVE_CLIENT_ATTESTATION` | 客户端证明 |
| `ANTI_DISTILLATION_CC` | 反蒸馏保护 | `CHICAGO_MCP` | Computer Use MCP |
| `PROMPT_CACHE_BREAK_DETECTION` | 缓存中断检测 | `FILE_PERSISTENCE` | 文件持久化 |
| `COMMIT_ATTRIBUTION` | 提交归属 | `CCR_AUTO_CONNECT` | 自动 CCR 连接 |
| `CCR_MIRROR` | CCR 镜像 | `CCR_REMOTE_SETUP` | Web 远程设置 |
| `MONITOR_TOOL` | 监控工具 | `LODESTONE` | Lodestone 功能 |
| `MCP_RICH_OUTPUT` | MCP 富文本输出 | `MESSAGE_ACTIONS` | 消息操作 |
| `NATIVE_CLIPBOARD_IMAGE` | 原生剪贴板图片 | `NEW_INIT` | 新初始化 |
| `POWERSHELL_AUTO_MODE` | PowerShell 自动模式 | `SHOT_STATS` | 统计快照 |
| `TREE_SITTER_BASH` | Tree-sitter Bash | `TREE_SITTER_BASH_SHADOW` | Tree-sitter 影子模式 |
| `ULTRAPLAN` | 云端深度规划 | `ULTRATHINK` | 深度思考 |
| `UNATTENDED_RETRY` | 无人值守重试 | `VERIFICATION_AGENT` | 验证 Agent |
| `AGENT_MEMORY_SNAPSHOT` | Agent 记忆快照 | `AGENT_TRIGGERS` | Agent 触发器 |
| `AGENT_TRIGGERS_REMOTE` | Agent 远程触发器 | `AWAY_SUMMARY` | 离开摘要 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 内置探索规划 Agent | `COMPACTION_REMINDERS` | 压缩提醒 |
| `CONNECTOR_TEXT` | 连接器文本 | `HISTORY_PICKER` | 历史选择器 |
| `HOOK_PROMPTS` | Hook 提示词 | `CCR_AUTO_CONNECT` | CCR 自动连接 |

#### 第二层：用户类型（USER_TYPE）

编译时固定为 `'external'`，无法在运行时更改：

| 类型 | 说明 |
|------|------|
| `ant`（内部） | 全部功能、调试工具、20 分钟 GrowthBook 刷新、200+ 内部检查点 |
| `external`（外部） | 裁剪版，6 小时 GrowthBook 刷新 |

#### 第三层：GrowthBook 远程 A/B 测试

| 远程开关 | 控制内容 |
|----------|---------|
| `tengu_kairos` | KAIROS 助手模式开关 |
| `tengu_onyx_plover` | 自动做梦阈值（间隔/会话数） |
| `tengu_cobalt_frost` | 语音识别（Nova 3）开关 |
| `tengu_ultraplan_model` | Ultraplan 使用的模型 |
| `tengu_ant_model_override` | 内部用户模型覆盖 |
| `tengu_session_memory` | 会话记忆功能 |
| `tengu_max_version_config` | 自动更新 Kill Switch |
| `tengu_frond_boric` | 数据接收器 Kill Switch |
| `tengu_herring_clock` | 团队记忆路径 |
| `tengu_sm_config` | 会话记忆配置 |

### 核心子系统

| 子系统 | 说明 |
|--------|------|
| **宠物系统 (BUDDY)** | 18 种物种、5 级稀有度、1% 闪光概率、确定性生成（FNV-1a + Mulberry32 PRNG） |
| **KAIROS 助手** | 跨会话持久运行、每日日志、自动记忆整合（Dream）、主动模式 |
| **多 Agent 编排** | Coordinator/Worker 角色分离、并行任务执行、共享任务列表 |
| **远程桥接 (Bridge)** | WebSocket 实时连接、claude.ai/手机远程控制、权限审批 |
| **语音模式** | 语音交互、语音识别 |
| **MCP 集成** | 支持多种 MCP 服务器、Chrome 扩展集成 |

### 内部专属能力（USER_TYPE === 'ant'）

以下能力仅在内部版本中可用：

| 能力 | 说明 |
|------|------|
| Agent Tool `remote` 隔离模式 | 内部用户可在远程 CCR 环境执行 Agent，外部版仅有 `worktree` |
| Bash Tool 环境变量白名单 | 内部用户特定环境变量自动放行，无需审批 |
| 沙箱强制启用 | 内部用户默认启用沙箱执行 |
| SkillTool 内部调试面板 | 内部用户可见技能加载详情和诊断信息 |
| Explore Agent 模型覆盖 | 内部版使用 `inherit` 模型，外部版强制 `haiku` |
| ToolSearchTool 内部搜索 | 内部用户可搜索内部工具目录 |
| FileEditTool 内部验证 | 内部用户的文件编辑走额外验证路径 |
| 内部日志系统 | `internalLogging.ts` — Anthropic 内部遥测管道 |
| 第一方事件分析 | `firstPartyEventLogger.ts` — 内部埋点 + Datadog 导出 |
| GrowthBook 20 分钟刷新 | 内部用户远程开关刷新频率为 20 分钟（外部 6 小时） |
| BigQuery 数据导出 | 内部分析管道，导出使用数据到大查询 |
| VCR 录制/回放 | API 交互的录制回放，用于内部调试 |
| Dump Prompts | 导出原始 prompt 用于调试 |
| Undercover 模式 | 内部调试/测试模式 |

### 配置体系

配置读取优先级（从高到低）：

1. **命令行参数** — `--` 参数
2. **环境变量** — 当前 shell 环境
3. **`~/.claude/session.json`** — 会话级配置（API 密钥、模型、环境变量）
4. **`~/.claude/settings.json`** — 用户级设置（MCP 服务器、偏好）
5. **`.claude/CLAUDE.md`** — 项目级指令

---

## 构建系统

### 构建命令

| 命令 | 说明 | 输出 |
|------|------|------|
| `bun run dev` | 开发模式（直接运行 TSX） | 内存 |
| `bun run dev:buddy` | 开发模式 + 宠物功能 | 内存 |
| `bun run build` | 生产构建（Bun bytecode） | `./cli` (~150MB) |
| `bun run build:dev` | 开发构建（Bun bytecode） | `./cli-dev` |
| `bun run build:dev:full` | 全功能开发构建（所有实验性功能） | `./cli-dev` |
| `bun run compile` | 编译构建（带 --compile） | `./dist/cli` |
| `bun run ./scripts/build-publish.ts` | npm 发布构建（Node.js 兼容） | `dist/publish/` |

### 生产构建（Bun Bytecode）

`scripts/build.ts` 将源码打包为 Bun bytecode 二进制文件：

- **入口**: `src/entrypoints/cli.tsx`
- **目标**: Bun 运行时，ESM 格式，字节码编译
- **优化**: minify + bytecode + lazy loading
- **宏定义**: 注入 `MACRO.VERSION`、`MACRO.BUILD_TIME` 等编译时常量
- **USER_TYPE**: 编译时固定为 `'external'`
- **外部依赖**: 排除平台特定的原生模块

```bash
# 默认构建（含 VOICE_MODE + BUDDY）
bun run build

# 全功能开发构建（开启所有实验性功能）
bun run build:dev:full

# 自定义功能组合
bun run ./scripts/build.ts --feature=KAIROS --feature=BRIDGE_MODE --feature=PROACTIVE
```

### npm 发布构建（Node.js 兼容）

`scripts/build-publish.ts` 生成可在 Node.js 18+ 上运行的跨平台 JS 包：

**构建流程**:

1. **JS Bundle**: 用 Bun 打包 `src/entrypoints/cli.tsx`，目标为 Node.js
   - 输出: `dist/publish/cli.js` (~10MB)
   - 注入 shebang `#!/usr/bin/env node`
   - 注入 `feature()` 降级 polyfill（Node.js 运行时返回 false）

2. **发布配置**: 生成干净的 `dist/publish/package.json`
   - 包名: `@zyzheal/ola-cc`
   - 唯一运行时依赖: `ws`
   - 可选依赖: `sharp`

3. **静态文件**: 复制 README、LICENSE、类型定义

4. **原生依赖**: 收集平台特定的二进制文件到 `vendor/`
   - ripgrep 多平台二进制文件
   - Linux seccomp 沙箱配置
   - 原生 addon（`.node` 文件）

**发布**:

```bash
cd dist/publish
npm publish --dry-run    # 预览
npm publish              # 发布
```

### 构建输出结构

```
dist/publish/
├── cli.js              # JS bundle (~10MB, 跨平台, Node.js >=18)
├── package.json        # 发布配置（@zyzheal/ola-cc）
├── README.md           # 用户文档
├── LICENSE.md          # 许可证
├── sdk-tools.d.ts      # TypeScript 类型定义
└── vendor/             # 可选原生依赖
    ├── ripgrep/        # 多平台 rg 二进制
    ├── seccomp/        # Linux 沙箱配置
    └── *.node          # 原生 addon
```

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | API 密钥 |
| `OPENAI_API_KEY` | OpenAI API 密钥（OpenAI 兼容模式必需） |
| `OPENAI_API_BASE` / `OPENAI_BASE_URL` | 自定义 OpenAI API 地址 |
| `OPENAI_MODEL` | 默认 OpenAI 模型名（覆盖 Anthropic 模型映射） |
| `OPENAI_EXTRA_BODY` | 额外请求参数（JSON，用于后端特定配置如 vLLM 前缀缓存） |
| `OPENAI_CONTEXT_LIMIT` | 上下文窗口限制（默认 128000），用于小 context window 的 provider |
| `CLAUDE_CODE_USE_OPENAI` | 启用 OpenAI 兼容模式（设为 1 开启） |
| `API_BASE_URL` | API 代理地址 |
| `OLA_CC_ENABLE_CFC` | 启用 Chrome 集成（1=启用，0=禁用） |
| `CLAUDE_CHROME_HTTP` | Chrome HTTP 桥接模式（1=启用） |
| `CLAUDE_CHROME_HTTP_PORT` | HTTP 端口（默认 12306） |
| `ENABLE_TOOL_SEARCH` | 工具搜索模式：`tst`（默认）、`tst-auto`、`standard` |
| `OLA_CC_EXTRA_BODY` | API 请求的额外 body 参数 |
| `ANTHROPIC_MODEL` | 模型覆盖 |
| `OLA_CC_MAX_OUTPUT_TOKENS` | 最大输出 token |
| `OLA_CC_DISABLE_THINKING` | 禁用思考 |
| `OLA_CC_PROACTIVE` | 主动模式 |
| `OLA_CC_COORDINATOR_MODE` | 协调器模式 |
| `OLA_CC_BRIEF` | 简报模式 |
| `CLAUDE_CODE_USE_BEDROCK` | 使用 AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | 使用 Google Vertex |
| `OLA_CC_DISABLE_AUTO_MEMORY` | 禁用自动记忆 |
| `OLA_CC_SYNTAX_HIGHLIGHT` | 语法高亮主题 |
| `OLA_CC_IDLE_THRESHOLD_MINUTES` | 空闲阈值（默认 75 分钟） |
| `SPROCKET_DUDOT_ENABLED` | 启用宠物伴随 |

---

## 详细分析文档

完整的功能分析和深入技术文档见 [docs/](docs/) 目录：

- [01-buddy.md](docs/01-buddy.md) - 宠物系统分析
- [02-kairos.md](docs/02-kairos.md) - KAIROS 助手模式
- [03-ultraplan.md](docs/03-ultraplan.md) - 云端深度规划
- [04-coordinator.md](docs/04-coordinator.md) - 多 Agent 编排
- [05-hidden-commands.md](docs/05-hidden-commands.md) - 隐藏命令
- [06-bridge.md](docs/06-bridge.md) - 远程桥接
- [07-feature-gates.md](docs/07-feature-gates.md) - 功能门控详解
- [08-chrome-mcp.md](docs/08-chrome-mcp.md) - Chrome MCP 集成

## 数据来源

- npm 包：[@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- 还原方式：提取 `cli.js.map` 中的 `sourcesContent`

## 声明

- 源码版权归 [Anthropic](https://www.anthropic.com) 所有
- 仅用于技术研究与学习，请勿用于商业用途
- 如有侵权，请联系删除
