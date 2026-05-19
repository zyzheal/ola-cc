# 功能清单 — 开发者指南

> 最后更新：2026-04-18
> 本文档面向 Claude Code CLI 的维护者和贡献者，描述源码结构、系统架构和扩展点。

## 入口与启动流程

### 入口文件

| 文件 | 职责 |
|------|------|
| `src/entrypoints/cli.tsx` | 引导入口，快速路由（--version, --help, bridge, daemon, bg 等），全动态 import 避免模块加载 |
| `src/main.tsx` | 完整 CLI 初始化，Commander.js 选项解析，REPL 启动 |

### 启动流程图

```
cli.tsx (main())
  |
  ├── 快速路径: --version / --help / version 子命令 → 零加载直接返回
  ├── update/upgrade → 提示使用完整 CLI
  ├── doctor → 提示需要完整 CLI
  ├── --dump-system-prompt → 输出系统提示后退出 (ant-only)
  ├── --claude-in-chrome-mcp → Chrome MCP 服务器
  ├── --chrome-native-host → Chrome Native Host
  ├── --computer-use-mcp → Computer Use MCP (CHICAGO_MCP)
  ├── --daemon-worker → Worker 进程 (DAEMON)
  ├── remote-control/rc/remote/sync/bridge → Bridge 服务器 (BRIDGE_MODE)
  ├── daemon → Daemon 监管进程 (DAEMON)
  ├── ps/logs/attach/kill/--bg → 后台会话管理 (BG_SESSIONS)
  ├── new/list/reply → 模板作业 (TEMPLATES)
  ├── environment-runner → BYOC 执行器 (BYOC_ENVIRONMENT_RUNNER)
  ├── self-hosted-runner → 自托管执行器 (SELF_HOSTED_RUNNER)
  ├── --worktree --tmux → Tmux worktree 执行
  └── 默认路径: enableConfigs() → import main.tsx → cliMain()
```

### main.tsx 初始化流程 (关键阶段)

1. 启动性能分析 (`profileCheckpoint`)
2. 预读取 MDM/Keychain/Prefetch
3. Commander.js 选项解析
4. GrowthBook 初始化（A/B 测试）
5. 策略限制加载 (`policyLimits`)
6. 远程管理设置加载
7. MCP 预取（官方注册表 + 资源）
8. 技能加载（内置 + 用户目录 + 插件）
9. 插件初始化 (`initBuiltinPlugins`)
10. 内置技能注册 (`initBundledSkills`)
11. REPL 启动

### CLI 参数解析

使用 `@commander-js/extra-typings` (Commander.js)。主要选项在 `main.tsx` 中定义：

- `-p/--print` — 打印响应并退出（无头模式）
- `-d/--debug` — 调试模式
- `--bare` — 最小模式：跳过 hooks、LSP、插件同步
- `--model <model>` — 指定模型
- `--permission-mode <mode>` — 权限模式
- `--remote` — 远程模式
- `--bg/--background` — 后台会话

---

## 命令系统

### 命令注册机制

**核心文件**: `src/commands.ts`

命令在 `commands.ts` 中通过 `COMMANDS()` 函数组装为数组，使用 `memoize` 缓存。

**命令类型** (`src/types/command.ts`):

| 类型 | 说明 |
|------|------|
| `prompt` | 扩展为发送给模型的提示词（技能类命令） |
| `local` | 本地执行，返回 `LocalCommandResult` |
| `local-jsx` | 渲染 Ink/React UI 组件 |

**Command 接口核心字段**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 命令名 |
| `type` | `'prompt' \| 'local' \| 'local-jsx'` | 命令类型 |
| `description` | `string` | 描述 |
| `aliases?` | `string[]` | 别名 |
| `isEnabled?` | `() => boolean` | 动态启用检查 |
| `isHidden?` | `boolean` | 是否在类型ahead中隐藏 |
| `loadedFrom?` | `'commands_DEPRECATED' \| 'skills' \| 'plugin' \| 'bundled' \| 'mcp'` | 来源 |
| `availability?` | `('claude-ai' \| 'console')[]` | 可用环境 |
| `getPromptForCommand` | `(args, context) => Promise<ContentBlockParam[]>` | prompt 类型专用 |

**插件命令扩展点**:

```
getPluginCommands()       → ~/.claude/plugins/ 下的命令
getSkillDirCommands(cwd)  → ~/.claude/skills/ 下的命令
getBundledSkills()        → src/skills/bundled/ 内置技能
getBuiltinPluginSkillCommands() → 内置插件技能
getWorkflowCommands(cwd)  → 工作流命令
```

### 命令目录速查

| 命令名 | 源码路径 | 功能简述 | Feature Gate |
|--------|----------|----------|-------------|
| `/add-dir` | `src/commands/add-dir/` | 添加项目目录到上下文 | |
| `/advisor` | `src/commands/advisor.js` | 切换 Advisor 模型 | |
| `/agents` | `src/commands/agents/` | 管理自定义 Agent 定义 | |
| `/branch` | `src/commands/branch/` | 分支创建与切换 | |
| `/btw` | `src/commands/btw/` | 快速笔记 | |
| `/chrome` | `src/commands/chrome/` | Claude in Chrome 配置 | |
| `/clear` | `src/commands/clear/` | 清空对话 | |
| `/color` | `src/commands/color/` | 设置 Agent 颜色 | |
| `/compact` | `src/commands/compact/` | 手动上下文压缩 | |
| `/config` | `src/commands/config/` | 配置管理 | |
| `/context` | `src/commands/context/` | 查看上下文信息 | |
| `/cost` | `src/commands/cost/` | 查看会话成本 | |
| `/diff` | `src/commands/diff/` | 查看文件差异 | |
| `/doctor` | `src/commands/doctor/` | 健康检查 | |
| `/effort` | `src/commands/effort/` | 设置努力程度 | |
| `/exit` | `src/commands/exit/` | 退出会话 | |
| `/export` | `src/commands/export/` | 导出对话 | |
| `/fast` | `src/commands/fast/` | 快速模式开关 | |
| `/feedback` | `src/commands/feedback/` | 发送反馈 | |
| `/files` | `src/commands/files/` | 列出跟踪文件 | |
| `/help` | `src/commands/help/` | 帮助 | |
| `/hooks` | `src/commands/hooks/` | Hook 管理 | |
| `/ide` | `src/commands/ide/` | IDE 扩展连接 | |
| `/init` | `src/commands/init.ts` | 初始化项目 | |
| `/keybindings` | `src/commands/keybindings/` | 快捷键管理 | |
| `/login` | `src/commands/login/` | 登录认证 | |
| `/logout` | `src/commands/logout/` | 登出 | |
| `/mcp` | `src/commands/mcp/` | MCP 服务器管理 | |
| `/memory` | `src/commands/memory/` | 记忆管理 | |
| `/mobile` | `src/commands/mobile/` | 移动端二维码 | |
| `/model` | `src/commands/model/` | 切换模型 | |
| `/passes` | `src/commands/passes/` | 传递次数管理 | |
| `/permissions` | `src/commands/permissions/` | 权限管理 | |
| `/plan` | `src/commands/plan/` | 计划模式切换 | |
| `/plugin` | `src/commands/plugin/` | 插件管理 | |
| `/privacy-settings` | `src/commands/privacy-settings/` | 隐私设置 | |
| `/reload-plugins` | `src/commands/reload-plugins/` | 重新加载插件 | |
| `/rename` | `src/commands/rename/` | 重命名会话 | |
| `/resume` | `src/commands/resume/` | 恢复会话 | |
| `/review` | `src/commands/review.ts` | 代码审查 | |
| `/rewind` | `src/commands/rewind/` | 对话回溯 | |
| `/sandbox-toggle` | `src/commands/sandbox-toggle/` | 沙箱切换 | |
| `/session` | `src/commands/session/` | 会话信息（QR 码） | |
| `/show-all-tools` | `src/commands/show-all-tools/` | 显示所有工具 | |
| `/skills` | `src/commands/skills/` | 技能列表 | |
| `/stats` | `src/commands/stats/` | 统计信息 | |
| `/status` | `src/commands/status/` | 会话状态 | |
| `/statusline` | `src/commands/statusline.tsx` | 状态行切换 | |
| `/stickers` | `src/commands/stickers/` | 贴纸 | |
| `/tag` | `src/commands/tag/` | 标签管理 | |
| `/tasks` | `src/commands/tasks/` | 后台任务管理 | |
| `/theme` | `src/commands/theme/` | 主题切换 | |
| `/thinkback` | `src/commands/thinkback/` | 回顾分析 | |
| `/torch` | `src/commands/torch/` | Torch 相关 | |
| `/upgrade` | `src/commands/upgrade/` | 检查更新 | |
| `/usage` | `src/commands/usage/` | 用量信息 | |
| `/vim` | `src/commands/vim/` | Vim 模式切换 | |
| `/workflows` | `src/commands/workflows/` | 工作流管理 | |
| `/fork` | `src/commands/fork/` | Fork 子代理 | |
| `/buddy` | `src/commands/buddy/` | Buddy 功能 | |
| `/proactive` | `src/commands/proactive.ts` | 主动模式 | |
| `/brief` | `src/commands/brief.ts` | 简要模式 | |
| `/assistant` | `src/commands/assistant/` | 助手模式 (KAIROS) | KAIROS |
| `/bridge` | `src/commands/bridge/` | Bridge 远程 | BRIDGE_MODE |
| `/voice` | `src/commands/voice/` | 语音模式 | VOICE_MODE |
| `/remote-control` | `src/commands/remoteControlServer/` | 远程控制服务器 | BRIDGE_MODE |
| `/insights` | `src/commands/insights.js` | 会话分析（懒加载） | |

**内部命令** (仅 ant 构建): `backfill-sessions`, `break-cache`, `bughunter`, `commit`, `commit-push-pr`, `ctx_viz`, `good-claude`, `issue`, `init-verifiers`, `force-snip`, `mock-limits`, `bridge-kick`, `version`, `ultraplan`, `subscribe-pr`, `reset-limits`, `onboarding`, `share`, `summary`, `teleport`, `ant-trace`, `perf-issue`, `env`, `oauth-refresh`, `debug-tool-call`, `agents-platform`, `autofix-pr`

### 如何添加新命令

1. 在 `src/commands/` 下创建目录（如 `src/commands/my-command/`）
2. 创建 `index.ts`，导出符合 `Command` 接口的对象
3. 在 `src/commands.ts` 中导入并加入 `COMMANDS()` 数组

```typescript
// src/commands/my-command/index.ts
const myCommand: Command = {
  type: 'local',
  name: 'my-command',
  description: '我的命令描述',
  supportsNonInteractive: true,
  async load() {
    return {
      async call(args, context) {
        return { type: 'text', value: 'Hello!' };
      },
    };
  },
};
export default myCommand;
```

```typescript
// src/commands.ts — 添加导入
import myCommand from './commands/my-command/index.js';

// 在 COMMANDS() 中加入
const COMMANDS = memoize((): Command[] => [
  // ...
  myCommand,
]);
```

---

## 工具系统

### 工具组装流程

**核心文件**: `src/tools.ts`

```
getTools(permissionContext)
  └── getAllBaseTools()  → 所有内置工具
        └── filterToolsByDenyRules()  → 按权限规则过滤
              └── assembleToolPool()  → 合并 MCP 工具
                    ├── 内置工具排序
                    ├── MCP 工具排序
                    └── uniqBy(name) 去重
```

### Tool 接口 (`src/Tool.ts`)

核心字段:

| 字段 | 说明 |
|------|------|
| `name` | 工具名 |
| `inputSchema` | Zod 输入模式 |
| `call(args, context, canUseTool, parentMessage, onProgress)` | 执行逻辑 |
| `description(input, options)` | 动态描述（发送给模型） |
| `prompt(options)` | 工具指令（系统提示词部分） |
| `renderToolUseMessage(input, options)` | 渲染工具使用 UI |
| `renderToolResultMessage(content, options)` | 渲染结果 UI |
| `isEnabled()` | 是否启用 |
| `isConcurrencySafe(input)` | 是否支持并发 |
| `isReadOnly(input)` | 是否只读 |
| `isDestructive?(input)` | 是否破坏性操作 |
| `checkPermissions(input, context)` | 权限检查 |
| `shouldDefer?` | 是否延迟加载（需要 ToolSearch） |
| `alwaysLoad?` | 永不延迟加载 |
| `maxResultSizeChars` | 结果大小限制 |

**工具构建函数**: `buildTool(def)` — 填充默认值

### 工具目录速查

| 工具名 | 源码路径 | 功能简述 | 备注 |
|--------|----------|----------|------|
| AgentTool | `src/tools/AgentTool/` | 子代理执行 | 核心 |
| BashTool | `src/tools/BashTool/` | Shell 命令执行 | 核心 |
| FileReadTool | `src/tools/FileReadTool/` | 文件读取 | 核心 |
| FileEditTool | `src/tools/FileEditTool/` | 文件编辑（统一编辑/写入） | 核心 |
| FileWriteTool | `src/tools/FileWriteTool/` | 文件写入 | 核心 |
| GlobTool | `src/tools/GlobTool/` | 文件通配搜索 | 核心 |
| GrepTool | `src/tools/GrepTool/` | 文件内容搜索 | 核心 |
| WebSearchTool | `src/tools/WebSearchTool/` | 网页搜索 | 核心 |
| WebFetchTool | `src/tools/WebFetchTool/` | 网页获取 | 核心 |
| TodoWriteTool | `src/tools/TodoWriteTool/` | 待办事项管理 | 核心 |
| SkillTool | `src/tools/SkillTool/` | 技能调用 | 核心 |
| TaskCreateTool | `src/tools/TaskCreateTool/` | 创建后台任务 | |
| TaskGetTool | `src/tools/TaskGetTool/` | 获取任务详情 | |
| TaskListTool | `src/tools/TaskListTool/` | 列出任务 | |
| TaskOutputTool | `src/tools/TaskOutputTool/` | 获取任务输出 | |
| TaskStopTool | `src/tools/TaskStopTool/` | 停止任务 | |
| TaskUpdateTool | `src/tools/TaskUpdateTool/` | 更新任务 | |
| AskUserQuestionTool | `src/tools/AskUserQuestionTool/` | 向用户提问 | |
| EnterPlanModeTool | `src/tools/EnterPlanModeTool/` | 进入计划模式 | |
| ExitPlanModeV2Tool | `src/tools/ExitPlanModeTool/` | 退出计划模式 | |
| LSPTool | `src/tools/LSPTool/` | LSP 语言服务器 | |
| MCPTool | `src/tools/MCPTool/` | MCP 工具调用 | 动态工具也由 MCP 系统提供 |
| ListMcpResourcesTool | `src/tools/ListMcpResourcesTool/` | 列出 MCP 资源 | |
| ReadMcpResourceTool | `src/tools/ReadMcpResourceTool/` | 读取 MCP 资源 | |
| ToolSearchTool | `src/tools/ToolSearchTool/` | 工具搜索 | 延迟加载工具发现 |
| WebBrowserTool | `src/tools/WebBrowserTool/` | 浏览器自动化 | |
| NotebookEditTool | `src/tools/NotebookEditTool/` | Jupyter Notebook 编辑 | |
| PowerShellTool | `src/tools/PowerShellTool/` | PowerShell 执行 | Windows |
| TungstenTool | `src/tools/TungstenTool/` | 内部工具 | |
| WorkflowTool | `src/tools/WorkflowTool/` | 工作流执行 | |
| VerifyPlanExecutionTool | `src/tools/VerifyPlanExecutionTool/` | 计划验证 | |
| ScheduleCron 系列 | `src/tools/ScheduleCronTool/` | Cron 定时任务 (Create/Delete/List) | |
| RemoteTriggerTool | `src/tools/RemoteTriggerTool/` | 远程触发 | |
| MonitorTool | `src/tools/MonitorTool/` | 监控工具 | |
| BriefTool | `src/tools/BriefTool/` | 简要摘要 | |
| SnipTool | `src/tools/SnipTool/` | 代码片段 | |
| REPLTool | `src/tools/REPLTool/` | REPL 透明包装器 | |
| SleepTool | `src/tools/SleepTool/` | 休眠 | |
| SendUserFileTool | `src/tools/SendUserFileTool/` | 发送用户文件 | |
| PushNotificationTool | `src/tools/PushNotificationTool/` | 推送通知 | |
| SubscribePRTool | `src/tools/SubscribePRTool/` | 订阅 PR | |
| SuggestBackgroundPRTool | `src/tools/SuggestBackgroundPRTool/` | 建议后台 PR | |
| TerminalCaptureTool | `src/tools/TerminalCaptureTool/` | 终端截图 | |
| EnterWorktreeTool | `src/tools/EnterWorktreeTool/` | 进入 worktree | |
| ExitWorktreeTool | `src/tools/ExitWorktreeTool/` | 退出 worktree | |
| SendMessageTool | `src/tools/SendMessageTool/` | 发送消息（团队通信） | |
| TeamCreateTool | `src/tools/TeamCreateTool/` | 创建 Agent 团队 | |
| TeamDeleteTool | `src/tools/TeamDeleteTool/` | 删除 Agent 团队 | |
| ConfigTool | `src/tools/ConfigTool/` | 配置工具 | |
| OverflowTestTool | `src/tools/OverflowTestTool/` | 溢出测试 | 内部 |
| DiscoverSkillsTool | `src/tools/DiscoverSkillsTool/` | 发现技能 | |
| ReviewArtifactTool | `src/tools/ReviewArtifactTool/` | 审查产物 | |
| CtxInspectTool | `src/tools/CtxInspectTool/` | 上下文检查 | |
| ListPeersTool | `src/tools/ListPeersTool/` | 列出对等会话 | |
| TestingPermissionTool | `src/tools/testing/` | 测试权限工具 | 测试用 |
| SyntheticOutputTool | `src/tools/SyntheticOutputTool/` | 合成输出 | 内部 |

### 内置 Agent 系统

**核心文件**: `src/tools/AgentTool/`

#### 内置 Agent 列表 (`src/tools/AgentTool/builtInAgents.ts`)

| Agent 名 | 文件 | 功能 | Feature Gate |
|----------|------|------|-------------|
| GENERAL_PURPOSE_AGENT | `built-in/generalPurposeAgent.ts` | 通用代理，默认 | |
| STATUSLINE_SETUP_AGENT | `built-in/statuslineSetup.ts` | 状态行配置 | |
| EXPLORE_AGENT | `built-in/exploreAgent.ts` | 代码探索 | BUILTIN_EXPLORE_PLAN_AGENTS |
| PLAN_AGENT | `built-in/planAgent.ts` | 计划制定 | BUILTIN_EXPLORE_PLAN_AGENTS |
| OLA_CC_GUIDE_AGENT | `built-in/claudeCodeGuideAgent.ts` | Claude Code 指南 | |
| VERIFICATION_AGENT | `built-in/verificationAgent.ts` | 验证 | VERIFICATION_AGENT |

#### Agent 架构

- **AgentTool.tsx** — 主 Agent 工具，处理子代理创建/执行/结果
- **runAgent.ts** — 子代理执行引擎，独立的 `query()` 循环
- **loadAgentsDir.ts** — 动态加载 `~/.claude/agents/` 自定义 Agent 定义
- **forkSubagent.ts** — Fork 子代理（共享 prompt cache）
- **agentMemory.ts** — Agent 记忆管理
- **agentDisplay.ts** — Agent UI 渲染
- **agentColorManager.ts** — Agent 颜色管理

#### 协调器模式 (`src/coordinator/`)

- `coordinatorMode.ts` — 协调器模式主逻辑（多 Worker 代理调度）
- `workerAgent.ts` — Worker Agent 执行

### 如何添加新工具

1. 在 `src/tools/` 下创建目录
2. 使用 `buildTool()` 定义工具:

```typescript
// src/tools/MyTool/MyTool.ts
import { buildTool, ToolDef } from '../../Tool.js';

export const MyTool = buildTool({
  name: 'MyTool',
  description: () => '工具描述',
  inputSchema: z.object({ command: z.string() }),
  prompt: () => '工具指令...',
  async call(input, context, canUseTool, parentMessage, onProgress) {
    // 执行逻辑
    return { data: 'result' };
  },
  renderToolUseMessage(input, { theme }) { /* React 组件 */ },
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
}) as typeof MyTool;
```

3. 在 `src/tools.ts` 导入并加入 `getAllBaseTools()`:

```typescript
import { MyTool } from './tools/MyTool/MyTool.js';

export function getAllBaseTools(): Tools {
  return [
    // ...
    MyTool,
  ];
}
```

---

## 服务层

### 服务目录速查

| 服务名 | 源码路径 | 功能简述 | 文件数 |
|--------|----------|----------|--------|
| API | `src/services/api/` | Claude API 通信、重试、错误、流式 | 多文件 |
| MCP | `src/services/mcp/` | MCP 客户端、多传输协议、认证 | 多文件 |
| Compact | `src/services/compact/` | 上下文压缩策略 | 13 |
| Analytics | `src/services/analytics/` | 数据追踪、GrowthBook A/B、DataDog | 多文件 |
| SessionMemory | `src/services/SessionMemory/` | 跨会话记忆 | |
| autoDream | `src/services/autoDream/` | 自动记忆整合 | |
| LSP | `src/services/lsp/` | 语言服务器协议管理 | |
| OAuth | `src/services/oauth/` | OAuth 认证流程 | |
| MagicDocs | `src/services/MagicDocs/` | 动态文档生成 | |
| contextCollapse | `src/services/contextCollapse/` | 上下文折叠 | |
| extractMemories | `src/services/extractMemories/` | 记忆提取 | |
| SkillSearch | `src/services/skillSearch/` | 技能搜索 | |
| PromptSuggestion | `src/services/PromptSuggestion/` | 提示建议 | |
| plugins | `src/services/plugins/` | 插件管理 | |
| teamMemorySync | `src/services/teamMemorySync/` | 团队记忆同步 | |
| tips | `src/services/tips/` | 使用提示 | |
| tools | `src/services/tools/` | 工具服务 | |
| toolUseSummary | `src/services/toolUseSummary/` | 工具使用摘要 | |
| policyLimits | `src/services/policyLimits/` | 组织策略限制 | |
| remoteManagedSettings | `src/services/remoteManagedSettings/` | 远程管理设置 | |
| settingsSync | `src/services/settingsSync/` | 设置同步 | |
| notifier | `src/services/notifier.ts` | 通知系统 | |
| voice | `src/services/voice.ts` | 语音服务 | |
| AgentSummary | `src/services/AgentSummary/` | Agent 摘要 | |
| awaySummary | `src/services/awaySummary.ts` | 离开摘要 | |
| claudeAiLimits | `src/services/claudeAiLimits.ts` | Claude.ai 配额检查 | |
| mcpServerApproval | `src/services/mcpServerApproval.tsx` | MCP 服务器审批 | |

### 核心服务详解

#### API (`src/services/api/`)

- **client.ts** — API 客户端封装，流式响应
- **withRetry.ts** — 指数退避重试策略
- **errors.ts** — 错误分类与处理
- **bootstrap.ts** — 启动数据预取
- **filesApi.ts** — 文件 API (下载/上传)
- **dumpPrompts.ts** — 提示词导出
- **promptCacheBreakDetection.ts** — Prompt cache miss 检测

#### MCP (`src/services/mcp/`)

- **client.ts** — MCP 客户端，连接/断开/资源获取
- **config.ts** — 配置文件解析 (.mcp.json)
- **types.ts** — MCP 类型定义
- **officialRegistry.ts** — 官方 MCP 服务器注册表
- **elicitationHandler.ts** — MCP 授权处理
- **channelPermissions.ts** — 频道权限

#### Compact (`src/services/compact/`) — 6 种压缩策略

| 策略 | 文件 | 说明 |
|------|------|------|
| AutoCompact | `autoCompact.ts` | 自动上下文压缩 |
| MicroCompact | `microCompact.ts` | 微压缩 |
| CachedMicrocompact | `cachedMicrocompact.ts` | 缓存微压缩 |
| ReactiveCompact | `reactiveCompact.ts` | 响应式压缩 |
| SnipCompact | `snipCompact.ts` | 片段压缩 |
| SessionMemoryCompact | `sessionMemoryCompact.ts` | 记忆压缩 |

#### Analytics (`src/services/analytics/`)

- **growthbook.ts** — GrowthBook A/B 测试远程开关
- **index.js** — 事件日志
- **sink.ts** — 日志 sink 初始化
- **config.js** — 分析配置

### 服务间依赖关系

```
REPL/Agent → API client → withRetry (重试) → errors (分类)
           → MCP client → config → officialRegistry
           → Compact → contextCollapse
           → Analytics → GrowthBook
           → SkillSearch → localSearch
Policy → policyLimits → remoteManagedSettings
```

---

## 状态管理

### STATE 全局单例 (`src/bootstrap/state.ts`)

`STATE` 是一个约 **100+ 字段**的全局单例，按类别划分：

| 类别 | 关键字段 |
|------|----------|
| **会话** | `sessionId`, `parentSessionId`, `sessionProjectDir`, `startTime` |
| **成本/用量** | `totalCostUSD`, `totalAPIDuration`, `totalToolDuration`, `modelUsage`, `totalLinesAdded/Removed` |
| **模型** | `mainLoopModelOverride`, `initialMainLoopModel`, `modelStrings` |
| **Agent 颜色** | `agentColorMap`, `agentColorIndex` |
| **技能** | `invokedSkills`, `planSlugCache` |
| **慢操作** | `slowOperations` |
| **缓存** | `promptCache1hAllowlist`, `promptCache1hEligible`, `latchedGlobalCacheStrategy` |
| **Beta 头锁存** | `afkModeHeaderLatched`, `fastModeHeaderLatched`, `cacheEditingHeaderLatched`, `thinkingClearLatched` |
| **遥测** | `meter`, `sessionCounter`, `costCounter`, `tokenCounter`, `loggerProvider`, `tracerProvider` |
| **Hook** | `registeredHooks` |
| **团队** | `sessionCreatedTeams` |
| **Cron** | `scheduledTasksEnabled`, `sessionCronTasks` |
| **权限** | `sessionBypassPermissionsMode`, `allowedSettingSources` |
| **远程** | `isRemoteMode`, `directConnectServerUrl` |
| **其他** | `isInteractive`, `kairosActive`, `hasExitedPlanMode`, `clientType` |

关键 API:
- `switchSession(id, projectDir)` — 原子切换会话
- `regenerateSessionId()` — 重新生成会话 ID
- `resetCostState()` — 重置成本
- `clearBetaHeaderLatches()` — 清除 Beta 头锁存

### AppStateStore (`src/state/AppStateStore.ts`)

基于 Zustand-like `Store` 模式的 UI 状态 store，管理：

- `messages` — 消息列表
- `mcp` — MCP 连接状态 (tools, commands, resources, servers)
- `settings` — SettingsJson
- `permissionMode` — 权限模式
- `todoList` — 待办列表
- `taskState` — 任务状态
- `speculation` — 预执行状态
- `notifications` — 通知
- `fileHistoryState` — 文件历史
- `attributionState` — 提交归属

---

## 构建系统

### 构建脚本 (`scripts/build.ts`)

**构建流程**: `Bun.build()` → `--compile` → `--bytecode` → `--minify`

| 命令 | 输出 | 说明 |
|------|------|------|
| `bun run build` | `./cli` | 生产二进制 |
| `bun run build:dev` | `./cli-dev` | 开发二进制 |
| `bun run build:dev:full` | `./cli-dev` | 全特性开发构建 |
| `bun run compile` | `./dist/cli` | 编译输出 |

**Externals** (不打包的依赖):

`@ant/*`, `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/foundry-sdk`, `@anthropic-ai/vertex-sdk`, `@aws-sdk/client-bedrock`, `@azure/identity`, `@opentelemetry/*`, `audio-capture-napi`, `image-processor-napi`, `sharp`, `turndown`, `url-handler-napi`

**编译时宏定义**:

| 宏 | 值 | 说明 |
|----|---|------|
| `process.env.USER_TYPE` | `'external'` | 用户类型 |
| `MACRO.VERSION` | 包版本号 | |
| `MACRO.BUILD_TIME` | ISO 时间戳 | |
| `MACRO.FEEDBACK_CHANNEL` | `'github'` | |

### 特性门控机制（三层）

| 层级 | 机制 | 说明 |
|------|------|------|
| **编译时** | `feature('NAME')` from `bun:bundle` | 死代码消除，未启用的特性不进入二进制 |
| **运行时** | `process.env.USER_TYPE` | `'ant'` (内部) vs `'external'` (外部) |
| **远程** | GrowthBook 远程开关 | 通过 `services/analytics/growthbook.ts` 动态控制 |

### 特性开关清单

**默认启用**: `VOICE_MODE`, `BUDDY`

| 开关名 | 控制功能 | 默认 | 用户类型 |
|--------|----------|------|----------|
| `VOICE_MODE` | 语音模式 | ON | all |
| `BUDDY` | Buddy 功能 | ON | all |
| `AGENT_MEMORY_SNAPSHOT` | Agent 记忆快照 | OFF | dev |
| `AGENT_TRIGGERS` | Agent 触发器 | OFF | dev |
| `AGENT_TRIGGERS_REMOTE` | 远程 Agent 触发 | OFF | dev |
| `AWAY_SUMMARY` | 离开摘要 | OFF | dev |
| `BASH_CLASSIFIER` | Bash 命令分类 | OFF | dev |
| `BRIDGE_MODE` | 桥接远程控制 | OFF | dev |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 内置探索/计划 Agent | OFF | dev |
| `CACHED_MICROCOMPACT` | 缓存微压缩 | OFF | dev |
| `CCR_AUTO_CONNECT` | CCR 自动连接 | OFF | dev |
| `CCR_MIRROR` | CCR 镜像 | OFF | dev |
| `CCR_REMOTE_SETUP` | CCR 远程设置 | OFF | dev |
| `COMPACTION_REMINDERS` | 压缩提醒 | OFF | dev |
| `CONNECTOR_TEXT` | 连接文本 | OFF | dev |
| `EXTRACT_MEMORIES` | 记忆提取 | OFF | dev |
| `HISTORY_PICKER` | 历史选择器 | OFF | dev |
| `HOOK_PROMPTS` | Hook 提示 | OFF | dev |
| `KAIROS_BRIEF` | Kairos 简要 | OFF | dev |
| `KAIROS_CHANNELS` | Kairos 频道 | OFF | dev |
| `LODESTONE` | Lodestone | OFF | dev |
| `MCP_RICH_OUTPUT` | MCP 丰富输出 | OFF | dev |
| `MESSAGE_ACTIONS` | 消息操作 | OFF | dev |
| `NATIVE_CLIPBOARD_IMAGE` | 原生剪贴板图片 | OFF | dev |
| `NEW_INIT` | 新初始化 | OFF | dev |
| `POWERSHELL_AUTO_MODE` | PowerShell 自动模式 | OFF | dev |
| `PROMPT_CACHE_BREAK_DETECTION` | Prompt cache miss 检测 | OFF | dev |
| `QUICK_SEARCH` | 快速搜索 | OFF | dev |
| `SHOT_STATS` | 截图统计 | OFF | dev |
| `TEAMMEM` | 团队记忆 | OFF | dev |
| `TOKEN_BUDGET` | Token 预算 | OFF | dev |
| `TREE_SITTER_BASH` | Tree-sitter Bash | OFF | dev |
| `TREE_SITTER_BASH_SHADOW` | Tree-sitter Bash 影子 | OFF | dev |
| `ULTRAPLAN` | 超级计划 | OFF | dev |
| `ULTRATHINK` | 超级思考 | OFF | dev |
| `UNATTENDED_RETRY` | 无人值守重试 | OFF | dev |
| `VERIFICATION_AGENT` | 验证 Agent | OFF | dev |

**其他已知特性门控** (代码中发现但未列入构建脚本):

| 特性名 | 控制功能 |
|--------|----------|
| `ABLATION_BASELINE` | 消融实验基线 |
| `COORDINATOR_MODE` | 协调器模式 |
| `KAIROS` / `KAIROS_DREAM` | 助手模式 |
| `DAEMON` | 守护进程 |
| `BG_SESSIONS` | 后台会话 |
| `TEMPLATES` | 模板系统 |
| `BYOC_ENVIRONMENT_RUNNER` | BYOC 执行器 |
| `SELF_HOSTED_RUNNER` | 自托管执行器 |
| `DUMP_SYSTEM_PROMPT` | 导出系统提示 (ant-only) |
| `CHICAGO_MCP` | Computer Use MCP |
| `MCP_SKILLS` | MCP 技能 |
| `TRANSCRIPT_CLASSIFIER` | 转录分类器 |
| `REVIEW_ARTIFACT` | 审查产物 |
| `BUILDING_CLAUDE_APPS` | 构建 Claude 应用 |
| `RUN_SKILL_GENERATOR` | 运行技能生成器 |

---

## 通信层

### API 客户端 (`src/services/api/`)

- **流式响应** — 基于 `@anthropic-ai/sdk` 的 `BetaMessageStream`
- **重试策略** — `withRetry.ts`: 指数退避，可配置重试次数和延迟
- **错误分类** — `errors.ts`: API 错误、网络错误、认证错误、配额错误
- **Prompt Cache** — `cache_control` 类型标记，支持增量缓存
- **全局缓存策略** — `latchedGlobalCacheStrategy`: `system_prompt` 或 `none`

### Bridge 协议 (`src/bridge/`)

远程桥接协议，支持从移动/Web 客户端远程控制本地 Claude Code:

| 文件 | 说明 |
|------|------|
| `bridgeMain.ts` | Bridge 入口 |
| `bridgeMessaging.ts` | 消息传输 |
| `bridgeTransport.ts` | 传输层 |
| `replBridge.ts` | REPL 桥接 |
| `peerSessions.ts` | 对等会话 |
| `types.ts` | 类型定义 |
| `workSecret.ts` | 工作密钥 |
| `jwtUtils.ts` | JWT 工具 |
| `webhookSanitizer.ts` | Webhook 清洗 |

**命令桥接安全**:
- `REMOTE_SAFE_COMMANDS` — 远程模式下允许的命令（本地 UI 操作）
- `BRIDGE_SAFE_COMMANDS` — 桥接模式下允许的 `local` 命令
- `isBridgeSafeCommand()` — 安全检查函数

### HTTP Server

- **Chrome MCP 服务器** — 端口 12306 (`--claude-in-chrome-mcp`)
- **Bridge 服务器** — WebSocket/HTTP，支持移动/Web 连接

---

## 插件/Skill 系统

### 技能加载链

技能（Skills）是扩展 Claude Code 能力的核心机制，分为多个来源：

| 来源 | 位置 | 加载时机 |
|------|------|----------|
| **内置技能** | `src/skills/bundled/` | 启动时 `initBundledSkills()` |
| **用户技能** | `~/.claude/skills/` | `getSkillDirCommands(cwd)` |
| **用户命令** (legacy) | `~/.claude/commands/` | `getSkillDirCommands(cwd)` |
| **插件技能** | `~/.claude/plugins/` | `getPluginSkills()` |
| **MCP 技能** | MCP 服务器 | `getMcpSkillCommands()` |
| **内置插件技能** | `src/plugins/bundled/` | `getBuiltinPluginSkillCommands()` |
| **动态技能** | 文件操作发现 | `getDynamicSkills()` |
| **工作流** | 文件系统 | `getWorkflowCommands(cwd)` |

### 内置技能列表 (`src/skills/bundled/`)

| 技能名 | 文件 | 功能 |
|--------|------|------|
| `/update-config` | `updateConfig.ts` | 更新配置 |
| `/keybindings` | `keybindings.ts` | 快捷键管理 |
| `/verify` | `verify.ts` | 验证 |
| `/debug` | `debug.ts` | 调试 |
| `/lorem-ipsum` | `loremIpsum.ts` | 占位文本生成 |
| `/skillify` | `skillify.ts` | 技能化 |
| `/remember` | `remember.ts` | 记忆 |
| `/simplify` | `simplify.ts` | 简化 |
| `/batch` | `batch.ts` | 批处理 |
| `/stuck` | `stuck.ts` | 卡住处理 |
| `/dream` | `dream.ts` | 梦想模式 (KAIROS) |
| `/hunter` | `hunter.ts` | 猎人 (REVIEW_ARTIFACT) |
| `/loop` | `loop.ts` | 循环 (AGENT_TRIGGERS) |
| `/schedule-remote-agents` | `scheduleRemoteAgents.ts` | 远程 Agent 调度 |
| `/claude-api` | `claudeApi.ts` | Claude API 操作 |
| `/claude-in-chrome` | `claudeInChrome.ts` | Claude in Chrome |
| `/run-skill-generator` | `runSkillGenerator.ts` | 运行技能生成器 |

### 如何添加新技能

**方法 1: 用户目录** (无需修改源码)
在 `~/.claude/skills/my-skill.md` 创建 Markdown 文件，带 frontmatter：

```markdown
---
name: my-skill
description: 我的技能描述
---

技能指令内容...
```

**方法 2: 内置技能** (需要修改源码)

1. 在 `src/skills/bundled/` 创建文件 (如 `myskill.ts`)
2. 导出注册函数:

```typescript
// src/skills/bundled/myskill.ts
import { registerBundledSkill } from '../bundledSkills.js';

export function registerMySkill() {
  registerBundledSkill({
    name: 'my-skill',
    description: '技能描述',
    async getPromptForCommand(args, context) {
      return [{ type: 'text', text: '指令内容' }];
    },
  });
}
```

3. 在 `src/skills/bundled/index.ts` 导入并调用

### 插件系统

- **插件目录**: `~/.claude/plugins/`
- **插件清单**: `plugin.json` (PluginManifest)
- **插件命令**: `src/utils/plugins/loadPluginCommands.ts`
- **插件内置**: `src/plugins/bundled/`

---

## UI 组件系统

### Ink 框架渲染

终端 UI 使用 **Ink** (React for terminal)。

### 组件层次

```
App.tsx
  ├── Messages.tsx
  │   └── MessageRow.tsx
  │       ├── 各消息组件 (Bash, ToolUse, Skill, Agent, etc.)
  │       └── MessageSelector.tsx
  ├── PromptInput/ — 输入框
  ├── StatusLine.tsx — 状态行
  ├── DevBar.tsx — 开发工具栏 (ant-only)
  └── Dialog 系列 — 各种对话框
```

### 核心组件目录

| 目录/文件 | 路径 | 说明 |
|-----------|------|------|
| 消息组件 | `src/components/messages/` | 各类型消息渲染 |
| Agent 相关 | `src/components/agents/` | Agent 展示 |
| 设置 | `src/components/Settings/` | 设置面板 |
| PromptInput | `src/components/PromptInput/` | 用户输入 |
| Hooks | `src/hooks/` | React Hooks (85+ 文件) |
| 设计系统 | `src/components/design-system/` | 基础 UI 组件 |
| Markdown | `src/components/Markdown.tsx` | Markdown 渲染 |
| Diff | `src/components/diff/` | 代码差异 |
| Shell | `src/components/shell/` | Shell 输出 |

### 核心 React Hooks (85+ 文件，`src/hooks/`)

关键 Hooks 包括: `useCanUseTool`, `useMergedTools`, `useMessageList`, `useAppState`, `useSettings`, `useTheme`, `useScroll`, `useAutoComplete`, 等。

---

## 扩展点总结

| 扩展类型 | 位置 | 说明 |
|----------|------|------|
| **新命令** | `src/commands/` + `src/commands.ts` | 实现 Command 接口 |
| **新工具** | `src/tools/` + `src/tools.ts` | 使用 buildTool() 定义 |
| **新 Agent** | `~/.claude/agents/` (运行时) 或 `src/tools/AgentTool/built-in/` (源码) | Agent 定义 |
| **新插件** | `~/.claude/plugins/` | plugin.json 清单 |
| **新技能** | `~/.claude/skills/` (用户) 或 `src/skills/bundled/` (内置) | Markdown 或 TypeScript |
| **新 Hook** | `src/hooks/` 或 `settings.json` 中的 `hooks` 字段 | React Hook 或 系统 Hook |
| **新服务** | `src/services/` | 新服务目录 |
| **新 UI 组件** | `src/components/` | Ink/React 组件 |
| **新特性门控** | `scripts/build.ts` 中添加到 fullExperimentalFeatures | 编译时特性 |

### 关键配置文件

| 文件 | 路径 | 说明 |
|------|------|------|
| 用户设置 | `~/.claude/settings.json` | 全局配置 |
| 项目设置 | `.claude/settings.json` | 项目级配置 |
| 本地设置 | `.claude/settings.local.json` | 本地覆盖 |
| MCP 配置 | `.mcp.json` | MCP 服务器列表 |
| CLAUDE.md | `CLAUDE.md` | 项目上下文 |
| Hooks 设置 | `settings.json` 中 `hooks` 字段 | 预/后执行 Hook |

### Settings 主要配置项 (`src/utils/settings/types.ts`)

`SettingsSchema` 涵盖 50+ 配置字段，关键项：

- `model` — 默认模型
- `permissions` — 权限配置 (allow/deny/ask/defaultMode)
- `hooks` — Hook 配置 (preToolUse, postToolUse, preCompact, etc.)
- `env` — 环境变量
- `allowedMcpServers` / `deniedMcpServers` — MCP 服务器允许/拒绝列表
- `mcpServers` — MCP 服务器配置
- `cleanupPeriodDays` — 会话保留天数
- `attribution` — 提交归属
- `worktree` — Worktree 配置
- `fileSuggestion` — 文件建议配置
- `availableModels` — 可用模型列表
- `modelOverrides` — 模型覆盖映射
