# Provider Extension Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: openclaude v0.16.1
**Priority**: P1
**Effort**: M (6 new files + 6 modified)

---

## 1. Overview

扩展 ola-cc 的 provider 支持，从当前 7 种增加到 13+ 种，并添加 GitHub Copilot、Gemini 两个重要 provider 的原生支持。

## 2. Provider Auto-Detect (P1)

### 2.1 Detection Priority

| Priority | Provider | Detection |
|----------|----------|-----------|
| 1 | anthropic | `ANTHROPIC_API_KEY` |
| 2 | codex | `CODEX_API_KEY` / `CHATGPT_ACCOUNT_ID` / `~/.codex/auth.json` |
| 3 | github | `GITHUB_TOKEN` / `GH_TOKEN` |
| 4 | openai | `OPENAI_API_KEY` |
| 5 | gemini | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| 6 | mistral | `MISTRAL_API_KEY` |
| 7 | minimax | `MINIMAX_API_KEY` |
| 8 | xiaomi-mimo | `MIMO_API_KEY` |
| 9 | xai | `XAI_API_KEY` |
| 10 | ollama | Network probe `localhost:11434/api/tags` (1.2s timeout) |
| 11 | lm-studio | Network probe `localhost:1234/v1/models` (1.2s timeout) |

**本地服务探测优化**：优先级 10-11 的本地服务探测使用 `Promise.allSettled` 并行执行，避免串行阻塞。探测结果缓存 5 分钟（Map<string, { result, timestamp }>），缓存期内直接返回上次结果，减少重复网络请求。

### 2.2 Return Value

```typescript
{
  kind: DetectedProviderKind
  source: string       // e.g., "ANTHROPIC_API_KEY set"
  baseUrl?: string     // For local services
  model?: string       // For specific providers
}
```

### 2.3 Integration

**File**: `src/utils/providerAutoDetect.ts` (pure function, no deps)

**Call site**: `src/entrypoints/cli.tsx` at first startup when no explicit provider config.

### 2.4 Files to Modify

| File | Operation |
|------|-----------|
| `src/utils/providerAutoDetect.ts` | **New** |
| `src/entrypoints/cli.tsx` | Modify — call detectBestProvider() |
| `src/setup.ts` | Modify — apply detection result |

---

## 3. GitHub Copilot Provider (P1)

### 3.1 Two Endpoint Modes

| Endpoint | Hostname | Purpose |
|----------|----------|---------|
| Copilot API | `api.githubcopilot.com` | Supports Anthropic native format |
| GitHub Models | `models.github.ai/inference` | OpenAI compatible |

### 3.2 Authentication

`GITHUB_TOKEN` or `GH_TOKEN` → Bearer auth

### 3.3 Model Normalization

`normalizeGithubCopilotModel()`: `"github:copilot"` → `"gpt-4o"`, strip provider prefix

### 3.4 GPT-5+ Responses API

`shouldUseGithubResponsesApi()`: GPT-5+ models auto-use `/responses` API (exclude `gpt-5-mini`)

### 3.5 Claude Native Mode

`isGithubNativeAnthropicMode()`: Claude models → Anthropic native format with `cache_control` prompt caching

### 3.6 COPILOT_HEADERS

```
User-Agent: GitHubCopilotChat/0.26.7
Editor-Version: vscode/1.99.3
Editor-Plugin-Version: copilot-chat/0.26.7
Copilot-Integration-Id: vscode-chat
```

### 3.7 Files to Modify

| File | Operation |
|------|-----------|
| `src/services/api/githubProvider.ts` | **New** |
| `src/utils/model/providers.ts` | Modify — add 'github' to APIProvider |
| `src/services/api/client.ts` | Modify — add CLAUDE_CODE_USE_GITHUB branch |
| `src/services/api/openai.ts` | Modify — add Copilot headers, responses API |

---

## 4. Gemini Provider (P1)

### 4.1 Environment Variables

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` → mapped to `OPENAI_API_KEY`
- `GEMINI_BASE_URL` or default `generativelanguage.googleapis.com`
- `GEMINI_MODEL` or default `gemini-2.5-flash`

### 4.2 Gemini Body Conversion

**`buildGeminiBody()`** — Anthropic → Google AI SDK format:

```typescript
interface GeminiRequest {
  contents: GeminiContent[]
  generationConfig: {
    temperature?: number
    maxOutputTokens?: number
    topP?: number
    topK?: number
  }
  safetySettings?: GeminiSafetySetting[]
  tools?: GeminiTool[]
  systemInstruction?: { parts: { text: string }[] }
}

function buildGeminiBody(messages: AnthropicMessage[], config: GeminiConfig): GeminiRequest
```

字段映射规则见下表：

| Anthropic | Gemini |
|-----------|--------|
| `assistant` role | `model` role |
| `tool_use` | `functionCall` |
| `tool_result` | `functionResponse` (needs `toolUseIdToName` mapping) |
| system prompt | `systemInstruction` |
| `max_tokens` | `generationConfig.maxOutputTokens` |
| tools | `functionDeclarations` |
| thinking | `google.thought_signature` |

### 4.3 Authentication Modes

| Mode | Source |
|------|--------|
| `api-key` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `access-token` | `GEMINI_ACCESS_TOKEN` |
| `adc` | Application Default Credentials (`~/.config/gcloud/application_default_credentials.json`) |

Configurable via `GEMINI_AUTH_MODE` env var.

### 4.4 Files to Modify

| File | Operation |
|------|-----------|
| `src/utils/geminiAuth.ts` | **New** |
| `src/utils/model/providers.ts` | Modify — add 'gemini' provider |
| `src/services/api/openai.ts` | Modify — add buildGeminiBody(), geminiSseToAnthropic() |
| `src/services/api/client.ts` | Modify — add CLAUDE_CODE_USE_GEMINI branch |

---

## 5. Keychain Storage (P1)

### 5.1 Platform Support

| Platform | Implementation | Command |
|----------|---------------|---------|
| macOS | `security` CLI | `security find-generic-password -a "{user}" -w -s "{service}"` |
| Linux | `secret-tool` | `secret-tool lookup service "{name}" account "{user}"` |
| Windows | PowerShell DPAPI | `ProtectedData::Protect/Unprotect` + CurrentUser scope |

### 5.2 Cache Strategy

- 30s TTL cache
- Stale-while-error (return stale when fetch fails)
- Generation counter to prevent concurrent overwrites

### 5.3 Interface Difference

- **ola-cc**: Key-value `get(key)/set(key, value)`
- **openclaude**: Whole-JSON `read()/update(data)`

**Decision**: Keep ola-cc's key-value interface (simpler, more composable).

### 5.4 Files to Modify

| File | Operation |
|------|-----------|
| `src/utils/secureStorage/linuxSecretStorage.ts` | **New** |
| `src/utils/secureStorage/windowsCredentialStorage.ts` | **New** |
| `src/utils/secureStorage/index.ts` | Modify — add linux/windows branches |

---

## 6. Agent Routing 集成

Provider Extension 与 Agent Routing 协同工作：

- **Agent Routing** 决定使用哪个 provider（priority chain）
- **Provider Extension** 负责该 provider 的具体连接（认证、headers、body 转换）
- 调用链：`routeModel()` → `detectBestProvider()` → `createClient()`

```
用户请求 → Agent Routing (routeModel)
  ├─ 优先级匹配 → detectBestProvider()
  ├─ 模型解析 → normalizeModelName()
  └─ 客户端创建 → createClient(provider, config)
       ├─ anthropic → Anthropic SDK
       ├─ github → githubProvider.ts (Copilot API / GitHub Models)
       ├─ gemini → openai.ts + buildGeminiBody()
       └─ openai → openai.ts (standard OpenAI compat)
```

**路由决策表**：

| 条件 | 选择 | 理由 |
|------|------|------|
| `ANTHROPIC_API_KEY` 存在 | anthropic | 原生支持，最佳兼容 |
| `GITHUB_TOKEN` + Claude 模型 | github (native) | Copilot 原生 Anthropic 格式 |
| `GITHUB_TOKEN` + GPT 模型 | github (models) | GitHub Models OpenAI 兼容 |
| `GEMINI_API_KEY` + Gemini 模型 | gemini | 原生 Gemini API |
| `OPENAI_API_KEY` | openai | 标准 OpenAI 兼容 |
| 本地服务探测命中 | ollama/lm-studio | 本地推理 |

详见 `agent-routing-smart-routing-design.md`。

---

## 7. Gemini Tool Schema 转换规则

Gemini 的 function calling schema 与 Anthropic JSON Schema 存在差异，需要转换层处理。

### 7.1 核心转换函数

```typescript
function convertToolSchemaToGemini(tool: AnthropicTool): GeminiTool {
  return {
    functionDeclarations: [{
      name: tool.name,
      description: tool.description,
      parameters: convertJsonSchemaToGeminiSchema(tool.input_schema)
      // Gemini 不支持 oneOf/anyOf，需展平为 object
    }]
  }
}

function convertJsonSchemaToGeminiSchema(schema: JSONSchema): GeminiSchema {
  // 递归转换，处理 Gemini 不支持的特性
  const converted = { ...schema }

  // 1. oneOf/anyOf → 展平为 object（取第一个匹配的 schema）
  if (converted.oneOf || converted.anyOf) {
    const candidates = converted.oneOf || converted.anyOf
    return convertJsonSchemaToGeminiSchema(candidates[0])
  }

  // 2. enum → 保留（Gemini 支持）
  // 3. required → 保留（Gemini 支持）
  // 4. additionalProperties → 移除（Gemini 不支持）
  delete converted.additionalProperties

  // 5. 递归处理 properties
  if (converted.properties) {
    for (const [key, value] of Object.entries(converted.properties)) {
      converted.properties[key] = convertJsonSchemaToGeminiSchema(value as JSONSchema)
    }
  }

  // 6. items（数组类型）递归处理
  if (converted.items) {
    converted.items = convertJsonSchemaToGeminiSchema(converted.items as JSONSchema)
  }

  return converted as GeminiSchema
}
```

### 7.2 转换差异对照表

| Anthropic JSON Schema | Gemini Schema | 处理方式 |
|----------------------|---------------|---------|
| `oneOf` / `anyOf` | 不支持 | 展平为第一个匹配的 schema |
| `additionalProperties` | 不支持 | 移除 |
| `type: "null"` | 不支持 | 移除该字段 |
| `type: "string"` | `STRING` | 枚举映射 |
| `type: "number"` / `"integer"` | `NUMBER` / `INTEGER` | 枚举映射 |
| `type: "boolean"` | `BOOLEAN` | 枚举映射 |
| `type: "array"` | `ARRAY` | 保留 `items` |
| `type: "object"` | `OBJECT` | 保留 `properties` + `required` |
| `enum` | `enum` | 直接保留 |
| `$ref` | 不支持 | 内联展开 |

### 7.3 tool_result 转换

```typescript
function convertToolResultToGemini(
  toolUseId: string,
  result: AnthropicToolResult,
  toolNameLookup: Map<string, string>
): GeminiFunctionResponse {
  return {
    name: toolNameLookup.get(toolUseId)!,  // Gemini 需要 name 而非 id
    response: {
      result: typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content)
    }
  }
}
```

---

## 8. Feature Flags 与向后兼容

### 8.1 Feature Flag 定义

| Flag | 默认值 | 控制范围 | 引入方式 |
|------|--------|---------|---------|
| `GEMINI_PROVIDER` | `off` | Gemini provider 适配器（buildGeminiBody、geminiSseToAnthropic、Gemini auth） | `scripts/build.ts` compile-time gate |
| `OLLAMA_PROVIDER` | `off` | Ollama 本地服务 provider（网络探测、OpenAI 兼容适配） | `scripts/build.ts` compile-time gate |
| `PROVIDER_AUTO_DETECT` | `off` | Provider 自动检测（环境变量扫描、本地服务探测、优先级匹配） | `scripts/build.ts` compile-time gate |

**注册位置**: `scripts/build.ts` 的 feature set 定义，使用 `feature('GEMINI_PROVIDER')` / `feature('OLLAMA_PROVIDER')` / `feature('PROVIDER_AUTO_DETECT')` 在 bundle 阶段做 dead code elimination。

**Flag 依赖关系**:
```
PROVIDER_AUTO_DETECT
  ├─ GEMINI_PROVIDER  (auto-detect 可探测 Gemini，但需要 flag 启用才能实际连接)
  ├─ OLLAMA_PROVIDER   (auto-detect 可探测 Ollama，但需要 flag 启用才能实际连接)
  └─ anthropic/openai/github (始终可用，不受新 flag 控制)
```

### 8.2 降级策略

| Flag 状态 | 降级行为 | 用户感知 |
|-----------|---------|---------|
| `GEMINI_PROVIDER=off` | Gemini provider 不可用，`createClient('gemini')` 抛出 `ProviderNotEnabledError` | 需手动设置 `CLAUDE_CODE_USE_OPENAI` + OpenAI 兼容端点绕过 |
| `OLLAMA_PROVIDER=off` | Ollama provider 不可用，网络探测跳过，`createClient('ollama')` 抛出 `ProviderNotEnabledError` | 需手动设置 `CLAUDE_CODE_USE_OPENAI` + `OPENAI_BASE_URL=http://localhost:11434/v1` 绕过 |
| `PROVIDER_AUTO_DETECT=off` | 禁用自动检测，必须通过显式 env var（`CLAUDE_CODE_USE_*`）选择 provider | 启动时无自动选择，未配置 env var 则使用默认 Anthropic |
| 全部 off | 回退到当前 ola-cc 行为：仅 anthropic + openai 兼容 + bedrock/vertex | 与当前行为完全一致，无功能退化 |

**降级链路**:
```
createClient(provider):
  if provider === 'gemini' && !feature('GEMINI_PROVIDER')
    → throw ProviderNotEnabledError("Enable GEMINI_PROVIDER feature flag")
  if provider === 'ollama' && !feature('OLLAMA_PROVIDER')
    → throw ProviderNotEnabledError("Enable OLLAMA_PROVIDER feature flag")
  → fallback to anthropic (default)

detectBestProvider():
  if !feature('PROVIDER_AUTO_DETECT')
    → return null (skip detection, rely on explicit env vars)
  → run full detection priority chain
```

---

## 9. LOC 估算

### 9.1 新增文件

| 模块 | 文件 | 估算 LOC | 难度 | 说明 |
|------|------|---------|------|------|
| Provider 自动检测 | `src/utils/providerAutoDetect.ts` | ~180 | M | 11 种 provider 探测、优先级匹配、缓存机制 |
| GitHub Copilot Provider | `src/services/api/githubProvider.ts` | ~350 | H | 双端点模式、Claude 原生格式、Responses API、Copilot headers |
| Gemini Auth | `src/utils/geminiAuth.ts` | ~120 | M | 三种认证模式（api-key / access-token / ADC） |
| Linux Secret Storage | `src/utils/secureStorage/linuxSecretStorage.ts` | ~90 | M | `secret-tool` CLI 封装 |
| Windows Credential Storage | `src/utils/secureStorage/windowsCredentialStorage.ts` | ~100 | M | PowerShell DPAPI 封装 |
| **新增小计** | — | **~840** | — | — |

### 9.2 修改文件

| 文件 | 修改内容 | 增量 LOC | 难度 |
|------|---------|---------|------|
| `src/utils/model/providers.ts` | 添加 `'github'` / `'gemini'` 到 APIProvider 类型 | ~15 | L |
| `src/services/api/client.ts` | 添加 `CLAUDE_CODE_USE_GITHUB` / `CLAUDE_CODE_USE_GEMINI` 分支 | ~60 | M |
| `src/services/api/openai.ts` | 添加 Copilot headers、Responses API、buildGeminiBody()、geminiSseToAnthropic() | ~280 | H |
| `src/entrypoints/cli.tsx` | 调用 detectBestProvider() | ~20 | L |
| `src/setup.ts` | 应用检测结果 | ~30 | L |
| `src/utils/secureStorage/index.ts` | 添加 linux/windows 分支 | ~25 | L |
| `scripts/build.ts` | 注册 3 个新 feature flag | ~15 | L |
| **修改小计** | — | **~445** | — |

### 9.3 总计

| 类别 | LOC |
|------|-----|
| 新增文件 | ~840 |
| 修改文件增量 | ~445 |
| **总计** | **~1285** |
