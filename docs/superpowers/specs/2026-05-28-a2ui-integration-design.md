# A2UI Protocol Integration Design for ola-cc

## Overview

This design integrates Google's A2UI (Agent-to-User Interface) protocol into ola-cc, enabling AI agents to generate interactive web UI components that render directly in the browser. The approach uses a "direct rendering" model: Agent generates A2UI JSON → Tool wraps it as self-contained HTML → Browser opens and renders → User interactions callback to ola-cc via local HTTP.

**Design Date**: 2026-05-28
**Status**: Draft
**Scope**: A2UITool + HTML Generator + Action Server + Validator + Circuit Breaker

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

### 2.1 Interface Definition

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

### 2.2 Call Flow

```typescript
async call(args: A2UIInput, context: ToolUseContext): Promise<ToolResult<A2UIOutput>> {
  // 1. Circuit breaker check
  if (this.circuitBreaker.isOpen()) {
    return this.degradedOutput('Circuit breaker open, use markdown fallback')
  }

  // 2. Generate Surface ID
  const surfaceId = args.surface_id || generateSurfaceId()

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

  // 6. Open browser
  await open(filePath)

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
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'self';
             script-src 'self' https://unpkg.com https://cdn.jsdelivr.net 'unsafe-inline';
             style-src 'self' 'unsafe-inline';
             connect-src http://localhost:*">
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@anthropic-ai/a2ui-renderer-react@latest"></script>
  <style>
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

  <script>
    const A2UI_DATA = {{a2uiJSON}};
    const ACTION_PORT = {{actionPort}};
    const SURFACE_ID = '{{surfaceId}}';
    const CATALOG_COMPONENTS = {{catalogComponents}};

    // Action bridge
    async function sendAction(action) {
      const statusEl = document.getElementById('a2ui-status');
      try {
        const resp = await fetch(`http://localhost:${ACTION_PORT}/a2ui/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

    // Initialize renderer
    try {
      const renderer = new A2UIRenderer({
        root: document.getElementById('a2ui-root'),
        onAction: sendAction,
        onError: (err) => {
          document.getElementById('a2ui-root').innerHTML =
            `<div class="a2ui-error">Render error: ${err.message}</div>`;
        }
      });
      renderer.render(A2UI_DATA);
      document.getElementById('a2ui-status').className = 'a2ui-status connected';
      document.getElementById('a2ui-status').textContent = 'Connected';
    } catch (err) {
      document.getElementById('a2ui-root').innerHTML =
        `<div class="a2ui-error">Failed to initialize: ${err.message}</div>`;
    }
  </script>
</body>
</html>
```

### 3.2 HTMLGenerator Class

```typescript
interface HTMLGeneratorOptions {
  messages: A2UIMessage[]
  surfaceId: string
  actionPort: number
  catalog: CatalogConfig
  theme?: 'light' | 'dark'
  title?: string
}

class HTMLGenerator {
  private template: string

  constructor() {
    this.template = fs.readFileSync(
      path.join(__dirname, 'templates/a2ui.html'), 'utf-8'
    )
  }

  generate(options: HTMLGeneratorOptions): string {
    const { messages, surfaceId, actionPort, catalog, theme, title } = options

    return this.template
      .replace('{{a2uiJSON}}', JSON.stringify(messages))
      .replace('{{actionPort}}', String(actionPort))
      .replace('{{surfaceId}}', surfaceId)
      .replace('{{catalogId}}', catalog.id)
      .replace('{{theme}}', theme || 'dark')
      .replace('{{title}}', title || `A2UI - ${surfaceId}`)
      .replace('{{catalogComponents}}', JSON.stringify(catalog.components))
  }
}
```

### 3.3 Temp File Management

```typescript
class TempFileManager {
  private basePath = os.tmpdir()

  generatePath(surfaceId: string): string {
    return path.join(this.basePath, `a2ui_${surfaceId}.html`)
  }

  async write(surfaceId: string, html: string): Promise<string> {
    const filePath = this.generatePath(surfaceId)
    await fs.promises.writeFile(filePath, html, { mode: 0o600 })
    return filePath
  }

  async cleanup(surfaceId: string): Promise<void> {
    const filePath = this.generatePath(surfaceId)
    try {
      await fs.promises.unlink(filePath)
    } catch {
      // File may already be deleted
    }
  }

  async cleanupAll(): Promise<void> {
    const files = await fs.promises.readdir(this.basePath)
    const a2uiFiles = files.filter(f => f.startsWith('a2ui_') && f.endsWith('.html'))
    await Promise.all(a2uiFiles.map(f =>
      fs.promises.unlink(path.join(this.basePath, f))
    ))
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
interface ActionServerConfig {
  port: number           // Listen port (default: 28900)
  host: string           // Listen address (default: 127.0.0.1)
  maxBodySize: number    // Max request body (default: 1MB)
}

class ActionServer {
  private server: http.Server | null = null
  private actions: A2UIAction[] = []
  private callback: ActionCallback | null = null
  port: number

  constructor(private config: ActionServerConfig) {
    this.port = config.port
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
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

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
    const body = await this.readBody(req)
    const action: A2UIAction = JSON.parse(body)

    if (!action.surfaceId || !action.actionId) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Missing surfaceId or actionId' }))
      return
    }

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

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve())
      })
    }
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
| **Input** | Malicious A2UI JSON | Structural validation + whitelist |
| **Render** | XSS injection | CSP header + sandbox |
| **Communication** | MITM attack | localhost only + CORS restriction |
| **Action** | Forged Action | ActionId whitelist + timestamp validation |
| **Resource** | Temp file leak | Periodic cleanup + permission restriction |

### 8.2 CSP Configuration

```
default-src 'self';
script-src 'self' https://unpkg.com https://cdn.jsdelivr.net 'unsafe-inline';
style-src 'self' 'unsafe-inline';
connect-src http://localhost:*
```

### 8.3 Temp File Permissions

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
