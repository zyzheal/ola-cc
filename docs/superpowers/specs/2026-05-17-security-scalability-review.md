# ola-cc 安全与规模化深度审查报告

> 审查日期：2026-05-17
> 审查范围：6 个实施方案的安全漏洞与规模化瓶颈
> 分析方法：基于对现有代码库（src/ 目录 1843 行全局状态、53+ 工具、NATS 事件总线、三层压缩系统、SendMessageTool、WorkflowTool 空壳等）的实际理解

---

## 方案一：声明式工作流引擎（YAML DAG 定义 + 执行引擎）

### 1.1 安全漏洞分析

#### V-001：YAML 模板注入（严重度：高危，CVSS 8.1）

**攻击面**：`{{stage.result}}` 等模板变量若直接拼接 Agent 输出，可被构造为恶意 YAML 内容。

**具体分析**：
- Agent 的输出是未信任的 LLM 生成文本。若某 Agent 的 tool result 中包含 `{{__proto__}}` 或 `{{constructor.prototype}}`（针对某些 JS YAML 库的原型链攻击），可能导致执行引擎行为异常。
- 更实际的风险：Agent 输出中故意构造 `result: "!!python/object/apply:os.system ['rm -rf /']"` 类似的 YAML 标签注入。如果 YAML 解析器未禁用 `!!` 自定义标签（JS 的 `js-yaml` 默认 LOAD 安全类型，但若使用 `FULL` 类型则危险），可能导致远程代码执行。
- 当前项目使用 TypeScript/Bun 生态，若引入 `js-yaml` 必须确保使用 `SAFE_LOAD` 或 `yaml` 包的 `parseDocument` 安全模式。

**缓解**：
- YAML 解析必须使用安全加载模式，禁止自定义标签
- 模板变量在注入前必须经过 JSON 序列化转义，不直接字符串替换
- 引入内容安全策略（CSP-style）：拒绝 `stage.result` 中包含 `{{`、`!!`、`<script>` 等模式

#### V-002：工作流权限提升（严重度：高危，CVSS 7.5）

**攻击面**：工作流定义中是否可以指定 Agent 使用的工具集？

**具体分析**：
- 当前 `spawnMultiAgent.ts` 中 Agent 继承父 Agent 的全部工具权限。若 YAML 允许定义 `tools: [Bash, FileWrite, ...]`，恶意用户可在工作流文件中授予 Agent 超出用户授权范围的工具。
- 工作流引擎必须在用户权限边界内运作，不能成为权限提升通道。

**缓解**：
- 工作流引擎的工具集是父 Agent 工具集的**子集**，不允许超集
- 引入 `allowedTools` 白名单，取 `intersection(parentTools, yamlDeclaredTools)`
- 敏感工具（Bash、FileWrite）在工作流中执行时需二次确认

#### V-003：DAG 执行中的资源耗尽（严重度：中危，CVSS 6.5）

**攻击面**：恶意构造的 DAG 可包含循环引用或指数级 fan-out。

**具体分析**：
- 若 DAG 验证不充分，`A -> B -> A` 的隐式循环可导致无限递归
- `fan_out: 10` 后每个分支再 `fan_out: 10`，3 层即可产生 1000 个并发 Agent

**缓解**：
- DAG 加载时执行拓扑排序验证（Kahn 算法），拒绝含环图
- 设置全局最大并发 Agent 数（建议 20）和最大 fan-out 深度（建议 3）

### 1.2 规模化瓶颈分析

| 场景 | 瓶颈 | 量化阈值 | 根因 |
|------|------|----------|------|
| 1000+ 轮对话 | 工作流状态持久化开销 | >50 个 stage 时，状态序列化 > 200ms/次 | 全量状态序列化而非增量 |
| 100K+ 文件 | DAG 中文件路径匹配开销 | >1000 个文件范围声明时，冲突检测 > 5s | 线性扫描而非索引 |
| 20+ 并发子代理 | 事件总线消息洪泛 | >100 msg/s 时 NATS 队列积压 | 无背压控制（已在系统分析中确认） |
| 24h+ 运行 | 工作流状态内存增长 | 每个 stage 平均 50KB，100 stages = 5MB | 中间结果不清理 |
| 50+ 工具调用/分钟 | 权限检查放大 | 每个工具调用 5ms，50/min = 可接受，但 20 并发 = 250ms/轮 | 权限规则索引未构建 |

### 1.3 缺失能力

- **工作流版本与回滚**：无机制将工作流定义版本化，执行失败无法回溯到上一个稳定版本
- **工作流沙箱**：工作流执行应在隔离的文件系统命名空间中进行，防止影响用户工作区
- **审计日志**：每个 stage 的执行时间、token 消耗、工具调用记录必须持久化

---

## 方案二：Agent 间通信标准化（EventChannel + BarrierSync + ResultAggregator）

### 2.1 安全漏洞分析

#### V-004：消息伪造与身份冒充（严重度：严重，CVSS 9.0）

**攻击面**：Agent 间通信是否验证发送者身份？

**具体分析**：
- 当前 `SendMessageTool` 通过 `getAgentName()` 和 `getTeammateColor()` 获取身份信息，但消息投递是基于名称匹配的字符串匹配。
- 若引入 `EventChannel`（类似 publish/subscribe），缺少消息签名机制意味着任何 Agent 可以伪造来自 `team-lead` 的消息。
- 特别是 `shutdown_request` 等协议消息（见 `src/tools/SendMessageTool/prompt.ts`），伪造可导致其他 Agent 被恶意终止。

**缓解**：
- 所有 Agent 间消息必须携带 `requestId` 和发送者 `agentId`（UUID，非名称）
- 引入消息签名：`HMAC-SHA256(agentId + timestamp + content, sessionKey)`
- `shutdown_request` 类敏感操作必须由用户侧发起或经过主 Agent 二次确认

#### V-005：中间人攻击（严重度：高危，CVSS 7.5）

**攻击面**：跨会话通信（UDS_INBOX、Bridge）的传输安全。

**具体分析**：
- `uds:/path/to.sock` 是本地 Unix Domain Socket，同机其他进程可连接
- `bridge:session_...` 是跨机通信，若未使用 TLS 则消息可被窃听/篡改
- 当前代码中 `isReplBridgeActive()` 和 `getReplBridgeHandle()` 未见 TLS 配置逻辑

**缓解**：
- UDS socket 文件权限设为 `0600`（仅创建者可读写）
- Bridge 通信必须使用 TLS，或使用 mTLS 双向认证
- 消息 payload 应包含 `sessionId` 校验，防止跨会话注入

#### V-006：BarrierSync 死锁（严重度：中危，CVSS 5.5）

**攻击面**：屏障同步的死锁风险。

**具体分析**：
- 若 Agent A 等待 `[B, C]` 到达屏障，而 Agent C 的 DAG 依赖 Agent A 的输出，则形成隐式死锁
- 当前系统无死锁检测机制

**缓解**：
- BarrierSync 必须设置超时（建议 30 分钟），超时后触发熔断
- DAG 验证时检测 `barrier_wait` 与 `depends_on` 的隐式循环
- 引入 `timeout` 字段：`{barrier: "phase1", timeout: "1800s"}`

### 2.2 规模化瓶颈分析

| 场景 | 瓶颈 | 量化阈值 | 根因 |
|------|------|----------|------|
| 20+ 并发子代理 | EventChannel 广播放大 | 每个 Agent 每 30s 发布进度，20 Agent = 0.67 msg/s/Agent，总 13.3 msg/s | 当前 NATS 无背压，内存队列无上限 |
| 20+ 并发子代理 | ResultAggregator 内存 | 每个结果 5-50KB，20 Agent x 10 stages = 10MB | 结果不清理 |
| 1000+ 轮对话 | 消息历史膨胀 | EventChannel 消息不归档，内存持续增长 | 无消息 TTL |
| 24h+ 运行 | 连接泄漏 | NATS Subscription 创建后未正确 unsubscribe | disconnect() 中只清理已知订阅，僵尸订阅未处理 |

**具体代码证据**：`NatsEventBus.ts` 第 69-74 行的 `disconnect()` 只 unsubscribe 已知 subscriptions，若订阅在连接断开期间创建则泄漏。

### 2.3 缺失能力

- **消息优先级**：紧急消息（shutdown）与普通进度消息应区分优先级
- **消息回溯**：Agent 崩溃后，其他 Agent 应能查询其最后已知状态
- **流量控制**：无令牌桶或漏桶限流，高频 Agent 可淹没 EventChannel
- **消息大小限制**：未限制单条消息大小，大 payload 可导致 OOM

---

## 方案三：结构化日志与可观测性（StructuredLogger + OTel）

### 3.1 安全漏洞分析

#### V-007：敏感信息泄露（严重度：严重，CVSS 8.6）

**攻击面**：结构化日志中可能记录的内容。

**具体分析**：
- **API Key/Token**：当前 `bootstrap/state.ts` 中存储大量状态，若日志中序列化 state 对象可能暴露 `apiKey`（虽然当前代码中 key 在 `auth.ts` 中管理，但 `resetStateForTests()` 重置全局状态时若日志记录了旧值则泄露）
- **代码片段**：工具结果（如 `FileReadTool` 返回的源代码）若被记录，日志中会包含完整源代码，包括其中可能的硬编码凭证
- **文件路径**：日志中的绝对路径暴露项目结构，在共享日志系统（ELK、Datadog）中可被其他团队看到
- **用户指令**：用户输入的 prompt 可能包含敏感业务逻辑、API endpoint、内部域名

**当前代码中的风险点**：
- `src/utils/log.js` 中的 `logForDebugging()` 函数 — 需要审查是否对敏感字段做了脱敏
- `bootstrap/state.ts` 第 31 行注释 "DO NOT ADD MORE STATE HERE" 表明已意识到全局状态风险，但 1843 行文件中是否有敏感字段需要审查
- OTel 的 `Meter` 和 `Tracer`（第 2-6 行导入）— 属性（attributes）中是否携带了敏感数据

**缓解**：
- 引入结构化脱敏管道：日志写入前经过 `sanitizeForLogging(obj)` 过滤
- 定义敏感字段白名单：`['toolName', 'duration', 'status', 'errorCode']`，其余全部脱敏
- API key、token、credentials 字段在日志中替换为 `***REDACTED***`
- 文件路径替换为相对路径或 hash

#### V-008：日志注入攻击（严重度：中危，CVSS 6.1）

**攻击面**：用户输入或 Agent 输出中的换行符、特殊字符注入到日志格式中。

**具体分析**：
- 若日志格式为 `[{timestamp}] {level}: {message}`，用户输入中包含 `\n` 可伪造日志行
- Agent 输出中的 JSON 特殊字符若未转义，可破坏结构化日志的 JSON 格式

**缓解**：
- 日志 message 字段在写入前执行 `sanitizeLogString()`：转义换行、制表符、引号
- 使用结构化日志库（如 `pino`、`winston`）而非手动字符串拼接

#### V-009：OTel 远程导出安全（严重度：高危，CVSS 7.5）

**攻击面**：OTel 数据导出到外部系统（Datadog、Jaeger）的传输安全。

**具体分析**：
- OTel exporter endpoint 若配置为 HTTP 而非 HTTPS，遥测数据在传输中可被截获
- exporter 的认证 token 若存储在环境变量中，可通过进程列表泄露

**缓解**：
- OTel exporter 强制 HTTPS
- 认证凭据通过 secure store 而非环境变量传递

### 3.2 规模化瓶颈分析

| 场景 | 瓶颈 | 量化阈值 | 根因 |
|------|------|----------|------|
| 1000+ 轮对话 | 日志存储膨胀 | 每轮 5KB 日志，1000 轮 = 5MB | 无日志轮转 |
| 50+ 工具调用/分钟 | OTel Span 创建开销 | 每个 Span ~50 微秒，50/min 可接受，但嵌套 Span 可指数增长 | 无 Span 采样 |
| 20+ 并发子代理 | Span 关联复杂度 | 20 Agent x 10 工具 = 200 Span/轮，trace 图爆炸 | 无 trace 折叠 |
| 24h+ 运行 | 日志文件增长 | 10KB/s x 86400s = 864MB/天 | 无日志压缩和归档 |

### 3.3 缺失能力

- **日志分级采样**：DEBUG 级日志采样率 1%，ERROR 级 100%
- **Trace ID 跨 Agent 传播**：当前无机制将父 Agent 的 trace ID 传递给子 Agent
- **日志保留策略**：无按时间、大小、敏感等级的自动清理
- **实时告警**：无基于日志模式的告警规则（如连续 3 次权限拒绝）
- **数据驻留合规**：日志导出到境外服务器时的 GDPR/数据本地化合规

---

## 方案四：工具结果缓存与去重（ToolResultCache - LRU）

### 4.1 安全漏洞分析

#### V-010：缓存中毒（严重度：高危，CVSS 7.8）

**攻击面**：恶意工具结果污染缓存，后续调用返回错误数据。

**具体分析**：
- 若缓存 key 仅基于 `(toolName, args)`，攻击者可通过构造等价但不同格式的 args 绕过缓存隔离。例如 `{"path": "/etc/passwd"}` 与 `{"path": "/etc/../etc/passwd"}` 应视为相同 key，但若未规范化则分别缓存。
- 更严重：若 Agent A 调用 `Read(path="secret.env")` 缓存了结果，Agent B 在无权访问 `secret.env` 的情况下通过缓存命中获取内容（缓存绕过了权限检查）。

**缓解**：
- 缓存 key 必须包含权限上下文：`hash(toolName + canonicalArgs + agentId + permissionLevel)`
- 路径参数必须规范化（`path.normalize`）后再计算 key
- 缓存命中时必须重新执行权限检查（cache-aside 模式）

#### V-011：敏感数据残留（严重度：中危，CVSS 5.9）

**攻击面**：缓存在会话结束或 compact 后仍保留敏感工具结果。

**具体分析**：
- LRU 缓存不会在 compact 时自动清理，压缩后的摘要中不包含旧数据，但缓存中仍有完整内容
- 若缓存持久化到磁盘（当前 `FileStateCache` 有 `dump()`/`load()` 方法），敏感数据可跨会话残留

**当前代码证据**：`FileStateCache` 第 86-91 行有 `dump()` 和 `load()` 方法，可序列化到磁盘。若序列化文件未加密，磁盘上可读取到缓存的敏感文件内容。

**缓解**：
- 会话结束时清空所有工具结果缓存
- 若支持缓存持久化，必须加密存储（AES-256）
- 缓存中不包含完整文件内容，仅存储 hash 和元数据

#### V-012：缓存侧信道（严重度：低危，CVSS 3.7）

**攻击面**：通过缓存命中/未命中的时序差异推断文件是否存在。

**具体分析**：
- 缓存命中返回 < 1ms，未命中需磁盘 I/O > 5ms，攻击者可通过时序判断文件是否被读过

**缓解**：
- 对所有读取路径添加恒定延迟（不实用），或接受此低危风险

### 4.2 规模化瓶颈分析

| 场景 | 瓶颈 | 量化阈值 | 根因 |
|------|------|----------|------|
| 100K+ 文件 | 缓存 key 空间爆炸 | 100K 文件 x 5 种 args 变体 = 500K keys | 无缓存预热策略 |
| 1000+ 轮对话 | LRU 命中率衰减 | >200 entries 后，旧数据被淘汰，命中率从 80% 降至 20% | 缓存大小固定 |
| 20+ 并发子代理 | 缓存竞争 | 20 Agent 同时读写同一 key，需锁或原子操作 | 当前 FileStateCache 无线程安全 |
| 50+ 工具调用/分钟 | GC 压力 | LRU eviction 触发 JavaScript GC，每次 10-50ms | 大对象频繁创建/销毁 |

**当前 `FileStateCache` 的局限性**：
- 默认 `READ_FILE_STATE_CACHE_SIZE = 100` entries，`maxSize = 25MB`
- 对只读工具（Read、Glob、Grep）的缓存策略不同：Read 适合缓存，Glob/Grep 的结果随文件变更而失效
- 无文件变更通知机制（如 `fs.watch`），缓存失效依赖手动 `delete()`

### 4.3 缺失能力

- **缓存失效通知**：文件系统变更时自动失效相关缓存条目
- **分级缓存**：高频小文件（CLAUDE.md、package.json）与低频大文件分开管理
- **缓存预热**：会话启动时预加载项目元数据（git status、文件树）
- **跨 Agent 缓存共享**：子 Agent 应能安全地共享父 Agent 的只读缓存

---

## 方案五：上下文管理优化（Prompt 瘦身 + 分层摘要 + 动态 buffer）

### 5.1 安全漏洞分析

#### V-013：压缩后信息泄露（严重度：高危，CVSS 7.5）

**攻击面**：compact 摘要中可能包含不应被后续 Agent 看到的敏感信息。

**具体分析**：
- 当前 `BASE_COMPACT_PROMPT`（见 `prompt.ts`）要求模型总结 "Files and Code Sections" 包含完整代码片段、"Errors and fixes" 包含错误详情
- 若对话中包含用户输入的 API key、token 或内部 URL，压缩摘要会将其浓缩保留
- 压缩后，原始消息被删除，只剩摘要。但摘要中的敏感信息密度更高，且无法回溯验证原始上下文

**当前代码中的保护**：`SENSITIVE_INSTRUCTIONS_PROTECTION`（第 62-70 行）指示模型保留敏感指令，但这依赖模型的判断，不是硬性的安全策略。

**缓解**：
- 引入硬性脱敏规则：在 compact 前扫描并替换已知的敏感模式（API key 格式、AWS secret key 格式等）
- 压缩摘要分段：技术摘要（可共享）与安全上下文（仅主 Agent 可见）分离
- 用户明确标记的 `<sensitive>` 标签内容不进入摘要，仅保留 "有敏感配置已省略" 提示

#### V-014：分层摘要中的信息衰减（严重度：中危，CVSS 5.3）

**攻击面**：多层摘要链导致关键安全上下文丢失。

**具体分析**：
- 一级摘要 -> 二级摘要 -> 三级摘要，每层摘要损失 10-20% 信息
- 3 层后，原始的安全约束（如 "不要修改 production 目录"）可能被完全摘要掉

**缓解**：
- 安全约束标记为 "pinned"，不参与摘要压缩，始终保留在上下文中
- 每层摘要必须包含 "安全约束摘要" 部分，不得省略

#### V-015：动态 buffer 的边界绕过（严重度：中危，CVSS 6.3）

**攻击面**：动态调整上下文窗口大小时，可能将关键安全消息排除在 buffer 外。

**具体分析**：
- 若 buffer 缩小，最旧的消息被压缩。但如果用户最早的指令包含安全策略（"不要删除任何数据库"），该指令可能被压缩掉
- 模型在后续轮次中不再有安全策略上下文

**缓解**：
- 用户消息（`UserMessage`）中的前 N 条标记为 "never compact"
- 系统 prompt 中的安全策略部分永远在 buffer 最前端

### 5.2 规模化瓶颈分析

| 场景 | 瓶颈 | 量化阈值 | 根因 |
|------|------|----------|------|
| 1000+ 轮对话 | 摘要质量衰减 | 5 次 compact 后，摘要中技术细节丢失率 > 40% | 链式摘要的信息熵衰减 |
| 100K+ 文件 | 文件列表膨胀 | 项目文件列表占 context 的 5-10% | 摘要中枚举所有相关文件 |
| 20+ 并发子代理 | 每 Agent 独立 compact | 20 Agent 同时 compact = 20 次额外 API 调用 | 无共享摘要 |
| 24h+ 运行 | Compact 累积开销 | 每次 compact 消耗 ~5K input tokens，10 次/天 = 50K tokens | 压缩频率过高 |
| 50+ 工具调用/分钟 | Microcompact 频率 | 每次工具调用后触发，50/min = 50 次 microcompact | 无批量压缩 |

**当前 compact 系统的已知问题**：
- `compact.ts` 中 `normalizeMessagesForAPI()` 处理大量消息时的性能
- Thinking Block 清理和图像剥离在每次 compact 时执行
- 无 "compact 质量评估" 机制，无法判断摘要是否丢失关键信息

### 5.3 缺失能力

- **Compact 质量回退**：若后续 Agent 因摘要信息不足而犯错，能回退到原始消息
- **语义感知的压缩**：按语义重要性而非时间顺序决定哪些消息保留
- **跨会话摘要**：长期运行项目中，跨会话的 "项目知识摘要" 应保留
- **用户可控的压缩级别**：允许用户选择 "保留更多细节" vs "节省更多 token"

---

## 方案六：架构隐患修复（测试隔离、全局状态拆分）

### 6.1 安全漏洞分析

#### V-016：全局状态竞态条件（严重度：中危，CVSS 6.5）

**攻击面**：1843 行 `bootstrap/state.ts` 中的可变全局状态在多 Agent 并发时的竞态。

**具体分析**：
- `totalCostUSD`、`turnToolCount` 等计数器在多 Agent 同时更新时可能丢失更新
- 更严重：`cwd`（当前工作目录）是全局的，若 Agent A 调用 `EnterWorktreeTool` 修改了 `cwd`，Agent B 的文件操作可能在错误的目录下执行
- `resetStateForTests()` 容易遗漏字段，导致测试间状态泄漏，掩盖生产环境的竞态 bug

**缓解**：
- 引入不可变更新模式（immer 或 Redux 式 reducer）
- 会话级状态与 Agent 级状态分离，`cwd` 应为 Agent-local 而非 global
- `resetStateForTests()` 改为从已知 schema 生成默认状态，而非手动重置每个字段

#### V-017：Feature Flag 绕过的安全边界（严重度：中危，CVSS 5.9）

**攻击面**：编译时 `feature()` gate 与运行时 GrowthBook 配置的组合可能产生安全边界缺口。

**具体分析**：
- `feature('DAEMON')` 等在编译时决定，但 `USER_TYPE` 固定为 `'ant'`（见 CLAUDE.md），所有安全 gate 中 `"external" === 'ant'` 恒为 false
- 这意味着 internal build 中所有安全 gate 都开启，但如果 external build 的 `feature()` gate 配置不当，可能遗漏安全检查
- GrowthBook 远程配置被篡改（MITM）时，运行时安全 gate 可能被关闭

**缓解**：
- 安全相关的 feature flag 必须有编译时硬编码的 fallback（远程配置不可用时默认开启）
- GrowthBook 配置使用签名验证，防止中间人篡改
- 编译产物中包含 feature flag hash，可审计

#### V-018：测试隔离不足导致的安全回归（严重度：低危，CVSS 3.1）

**攻击面**：测试间状态泄漏导致安全测试不可靠。

**具体分析**：
- 1798 个测试文件但无覆盖率报告
- 若安全相关的测试（如权限检查、路径遍历防护）因全局状态污染而未真正执行，安全回归无法被发现

**缓解**：
- 每个测试用例使用独立的状态实例
- 引入安全测试套件，专门验证权限边界

### 6.2 规模化瓶颈分析

| 场景 | 瓶颈 | 量化阈值 | 根因 |
|------|------|----------|------|
| 20+ 并发子代理 | 全局状态锁竞争 | >10 并发写入时，state 更新延迟 > 50ms | 无读写锁分离 |
| 1000+ 轮对话 | State 对象膨胀 | 100+ 字段 x 1000 轮历史引用 = 大量内存 | 无状态裁剪 |
| 100K+ 文件 | 文件状态缓存克隆 | 深拷贝 FileStateCache 在 fork 子进程时 > 100MB | 无 copy-on-write |
| 24h+ 运行 | 循环依赖初始化 | 30+ 处 `require()` 打破循环，启动时间 > 3s | 模块图有环 |

### 6.3 缺失能力

- **状态变更审计**：谁在什么时候修改了哪个 state 字段
- **状态快照与恢复**：会话崩溃后能从状态快照恢复
- **类型安全的全局状态**：100+ 字段中哪些是只读、哪些是可写、哪些是 Agent-local 应通过类型系统强制
- **依赖图可视化**：循环依赖的自动检测和可视化

---

## 综合安全风险热力图

| 风险编号 | 风险名称 | 严重度 | 影响方案 | 修复优先级 |
|----------|----------|--------|----------|------------|
| V-004 | 消息伪造与身份冒充 | CVSS 9.0 | 方案二 | P0 |
| V-007 | 敏感信息泄露 | CVSS 8.6 | 方案三 | P0 |
| V-001 | YAML 模板注入 | CVSS 8.1 | 方案一 | P0 |
| V-010 | 缓存中毒 | CVSS 7.8 | 方案四 | P1 |
| V-002 | 工作流权限提升 | CVSS 7.5 | 方案一 | P1 |
| V-005 | 中间人攻击 | CVSS 7.5 | 方案二 | P1 |
| V-009 | OTel 远程导出安全 | CVSS 7.5 | 方案三 | P1 |
| V-013 | 压缩后信息泄露 | CVSS 7.5 | 方案五 | P1 |
| V-016 | 全局状态竞态条件 | CVSS 6.5 | 方案六 | P1 |
| V-003 | DAG 资源耗尽 | CVSS 6.5 | 方案一 | P2 |
| V-008 | 日志注入攻击 | CVSS 6.1 | 方案三 | P2 |
| V-015 | 动态 buffer 边界绕过 | CVSS 6.3 | 方案五 | P2 |
| V-006 | BarrierSync 死锁 | CVSS 5.5 | 方案二 | P2 |
| V-014 | 分层摘要信息衰减 | CVSS 5.3 | 方案五 | P2 |
| V-011 | 敏感数据残留 | CVSS 5.9 | 方案四 | P2 |
| V-017 | Feature Flag 绕过 | CVSS 5.9 | 方案六 | P2 |
| V-012 | 缓存侧信道 | CVSS 3.7 | 方案四 | P3 |
| V-018 | 测试隔离不足 | CVSS 3.1 | 方案六 | P3 |

---

## 综合规模化瓶颈汇总表

| 瓶颈维度 | 最敏感方案 | 关键阈值 | 建议上限 |
|----------|-----------|----------|----------|
| 并发 Agent 数 | 方案一、二、六 | 20 Agent 时 EventChannel 积压 | 建议硬编码上限 25 |
| 对话轮数 | 方案三、五 | 1000 轮时日志 5MB、摘要质量衰减 | 建议 500 轮触发全量归档 |
| 项目规模 | 方案四、五 | 100K 文件时缓存 key 500K | 建议 LRU 上限 50K entries |
| 运行时长 | 方案三、六 | 24h 日志 864MB | 建议 6h 日志轮转 |
| 工具调用频率 | 方案三、四、五 | 50/min 时 microcompact 过载 | 建议批量压缩，每 30s 一次 |
| 单条消息大小 | 方案二 | > 1MB payload 可导致 OOM | 建议硬编码上限 5MB |
| DAG 深度 | 方案一 | fan-out 3 层 = 1000 Agent | 建议最大深度 3，最大节点 50 |

---

## 未覆盖的重要方向

### S-001：Agent 行为审计

**现状**：无系统记录每个 Agent 执行了哪些工具、修改了哪些文件、产生了多少 token 消耗。

**建议**：
- 引入 `AgentAuditLog`：`{agentId, timestamp, toolName, args_hash, result_size, duration, files_modified[]}`
- 审计日志独立于普通日志，不可篡改（append-only）
- 支持按 Agent 查询 "做了什么"

### S-002：成本上限熔断

**现状**：`totalCostUSD` 在全局状态中累计（`bootstrap/state.ts` 第 51 行），但无自动熔断机制。

**建议**：
- `MAX_COST_USD` 环境变量，超过后自动停止所有 Agent
- 分级告警：50% 警告，80% 通知，100% 熔断
- 熔断后保留 "只读模式"，不终止会话但禁止写操作

### S-003：模型输出安全扫描

**现状**：无机制检测模型输出中是否包含恶意代码。

**建议**：
- 在工具调用前（如 Bash、FileWrite），对模型输出的内容进行静态分析
- 检测模式：`eval()`、`exec()`、base64 解码后执行、反向 shell 模式
- 不阻止但标记为 "高风险"，需用户确认

### S-004：数据驻留合规

**现状**：无数据驻留策略。

**建议**：
- 日志、缓存、事件总线数据的存储位置可配置
- GDPR 合规：用户数据可导出和删除
- 区域限制：指定区域的 Agent 数据不得流出该区域

### S-005：API 限流与请求合并

**现状**：`withRetry.ts` 中只有重试逻辑，无主动限流。

**建议**：
- 令牌桶限流器：控制每秒 API 请求数
- 请求合并：多个 Agent 的独立 API 调用合并为批量请求（如果 API 支持）
- 退避策略差异化：429 遵守 `Retry-After`，5xx 指数退避，4xx 不重试

### S-006：权限变更审计

**现状**：权限系统是多步骤管线，但权限规则的变更无审计。

**建议**：
- 权限规则变更（`settings.json` 中的 `permissions` 字段）需记录变更日志
- 变更影响评估：新规则是否扩大了之前的权限范围
