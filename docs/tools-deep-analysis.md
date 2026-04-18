# 工具系统深度分析

**项目**: Claude Code 源码分析  
**分析日期**: 2026-04-12  
**状态**: 已完成  

---

## 执行摘要

### 工具统计概览

| 指标 | 数量 |
|------|------|
| 工具文件总数 | 140+ 个 (.ts) |
| 核心工具数 | 53+ 个 |
| 工具子目录数 | 28+ 个 |
| 内置 Agent 数 | 6-8 个 |

### 工具分类

| 类别 | 工具数 | 占比 |
|------|--------|------|
| 文件操作 | 5 | 9% |
| Bash/Shell | 2 | 4% |
| Agent 系统 | 18+ | 34% |
| MCP 集成 | 4 | 8% |
| 任务管理 | 7 | 13% |
| 用户交互 | 5 | 9% |
| Web 功能 | 4 | 8% |
| 其他工具 | 8 | 15% |

---

## 1. 工具系统架构

### 1.1 工具目录结构

```
src/tools/
├── AgentTool/                    # Agent 工具系统
│   ├── agentColorManager.ts      # Agent 颜色管理
│   ├── agentDisplay.ts           # Agent 显示逻辑
│   ├── agentMemory.ts            # Agent 记忆
│   ├── agentMemorySnapshot.ts    # 记忆快照
│   ├── agentToolUtils.ts         # 工具函数
│   ├── built-in/                 # 内置 Agent
│   │   ├── claudeCodeGuideAgent.ts
│   │   ├── exploreAgent.ts
│   │   ├── generalPurposeAgent.ts
│   │   ├── planAgent.ts
│   │   ├── statuslineSetup.ts
│   │   └── verificationAgent.ts
│   ├── builtInAgents.ts          # 内置 Agent 注册
│   ├── constants.ts              # 常量定义
│   ├── forkSubagent.ts           # 子代理分叉
│   ├── loadAgentsDir.ts          # 动态加载 Agent
│   ├── prompt.ts                 # 提示词
│   ├── resumeAgent.ts            # 恢复 Agent
│   └── runAgent.ts               # 运行 Agent
│
├── BashTool/                     # Bash 执行工具 (14 文件)
│   ├── bashCommandHelpers.ts
│   ├── bashPermissions.ts
│   ├── bashSecurity.ts
│   ├── commandSemantics.ts
│   ├── destructiveCommandWarning.ts
│   ├── modeValidation.ts
│   ├── pathValidation.ts
│   ├── prompt.ts
│   ├── readOnlyValidation.ts
│   ├── sedEditParser.ts
│   ├── sedValidation.ts
│   ├── shouldUseSandbox.ts
│   ├── toolName.ts
│   └── utils.ts
│
├── PowerShellTool/               # PowerShell 工具 (13 文件)
│   ├── clmTypes.ts
│   ├── commandSemantics.ts
│   ├── destructiveCommandWarning.ts
│   ├── gitSafety.ts
│   ├── modeValidation.ts
│   ├── pathValidation.ts
│   ├── powershellPermissions.ts
│   ├── powershellSecurity.ts
│   ├── prompt.ts
│   ├── readOnlyValidation.ts
│   ├── toolName.ts
│   └── ...
│
├── FileEditTool/                 # 文件编辑工具 (5 文件)
├── FileReadTool/                 # 文件读取工具 (4 文件)
├── FileWriteTool/                # 文件写入工具 (2 文件)
├── GlobTool/                     # 文件搜索工具 (2 文件)
├── GrepTool/                     # 内容搜索工具 (2 文件)
│
├── MCPTool/                      # MCP 工具集成 (4 文件)
├── ListMcpResourcesTool/         # MCP 资源列表 (2 文件)
├── ReadMcpResourceTool/          # MCP 资源读取 (2 文件)
├── McpAuthTool/                  # MCP 认证工具
│
├── TaskCreateTool/               # 任务创建
├── TaskUpdateTool/               # 任务更新
├── TaskGetTool/                  # 任务获取
├── TaskListTool/                 # 任务列表
├── TaskStopTool/                 # 任务停止
│
├── SendMessageTool/              # 发送消息
├── AskUserQuestionTool/          # 提问工具
├── SleepTool/                    # 睡眠工具
│
├── LSPTool/                      # 语言服务器工具 (5 文件)
├── ConfigTool/                   # 配置工具 (4 文件)
├── BriefTool/                    # 简报工具 (4 文件)
│
├── NotebookEditTool/             # Jupyter 编辑 (3 文件)
├── REPLTool/                     # REPL 工具 (3 文件)
├── WorkflowTool/                 # 工作流工具 (3 文件)
│
├── ScheduleCronTool/             # Cron 定时任务 (4 文件)
├── MonitorTool/                  # 监控工具
├── OverflowTestTool/             # 溢出测试工具
│
├── RemoteTriggerTool/            # 远程触发 (2 文件)
├── PushNotificationTool/         # 推送通知
│
├── EnterPlanModeTool/            # 进入计划模式 (3 文件)
├── ExitPlanModeTool/             # 退出计划模式 (3 文件)
├── EnterWorktreeTool/            # 进入工作树 (3 文件)
├── ExitWorktreeTool/             # 退出工作树 (3 文件)
│
├── ReviewArtifactTool/           # 审查产物
├── TodoWriteTool/                # TODO 列表
├── SnipTool/                     # 历史截断
│
├── WebFetchTool/                 # Web 抓取 (4 文件)
├── WebSearchTool/                # Web 搜索 (2 文件)
│
├── SubscribePRTool/              # GitHub PR 订阅
├── SuggestBackgroundPRTool/      # 建议后台 PR
│
├── TeamCreateTool/               # 团队创建
├── TeamDeleteTool/               # 团队删除
│
├── ToolSearchTool/               # 工具搜索 (3 文件)
├── DiscoverSkillsTool/           # 发现技能
├── SkillTool/                    # 技能工具 (3 文件)
│
├── TungstenTool/                 # Tungsten 工具
├── SyntheticOutputTool/          # 合成输出
│
└── shared/                       # 共享工具逻辑
    ├── gitOperationTracking.ts
    └── spawnMultiAgent.ts
```

---

## 2. 核心工具详细分析

### 2.1 BashTool (Bash 执行工具)

**文件数**: 14 个  
**复杂度**: 高  
**安全性**: 严格验证

#### 核心功能
| 模块 | 功能 |
|------|------|
| `bashCommandHelpers.ts` | 命令执行辅助函数 |
| `bashPermissions.ts` | 权限验证和批准 |
| `bashSecurity.ts` | 安全检查（命令注入防护） |
| `commandSemantics.ts` | 命令语义分析 |
| `destructiveCommandWarning.ts` | 破坏性命令警告 |
| `modeValidation.ts` | 模式验证（只读/读写） |
| `pathValidation.ts` | 路径验证（越狱防护） |
| `readOnlyValidation.ts` | 只读模式验证 |
| `sedEditParser.ts` | sed 命令解析 |
| `sedValidation.ts` | sed 命令安全验证 |
| `shouldUseSandbox.ts` | 沙箱使用判断 |
| `toolName.ts` | 工具名称定义 |

#### 安全机制
```
用户命令 → 路径验证 → 权限检查 → 破坏性检测 → 沙箱决策 → 执行
              ↓           ↓            ↓           ↓
          越狱防护   用户批准     警告提示    隔离执行
```

#### Feature Gates
- `BASH_CLASSIFIER` - Bash 命令分类器
- `MONITOR_TOOL` - 监控工具模式

---

### 2.2 AgentTool (Agent 工具系统)

**文件数**: 18+ 个  
**复杂度**: 非常高  
**扩展性**: 支持动态加载

#### 内置 Agent

| Agent | 功能 | Feature Gate |
|-------|------|--------------|
| `GENERAL_PURPOSE_AGENT` | 通用目的 Agent | - |
| `STATUSLINE_SETUP_AGENT` | 状态行设置 | - |
| `EXPLORE_AGENT` | 探索 Agent | `BUILTIN_EXPLORE_PLAN_AGENTS` |
| `PLAN_AGENT` | 规划 Agent | `BUILTIN_EXPLORE_PLAN_AGENTS` |
| `CLAUDE_CODE_GUIDE_AGENT` | Claude Code 指南 | - |
| `VERIFICATION_AGENT` | 验证 Agent | `VERIFICATION_AGENT` |

#### 核心模块
| 模块 | 功能 |
|------|------|
| `runAgent.ts` | Agent 执行引擎 |
| `agentMemory.ts` | Agent 记忆管理 |
| `agentMemorySnapshot.ts` | 记忆快照 |
| `agentDisplay.ts` | UI 显示逻辑 |
| `agentColorManager.ts` | Agent 颜色管理 |
| `forkSubagent.ts` | 子代理分叉 |
| `loadAgentsDir.ts` | 动态 Agent 加载 |
| `resumeAgent.ts` | Agent 恢复 |

#### Agent 显示机制
```
Agent 启动 → 创建会话 → 分配颜色 → 进度展示 → 结果返回
              ↓                      ↓
         独立进程                实时更新
```

#### 协调器模式集成
```typescript
// 当 COORDINATOR_MODE 启用时
if (feature('COORDINATOR_MODE')) {
  return getCoordinatorAgents() // 使用协调器 Agent
}
```

---

### 2.3 文件操作工具组

#### FileReadTool (文件读取)
**文件数**: 4 个

| 模块 | 功能 |
|------|------|
| `FileReadTool.ts` | 核心读取逻辑 |
| `imageProcessor.ts` | 图像处理（支持 PNG/JPG/PDF） |
| `limits.ts` | 读取限制（行数/大小） |
| `prompt.ts` | 工具提示词 |

**支持格式**:
- 文本文件（.ts/.tsx/.js/.md 等）
- 图片文件（.png/.jpg）- 视觉模型处理
- PDF 文件 - 分页读取（最大 20 页/次）
- Jupyter Notebook（.ipynb）- 单元格解析

#### FileEditTool (文件编辑)
**文件数**: 5 个

| 模块 | 功能 |
|------|------|
| `FileEditTool.ts` | 核心编辑逻辑（字符串替换） |
| `constants.ts` | 常量定义 |
| `prompt.ts` | 工具提示词 |
| `types.ts` | 类型定义 |
| `utils.ts` | 辅助函数 |

**编辑模式**:
- 精确字符串替换（旧→新）
- 支持 `replace_all` 参数
- 保持缩进格式

#### FileWriteTool (文件写入)
**文件数**: 2 个

| 模块 | 功能 |
|------|------|
| `FileWriteTool.ts` | 核心写入逻辑 |
| `prompt.ts` | 工具提示词 |

**特性**:
- 覆盖写入（非追加）
- 自动创建目录
- 敏感文件检测（.env 等）

---

### 2.4 搜索工具组

#### GlobTool (文件搜索)
**文件数**: 2 个

| 功能 | 说明 |
|------|------|
| 模式匹配 | 支持 glob 模式（**/*.ts） |
| 路径过滤 | 支持 path 参数限定搜索范围 |
| 结果排序 | 按修改时间倒序 |

#### GrepTool (内容搜索)
**文件数**: 2 个

| 功能 | 说明 |
|------|------|
| 正则搜索 | 完整 regex 语法 |
| 文件类型过滤 | --type 参数（js/py/rust 等） |
| 上下文显示 | -A/-B/-C 参数显示上下文 |
| 输出模式 | content/files_with_matches/count |

---

### 2.5 任务管理工具组

| 工具 | 功能 | 文件数 |
|------|------|--------|
| `TaskCreateTool` | 创建新任务 | 3 |
| `TaskUpdateTool` | 更新任务状态 | 3 |
| `TaskGetTool` | 获取任务详情 | 3 |
| `TaskListTool` | 列出任务清单 | 3 |
| `TaskStopTool` | 停止任务执行 | 2 |
| `TaskOutputTool` | 获取任务输出 | 3 |

**任务状态机**:
```
pending → in_progress → completed
                  ↓
               stopped (可手动停止)
```

**持久化**: 任务状态写入 `~/.claude/tasks/` 目录

---

### 2.6 MCP 集成工具组

#### MCPTool (MCP 工具调用)
**文件数**: 4 个

| 模块 | 功能 |
|------|------|
| `MCPTool.ts` | MCP 工具执行引擎 |
| `prompt.ts` | 工具提示词 |
| `classifyForCollapse.ts` | 输出分类（用于压缩） |

**支持的 MCP 传输**:
- `StdioTransport` - 标准输入输出
- `SSETransport` - Server-Sent Events
- `StreamableHTTP` - HTTP 流
- `WebSocketTransport` - WebSocket

#### ListMcpResourcesTool / ReadMcpResourceTool
| 工具 | 功能 |
|------|------|
| `ListMcpResourcesTool` | 列出 MCP 服务器资源 |
| `ReadMcpResourceTool` | 读取 MCP 资源内容 |

---

### 2.7 Web 工具组

#### WebSearchTool (Web 搜索)
**文件数**: 2 个

| 功能 | 说明 |
|------|------|
| 搜索引擎 | 使用默认搜索引擎（可配置） |
| 结果过滤 | 按相关性排序 |
| 数量限制 | 默认返回 top 10 结果 |

#### WebFetchTool (Web 抓取)
**文件数**: 4 个

| 模块 | 功能 |
|------|------|
| `WebFetchTool.ts` | 核心抓取逻辑 |
| `prompt.ts` | 工具提示词 |
| `preapproved.ts` | 预批准 URL 列表 |
| `utils.ts` | 辅助函数 |

**安全机制**:
- URL 白名单验证
- 内网访问限制
- 内容类型验证

---

### 2.8 GitHub 集成工具

#### SubscribePRTool (PR 订阅)
**功能**: 订阅 GitHub PR 通知
**Feature Gate**: `KAIROS_GITHUB_WEBHOOKS`

#### SuggestBackgroundPRTool (建议后台 PR)
**功能**: 在后台运行 PR 任务

---

### 2.9 计划模式工具组

| 工具 | 功能 |
|------|------|
| `EnterPlanModeTool` | 进入计划模式（只读分析） |
| `ExitPlanModeTool` | 退出计划模式（返回执行模式） |

**计划模式特性**:
- 只读文件访问
- 无破坏性操作
- 适合代码审查和规划

---

### 2.10 工作树工具组

| 工具 | 功能 |
|------|------|
| `EnterWorktreeTool` | 进入 Git 工作树 |
| `ExitWorktreeTool` | 退出工作树 |

**用途**: 多分支并行开发

---

## 3. 工具发现机制

### 3.1 工具注册流程

```
工具定义 → 工具注册 → 提示词生成 → 模型暴露
    ↓          ↓           ↓           ↓
Tool 类   tools 数组   system prompt  可用工具列表
```

### 3.2 动态工具加载

```typescript
// 示例：动态 Agent 加载
const agents = await loadAgentsFromDir(agentDir)
tools.push(...agents.map(agent => createAgentTool(agent)))
```

---

## 4. 工具安全模型

### 4.1 权限层级

| 级别 | 说明 | 示例 |
|------|------|------|
| 只读 | 无需批准 | Read/Glob/Grep |
| 低风险 | 自动批准 | 小文件写入 |
| 中风险 | 用户批准 | Bash 命令 |
| 高风险 | 明确警告 | 破坏性命令 |
| 禁止 | 始终拒绝 | 越狱路径访问 |

### 4.2 安全检查点

```
工具调用
    ↓
1. 路径验证 (pathValidation) ← 越狱检测
    ↓
2. 权限检查 (Permissions) ← 只读/读写模式
    ↓
3. 破坏性检测 (DestructiveCommandWarning) ← rm -rf 等
    ↓
4. 沙箱决策 (shouldUseSandbox) ← 隔离执行
    ↓
5. 用户批准 ← 交互式确认
    ↓
6. 执行
```

---

## 5. 工具并发模型

### 5.1 并行执行

工具支持并行调用，由模型决定：
```
当多个独立信息请求时，并行执行多个工具调用以获得最佳性能
```

### 5.2 后台执行

```typescript
// BashTool 支持 run_in_background 参数
{
  command: "npm build",
  run_in_background: true  // 后台执行，完成后通知
}
```

---

## 6. Feature-Gated 工具

| 工具 | Feature Gate | 外部可用 |
|------|--------------|----------|
| `TungstenTool` | TUNGSTEN | ❌ |
| `MonitorTool` | MONITOR_TOOL | ❌ |
| `WorkflowTool` | WORKFLOW_SCRIPTS | ❌ |
| `SuggestBackgroundPRTool` | KAIROS_GITHUB_WEBHOOKS | ❌ |
| `SubscribePRTool` | KAIROS_GITHUB_WEBHOOKS | ❌ |
| `VerificationAgent` | VERIFICATION_AGENT | ❌ |

---

## 7. 工具使用统计（估计）

| 工具 | 使用频率 | 说明 |
|------|----------|------|
| Bash | 极高 | 最常用工具 |
| FileRead | 极高 | 代码读取 |
| FileEdit | 高 | 代码修改 |
| Glob | 高 | 文件查找 |
| Grep | 高 | 内容搜索 |
| Agent | 中 | 委派任务 |
| Task* | 中 | 任务管理 |
| MCP* | 低 | MCP 集成 |

---

## 8. 工具扩展性

### 8.1 自定义 Agent

通过 `loadAgentsDir.ts` 从 `~/.claude/agents/` 目录动态加载

### 8.2 MCP 服务器

支持任意符合 MCP 协议的服务器:
- 本地 stdio 服务器
- 远程 SSE/HTTP 服务器
- WebSocket 服务器

---

## 9. 改进建议

### 短期 (P0)
- [ ] 补充 MonitorTool 详细分析
- [ ] 补充 WorkflowTool 详细分析
- [ ] 补充 TungstenTool 详细分析

### 中期 (P1)
- [ ] 工具调用链路追踪
- [ ] 工具性能基准测试
- [ ] 工具错误处理分析

### 长期 (P2)
- [ ] 工具使用最佳实践文档
- [ ] 自定义工具开发指南
- [ ] 工具测试框架

---

## 附录：工具清单速查

### 文件操作 (5)
- FileRead / FileEdit / FileWrite / Glob / Grep

### 命令行执行 (2)
- Bash / PowerShell

### Agent 系统 (18+)
- Agent (主工具) / 6 个内置 Agent / fork / resume / loadAgentsDir

### MCP 集成 (4)
- MCPTool / ListMcpResourcesTool / ReadMcpResourceTool / McpAuthTool

### 任务管理 (7)
- TaskCreate / TaskUpdate / TaskGet / TaskList / TaskStop / TaskOutput / TaskSummary

### 用户交互 (5)
- AskUserQuestion / SendMessage / Sleep / PushNotification / SendUserFile

### Web 功能 (4)
- WebSearch / WebFetch / SubscribePR / SuggestBackgroundPR

### 开发工具 (10+)
- LSP / Config / NotebookEdit / REPL / Workflow / ScheduleCron / Monitor
- EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree

### 其他 (10+)
- TodoWrite / Snip / ReviewArtifact / Tungsten / SyntheticOutput
- TeamCreate / TeamDelete / ToolSearch / DiscoverSkills / SkillTool / OverflowTest

---

*文档版本：1.0 | 最后更新：2026-04-12*
