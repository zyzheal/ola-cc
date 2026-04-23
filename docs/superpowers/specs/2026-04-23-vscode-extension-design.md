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

**变更:**

```typescript
// 当前 (WebviewPanel)
this.panel = vscode.window.createWebviewPanel('claudeChat', 'Claude Code', vscode.ViewColumn.Two, {...})

// 改为 (WebviewViewProvider)
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    this.view.webview.options = { enableScripts: true }
    this.view.webview.html = this.getWebviewHtml()
    this.setupMessageHandlers()
  }

  // show() → this.view?.show(true)
  // postMessage → this.view?.webview.postMessage
  // onDidReceiveMessage → this.view?.webview.onDidReceiveMessage
  // 删除 panel.onDidDispose → 不需要，view 由 VSCode 管理
}

// extension.ts 注册
const provider = new ChatViewProvider(context, statusBar)
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider('claudeCode.sidebar', provider)
)
```

**关键变化:**
- 删除 `panel: vscode.WebviewPanel | undefined` 的 optional 处理
- `retainContextWhenHidden: true` 移除（WebviewView 默认保持状态）
- HTML 生成和消息传递接口不变
- `show()` 方法变为聚焦侧边栏

### 3.5 API Key 改用 SecretStorage

**原因:** settings.json 中的密码值不是加密存储的。

**变更:**

```typescript
// 存储
await context.secrets.store('claude-api-key', apiKey)

// 读取
const apiKey = await context.secrets.get('claude-api-key')

// 清除
await context.secrets.delete('claude-api-key')
```

**降级策略:** 如果 SecretStorage 不可用（某些 Linux 缺少 libsecret），降级为 settings.json，但显示警告。

**设置 UI:** `claude.apiKey` 设置为空字符串，新增命令 `claude.setApiKey` 弹出输入框并存储到 SecretStorage。

## 4. Phase 2: 功能增强（3-5 天）

### 4.1 OpenAI 兼容支持

**新增文件:** `vscode-extension/src/api/openai.ts`

从主项目 `src/services/api/openai.ts` 复制。该模块是自包含的（只依赖 `crypto`），将 Anthropic 格式的请求转换为 OpenAI 格式。

**ClaudeClient 变更:**

```typescript
// 新增设置
"claude.provider": {
  "type": "string",
  "enum": ["anthropic", "openai"],
  "default": "anthropic"
}
"claude.baseUrl": {
  "type": "string",
  "default": ""  // 空=使用 provider 默认
}

// 请求路由
const baseUrl = config.get<string>('baseUrl') ||
  (this.provider === 'openai' ? 'http://localhost:11434' : 'https://api.anthropic.com')
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
  minify: !isWatch,
})
```

**Webview HTML 引入:**

```html
<link rel="stylesheet" href="highlight.css">
<script nonce="${nonce}" src="${highlightJsUri}"></script>
<script nonce="${nonce}" src="${appJsUri}"></script>
```

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

**方案:** 双层存储

```typescript
// 快速访问: 最近 50 条消息缓存到 vscode.getState()
// 长期存储: 全部消息写入 context.globalStorageUri (文件系统)

async function saveSession(messages: ChatMessage[]): Promise<void> {
  // 缓存最近 50 条
  const cache = messages.slice(-50)
  vscode.setState({ messages: cache })

  // 持久化到文件
  const uri = vscode.Uri.joinPath(context.globalStorageUri, 'session.json')
  const content = JSON.stringify({ messages, savedAt: Date.now() })
  // 使用 VSCode FileSystem API 写入
}
```

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
  const maxIterations = 25

  while (iteration < maxIterations) {
    iteration++
    const response = await this.callAPI(messages)

    // 解析响应 content blocks
    const toolUses = response.content.filter(b => b.type === 'tool_use')

    if (toolUses.length === 0) {
      // 纯文本响应，流式发送给 webview
      break
    }

    // 有 tool_use: 执行工具
    for (const toolUse of toolUses) {
      callbacks.onToolStart(toolUse)

      // 需要用户确认的工具
      if (this.requiresConfirmation(toolUse.name)) {
        await callbacks.onToolConfirmation(toolUse)
      }

      const result = await this.executeTool(toolUse)
      callbacks.onToolComplete(toolUse, result)

      // 添加 tool_use 和 tool_result 到消息历史
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', ...toolUse }] })
      messages.push({ role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      }]})
    }
  }
}
```

### 5.3 Webview Tool UI

**通信协议:**

```typescript
// Extension host → Webview
{ command: 'tool_start', toolName: '...', input: {...} }
{ command: 'tool_progress', toolName: '...', progress: 'Fetching...' }
{ command: 'tool_complete', toolName: '...', result: {...} }
{ command: 'tool_requires_confirmation', toolName: '...', input: {...} }

// Webview → Extension host
{ command: 'tool_approve', toolName: '...' }
{ command: 'tool_deny', toolName: '...' }
```

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
| highlight.js CSP eval() 限制 | 低 | esbuild 预打包为 IIFE，确认不含 eval |
| SecretStorage 在 Linux 不可用 | 低 | 降级为 settings.json + 警告 |
| Webview 的 `vscode.getState()` 10MB 限制 | 低 | 双层存储方案 |

### 6.2 架构风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| `claude.ts` 深度耦合 CLI | 高 | 不共享，VSCode 独立实现 |
| MCP SDK 依赖 `bun:bundle` | 高 | 重新实现传输层，不直接引用 |
| Agent mode 的流式 + tool_use 混合 | 中 | 重构 SSE 解析器支持 content block |
| Webview XSS（Claude 响应含恶意 HTML） | 中 | 集成 DOMPurify sanitization |
| Webview CSP 不允许 `eval()` | 中 | highlight.js 确认不含 eval |

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
  ├── 3.4 WebviewPanel → WebviewView
  └── 3.5 API Key → SecretStorage

Phase 2 (功能增强)
  ├── 3.3 构建集成（build-publish.ts 新增阶段）
  ├── 4.1 OpenAI 兼容
  ├── 4.2 语法高亮
  └── 4.3 Session 持久化

Phase 3 (MCP + Agent)
  ├── 5.1 MCP Client
  ├── 5.2 Tool Use 循环
  └── 5.3 Webview Tool UI
```

## 8. 测试策略

- **Phase 1:** 手动测试（Extension Development Host F5）
- **Phase 2:** 单元测试（ClaudeClient, OpenAI shim）+ 手动集成测试
- **Phase 3:** 集成测试（MCP transport mock）+ 端到端测试
