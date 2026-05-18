# OAuth/API 端点配置化设计

## 目标

将代码中所有硬编码的 `*.anthropic.com`、`platform.claude.com`、`claude.com` 等服务端 URL 全部抽离为环境变量驱动，取消默认值，启动时必须配置。注释、错误提示中的文档链接类 URL 保持不变。

## 范围

### 修改文件清单（共 12 个文件）

#### A. OAuth 认证端点

| 文件 | 行号 | 当前硬编码值 |
|------|------|-------------|
| `src/constants/oauth.ts` | 85 | `https://api.anthropic.com` (BASE_API_URL) |
| `src/constants/oauth.ts` | 92 | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` |
| `src/constants/oauth.ts` | 93 | `https://api.anthropic.com/api/oauth/claude_cli/roles` |
| `src/constants/oauth.ts` | 102 | `https://mcp-proxy.anthropic.com` |
| `src/constants/oauth.ts` | 121 | `https://api-staging.anthropic.com` (staging BASE) |
| `src/constants/oauth.ts` | 129 | `https://api-staging.anthropic.com/api/oauth/claude_cli/create_api_key` |
| `src/constants/oauth.ts` | 131 | `https://api-staging.anthropic.com/api/oauth/claude_cli/roles` |
| `src/constants/oauth.ts` | 140 | `https://mcp-proxy-staging.anthropic.com` |
| `src/services/mcp/officialRegistry.ts` | 40 | `https://api.anthropic.com/mcp-registry/v0/servers` |
| `src/services/api/filesApi.ts` | 36 | `https://api.anthropic.com` (base URL default) |

#### B. 分析/遥测上报

| 文件 | 行号 | 当前硬编码值 |
|------|------|-------------|
| `src/services/analytics/growthbook.ts` | 505-506 | `https://api.anthropic.com/` (GrowthBook base) |
| `src/services/analytics/firstPartyEventLoggingExporter.ts` | 116-118 | `https://api.anthropic.com` / `api-staging.anthropic.com` |
| `src/utils/telemetry/bigqueryExporter.ts` | 47 | `https://api.anthropic.com/api/claude_code/metrics` |
| `src/services/api/metricsOptOut.ts` | 45 | `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled` |
| `src/components/Feedback.tsx` | 543 | `https://api.anthropic.com/api/claude_cli_feedback` |
| `src/components/FeedbackSurvey/submitTranscriptShare.ts` | 88 | `https://api.anthropic.com/api/claude_code_shared_session_transcripts` |

#### C. API 调用/工具

| 文件 | 行号 | 当前硬编码值 |
|------|------|-------------|
| `src/tools/WebFetchTool/utils.ts` | 184 | `https://api.anthropic.com/api/web/domain_info` |

#### D. 产品 URL

| 文件 | 行号 | 当前硬编码值 |
|------|------|-------------|
| `src/constants/product.ts` | 1 | `https://claude.com/claude-code` (PRODUCT_URL) |
| `src/constants/product.ts` | 4 | `https://claude.ai` (CLAUDE_AI_BASE_URL) |

### 不在本次范围的文件

以下文件中的 `.anthropic.com` 均为注释、文档链接、错误提示中的静态 URL，不修改：

- `src/remote/SessionsWebSocket.ts:78` — 注释说明
- `src/types/command.ts:166,172` — 注释说明
- `src/services/analytics/growthbook.ts:436,444` — 注释说明
- `src/services/voiceStreamSTT.ts:125-129` — 注释说明
- `src/services/api/filesApi.ts:7,63` — JSDoc 注释
- `src/services/api/errors.ts:555,1195-1196` — 错误提示中的静态链接
- `src/services/api/errorUtils.ts:99` — SSL 错误提示
- `src/utils/api.ts:197` — 注释
- `src/utils/http.ts:57` — User-Agent 字符串
- `src/utils/model/providers.ts:24-25,34,36` — 注释 + 白名单判断
- `src/tools/WebFetchTool/utils.ts:73` — 注释
- `src/utils/proxy.ts:285` — 注释
- `src/upstreamproxy/upstreamproxy.ts:48-49,52-53` — 代理域名白名单
- `src/tools/BriefTool/upload.ts:66` — 注释
- `src/hooks/notifs/useNpmDeprecationNotification.tsx:5` — `docs.anthropic.com` 文档链接
- `src/components/grove/Grove.tsx:70,123` — `www.anthropic.com/news/...` 新闻链接

## 环境变量清单

以下环境变量**全部为必填项**，缺少任何一项将在启动时报错。

### 核心 API/ OAuth 端点（src/constants/oauth.ts）

| 环境变量 | 说明 | 示例值 |
|----------|------|--------|
| `CLAUDE_API_BASE_URL` | API 基础地址（替代 `api.anthropic.com`） | `https://api.example.com` |
| `CLAUDE_OAUTH_CONSOLE_AUTHORIZE_URL` | Console OAuth 授权页面地址 | `https://platform.example.com/oauth/authorize` |
| `CLAUDE_OAUTH_CLAUDE_AI_AUTHORIZE_URL` | claude.ai OAuth 授权页面地址 | `https://auth.example.com/oauth/authorize` |
| `CLAUDE_OAUTH_CLAUDE_AI_ORIGIN` | claude.ai Web Origin（CORS 同源标识） | `https://claude.example.com` |
| `CLAUDE_OAUTH_TOKEN_URL` | Token 交换端点（POST） | `https://api.example.com/v1/oauth/token` |
| `CLAUDE_OAUTH_API_KEY_URL` | API Key 创建端点 | `https://api.example.com/api/oauth/claude_cli/create_api_key` |
| `CLAUDE_OAUTH_ROLES_URL` | 用户角色/权限查询端点 | `https://api.example.com/api/oauth/claude_cli/roles` |
| `CLAUDE_OAUTH_CLIENT_ID` | OAuth 2.0 Client ID | `your-uuid-client-id` |
| `CLAUDE_OAUTH_CONSOLE_SUCCESS_URL` | Console 认证成功跳转页 | `https://platform.example.com/oauth/code/success?app=claude-code` |
| `CLAUDE_OAUTH_CLAUDEAI_SUCCESS_URL` | claude.ai 认证成功跳转页 | `https://platform.example.com/oauth/code/success?app=claude-code` |
| `CLAUDE_OAUTH_MANUAL_REDIRECT_URL` | 手动认证模式回调地址 | `https://platform.example.com/oauth/code/callback` |
| `CLAUDE_MCP_PROXY_URL` | MCP 代理服务器地址 | `https://mcp-proxy.example.com` |

### 分析/遥测端点

| 环境变量 | 说明 | 示例值 |
|----------|------|--------|
| `CLAUDE_GROWTHBOOK_BASE_URL` | GrowthBook 特性标志服务地址 | `https://api.example.com/` |
| `CLAUDE_METRICS_URL` | 指标上报端点 | `https://api.example.com/api/claude_code/metrics` |
| `CLAUDE_METRICS_OPT_OUT_URL` | 指标退出状态查询端点 | `https://api.example.com/api/claude_code/organizations/metrics_enabled` |
| `CLAUDE_FEEDBACK_URL` | 反馈提交端点 | `https://api.example.com/api/claude_cli_feedback` |
| `CLAUDE_TRANSCRIPT_SHARE_URL` | 会话记录共享端点 | `https://api.example.com/api/claude_code_shared_session_transcripts` |
| `CLAUDE_MCP_REGISTRY_URL` | MCP 官方插件注册表地址 | `https://api.example.com/mcp-registry/v0/servers?version=latest&visibility=commercial` |

### Files API / WebFetch 工具

| 环境变量 | 说明 | 示例值 |
|----------|------|--------|
| `CLAUDE_FILES_API_BASE_URL` | Files API 基础地址 | `https://api.example.com` |
| `CLAUDE_WEB_DOMAIN_INFO_URL` | WebFetch 域名信息查询端点 | `https://api.example.com/api/web/domain_info` |

### 产品 URL（src/constants/product.ts）

| 环境变量 | 说明 | 示例值 |
|----------|------|--------|
| `CLAUDE_PRODUCT_URL` | 产品页面地址 | `https://your-product.example.com/claude-code` |
| `CLAUDE_AI_BASE_URL` | claude.ai Web 基础地址（远程会话） | `https://claude.example.com` |

## 代码改动方案

### 1. 新增 `getEnvOrThrow` 工具函数

在 `src/constants/oauth.ts` 顶部新增（同时导出供 `product.ts` 使用）：

```typescript
/**
 * 读取必需的环境变量，未设置则抛出异常。
 * 所有 OAuth/API 端点均通过此函数强制要求配置。
 */
export function getEnvOrThrow(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Please configure it before running the application.`
    )
  }
  return value
}
```

### 2. 重写 `src/constants/oauth.ts`

将 `PROD_OAUTH_CONFIG` 和 `STAGING_OAUTH_CONFIG` 合并为单一配置，全部由环境变量提供：

```typescript
const PROD_OAUTH_CONFIG = {
  // API 基础地址（替代 https://api.anthropic.com）
  // 用于 API 请求、WebSocket 连接、voice_stream STT 等
  BASE_API_URL: getEnvOrThrow('CLAUDE_API_BASE_URL'),

  // Console 授权页面 URL
  // 浏览器跳转到此页面完成 OAuth 登录（Console / API Key 用户）
  CONSOLE_AUTHORIZE_URL: getEnvOrThrow('CLAUDE_OAUTH_CONSOLE_AUTHORIZE_URL'),

  // claude.ai 授权页面 URL
  // 浏览器跳转到此页面完成 OAuth 登录（claude.ai 订阅用户）
  CLAUDE_AI_AUTHORIZE_URL: getEnvOrThrow('CLAUDE_OAUTH_CLAUDE_AI_AUTHORIZE_URL'),

  // claude.ai Web Origin
  // 用于 CORS 同源标识，不要与 AUTHORIZE_URL 混淆
  CLAUDE_AI_ORIGIN: getEnvOrThrow('CLAUDE_OAUTH_CLAUDE_AI_ORIGIN'),

  // Token 交换端点
  // POST 请求，将 authorization code 换取 access_token + refresh_token
  TOKEN_URL: getEnvOrThrow('CLAUDE_OAUTH_TOKEN_URL'),

  // API Key 创建端点
  // POST 请求，OAuth 认证成功后自动创建 API Key
  API_KEY_URL: getEnvOrThrow('CLAUDE_OAUTH_API_KEY_URL'),

  // 用户角色查询端点
  // GET 请求，获取用户组织角色和权限信息
  ROLES_URL: getEnvOrThrow('CLAUDE_OAUTH_ROLES_URL'),

  // Console 认证成功跳转页
  // 用户完成 Console OAuth 后浏览器跳转的目标页
  CONSOLE_SUCCESS_URL: getEnvOrThrow('CLAUDE_OAUTH_CONSOLE_SUCCESS_URL'),

  // claude.ai 认证成功跳转页
  // 用户完成 claude.ai OAuth 后浏览器跳转的目标页
  CLAUDEAI_SUCCESS_URL: getEnvOrThrow('CLAUDE_OAUTH_CLAUDEAI_SUCCESS_URL'),

  // 手动认证模式回调地址
  // 无浏览器环境下，用户手动输入 auth code 的回调地址
  MANUAL_REDIRECT_URL: getEnvOrThrow('CLAUDE_OAUTH_MANUAL_REDIRECT_URL'),

  // OAuth Client ID
  // OAuth 2.0 协议中的客户端标识符
  CLIENT_ID: getEnvOrThrow('CLAUDE_OAUTH_CLIENT_ID'),

  // 移除 OAUTH_FILE_SUFFIX（不再需要 staging/local 区分）
  OAUTH_FILE_SUFFIX: '',

  // MCP 代理服务器地址
  MCP_PROXY_URL: getEnvOrThrow('CLAUDE_MCP_PROXY_URL'),
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
} as const
```

### 3. 删除 staging/local 配置分支

- 移除 `STAGING_OAUTH_CONFIG` 整个常量定义
- 移除 `getLocalOauthConfig()` 函数
- 简化 `getOauthConfigType()` 只返回 `'prod'`
- 移除 `ALLOWED_OAUTH_BASE_URLS` 白名单
- 移除 `OLA_CC_CUSTOM_OAUTH_URL` override 逻辑

### 4. 修改 `src/services/mcp/officialRegistry.ts`

将 `https://api.anthropic.com/mcp-registry/v0/servers` 改为从 `getOauthConfig().BASE_API_URL` 派生：

```typescript
// 改造前
'https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial'

// 改造后 — 基于 BASE_API_URL 动态拼接
`${getOauthConfig().BASE_API_URL}/mcp-registry/v0/servers?version=latest&visibility=commercial`
```

### 5. 修改 `src/services/api/filesApi.ts`

将默认 base URL 从硬编码改为环境变量：

```typescript
// 改造前
const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'

// 改造后
const baseUrl = getEnvOrThrow('CLAUDE_FILES_API_BASE_URL')
```

### 6. 修改分析/遥测相关文件

**`src/services/analytics/growthbook.ts`**（行 505-506）：

```typescript
// 改造前
? process.env.CLAUDE_CODE_GB_BASE_URL || 'https://api.anthropic.com/'
: 'https://api.anthropic.com/'

// 改造后
: getEnvOrThrow('CLAUDE_GROWTHBOOK_BASE_URL')
```

同时更新行 444 的 `isFirstPartyAnthropicBaseUrl()` 判断逻辑，将 `api.anthropic.com` 白名单改为基于环境变量值的动态比较。

**`src/services/analytics/firstPartyEventLoggingExporter.ts`**（行 116-118）：

```typescript
// 改造前
(process.env.ANTHROPIC_BASE_URL === 'https://api-staging.anthropic.com'
  ? 'https://api-staging.anthropic.com'
  : 'https://api.anthropic.com')

// 改造后
getOauthConfig().BASE_API_URL
```

**`src/utils/telemetry/bigqueryExporter.ts`**（行 47）：

```typescript
// 改造前
const defaultEndpoint = 'https://api.anthropic.com/api/claude_code/metrics'

// 改造后
const defaultEndpoint = `${getEnvOrThrow('CLAUDE_METRICS_URL')}`
```

**`src/services/api/metricsOptOut.ts`**（行 45）：

```typescript
// 改造前
const endpoint = `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled`

// 改造后
const endpoint = `${getEnvOrThrow('CLAUDE_METRICS_OPT_OUT_URL')}`
```

**`src/components/Feedback.tsx`**（行 543）：

```typescript
// 改造前
await axios.post('https://api.anthropic.com/api/claude_cli_feedback', {

// 改造后
await axios.post(`${getEnvOrThrow('CLAUDE_FEEDBACK_URL')}`, {
```

**`src/components/FeedbackSurvey/submitTranscriptShare.ts`**（行 88）：

```typescript
// 改造前
'https://api.anthropic.com/api/claude_code_shared_session_transcripts'

// 改造后
getEnvOrThrow('CLAUDE_TRANSCRIPT_SHARE_URL')
```

### 7. 修改 `src/tools/WebFetchTool/utils.ts`

行 184 的域名信息查询端点：

```typescript
// 改造前
`https://api.anthropic.com/api/web/domain_info?domain=${encodeURIComponent(domain)}`

// 改造后
`${getEnvOrThrow('CLAUDE_WEB_DOMAIN_INFO_URL')}?domain=${encodeURIComponent(domain)}`
```

### 8. 修改 `src/utils/model/providers.ts`

`isFirstPartyAnthropicBaseUrl()` 中的硬编码白名单改为动态比较：

```typescript
// 改造前
const allowedHosts = ['api.anthropic.com']
if (process.env.USER_TYPE === 'ant') {
  allowedHosts.push('api-staging.anthropic.com')
}
return allowedHosts.includes(host)

// 改造后
const baseUrl = process.env.ANTHROPIC_BASE_URL
if (!baseUrl) return true
try {
  const configHost = new URL(getOauthConfig().BASE_API_URL).host
  return host === configHost
} catch {
  return false
}
```

### 9. 重写 `src/constants/product.ts`

```typescript
import { getEnvOrThrow } from './oauth.js'

export const PRODUCT_URL = getEnvOrThrow('CLAUDE_PRODUCT_URL')
export const CLAUDE_AI_BASE_URL = getEnvOrThrow('CLAUDE_AI_BASE_URL')
export const CLAUDE_AI_STAGING_BASE_URL = getEnvOrThrow('CLAUDE_AI_STAGING_BASE_URL')
export const CLAUDE_AI_LOCAL_BASE_URL = getEnvOrThrow('CLAUDE_AI_LOCAL_BASE_URL')
```

### 10. 处理 `getOauthConfig()` 中的 override 逻辑

现有的 `OLA_CC_CUSTOM_OAUTH_URL` 覆盖逻辑（行 200-222）整个删除，因为所有 URL 现在都由独立环境变量直接指定，不再需要从 base URL 派生。

## 错误处理

启动时如果缺少任何必需环境变量，错误信息应清晰指出缺少的变量：

```
Error: Missing required environment variable: CLAUDE_API_BASE_URL.
Please configure it before running the application.
```

## 配置示例

用户需要在 `.env` 文件或 shell 中设置：

```bash
# === 核心 API/ OAuth 端点 ===
export CLAUDE_API_BASE_URL=https://api.example.com
export CLAUDE_OAUTH_CONSOLE_AUTHORIZE_URL=https://platform.example.com/oauth/authorize
export CLAUDE_OAUTH_CLAUDE_AI_AUTHORIZE_URL=https://auth.example.com/oauth/authorize
export CLAUDE_OAUTH_CLAUDE_AI_ORIGIN=https://claude.example.com
export CLAUDE_OAUTH_TOKEN_URL=https://api.example.com/v1/oauth/token
export CLAUDE_OAUTH_API_KEY_URL=https://api.example.com/api/oauth/claude_cli/create_api_key
export CLAUDE_OAUTH_ROLES_URL=https://api.example.com/api/oauth/claude_cli/roles
export CLAUDE_OAUTH_CLIENT_ID=your-client-id-uuid
export CLAUDE_OAUTH_CONSOLE_SUCCESS_URL=https://platform.example.com/oauth/code/success?app=claude-code
export CLAUDE_OAUTH_CLAUDEAI_SUCCESS_URL=https://platform.example.com/oauth/code/success?app=claude-code
export CLAUDE_OAUTH_MANUAL_REDIRECT_URL=https://platform.example.com/oauth/code/callback
export CLAUDE_MCP_PROXY_URL=https://mcp-proxy.example.com

# === 分析/遥测端点 ===
export CLAUDE_GROWTHBOOK_BASE_URL=https://api.example.com/
export CLAUDE_METRICS_URL=https://api.example.com/api/claude_code/metrics
export CLAUDE_METRICS_OPT_OUT_URL=https://api.example.com/api/claude_code/organizations/metrics_enabled
export CLAUDE_FEEDBACK_URL=https://api.example.com/api/claude_cli_feedback
export CLAUDE_TRANSCRIPT_SHARE_URL=https://api.example.com/api/claude_code_shared_session_transcripts
export CLAUDE_MCP_REGISTRY_URL=https://api.example.com/mcp-registry/v0/servers?version=latest&visibility=commercial

# === Files API / WebFetch 工具 ===
export CLAUDE_FILES_API_BASE_URL=https://api.example.com
export CLAUDE_WEB_DOMAIN_INFO_URL=https://api.example.com/api/web/domain_info

# === 产品 URL ===
export CLAUDE_PRODUCT_URL=https://your-product.example.com/claude-code
export CLAUDE_AI_BASE_URL=https://claude.example.com
export CLAUDE_AI_STAGING_BASE_URL=https://claude-staging.example.com
export CLAUDE_AI_LOCAL_BASE_URL=http://localhost:4000
```

## 风险与注意事项

1. **向后兼容**：移除默认值后，未配置环境变量会导致启动失败。需要确保部署时所有变量已设置。
2. **`isFirstPartyAnthropicBaseUrl()` 语义变化**：原来通过硬编码白名单判断是否"直接连接 Anthropic API"，现在改为与配置的 `BASE_API_URL` 动态比较，行为逻辑需要验证。
3. **构建产物**：`dist/publish/` 为 npm 发布包，配置方式需在文档中说明。
4. **循环依赖风险**：`product.ts` 引用 `oauth.ts` 的 `getEnvOrThrow`，需要确保 `oauth.ts` 不反向依赖 `product.ts`，避免循环引用。
