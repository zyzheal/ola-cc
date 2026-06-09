# 质量与可靠性系统设计

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: openclaude + claude-code
**Priority**: P0/P1
**Effort**: M

---

## 1. 概述

质量与可靠性系统覆盖：自动修复（AutoFix）、推理标签清理（ThinkTag Sanitizer）、错误分类（Error Classification）、代理感知重试（FetchWithProxyRetry）、OAuth 认证（Codex/xAI）。

---

## 2. AutoFix 自动修复 (P0)

**Source**: `/Users/heal/openclaude/src/services/autoFix/` (3 files, 187+25+53 LOC)

### 2.1 核心机制

AI 编辑文件后自动运行 lint 和 test，将错误反馈给模型自修复。

```
file_edit/file_write → shouldRunAutoFix() → runAutoFixCheck() → buildAutoFixContext()
                                                              ↓
                                                   <auto_fix_feedback> 注入给模型
```

### 2.2 执行流程

1. **循环防护**：`shouldRunAutoFix()` 首先检查 `context.isAutoFixTriggered`，若为 `true` 则直接返回 `false`，防止 AutoFix 触发的工具调用再次触发 AutoFix 形成无限循环
2. **Lint-first 短路**：先跑 lint，失败则不跑 test
3. 跨平台进程终止：Unix `process.kill(-pid, SIGTERM)`，Windows `taskkill /T /F`
4. stdout/stderr 各截断到 10000 字符
5. 支持 AbortSignal 取消和 timeout 超时

```typescript
function shouldRunAutoFix(context: AutoFixContext): boolean {
  // 循环防护：AutoFix 产生的工具调用不再触发 AutoFix
  if (context.isAutoFixTriggered) return false
  if (!context.config.enabled) return false
  if (!context.config.lint && !context.config.test) return false
  return true
}
```

### 2.3 配置

```typescript
interface AutoFixConfig {
  enabled: boolean
  lint?: string      // lint 命令
  test?: string      // test 命令
  maxRetries: number // 0-10, 默认 3
  timeout: number    // 1000-300000ms, 默认 30000
}
```

Zod schema 校验：`enabled=true` 时 `lint` 和 `test` 至少有一个必须设置（非两者都必须）。

### 仅有 test 无 lint 时的行为

当项目无 lint 命令（`lint` 字段为空或未配置）时：
- 跳过 lint 阶段，直接执行 test 阶段
- 不视为错误，这是合法配置
- Zod 校验规则调整为：`lint` 和 `test` 至少有一个必须设置（非两者都必须）

### 2.4 反馈格式

```xml
<auto_fix_feedback>
AUTO-FIX: The file you just edited has errors. Please fix them:

[lint output]
[test output]

Please fix these errors in the files you just edited.
Do not ask the user — just apply the fix.
</auto_fix_feedback>
```

### 2.5 Integration

| File | Operation |
|------|-----------|
| `src/services/autoFix/` | **New** — 3 files |
| `src/services/tools/toolExecution.ts` | Modify — 工具执行后触发 autoFix |
| `src/commands/config.ts` | Modify — 添加 autoFix 配置项 |

---

## 3. ThinkTag Sanitizer 推理标签清理 (P0)

**Source**: `/Users/heal/openclaude/src/services/api/thinkTagSanitizer.ts` (163 LOC)

### 3.1 问题

MiniMax、GLM、DeepSeek、Kimi K2 等模型将推理内容混入 content 字段，需要清理。

### 3.2 三层防御

| 层 | 函数 | 策略 |
|----|------|------|
| 流式状态机 | `createThinkTagFilter()` | 跨 chunk 边界处理，hold back 最多 64 字符 |
| 全文清理 | `stripThinkTags()` | 三步正则替换 |
| Flush 兜底 | `flush()` | 丢弃缓冲区中的部分标签（false-negative bias） |

### 3.3 支持的标签

`think`, `thinking`, `reasoning`, `thought`, `reasoning_scratchpad`

### 3.4 流式状态机

```typescript
interface ThinkTagFilter {
  feed(chunk: string): string  // 处理 chunk，返回清理后内容
  flush(): string              // 流结束，丢弃缓冲区
  isInsideBlock(): boolean     // 是否在推理块内
}
```

状态：`outside` ↔ `inside`，通过 OPEN_TAG_RE / CLOSE_TAG_RE 正则切换。

### 3.5 False-Negative Bias

宁可丢失推理片段也不泄露：flush 时丢弃缓冲区中的部分标签。

### 3.6 Integration

| File | Operation |
|------|-----------|
| `src/services/api/thinkTagSanitizer.ts` | **New** |
| `src/services/api/openai.ts` | Modify — 流式响应中应用 sanitizer |

---

## 4. OpenAI Error Classification (P1)

**Source**: `/Users/heal/openclaude/src/services/api/openaiErrorClassification.ts` (387 LOC)

### 4.1 14 种错误分类

| 分类 | HTTP | 可重试 | Hint |
|------|------|--------|------|
| `connection_refused` | — | ✅ | 检查服务是否运行 |
| `localhost_resolution_failed` | — | ✅ | 检查 localhost 解析 |
| `request_timeout` | — | ✅ | 检查网络连接 |
| `network_error` | — | ✅ | 检查网络 |
| `auth_invalid` | 401/403 | ❌ | 检查 API key |
| `rate_limited` | 429 | ✅ | 等待重置 |
| `model_not_found` | 404 | ❌ | 检查模型名 |
| `endpoint_not_found` | 404 | ❌ | 检查 base URL |
| `context_overflow` | 413/400 | ❌ | 减少上下文 |
| `tool_call_incompatible` | 400 | ❌ | 检查工具格式 |
| `malformed_provider_response` | 400+ | ❌ | 提供商错误 |
| `provider_unavailable` | 500+ | ✅ | 稍后重试 |
| `unknown` | — | ❌ | — |

### 4.2 跨层标记

```typescript
// 错误消息中嵌入分类标记
formatOpenAICategoryMarker(category, host)
// → [openai_category=rate_limited,host=api.openai.com]

// 提取分类标记
extractOpenAICategoryMarker(message)
// → { category: 'rate_limited', host: 'api.openai.com' }
```

### 4.3 递归错误链

`getErrorCode()` 递归遍历 `error.cause` 链最多 5 层提取 code。

### 4.4 AutoFix 与现有重试逻辑的集成

Error Classification 的 14 种分类直接映射到 `openai.ts` 的 retry/delay/abort 决策。集成后，`openai.ts` 中的通用重试逻辑将被分类器驱动的精确重试取代：

```typescript
const ERROR_TO_RETRY_MAP: Record<ErrorCategory, RetryDecision> = {
  // 可重试 — 指数退避
  'rate_limited':        { retry: true,  delay: 'exponential', maxAttempts: 3 },
  'network_error':       { retry: true,  delay: 'exponential', maxAttempts: 3 },
  'connection_refused':  { retry: true,  delay: 'exponential', maxAttempts: 3 },
  'localhost_resolution_failed': { retry: true, delay: 'exponential', maxAttempts: 3 },
  'provider_unavailable': { retry: true, delay: 'exponential', maxAttempts: 2 },

  // 可重试 — 固定间隔
  'request_timeout':     { retry: true,  delay: 'fixed',       maxAttempts: 2 },

  // 不可重试 — 立即中止
  'auth_invalid':        { retry: false, abort: true },
  'model_not_found':     { retry: false, abort: true },
  'endpoint_not_found':  { retry: false, abort: true },
  'context_overflow':    { retry: false, abort: true },
  'tool_call_incompatible': { retry: false, abort: true },
  'malformed_provider_response': { retry: false, abort: true },
  'unknown':             { retry: false, abort: true },
}
```

**与 FetchWithProxyRetry 的协作**：FetchWithProxyRetry 处理底层网络错误（502/504、ECONNRESET），Error Classification 处理应用层错误（401/429/413）。执行顺序：FetchWithProxyRetry（网络层重试）→ Error Classification（应用层决策）→ openai.ts（最终重试/中止）。

**AutoFix 集成点**：当 Error Classification 判定为 `context_overflow` 时，AutoFix 可触发 compact 操作后重试，而非直接中止。

### 4.5 Integration

| File | Operation |
|------|-----------|
| `src/services/api/openaiErrorClassification.ts` | **New** |
| `src/services/api/openai.ts` | Modify — 使用分类器指导重试策略 |

---

## 5. FetchWithProxyRetry 代理感知重试 (P1)

**Source**: `/Users/heal/openclaude/src/services/api/fetchWithProxyRetry.ts` (57 LOC)

### 5.1 核心逻辑

1. 默认最多 2 次尝试
2. 每次尝试注入代理配置
3. 502/504 响应时自动 `disableKeepAlive()` 并重试
4. 网络错误时同样 disableKeepAlive 并重试

### 5.2 可重试错误模式

`ECONNRESET`、`EPIPE`、`socket hang up`、`Connection reset by peer`、`fetch failed`

### 5.3 Integration

| File | Operation |
|------|-----------|
| `src/services/api/fetchWithProxyRetry.ts` | **New** |
| `src/services/api/openai.ts` | Modify — 替代原生 fetch |

---

## 6. OAuth 认证系统 (P1)

**Source**: `/Users/heal/openclaude/src/services/api/codexOAuth.ts` (349 LOC) + `xaiOAuth.ts` (631 LOC)

### 6.1 Codex OAuth

完整 OAuth2 + PKCE 流程：
1. 生成 codeVerifier
2. 启动本地 HTTP 监听器
3. 构建授权 URL（含 PKCE challenge、state、originator）
4. 打开浏览器
5. 等待授权码回调
6. 交换 token
7. 尝试交换 id_token 为 API key

### 6.2 xAI OAuth 双模式

| 模式 | 场景 | 流程 |
|------|------|------|
| Authorization Code + PKCE | 本地开发 | 浏览器回调 |
| Device Code | 远程/VPS | 轮询 token |

Device Code 轮询处理：
- `authorization_pending` → 继续等待
- `slow_down` → 增加间隔 +5s
- `access_denied` → 抛错
- `expired_token` → 抛错

### 6.3 安全设计

- 所有 endpoint URL 通过 `requireTrustedXaiOAuthEndpoint()` 校验
- Token 刷新自动携带前一个 refreshToken
- `XAI_OAUTH_FETCH_TIMEOUT_MS = 30_000` 超时保护

### 6.4 Token 存储

OAuth token 使用系统 keychain 存储（通过 `@napi-rs/keyring`），平台适配：

| 平台 | 后端 | 说明 |
|------|------|------|
| macOS | Keychain | `security` CLI，访问需用户授权 |
| Linux | libsecret | `secret-tool`，依赖 GNOME Keyring 或 KWallet |
| Windows | DPAPI | `ProtectedData::Protect/Unprotect`，CurrentUser scope |

**降级策略**：当 keychain 不可用时（headless 环境、Docker、SSH session），降级为文件存储，文件权限设为 `600`（仅 owner 可读写），路径为 `~/.ola-cc/oauth-tokens.json`。

```typescript
async function storeToken(service: string, token: OAuthToken): Promise<void> {
  try {
    await keyring.setPassword('ola-cc', service, JSON.stringify(token))
  } catch {
    // 降级：文件存储，权限 600
    const path = join(homedir(), '.ola-cc', 'oauth-tokens.json')
    await fs.writeFile(path, JSON.stringify(token), { mode: 0o600 })
  }
}
```

### 6.5 Integration

| File | Operation |
|------|-----------|
| `src/services/api/oauth/` | **New** — Codex + xAI OAuth |
| `src/commands/auth.ts` | Modify — 添加 OAuth 登录流程 |

---

## 7. 架构师视角

### 7.1 分层架构

```
用户层:    /auth login → OAuth 流程
API 层:    fetchWithProxyRetry → Error Classification → ThinkTag Sanitizer
工具层:    AutoFix hook → toolExecution
```

### 7.2 ola-cc 适配

- AutoFix：可直接集成到现有 toolExecution 流程
- ThinkTag Sanitizer：集成到 openai.ts 的流式响应处理
- Error Classification：集成到 openai.ts 的错误处理
- OAuth：扩展现有 /auth 命令

---

## 8. 产品经理视角

### 8.1 用户价值

| 功能 | 解决的痛点 | 用户感知 |
|------|-----------|---------|
| AutoFix | "AI 编辑后代码有 lint 错误" | 自动检测并修复 |
| ThinkTag Sanitizer | "DeepSeek 输出包含思考过程" | 输出干净 |
| Error Classification | "API 错误信息看不懂" | 精确错误提示 + 自动重试 |
| OAuth | "配置 API key 太麻烦" | 浏览器一键登录 |

---

## 9. Feature Flags

| Flag | 默认 | 环境变量覆盖 | 降级策略 |
|------|------|-------------|---------|
| `OLA_CC_AUTO_FIX` | off | `OLA_CC_AUTO_FIX=1` | 不自动运行 lint/test 修复 |
| `OLA_CC_THINK_TAG_SANITIZER` | **on** | `OLA_CC_THINK_TAG_SANITIZER=0` 禁用 | 原样输出模型响应（含推理标签） |
| `OLA_CC_ERROR_CLASSIFICATION` | off | `OLA_CC_ERROR_CLASSIFICATION=1` | 使用通用错误重试逻辑 |
| `OLA_CC_PROXY_RETRY` | off | `OLA_CC_PROXY_RETRY=1` | 直接请求无重试 |
| `OLA_CC_OAUTH_FLOW` | off | `OLA_CC_OAUTH_FLOW=1` | 使用现有 API key 认证 |

---

## 10. 实施路线图

| Phase | 功能 | 优先级 | 依赖 |
|-------|------|--------|------|
| Phase 1 | ThinkTag Sanitizer | P0 | 无 |
| Phase 2 | Error Classification + Proxy Retry | P0 | 无 |
| Phase 3 | AutoFix | P0 | Phase 2 |
| Phase 4 | OAuth (Codex + xAI) | P1 | 无 |
