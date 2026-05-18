# OAuth/API 端点配置化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有硬编码的 `*.anthropic.com`、`platform.claude.com`、`claude.com` 等服务端 URL 替换为环境变量驱动，无默认值，启动时必填。

**Architecture:** 在 `src/constants/oauth.ts` 中新增 `getEnvOrThrow` 工具函数，所有 OAuth/API 端点通过该函数从环境变量读取。将 `getEnvOrThrow` 导出供其他文件使用。删除 staging/local 配置分支和 FedStart 白名单逻辑。

**Tech Stack:** TypeScript, Bun, 环境变量 (`process.env`)

---

### Task 1: 新增 `getEnvOrThrow` 工具函数

**Files:**
- Modify: `src/constants/oauth.ts` (在文件顶部 import 之后新增函数)

- [ ] **Step 1: 在 `src/constants/oauth.ts` 顶部 import 之后新增 `getEnvOrThrow` 函数并导出**

在 `src/constants/oauth.ts` 的 import 语句之后、`getOauthConfigType` 函数之前，新增：

```typescript
/**
 * 读取必需的环境变量，未设置则抛出异常。
 * 所有 OAuth/API 端点均通过此函数强制要求配置。
 * 每个环境变量在文件头部有对应的配置说明注释。
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

- [ ] **Step 2: 编译验证**

Run: `bun run build:dev`
Expected: 编译成功，无错误

- [ ] **Step 3: 提交**

```bash
git add src/constants/oauth.ts
git commit -m "feat: add getEnvOrThrow helper for required env variables"
```

---

### Task 2: 重写 `src/constants/oauth.ts` — 核心 OAuth 配置

**Files:**
- Modify: `src/constants/oauth.ts`

- [ ] **Step 1: 替换 `PROD_OAUTH_CONFIG` 为环境变量驱动**

将 `src/constants/oauth.ts` 中的 `PROD_OAUTH_CONFIG`（行 84-104）替换为：

```typescript
// ============================================================
// OAuth/API 端点配置 — 全部通过环境变量提供，无默认值
//
// 必需环境变量清单:
//   CLAUDE_API_BASE_URL                  — API 基础地址
//   CLAUDE_OAUTH_CONSOLE_AUTHORIZE_URL   — Console OAuth 授权页
//   CLAUDE_OAUTH_CLAUDE_AI_AUTHORIZE_URL — claude.ai OAuth 授权页
//   CLAUDE_OAUTH_CLAUDE_AI_ORIGIN        — claude.ai Web Origin
//   CLAUDE_OAUTH_TOKEN_URL              — Token 交换端点
//   CLAUDE_OAUTH_API_KEY_URL            — API Key 创建端点
//   CLAUDE_OAUTH_ROLES_URL              — 用户角色查询端点
//   CLAUDE_OAUTH_CLIENT_ID              — OAuth Client ID
//   CLAUDE_OAUTH_CONSOLE_SUCCESS_URL    — Console 认证成功跳转页
//   CLAUDE_OAUTH_CLAUDEAI_SUCCESS_URL   — claude.ai 认证成功跳转页
//   CLAUDE_OAUTH_MANUAL_REDIRECT_URL    — 手动认证回调地址
//   CLAUDE_MCP_PROXY_URL                — MCP 代理服务器地址
// ============================================================

const PROD_OAUTH_CONFIG = {
  BASE_API_URL: getEnvOrThrow('CLAUDE_API_BASE_URL'),
  CONSOLE_AUTHORIZE_URL: getEnvOrThrow('CLAUDE_OAUTH_CONSOLE_AUTHORIZE_URL'),
  CLAUDE_AI_AUTHORIZE_URL: getEnvOrThrow('CLAUDE_OAUTH_CLAUDE_AI_AUTHORIZE_URL'),
  CLAUDE_AI_ORIGIN: getEnvOrThrow('CLAUDE_OAUTH_CLAUDE_AI_ORIGIN'),
  TOKEN_URL: getEnvOrThrow('CLAUDE_OAUTH_TOKEN_URL'),
  API_KEY_URL: getEnvOrThrow('CLAUDE_OAUTH_API_KEY_URL'),
  ROLES_URL: getEnvOrThrow('CLAUDE_OAUTH_ROLES_URL'),
  CONSOLE_SUCCESS_URL: getEnvOrThrow('CLAUDE_OAUTH_CONSOLE_SUCCESS_URL'),
  CLAUDEAI_SUCCESS_URL: getEnvOrThrow('CLAUDE_OAUTH_CLAUDEAI_SUCCESS_URL'),
  MANUAL_REDIRECT_URL: getEnvOrThrow('CLAUDE_OAUTH_MANUAL_REDIRECT_URL'),
  CLIENT_ID: getEnvOrThrow('CLAUDE_OAUTH_CLIENT_ID'),
  OAUTH_FILE_SUFFIX: '',
  MCP_PROXY_URL: getEnvOrThrow('CLAUDE_MCP_PROXY_URL'),
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
} as const
```

- [ ] **Step 2: 删除 `STAGING_OAUTH_CONFIG`**

删除 `src/constants/oauth.ts` 中的 `STAGING_OAUTH_CONFIG` 定义（约行 117-143）：

```typescript
// 删除以下整个常量定义:
// const STAGING_OAUTH_CONFIG = process.env.USER_TYPE === 'ant' ? (...) : undefined
```

- [ ] **Step 3: 删除 `getLocalOauthConfig()` 函数**

删除 `src/constants/oauth.ts` 中的 `getLocalOauthConfig()` 函数（约行 148-174）。

- [ ] **Step 4: 删除 `ALLOWED_OAUTH_BASE_URLS` 白名单**

删除 `src/constants/oauth.ts` 中的 `ALLOWED_OAUTH_BASE_URLS` 数组定义（约行 179-183）。

- [ ] **Step 5: 删除 `OLA_CC_CUSTOM_OAUTH_URL` override 逻辑**

删除 `getOauthConfig()` 函数中处理 `OLA_CC_CUSTOM_OAUTH_URL` 的代码块（约行 200-222）。

- [ ] **Step 6: 简化 `getOauthConfig()` 函数**

将 `getOauthConfig()` 函数简化为：

```typescript
export function getOauthConfig(): OauthConfig {
  return PROD_OAUTH_CONFIG
}
```

- [ ] **Step 7: 简化 `getOauthConfigType()` 函数**

将 `getOauthConfigType()` 函数简化为：

```typescript
function getOauthConfigType(): 'prod' {
  return 'prod'
}
```

- [ ] **Step 8: 编译验证**

Run: `bun run build:dev`
Expected: 编译成功

- [ ] **Step 9: 提交**

```bash
git add src/constants/oauth.ts
git commit -m "refactor: replace hardcoded OAuth URLs with env variables"
```

---

### Task 3: 修改 MCP Registry 和 Files API

**Files:**
- Modify: `src/services/mcp/officialRegistry.ts` (行 40)
- Modify: `src/services/api/filesApi.ts` (行 32-38)

- [ ] **Step 1: 修改 `src/services/mcp/officialRegistry.ts`**

在文件顶部添加 import:

```typescript
import { getOauthConfig } from '../../constants/oauth.js'
```

将行 40 的硬编码 URL 改为动态拼接:

```typescript
// 替换前:
// 'https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial'

// 替换后:
`${getOauthConfig().BASE_API_URL}/mcp-registry/v0/servers?version=latest&visibility=commercial`
```

- [ ] **Step 2: 修改 `src/services/api/filesApi.ts`**

在文件顶部添加 import:

```typescript
import { getEnvOrThrow } from '../../constants/oauth.js'
```

将 `getDefaultApiBaseUrl()` 函数（行 32-38）替换为:

```typescript
function getDefaultApiBaseUrl(): string {
  return getEnvOrThrow('CLAUDE_FILES_API_BASE_URL')
}
```

- [ ] **Step 3: 编译验证**

Run: `bun run build:dev`
Expected: 编译成功

- [ ] **Step 4: 提交**

```bash
git add src/services/mcp/officialRegistry.ts src/services/api/filesApi.ts
git commit -m "refactor: replace hardcoded API URLs in MCP registry and Files API"
```

---

### Task 4: 修改分析/遥测端点（6 个文件）

**Files:**
- Modify: `src/services/analytics/growthbook.ts` (行 444, 505-506)
- Modify: `src/services/analytics/firstPartyEventLoggingExporter.ts` (行 116-118)
- Modify: `src/utils/telemetry/bigqueryExporter.ts` (行 47)
- Modify: `src/services/api/metricsOptOut.ts` (行 45)
- Modify: `src/components/Feedback.tsx` (行 543)
- Modify: `src/components/FeedbackSurvey/submitTranscriptShare.ts` (行 88)

- [ ] **Step 1: 修改 `src/services/analytics/growthbook.ts`**

在文件顶部添加 import:

```typescript
import { getOauthConfig, getEnvOrThrow } from '../../constants/oauth.js'
```

修改 `getApiBaseUrlHost()` 函数（行 444），将硬编码白名单改为动态比较:

```typescript
// 替换行 444:
// if (host === 'api.anthropic.com') return undefined
// 改为:
const configHost = getOauthConfig().BASE_API_URL
try {
  if (host === new URL(configHost).host) return undefined
} catch { /* ignore */ }
return host
```

修改行 505-506 的 GrowthBook baseUrl:

```typescript
// 替换前 (行 503-506):
// const baseUrl =
//   process.env.USER_TYPE === 'ant'
//     ? process.env.CLAUDE_CODE_GB_BASE_URL || 'https://api.anthropic.com/'
//     : 'https://api.anthropic.com/'

// 替换后:
const baseUrl = getEnvOrThrow('CLAUDE_GROWTHBOOK_BASE_URL')
```

- [ ] **Step 2: 修改 `src/services/analytics/firstPartyEventLoggingExporter.ts`**

在文件顶部添加 import:

```typescript
import { getOauthConfig } from '../../constants/oauth.js'
```

替换行 114-118 的 baseUrl:

```typescript
// 替换前:
// const baseUrl =
//   options.baseUrl ||
//   (process.env.ANTHROPIC_BASE_URL === 'https://api-staging.anthropic.com'
//     ? 'https://api-staging.anthropic.com'
//     : 'https://api.anthropic.com')

// 替换后:
const baseUrl = options.baseUrl || getOauthConfig().BASE_API_URL
```

- [ ] **Step 3: 修改 `src/utils/telemetry/bigqueryExporter.ts`**

在文件顶部添加 import:

```typescript
import { getEnvOrThrow } from '../../constants/oauth.js'
```

替换行 47 的 defaultEndpoint:

```typescript
// 替换前:
// const defaultEndpoint = 'https://api.anthropic.com/api/claude_code/metrics'

// 替换后:
const defaultEndpoint = getEnvOrThrow('CLAUDE_METRICS_URL')
```

同时需要处理 `ANT_OLA_CC_METRICS_ENDPOINT` 的拼接逻辑。完整替换 constructor:

```typescript
  constructor(options: { timeout?: number } = {}) {
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.ANT_OLA_CC_METRICS_ENDPOINT
    ) {
      this.endpoint =
        process.env.ANT_OLA_CC_METRICS_ENDPOINT +
        '/api/claude_code/metrics'
    } else {
      this.endpoint = getEnvOrThrow('CLAUDE_METRICS_URL')
    }

    this.timeout = options.timeout || 5000
  }
```

- [ ] **Step 4: 修改 `src/services/api/metricsOptOut.ts`**

在文件顶部添加 import:

```typescript
import { getEnvOrThrow } from '../../constants/oauth.js'
```

替换行 45 的 endpoint:

```typescript
// 替换前:
// const endpoint = `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled`

// 替换后:
const endpoint = getEnvOrThrow('CLAUDE_METRICS_OPT_OUT_URL')
```

- [ ] **Step 5: 修改 `src/components/Feedback.tsx`**

在文件顶部添加 import:

```typescript
import { getEnvOrThrow } from '../../constants/oauth.js'
```

替换行 543 的 URL:

```typescript
// 替换前:
// const response = await axios.post('https://api.anthropic.com/api/claude_cli_feedback', {

// 替换后:
const response = await axios.post(getEnvOrThrow('CLAUDE_FEEDBACK_URL'), {
```

- [ ] **Step 6: 修改 `src/components/FeedbackSurvey/submitTranscriptShare.ts`**

在文件顶部添加 import:

```typescript
import { getEnvOrThrow } from '../../constants/oauth.js'
```

替换行 88 的 URL:

```typescript
// 替换前:
// 'https://api.anthropic.com/api/claude_code_shared_session_transcripts'

// 替换后:
getEnvOrThrow('CLAUDE_TRANSCRIPT_SHARE_URL')
```

- [ ] **Step 7: 编译验证**

Run: `bun run build:dev`
Expected: 编译成功

- [ ] **Step 8: 提交**

```bash
git add src/services/analytics/growthbook.ts src/services/analytics/firstPartyEventLoggingExporter.ts src/utils/telemetry/bigqueryExporter.ts src/services/api/metricsOptOut.ts src/components/Feedback.tsx src/components/FeedbackSurvey/submitTranscriptShare.ts
git commit -m "refactor: replace hardcoded API URLs in analytics and telemetry"
```

---

### Task 5: 修改 WebFetch Tool 和 Model Provider

**Files:**
- Modify: `src/tools/WebFetchTool/utils.ts` (行 184)
- Modify: `src/utils/model/providers.ts` (行 27-42)

- [ ] **Step 1: 修改 `src/tools/WebFetchTool/utils.ts`**

在文件顶部添加 import:

```typescript
import { getEnvOrThrow } from '../../constants/oauth.js'
```

替换行 184 的 URL:

```typescript
// 替换前:
// `https://api.anthropic.com/api/web/domain_info?domain=${encodeURIComponent(domain)}`

// 替换后:
`${getEnvOrThrow('CLAUDE_WEB_DOMAIN_INFO_URL')}?domain=${encodeURIComponent(domain)}`
```

- [ ] **Step 2: 修改 `src/utils/model/providers.ts`**

在文件顶部添加 import:

```typescript
import { getOauthConfig } from '../../constants/oauth.js'
```

替换 `isFirstPartyAnthropicBaseUrl()` 函数（行 27-42）:

```typescript
/**
 * Check if ANTHROPIC_BASE_URL is the configured API URL.
 * Returns true if not set (default API) or matches the configured BASE_API_URL host.
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const configHost = new URL(getOauthConfig().BASE_API_URL).host
    return new URL(baseUrl).host === configHost
  } catch {
    return false
  }
}
```

- [ ] **Step 3: 编译验证**

Run: `bun run build:dev`
Expected: 编译成功

- [ ] **Step 4: 提交**

```bash
git add src/tools/WebFetchTool/utils.ts src/utils/model/providers.ts
git commit -m "refactor: replace hardcoded API URLs in WebFetch tool and provider detection"
```

---

### Task 6: 重写 `src/constants/product.ts`

**Files:**
- Modify: `src/constants/product.ts`

- [ ] **Step 1: 重写 `src/constants/product.ts`**

```typescript
import { getEnvOrThrow } from './oauth.js'

export const PRODUCT_URL = getEnvOrThrow('CLAUDE_PRODUCT_URL')

// Claude Code Remote session URLs
export const CLAUDE_AI_BASE_URL = getEnvOrThrow('CLAUDE_AI_BASE_URL')
export const CLAUDE_AI_STAGING_BASE_URL = getEnvOrThrow('CLAUDE_AI_STAGING_BASE_URL')
export const CLAUDE_AI_LOCAL_BASE_URL = getEnvOrThrow('CLAUDE_AI_LOCAL_BASE_URL')
```

保留 `isRemoteSessionStaging`、`isRemoteSessionLocal`、`getClaudeAiBaseUrl`、`getRemoteSessionUrl` 函数不变。

- [ ] **Step 2: 编译验证**

Run: `bun run build:dev`
Expected: 编译成功，确认 `product.ts` → `oauth.ts` 依赖不产生循环引用

- [ ] **Step 3: 提交**

```bash
git add src/constants/product.ts
git commit -m "refactor: replace hardcoded URLs in product constants with env variables"
```

---

### Task 7: 最终验证

- [ ] **Step 1: 全量编译验证**

Run: `bun run build:dev`
Expected: 编译成功，无错误

- [ ] **Step 2: 搜索确认无遗漏的硬编码 URL**

Run: `grep -rn 'https://api.anthropic.com' src/ --include='*.ts' --include='*.tsx' | grep -v '// ' | grep -v '\* ' | grep -v "getEnvOrThrow\|getOauthConfig"`
Expected: 无输出（仅剩注释中的 URL）

Run: `grep -rn 'https://platform.claude.com\|https://claude.com/cai\|https://claude.ai' src/ --include='*.ts' --include='*.tsx' | grep -v '// ' | grep -v '\* ' | grep -v "getEnvOrThrow\|getOauthConfig\|CLAUDE_AI_BASE_URL\|CLAUDE_AI_ORIGIN"`
Expected: 无输出（仅剩注释中的 URL）

- [ ] **Step 3: 运行测试**

Run: `bun test`
Expected: 所有测试通过

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: final verification — no remaining hardcoded OAuth/API URLs"
```
