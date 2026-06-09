# ACP 协议与安全存储设计

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: claude-code
**Priority**: P1
**Effort**: L

---

## 1. 概述

ACP (Agent Client Protocol) 使 Claude Code 可被外部 IDE（如 Zed）作为后台 agent 调用。LocalVault 提供安全的本地密钥存储。

---

## 2. ACP Agent Client Protocol (P1)

**Source**: `/Users/heal/claude-code/src/services/acp/` (4 files, 1048+75+1332+286 LOC)

### 2.1 架构

```
IDE (Zed) ←NDJSON→ stdin/stdout ←→ AcpAgent ←→ QueryEngine
                                              ↓
                                        SessionUpdate → IDE
```

### 2.2 核心组件

| 组件 | 职责 |
|------|------|
| `agent.ts` | ACP Agent 实现，管理多会话生命周期 |
| `entry.ts` | 入口点，建立 stdio 传输通道 |
| `bridge.ts` | SDKMessage → SessionUpdate 转换 |
| `permissions.ts` | 权限系统映射 |

### 2.3 AcpSession 状态

```typescript
type AcpSession = {
  queryEngine: QueryEngine
  cancelled: boolean
  cancelGeneration: number
  cwd: string
  pendingMessages: Map<string, PendingPrompt>
  pendingQueue: string[]
  toolUseCache: ToolUseCache
  clientCapabilities?: ClientCapabilities
}
```

### 2.4 ACP NDJSON 消息格式

ACP 协议使用 NDJSON（Newline Delimited JSON）格式通过 stdin/stdout 通信，每行一个完整 JSON 对象。

```typescript
// 完整的 ACP 消息类型定义
type AcpMessage =
  | { type: 'session_update', payload: SessionUpdate }
  | { type: 'agent_prompt', payload: { text: string, context?: string } }
  | { type: 'agent_response', payload: { text: string, tool_calls?: ToolCall[] } }
  | { type: 'heartbeat', payload: { timestamp: string } }
  | { type: 'error', payload: { code: string, message: string } }

type SessionUpdate =
  | { action: 'start', sessionId: string, model: string }
  | { action: 'stop', sessionId: string, reason: string }
  | { action: 'compact', sessionId: string }
  | { action: 'progress', sessionId: string, turn: number, tokens: number }

// 消息流向
// IDE → Claude Code: agent_prompt, session_update (start/stop)
// Claude Code → IDE: agent_response, session_update (progress/compact), heartbeat, error

// NDJSON 序列化/反序列化
function serializeAcpMessage(msg: AcpMessage): string {
  return JSON.stringify(msg) + '\n'
}

function* deserializeAcpStream(chunk: string): Generator<AcpMessage> {
  for (const line of chunk.split('\n').filter(Boolean)) {
    yield JSON.parse(line) as AcpMessage
  }
}
```

**心跳机制**: Claude Code 每 30 秒发送 heartbeat 消息，IDE 用于检测 agent 存活状态。IDE 超过 90 秒未收到 heartbeat 则认为 agent 断开，触发重连。

**错误码定义**:

| Code | 含义 | 触发条件 |
|------|------|---------|
| `SESSION_NOT_FOUND` | 会话不存在 | 引用了已停止的 sessionId |
| `PERMISSION_DENIED` | 权限拒绝 | 用户拒绝了权限请求 |
| `MODEL_ERROR` | 模型错误 | API 调用失败 |
| `CONTEXT_OVERFLOW` | 上下文溢出 | 超出 token 限制且 compact 失败 |
| `INTERNAL_ERROR` | 内部错误 | 未预期异常 |

### 2.5 Prompt 队列机制

当一个 prompt 正在运行时，后续 prompt 被挂起：
- `pendingMessages`: 存储待处理 prompt
- `pendingQueue`: 队列顺序
- `pendingQueueHead`: 消费指针
- `compactPendingQueue()`: 惰性压缩（当 head > 1024 且消耗过半时触发 slice）

### 2.6 Bridge 层

`forwardSessionUpdates()` 将 SDKMessage 流转换为 ACP SessionUpdate：

| SDKMessage | SessionUpdate |
|------------|---------------|
| `system` | 处理 compact_boundary |
| `result` | 累加 usage，计算 stopReason |
| `stream_event` | 流式转发（content_block_start/delta） |
| `assistant` | 完整消息转换 |
| `progress` | 子代理进度转发 |

### 2.7 权限映射

```typescript
// Claude Code 权限 → ACP 权限
hasPermissionsToUseTool() → allow/deny → 直接返回
hasPermissionsToUseTool() → ask → conn.requestPermission()
```

支持 6 种权限模式：auto/default/acceptEdits/bypassPermissions/dontAsk/plan

### 2.7 Integration

| File | Operation |
|------|-----------|
| `src/services/acp/` | **New** — 4 files |
| `src/entrypoints/cli.tsx` | Modify — 添加 ACP 子命令 |
| `src/tools/AgentTool/` | Modify — ACP 子代理支持 |

---

## 3. LocalVault 加密存储 (P1)

**Source**: `/Users/heal/claude-code/src/services/localVault/` (2 files, 468+134 LOC)

### 3.1 双层架构

```
setSecret(key, value) → keychain 优先 → 失败降级到 AES-256-GCM 文件
getSecret(key)        → keychain 优先 → 失败从文件解密
```

### 3.2 加密参数

| 参数 | 值 |
|------|------|
| 算法 | AES-256-GCM |
| IV | 每条记录独立随机 12 字节 |
| AAD | entry key（防记录交换攻击） |
| KDF | scryptSync (N:16384, r:8, p:1) |
| Salt | per-vault 16 字节随机 salt |
| 值上限 | 64KB |

### 3.3 Passphrase 优先级

1. `CLAUDE_LOCAL_VAULT_PASSPHRASE` 环境变量
2. `~/.claude/.local-vault-passphrase` 文件
3. 自动生成

### 3.4 安全不变量

| ID | 不变量 |
|----|--------|
| D1 | 值大小上限 64KB |
| B1 | derived key 使用后零化 `key256.fill(0)` |
| F3 | AAD 绑定 entry key |
| H3 | `TextDecoder('utf-8', { fatal: true })` 检测无效 UTF-8 |

### 3.5 明文 API Key 迁移路径

现有明文 API key 升级后自动迁移到 LocalVault：首次启动时检测 `~/.claude/settings.json` 中的明文 key，自动加密存储到 LocalVault，删除明文。旧格式继续支持（降级读取）。

迁移流程：
1. 读取 `settings.json` 中的 `apiKey` / `anthropicApiKey` 字段
2. 调用 `setSecret('anthropic-api-key', value)` 存入 LocalVault
3. 删除 `settings.json` 中的明文字段，写入标记 `"vaultMigrated": true`
4. 后续读取时，先检查 LocalVault，不存在则检查 `settings.json` 旧格式（降级）

### 3.6 原子写入

```typescript
// tmp 文件 + POSIX 原子 rename
writeFileSync(tmpPath, data)
renameSync(tmpPath, realPath)

// 文件排他创建防并发
{ flag: 'wx' }
```

### 3.7 Keychain 封装

```typescript
const tryKeychain = {
  set(account, value),
  get(account),
  delete(account),
  list(),              // __index__ 专用 account 存储 key 列表
  _addToIndex(account),
  _removeFromIndex(account),
}
```

惰性模块加载：`_mod` 三态缓存（`'not-tried'`/`null`/`KeyringModule`）

**`__index__` 损坏恢复**: index 损坏时，通过遍历所有 keychain account（`security find-generic-password -s "claude-"`）重建 index。恢复流程：检测 index 读取异常 → 执行 `security find-generic-password -s "claude-code-vault" | grep "acct"` → 解析所有 account 名称 → 重建 `__index__` 条目 → 写回 keychain。

### 3.8 Integration

| File | Operation |
|------|-----------|
| `src/services/localVault/` | **New** — 2 files |
| `src/commands/auth.ts` | Modify — 使用 LocalVault 存储 token |
| `src/services/api/claude.ts` | Modify — 从 LocalVault 读取 API key |

---

## 4. 架构师视角

### 4.1 ACP 协议栈

```
应用层:    IDE (Zed, VS Code)
协议层:    ACP (NDJSON over stdio)
桥接层:    bridge.ts (SDKMessage → SessionUpdate)
引擎层:    QueryEngine
工具层:    Tools + Commands
```

### 4.2 安全架构

```
用户输入:   API Key / Token
存储层:     LocalVault (keychain + AES-256-GCM)
传输层:     TLS (API 调用)
访问控制:   ACP permissions (6 种模式)
```

### 4.3 ola-cc 适配

- ACP：ola-cc 已有 MCP server 模式，ACP 可作为补充的 IDE 集成协议
- LocalVault：可直接替代当前的明文 API key 存储

### 4.4 ACP 与 MCP 共存策略

当 IDE 同时通过 MCP 和 ACP 连接时，ACP 优先处理 agent 通信，MCP 专注工具暴露。session 状态通过 `sessionId` 隔离，避免两个协议的 session 互相干扰。具体分工：

| 协议 | 职责 | 通信方式 |
|------|------|---------|
| ACP | Agent 生命周期管理、prompt 队列、权限请求 | NDJSON over stdio |
| MCP | 工具暴露、资源访问、prompt 模板 | JSON-RPC over stdio/HTTP |

---

## 5. Feature Flags 与向后兼容

### 5.1 Feature Flag 定义

| Flag | 默认值 | 控制范围 | 引入方式 |
|------|--------|---------|---------|
| `ACP_VAULT` | `off` | ACP 凭证安全存储（LocalVault 加密写入/读取） | `scripts/build.ts` compile-time gate |
| `ACP_KEYCHAIN` | `off` | OS Keychain 集成（macOS Keychain / Linux libsecret / Windows DPAPI） | `scripts/build.ts` compile-time gate |

**注册位置**: `scripts/build.ts` 的 feature set 定义，使用 `feature('ACP_VAULT')` / `feature('ACP_KEYCHAIN')` 在 bundle 阶段做 dead code elimination。

### 5.2 降级策略

| Flag 状态 | 降级行为 | 用户感知 |
|-----------|---------|---------|
| `ACP_VAULT=off` | 回退到 LocalVault 明文存储（`~/.claude/secrets.json`，文件权限 0600） | API Key 存储在本地文件中，无加密 |
| `ACP_KEYCHAIN=off` | 跳过 Keychain 尝试，直接使用 AES-256-GCM 文件加密 | 无 OS keychain 集成，仅文件加密 |
| `ACP_VAULT=off` + `ACP_KEYCHAIN=off` | 完全回退到环境变量 / settings.json 明文读取 | 与当前 ola-cc 行为一致 |

**降级链路**:
```
setSecret(key, value):
  if feature('ACP_KEYCHAIN') → tryKeychain.set()
    ↓ 失败
  if feature('ACP_VAULT')    → AES-256-GCM 文件加密写入
    ↓ off
  fallback                    → 明文写入 ~/.claude/secrets.json (0600)

getSecret(key):
  if feature('ACP_KEYCHAIN') → tryKeychain.get()
    ↓ miss
  if feature('ACP_VAULT')    → AES-256-GCM 文件解密读取
    ↓ off
  fallback                    → 明文读取 ~/.claude/secrets.json
```

---

## 6. 产品经理视角

### 6.1 用户价值

| 功能 | 解决的痛点 | 用户感知 |
|------|-----------|---------|
| ACP | "想在 IDE 里用 Claude Code" | Zed 等 IDE 原生集成 |
| LocalVault | "API key 明文存储不安全" | OS keychain 加密存储 |

### 6.2 竞品对比

| 能力 | claude-code | ola-cc 当前 | 差距 |
|------|------------|------------|------|
| IDE 集成 | ✅ ACP + MCP | ✅ MCP only | 轻微 |
| 密钥存储 | ✅ LocalVault | ❌ 明文/env | **关键缺失** |

---

## 7. 实施路线图

| Phase | 功能 | 优先级 | 依赖 |
|-------|------|--------|------|
| Phase 1 | LocalVault | P1 | @napi-rs/keyring |
| Phase 2 | ACP Agent | P1 | QueryEngine |
| Phase 3 | ACP Bridge + Permissions | P1 | Phase 2 |

### 7.1 LOC 估算

| 模块 | 文件 | 估算 LOC | 难度 | 说明 |
|------|------|---------|------|------|
| LocalVault 核心 | `src/services/localVault/localVault.ts` | ~470 | M | AES-256-GCM 加密/解密、passphrase 管理、原子写入 |
| Keychain 封装 | `src/services/localVault/keychain.ts` | ~135 | M | macOS/Linux/Windows 三平台 keychain API 封装 |
| ACP Agent | `src/services/acp/agent.ts` | ~1050 | H | 多会话生命周期管理、prompt 队列、心跳机制 |
| ACP Entry | `src/services/acp/entry.ts` | ~75 | L | stdio 传输通道建立 |
| ACP Bridge | `src/services/acp/bridge.ts` | ~1330 | H | SDKMessage → SessionUpdate 转换、流式转发 |
| ACP Permissions | `src/services/acp/permissions.ts` | ~285 | M | 6 种权限模式映射、请求/响应处理 |
| Feature flag 集成 | `scripts/build.ts` | ~30 | L | ACP_VAULT / ACP_KEYCHAIN flag 注册 |
| CLI 子命令 | `src/entrypoints/cli.tsx` | ~40 | L | `acp` 子命令分发 |
| **合计** | — | **~3415** | — | — |

---

## 8. @napi-rs/keyring Bun 兼容性说明

### 8.1 兼容性现状

`@napi-rs/keyring` 是 LocalVault 的 keychain 封装核心依赖，通过 N-API 绑定系统原生 keychain API。

| 平台 | 后端 | Bun 兼容性 | 说明 |
|------|------|-----------|------|
| macOS | Keychain Services | 已验证 | `security` CLI fallback 可用 |
| Linux | libsecret (Secret Service) | 已验证 | 需要 `secret-tool` 或 D-Bus |
| Windows | Windows Credential Manager | 已验证 | DPAPI + CurrentUser scope |

### 8.2 Bun 特殊处理

```typescript
// Bun 环境检测与 fallback
function createKeyringAccess(): KeyringAccess {
  if (typeof Bun !== 'undefined') {
    // Bun 环境: 优先使用 @napi-rs/keyring (N-API 兼容)
    // 若加载失败，降级到 CLI 方式
    try {
      return new NapiKeyringAccess()
    } catch {
      return new CliKeyringAccess()  // security/secret-tool/powershell
    }
  }
  // Node.js 环境: 直接使用 @napi-rs/keyring
  return new NapiKeyringAccess()
}
```

### 8.3 测试验证计划

| 测试类型 | 覆盖范围 | 优先级 |
|---------|---------|--------|
| 单元测试 | mock keyring API，验证 get/set/delete/list | P0 |
| 集成测试 | 真实 keychain 操作，macOS/Linux/Windows | P1 |
| Bun 兼容测试 | `bun test` 环境下运行完整测试套件 | P1 |
| 并发测试 | 多进程同时访问同一 keychain entry | P2 |
| 降级测试 | keychain 不可用时的文件加密 fallback | P1 |
| 迁移测试 | 明文 API key → LocalVault 自动迁移 | P1 |

```typescript
// 测试骨架
describe('LocalVault', () => {
  describe('keyring access', () => {
    it('should store and retrieve secret via keychain', async () => {
      const vault = createLocalVault()
      await vault.setSecret('test-key', 'test-value')
      const result = await vault.getSecret('test-key')
      expect(result).toBe('test-value')
    })

    it('should fallback to file encryption when keychain unavailable', async () => {
      // 模拟 keychain 不可用
      mockKeyringFailure()
      const vault = createLocalVault()
      await vault.setSecret('test-key', 'test-value')
      const result = await vault.getSecret('test-key')
      expect(result).toBe('test-value')
    })

    it('should work under Bun runtime', async () => {
      // 仅在 Bun 环境下运行
      if (typeof Bun === 'undefined') return
      const vault = createLocalVault()
      await vault.setSecret('bun-test', 'works')
      expect(await vault.getSecret('bun-test')).toBe('works')
    })
  })
})
```
