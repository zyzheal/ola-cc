# Grok + CodeGraph 双引擎互补集成设计

> 设计日期：2026-05-28
> 状态：已实施（Phase 1-6 完成，4 轮深度评审通过，33 项修复）

---

## 一、设计目标

1. **双引擎互补** — CodeGraph 负责实时精确查询，Grok（Understand-Anything）负责离线全局理解
2. **Tool + Skill 双形态** — 两者都支持模型自动调用（Tool）和用户交互式使用（Skill）
3. **零侵入** — 不修改 Understand-Anything 源代码，通过适配层集成
4. **渐进增强** — Phase 1 浏览器 Dashboard，Phase 2 终端 Ink 集成

---

## 零、用户故事

### US-1：新人 Onboarding

- **角色**：新加入团队的开发者
- **场景**：刚接手一个 20 万行代码的项目，需要快速理解架构
- **操作流程**：
  1. 执行 `/grok` 生成知识图谱（首次约 3-5 分钟）
  2. 执行 `/gd` 打开浏览器 Dashboard，浏览架构层和节点关系
  3. 执行 `/gt` 获取引导式学习路径，按依赖顺序学习模块
  4. 执行 `/ge src/auth/login.ts` 深入理解关键文件
- **价值**：从"不知从何下手"到"有全局视图"，缩短 onboarding 时间 50%+
- **验收标准**：图谱覆盖 ≥90% 文件，学习路径 ≥3 条，Dashboard 可交互

### US-2：变更影响评估

- **角色**：提交 PR 的开发者
- **场景**：修改了 `PaymentService.createOrder()`，需要知道影响范围
- **操作流程**：
  1. 执行 `/cg i PaymentService.createOrder` 查看 CodeGraph 影响分析（秒级）
  2. 执行 `/gdiff` 查看 Grok 的变更影响（结合业务域语义）
  3. 根据影响范围决定需要补充哪些测试
- **价值**：避免遗漏影响面，减少线上回归问题
- **验收标准**：CodeGraph 返回调用链 ≥2 层，Grok 返回业务域关联

### US-3：业务域理解

- **角色**：产品经理 / 技术负责人
- **场景**：需要理解代码如何映射到业务流程
- **操作流程**：
  1. 执行 `/gdomain` 分析业务域（domains、flows、steps）
  2. 在 Dashboard 中切换到"域视图"，查看业务流程图
  3. 执行 `/gc 支付流程是怎么工作的？` 自然语言问答
- **价值**：技术与业务对齐，减少沟通成本
- **验收标准**：识别 ≥3 个业务域，每个域有 ≥1 个完整流程

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

| 操作 | 用途 | 输入参数 | 输出 |
|------|------|---------|------|
| `grok_generate` | 生成知识图谱 | `path?`, `language?`, `scope?`, `incremental?` | `{ status, nodeCount, edgeCount, domainCount, filePath }` |
| `grok_chat` | 自然语言问答 | `question` | `{ answer, sources: [{ file, line, relevance }] }` |
| `grok_explain` | 解释文件/函数 | `target` | `{ summary, relationships, layer, domain }` |
| `grok_domain` | 业务域分析 | `path?` | `{ domains: [{ name, flows, files }] }` |
| `grok_tour` | 引导式学习 | `topic?` | `{ tours: [{ name, steps: [{ file, description }] }] }` |
| `grok_diff` | 变更影响分析 | `files?` | `{ impacted: [{ file, reason, domain }] }` |
| `grok_status` | 图谱状态 | — | `{ exists, nodeCount, lastUpdated, stale }` |
| `grok_dashboard` | 启动浏览器 Dashboard | `port?` | `{ url, port }` |

#### 5.1.1 grok_generate 增量更新策略

**首次生成**：全量扫描 → Tree-sitter 解析 → LLM 语义分析 → 输出 `knowledge-graph.json`

**增量更新**（`incremental: true`，默认行为）：
1. 读取现有 `knowledge-graph.json` 的 metadata（含文件指纹 map）
2. 对比当前项目文件的 mtime + content hash
3. 仅对变更文件重新执行 file-analyzer Agent
4. 合并新旧图谱（新增节点/边 + 删除失效节点/边）
5. 重新运行 architecture-analyzer（层分配可能因变更而调整）
6. 跳过 tour-builder 和 graph-reviewer（除非用户指定 `--full`）

**增量判定条件**：
- 文件 mtime 变更 → 重新分析
- 文件 content hash 变更 → 重新分析
- 新增文件 → 追加分析
- 删除文件 → 从图谱中移除节点和相关边

**强制全量**：`incremental: false` 或图谱 metadata 缺失时执行全量

### 5.2 Skill 命令

| Skill | 功能 | type | 说明 |
|-------|------|------|------|
| `/grok` | 生成图谱 | `local` | 交互式进度显示，可选 `--language zh`，需要终端 UI |
| `/gc <question>` | 自然语言问答 | `prompt` | 构造 prompt 让模型调用 grok_chat Tool |
| `/gd` | 打开浏览器 Dashboard | `local` | 直接调用 GrokManager.startDashboard()，无需模型参与 |
| `/ge <file>` | 深入解释 | `prompt` | 构造 prompt 让模型调用 grok_explain Tool |
| `/gt` | 引导式学习路径 | `prompt` | 构造 prompt 让模型调用 grok_tour Tool |
| `/gdiff` | 变更影响分析 | `prompt` | 构造 prompt 让模型调用 grok_diff Tool |
| `/go` | 新人入职指南 | `prompt` | 构造 prompt 让模型调用 grok_tour + grok_domain Tool |
| `/gdomain` | 业务域分析 | `prompt` | 构造 prompt 让模型调用 grok_domain Tool |

> **type 说明**：`local` = 直接在本地执行，不经过模型（如进度显示、打开浏览器）；`prompt` = 构造 prompt 注入对话，由模型调用对应 Tool 完成。

#### 5.2.1 Skill 交互流程规范

**`/grok`（生成图谱）**：
```
输入: /grok [--language zh] [--scope src/frontend]
输出:
  ┌── Grok 图谱生成 ──────────────────────────────┐
  │ 项目: ola-cc (TypeScript, 847 文件)              │
  │                                                  │
  │ [1/5] project-scanner    ████████████ 100%       │
  │ [2/5] file-analyzer      ████████░░░░  67%       │
  │ [3/5] architecture       ░░░░░░░░░░░░   0%       │
  │ [4/5] tour-builder       ░░░░░░░░░░░░   0%       │
  │ [5/5] graph-reviewer     ░░░░░░░░░░░░   0%       │
  │                                                  │
  │ 已处理: 234/847 文件 | 耗时: 1m23s               │
  └──────────────────────────────────────────────────┘
错误: 图谱生成失败时显示具体错误 + 建议操作
  ✗ file-analyzer 失败: src/complex.ts 解析超时
    → 建议: /grok --scope src/ --exclude src/complex.ts
```

**`/gc`（自然语言问答）**：
```
输入: /gc 支付流程是怎么工作的？
输出:
  ┌── Grok 问答 ──────────────────────────────────┐
  │ Q: 支付流程是怎么工作的？                         │
  │                                                  │
  │ A: 支付流程涉及 3 个核心模块：                     │
  │   1. PaymentService.createOrder() — 创建订单     │
  │   2. StripeAPI.charge() — 调用第三方支付         │
  │   3. OrderDB.updateStatus() — 持久化状态         │
  │                                                  │
  │ 📎 相关文件:                                     │
  │   • src/services/payment.ts:45 (核心逻辑)        │
  │   • src/api/stripe.ts:12 (第三方集成)            │
  │   • src/db/orders.ts:78 (数据持久化)             │
  │                                                  │
  │ 💡 输入 /gd 查看完整交互式图谱                    │
  └──────────────────────────────────────────────────┘
错误: 图谱不存在时
  ✗ 知识图谱未生成，请先执行 /grok
```

**`/gd`（打开 Dashboard）**：
```
输入: /gd
输出:
  ✓ Dashboard 已启动: http://localhost:63000
  （浏览器自动打开）
错误: 端口占用时
  ✗ 端口 63000 被占用，尝试 63001...
  ✓ Dashboard 已启动: http://localhost:63001
```

**`/ge`（深入解释）**：
```
输入: /ge src/QueryEngine.ts
输出:
  ┌── Grok 解释: QueryEngine.ts ──────────────────┐
  │ 层: Service | 域: 核心引擎                        │
  │                                                  │
  │ 📝 摘要:                                         │
  │   编排 Agent 循环 — 发送消息到 API，处理工具调用，  │
  │   管理会话状态，处理 compact/recovery 流程。        │
  │                                                  │
  │ 🔗 关系:                                         │
  │   调用: API.client, ToolRunner, StateManager     │
  │   被调用: REPL.main, SubAgent.run                │
  │                                                  │
  │ 🏗️ 架构:                                        │
  │   Service 层 → 依赖 API 层 + Data 层             │
  └──────────────────────────────────────────────────┘
错误: 文件不存在时
  ✗ 文件不存在: src/QueryEngine.ts
    → 可用文件: src/QueryEngine.ts (注意大小写)
```

**`/gt`（引导式学习）**：
```
输入: /gt [auth]
输出:
  ┌── Grok 学习路径: 认证系统 ─────────────────────┐
  │ 📍 推荐学习顺序（按依赖关系）：                    │
  │                                                  │
  │ Step 1: src/auth/types.ts                        │
  │   → 理解认证类型定义（Token, Session, User）      │
  │                                                  │
  │ Step 2: src/auth/middleware.ts                    │
  │   → 理解认证中间件（JWT 验证、权限检查）           │
  │                                                  │
  │ Step 3: src/auth/service.ts                      │
  │   → 理解认证服务（登录、注册、Token 刷新）         │
  │                                                  │
  │ Step 4: src/api/auth-routes.ts                   │
  │   → 理解 API 路由（端点定义、请求处理）            │
  │                                                  │
  │ ⏱️ 预计学习时间: 25 分钟                          │
  └──────────────────────────────────────────────────┘
```

**`/gdiff`（变更影响）**：
```
输入: /gdiff
输出:
  ┌── Grok 变更影响分析 ───────────────────────────┐
  │ 变更文件: 3 个                                    │
  │                                                  │
  │ 📄 src/services/payment.ts (修改)                │
  │   影响: 5 个文件 | 域: 支付                       │
  │   • src/api/payment-routes.ts (API 层)           │
  │   • src/workflows/checkout.ts (业务流程)          │
  │   • tests/payment.test.ts (测试)                 │
  │   • src/db/orders.ts (数据层)                    │
  │   • src/notifications/email.ts (通知)            │
  │                                                  │
  │ ⚠️ 高风险: 支付域核心逻辑变更，建议补充测试        │
  └──────────────────────────────────────────────────┘
```

### 5.3 Skill 别名

使用 ola-cc 命令系统原生的 `Command.aliases` 字段注册别名，无需自定义别名表。

```typescript
// src/commands/gc/index.ts
export const Command = {
  name: 'gc',
  description: 'Grok 自然语言问答',
  type: 'prompt',
  aliases: ['grok-chat'],  // 原生 aliases 字段
  // ...
}
```

| 命令 | aliases | 说明 |
|------|---------|------|
| `/gc` | `grok-chat` | 用户输入 `/grok-chat` 自动路由到 `/gc` |
| `/gd` | `grok-dashboard` | 同上 |
| `/ge` | `grok-explain` | 同上 |
| `/gt` | `grok-tour` | 同上 |
| `/gdiff` | `grok-diff` | 同上 |
| `/go` | `grok-onboard` | 同上 |
| `/gdomain` | `grok-domain` | 同上 |

> **实现方式**：每个命令的 `index.ts` 导出的 `Command` 对象中声明 `aliases` 数组，ola-cc 命令系统自动处理别名路由，无需额外代码。

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

### 6.2 接口定义

```typescript
// GrokManager 公开接口

interface GrokGenerateOptions {
  path?: string           // 扫描路径，默认项目根目录
  language?: string       // 输出语言，默认 'en'
  scope?: string          // 子目录范围
  incremental?: boolean   // 增量更新，默认 true
  onProgress?: (stage: string, progress: number) => void  // 进度回调
}

interface GrokGenerateResult {
  status: 'success' | 'partial' | 'failed'
  nodeCount: number
  edgeCount: number
  domainCount: number
  filePath: string        // knowledge-graph.json 路径
  errors?: GrokError[]    // 部分失败时的错误列表
}

interface GrokChatResult {
  answer: string
  sources: { file: string; line: number; relevance: number }[]
}

interface GrokError {
  agent: string           // 失败的 Agent 名称
  stage: string           // 失败阶段
  message: string
  recoverable: boolean    // 是否可恢复
  suggestion?: string     // 建议操作
}

// 公开方法
export async function ensureGrokSource(): Promise<string>
export async function runAgentPipeline(options: GrokGenerateOptions): Promise<GrokGenerateResult>
export async function queryGraph(question: string): Promise<GrokChatResult>
export async function startDashboard(port?: number): Promise<{ url: string; port: number }>
export async function getGraphStatus(): Promise<GrokGraphStatus>
```

### 6.3 关键设计决策

**Agent 流水线使用轻量级 API client 直接编排**，不通过 AgentTool。

#### 为什么不用 AgentTool？

| 维度 | AgentTool | 轻量级 API client |
|------|-----------|-------------------|
| 设计目的 | 交互式子代理调用（用户对话中） | 批量 LLM 调用编排 |
| UI 开销 | 完整的 Ink 渲染、权限检查、进度跟踪 | 无 UI 开销 |
| Token 管理 | 会话级，非流水线级 | 可自定义流水线级预算 |
| 并行能力 | 受 `isConcurrencySafe` 限制 | 原生 `Promise.all` 并行 |
| 适合场景 | 2-3 个子代理任务 | 5 并行 × 20-30 文件/批 |

**结论**：AgentTool 面向交互式子代理，用于批量文件分析流水线过于重量级。GrokManager 直接使用 `getAnthropicClient()` API client 构建轻量级 Agent 流水线。

#### 实现方式

```typescript
import { getAnthropicClient } from '../../services/api/client.js'

// 轻量级 Agent 调用 — 直接使用 Anthropic SDK
async function callAgent(prompt: string, systemPrompt: string): Promise<string> {
  const client = getAnthropicClient()
  const response = await client.messages.create({
    model: getAgentModel(),  // 复用 ola-cc 模型选择逻辑
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  })
  return response.content[0].type === 'text' ? response.content[0].text : ''
}

// 并行 file-analyzer — 5 批 × 20-30 文件
async function analyzeFilesBatch(files: string[]): Promise<AnalysisResult[]> {
  const batches = chunk(files, 25)  // 25 文件/批
  const results = await Promise.all(
    batches.slice(0, 5).map(batch => callAgent(
      buildFileAnalyzerPrompt(batch),
      FILE_ANALYZER_SYSTEM_PROMPT,
    ))
  )
  return results.flatMap(parseAnalysisResults)
}
```

原版 Understand-Anything 的 5 个 Agent：
1. `project-scanner` — 发现文件、检测语言/框架
2. `file-analyzer` — Tree-sitter 解析 + LLM 语义分析（并行，20-30 文件/批）
3. `architecture-analyzer` — 识别架构层
4. `tour-builder` — 生成引导式学习路径
5. `graph-reviewer` — 验证图谱完整性

这些 Agent 的 prompt 模板从源码中提取，通过轻量级 API client 直接执行。

### 6.4 错误处理与恢复策略

#### Agent 流水线 Checkpoint 机制

每个 Agent 完成后保存中间结果到 `.understand-anything/checkpoints/`：

```
checkpoints/
├── scanner.json        — project-scanner 输出（文件列表、语言检测）
├── analyzer-batch-1.json  — file-analyzer 第 1 批输出
├── analyzer-batch-2.json  — file-analyzer 第 2 批输出
├── architecture.json   — architecture-analyzer 输出
├── tour.json           — tour-builder 输出
└── review.json         — graph-reviewer 输出
```

**恢复策略**：
- 流水线中断后重新执行 `/grok`，自动检测已有 checkpoint
- 跳过已完成的 Agent，从断点继续
- checkpoint 文件含 timestamp，超过 24 小时自动失效

#### 超时保护

| 阶段 | 超时时间 | 超时后行为 |
|------|---------|-----------|
| 单个 file-analyzer 批次 | 30s | 跳过该批，记录错误，继续下一批 |
| architecture-analyzer | 60s | 跳过，使用默认层分配 |
| tour-builder | 60s | 跳过，标记为"学习路径未生成" |
| graph-reviewer | 30s | 跳过，标记为"未验证" |
| 总流水线 | 10min | 强制终止，输出已生成的部分图谱 |

#### 部分完成降级

当部分 Agent 失败时，`GrokGenerateResult.status` 为 `'partial'`：
- 图谱仍可使用（已分析的节点/边保留）
- Dashboard 标记缺失部分（如"学习路径未生成"）
- 用户可通过 `--full` 强制重新执行失败的 Agent

#### 错误类型与建议

```typescript
const ERROR_SUGGESTIONS: Record<string, string> = {
  'PARSE_TIMEOUT': '文件过大，建议 --exclude 排除或拆分文件',
  'LLM_RATE_LIMIT': 'API 限流，建议等待 60s 后重试',
  'LLM_TOKEN_BUDGET': 'Token 预算耗尽，建议 --scope 缩小范围',
  'GRAPH_INVALID': '图谱数据损坏，建议 /grok --full 重新生成',
  'SOURCE_CLONE_FAILED': '源码克隆失败，检查网络连接后重试',
}
```

### 6.5 LLM Client 集成

**复用 ola-cc 已有的 API client**（`src/services/api/client.ts`），不引入独立的 LLM SDK。

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 并发 Agent 数 | 5 | file-analyzer 并行批次数 |
| 单 Agent token 上限 | 4096 | 单次 LLM 调用的最大输出 token |
| 总流水线 token 上限 | 100K | 整个生成过程的 token 预算 |
| rate limit 退避 | 指数退避，最大 3 次 | 遇到 429 自动重试 |

**Token 预算管理**：
- 流水线启动时估算总 token 需求（文件数 × 平均 token/文件）
- 超出预算时自动降低分析深度（跳过 tour-builder 和 graph-reviewer）
- 进度回调中报告已消耗 token 数

### 6.6 源码管理

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

#### 安全措施

- **绑定 localhost** — 默认只监听 `127.0.0.1`，不暴露到网络
- **随机 token** — 每次启动生成随机 URL token（如 `http://localhost:63000/dashboard?token=abc123`），防止 CSRF
- **无敏感数据** — Dashboard 只展示代码结构图，不暴露源码内容或密钥
- **自动关闭** — 30 分钟无请求自动关闭 HTTP 服务

---

## 八、意图路由

### 8.1 自然语言路由规则

当用户通过 `/cg` 或 `/gc` 使用自然语言查询时，根据关键词路由：

| 关键词 | 路由目标 | 优先级 |
|--------|---------|--------|
| 谁调用、调用链、callers、callees | CodeGraph | 高 |
| 影响、修改影响、impact | CodeGraph | 高 |
| 路径、从...到、trace | CodeGraph | 高 |
| 搜索、找、find、search | CodeGraph | 高 |
| 业务、流程、domain、business | Grok | 中 |
| 架构、全貌、overview、architecture | Grok | 中 |
| 学习、入门、learn、onboard | Grok | 中 |
| 解释、explain、what is | Grok | 中 |
| 变更影响、diff impact | Grok | 中 |

### 8.2 路由冲突处理

当查询同时匹配 CodeGraph 和 Grok 关键词时（如"PaymentService 的业务流程"同时匹配"业务"和符号名）：

1. **精确符号名优先** — 如果查询包含已知符号名（通过 CodeGraph 搜索验证），路由到 CodeGraph
2. **CodeGraph 优先** — 无明确符号名时，CodeGraph 优先（零成本、秒级响应）
3. **Grok 补充** — CodeGraph 返回结果不足时（节点数 < 3），提示用户可用 `/gc` 获取 Grok 语义分析

路由决策伪代码：
```
if (containsSymbolName(query)) → CodeGraph
else if (matchesCodeGraphKeywords(query)) → CodeGraph
else if (matchesGrokKeywords(query)) → Grok
else → CodeGraph (默认)
```

### 8.3 模型自动选择

当模型通过 Tool 系统调用时，不经过路由层，由模型根据上下文自行选择 CodeGraph 或 Grok Tool。

---

## 九、实施阶段

| Phase | 内容 | 工作量 | 依赖 | 验收标准 |
|-------|------|--------|------|---------|
| 1 | CodeGraph Skill 层（`/cg` 命令） | 小 | 无 | `/cg s`, `/cg i`, `/cg tr` 命令可执行，输出格式正确 |
| 2 | GrokManager 适配层 + 源码克隆 | 中 | 无 | `ensureGrokSource()` 成功克隆，`runAgentPipeline()` 返回结果 |
| 3 | Grok Tool 注册（8 操作） | 中 | Phase 2 | 模型可通过 Tool 系统调用 8 个 grok_* 操作 |
| 4 | Grok Skill 层（`/grok` 命令） | 小 | Phase 3 | `/grok`, `/gc`, `/gd` 命令可执行，交互流程符合 §5.2.1 |
| 5 | Dashboard 集成（浏览器） | 中 | Phase 2 | `/gd` 打开浏览器，D3 图谱可交互，节点可点击 |
| 6 | 终端 Ink 集成 | 大 | Phase 3 | Agent 可在终端内联输出图谱摘要（文本/表格） |

Phase 1-2 可并行开发。

#### 验收测试用例

| 测试 | 命令 | 预期结果 |
|------|------|---------|
| CG-01 | `/cg s QueryGuard` | 返回 QueryGuard 相关节点列表 |
| CG-02 | `/cg i QueryGuard` | 返回影响分析（调用者 + 被调用者） |
| CG-03 | `/cg tr QueryGuard to REPL` | 返回连接路径 |
| GK-01 | `/grok` | 生成图谱，进度条显示，完成后提示 `/gd` |
| GK-02 | `/gc 支付流程` | 返回支付相关节点和摘要 |
| GK-03 | `/gd` | 浏览器打开 Dashboard，图谱可交互 |
| GK-04 | `/ge src/QueryEngine.ts` | 返回文件解释（层、域、关系） |
| GK-05 | `/gt` | 返回学习路径（≥3 步） |
| GK-06 | `/gdiff` | 返回变更影响分析 |
| GK-07 | `grok_status` Tool | 返回 `{ exists: true, nodeCount: N }` |
| GK-08 | `/grok --language zh` | 图谱节点描述为中文 |

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
│   ├── grok/
│   │   └── index.ts              # 新增：/grok 命令（type: local）
│   ├── gc/
│   │   └── index.ts              # 新增：/gc 命令（type: prompt）
│   ├── gd/
│   │   └── index.ts              # 新增：/gd 命令（type: local）
│   ├── ge/
│   │   └── index.ts              # 新增：/ge 命令（type: prompt）
│   ├── gt/
│   │   └── index.ts              # 新增：/gt 命令（type: prompt）
│   ├── gdiff/
│   │   └── index.ts              # 新增：/gdiff 命令（type: prompt）
│   ├── go/
│   │   └── index.ts              # 新增：/go 命令（type: prompt）
│   ├── gdomain/
│   │   └── index.ts              # 新增：/gdomain 命令（type: prompt）
│   └── cg/
│       └── index.ts              # 新增：/cg 命令（type: prompt）
vendor/
│   └── grok/                     # 克隆的 Understand-Anything 源码
```

> **目录结构说明**：ola-cc 的命令系统使用目录模式 `src/commands/<name>/index.ts`，而非扁平文件。每个命令目录下的 `index.ts` 导出 `Command` 对象，包含 `name`、`description`、`type`、`aliases` 等字段。

---

## 十一、大厂对标

| 工具 | 核心能力 | 可借鉴点 | Grok 适配 |
|------|---------|---------|-----------|
| **Sourcegraph** | 代码搜索 + 代码智能 | 精确符号搜索、跨仓库搜索、代码导航 | CodeGraph 已覆盖搜索，Grok 补充语义层 |
| **CodeSee** | 代码可视化 + 影响分析 | 自动架构图、PR 影响分析、代码变更可视化 | Grok Dashboard 对标，`/gdiff` 对标 PR 分析 |
| **Swimm** | 代码文档 + 引导式学习 | 自动生成文档、与代码同步、学习路径 | Grok tour-builder 对标，增量更新机制可借鉴 |
| **Mintlify** | API 文档自动生成 | 从代码提取 API 文档、交互式文档 | Grok explain 可扩展为 API 文档生成 |
| **Augment Code** | AI 代码理解 | 上下文感知、大型代码库理解、团队知识 | Grok 的 Agent 流水线设计理念相似 |

**核心差异**：Grok 作为 ola-cc 内置工具，与 Agent 系统深度集成（模型自动调用 + Skill 交互），而上述工具多为独立产品。

---

## 十二、配置项

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `OLA_CC_GROK_STORAGE` | `project` | 存储位置：`project` 或 `user` |
| `OLA_CC_GROK_PORT_RANGE` | `63000-63100` | Dashboard HTTP 端口范围 |
| `OLA_CC_GROK_LANGUAGE` | `en` | 默认语言 |
| `OLA_CC_GROK_MAX_BATCH` | `5` | 并行分析文件数 |
| `OLA_CC_GROK_AUTO_UPDATE` | `false` | 自动更新源码 |

---

---

## 十三、实施状态与评审记录

### 13.1 实施完成度

| 模块 | 文件 | 行数 | 状态 |
|------|------|------|------|
| GrokManager.ts | `src/tools/GrokTool/GrokManager.ts` | ~1300 | ✅ 完成 |
| GrokTool.ts | `src/tools/GrokTool/GrokTool.ts` | ~180 | ✅ 完成 |
| GrokSkill.ts | `src/tools/GrokTool/GrokSkill.ts` | ~140 | ✅ 完成 |
| CodegraphTool.ts | `src/tools/CodegraphTool/CodegraphTool.ts` | ~280 | ✅ 增强（sync 操作 + buildTool 适配） |
| CodegraphManager.ts | `src/tools/CodegraphTool/CodegraphManager.ts` | ~470 | ✅ 修复（execFile + settled guard + initLock） |
| 测试 | `src/tools/GrokTool/__tests__/` | ~400 | ✅ 37 用例通过 |

### 13.2 设计偏差记录

实现过程中与原始设计的偏差：

| 设计项 | 原始设计 | 实际实现 | 偏差原因 |
|--------|---------|---------|---------|
| 文件指纹 | mtime + size | SHA-256 content hash + size | mtime 在 git checkout 后不可靠 |
| projectRoot | 构造时固定 | 惰性 getter `get projectRoot()` | 适配 worktree 切换 |
| pipelineLock | 模块级变量 | 类实例级 | 避免多实例共享锁 |
| LLM Client | `getAnthropicClient()` | `new Anthropic()` + provider 检测 | 轻量级调用不需要完整 provider 栈 |
| Skill 层 | Tool 调用 Skill 格式化 | Tool 自行格式化，Skill 未集成 | Skill 层当前为死代码，待后续集成 |
| 增量架构分析 | 始终重新分析 | 变更 <20% 时复用已有 | 减少 LLM 调用成本 |
| 边过滤 | — | Set 提升到循环外 O(n+m) | 评审发现 O(E*N) 性能 bug |

### 13.3 三轮深度评审修复汇总

#### 第一轮：安全/架构/测试评审（15 项）

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| 1 | Critical | Dashboard XSS — innerHTML 渲染 LLM 输出 | `esc()` 转义函数 |
| 2 | Critical | execSync 无超时 — git clone 可无限阻塞 | 添加 timeout: 120_000/60_000 |
| 3 | Critical | 路径穿越 — scope 参数未校验 | `basePath.startsWith(projectRoot)` 校验 |
| 4 | P0 | GrokManager 绕过 provider 体系 | 引入 `getAPIProvider()` 检测 |
| 5 | Important | Promise.race 定时器泄漏 | `.finally(() => clearTimeout(timer))` |
| 6 | Important | queryGraph JSON.parse 崩溃 | try/catch + GrokError |
| 7 | Important | HOME 环境变量 Windows 不兼容 | `os.homedir()` |
| 8 | Important | discoverFiles 无递归深度限制 | `depth > 20` 上限 |
| 9 | Important | Dashboard 可重复启动 | `dashboardServer` 字段跟踪 |
| 10 | P1 | codegraph_init 对已初始化项目重复执行 | switch 短路判断 |
| 11 | P1 | 单例 projectRoot 不适应 worktree | 惰性 getter |
| 12 | P1 | parseAnalysisResult 正则 `/m` 误剥离 | 只剥离字符串首尾 code fence |
| 13 | P2 | pipelineLock 模块级变量 | 移入类实例 |
| 14 | P2 | isConcurrencySafe 语义不精确 | 排除 generate/dashboard |
| 15 | P2 | assembleGraph O(E*N) 边过滤 | Set 提升到 filter 外 |

#### 第二轮：灾难性风险评审（6 项）

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| 16 | Critical | 增量模式 LLM 失败丢失旧节点 | 仅在有新分析结果时删除旧节点 |
| 17 | Important | Dashboard err.message XSS | `esc()` 转义 |
| 18 | Important | 图谱 JSON 结构无校验 | 检查 nodes/edges 数组存在 |
| 19 | Important | 写入中断无恢复 | 写前备份 + 启动清理 .tmp |
| 20 | Important | 图谱损坏无回退 | 自动读取 .backup 文件 |
| 21 | — | require('fs') 替代 | 使用已导入的 fs 函数 |

#### 第三轮：深度灾难性评审（3 项）

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| 22 | Critical | mapToolResultToToolResultBlockParam 双重编码 | 提取 `output.content[0].text` |
| 23 | Critical | downloadPromise reject 后不重置 → 永久故障 | try/finally 确保重置 |
| 24 | Critical | stdout/stderr 无大小限制 → OOM | 50MB 上限 + 手动超时保险 |

#### 第四轮：并行架构/质量/安全评审（9 项）

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| 25 | P0 | runCodegraph double-reject（stdout 超限后 timer 未清除） | `settled` flag guard，所有 settle 路径检查 |
| 26 | P0 | downloadFile 重定向时 WriteStream 未关闭 → FD 泄漏 | 重定向分支 `file.destroy()` |
| 27 | P0 | ensureReady TOCTOU 竞态 → 并发触发多次 init | `initPromise` 单一飞行锁 |
| 28 | P0 | extractTarGz shell 注入风险 | `exec` → `execFile`（数组参数） |
| 29 | P0 | Dashboard `close()` 不关闭活跃连接 | `closeAllConnections()` + `close()` |
| 30 | P0 | GrokError interface/class 命名冲突 | 移除重复 interface，统一用 class |
| 31 | P0 | codegraph_trace 不安全 `any[]` 转换 | `Array.isArray` guard 替代 `as any[]` |
| 32 | P1 | `includeCode` schema 参数从未传递到后端 | 从 schema 移除 |
| 33 | P1 | `parseWithTimeout` 死代码（零调用点） | 移除方法和 `PARSE_TIMEOUT` 常量 |

### 13.4 已知遗留项

| 优先级 | 项目 | 说明 |
|--------|------|------|
| P2 | CodegraphSkill 测试 | parseCgCommand、formatCodegraphResult 纯函数测试 |
| P2 | GrokTool.call() 测试 | mock grokManager 后测试 8 个 operation 分发 |
| P2 | Skill 层集成 | GrokSkill/CodegraphSkill 格式化函数是死代码，Tool 层绕过了它们 |
| P2 | 跨引擎联动 | CodeGraph sync 后提示 Grok 图谱过期 |
| P3 | 二进制校验 | CodegraphManager 下载后 SHA-256 验证 |
| P3 | 流式写入 | 大项目（10 万+ 文件）的内存优化 |

*文档版本：v3.0（实施完成 + 4 轮评审，33 项修复）*
