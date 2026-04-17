# OAuth 端点配置化设计

## 目标

将代码中所有硬编码的 OAuth 认证 URL（`platform.claude.com`、`claude.com`、`api.anthropic.com` 等）全部抽离为环境变量驱动，取消默认值，启动时必须配置。

## 范围

### 修改文件清单

| 文件 | 说明 |
|------|------|
| `src/constants/oauth.ts` | 核心文件，集中管理所有 OAuth 端点 URL |
| `src/constants/product.ts` | 产品 URL（PRODUCT_URL、CLAUDE_AI_BASE_URL） |

### 不在本次范围的文件

语音 STT（`src/services/voiceStreamSTT.ts`）已有 `VOICE_STREAM_BASE_URL` 环境变量，保持不变。
分析上报（`src/services/analytics/`）中的 URL 与 OAuth 认证无关，保持不变。
文档链接类 URL（如 `https://code.claude.com/docs/...`）保持不变。

## 环境变量清单

以下环境变量**全部为必填项**，缺少任何一项将在启动时报错。

### OAuth 认证端点（src/constants/oauth.ts）

| 环境变量 | 说明 | 示例值 |
|----------|------|--------|
| `CLAUDE_OAUTH_BASE_URL` | API 基础地址，用于 `api.anthropic.com` 替换 | `https://api.example.com` |
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

### 产品 URL（src/constants/product.ts）

| 环境变量 | 说明 | 示例值 |
|----------|------|--------|
| `CLAUDE_PRODUCT_URL` | 产品页面地址 | `https://your-product.example.com/claude-code` |
| `CLAUDE_AI_BASE_URL` | claude.ai Web 基础地址（远程会话） | `https://claude.example.com` |

## 代码改动方案

### 1. 新增 `getEnvOrThrow` 工具函数

在 `src/constants/oauth.ts` 顶部新增：

```typescript
function getEnvOrThrow(name: string): string {
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

### 2. 重写 `PROD_OAUTH_CONFIG`

将所有硬编码值替换为 `getEnvOrThrow` 调用，每项附带注释说明：

```typescript
const PROD_OAUTH_CONFIG = {
  // API 基础地址（替代 https://api.anthropic.com）
  // 用于 API 请求、WebSocket 连接等
  BASE_API_URL: getEnvOrThrow('CLAUDE_OAUTH_BASE_URL'),

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

  // 移除 OAUTH_FILE_SUFFIX（不再需要环境区分）
  OAUTH_FILE_SUFFIX: '',

  // MCP Proxy URL — 非 OAuth 认证范畴，保持不变
  MCP_PROXY_URL: 'https://mcp-proxy.anthropic.com',
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
} as const
```

### 3. 处理 staging/local 配置

staging 和 local 环境原本有自己的硬编码值，改为同样从环境变量读取，不再区分三套配置。合并为一个统一的 config：

- 移除 `STAGING_OAUTH_CONFIG` 条件分支
- 移除 `getLocalOauthConfig()` 函数
- `getOauthConfigType()` 函数保留但只返回 `'prod'`（因为所有值都由环境变量提供）

### 4. 移除 FedStart 白名单限制

移除 `ALLOWED_OAUTH_BASE_URLS` 白名单检查逻辑（`CLAUDE_CODE_CUSTOM_OAUTH_URL` 的 override 机制不再需要，因为所有 URL 都直接由环境变量指定）。

### 5. 重写 `src/constants/product.ts`

```typescript
export const PRODUCT_URL = getEnvOrThrow('CLAUDE_PRODUCT_URL')
export const CLAUDE_AI_BASE_URL = getEnvOrThrow('CLAUDE_AI_BASE_URL')
```

将 `getEnvOrThrow` 也导出为共享工具，或将其放在独立的工具文件中（如 `src/utils/env.ts`）供两个常量文件共同引用。

### 6. 处理 `CLAUDE_CODE_CUSTOM_OAUTH_URL` 兼容

现有的 `CLAUDE_CODE_CUSTOM_OAUTH_URL` 覆盖逻辑（在 `getOauthConfig()` 中）需要保留兼容性：如果设置了该变量，则以它为 base 派生所有子 URL；否则走新的逐个环境变量模式。

## 错误处理

启动时如果缺少任何必需环境变量，错误信息应清晰指出缺少的变量：

```
Error: Missing required environment variable: CLAUDE_OAUTH_BASE_URL.
Please configure it before running the application.
```

## 配置示例

用户需要在 `.env` 文件或 shell 中设置：

```bash
export CLAUDE_OAUTH_BASE_URL=https://api.example.com
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
export CLAUDE_PRODUCT_URL=https://your-product.example.com/claude-code
export CLAUDE_AI_BASE_URL=https://claude.example.com
```

## 风险与注意事项

1. **向后兼容**：移除默认值后，未配置环境变量会导致启动失败。需要确保部署时所有变量已设置。
2. **构建产物**：`dist/publish/` 为 npm 发布包，配置方式需在文档中说明。
3. **MCP Proxy URL**：`MCP_PROXY_URL` 也加入了环境变量，如不需要可保留默认值。
