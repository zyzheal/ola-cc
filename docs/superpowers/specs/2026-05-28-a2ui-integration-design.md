# A2UI Protocol Integration Design for ola-cc

## Overview

This design integrates Google's A2UI (Agent-to-User Interface) protocol into ola-cc, enabling AI agents to generate interactive web UI components that render directly in the browser. The approach uses a "direct rendering" model: Agent generates A2UI JSON → Tool wraps it as self-contained HTML → Browser opens and renders → User interactions callback to ola-cc via local HTTP.

**Design Date**: 2026-05-28
**Status**: Draft (Reviewed, 22 issues fixed across 2 review rounds)
**Scope**: A2UITool + HTML Generator + Action Server + Validator + Circuit Breaker + Security Hardening

---

## 1. Architecture

### 1.1 System Boundary

```
┌─────────────────────────────────────────────────────────────────┐
│                        ola-cc Process                            │
│                                                                  │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │ Agent    │───►│ A2UI Tool    │───►│ HTML Generator         │  │
│  │ (LLM)   │    │              │    │ (JSON → self-contained │  │
│  └──────────┘    └──────┬───────┘    │  HTML file)            │  │
│                         │            └───────────┬───────────┘  │
│                         │                        │               │
│                         │                        ▼               │
│                         │              ┌───────────────────┐     │
│                         │              │ Temp file write    │     │
│                         │              │ /tmp/a2ui_*.html   │     │
│                         │              └─────────┬─────────┘     │
│                         │                        │               │
│                         │                        ▼               │
│                         │              ┌───────────────────┐     │
│                         │              │ Browser auto-open  │     │
│                         │              │ open(filePath)     │     │
│                         │              └───────────────────┘     │
│                         │                                        │
│  ┌──────────────────────▼──────────────────────────────────────┐ │
│  │         Action HTTP Server (localhost:28900)                 │ │
│  │  POST /a2ui/action  ◄──── Browser Action callback           │ │
│  │  GET  /a2ui/health  ◄──── Health check                      │ │
│  └──────────────────────┬──────────────────────────────────────┘ │
│                         │                                        │
│                         ▼                                        │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │         Action Processing Layer                              ││
│  │  - Validate Action legitimacy                                ││
│  │  - Update Surface state machine                              ││
│  │  - Trigger Agent to continue conversation                    ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        Browser                                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │         A2UI React Renderer (loaded from CDN)              │  │
│  │  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐      │  │
│  │  │ Card  │ │ Form  │ │Table  │ │Button │ │ Input │      │  │
│  │  └───────┘ └───────┘ └───────┘ └───────┘ └───────┘      │  │
│  │                      ▲                                     │  │
│  │              ┌───────┴───────┐                             │  │
│  │              │  DataModel    │                             │  │
│  │              └───────┬───────┘                             │  │
│  │              ┌───────▼───────┐                             │  │
│  │              │  Action Bridge│──── POST /a2ui/action ──►  │  │
│  │              └───────────────┘                             │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Core Modules

| Module | Responsibility | File Path | Dependencies |
|--------|---------------|-----------|--------------|
| **A2UITool** | Tool entry point, coordinates all sub-modules | `src/tools/A2UITool/A2UITool.ts` | HTMLGenerator, Validator, ActionServer |
| **HTMLGenerator** | A2UI JSON → self-contained HTML | `src/tools/A2UITool/htmlGenerator.ts` | None |
| **Validator** | Dual validation (structural + state machine) | `src/tools/A2UITool/validator.ts` | Catalog, SurfaceStateMachine |
| **Catalog** | Component whitelist management | `src/tools/A2UITool/catalog.ts` | None |
| **SurfaceStateMachine** | Surface lifecycle management | `src/tools/A2UITool/surfaceStateMachine.ts` | None |
| **ActionServer** | Local HTTP server for Action callbacks | `src/tools/A2UITool/actionServer.ts` | Node http module |
| **CircuitBreaker** | Circuit breaker / degradation | `src/tools/A2UITool/circuitBreaker.ts` | None |
| **TempFileManager** | Temporary HTML file management | `src/tools/A2UITool/tempFileManager.ts` | None |

### 1.3 Data Flow

```
1. User request → Agent generates A2UI JSON
2. A2UITool.call() receives JSON
3. Validator validates (structural + state machine)
4. CircuitBreaker checks if circuit is open
5. HTMLGenerator generates self-contained HTML
6. Write to /tmp/a2ui_{timestamp}.html
7. open() opens browser
8. ActionServer listens for Action callbacks
9. Action arrives → validate → update state machine → trigger Agent continuation
```

---

## 2. A2UI Tool

### 2.1 Type Definitions

```typescript
// A2UI 协议消息类型（4 种 Server→Client 消息）
type A2UIMessage =
  | { surfaceUpdate: { surfaceId?: string; components: Array<{ id: string; component: A2UIComponent }> } }
  | { dataModelUpdate: { surfaceId?: string; contents: Record<string, unknown> } }
  | { beginRendering: { root: string; catalog?: string } }
  | { deleteSurface: { surfaceId: string } }

// A2UI 组件（Catalog 内定义的组件类型）
interface A2UIComponent {
  type: string                    // 组件类型，如 'Button', 'Card', 'TextField'
  props: Record<string, unknown>  // 组件属性
  children?: string[]             // 子组件 ID 引用
  actions?: string[]              // 允许的 action 类型
}

// Catalog 配置
interface CatalogConfig {
  id: string
  components: Array<{
    type: string
    props: Record<string, { type: string; required?: boolean; default?: unknown }>
    actions?: string[]
  }>
}
```

### 2.2 Interface Definition

```typescript
interface A2UIInput {
  a2ui_messages: A2UIMessage[]    // Agent-generated A2UI JSON messages
  catalog_id?: string             // Optional: specify Catalog
  surface_id?: string             // Optional: specify Surface ID
  theme?: 'light' | 'dark'       // Optional: theme (default: dark)
  title?: string                  // Optional: page title
}

interface A2UIOutput {
  surface_id: string              // Created Surface ID
  file_path: string               // Generated HTML file path
  component_count: number         // Number of rendered components
  action_port: number             // Action listener port
  status: 'rendered' | 'degraded' | 'failed'
}
```

### 2.3 Tool Registration (buildTool Pattern)

A2UITool **必须**使用 `buildTool()` 模式创建（参考 `src/Tool.ts:838`），确保所有必需的 Tool 接口方法都有实现：

```typescript
import { buildTool } from '../../Tool'
import { ToolResult } from '../../ToolResult'

export const A2UITool = buildTool({
  name: 'a2ui',
  description: 'Render interactive web UI from A2UI JSON. Generates a self-contained HTML file and opens it in the browser. User interactions (clicks, form submissions) are sent back as Actions.',

  inputSchema: a2uiInputSchema,  // Zod schema defined below

  // 必需：为 deferred tool discovery 提供搜索提示
  searchHint: 'render UI web page interactive form table button a2ui',

  // 必需：生成 prompt 片段告诉 model 如何使用此 tool
  prompt: () => `Use the a2ui tool to render interactive web UIs. Provide A2UI JSON messages describing the UI components (Card, Button, TextField, Table, etc.). The tool will generate an HTML file and open it in the browser. User interactions will be sent back as Actions that you can process.`,

  // 必需：渲染 tool 结果为用户可见消息
  renderToolResultMessage: (result: ToolResult<A2UIOutput>) => {
    if (result.data.status === 'degraded') {
      return `⚠️ A2UI degraded: falling back to markdown`
    }
    return `✅ Rendered ${result.data.component_count} components → ${result.data.file_path}`
  },

  // 必需：将 tool 结果映射为 API 返回格式
  mapToolResultToToolResultBlockParam: (result: ToolResult<A2UIOutput>, toolUseId: string) => ({
    type: 'tool_result' as const,
    tool_use_id: toolUseId,
    content: JSON.stringify(result.data)
  }),

  // 必需：渲染 tool 调用中的 JSX（终端 UI）
  renderToolUseMessage: (input: A2UIInput) => {
    const count = input.a2ui_messages?.length || 0
    return `Rendering ${count} A2UI message(s)...`
  },

  // 必需：权限检查
  checkPermissions: async (_input: A2UIInput, _context: ToolUseContext) => {
    // A2UI 只写临时文件 + 开 localhost server，不需要额外权限
    return { allowed: true }
  },

  // 必需：classifier 输入生成
  toAutoClassifierInput: (input: A2UIInput) => ({
    command: `a2ui render ${input.a2ui_messages?.length || 0} messages`,
    file_paths: [],
    description: `Render A2UI interactive UI with ${input.a2ui_messages?.length || 0} messages`
  }),

  // 必需：用户可见名称
  userFacingName: () => 'A2UI',

  // 可选：结果大小限制
  maxResultSizeChars: 10_000,

  // 核心实现
  async call(args: A2UIInput, context: ToolUseContext): Promise<ToolResult<A2UIOutput>> {
    // ... 见 2.4 Call Flow
  }
})
```

### 2.4 Call Flow

```typescript
async call(args: A2UIInput, context: ToolUseContext): Promise<ToolResult<A2UIOutput>> {
  // 0. 输入验证
  if (!args.a2ui_messages || args.a2ui_messages.length === 0) {
    return this.errorOutput('A2UI_VALIDATION_FAILED', 'a2ui_messages is empty')
  }

  // 1. Circuit breaker check
  if (this.circuitBreaker.isOpen()) {
    return this.degradedOutput('Circuit breaker open, use markdown fallback')
  }

  // 2. Generate Surface ID（sanitize: only alphanumeric + hyphens）
  const surfaceId = sanitizeSurfaceId(args.surface_id || generateSurfaceId())

  // 3. Validate A2UI JSON
  const validation = this.validator.validate(args.a2ui_messages)
  if (!validation.valid) {
    this.circuitBreaker.recordFailure()
    return this.validationErrorOutput(validation.errors)
  }

  // 4. Generate HTML
  const html = this.htmlGenerator.generate({
    messages: args.a2ui_messages,
    surfaceId,
    actionPort: this.actionServer.port,
    catalog: this.catalog.get(args.catalog_id || 'default'),
    theme: args.theme,
    title: args.title
  })

  // 5. Write temp file
  const filePath = await this.tempFileManager.write(surfaceId, html)

  // 6. Open browser（headless 环境降级）
  try {
    await open(filePath)
  } catch (err) {
    // Headless 环境或 open 不可用：降级到终端提示
    return {
      data: {
        surface_id: surfaceId,
        file_path: filePath,
        component_count: countComponents(args.a2ui_messages),
        action_port: this.actionServer.port,
        status: 'degraded'
      },
      newMessages: [{
        type: 'system',
        message: `⚠️ Cannot open browser (headless environment). HTML file saved at: ${filePath}`
      }]
    }
  }

  // 7. Register Surface state
  this.surfaceStateMachine.create(surfaceId, args.a2ui_messages)

  // 8. Ensure Action server is running
  await this.actionServer.ensureRunning()

  // 9. Record success
  this.circuitBreaker.recordSuccess()

  return {
    data: {
      surface_id: surfaceId,
      file_path: filePath,
      component_count: countComponents(args.a2ui_messages),
      action_port: this.actionServer.port,
      status: 'rendered'
    }
  }
}
```

### 2.5 Action-to-Conversation Bridge

**关键设计**：Action 回调必须能注入回 Agent 对话循环，否则用户交互是"死胡同"。

```typescript
// ActionServer 回调 → Agent 对话续接
// 方案：利用 ToolResult.newMessages 将 Action 结果注入对话
// 当 Agent 调用 a2ui tool 后，ActionServer 收到用户交互时：
// 1. 将 Action 存入 pendingActions 队列
// 2. 通过 context.setToolJSX() 更新终端 UI 显示 Action 状态
// 3. 下一轮 Agent 调用时，pendingActions 自动作为 tool result 返回

class ActionProcessor {
  private pendingActions: Map<string, A2UIAction[]> = new Map()

  onActionReceived(action: A2UIAction): void {
    // 存入待处理队列
    const actions = this.pendingActions.get(action.surfaceId) || []
    actions.push(action)
    this.pendingActions.set(action.surfaceId, actions)

    // 更新终端 UI 状态
    this.updateTerminalStatus(action)
  }

  // Agent 下次调用时消费 pending actions
  consumeActions(surfaceId: string): A2UIAction[] {
    const actions = this.pendingActions.get(surfaceId) || []
    this.pendingActions.delete(surfaceId)
    return actions
  }

  private updateTerminalStatus(action: A2UIAction): void {
    // 通过 Ink setToolJSX 在终端显示 action 状态
    // 例如："User clicked Submit button on Surface abc123"
  }
}
```

**集成到 call() 流程**：在 Step 9 之后，如果有 pending actions，将它们作为 `ToolResult.newMessages` 返回给 Agent，触发 Agent 继续处理用户交互。

### 2.3 Input Schema (Zod)

```typescript
const inputSchema = z.object({
  a2ui_messages: z.array(z.object({
    surfaceUpdate: z.object({
      surfaceId: z.string().optional(),
      components: z.array(z.object({
        id: z.string(),
        component: z.record(z.any())
      }))
    }).optional(),
    dataModelUpdate: z.object({
      surfaceId: z.string().optional(),
      contents: z.record(z.any())
    }).optional(),
    beginRendering: z.object({
      root: z.string(),
      catalog: z.string().optional()
    }).optional(),
    deleteSurface: z.object({
      surfaceId: z.string()
    }).optional()
  })).describe('A2UI JSON messages to render'),
  catalog_id: z.string().optional().describe('Catalog ID to use'),
  surface_id: z.string().optional().describe('Surface ID to create'),
  theme: z.enum(['light', 'dark']).optional().describe('UI theme'),
  title: z.string().optional().describe('Page title')
})
```

---

## 3. HTML Generator

### 3.1 Self-Contained HTML Template

The HTML file is fully self-contained, loading the A2UI renderer from CDN:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}}</title>
  <!-- CSP: nonce-based，禁止 unsafe-inline -->
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'self';
             script-src 'self' https://unpkg.com https://cdn.jsdelivr.net 'nonce-{{nonce}}';
             style-src 'self' 'nonce-{{nonce}}';
             connect-src http://localhost:{{actionPort}}">
  <!-- SRI: Subresource Integrity 防止 CDN 篡改 -->
  <script crossorigin integrity="sha384-{{reactSRI}}"
    src="https://unpkg.com/react@18.2.0/umd/react.production.min.js"></script>
  <script crossorigin integrity="sha384-{{reactDomSRI}}"
    src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js"></script>
  <script integrity="sha384-{{a2uiRendererSRI}}"
    src="https://cdn.jsdelivr.net/npm/@anthropic-ai/a2ui-renderer-react@0.8.0"></script>
  <style nonce="{{nonce}}">
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 20px; }
    body.light { background: #ffffff; color: #333333; }
    body.dark { background: #1a1a2e; color: #e0e0e0; }
    #a2ui-root { max-width: 800px; margin: 0 auto; }
    .a2ui-error { color: #d32f2f; padding: 16px; background: #ffebee; border-radius: 8px; }
    .a2ui-loading { text-align: center; padding: 40px; color: #666; }
    .a2ui-status { position: fixed; bottom: 16px; right: 16px; padding: 8px 12px;
                   border-radius: 4px; font-size: 12px; }
    .a2ui-status.connected { background: #e8f5e9; color: #2e7d32; }
    .a2ui-status.disconnected { background: #fff3e0; color: #e65100; }
  </style>
</head>
<body class="{{theme}}">
  <div id="a2ui-root">
    <div class="a2ui-loading">Loading A2UI components...</div>
  </div>
  <div id="a2ui-status" class="a2ui-status"></div>

  <!-- 安全数据注入：使用 script type="application/json" 避免 XSS -->
  <script id="a2ui-data" type="application/json">{{a2uiJSON}}</script>
  <div id="a2ui-config"
       data-port="{{actionPort}}"
       data-surface-id="{{surfaceId}}"
       data-catalog="{{catalogComponents}}"
       data-token="{{actionToken}}"
       style="display:none"></div>

  <script nonce="{{nonce}}">
    // 安全解析：从 DOM 元素读取数据，而非直接嵌入
    const A2UI_DATA = JSON.parse(document.getElementById('a2ui-data').textContent);
    const ACTION_PORT = parseInt(document.getElementById('a2ui-config').dataset.port);
    const SURFACE_ID = document.getElementById('a2ui-config').dataset.surfaceId;
    const CATALOG_COMPONENTS = JSON.parse(document.getElementById('a2ui-config').dataset.catalog);
    const ACTION_TOKEN = document.getElementById('a2ui-config').dataset.token;

    // Action bridge（带认证 token）
    async function sendAction(action) {
      const statusEl = document.getElementById('a2ui-status');
      try {
        const resp = await fetch(`http://localhost:${ACTION_PORT}/a2ui/action`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-A2UI-Token': ACTION_TOKEN  // 防 CSRF
          },
          body: JSON.stringify({
            surfaceId: SURFACE_ID,
            ...action,
            timestamp: Date.now()
          })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        statusEl.className = 'a2ui-status connected';
        statusEl.textContent = 'Connected';
        return await resp.json();
      } catch (err) {
        console.error('Action callback failed:', err);
        statusEl.className = 'a2ui-status disconnected';
        statusEl.textContent = 'Disconnected - action saved locally';
        localStorage.setItem(`a2ui_action_${Date.now()}`, JSON.stringify(action));
        throw err;
      }
    }

    // Initialize renderer（使用 textContent 替代 innerHTML 防 XSS）
    try {
      const renderer = new A2UIRenderer({
        root: document.getElementById('a2ui-root'),
        onAction: sendAction,
        onError: (err) => {
          const errEl = document.createElement('div');
          errEl.className = 'a2ui-error';
          errEl.textContent = 'Render error: ' + String(err.message || 'Unknown error');
          document.getElementById('a2ui-root').replaceChildren(errEl);
        }
      });
      renderer.render(A2UI_DATA);
      document.getElementById('a2ui-status').className = 'a2ui-status connected';
      document.getElementById('a2ui-status').textContent = 'Connected';
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'a2ui-error';
      errEl.textContent = 'Failed to initialize: ' + String(err.message || 'Unknown error');
      document.getElementById('a2ui-root').replaceChildren(errEl);
    }
  </script>
</body>
</html>
```

**安全变更说明**：

| 变更 | 前 | 后 | 原因 |
|------|-----|-----|------|
| CSP | `'unsafe-inline'` | `'nonce-{{nonce}}'` | unsafe-inline 允许任意内联脚本，完全绕过 CSP |
| SRI | 无 | `integrity="sha384-{{SRI}}"` | 防止 CDN 被篡改注入恶意脚本 |
| XSS 修复 | `innerHTML = ...${err.message}` | `textContent = ... + String(err.message)` | err.message 可含 `<script>` 标签 |
| CORS | `http://localhost:*` | `http://localhost:{{actionPort}}` | 限定具体端口，不开放所有端口 |
| 认证 | 无 | `X-A2UI-Token` header | 防止其他 localhost 页面伪造 Action |
| 模板变量 | `{{title}}` 直接嵌入 | HTML 实体转义后嵌入 | 防止 title 含 `<script>` 注入 |

### 3.2 HTMLGenerator Class

```typescript
import { randomBytes, createHash } from 'crypto'

interface HTMLGeneratorOptions {
  messages: A2UIMessage[]
  surfaceId: string
  actionPort: number
  catalog: CatalogConfig
  actionToken: string  // CSRF token for Action authentication
  theme?: 'light' | 'dark'
  title?: string
}

class HTMLGenerator {
  private template: string
  private sriCache: Map<string, string> = new Map()

  constructor() {
    this.template = fs.readFileSync(
      path.join(__dirname, 'templates/a2ui.html'), 'utf-8'
    )
  }

  generate(options: HTMLGeneratorOptions): string {
    const { messages, surfaceId, actionPort, catalog, actionToken, theme, title } = options

    // 生成 nonce（每次渲染唯一）
    const nonce = randomBytes(16).toString('base64')

    // HTML 实体转义（防止模板注入 XSS）
    const escapeHtml = (str: string): string =>
      str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

    const safeTitle = escapeHtml(title || `A2UI - ${surfaceId}`)
    const safeTheme = ['light', 'dark'].includes(theme || '') ? theme! : 'dark'
    const safeSurfaceId = escapeHtml(surfaceId)

    return this.template
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace('{{a2uiJSON}}', JSON.stringify(messages))
      .replace('{{actionPort}}', String(actionPort))
      .replace('{{surfaceId}}', safeSurfaceId)
      .replace('{{theme}}', safeTheme)
      .replace('{{title}}', safeTitle)
      .replace('{{catalogComponents}}', JSON.stringify(catalog.components))
      .replace('{{actionToken}}', escapeHtml(actionToken))
      .replace('{{reactSRI}}', this.getSRI('react@18.2.0'))
      .replace('{{reactDomSRI}}', this.getSRI('react-dom@18.2.0'))
      .replace('{{a2uiRendererSRI}}', this.getSRI('a2ui-renderer-react@0.8.0'))
  }

  // SRI hash 预计算（构建时或首次使用时计算，缓存结果）
  private getSRI(packageId: string): string {
    if (!this.sriCache.has(packageId)) {
      // 实际实现：下载文件 → SHA384 → 缓存
      // 构建时预计算写入 sri-hashes.json
      const hashes = require('./sri-hashes.json')
      this.sriCache.set(packageId, hashes[packageId] || '')
    }
    return this.sriCache.get(packageId)!
  }
}
```

### 3.3 Temp File Management

```typescript
class TempFileManager {
  private basePath = os.tmpdir()
  private activeSurfaces: Set<string> = new Set()  // 跟踪已创建的 Surface

  generatePath(surfaceId: string): string {
    // 防止路径遍历：只允许字母数字和连字符
    const safeId = surfaceId.replace(/[^a-zA-Z0-9-]/g, '')
    if (safeId !== surfaceId || surfaceId.includes('..')) {
      throw new Error(`Invalid surfaceId: ${surfaceId}`)
    }
    return path.join(this.basePath, `a2ui_${safeId}.html`)
  }

  async write(surfaceId: string, html: string): Promise<string> {
    const filePath = this.generatePath(surfaceId)
    await fs.promises.writeFile(filePath, html, { mode: 0o600 })
    this.activeSurfaces.add(surfaceId)
    return filePath
  }

  async cleanup(surfaceId: string): Promise<void> {
    const filePath = this.generatePath(surfaceId)
    try {
      await fs.promises.unlink(filePath)
      this.activeSurfaces.delete(surfaceId)
    } catch {
      // File may already be deleted
    }
  }

  // 只清理已跟踪的 Surface 文件（防止删除无关文件）
  async cleanupAll(): Promise<void> {
    const cleanupPromises = Array.from(this.activeSurfaces).map(id => this.cleanup(id))
    await Promise.all(cleanupPromises)
    this.activeSurfaces.clear()
  }
}
```

---

## 4. Action HTTP Server

### 4.1 Endpoints

| Method | Path | Description | Request Body | Response |
|--------|------|-------------|--------------|----------|
| POST | `/a2ui/action` | Receive user interaction | Action object | `{ status: 'ok', actionId }` |
| GET | `/a2ui/surfaces` | List active surfaces | - | Surface list |
| DELETE | `/a2ui/surfaces/:id` | Delete surface | - | `{ status: 'deleted' }` |
| GET | `/a2ui/health` | Health check | - | `{ status: 'ok', uptime }` |

### 4.2 Action Data Structure

```typescript
interface A2UIAction {
  surfaceId: string
  actionId: string
  componentId: string
  actionType: string      // e.g., 'onClick', 'onChange', 'onSubmit'
  payload: Record<string, unknown>
  timestamp: number
}
```

### 4.3 Server Implementation

```typescript
import { randomBytes } from 'crypto'

interface ActionServerConfig {
  port: number           // Listen port (default: 28900)
  host: string           // Listen address (default: 127.0.0.1)
  maxBodySize: number    // Max request body (default: 1MB)
}

class ActionServer {
  private server: http.Server | null = null
  private actions: A2UIAction[] = []
  private readonly maxActions = 1000  // 防止内存无限增长
  private callback: ActionCallback | null = null
  private actionTokens: Set<string> = new Set()  // 已发放的 Action 认证 token
  port: number

  constructor(private config: ActionServerConfig) {
    this.port = config.port
  }

  // 生成 Action 认证 token（每个 Surface 一个）
  generateActionToken(): string {
    const token = randomBytes(32).toString('hex')
    this.actionTokens.add(token)
    return token
  }

  // 验证 Action token
  private verifyActionToken(token: string | undefined): boolean {
    return !!token && this.actionTokens.has(token)
  }

  async ensureRunning(): Promise<void> {
    if (this.server) return
    this.port = await findAvailablePort(this.config.port)
    await this.start()
  }

  private async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(this.port, this.config.host, () => resolve())
      this.server.on('error', reject)
    })
  }

  onAction(callback: ActionCallback): void {
    this.callback = callback
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS: 只允许 file:// 协议（origin 为 null）和 localhost
    const origin = req.headers.origin
    if (origin === 'null' || origin?.startsWith('http://localhost:')) {
      res.setHeader('Access-Control-Allow-Origin', origin)
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-A2UI-Token')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)

    if (req.method === 'POST' && url.pathname === '/a2ui/action') {
      await this.handleAction(req, res)
    } else if (req.method === 'GET' && url.pathname === '/a2ui/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
    } else {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  }

  private async handleAction(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 认证：验证 X-A2UI-Token
    const token = req.headers['x-a2ui-token'] as string | undefined
    if (!this.verifyActionToken(token)) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Invalid or missing action token' }))
      return
    }

    // 读取请求体
    const body = await this.readBody(req)

    // 输入验证：大小限制
    if (body.length > this.config.maxBodySize) {
      res.writeHead(413)
      res.end(JSON.stringify({ error: 'Request body too large' }))
      return
    }

    // 安全 JSON 解析
    let action: A2UIAction
    try {
      action = JSON.parse(body)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    // 输入验证：必要字段
    if (!action.surfaceId || !action.actionId) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Missing surfaceId or actionId' }))
      return
    }

    // Action 白名单校验
    if (!this.isActionAllowed(action)) {
      res.writeHead(403)
      res.end(JSON.stringify({ error: `Action '${action.actionType}' not allowed` }))
      return
    }

    // LRU 淘汰：超过最大数量时移除最早的
    if (this.actions.length >= this.maxActions) {
      this.actions.splice(0, this.actions.length - this.maxActions + 1)
    }

    // 只 push 一次（修复 duplicate push bug）
    this.actions.push(action)

    if (this.callback) {
      const result = await this.callback(action)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', actionId: action.actionId }))
    }
  }

  private isActionAllowed(action: A2UIAction): boolean {
    const allowedActions = ['onClick', 'onChange', 'onSubmit']
    return allowedActions.includes(action.actionType)
  }

  // 安全的请求体读取（有大小限制）
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalSize = 0

      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length
        if (totalSize > this.config.maxBodySize) {
          req.destroy()
          reject(new Error('Request body too large'))
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'))
      })

      req.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve())
      })
    }
    this.actionTokens.clear()
  }
}
```

### 4.4 Port Conflict Resolution

```typescript
async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = http.createServer()
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve())
        })
        server.on('error', reject)
      })
      return port
    } catch {
      continue
    }
  }
  throw new Error('No available port found')
}
```

---

## 5. Dual Validator

### 5.1 Structural Validation

```typescript
interface ValidationRule {
  name: string
  validate: (message: A2UIMessage, catalog: Catalog) => ValidationError | null
}

class StructuralValidator {
  private rules: ValidationRule[] = [
    { name: 'component_in_catalog', validate: (msg, catalog) => { /* ... */ } },
    { name: 'unique_component_id', validate: (msg) => { /* ... */ } },
    { name: 'valid_data_binding', validate: (msg) => { /* ... */ } },
    { name: 'action_in_whitelist', validate: (msg, catalog) => { /* ... */ } }
  ]

  validate(messages: A2UIMessage[], catalog: Catalog): ValidationResult {
    const errors: ValidationError[] = []
    for (const msg of messages) {
      for (const rule of this.rules) {
        const error = rule.validate(msg, catalog)
        if (error) errors.push(error)
      }
    }
    return { valid: errors.length === 0, errors }
  }
}
```

### 5.2 State Machine Validation

```typescript
type SurfaceState = 'nonexistent' | 'created' | 'rendering' | 'interactive' | 'deleted'

const VALID_TRANSITIONS: Record<string, SurfaceState[]> = {
  'nonexistent → surfaceUpdate': ['created'],
  'created → surfaceUpdate': ['created'],
  'created → beginRendering': ['rendering'],
  'created → deleteSurface': ['deleted'],
  'rendering → dataModelUpdate': ['interactive'],
  'rendering → surfaceUpdate': ['rendering'],
  'rendering → deleteSurface': ['deleted'],
  'interactive → dataModelUpdate': ['interactive'],
  'interactive → surfaceUpdate': ['interactive'],
  'interactive → deleteSurface': ['deleted'],
  'deleted → surfaceUpdate': ['created'],
}

class SurfaceStateMachine {
  private states: Map<string, SurfaceState> = new Map()

  getState(surfaceId: string): SurfaceState {
    return this.states.get(surfaceId) || 'nonexistent'
  }

  validate(surfaceId: string, messageType: string): { valid: boolean; error?: string } {
    const currentState = this.getState(surfaceId)
    const transitionKey = `${currentState} → ${messageType}`
    const validTargets = VALID_TRANSITIONS[transitionKey]

    if (!validTargets) {
      return {
        valid: false,
        error: `Invalid transition: ${currentState} → ${messageType} for surface '${surfaceId}'`
      }
    }
    return { valid: true }
  }

  transition(surfaceId: string, messageType: string): void {
    const currentState = this.getState(surfaceId)
    const transitionKey = `${currentState} → ${messageType}`
    const validTargets = VALID_TRANSITIONS[transitionKey]
    if (validTargets && validTargets.length > 0) {
      this.states.set(surfaceId, validTargets[0])
    }
  }
}
```

### 5.3 Combined Validator

```typescript
class A2UIValidator {
  constructor(
    private structural: StructuralValidator,
    private stateMachine: SurfaceStateMachine,
    private catalog: Catalog
  ) {}

  validate(messages: A2UIMessage[]): ValidationResult {
    const allErrors: ValidationError[] = []

    // 1. Structural validation
    const structuralResult = this.structural.validate(messages, this.catalog)
    allErrors.push(...structuralResult.errors)

    // 2. State machine validation
    for (const msg of messages) {
      const surfaceId = this.extractSurfaceId(msg)
      const messageType = this.extractMessageType(msg)
      const stateResult = this.stateMachine.validate(surfaceId, messageType)
      if (!stateResult.valid) {
        allErrors.push({
          rule: 'state_machine',
          message: stateResult.error!
        })
      }
    }

    // 3. If all passed, execute state transitions
    if (allErrors.length === 0) {
      for (const msg of messages) {
        const surfaceId = this.extractSurfaceId(msg)
        const messageType = this.extractMessageType(msg)
        this.stateMachine.transition(surfaceId, messageType)
      }
    }

    return { valid: allErrors.length === 0, errors: allErrors }
  }
}
```

---

## 6. Circuit Breaker

### 6.1 State Machine

```
CLOSED (normal)
  │ N consecutive failures
  ▼
OPEN (tripped) ────── 30s timeout ──────┐
  │                                      │
  │ Degrade to markdown                  │
  ▼                                      ▼
  Wait                         HALF_OPEN (half-open)
                                   │ 1 success → CLOSED
                                   │ 1 failure → OPEN
```

### 6.2 Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `failureThreshold` | 3 | Consecutive failures to trip |
| `resetTimeoutMs` | 30000 | Circuit open duration (ms) |
| `halfOpenMaxAttempts` | 1 | Half-open attempt count |

### 6.3 Implementation

```typescript
type CircuitState = 'closed' | 'open' | 'half-open'

class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount: number = 0
  private lastFailureTime: number = 0

  constructor(private config: CircuitBreakerConfig) {}

  isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = 'half-open'
        return false
      }
      return true
    }
    return false
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed'
    }
    this.failureCount = 0
  }

  recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()
    if (this.state === 'half-open') {
      this.state = 'open'
      return
    }
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open'
    }
  }
}
```

### 6.4 Degradation Output

```typescript
private degradedOutput(reason: string): ToolResult<A2UIOutput> {
  return {
    data: {
      surface_id: 'degraded',
      file_path: '',
      component_count: 0,
      action_port: 0,
      status: 'degraded'
    },
    newMessages: [{
      type: 'system',
      message: `⚠️ A2UI degraded: ${reason}. Falling back to markdown rendering.`
    }]
  }
}
```

---

## 7. Catalog Management

### 7.1 Default Components

| Component | Props | Actions |
|-----------|-------|---------|
| `Column` | `children`, `gap` | - |
| `Row` | `children`, `gap` | - |
| `Text` | `text`, `style`, `usageHint` | - |
| `Card` | `child`, `title` | - |
| `Button` | `label`, `variant` | `onClick` |
| `TextField` | `label`, `placeholder`, `value` | `onChange` |
| `Select` | `label`, `options`, `value` | `onChange` |

### 7.2 Catalog Class

```typescript
class Catalog {
  private catalogs: Map<string, CatalogConfig> = new Map()

  constructor() {
    this.register(this.defaultCatalog())
  }

  register(config: CatalogConfig): void {
    this.catalogs.set(config.id, config)
  }

  get(id: string): CatalogConfig {
    return this.catalogs.get(id) || this.catalogs.get('default')!
  }

  hasComponent(type: string): boolean {
    return this.get('default').components.some(c => c.type === type)
  }

  get componentTypes(): string[] {
    return this.get('default').components.map(c => c.type)
  }
}
```

---

## 8. Security Design

### 8.1 Security Layers

| Layer | Threat | Protection |
|-------|--------|------------|
| **Input** | Malicious A2UI JSON | Structural validation + whitelist + surfaceId sanitize |
| **Render** | XSS injection | CSP nonce-based (no unsafe-inline) + SRI + textContent |
| **Communication** | MITM attack | localhost only + specific port CORS |
| **Action** | Forged Action / CSRF | X-A2UI-Token per-surface authentication |
| **Template** | Template variable injection | HTML entity escaping for title/theme/surfaceId |
| **Resource** | Temp file leak / path traversal | activeSurfaces tracking + surfaceId validation |

### 8.2 CSP Configuration (Nonce-based)

```
default-src 'self';
script-src 'self' https://unpkg.com https://cdn.jsdelivr.net 'nonce-{{nonce}}';
style-src 'self' 'nonce-{{nonce}}';
connect-src http://localhost:{{actionPort}}
```

**关键安全原则**：
- **禁止 `unsafe-inline`**：CSP `unsafe-inline` 允许页面上任意内联脚本执行，完全绕过 CSP 保护。使用 nonce 确保只有我们生成的脚本可以执行。
- **SRI (Subresource Integrity)**：CDN 脚本带 `integrity="sha384-..."` 属性，防止 CDN 被篡改注入恶意代码。
- **textContent 替代 innerHTML**：错误消息使用 `textContent` 渲染，防止 `err.message` 含 `<script>` 标签导致 XSS。

### 8.3 Action Authentication

每个 Surface 创建时生成唯一的 `actionToken`（32 字节随机 hex），注入到 HTML 的 `data-token` 属性。浏览器发送 Action 时必须携带 `X-A2UI-Token` header，ActionServer 验证 token 有效性。

```typescript
// 生成 token
const actionToken = randomBytes(32).toString('hex')

// HTML 注入
<div data-token="{{actionToken}}"></div>

// 浏览器发送
headers: { 'X-A2UI-Token': ACTION_TOKEN }

// Server 验证
if (!this.actionTokens.has(token)) {
  res.writeHead(401)
  res.end(JSON.stringify({ error: 'Invalid or missing action token' }))
}
```

### 8.4 Temp File Permissions

```typescript
await fs.promises.writeFile(filePath, html, { mode: 0o600 })
```

---

## 9. Error Handling

### 9.1 Error Classification

| Error Type | Strategy | User Perception |
|-----------|----------|-----------------|
| A2UI JSON format error | Return validation details | Agent receives error, can retry |
| Component not in whitelist | Return whitelist info | Agent receives catalog info |
| Surface state invalid | Return current + expected state | Agent receives state machine info |
| Browser open failure | Degrade to terminal text | User sees degradation prompt |
| Action callback failure | Browser local cache + retry | User sees connection status |
| Circuit breaker open | Degrade to markdown | User sees circuit breaker prompt |

### 9.2 Error Format

```typescript
interface A2UIError {
  code: string           // e.g., 'A2UI_VALIDATION_FAILED'
  message: string        // Human-readable description
  details: {
    type: string         // Error type
    path?: string        // Error location
    expected?: string    // Expected value
    actual?: string      // Actual value
  }
  suggestions?: string[] // Fix suggestions
}
```

---

## 10. Testing Strategy

| Test Type | Coverage | Tool |
|-----------|----------|------|
| Unit tests | Validator, Catalog, SurfaceStateMachine, CircuitBreaker | Bun test |
| Integration tests | A2UITool.call() full flow | Bun test + mock |
| E2E tests | HTML generation → browser render → Action callback | Playwright |
| Property tests | Random A2UI JSON generation → validation pass rate | fast-check |

---

## 11. Implementation Plan

### Phase 1: Core SDK (3 days)

| Task | File | Effort |
|------|------|--------|
| A2UITool scaffold | `src/tools/A2UITool/A2UITool.ts` | 0.5 day |
| Catalog + default components | `src/tools/A2UITool/catalog.ts` | 0.5 day |
| Structural validator | `src/tools/A2UITool/validator.ts` | 0.5 day |
| Surface state machine | `src/tools/A2UITool/surfaceStateMachine.ts` | 0.5 day |
| Circuit breaker | `src/tools/A2UITool/circuitBreaker.ts` | 0.5 day |
| TypeScript types | `src/tools/A2UITool/types.ts` | 0.5 day |

### Phase 2: HTML Rendering (2 days)

| Task | File | Effort |
|------|------|--------|
| HTML template | `src/tools/A2UITool/templates/a2ui.html` | 0.5 day |
| HTML generator | `src/tools/A2UITool/htmlGenerator.ts` | 0.5 day |
| Temp file manager | `src/tools/A2UITool/tempFileManager.ts` | 0.25 day |
| Browser open integration | `src/tools/A2UITool/A2UITool.ts` | 0.25 day |
| Integration testing | `src/tools/A2UITool/__tests__/` | 0.5 day |

### Phase 3: Action Callback (2 days)

| Task | File | Effort |
|------|------|--------|
| Action server | `src/tools/A2UITool/actionServer.ts` | 1 day |
| Action processing | `src/tools/A2UITool/actionProcessor.ts` | 0.5 day |
| Agent continuation trigger | `src/tools/A2UITool/A2UITool.ts` | 0.5 day |

**Total**: 7 days

---

## 12. Success Criteria

| Criteria | Verification |
|----------|-------------|
| Agent generates valid A2UI JSON | Unit test: 100% validation pass rate for default catalog |
| HTML renders in browser | E2E: Playwright test renders Card + Button + TextField |
| Action callbacks work | E2E: Click button → Action received by ola-cc |
| Circuit breaker works | Unit test: 3 failures → degraded output |
| State machine prevents invalid transitions | Unit test: all invalid transitions rejected |
| Security: localhost only | Integration test: external connection rejected |

---

## 13. Review Notes

### Round 1: Initial Review (2026-05-28)

| ID | Priority | Issue | Fix |
|----|----------|-------|-----|
| F-01 | P0 | JSON injection XSS risk in HTML template | Changed to `<script type="application/json">` + DOM parse |
| F-02 | P0 | `readBody()` not implemented | Added safe JSON parsing with try-catch |
| F-03 | P0 | No lifecycle management for ActionServer | Added `stop()` method and cleanup |
| F-04 | P1 | CDN versions not locked | Locked to React 18.2.0, A2UI renderer 0.8.0 |
| F-05 | P1 | CORS `Access-Control-Allow-Origin: *` too permissive | Changed to `null` (file:// protocol origin) |
| F-06 | P1 | `actions` array grows unbounded | Added `maxActions: 1000` with LRU eviction |
| F-07 | P1 | No input validation for empty/large payloads | Added empty array check + body size limit |
| F-08 | P2 | `z.record(z.any())` too loose | To be addressed with specific component prop types in Phase 1 |

### Round 2: Domain Expert Team Review (2026-05-28)

**Architecture Expert Findings:**

| ID | Priority | Issue | Fix |
|----|----------|-------|-----|
| A-01 | P0 | Missing ~10 required Tool interface methods | Rewrote A2UITool using `buildTool()` pattern with all required methods |
| A-02 | P0 | Action callback is a dead end (no agent continuation) | Added ActionProcessor with pendingActions queue + newMessages bridge |
| A-03 | P1 | No `buildTool()` pattern | Changed to `buildTool()` from `src/Tool.ts:838` |
| A-04 | P1 | TempFileManager cleanupAll deletes unrelated files | Changed to activeSurfaces tracking, only delete known files |
| A-05 | P2 | Duplicate handleAction code (push twice) | Removed duplicate validation + push block |

**Quality Expert Findings:**

| ID | Priority | Issue | Fix |
|----|----------|-------|-----|
| Q-01 | P0 | `open()` no try-catch, crashes in headless | Added try-catch with degraded output + file path message |
| Q-02 | P0 | A2UIMessage type never explicitly defined | Added full type definitions for A2UIMessage, A2UIComponent, CatalogConfig |
| Q-03 | P0 | Duplicate push bug in handleAction() (lines 518-526) | Removed duplicate code block |
| Q-04 | P1 | `z.record(z.any())` too loose for component props | Will be tightened with specific component types in Phase 1 |
| Q-05 | P1 | readBody() still uses generic promise pattern | Added proper stream reading with size limit |

**Security Expert Findings:**

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| V-1 | Critical | CSP `'unsafe-inline'` defeats entire XSS protection | Changed to nonce-based CSP |
| V-2 | Critical | `innerHTML` XSS via `err.message` | Changed to `textContent` + `replaceChildren()` |
| V-3 | High | No SRI on CDN scripts | Added `integrity="sha384-..."` attributes |
| V-4 | High | CORS `null` allows any file:// page | Changed to origin validation (null or localhost) |
| V-5 | High | Action Server has no authentication | Added X-A2UI-Token per-surface auth |
| V-6 | Medium | Template variable injection (title/theme) | Added HTML entity escaping |
| V-7 | Medium | Duplicate push bug in handleAction() | Removed duplicate code |
| V-8 | Medium | cleanupAll path traversal via surfaceId | Added surfaceId sanitization + activeSurfaces tracking |

### Remaining Considerations

1. **A2UI Renderer CDN availability**: If unpkg.com/jsdelivr.net is down, HTML won't render. Consider bundling renderer as fallback.
2. **Concurrent Surface management**: Multiple simultaneous A2UI surfaces may conflict. Need surface-level locking.
3. **Agent prompt design**: Not covered in this spec. Agent needs specific prompts to generate valid A2UI JSON. Should be addressed in Phase 1.
4. **Terminal fallback**: When browser open fails (headless server), need terminal rendering fallback. Now partially addressed with try-catch degradation.
5. **SRI hash pre-computation**: Need to build `sri-hashes.json` during build phase for CDN script integrity verification.
