# 多专家视角深度分析 — 四项目交叉集成综合报告

**Date**: 2026-06-03
**Status**: Analysis Complete
**Source**: claude-code + openclaude + oh-my-claudecode → ola-cc
**Experts**: 架构师 + 产品经理 + 算法工程师 + UX 专家 + 安全专家

> **文档定位**: 本文档为分析报告 + 实施路线图，非独立功能设计规范。具体功能的接口定义、数据结构、算法细节详见对应的专项设计文档（见 §1.1 引用表）。Phase 路线图提供优先级排序和依赖关系，实施时以各专项文档为准。

---

## 1. 架构师视角 — 六子系统架构差异

### 1.1 记忆生命周期

| 项目 | 架构 | 核心组件 |
|------|------|---------|
| claude-code | ExtractMemories + AutoDream + MagicDocs | fork 子代理提取 → 时间+会话门控整合 → 文档自动更新 |
| openclaude | AgentMemory 三作用域 | user/project/local 作用域 + 远程挂载 + teamMemorySync |
| oh-my-claudecode | Notepad 三区模型 | Priority Context(500c) / Working Memory(7天) / MANUAL(永久) |
| ola-cc | 手动 /memory | 缺少自动提取和整合 |

**推荐方案**: openclaude 三作用域 + OMC 三区混合模型。新增 `MemoryRouter` 根据类型路由到对应作用域和区域。

**MemoryRouter 映射关系**:

| openclaude 作用域 | OMC 区域 | 容量/有效期 | 说明 |
|-------------------|----------|-------------|------|
| local scope | Priority Context | 500 字符，始终加载 | 项目级高频上下文，每次会话自动注入 |
| project scope | Working Memory | 7 天过期 | 项目级中期记忆，跨会话保留但有衰减 |
| user scope | MANUAL zone | 永久 | 用户级偏好和长期知识，需显式管理 |

**路由规则**:
- **写入路由**: 根据记忆元数据的 `scope` 字段自动分发 — `local` → Priority Context, `project` → Working Memory, `user` → MANUAL zone
- **读取优先级**: Priority Context > Working Memory > MANUAL zone（短生命周期优先，避免上下文膨胀）
- **衰减策略**: Working Memory 超过 7 天未命中的条目自动降级为 MANUAL zone，不直接删除
- **容量保护**: Priority Context 超过 500 字符时，最旧条目溢出到 Working Memory

**MemoryRouter 完整接口定义**:

```typescript
// === 配置 ===
interface MemoryScopeConfig {
  ttlMs: number           // -1 = permanent
  maxSize: number         // bytes
  decayFactor?: number    // 衰减系数，0-1
}

interface MemoryZoneConfig {
  maxChars?: number       // Priority Context 字符上限
  retentionMs: number     // -1 = permanent
  injectMethod?: 'system_prompt' | 'tool_result'
  decayFactor?: number
  userManaged?: boolean
}

interface MemoryRouterConfig {
  scopes: {
    local: MemoryScopeConfig    // { ttlMs: 604800000, maxSize: 51200 }
    project: MemoryScopeConfig  // { ttlMs: 2592000000, maxSize: 204800 }
    user: MemoryScopeConfig     // { ttlMs: -1, maxSize: 512000 }
  }
  zones: {
    priority: MemoryZoneConfig  // { maxChars: 500, injectMethod: 'system_prompt' }
    working: MemoryZoneConfig   // { retentionMs: 604800000, decayFactor: 0.9 }
    manual: MemoryZoneConfig    // { retentionMs: -1, userManaged: true }
  }
}

// === 记忆条目 ===
interface MemoryEntry {
  id: string
  content: string
  scope: 'local' | 'project' | 'user'
  zone: 'priority' | 'working' | 'manual'
  createdAt: number
  lastAccessedAt: number
  accessCount: number
  metadata: Record<string, unknown>
}

// === 路由决策 ===
interface RouteDecision {
  targetScope: 'local' | 'project' | 'user'
  targetZone: 'priority' | 'working' | 'manual'
  reason: string
  confidence: number      // 0-1
}

// === 路由器接口 ===
interface MemoryRouter {
  config: MemoryRouterConfig

  // 写入路由
  route(entry: MemoryEntry): RouteDecision

  // 读取（按优先级排序）
  query(options?: { scope?: string; zone?: string; limit?: number }): MemoryEntry[]

  // 注入到上下文
  injectToContext(entries: MemoryEntry[]): string

  // 衰减处理
  applyDecay(): void

  // 容量保护：溢出降级
  enforceCapacity(): void
}

// === 对话上下文（路由输入） ===
interface ConversationContext {
  currentTopic?: string
  recentMessages: Array<{ role: string; content: string }>
  sessionDuration: number
  projectPath: string
}
```

### 1.2 执行管线

| 项目 | 架构 | 核心组件 |
|------|------|---------|
| claude-code | Dynamic Workflows | QueryEngine 驱动，模型自主决策工具调用序列 |
| openclaude | AutoFix | lint-first 短路 + 重试 3 次 + 跨平台进程终止 |
| oh-my-claudecode | Autopilot 5-phase | Expansion→Planning→Execution→QA→Validation，prompt-driven orchestration |
| ola-cc | Goal 系统 | OrchestratorDecision 决策矩阵 + ReAct 观察 + 收敛检测 + 错误熔断 |

**推荐方案**: 以 Goal 系统为核心，融合 OMC Pipeline 阶段管理 + openclaude AutoFix 门控。Goal 支持"管线模式"变体。

### 1.3 IDE 集成

| 项目 | 架构 |
|------|------|
| claude-code | ACP + MCP 双协议，IDE 自动检测 |
| openclaude | ACP + bridge 远程桥接 + JWT 认证 |
| oh-my-claudecode | MCP server 暴露工具 |
| ola-cc | ACP + MCP 双协议 |

**推荐方案**: 保持双协议，增强 MCP 为统一扩展接口。新增 `McpToolExporter` 将 SingularityTool 34 API 通过 MCP 暴露。

### 1.4 安全架构

| 项目 | 安全层 |
|------|--------|
| claude-code | LocalVault(AES-256-GCM + keychain) + Bash Dangerous Patterns + Read-Only Validation(40+命令白名单) |
| openclaude | SSRF Guard(IP验证) + Secret Scanner(34规则) + URL Redaction(14参数) + Error Classification(13类) |
| oh-my-claudecode | Factcheck Guard(4模式) + Verification Tier(3级) + Sentinel Gate(fail-closed) |
| ola-cc | 基础路径安全 + 命令权限 |

**推荐方案**: 三层安全架构。存储层(LocalVault) + 网络层(SSRF Guard) + 行为层(Factcheck)。

### 1.5 生态扩展

| 项目 | 架构 |
|------|------|
| claude-code | Plugin Marketplace + Skill Store + hooks 系统 |
| openclaude | 沿用插件系统 + 自定义市场 |
| oh-my-claudecode | hooks 核心 + builtin-skills + installer |
| ola-cc | 插件系统 + Skill 系统 + SingularityTool 34 API + ASAEF 进化系统 |

**推荐方案**: Skill 为核心扩展点，Singularity API 通过 MCP 暴露，引入 OMC hooks 模式让 Skill 注册 lifecycle hooks。

### 1.6 可观测性

| 项目 | 架构 |
|------|------|
| claude-code | ContextVisualization(热力图+折叠+缓存命中率) |
| openclaude | CacheMetrics(7 provider 归一化) + CostTracker |
| oh-my-claudecode | Session Replay(JSONL 事件录制 + 瓶颈分析) |
| ola-cc | 基础 logEvent + GoalProgress |

**推荐方案**: 三层可观测性。实时(Context Visualization) + 指标(Cache Metrics) + 回放(Session Replay)。

---

## 2. 产品经理视角 — 用户价值矩阵

### 2.1 Top 15 功能

| 排名 | 功能 | 来源 | 痛点 | 频率 | 影响 | ola-cc 现状 |
|------|------|------|------|------|------|-------------|
| 1 | Model Routing | OMC | 不同任务用不同模型省钱 | 每次 | 高 | 有 getAgentModel 但无自动路由 |
| 2 | Dream 记忆整合 | openclaude | 跨会话记忆丢失 | 每日 | 高 | 无自动整合 |
| 3 | Task Decomposer | OMC | 大任务无法并行 | 每次大任务 | 高 | 无自动分解 |
| 4 | Verification Protocol | OMC | 缺乏统一验证标准 | 每次修改 | 高 | codeAuditor 但无 checklist |
| 5 | Security Review | claude-code | PR 遗漏安全漏洞 | 每次 PR | 高 | 无专门安全审查 |
| 6 | Ultraplan | claude-code | 规划占用本地终端 | 每周 | 高 | 完全缺失 |
| 7 | Notepad Wisdom | OMC | 长任务经验无处记录 | 每次长任务 | 中 | LearningSystem 但无计划级笔记 |
| 8 | Context Injector | OMC | 多源上下文散乱 | 每次 | 中 | 无优先级注入框架 |
| 9 | Session History Search | OMC | 找不到历史方案 | 每周 | 中 | 完全缺失 |
| 10 | Magic Keywords | OMC | 需手动写长 prompt | 每次 | 中 | 完全缺失 |
| 11 | Commit-Push-PR | claude-code | git 流程繁琐 | 每日 | 中 | 有 commit 但无一体化 PR |
| 12 | Autofix-PR | claude-code | CI 失败手动修复 | 每周 | 中 | 完全缺失 |
| 13 | Rate Limit Wait | OMC | rate limit 手动等待 | 每日 | 中 | 完全缺失 |
| 14 | Benchmark | openclaude | 无法量化模型性能 | 每周 | 低 | 完全缺失 |
| 15 | Init-Verifiers | claude-code | 新项目手动配置 | 初始化 | 中 | 完全缺失 |

### 2.2 ROI 分析

| 排名 | 功能 | 工作量 | 收益 | ROI |
|------|------|--------|------|-----|
| 1 | Magic Keywords | M(500+行，含多语言支持+意图过滤+防误触发) | 高 | 9/10 |
| 2 | Commit-Push-PR | S(100行) | 高 | 8/10 |
| 3 | Session History Search | M(500行) | 高 | 8/10 |
| 4 | Verification Protocol | M(400行) | 高 | 7/10 |
| 5 | Model Routing | M(600行) | 高 | 7/10 |
| 6 | Notepad Wisdom | S(300行) | 中 | 7/10 |
| 7 | Dream 记忆整合 | L(800行) | 高 | 6/10 |
| 8 | Task Decomposer | L(1000行) | 高 | 6/10 |
| 9 | Security Review | M(400行) | 中 | 5/10 |
| 10 | Autofix-PR | XL | 中 | 4/10 |

---

## 3. 算法工程师视角 — 性能与智能

### 3.1 最具集成价值的技术（低难度高收益）

| 技术 | 来源 | 核心算法 | 预期收益 |
|------|------|---------|---------|
| compressToolHistory | openclaude | 三级压缩(recent/mid/old) + 自适应分层 | 非 Claude provider 40-60% token 减少 |
| IncrementalTokenCounter | openclaude | SHA-256 content hash + O(1) cache hit | token 计算 CPU 开销降低 80% |
| thinkTagSanitizer | openclaude | 流式状态机 + 全文清理 + flush 兜底 | 兼容 DeepSeek/Kimi 等 reasoning 模型 |
| Magic Keywords | OMC | 正则触发 + 信息意图过滤 + 多语言 | 零成本 prompt 增强 |
| tokenBudget | claude-code | 自然语言解析 + 预算百分比注入 | 防止无效输出循环 |

### 3.2 最具架构价值的技术（需深度集成）

| 技术 | 来源 | 核心算法 | 价值 |
|------|------|---------|------|
| promptCacheBreakDetection | claude-code | 12 维缓存诊断 | 定位 cache miss 根因 |
| toolResultStorage | claude-code | 磁盘持久化 + 2KB preview + content replacement | 跨 turn prompt cache 稳定性 |
| Model Routing | OMC | 三维评分(lexical/structural/context) + 规则链 | 智能模型选择节省 30%+ token |
| Cached Microcompact | claude-code | cache_edits beta API + server-side deletion | 30-50% cache token 节省 |
| Streaming Tool Execution | openclaude | isConcurrencySafe + stream-start + sibling abort | 3x → 1x 并行 Read 延迟 |

### 3.3 Cache 策略对比

| 维度 | claude-code | openclaude | ola-cc |
|------|------------|------------|--------|
| Prompt Cache | cache_control markers + break detection | 自动 prefix caching | cache_control markers |
| Tool Schema Cache | session-scoped 锁定 | 无 | 无 |
| Token Counter | 增量 SHA-256 | 增量 SHA-256 | 全量计算 |
| Cache Metrics | 基础日志 | 7 provider 归一化 | 基础日志 |

---

## 4. UX 专家视角 — 交互体验

### 4.1 三项目 UX 设计哲学

| 维度 | claude-code | openclaude | oh-my-claudecode |
|------|------------|------------|-----------------|
| 核心理念 | 透明度+控制权 | 协议集成+工具链 | 自动化+行为引导 |
| 交互风格 | 命令驱动(/btw, /fork) | 协议驱动(deep link) | 钩子驱动(hook 拦截) |
| 上下文管理 | 可视化+折叠+缓存 | 基准测试辅助选型 | 启动快照+空消息消毒 |
| 用户引导 | 显式命令+建议 | 环境检测+自动适配 | 魔法关键词+续行强制 |

### 4.2 ola-cc 已覆盖

/btw, /fast, /effort, /fork, /context, /tag, HooksConfigMenu, FeedbackSurvey, ContextVisualization, ContextCollapse, shellCompletion, deepLink

### 4.3 ola-cc 尚未覆盖的高价值功能

| 功能 | 来源 | UX 价值 |
|------|------|---------|
| codebase-map | OMC | 启动即知项目结构，减少 30-50% 盲目探索 |
| empty-message-sanitizer | OMC | 消除 Ctrl-C 后的 API 400 错误 |
| agent-usage-reminder | OMC | 教育性反馈，引导用户使用并行 agent |
| magic-keywords | OMC | 自然语言意图自动映射增强行为 |
| session-history-search | OMC | 跨会话知识检索 |
| continuation-enforcement | OMC | 防止 agent 过早停止 |
| non-interactive-env | OMC | CI 环境自动适配 |
| benchmark | openclaude | 模型性能量化对比 |

### 4.4 交互模式创新

**Side Question (/btw)**: 缓存复用 — 复用主线已发送的精确字节实现 prompt cache hit，侧问零额外成本。

**Magic Keywords**: 信息意图过滤 — 如果关键词出现在 "what is X" 上下文中不触发增强，避免误触发。

**Context Visualization**: API 视角对齐 — 显示模型实际看到的上下文而非原始消息，避免 token 数虚高误导。

**Codebase Map**: 启动快照 — 200 文件上限 + 4 层深度 + 57 种扩展名过滤 + 16 个重要文件始终包含。

---

## 5. 安全专家视角 — 安全加固

### 5.1 安全功能清单

| 功能 | 来源 | 防护对象 | ola-cc 现状 |
|------|------|---------|-------------|
| LocalVault | claude-code | API 密钥/OAuth 令牌 | 无独立 vault |
| OS Keychain | claude-code | 凭据持久化 | 未实现 |
| Secret Scanner | openclaude | 团队记忆上传前凭据泄露 | 无 |
| URL Redaction | openclaude | 日志中敏感 URL 参数 | 无 |
| SSRF Guard | openclaude | HTTP hook 内网穿透 | 无 |
| Bash Dangerous Patterns | claude-code | 危险命令执行 | treeSitter 但无列表 |
| Read-Only Validation | claude-code | 只读命令越权(40+命令) | 基础分类 |
| UNC Path Detection | claude-code | Windows NTLM 凭据泄露 | 未实现 |
| Factcheck Guard | OMC | 代码变更声明真实性 | 无 |
| Verification Tier | OMC | 变更复杂度与审查力度匹配 | 无 |
| Sentinel Gate | OMC | 合并前质量门控 | 无 |
| Error Classification | openclaude | API 错误精确分类(13类) | 基础处理 |
| Codex/xAI OAuth | openclaude | 安全认证(PKCE+Device Code) | 无 OAuth |

### 5.2 LocalVault 安全不变量

| ID | 不变量 | 实现 |
|----|--------|------|
| D1 | 值大小上限 64KB | 强制检查 |
| B1 | derived key 使用后清零 | key256.fill(0) |
| F3 | AAD 绑定 entry key | 防记录交换攻击 |
| H3 | UTF-8 有效性验证 | TextDecoder fatal:true |
| C1 | 原子写入 | tmp + renameSync |
| C5 | passphrase 排他创建 | {flag:'wx'} |

### 5.3 SSRF Guard 防护范围

阻止: 10.x, 172.16-31.x, 192.168.x, 169.254.x(云元数据), ::ffff:(IPv4-mapped IPv6), fc00::/7, fe80::/10
允许: 127.0.0.0/8, ::1(loopback)

关键设计: `ssrfGuardedLookup` 作为 axios lookup 选项，消除验证与连接之间的 TOCTOU 窗口。

### 5.4 Read-Only Validation 安全修复亮点

1. git diff -S 漏洞修复: 防止任意文件写入
2. git ls-remote --server-option 排除: 阻止网络数据外泄
3. gh 命令网络外泄防护: 检测 HOST/OWNER/REPO 格式防 DNS 编码外泄
4. xargs 短标志捆绑修复: GNU getopt 语义差异导致的 RCE
5. UNC 路径检测: 8 种模式防 NTLM 凭据泄露

---

## Feature Flags 汇总

| Phase | 功能 | Flag | 默认 |
|-------|------|------|------|
| 1 | ThinkTag Sanitizer | OLA_CC_THINK_TAG_SANITIZER | off |
| 1 | Empty Message Sanitizer | OLA_CC_EMPTY_MSG_SANITIZER | off |
| 1 | Commit-Push-PR | OLA_CC_COMMIT_PUSH_PR | off |
| 2 | Magic Keywords | OLA_CC_MAGIC_KEYWORDS | off |
| 2 | Performance Optimization | 见 performance-optimization-design.md | off |
| 2 | Memory Lifecycle | 见 memory-lifecycle-design.md | off |
| 3 | Agent Routing | OLA_CC_AGENT_ROUTING | off |
| 3 | Context UX | 见 context-ux-commands-design.md | off |
| 4 | Security Hardening | 见 security-hardening-design.md | off |
| 4 | ACP Vault | 见 acp-vault-design.md | off |
| 5 | Ecosystem | 见 ecosystem-extensibility-design.md | off |

---

## 6. 统一实施路线图

### Phase 1 (1-2 天, 高 ROI 快速落地)

| 功能 | 工作量 | 难度 | 来源 | 理由 |
|------|--------|------|------|------|
| Magic Keywords | M(500+行) | M | OMC | 零成本 UX 提升 |
| Commit-Push-PR | S(100行) | S | claude-code | 高频刚需 |
| Empty Message Sanitizer | S(50行) | XS | OMC | 消除 API 错误 |
| ThinkTag Sanitizer | S(163行) | S | openclaude | 兼容 reasoning 模型 |

### Phase 2 (3-5 天, 核心能力建设)

| 功能 | 工作量 | 难度 | 来源 | 理由 |
|------|--------|------|------|------|
| Session History Search | M(500行) | M | OMC | 跨会话知识检索 |
| Verification Protocol | M(400行) | M | OMC | 标准化验证 |
| Model Routing | M(600行) | M | OMC | 节省 30%+ token |
| Error Classification | M(387行) | M | openclaude | 精确错误提示 |
| Codebase Map | M(272行) | M | OMC | 启动即知项目结构 |

### Phase 3 (1-2 周, 安全+性能基础设施)

| 功能 | 工作量 | 难度 | 来源 | 理由 |
|------|--------|------|------|------|
| LocalVault | L(468行) | L | claude-code | 密钥加密存储 |
| SSRF Guard | M(283行) | M | openclaude | 内网穿透防护 |
| Secret Scanner | M(34规则) | M | openclaude | 凭据泄露防护 |
| Cache Metrics | M(300行) | M | openclaude | 多 provider 缓存归一化 |
| Incremental Token Counter | M(200行) | M | openclaude | 80% CPU 开销降低 |
| Compress Tool History | M(300行) | M | openclaude | 40-60% token 减少 |

### Phase 4 (2-3 周, 记忆+执行管线)

| 功能 | 工作量 | 难度 | 来源 | 理由 |
|------|--------|------|------|------|
| Memory Router | L(500行) | L | 混合 | 三作用域+三区混合模型 |
| Dream 记忆整合 | L(800行) | L | openclaude | 跨会话记忆合成 |
| Goal + AutoFix 融合 | L(600行) | L | 混合 | 代码质量门控 |
| Notepad Wisdom | M(300行) | M | OMC | 计划级笔记 |
| Continuation Enforcement | M(200行) | M | OMC | 防止过早停止 |

### Phase 5 (3-4 周, 生态+可观测性)

| 功能 | 工作量 | 难度 | 来源 | 理由 |
|------|--------|------|------|------|
| Context Visualization | M(移植) | M | claude-code | 上下文透明度 |
| Session Replay | M(400行) | M | OMC | 瓶颈分析 |
| MCP Tool Exporter | M(300行) | M | 混合 | Singularity API 暴露 |
| Skill Hooks | M(400行) | M | OMC | Skill lifecycle hooks |
| Task Decomposer | L(1000行) | L | OMC | 大任务并行执行 |

**Phase 依赖关系**:
- Phase 1 内部: ThinkTag Sanitizer 和 Empty Message Sanitizer 无依赖，可并行
- Phase 1 → Phase 2: Magic Keywords 依赖 ThinkTag Sanitizer 的标签过滤能力
- Phase 2 内部: Performance Optimization 和 Memory Lifecycle 无依赖，可并行
- Phase 2 → Phase 3: Agent Routing 依赖 Phase 2 的 Performance Optimization（共享 query.ts 修改）
- Phase 3 → Phase 4: Security Hardening 依赖 Phase 3 的 Provider Extension（Keychain 共享）
- Phase 4 → Phase 5: Ecosystem 工具依赖 Phase 1-4 核心功能稳定
- 可并行组: [Phase 1a: ThinkTag + EmptyMsg] || [Phase 1b: Commit-Push-PR]

---

### 6.1 LOC 估算总表

| Phase | 功能 | 新增 LOC | 修改 LOC | 难度 | 专项文档 |
|-------|------|---------|---------|------|---------|
| 1 | Magic Keywords | ~500 | ~30 | M | magic-keywords-design.md |
| 1 | Commit-Push-PR | ~100 | ~20 | S | commit-push-pr-design.md |
| 1 | Empty Message Sanitizer | ~50 | ~10 | XS | empty-msg-sanitizer-design.md |
| 1 | ThinkTag Sanitizer | ~163 | ~15 | S | think-tag-sanitizer-design.md |
| **Phase 1 小计** | — | **~813** | **~75** | — | — |
| 2 | Session History Search | ~500 | ~40 | M | session-history-search-design.md |
| 2 | Verification Protocol | ~400 | ~30 | M | verification-protocol-design.md |
| 2 | Model Routing | ~600 | ~50 | M | model-routing-design.md |
| 2 | Error Classification | ~387 | ~25 | M | error-classification-design.md |
| 2 | Codebase Map | ~272 | ~20 | M | codebase-map-design.md |
| **Phase 2 小计** | — | **~2159** | **~165** | — | — |
| 3 | LocalVault | ~468 | ~30 | L | acp-vault-design.md |
| 3 | SSRF Guard | ~283 | ~20 | M | ssrf-guard-design.md |
| 3 | Secret Scanner | ~200 | ~15 | M | secret-scanner-design.md |
| 3 | Cache Metrics | ~300 | ~25 | M | cache-metrics-design.md |
| 3 | Incremental Token Counter | ~200 | ~15 | M | perf-optimization-design.md |
| 3 | Compress Tool History | ~300 | ~20 | M | perf-optimization-design.md |
| **Phase 3 小计** | — | **~1751** | **~125** | — | — |
| 4 | Memory Router | ~500 | ~40 | L | memory-lifecycle-design.md §5-6 |
| 4 | Dream 记忆整合 | ~800 | ~60 | L | memory-lifecycle-design.md §3 |
| 4 | Goal + AutoFix 融合 | ~600 | ~50 | L | goal-autofix-design.md |
| 4 | Notepad Wisdom | ~300 | ~20 | M | notepad-wisdom-design.md |
| 4 | Continuation Enforcement | ~200 | ~15 | M | continuation-design.md |
| **Phase 4 小计** | — | **~2400** | **~185** | — | — |
| 5 | Context Visualization | ~350 | ~30 | M | context-ux-design.md |
| 5 | Session Replay | ~400 | ~25 | M | session-replay-design.md |
| 5 | MCP Tool Exporter | ~300 | ~20 | M | mcp-exporter-design.md |
| 5 | Skill Hooks | ~400 | ~30 | M | skill-hooks-design.md |
| 5 | Task Decomposer | ~1000 | ~80 | L | task-decomposer-design.md |
| **Phase 5 小计** | — | **~2450** | **~185** | — | — |
| **总计** | — | **~9573** | **~735** | — | — |

---

### 6.2 核心代码骨架

#### 6.2.1 MemoryRouter 路由逻辑

```typescript
// src/services/memory/MemoryRouter.ts

import type { MemoryEntry, RouteDecision, MemoryRouterConfig, ConversationContext } from './types.js'

export class MemoryRouterImpl implements MemoryRouter {
  config: MemoryRouterConfig

  constructor(config?: Partial<MemoryRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  route(entry: MemoryEntry, context: ConversationContext): RouteDecision {
    const scope = this.determineScope(entry, context)
    const zone = this.determineZone(entry, scope)
    const reason = `scope=${scope} (keyword:${entry.metadata?.keywords?.length || 0}), zone=${zone}`
    return { targetScope: scope, targetZone: zone, reason, confidence: 0.85 }
  }

  private determineScope(entry: MemoryEntry, ctx: ConversationContext): 'local' | 'project' | 'user' {
    // 规则 1: 显式标注优先
    if (entry.metadata?.scope) return entry.metadata.scope as 'local' | 'project' | 'user'

    // 规则 2: 项目路径匹配
    if (entry.content.includes(ctx.projectPath)) return 'project'

    // 规则 3: 用户偏好关键词
    const userKeywords = ['prefer', 'always', 'never', 'style', '习惯', '偏好']
    if (userKeywords.some(k => entry.content.toLowerCase().includes(k))) return 'user'

    // 规则 4: 默认 project
    return 'project'
  }

  private determineZone(entry: MemoryEntry, scope: 'local' | 'project' | 'user'): 'priority' | 'working' | 'manual' {
    // local scope → priority zone (高频上下文)
    if (scope === 'local') return 'priority'

    // user scope → manual zone (需显式管理)
    if (scope === 'user') return 'manual'

    // project scope → working zone (7天衰减)
    const age = Date.now() - entry.lastAccessedAt
    if (age < this.config.zones.working.retentionMs) return 'working'

    // 超期降级到 manual
    return 'manual'
  }

  applyDecay(): void { /* 调用 entry.accessCount *= config.zones.working.decayFactor */ }

  enforceCapacity(): void {
    /* Priority Context 超过 500 字符时，最旧条目溢出到 Working Memory */
  }
}
```

#### 6.2.2 Phase 依赖检查器

```typescript
// scripts/phase-dependency-check.ts

interface PhaseStatus {
  phase: number
  features: Array<{ name: string; flag: string; implemented: boolean }>
  canStart: boolean
  blockingDeps: number[]
}

function checkPhaseDependencies(phases: PhaseStatus[]): PhaseStatus[] {
  return phases.map(phase => {
    const blockingDeps: number[] = []

    // Phase N 依赖 Phase N-1 完成
    if (phase.phase > 1) {
      const prevPhase = phases.find(p => p.phase === phase.phase - 1)
      if (prevPhase && !prevPhase.features.every(f => f.implemented)) {
        blockingDeps.push(prevPhase.phase)
      }
    }

    // Phase 内部依赖检查
    for (const feature of phase.features) {
      const deps = PHASE_INTERNAL_DEPS[feature.name] || []
      for (const dep of deps) {
        const depFeature = phase.features.find(f => f.name === dep)
        if (depFeature && !depFeature.implemented) {
          feature.implemented = false  // 未满足内部依赖
        }
      }
    }

    return { ...phase, canStart: blockingDeps.length === 0, blockingDeps }
  })
}

// Phase 内部依赖映射
const PHASE_INTERNAL_DEPS: Record<string, string[]> = {
  'Magic Keywords': ['ThinkTag Sanitizer'],      // P1: 依赖标签过滤
  'Session History Search': ['Codebase Map'],     // P2: 依赖项目结构
  'Model Routing': ['Error Classification'],      // P2: 依赖错误分类选模型
  'Memory Router': ['Dream 记忆整合'],             // P4: 依赖整合能力
}

// 使用示例
const phases = loadPhaseStatus()  // 从 feature flags + 代码扫描
const result = checkPhaseDependencies(phases)
console.table(result.map(p => ({
  Phase: p.phase,
  '可开始': p.canStart ? '✅' : '❌',
  '阻塞': p.blockingDeps.length ? `Phase ${p.blockingDeps.join(',')}` : '无',
  '完成度': `${p.features.filter(f => f.implemented).length}/${p.features.length}`
})))
```

---

### 6.3 实施难度标注说明

| 难度 | 预估工时 | 特征 |
|------|---------|------|
| XS | < 0.5 天 | 单文件修改，无新依赖 |
| S | 0.5-1 天 | 1-2 个新文件，简单逻辑 |
| M | 1-3 天 | 3-5 个新文件，需跨模块集成 |
| L | 3-7 天 | 5+ 个新文件，复杂状态管理或安全约束 |
| XL | > 1 周 | 全新子系统，需架构设计评审 |

---

## 7. ola-cc 应保留的独有优势

| 优势 | 说明 |
|------|------|
| compactModelRouter | 智能压缩模型路由 |
| getCacheStrategy() | 缓存策略引擎 |
| isThirdPartyProvider() | 第三方 provider 检测 |
| assembleToolPool | 注册模式工具池组装 |
| ASAEF | Agent 进化系统(8 阶段状态机) |
| Goal 系统 | ReAct 目标编排器 + 收敛检测 + 错误熔断 |
| 4 阶段 CompactProgressEvent | 比 claude-code 多 1 阶段 |
| ResourceQuotaManager | 资源配额管理 |
| SingularityTool 34 API | 评分/遥测/注册表/门控/审计 |
| EvolutionEngine | L1→L2→L3 分层推进 + Early Stopping |
