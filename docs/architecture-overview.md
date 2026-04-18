# 项目架构总览

> 最后更新：2026-04-18

## 项目概述

Claude Code CLI — 基于 Bun 构建的终端 AI 助手，使用 Ink (React) 渲染终端 UI，通过 API 与 Claude 模型通信，提供丰富的工具系统和插件生态。

---

## 入口与启动流程

```
cli.tsx (快速路由)
  ├── --version / --help → 立即退出
  ├── --daemon-worker → 守护进程工作模式
  ├── --bridge → 桥接模式
  ├── --daemon → 守护进程模式
  └── 默认 → main.tsx (完整 CLI)

main.tsx
  ├── Commander.js 选项解析
  ├── GrowthBook A/B 测试初始化
  ├── 命令注册 (commands.ts, 75+)
  ├── 工具注册 (tools.ts, 35+ 基础工具 + MCP 工具)
  ├── 服务初始化
  └── Ink 渲染启动
```

### 关键文件

| 文件 | 角色 |
|------|------|
| `src/entrypoints/cli.tsx` | 主入口，快速路由 |
| `src/main.tsx` | 完整 CLI (804KB)，选项解析、初始化 |
| `src/dev-entry.ts` | 开发入口点 |

---

## 架构分层

```
┌─────────────────────────────────────────────────────┐
│  CLI 入口层 (cli.tsx → main.tsx)                    │
├─────────────────────────────────────────────────────┤
│  命令层 (commands.ts, 75+ 命令 + 技能 + 插件)       │
│  工具层 (tools.ts, 53+ 工具 + MCP 动态工具)         │
├─────────────────────────────────────────────────────┤
│  服务层 (src/services/, 22 服务, 150+ 文件)         │
│  ├── API 通信 (api/, 15+ 文件)                      │
│  ├── MCP 集成 (mcp/, 20+ 文件)                      │
│  ├── 上下文压缩 (compact/, 15+ 文件)                │
│  ├── 数据分析 (analytics/, 10+ 文件)                │
│  ├── 会话管理 (SessionMemory, autoDream)            │
│  ├── LSP (lsp/, 8 文件)                             │
│  └── OAuth 认证 (oauth/, 4 文件)                    │
├─────────────────────────────────────────────────────┤
│  UI 层 (src/components/, 250+ React 组件)           │
│  ├── messages/ (40+ 消息展示组件)                   │
│  ├── agents/ (20+ Agent 相关组件)                   │
│  ├── settings/ (10+ 设置组件)                       │
│  └── ...                                            │
├─────────────────────────────────────────────────────┤
│  Hooks 层 (src/hooks/, 93+ Hooks)                   │
│  ├── notifs/ (18+ 通知 Hooks)                       │
│  ├── 状态管理 (useSettings, useAppState)            │
│  ├── 工具/命令 (useMergedTools, useMergedCommands)  │
│  └── ...                                            │
├─────────────────────────────────────────────────────┤
│  状态层 (STATE singleton, AppStateStore)            │
│  ├── bootstrap/state.ts (60+ 字段全局状态)          │
│  └── state/AppStateStore.ts (Zustand-like UI 状态)  │
├─────────────────────────────────────────────────────┤
│  工具层 (src/tools/, 59 目录, 53+ 核心工具)         │
│  ├── AgentTool + 6 内置 Agent                       │
│  ├── BashTool / PowerShellTool                      │
│  ├── FileRead/Edit/Write                            │
│  ├── Glob / Grep                                    │
│  ├── Task* (Create/Update/Get/List/Stop)            │
│  ├── MCP / LSP / Config / Brief                     │
│  └── WebFetch / WebSearch                           │
├─────────────────────────────────────────────────────┤
│  通信层 (API Client, HTTP Server, Bridge)           │
│  ├── services/api/client.ts (API 客户端)            │
│  ├── 内置 HTTP Server (Chrome MCP, 端口 12306)      │
│  └── bridge/ (v1/v2 远程桥接)                       │
└─────────────────────────────────────────────────────┘
```

---

## 构建系统

### 构建流程

```
scripts/build.ts
  ├── Bun.build() + --compile --target bun --bytecode --minify
  ├── 50+ 特性开关 (feature())
  ├── 入口: src/entrypoints/cli.tsx
  └── 输出: ./cli (生产) / ./cli-dev (开发)
```

### 三层特性门控

| 层级 | 机制 | 示例 |
|------|------|------|
| 编译时 | `feature('NAME')` → 死代码消除 | `BUDDY`, `KAIROS`, `VOICE_MODE` |
| 运行时 | `process.env.USER_TYPE` | `'ant'` vs `'external'` |
| 远程 | GrowthBook 远程开关 | `tengu_kairos`, `tengu_session_memory` |

### 构建命令

```bash
bun run dev              # 开发模式
bun run build            # 生产构建 → ./cli
bun run build:dev        # 开发构建 → ./cli-dev
bun run compile          # 编译构建 → ./dist/cli
bun run ./scripts/build-publish.ts  # npm 发布构建
```

---

## 状态管理

### STATE 全局单例

`src/bootstrap/state.ts` — 1785 行，60+ 字段：

- 会话管理
- 成本追踪
- 模型使用
- Agent 颜色
- 已调用技能
- 慢速操作追踪

### AppStateStore

`src/state/AppStateStore.ts` — React UI 状态的 Zustand-like store，配合 Ink 组件使用。

---

## 插件/技能系统

### 技能来源

| 来源 | 位置 |
|------|------|
| 内置技能 | `src/skills/bundled/` |
| 插件技能 | `~/.claude/plugins/` |
| 技能目录 | `~/.claude/skills/` |
| MCP 技能 | MCP 服务器提供 |
| 工作流 | 工作流脚本 |

技能通过 `getSkillToolCommands()` 集成到命令系统，以 `/<skill-name>` 形式暴露。

---

## Agent/子代理系统

### AgentTool

`src/tools/AgentTool/` — 内置 Agent + 动态加载：

| Agent | 功能 |
|-------|------|
| `GENERAL_PURPOSE_AGENT` | 通用目的 |
| `STATUSLINE_SETUP_AGENT` | 状态行设置 |
| `EXPLORE_AGENT` | 代码库探索 |
| `PLAN_AGENT` | 规划 |
| `CLAUDE_CODE_GUIDE_AGENT` | Claude Code 指南 |
| `VERIFICATION_AGENT` | 验证（ant-only A/B） |

### 协调器模式

`src/coordinator/` — 多代理编排，协调器 + 工作者模式。

---

## 通信层

### API 客户端

`src/services/api/client.ts` — 重试、错误处理、流式响应。

### HTTP Server

- Chrome MCP 融合服务器（端口 12306）
- 桥接模式服务器
- 守护进程工作器通信

### Bridge 远程桥接

`src/bridge/` — v1/v2 传输协议，支持 claude.ai 远程控制本地 CLI。

---

## 文档索引

### 架构文档

| 文档 | 内容 |
|------|------|
| [services-deep-analysis.md](services-deep-analysis.md) | 服务层 22 服务、150+ 文件详细分析 |
| [hooks-deep-analysis.md](hooks-deep-analysis.md) | Hooks 93+ 文件、3 子目录详细分析 |
| [tools-deep-analysis.md](tools-deep-analysis.md) | 工具系统 53+ 工具、59 目录详细分析 |
| [ui-components-deep-analysis.md](ui-components-deep-analysis.md) | UI 250+ 组件、20+ 子目录详细分析 |

### 功能文档

| 文档 | 内容 |
|------|------|
| [01-buddy.md](01-buddy.md) | BUDDY 宠物伴侣系统 |
| [02-kairos.md](02-kairos.md) | KAIROS 持久助手 |
| [03-ultraplan.md](03-ultraplan.md) | ULTRAPLAN 云端规划 |
| [04-coordinator.md](04-coordinator.md) | 协调器多代理编排 |
| [05-hidden-commands.md](05-hidden-commands.md) | 隐藏命令与秘密开关 |
| [06-bridge.md](06-bridge.md) | BRIDGE 远程控制 |
| [07-feature-gates.md](07-feature-gates.md) | 三层特性门控 |
| [08-chrome-mcp.md](08-chrome-mcp.md) | Chrome MCP 浏览器自动化 |

### 分析文档

| 文档 | 内容 |
|------|------|
| [technical-design-code-analysis.md](technical-design-code-analysis.md) | 架构设计分析框架 |
| [requirements-code-analysis.md](requirements-code-analysis.md) | 需求分析 |
| [functionality-completeness-report.md](functionality-completeness-report.md) | 功能完成度评分 |
| [stakeholder-analysis-code-analysis.md](stakeholder-analysis-code-analysis.md) | 利益相关方分析 |
| [risk-assessment-code-analysis.md](risk-assessment-code-analysis.md) | 风险评估 |

### 其他文档

| 文档 | 内容 |
|------|------|
| [voice-mode-deep-analysis.md](voice-mode-deep-analysis.md) | 语音模式详细分析 |
| [security-deep-analysis.md](security-deep-analysis.md) | 安全详细分析 |
| [lsp-architecture-optimization.md](lsp-architecture-optimization.md) | LSP 架构优化 |
| [streaming-text-optimization.md](streaming-text-optimization.md) | 流式文本优化 |
| [tool-usage-guide.md](tool-usage-guide.md) | 工具使用指南 |
| [cache-bug-fixes.md](cache-bug-fixes.md) | 缓存 Bug 修复 |
| [node22-stdin-analysis.md](node22-stdin-analysis.md) | Node.js 22 stdin 分析 |
| [开发任务.md](开发任务.md) | 开发任务分解 |
| [superpowers/](superpowers/) | OAuth 端点可配置规范与计划 |
