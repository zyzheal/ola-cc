# Grok + CodeGraph 双引擎互补集成设计

> 设计日期：2026-05-28
> 状态：待实施

---

## 一、设计目标

1. **双引擎互补** — CodeGraph 负责实时精确查询，Grok（Understand-Anything）负责离线全局理解
2. **Tool + Skill 双形态** — 两者都支持模型自动调用（Tool）和用户交互式使用（Skill）
3. **零侵入** — 不修改 Understand-Anything 源代码，通过适配层集成
4. **渐进增强** — Phase 1 浏览器 Dashboard，Phase 2 终端 Ink 集成

---

## 二、架构总览

```
┌─────────────────────────────────────────────────────┐
│  用户层：Skill 命令 + 自然语言                        │
│  /gc /gd /grok ... | /codegraph /cg ...             │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  意图路由层（新增）                                    │
│  • 精确查询 → CodeGraph（实时）                       │
│  • 全局理解 → Grok（离线图谱）                        │
│  • 自然语言 → 模型自动选择                             │
└──────────┬───────────────────────┬──────────────────┘
           │                       │
┌──────────▼──────────┐ ┌─────────▼──────────────────┐
│ CodegraphTool       │ │ GrokTool                    │
│ (改造: Tool+Skill)  │ │ (新增: Tool+Skill)          │
│                     │ │                             │
│ Tool: 10 操作       │ │ Tool: 8 操作                │
│ Skill: /cg + 子命令 │ │ Skill: /grok + 子命令       │
└──────────┬──────────┘ └─────────┬──────────────────┘
           │                       │
┌──────────▼──────────┐ ┌─────────▼──────────────────┐
│ codegraph CLI       │ │ GrokManager                 │
│ (现有，不变)         │ │ • 源码克隆适配层             │
│                     │ │ • Agent 流水线编排            │
│                     │ │ • 复用 ola-cc LLM client     │
└─────────────────────┘ └─────────┬──────────────────┘
                                  │
                       ┌──────────▼──────────┐
                       │ knowledge-graph.json │
                       │ • 项目目录 (默认)     │
                       │ • 用户目录 (可配置)   │
                       └──────────┬──────────┘
                                  │
                       ┌──────────▼──────────┐
                       │ Dashboard            │
                       │ Phase 1: 浏览器 D3   │
                       │ Phase 2: 终端 Ink    │
                       └─────────────────────┘
```

---

## 三、功能互补矩阵

| 能力维度 | CodeGraph | Grok | 互补关系 |
|---------|-----------|------|---------|
| 符号搜索 | ✓ 实时 | — | CodeGraph 主导 |
| 调用链追踪 | ✓ callers/callees | — | CodeGraph 主导 |
| 影响分析 | ✓ impact | ✓ diff 影响 | 互补 |
| 业务域理解 | ✗ | ✓ domain-analyzer | Grok 独占 |
| 架构层可视化 | ✗ | ✓ Dashboard | Grok 独占 |
| 引导式学习 | ✗ | ✓ tour-builder | Grok 独占 |
| LLM 语义摘要 | ✗ | ✓ file-analyzer | Grok 独占 |
| 响应速度 | ✓ 秒级 | △ 分钟级（首次） | CodeGraph 更快 |
| LLM 成本 | ✓ 零成本 | ✗ 需要 LLM | CodeGraph 更省 |

---

## 四、CodeGraph 改造（Tool + Skill 双形态）

### 4.1 现有 Tool 不变

`src/tools/CodegraphTool/CodegraphTool.ts` 的 10 个操作保持不变。

### 4.2 新增 Skill 层

| Skill | 功能 | 映射 Tool 操作 |
|-------|------|---------------|
| `/cg` | 自然语言查询（智能路由） | 模型选择操作 |
| `/cg s <query>` | 符号搜索 | `codegraph_search` |
| `/cg i <symbol>` | 影响分析 | `codegraph_impact` |
| `/cg tr <from> <to>` | 路径追踪 | `codegraph_trace` |
| `/cg c <symbol>` | 调用者 | `codegraph_callers` |
| `/cg e <symbol>` | 被调用 | `codegraph_callees` |
| `/cg init` | 初始化 | `codegraph_init` |
| `/cg st` | 状态 | `codegraph_status` |

### 4.3 Skill 实现方式

Skill 不直接执行 CLI，而是构造 Tool 调用参数，通过 ola-cc 的 Tool 系统执行。Skill 层负责：
- 参数解析（子命令 → Tool 操作映射）
- 结果格式化（JSON → 终端友好格式）
- 交互确认（自然语言查询时展示选择）

---

## 五、Grok 集成（新增 Tool + Skill）

### 5.1 Tool 操作

| 操作 | 用途 | 输入参数 |
|------|------|---------|
| `grok_generate` | 生成知识图谱 | `path?`, `language?`, `scope?` |
| `grok_chat` | 自然语言问答 | `question` |
| `grok_explain` | 解释文件/函数 | `target` |
| `grok_domain` | 业务域分析 | `path?` |
| `grok_tour` | 引导式学习 | `topic?` |
| `grok_diff` | 变更影响分析 | `files?` |
| `grok_status` | 图谱状态 | — |
| `grok_dashboard` | 启动浏览器 Dashboard | `port?` |

### 5.2 Skill 命令

| Skill | 功能 | 说明 |
|-------|------|------|
| `/grok` | 生成图谱 | 交互式进度显示，可选 `--language zh` |
| `/gc <question>` | 自然语言问答 | 终端内联输出 |
| `/gd` | 打开浏览器 Dashboard | 自动启动 HTTP 服务 |
| `/ge <file>` | 深入解释 | 终端内联输出 |
| `/gt` | 引导式学习路径 | 终端内联输出 |
| `/gdiff` | 变更影响分析 | 终端内联输出 |
| `/go` | 新人入职指南 | 终端内联输出 |
| `/gdomain` | 业务域分析 | 终端内联输出 |

### 5.3 Skill 别名

| 完整名 | 缩写 |
|--------|------|
| `/grok-chat` | `/gc` |
| `/grok-dashboard` | `/gd` |
| `/grok-explain` | `/ge` |
| `/grok-tour` | `/gt` |
| `/grok-diff` | `/gdiff` |
| `/grok-onboard` | `/go` |
| `/grok-domain` | `/gdomain` |

---

## 六、GrokManager 适配层

### 6.1 职责

```
src/tools/GrokTool/GrokManager.ts
├── ensureGrokSource()     — 克隆/更新源码到 ~/.ola-cc/vendor/grok/
├── loadAgentPrompts()     — 加载 5 个 Agent 的 prompt 模板
├── loadTreeSitterConfig() — 加载语言解析配置
├── runAgentPipeline()     — 编排 Agent 流水线（复用 ola-cc AgentTool）
├── queryGraph()           — 查询已生成的 knowledge-graph.json
├── startDashboard()       — 启动 HTTP 服务 + openBrowser()
└── getGraphStatus()       — 检查图谱状态
```

### 6.2 关键设计决策

**Agent 流水线复用 ola-cc 的 AgentTool 子代理系统**，不引入独立的 Agent 运行时。

原版 Understand-Anything 的 5 个 Agent：
1. `project-scanner` — 发现文件、检测语言/框架
2. `file-analyzer` — Tree-sitter 解析 + LLM 语义分析（并行，20-30 文件/批）
3. `architecture-analyzer` — 识别架构层
4. `tour-builder` — 生成引导式学习路径
5. `graph-reviewer` — 验证图谱完整性

这些 Agent 的 prompt 模板从源码中提取，通过 ola-cc 的 `AgentTool` 执行。

### 6.3 源码管理

- 克隆地址：`~/.ola-cc/vendor/grok/`
- 首次使用自动克隆
- 支持 `--update` 手动更新
- 版本锁定到特定 commit

---

## 七、存储策略

### 7.1 图谱数据

- **默认**：`.understand-anything/knowledge-graph.json`（项目目录，可 git 共享）
- **可配置**：环境变量 `OLA_CC_GROK_STORAGE=user` → `~/.ola-cc/grok-graphs/<project-hash>/`
- **共享**：commit `.understand-anything/`（排除 `intermediate/` 和 `diff-overlay.json`）

### 7.2 Dashboard 服务

- HTTP 服务自动选择可用端口（避免冲突）
- 端口范围：`OLA_CC_GROK_PORT_RANGE=63000-63100`
- 多项目并行支持（每个项目独立端口）

---

## 八、意图路由

### 8.1 自然语言路由规则

当用户通过 `/cg` 或 `/gc` 使用自然语言查询时，根据关键词路由：

| 关键词 | 路由目标 |
|--------|---------|
| 谁调用、调用链、callers、callees | CodeGraph |
| 影响、修改影响、impact | CodeGraph |
| 路径、从...到、trace | CodeGraph |
| 搜索、找、find、search | CodeGraph |
| 业务、流程、domain、business | Grok |
| 架构、全貌、overview、architecture | Grok |
| 学习、入门、learn、onboard | Grok |
| 解释、explain、what is | Grok |
| 变更影响、diff impact | Grok |

### 8.2 模型自动选择

当模型通过 Tool 系统调用时，不经过路由层，由模型根据上下文自行选择 CodeGraph 或 Grok Tool。

---

## 九、实施阶段

| Phase | 内容 | 工作量 | 依赖 |
|-------|------|--------|------|
| 1 | CodeGraph Skill 层（`/cg` 命令） | 小 | 无 |
| 2 | GrokManager 适配层 + 源码克隆 | 中 | 无 |
| 3 | Grok Tool 注册（8 操作） | 中 | Phase 2 |
| 4 | Grok Skill 层（`/grok` 命令） | 小 | Phase 3 |
| 5 | Dashboard 集成（浏览器） | 中 | Phase 2 |
| 6 | 终端 Ink 集成 | 大 | Phase 3 |

Phase 1-2 可并行开发。

---

## 十、文件结构

```
src/tools/
├── CodegraphTool/
│   ├── CodegraphTool.ts          # 现有，不变
│   ├── CodegraphManager.ts       # 现有，不变
│   └── CodegraphSkill.ts         # 新增：Skill 层
├── GrokTool/
│   ├── GrokTool.ts               # 新增：Tool 定义（8 操作）
│   ├── GrokManager.ts            # 新增：适配层
│   └── GrokSkill.ts              # 新增：Skill 层
src/commands/
│   ├── grok.ts                   # 新增：/grok 命令
│   ├── gc.ts                     # 新增：/gc 命令
│   ├── gd.ts                     # 新增：/gd 命令
│   ├── ge.ts                     # 新增：/ge 命令
│   ├── gt.ts                     # 新增：/gt 命令
│   ├── gdiff.ts                  # 新增：/gdiff 命令
│   ├── go.ts                     # 新增：/go 命令
│   ├── gdomain.ts                # 新增：/gdomain 命令
│   └── cg.ts                     # 新增：/cg 命令
vendor/
│   └── grok/                     # 克隆的 Understand-Anything 源码
```

---

## 十一、配置项

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `OLA_CC_GROK_STORAGE` | `project` | 存储位置：`project` 或 `user` |
| `OLA_CC_GROK_PORT_RANGE` | `63000-63100` | Dashboard HTTP 端口范围 |
| `OLA_CC_GROK_LANGUAGE` | `en` | 默认语言 |
| `OLA_CC_GROK_MAX_BATCH` | `5` | 并行分析文件数 |
| `OLA_CC_GROK_AUTO_UPDATE` | `false` | 自动更新源码 |

---

*文档版本：v1.0*
