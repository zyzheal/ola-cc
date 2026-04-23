# VSCode Extension 构建与架构设计

**日期:** 2026-04-23
**状态:** 待评审
**目标:** 使主项目同时产出 CLI + VSCode Extension 两种产物，并扩展 VSCode Extension 的架构

## 1. 背景

### 1.1 当前状态

- **CLI 构建体系:** `scripts/build-publish.ts` 使用 Bun bundler，输出到 `dist/publish/`
- **VSCode Extension:** 独立子项目 `vscode-extension/`（仅在 `feature-vscode` 分支），使用 esbuild + @vscode/vsce
- **构建已验证:** `bun install --dev` + `bun run build` + `vsce package` 均可成功，生成 32KB 的 .vsix

### 1.2 已知问题

| 问题 | 严重度 |
|------|--------|
| `.vscodeignore` 不完善，src/ 和 build.mjs 被打入 vsix | 中 |
| 缺少 LICENSE.md | 低 |
| WebviewPanel vs WebviewView 声明矛盾 | 中 |
| API Key 存储在 settings.json（不安全） | 高 |
| 无 OpenAI 兼容支持 | 低 |
| 无 MCP/Agent 集成 | 低 |
| 与主项目无构建集成 | 中 |
| Webview 无语法高亮 | 低 |
| Session 持久化仅依赖 vscode.getState()（10MB 限制） | 低 |

### 1.3 专家审查关键发现

- **`src/shared/` 风险极高:** `claude.ts` (3475行) 深度耦合 20+ CLI 专属模块，含 `bun:bundle` 虚拟模块
- **保留 esbuild:** Bun bundler 对 VSCode 扩展的兼容性不如 esbuild 成熟
- **复制 openai.ts 不需要:** ClaudeClient.ts 已是自包含的 Anthropic 客户端，与主项目 openai.ts（Anthropic→OpenAI 格式转换器）用途不同
- **feature() define 当前不需要:** vscode-extension 未引用 `bun:bundle`
- **SecretStorage 替代 settings.json:** 安全存储 API Key

## 2. 总体架构

### 2.1 输出结构

```
dist/
├── publish/                    ← CLI（已有）
│   ├── cli.mjs
│   ├── package.json
│   └── ...
├── publish-vscode/             ← VSCode Extension 产物（新增）
│   ├── extension/
│   │   ├── extension.js
│   │   └── webview/
│   │       └── app.js
│   ├── package.json
│   ├── README.md
│   └── LICENSE.md
└── claude-code-vscode-<version>.vsix  ← 最终 VSCode 扩展包
```

### 2.2 设计原则

1. **不拆包:** 短期不创建 `@ola-cc/sdk`，VSCode Extension 和 CLI 各自独立维护 API 客户端
2. **保留 esbuild:** VSCode Extension 继续使用 esbuild，不迁移到 Bun bundler
3. **条件构建:** VSCode 构建通过 `--vscode` 参数或 `BUILD_VSCODE=1` 环境变量触发
4. **失败阻断:** 子项目构建失败必须中断主构建流程
5. **版本同步:** vscode-extension 版本号与主项目自动同步

## 3. Phase 1: 基础修复（1-2 天）

### 3.1 .vscodeignore 修复

当前内容：
```
node_modules/
.vscode-test/
.vscode-test.mjs
bun.lock
```

修正后：
```
node_modules/
.vscode-test/
.vscode-test.mjs
.vscode/
bun.lock
tsconfig.json
src/
build.mjs
**/*.ts
**/*.tsx
**/*.map
```

### 3.2 LICENSE.md

在 `vscode-extension/` 目录放置 LICENSE.md，与根目录同步。

### 3.3 构建集成

在 `scripts/build-publish.ts` 末尾新增：

```typescript
const buildVscode = args.includes('--vscode') || process.env.BUILD_VSCODE === '1'

if (buildVscode) {
  console.log('[publish] Building VSCode extension...')

  // 1. 同步版本号
  const vscePkgPath = join(process.cwd(), 'vscode-extension', 'package.json')
  const vscePkg = await Bun.file(vscePkgPath).json()
  vscePkg.version = publishVersion
  writeFileSync(vscePkgPath, JSON.stringify(vscePkg, null, 2) + '\n')

  // 2. 构建
  const buildProc = Bun.spawnSync({
    cmd: ['bun', 'run', 'build'],
    cwd: join(process.cwd(), 'vscode-extension'),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (buildProc.exitCode !== 0) {
    console.error('[publish] VSCode extension build failed')
    process.exit(buildProc.exitCode ?? 1)
  }

  // 3. 复制到 dist/publish-vscode/
  const vsceOutDir = join(outDir, 'publish-vscode')
  mkdirSync(vsceOutDir, { recursive: true })
  mkdirSync(join(vsceOutDir, 'extension'), { recursive: true })
  cpSync(join(process.cwd(), 'vscode-extension', 'dist', 'extension.js'),
         join(vsceOutDir, 'extension', 'extension.js'))
  mkdirSync(join(vsceOutDir, 'extension', 'webview'), { recursive: true })
  cpSync(join(process.cwd(), 'vscode-extension', 'dist', 'webview', 'app.js'),
         join(vsceOutDir, 'extension', 'webview', 'app.js'))
  cpSync(join(process.cwd(), 'vscode-extension', 'package.json'),
         join(vsceOutDir, 'package.json'))
  cpSync(join(process.cwd(), 'vscode-extension', 'README.md'),
         join(vsceOutDir, 'README.md'))
  cpSync('LICENSE.md', join(vsceOutDir, 'LICENSE.md'))

  // 4. 打包 vsix
  const vsixProc = Bun.spawnSync({
    cmd: ['bunx', 'vsce', 'package', '--no-yarn',
          '--out', join(outDir, `claude-code-vscode-${publishVersion}.vsix`)],
    cwd: join(process.cwd(), 'vscode-extension'),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (vsixProc.exitCode !== 0) {
    console.error('[publish] VSCode extension packaging failed')
    process.exit(vsixProc.exitCode ?? 1)
  }

  console.log(`[publish] VSIX: ${join(outDir, `claude-code-vscode-${publishVersion}.vsix`)}`)
}
```

### 3.4 WebviewPanel → WebviewView

**原因:** package.json 声明了 sidebar webview 但实际使用浮动面板，设计不一致。WebviewView 常驻实例对 MCP 集成有利。

**重要注意:** WebviewView 与 WebviewPanel 在状态管理上有根本差异。WebviewView 没有 `retainContextWhenHidden` 选项，当侧边栏被收起时 webview DOM 会被销毁，仅 `vscode.getState()` 保留。每次 `resolveWebviewView()` 被调用时必须重新发送全量历史和配置。

**变更:**

```typescript
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private visible = false

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    this.view.webview.options = { enableScripts: true }
    this.view.webview.html = this.getWebviewHtml()
    this.setupMessageHandlers()

    // 每次 resolve 时重新发送全量历史和配置
    // （WebviewView 无 retainContextWhenHidden，DOM 销毁后需重建）
    this.sendHistoryToWebview()
    this.sendConfigToWebview()
  }

  // 聚焦侧边栏
  async show(): Promise<void> {
    await vscode.commands.executeCommand('claudeCode.sidebar.focus')
  }

  postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg)
  }
}

// extension.ts 注册
const provider = new ChatViewProvider(context, statusBar)
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider('claudeCode.sidebar', provider)
)

// 监听可见性变化（MCP 长连接场景：收起时暂停工具轮询）
context.subscriptions.push(
  provider.onDidChangeVisibility(visible => {
    if (!visible) provider.pauseMCPPolling()
    else provider.resumeMCPPolling()
  })
)
```

**关键变化:**
- 删除 `panel: vscode.WebviewPanel | undefined` 的 optional 处理
- `retainContextWhenHidden` 移除（WebviewView 不支持此选项）
- `resolveWebviewView()` 中必须重新发送 `messageHistory` 和配置
- `show()` 改为 `vscode.commands.executeCommand('claudeCode.sidebar.focus')`
- 新增 `onDidChangeVisibility` 监听器用于 MCP 生命周期管理
- HTML 生成和消息传递接口不变

### 3.5 API Key 改用 SecretStorage

**原因:** settings.json 中的密码值不是加密存储的。

**变更:**

```typescript
// 存储（带 read-back 验证）
async function safeStoreApiKey(apiKey: string): Promise<boolean> {
  try {
    await context.secrets.store('claude-api-key', apiKey)
    const readBack = await context.secrets.get('claude-api-key')
    if (!readBack) throw new Error('SecretStorage read-back failed')
    return true
  } catch (e) {
    // 降级：写入 settings.json + 警告
    await vscode.workspace.getConfiguration('claude').update(
      'apiKey', apiKey, vscode.ConfigurationTarget.Global
    )
    vscode.window.showWarningMessage(
      'SecretStorage unavailable. API key stored in settings.json (not encrypted).'
    )
    return false
  }
}

// 读取（优先 SecretStorage，降级 settings.json）
async function getApiKey(): Promise<string | undefined> {
  const fromSecret = await context.secrets.get('claude-api-key')
  if (fromSecret) return fromSecret
  // 降级路径
  return vscode.workspace.getConfiguration('claude').get<string>('apiKey')
}
```

**迁移路径:** 已有用户如果之前通过 settings.json 设置了 API Key，在 `activate()` 中自动迁移：

```typescript
async function migrateApiKey(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('claude')
  const settingsKey = config.get<string>('apiKey', '')
  if (settingsKey) {
    const ok = await safeStoreApiKey(settingsKey)
    if (ok) {
      await config.update('apiKey', '', vscode.ConfigurationTarget.Global)
      console.log('API key migrated from settings.json to SecretStorage')
    }
  }
}
```

**Linux 降级:** 在 Ubuntu Server、WSL2、远程 SSH 等环境中 `libsecret` 或 DBus 可能不可用。降级策略已在 `safeStoreApiKey` 中实现，显示明确警告。**影响等级：中**（大量开发者使用 Linux/WSL）。

**设置 UI:** `claude.apiKey` 保留但显示为空（`"format": "password"`），新增命令 `claude.setApiKey` 弹出输入框并调用 `safeStoreApiKey`。

## 4. Phase 2: 功能增强（3-5 天）

### 4.1 OpenAI 兼容支持

**新增文件:** `vscode-extension/src/api/openai-adapter.ts`

**注意:** 当前 ClaudeClient 直接调用 HTTP API（非 SDK），所以不能直接复用主项目的 `openai.ts`（它是 Anthropic SDK→OpenAI 格式转换器）。需要独立实现 OpenAI 格式 HTTP 请求构建和 SSE 解析。

**ClaudeClient 变更:**

```typescript
// 新增设置
"claude.provider": {
  "type": "string",
  "enum": ["anthropic", "openai"],
  "default": "anthropic"
}
"claude.openaiBaseUrl": {
  "type": "string",
  "default": "http://localhost:11434"  // Ollama 默认地址
}
"claude.openaiApiKey": {
  "type": "string",
  "default": "",
  "format": "password"
}
"claude.openaiModel": {
  "type": "string",
  "default": ""  // 空=使用 claude.model 的值
}
```

**端点配置（区分认证和请求格式）:**

```typescript
interface ProviderConfig {
  url: string        // 完整端点 URL
  apiKey: string     // API key
  headers: Record<string, string>
  body: (msg: ApiMessage[], opts: RequestOptions) => Record<string, unknown>
  parseSSE: (line: string) => SSEEvent  // 不同 provider 的 SSE 格式不同
}

const anthropicConfig: ProviderConfig = {
  url: 'https://api.anthropic.com/v1/messages',
  headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  body: (messages, opts) => ({
    model: opts.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    messages: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    stream: true,
  }),
  parseSSE: parseAnthropicSSE,  // content_block_delta → text_delta
}

const openaiConfig: ProviderConfig = {
  url: `${openaiBaseUrl}/v1/chat/completions`,
  headers: { 'Authorization': `Bearer ${openaiApiKey}` },
  body: (messages, opts) => ({
    model: openaiModel || opts.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: true,
  }),
  parseSSE: parseOpenAISSE,  // choices[0].delta.content
}
```

**SSE 格式差异处理:**

```typescript
// Anthropic SSE: data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
function parseAnthropicSSE(line: string): SSEEvent {
  const parsed = JSON.parse(line.slice(6))
  if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
    return { type: 'chunk', text: parsed.delta.text }
  }
  if (parsed.type === 'message_stop') return { type: 'done' }
  return { type: 'ignore' }
}

// OpenAI SSE: data: {"choices":[{"delta":{"content":"..."},"index":0}]}
function parseOpenAISSE(line: string): SSEEvent {
  const parsed = JSON.parse(line.slice(6))
  const content = parsed.choices?.[0]?.delta?.content
  if (content) return { type: 'chunk', text: content }
  if (parsed.choices?.[0]?.finish_reason) return { type: 'done' }
  return { type: 'ignore' }
}
```

### 4.2 Webview 语法高亮

**方案:** highlight.js，由 esbuild 预打包为独立 bundle，通过 `<script>` 标签注入 webview。

```
vscode-extension/src/webview/
├── app.tsx              ← 主 webview 逻辑
├── highlight-bundle.ts  ← highlight.js 入口（注册常用语言）
└── highlight.css        ← 主题样式
```

```typescript
// highlight-bundle.ts
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
// ... 其他常用语言

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)

// 挂载到 window 供 webview 调用
;(window as any).hljs = hljs
```

**esbuild 配置 (build.mjs):**

```typescript
// 打包 highlight.js 为独立 IIFE
await esbuild.build({
  bundle: true,
  entryPoints: [join(srcDir, 'webview', 'highlight-bundle.ts')],
  outfile: join(webviewDistDir, 'highlight.js'),
  target: 'chrome100',
  platform: 'browser',
  format: 'iife',
  globalName: 'hljs',  // 确保 IIFE 正确挂载到 window.hljs
  minify: !isWatch,
})

// 打包 CSS 为 JS 字符串，由 app.js 注入
await esbuild.build({
  bundle: true,
  entryPoints: [join(srcDir, 'webview', 'highlight.css')],
  outfile: join(webviewDistDir, 'highlight-css.js'),
  target: 'chrome100',
  platform: 'browser',
  format: 'iife',
  minify: !isWatch,
  loader: { '.css': 'dataurl' },
})
```

**Webview HTML 引入:**

```html
<script nonce="${nonce}" src="${highlightJsUri}"></script>
<script nonce="${nonce}" src="${highlightCssUri}"></script>
<script nonce="${nonce}" src="${appJsUri}"></script>
```

CSS 的 URI 通过 `asWebviewUri()` 转换，与 JS 文件一致。CSP `style-src` 加入 `${this.panel.webview.cspSource}` 以允许内联样式。

**Webview 中使用:**

```typescript
function renderCodeBlock(code: string, language?: string): string {
  if (!language || !(window as any).hljs) {
    return `<pre><code>${escapeHtml(code)}</code></pre>`
  }
  const hljs = (window as any).hljs
  const result = language && hljs.getLanguage(language)
    ? hljs.highlight(code, { language })
    : hljs.highlightAuto(code)
  return `<pre><code class="hljs language-${result.language}">${result.value}</code></pre>`
}
```

**优势:** 不依赖运行时动态 import，CSP 安全，全部打包进扩展无外部请求。

### 4.3 Session 持久化

**问题:** `vscode.getState()` 有 10MB 限制。

**方案:** 双层存储 + 节流

**职责划分:**
- **Extension 侧 (`ChatViewProvider`):** 维护 `messageHistory`，负责写入 `globalStorageUri` 文件
- **Webview 侧 (`app.tsx`):** 保留 `vscode.getState()` 作为 view 层快速恢复（最近 50 条消息）
- 两者通过 `sendHistoryToWebview()` 保持同步

**节流策略:**

```typescript
// Extension 侧：每 10 条消息或每 10 秒持久化一次，取先到者
private pendingSave = false
private saveDebounceTimer: NodeJS.Timeout | undefined

async onMessageAdded(): Promise<void> {
  if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer)

  // 先清除 timer，避免立即保存后 timer 仍然触发（修复 P0: 冗余写入）
  if (this.messageHistory.length % 10 === 0) {
    this.saveDebounceTimer = undefined  // 明确清除
    await this.saveSession()
  } else {
    this.saveDebounceTimer = setTimeout(() => this.saveSession(), 10_000)
  }
}
```

**恢复优先级定义（修复 P1: 状态恢复路径不完整）:**
1. **Extension 激活时:** 优先读取 `globalStorageUri/session.json`，不存在则读取 webview 传递的 `vscode.getState()` 作为备份
2. **Webview resolve 时:** 先用 `vscode.getState()` 快速渲染，然后通过 `sendHistoryToWebview()` 从 extension 侧同步
3. **Webview resolve 竞态保护:** 设置 `isResolving` 标志，重发历史完成前暂停新的 `postMessage` 调用（排队等待）

**持久化实现:**

```typescript
async saveSession(): Promise<void> {
  if (this.pendingSave) return
  this.pendingSave = true

  try {
    const uri = vscode.Uri.joinPath(context.globalStorageUri, 'session.json')
    const content = JSON.stringify({
      messages: this.messageHistory,
      savedAt: Date.now(),
      version: 1,
    })

    // 原子写入：先写临时文件再 rename
    const tmpUri = vscode.Uri.joinPath(context.globalStorageUri, 'session.json.tmp')
    await vscode.workspace.fs.writeFile(tmpUri, new TextEncoder().encode(content))
    await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true })
  } finally {
    this.pendingSave = false
  }
}

async loadSession(): Promise<ChatMessage[] | null> {
  try {
    const uri = vscode.Uri.joinPath(context.globalStorageUri, 'session.json')
    const data = await vscode.workspace.fs.readFile(uri)
    const session = JSON.parse(new TextDecoder().decode(data))
    // 清理过期 session（超过 7 天）
    if (Date.now() - session.savedAt > 7 * 24 * 60 * 60 * 1000) {
      await vscode.workspace.fs.delete(uri)
      return null
    }
    return session.messages
  } catch {
    return null  // 文件不存在或解析失败
  }
}
```

**旧数据清理:**
- 自动清理超过 7 天的 session
- 启动时检查 `globalStorageUri` 下文件大小，超过 50MB 时删除最旧的 session 文件

## 5. Phase 3: MCP + Agent（5-7 天）

### 5.1 MCP Client 架构

```
┌─────────────────────────────────────────────────────┐
│  VSCode Extension Host (Node.js)                    │
│                                                     │
│  MCPClientManager                                   │
│  ├── InProcessTransport (MCP subprocess via stdio) │
│  └── HTTPTransport (HTTP/SSE)                      │
│                                                     │
│  ToolRegistry                                       │
│  ├── registerMCPTools()                            │
│  └── callMCPTool(name, input)                      │
└──────────┬──────────────────────────┬───────────────┘
           │ postMessage              │ fetch/stream
           ▼                          ▼
┌──────────────────┐      ┌───────────────────────────┐
│  Claude API      │      │  Webview (sandboxed)      │
│                  │      │                           │
│  tool_use ──────►│      │  - Chat UI                │
│  ◄── tool_result │      │  - Tool progress/result   │
└──────────────────┘      │  - User approve/deny      │
                          └───────────────────────────┘
```

**关键设计:**
- MCP 连接在 extension host 侧初始化（webview 是沙盒环境，无法启动子进程）
- 复用主项目 `InProcessTransport` 思路（不直接引用代码，因为含 `bun:bundle`）
- 支持 `claude.mcpServers` 配置项定义 MCP 服务端点

### 5.2 Tool Use 循环

**ClaudeClient 消息格式重构:**

```typescript
// 当前格式
interface ApiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

// 新格式
interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}

interface ApiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
}
```

**Agent Loop 逻辑:**

```typescript
async agentLoop(messages: ApiMessage[], callbacks: AgentCallbacks): Promise<void> {
  let iteration = 0
  const maxIterations = this.getMaxIterations()  // 可配置，默认 25

  while (iteration < maxIterations) {
    iteration++
    callbacks.onIteration(iteration, maxIterations)  // 通知 webview 当前进度

    const response = await this.callAPI(messages)

    // 解析响应 content blocks（可能同时包含 text 和 tool_use）
    const textBlocks = response.content.filter(b => b.type === 'text')
    const toolUses = response.content.filter(b => b.type === 'tool_use')

    // 流式发送文本内容
    for (const textBlock of textBlocks) {
      callbacks.onChunk(textBlock.text || '')
    }

    if (toolUses.length === 0) {
      break  // 纯文本响应，结束循环
    }

    // 有 tool_use: 追加完整 assistant message（含 text + tool_use）
    messages.push({
      role: 'assistant',
      content: response.content,  // 保留原始混合内容
    })

    // 并发执行工具（带并发度限制，默认 3）
    const maxConcurrent = this.getMaxConcurrentTools()  // 可配置
    const semaphore = new Semaphore(maxConcurrent)
    const toolResults = await Promise.allSettled(
      toolUses.map(async (toolUse) => {
        await semaphore.acquire()
        try {
          callbacks.onToolStart(toolUse)

          // 需要用户确认的工具
          if (this.requiresConfirmation(toolUse.name)) {
            await callbacks.onToolConfirmation(toolUse)
          }

          const result = await this.executeTool(toolUse)
          callbacks.onToolComplete(toolUse, result)
          return {
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          callbacks.onToolError(toolUse, errorMsg)
          return {
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,  // 保留原始 ID
            content: `Error: ${errorMsg}`,
            is_error: true,
          }
        } finally {
          semaphore.release()
        }
      })
    )

    // 将所有 tool_result 追加到用户消息（保留原始 tool_use_id）
    messages.push({
      role: 'user',
      content: toolResults.map((r, i) => {
        if (r.status === 'fulfilled') return r.value
        return {
          type: 'tool_result' as const,
          tool_use_id: toolUses[i].id,  // 从原始数组获取正确 ID
          content: `Error: ${r.reason}`,
          is_error: true,
        }
      }),
    })
  }
}
```

### 5.3 Webview Tool UI

**通信协议:**

```typescript
// Extension host → Webview
{ command: 'tool_start', toolName: '...', input: {...}, iteration: 1 }
{ command: 'tool_progress', toolName: '...', progress: 'Fetching...' }
{ command: 'tool_complete', toolName: '...', result: {...} }
{ command: 'tool_error', toolName: '...', error: '...' }
{ command: 'tool_requires_confirmation', toolName: '...', input: {...} }
{ command: 'agent_iteration', current: 1, max: 25 }
{ command: 'agent_done', stopReason: 'end_turn' }

// Webview → Extension host
{ command: 'tool_approve', toolName: '...' }
{ command: 'tool_deny', toolName: '...' }
{ command: 'cancel_agent_loop' }  // 用户手动取消
```

**超时处理:** 单个 tool 执行超过 60 秒自动标记为 timeout 并发送 `tool_error`。整个 agent loop 超过 5 分钟自动终止。

**并发工具管理:** 当 API 返回多个 `tool_use` 时，webview 为每个 tool 创建独立的进度卡片，通过 `toolName + id` 区分。

**UI 元素:**
- Tool 执行进度指示器
- 危险操作确认对话框（如 Bash 命令执行）
- Tool 结果折叠面板

## 6. 风险评估

### 6.1 构建风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| vsce 依赖 `node_modules` 体积膨胀 | 中 | .vscodeignore 正确排除 |
| esbuild 不认识 `feature()` 宏 | 低 | 当前未引用，未来需 `--define` |
| highlight.js CSP eval() 限制 | 低 | esbuild IIFE + `globalName`，验证不含 eval |
| SecretStorage 在 Linux 不可用 | 中 | 降级为 settings.json + 警告 + read-back 验证 |
| Webview 的 `vscode.getState()` 10MB 限制 | 低 | 双层存储 + 节流 + 原子写入 |
| `vsce package` 版本号手动维护 | 中 | build-publish.ts 自动同步主项目版本号 |
| `@types/vscode` 版本过低 | 中 | 升级到 `^1.87.0`（WebviewView 稳定版） |
| Webview `acquireVsCodeApi()` 多次调用 | 高 | IIFE 保护，确保只调用一次 |

### 6.2 架构风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| `claude.ts` 深度耦合 CLI | 高 | 不共享，VSCode 独立实现 |
| MCP SDK 依赖 `bun:bundle` | 高 | 重新实现传输层，不直接引用 |
| Agent mode 的流式 + tool_use 混合 | 中 | 重构 SSE 解析器支持 content block |
| Webview XSS（Claude 响应含恶意 HTML） | 中 | 集成 DOMPurify sanitization（Phase 2） |
| Webview 状态丢失（WebviewView 无 retainContext） | 中 | resolve 时重发全量历史 |
| Agent loop 25 次迭代费用不可控 | 中 | 可配置 maxIterations + webview 显示进度 + 取消按钮 |
| Token 计数超上下文窗口 | 中 | buildApiMessages 增加 token 计数，超长时截断历史 |
| Abort race condition（旧 callback 在新请求后触发） | 中 | AbortError 时 continue，不调用 onError callback |
| Activation 时间慢（MCP 初始化） | 中 | MCP 延迟初始化，首次聊天时连接 |

### 6.3 体积预估

| 项 | 大小 |
|----|------|
| 当前扩展代码 | 32KB |
| highlight.js（按需加载） | ~50KB |
| MCP SDK 及依赖 | ~200KB |
| 总计 | ~280-370KB |

远低于 VSCode Marketplace 500MB 限制，无需拆分 vsix。

## 7. 实施顺序

```
Phase 1 (基础修复)
  ├── 3.1 .vscodeignore 修复
  ├── 3.2 LICENSE.md
  ├── 3.4 WebviewPanel → WebviewView（含 resolve 重发历史 + onDidChangeVisibility）
  └── 3.5 API Key → SecretStorage（含迁移路径 + Linux 降级）

Phase 2 (功能增强)
  ├── 3.3 构建集成（build-publish.ts 新增阶段）
  ├── 4.1 OpenAI 兼容（独立实现 HTTP 请求 + SSE 解析）
  ├── 4.2 语法高亮（esbuild IIFE 预打包 + globalName）
  └── 4.3 Session 持久化（双层存储 + 节流 + 原子写入 + 旧数据清理）

Phase 3 (MCP + Agent)
  ├── 5.1 MCP Client（重新实现传输层）
  ├── 5.2 Tool Use 循环（并发执行 + 错误处理 + 可配置 maxIterations）
  └── 5.3 Webview Tool UI（错误/取消/超时语义 + 并发进度卡片）
```

## 8. 测试策略

- **Phase 1:** 手动测试（Extension Development Host F5）
  - WebviewView resolve/re-resolve 生命周期验证
  - SecretStorage 在 macOS/Linux/Windows 的可用性测试
  - API Key 迁移路径测试

- **Phase 2:** 单元测试 + 手动集成测试
  - 测试框架：`@vscode/test-electron` + `mocha`
  - ClaudeClient OpenAI adapter：mock `fetch` 验证请求格式和 SSE 解析
  - Session 持久化：验证节流、原子写入、过期清理

- **Phase 3:** 集成测试 + 端到端测试
  - MCP transport mock（模拟 stdio subprocess 的 JSON-RPC 通信）
  - Agent loop 测试：验证混合 content block 解析、并发 tool 执行、错误恢复
  - 端到端：真实 MCP server（如 filesystem server）连接测试
