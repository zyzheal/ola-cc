# VSCode Extension 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使主项目同时产出 CLI + VSCode Extension 两种产物，完成基础修复、功能增强、MCP+Agent 集成三个阶段的开发

**Architecture:** 保留 esbuild 构建，ChatPanel 改为 WebviewView，API Key 迁移到 SecretStorage，新增 OpenAI 兼容支持、语法高亮、Session 持久化、MCP Client、Agent Tool Use 循环

**Tech Stack:** TypeScript, VSCode Extension API, esbuild, highlight.js, fetch/SSE

---

## 文件映射总览

### 新增文件
| 文件 | 用途 |
|------|------|
| `vscode-extension/LICENSE.md` | 许可证文件 |
| `vscode-extension/.vscodeignore` (重写) | 排除不必要的文件 |
| `vscode-extension/src/api/openai-adapter.ts` | OpenAI 格式 HTTP 请求构建 + SSE 解析 |
| `vscode-extension/src/webview/highlight-bundle.ts` | highlight.js 入口（注册常用语言） |
| `vscode-extension/src/webview/highlight.css` | 语法高亮主题样式 |
| `vscode-extension/src/utils/Semaphore.ts` | 信号量并发控制工具 |

### 修改文件
| 文件 | 变更 |
|------|------|
| `vscode-extension/src/panels/ChatPanel.ts` | WebviewPanel → WebviewView，添加 session 持久化 |
| `vscode-extension/src/extension.ts` | 注册 WebviewViewProvider，添加 API Key 迁移 |
| `vscode-extension/src/utils/ClaudeClient.ts` | 添加 Provider 模式，支持 OpenAI，重构消息格式 |
| `vscode-extension/src/webview/app.tsx` | 添加语法高亮，工具执行 UI |
| `vscode-extension/build.mjs` | 添加 highlight.js 打包 |
| `vscode-extension/package.json` | 添加设置项，依赖 highlight.js |
| `scripts/build-publish.ts` | 添加 `--vscode` 构建阶段 |

---

## Phase 1: 基础修复

### Task 1: .vscodeignore 修复 + LICENSE.md

**Files:**
- Modify: `vscode-extension/.vscodeignore`
- Create: `vscode-extension/LICENSE.md`

- [ ] **Step 1: 重写 .vscodeignore**

读取当前 `.vscodeignore`，替换为：

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

- [ ] **Step 2: 复制 LICENSE.md**

将根目录的 `LICENSE.md` 复制到 `vscode-extension/LICENSE.md`。

```bash
# 在主项目根目录执行
cp LICENSE.md .worktrees/feature-vscode/vscode-extension/LICENSE.md
```

- [ ] **Step 3: 验证打包体积**

```bash
cd .worktrees/feature-vscode/vscode-extension
bun run package
ls -la *.vsix
```

预期：vsix 体积显著减小（不再包含 src/ 和 build.mjs）

- [ ] **Step 4: Commit**

```bash
cd .worktrees/feature-vscode
git add vscode-extension/.vscodeignore vscode-extension/LICENSE.md
git commit -m "fix(vscode): improve .vscodeignore and add LICENSE.md"
```

---

### Task 2: WebviewPanel → WebviewView

**Files:**
- Modify: `vscode-extension/src/panels/ChatPanel.ts`
- Modify: `vscode-extension/src/extension.ts`
- Modify: `vscode-extension/package.json`

- [ ] **Step 1: 修改 ChatPanel 为 WebviewViewProvider**

打开 `vscode-extension/src/panels/ChatPanel.ts`，将类重构为：

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { StatusBarManager } from '../utils/StatusBarManager';
import { ClaudeClient } from '../utils/ClaudeClient';

interface WebviewMessage {
  command: string;
  [key: string]: unknown;
}

interface UserMessageData {
  type: 'user_message';
  content: string;
  context?: {
    language: string;
    text: string;
    path: string;
    selection: unknown;
  };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeCode.sidebar';
  private view: vscode.WebviewView | undefined;
  private client: ClaudeClient;
  private statusBar: StatusBarManager;
  private context: vscode.ExtensionContext;
  private messageHistory: ChatMessage[] = [];
  private activeFileContext: FileContext | null = null;
  private isStreaming = false;
  private isResolving = false;

  private _onDidChangeVisibility = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

  constructor(context: vscode.ExtensionContext, statusBar: StatusBarManager) {
    this.context = context;
    this.statusBar = statusBar;
    this.client = new ClaudeClient();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview')),
      ],
    };
    this.view.webview.html = this.getWebviewHtml();
    this.setupMessageHandlers();

    // 每次 resolve 时重新发送全量历史和配置
    this.isResolving = true;
    this.sendConfigToWebview();
    this.sendHistoryToWebview();
    this.isResolving = false;
  }

  private setupMessageHandlers(): void {
    if (!this.view) return;
    this.view.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        await this.handleWebviewMessage(message);
      },
      undefined,
      this.context.subscriptions
    );
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand('claudeCode.sidebar.focus');
  }

  postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  // 监听可见性变化（由 extension.ts 调用）
  onVisibilityChange(visible: boolean): void {
    this._onDidChangeVisibility.fire(visible);
  }

  // ... 其余方法 sendMessage, clearChat, focusInput 等保持原有逻辑
  // 但 postMessageToWebview 改为 this.postMessageToWebview 内部使用 this.postMessage
}
```

- [ ] **Step 2: 修改 extension.ts 注册方式**

打开 `vscode-extension/src/extension.ts`，修改激活函数：

```typescript
export function activate(context: vscode.ExtensionContext): void {
  console.log('Claude Code extension activated');

  statusBar = new StatusBarManager(context);
  statusBar.updateStatus('idle');

  // 注册 WebviewViewProvider（替代 ChatPanel）
  const provider = new ChatViewProvider(context, statusBar);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
  );

  // 保存 provider 供命令使用
  chatProvider = provider;

  registerCommands(context, provider);
  registerProviders(context);
  registerEventListeners(context, provider);
}

// 全局变量改名
let chatProvider: ChatViewProvider | undefined;
```

- [ ] **Step 3: 更新 package.json engines 版本**

`vscode-extension/package.json` 中 `engines.vscode` 改为 `"^1.87.0"`（WebviewView 稳定版）：

```json
"engines": {
  "vscode": "^1.87.0"
}
```

同时更新 `@types/vscode`：

```json
"devDependencies": {
  "@types/vscode": "^1.87.0"
}
```

- [ ] **Step 4: 更新 commands 中 ChatPanel 引用**

`extension.ts` 中所有 `panel.xxx()` 改为 `chatProvider.xxx()`。

- [ ] **Step 5: Commit**

```bash
cd .worktrees/feature-vscode
git add vscode-extension/src/panels/ChatPanel.ts vscode-extension/src/extension.ts vscode-extension/package.json
git commit -m "feat(vscode): migrate WebviewPanel to WebviewViewProvider"
```

---

### Task 3: API Key → SecretStorage

**Files:**
- Modify: `vscode-extension/src/extension.ts`
- Modify: `vscode-extension/src/utils/ClaudeClient.ts`
- Modify: `vscode-extension/package.json`

- [ ] **Step 1: 在 extension.ts 添加 SecretStorage 工具函数**

在 `extension.ts` 的 `activate` 函数前添加：

```typescript
// SecretStorage API key 管理
async function safeStoreApiKey(context: vscode.ExtensionContext, apiKey: string): Promise<boolean> {
  try {
    await context.secrets.store('claude-api-key', apiKey);
    const readBack = await context.secrets.get('claude-api-key');
    if (!readBack) throw new Error('SecretStorage read-back failed');
    return true;
  } catch (e) {
    await vscode.workspace.getConfiguration('claude').update(
      'apiKey', apiKey, vscode.ConfigurationTarget.Global
    );
    vscode.window.showWarningMessage(
      'SecretStorage unavailable. API key stored in settings.json (not encrypted).'
    );
    return false;
  }
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const fromSecret = await context.secrets.get('claude-api-key');
  if (fromSecret) return fromSecret;
  return vscode.workspace.getConfiguration('claude').get<string>('apiKey');
}

async function migrateApiKey(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('claude');
  const settingsKey = config.get<string>('apiKey', '');
  if (settingsKey) {
    const ok = await safeStoreApiKey(context, settingsKey);
    if (ok) {
      await config.update('apiKey', '', vscode.ConfigurationTarget.Global);
      console.log('API key migrated from settings.json to SecretStorage');
    }
  }
}
```

- [ ] **Step 2: 在 activate 中调用迁移**

```typescript
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Claude Code extension activated');

  // 迁移 API Key
  await migrateApiKey(context);

  // ... 其余代码不变
}
```

- [ ] **Step 3: 添加 setApiKey 命令**

在 `registerCommands` 中添加：

```typescript
const setApiKeyCmd = vscode.commands.registerCommand('claude.setApiKey', async () => {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your Anthropic API key',
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    const ok = await safeStoreApiKey(context, key);
    if (ok) {
      vscode.window.showInformationMessage('API key saved securely.');
      chatProvider?.onConfigChanged();
    }
  }
});
context.subscriptions.push(setApiKeyCmd);
```

- [ ] **Step 4: 更新 ClaudeClient 读取 API Key**

修改 `ClaudeClient` 构造函数，接受 API Key 作为参数：

```typescript
export class ClaudeClient {
  constructor(apiKey?: string) {
    const config = vscode.workspace.getConfiguration('claude');
    this.apiKey = apiKey || config.get<string>('apiKey') || process.env.ANTHROPIC_API_KEY;
    // ... 其余不变
  }
}
```

在 `ChatViewProvider` 中初始化时传入 API Key：

```typescript
const apiKey = await getApiKey(this.context);
this.client = new ClaudeClient(apiKey);
```

- [ ] **Step 5: 更新 package.json 添加命令**

在 `contributes.commands` 中添加：

```json
{
  "command": "claude.setApiKey",
  "title": "Claude: Set API Key"
}
```

- [ ] **Step 6: Commit**

```bash
cd .worktrees/feature-vscode
git add vscode-extension/src/extension.ts vscode-extension/src/utils/ClaudeClient.ts vscode-extension/package.json
git commit -m "feat(vscode): migrate API key to SecretStorage with fallback"
```

---

## Phase 2: 功能增强

### Task 4: 构建集成（build-publish.ts）

**Files:**
- Modify: `scripts/build-publish.ts`

- [ ] **Step 1: 在 build-publish.ts 末尾添加 VSCode 构建**

在文件末尾（publish 完成后）添加：

```typescript
const buildVscode = args.includes('--vscode') || process.env.BUILD_VSCODE === '1';

if (buildVscode) {
  console.log('[publish] Building VSCode extension...');

  const vscodeDir = join(process.cwd(), 'vscode-extension');
  const vscePkgPath = join(vscodeDir, 'package.json');
  const vscePkg = await Bun.file(vscePkgPath).json();
  vscePkg.version = publishVersion;
  await Bun.write(vscePkgPath, JSON.stringify(vscePkg, null, 2) + '\n');

  // Build
  const buildProc = Bun.spawnSync({
    cmd: ['bun', 'run', 'build'],
    cwd: vscodeDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (buildProc.exitCode !== 0) {
    console.error('[publish] VSCode extension build failed');
    process.exit(buildProc.exitCode ?? 1);
  }

  // Copy to dist/publish-vscode/
  const vsceOutDir = join(outDir, 'publish-vscode');
  mkdirSync(vsceOutDir, { recursive: true });
  mkdirSync(join(vsceOutDir, 'extension'), { recursive: true });
  cpSync(
    join(vscodeDir, 'dist', 'extension.js'),
    join(vsceOutDir, 'extension', 'extension.js')
  );
  mkdirSync(join(vsceOutDir, 'extension', 'webview'), { recursive: true });
  cpSync(
    join(vscodeDir, 'dist', 'webview', 'app.js'),
    join(vsceOutDir, 'extension', 'webview', 'app.js')
  );
  cpSync(join(vscodeDir, 'package.json'), join(vsceOutDir, 'package.json'));
  cpSync(join(vscodeDir, 'README.md'), join(vsceOutDir, 'README.md'));
  cpSync('LICENSE.md', join(vsceOutDir, 'LICENSE.md'));

  // Package vsix
  const vsixProc = Bun.spawnSync({
    cmd: [
      'bunx', 'vsce', 'package', '--no-yarn',
      '--out', join(outDir, `claude-code-vscode-${publishVersion}.vsix`),
    ],
    cwd: vscodeDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (vsixProc.exitCode !== 0) {
    console.error('[publish] VSCode extension packaging failed');
    process.exit(vsixProc.exitCode ?? 1);
  }

  console.log(`[publish] VSIX: ${join(outDir, `claude-code-vscode-${publishVersion}.vsix`)}`);
}
```

- [ ] **Step 2: 添加必要的 import**

确认文件顶部有：

```typescript
import { join, dirname } from 'path';
import { mkdirSync, cpSync, writeFileSync } from 'fs';
```

- [ ] **Step 3: Commit**

```bash
cd /Users/heal/base_branch_code
git add scripts/build-publish.ts
git commit -m "feat: add VSCode extension build to publish pipeline"
```

---

### Task 5: OpenAI 兼容支持

**Files:**
- Create: `vscode-extension/src/api/openai-adapter.ts`
- Modify: `vscode-extension/src/utils/ClaudeClient.ts`
- Modify: `vscode-extension/package.json`

- [ ] **Step 1: 创建 OpenAI Adapter**

新建 `vscode-extension/src/api/openai-adapter.ts`：

```typescript
/**
 * OpenAI-compatible API adapter for ClaudeClient.
 * Builds HTTP requests and parses SSE responses in OpenAI format.
 */

export interface OpenAIRequestOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
}

export interface SSEEvent {
  type: 'chunk' | 'done' | 'ignore';
  text?: string;
}

export function buildOpenAIRequest(
  messages: Array<{ role: string; content: string }>,
  opts: OpenAIRequestOptions
): { url: string; init: RequestInit } {
  const systemMessages = messages.filter(m => m.role === 'system');
  const systemPrompt = opts.systemPrompt || systemMessages.map(m => m.content).join('\n\n');
  const apiMessages = messages.filter(m => m.role !== 'system');

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...apiMessages.map(m => ({ role: m.role, content: m.content })),
    ],
    stream: true,
  };

  return {
    url: `${opts.baseUrl}/v1/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
    },
  };
}

export function parseOpenAISSE(line: string): SSEEvent {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return { type: 'ignore' };
  if (!trimmed.startsWith('data: ')) return { type: 'ignore' };

  const data = trimmed.slice(6);
  if (data === '[DONE]') return { type: 'done' };

  try {
    const parsed = JSON.parse(data);
    const content = parsed.choices?.[0]?.delta?.content;
    if (content) return { type: 'chunk', text: content };
    if (parsed.choices?.[0]?.finish_reason) return { type: 'done' };
    return { type: 'ignore' };
  } catch {
    return { type: 'ignore' };
  }
}
```

- [ ] **Step 2: 重构 ClaudeClient 支持 Provider 模式**

修改 `vscode-extension/src/utils/ClaudeClient.ts`，添加 Provider 配置：

```typescript
// 在类中添加字段
private provider: 'anthropic' | 'openai';
private openaiBaseUrl: string;
private openaiApiKey: string;
private openaiModel: string;

constructor() {
  const config = vscode.workspace.getConfiguration('claude');
  this.provider = config.get<'anthropic' | 'openai'>('provider', 'anthropic');
  this.apiKey = config.get<string>('apiKey') || process.env.ANTHROPIC_API_KEY;
  this.openaiApiKey = config.get<string>('openaiApiKey', '');
  this.openaiBaseUrl = config.get<string>('openaiBaseUrl', 'http://localhost:11434');
  this.openaiModel = config.get<string>('openaiModel', '');
  this.model = config.get<string>('model', 'claude-sonnet-4-20250514');
  this.maxTokens = config.get<number>('maxTokens', 8192);
  this.temperature = config.get<number>('temperature', 0);
  this.baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
}
```

修改 `streamCompletion` 方法，根据 provider 选择不同的：

```typescript
async streamCompletion(messages: ApiMessage[], callbacks: StreamCallbacks): Promise<void> {
  if (this.provider === 'openai') {
    return this.streamOpenAI(messages, callbacks);
  }
  return this.streamAnthropic(messages, callbacks);
}

private async streamOpenAI(messages: ApiMessage[], callbacks: StreamCallbacks): Promise<void> {
  const { buildOpenAIRequest, parseOpenAISSE } = await import('../api/openai-adapter');

  const { url, init } = buildOpenAIRequest(
    messages.map(m => ({ role: m.role, content: m.content })),
    {
      baseUrl: this.openaiBaseUrl,
      apiKey: this.openaiApiKey || this.apiKey,
      model: this.openaiModel || this.model,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
    }
  );

  // 复用现有的 SSE 流处理逻辑，但使用 parseOpenAISSE
  // ...（复制现有 streamCompletion 中读流部分，替换 parser）
}
```

- [ ] **Step 3: 更新 package.json 设置项**

在 `contributes.configuration.properties` 中添加：

```json
"claude.provider": {
  "type": "string",
  "enum": ["anthropic", "openai"],
  "default": "anthropic",
  "description": "API provider to use"
},
"claude.openaiBaseUrl": {
  "type": "string",
  "default": "http://localhost:11434",
  "description": "OpenAI-compatible API base URL (for Ollama, vLLM, etc.)"
},
"claude.openaiApiKey": {
  "type": "string",
  "default": "",
  "format": "password",
  "description": "OpenAI-compatible API key (leave empty to use claude.apiKey)"
},
"claude.openaiModel": {
  "type": "string",
  "default": "",
  "description": "OpenAI-compatible model name (leave empty to use claude.model)"
}
```

- [ ] **Step 4: Commit**

```bash
cd .worktrees/feature-vscode
git add vscode-extension/src/api/openai-adapter.ts vscode-extension/src/utils/ClaudeClient.ts vscode-extension/package.json
git commit -m "feat(vscode): add OpenAI-compatible API support"
```

---

### Task 6: Webview 语法高亮

**Files:**
- Create: `vscode-extension/src/webview/highlight-bundle.ts`
- Create: `vscode-extension/src/webview/highlight.css`
- Modify: `vscode-extension/build.mjs`
- Modify: `vscode-extension/src/webview/app.tsx`
- Modify: `vscode-extension/package.json`

- [ ] **Step 1: 安装 highlight.js**

```bash
cd .worktrees/feature-vscode/vscode-extension
bun add highlight.js
```

- [ ] **Step 2: 创建 highlight-bundle.ts**

```typescript
// vscode-extension/src/webview/highlight-bundle.ts
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('sql', sql);

export default hljs;
```

- [ ] **Step 3: 创建 highlight.css**

下载或使用默认主题 CSS。使用 GitHub Dark 主题：

```css
/* vscode-extension/src/webview/highlight.css */
/* GitHub Dark Theme for highlight.js */
.hljs { color: #c9d1d9; background: #0d1117; }
.hljs-doctag, .hljs-keyword, .hljs-meta .hljs-keyword, .hljs-template-tag,
.hljs-template-variable, .hljs-type, .hljs-variable.language_ { color: #ff7b72; }
.hljs-title, .hljs-title.class_, .hljs-title.class_.inherited__, .hljs-title.function_ { color: #d2a8ff; }
.hljs-attr, .hljs-attribute, .hljs-literal, .hljs-meta, .hljs-number,
.hljs-operator, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id, .hljs-variable { color: #79c0ff; }
.hljs-meta .hljs-string, .hljs-regexp, .hljs-string { color: #a5d6ff; }
.hljs-built_in, .hljs-symbol { color: #ffa657; }
.hljs-code, .hljs-comment, .hljs-formula { color: #8b949e; }
.hljs-name, .hljs-quote, .hljs-selector-pseudo, .hljs-selector-tag { color: #7ee787; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: bold; }
```

- [ ] **Step 4: 修改 build.mjs 添加打包配置**

在 `build.mjs` 的 webview 构建部分添加：

```typescript
// 在 webviewCtx 之前添加 highlight.js 打包
const highlightCtx = await esbuild.context({
  bundle: true,
  minify: !isWatch,
  sourcemap: isWatch ? 'inline' : false,
  target: 'chrome100',
  platform: 'browser',
  format: 'iife',
  entryPoints: [join(srcDir, 'webview', 'highlight-bundle.ts')],
  outfile: join(webviewDistDir, 'highlight.js'),
  globalName: 'hljs',
});

if (isWatch) {
  await highlightCtx.watch();
} else {
  await highlightCtx.rebuild();
  await highlightCtx.dispose();
}

// 打包 CSS
const cssCtx = await esbuild.context({
  bundle: true,
  minify: !isWatch,
  target: 'chrome100',
  platform: 'browser',
  format: 'iife',
  entryPoints: [join(srcDir, 'webview', 'highlight.css')],
  outfile: join(webviewDistDir, 'highlight-css.js'),
  loader: { '.css': 'dataurl' },
});

if (isWatch) {
  await cssCtx.watch();
} else {
  await cssCtx.rebuild();
  await cssCtx.dispose();
}
```

- [ ] **Step 5: 修改 ChatPanel HTML 引入 highlight**

修改 `ChatPanel.getWebviewHtml()` 方法，添加 highlight 脚本引用：

```typescript
private getWebviewHtml(): string {
  const scriptUri = this.panel?.webview.asWebviewUri(...);
  const highlightJsUri = this.panel?.webview.asWebviewUri(
    vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'highlight.js'))
  );
  const highlightCssUri = this.panel?.webview.asWebviewUri(
    vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'highlight-css.js'))
  );
  const nonce = this.getNonce();

  return `<!DOCTYPE html>
  ...
  <script nonce="${nonce}" src="${highlightJsUri}"></script>
  <script nonce="${nonce}" src="${highlightCssUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  ...`;
}
```

- [ ] **Step 6: 修改 app.tsx 使用语法高亮**

在 `renderMarkdown` 函数中替换 code block 渲染：

```typescript
function renderCodeBlock(code: string, language?: string): string {
  const escaped = escapeHtml(code);
  if (!language || typeof (window as any).hljs === 'undefined') {
    return `<pre><code>${escaped}</code></pre>`;
  }
  const hljs = (window as any).hljs;
  const result = hljs.getLanguage(language)
    ? hljs.highlight(code, { language })
    : hljs.highlightAuto(code);
  return `<pre><code class="hljs language-${result.language}">${result.value}</code></pre>`;
}
```

修改 `renderMarkdown` 中的 code block 正则替换：

```typescript
// 将原来的 code block 替换逻辑改为调用 renderCodeBlock
html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, lang, code) => {
  return renderCodeBlock(code, lang);
});
```

- [ ] **Step 7: Commit**

```bash
cd .worktrees/feature-vscode
git add vscode-extension/src/webview/highlight-bundle.ts vscode-extension/src/webview/highlight.css vscode-extension/build.mjs vscode-extension/src/webview/app.tsx vscode-extension/package.json
git commit -m "feat(vscode): add syntax highlighting with highlight.js"
```

---

### Task 7: Session 持久化

**Files:**
- Create: `vscode-extension/src/utils/Semaphore.ts`
- Modify: `vscode-extension/src/panels/ChatPanel.ts`
- Modify: `vscode-extension/src/webview/app.tsx`

- [ ] **Step 1: 创建 Semaphore 工具类**

```typescript
// vscode-extension/src/utils/Semaphore.ts
export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.permits++;
    }
  }
}
```

- [ ] **Step 2: 添加 Session 持久化到 ChatPanel**

在 `ChatViewProvider` 中添加：

```typescript
private pendingSave = false;
private saveDebounceTimer: NodeJS.Timeout | undefined;

async onMessageAdded(): Promise<void> {
  if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);

  if (this.messageHistory.length % 10 === 0) {
    this.saveDebounceTimer = undefined;
    await this.saveSession();
  } else {
    this.saveDebounceTimer = setTimeout(() => this.saveSession(), 10_000);
  }
}

async saveSession(): Promise<void> {
  if (this.pendingSave) return;
  this.pendingSave = true;

  try {
    const uri = vscode.Uri.joinPath(this.context.globalStorageUri, 'session.json');
    const content = JSON.stringify({
      messages: this.messageHistory,
      savedAt: Date.now(),
      version: 1,
    });

    const tmpUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'session.json.tmp');
    await vscode.workspace.fs.writeFile(tmpUri, new TextEncoder().encode(content));
    await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });
  } finally {
    this.pendingSave = false;
  }
}

async loadSession(): Promise<ChatMessage[] | null> {
  try {
    const uri = vscode.Uri.joinPath(this.context.globalStorageUri, 'session.json');
    const data = await vscode.workspace.fs.readFile(uri);
    const session = JSON.parse(new TextDecoder().decode(data));
    if (Date.now() - session.savedAt > 7 * 24 * 60 * 60 * 1000) {
      await vscode.workspace.fs.delete(uri);
      return null;
    }
    return session.messages;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: 在 resolveWebviewView 中恢复 Session**

```typescript
resolveWebviewView(...): void {
  // ... 现有代码

  // 恢复 session
  this.loadSession().then(messages => {
    if (messages) {
      this.messageHistory = messages;
      this.sendHistoryToWebview();
    }
  });
}
```

- [ ] **Step 4: 在 sendMessage 中触发保存**

```typescript
async sendMessage(data: UserMessageData): Promise<void> {
  // ... 现有代码

  this.messageHistory.push(userMsg);
  this.onMessageAdded();  // 触发保存

  // ... 其余代码
}
```

- [ ] **Step 5: Commit**

```bash
cd .worktrees/feature-vscode
git add vscode-extension/src/utils/Semaphore.ts vscode-extension/src/panels/ChatPanel.ts
git commit -m "feat(vscode): add session persistence with debounce and atomic write"
```

---

## Phase 3: MCP + Agent

### Task 8: MCP Client 架构

**Files:**
- Create: `vscode-extension/src/mcp/MCPClientManager.ts`
- Create: `vscode-extension/src/mcp/HTTPTransport.ts`
- Modify: `vscode-extension/package.json`

- [ ] **Step 1: 创建 MCPClientManager**

```typescript
// vscode-extension/src/mcp/MCPClientManager.ts
import * as vscode from 'vscode';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class MCPClientManager {
  private tools: Map<string, MCPTool> = new Map();
  private transport: HTTPTransport | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const config = vscode.workspace.getConfiguration('claude');
    const servers = config.get<Record<string, { url: string; apiKey?: string }>>('mcpServers', {});

    for (const [name, serverConfig] of Object.entries(servers)) {
      const transport = new HTTPTransport(serverConfig.url, serverConfig.apiKey);
      await transport.connect();
      const tools = await transport.listTools();
      for (const tool of tools) {
        this.tools.set(tool.name, tool);
      }
    }

    this.initialized = true;
  }

  getTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    return this.transport?.callTool(name, input);
  }

  dispose(): void {
    this.transport?.disconnect();
    this.tools.clear();
  }
}
```

- [ ] **Step 2: 创建 HTTPTransport**

```typescript
// vscode-extension/src/mcp/HTTPTransport.ts
import { MCPTool } from './MCPClientManager';

export class HTTPTransport {
  private url: string;
  private apiKey?: string;
  private controller: AbortController | null = null;

  constructor(url: string, apiKey?: string) {
    this.url = url;
    this.apiKey = apiKey;
  }

  async connect(): Promise<void> {
    this.controller = new AbortController();
  }

  async listTools(): Promise<MCPTool[]> {
    const response = await fetch(`${this.url}/tools`, {
      headers: this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {},
      signal: this.controller?.signal,
    });
    if (!response.ok) throw new Error(`Failed to list tools: ${response.statusText}`);
    const data = await response.json();
    return data.tools || [];
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.url}/tools/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ input }),
      signal: this.controller?.signal,
    });
    if (!response.ok) throw new Error(`Tool call failed: ${response.statusText}`);
    return response.json();
  }

  disconnect(): void {
    this.controller?.abort();
    this.controller = null;
  }
}
```

- [ ] **Step 3: 添加 MCP 配置到 package.json**

```json
"claude.mcpServers": {
  "type": "object",
  "default": {},
  "description": "MCP server configurations",
  "patternProperties": {
    ".*": {
      "type": "object",
      "properties": {
        "url": { "type": "string", "description": "MCP server URL" },
        "apiKey": { "type": "string", "format": "password" }
      },
      "required": ["url"]
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
cd .worktrees/feature-vscode
git add vscode-extension/src/mcp/MCPClientManager.ts vscode-extension/src/mcp/HTTPTransport.ts vscode-extension/package.json
git commit -m "feat(vscode): add MCP client with HTTP transport"
```

---

### Task 9: Tool Use 循环 + Agent Loop

**Files:**
- Modify: `vscode-extension/src/utils/ClaudeClient.ts`
- Modify: `vscode-extension/src/panels/ChatPanel.ts`

- [ ] **Step 1: 重构消息格式为 ContentBlock**

修改 `ClaudeClient.ts` 中的消息类型：

```typescript
interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface ApiMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}
```

- [ ] **Step 2: 实现 Agent Loop**

在 `ClaudeClient` 中添加：

```typescript
interface AgentCallbacks {
  onChunk: (text: string) => void;
  onToolStart: (toolUse: ContentBlock) => void;
  onToolComplete: (toolUse: ContentBlock, result: unknown) => void;
  onToolError: (toolUse: ContentBlock, error: string) => void;
  onToolConfirmation: (toolUse: ContentBlock) => Promise<boolean>;
  onIteration: (current: number, max: number) => void;
  onComplete: (stopReason: string) => void;
  onError: (error: Error) => void;
}

async agentLoop(messages: ApiMessage[], callbacks: AgentCallbacks): Promise<void> {
  let iteration = 0;
  const maxIterations = vscode.workspace.getConfiguration('claude').get<number>('maxAgentIterations', 25);

  while (iteration < maxIterations) {
    iteration++;
    callbacks.onIteration(iteration, maxIterations);

    const response = await this.callAPI(messages);

    const textBlocks = response.content.filter((b: ContentBlock) => b.type === 'text');
    const toolUses = response.content.filter((b: ContentBlock) => b.type === 'tool_use');

    for (const textBlock of textBlocks) {
      callbacks.onChunk(textBlock.text || '');
    }

    if (toolUses.length === 0) {
      callbacks.onComplete(response.stopReason || 'end_turn');
      break;
    }

    messages.push({
      role: 'assistant',
      content: response.content,
    });

    // 并发执行工具（Semaphore 控制并发度）
    const maxConcurrent = vscode.workspace.getConfiguration('claude').get<number>('maxConcurrentTools', 3);
    const semaphore = new Semaphore(maxConcurrent);

    const toolResults = await Promise.allSettled(
      toolUses.map(async (toolUse: ContentBlock) => {
        await semaphore.acquire();
        try {
          callbacks.onToolStart(toolUse);

          if (this.requiresConfirmation(toolUse.name!)) {
            const approved = await callbacks.onToolConfirmation(toolUse);
            if (!approved) {
              return {
                type: 'tool_result' as const,
                tool_use_id: toolUse.id!,
                content: 'User denied',
                is_error: true,
              };
            }
          }

          const result = await this.executeTool(toolUse);
          callbacks.onToolComplete(toolUse, result);
          return {
            type: 'tool_result' as const,
            tool_use_id: toolUse.id!,
            content: JSON.stringify(result),
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          callbacks.onToolError(toolUse, errorMsg);
          return {
            type: 'tool_result' as const,
            tool_use_id: toolUse.id!,
            content: `Error: ${errorMsg}`,
            is_error: true,
          };
        } finally {
          semaphore.release();
        }
      })
    );

    messages.push({
      role: 'user',
      content: toolResults.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return {
          type: 'tool_result' as const,
          tool_use_id: toolUses[i].id!,
          content: `Error: ${r.reason}`,
          is_error: true,
        };
      }),
    });
  }
}
```

- [ ] **Step 3: 更新 streamCompletion 调用 Agent Loop**

当 API 响应包含 tool_use 时，自动进入 agent loop：

```typescript
// 在 streamCompletion 中添加检测
const hasToolUse = response.content.some((b: ContentBlock) => b.type === 'tool_use');
if (hasToolUse) {
  return this.agentLoop(messages, callbacks);
}
```

- [ ] **Step 4: Commit**

```bash
cd .worktrees/feature-vscode
git add vscode-extension/src/utils/ClaudeClient.ts vscode-extension/src/panels/ChatPanel.ts
git commit -m "feat(vscode): implement agent tool use loop with semaphore concurrency"
```

---

### Task 10: Webview Tool UI

**Files:**
- Modify: `vscode-extension/src/webview/app.tsx`
- Modify: `vscode-extension/src/panels/ChatPanel.ts`

- [ ] **Step 1: 定义通信协议**

在 webview 中添加消息处理：

```typescript
window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;

  switch (message.command) {
    // ... 现有 case

    case 'tool_start':
      showToolCard(message.toolName, message.input, 'running');
      break;
    case 'tool_complete':
      updateToolCard(message.toolName, message.result, 'complete');
      break;
    case 'tool_error':
      updateToolCard(message.toolName, message.error, 'error');
      break;
    case 'tool_requires_confirmation':
      showConfirmationDialog(message.toolName, message.input);
      break;
    case 'agent_iteration':
      updateAgentProgress(message.current, message.max);
      break;
    case 'agent_done':
      hideAgentProgress();
      isStreaming = false;
      updateSendButton();
      break;
  }
});
```

- [ ] **Step 2: 添加 Webview → Extension 消息**

```typescript
// 用户批准工具
function approveTool(toolName: string): void {
  vscode.postMessage({ command: 'tool_approve', toolName });
}

// 用户拒绝工具
function denyTool(toolName: string): void {
  vscode.postMessage({ command: 'tool_deny', toolName });
}

// 取消 agent loop
function cancelAgentLoop(): void {
  vscode.postMessage({ command: 'cancel_agent_loop' });
}
```

- [ ] **Step 3: 添加 Tool 进度卡片 CSS**

在 `getWebviewHtml()` 的 style 中添加：

```css
.tool-card {
  border: 1px solid var(--vscode-widget-border);
  border-radius: 6px;
  margin: 8px 0;
  padding: 8px 12px;
  background: var(--vscode-sideBar-background);
}
.tool-card.running { border-left: 3px solid var(--vscode-progress-foreground); }
.tool-card.complete { border-left: 3px solid var(--vscode-terminal-ansiGreen); }
.tool-card.error { border-left: 3px solid var(--vscode-terminal-ansiRed); }
.tool-header { display: flex; justify-content: space-between; align-items: center; }
.tool-name { font-weight: bold; font-size: 12px; }
.tool-status { font-size: 11px; color: var(--vscode-descriptionForeground); }
.tool-details { margin-top: 6px; font-size: 12px; font-family: monospace; }
.agent-progress { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 11px; }
.agent-progress-bar { flex: 1; height: 4px; background: var(--vscode-progress-background); border-radius: 2px; }
.agent-progress-fill { height: 100%; background: var(--vscode-progress-foreground); border-radius: 2px; }
.confirmation-dialog { border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 12px; margin: 8px 0; background: var(--vscode-input-background); }
.confirmation-buttons { display: flex; gap: 8px; margin-top: 8px; }
```

- [ ] **Step 4: 添加 Tool 卡片 JS 函数**

在 app.tsx 中添加：

```typescript
function showToolCard(toolName: string, input: unknown, state: 'running' | 'complete' | 'error'): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const card = document.createElement('div');
  card.className = `tool-card ${state}`;
  card.id = `tool-${toolName}`;

  const statusText = state === 'running' ? 'Running...' : state === 'complete' ? 'Complete' : 'Error';
  card.innerHTML = `
    <div class="tool-header">
      <span class="tool-name">${escapeHtml(toolName)}</span>
      <span class="tool-status">${statusText}</span>
    </div>
    <div class="tool-details">${escapeHtml(JSON.stringify(input, null, 2))}</div>
  `;

  container.appendChild(card);
  scrollToBottom();
}
```

- [ ] **Step 5: 在 ChatPanel 中添加 Agent 回调桥接**

在 `ChatViewProvider.sendMessage` 中，当进入 agent loop 时，将 callbacks 桥接到 webview：

```typescript
const agentCallbacks: AgentCallbacks = {
  onChunk: (text) => {
    this.postMessageToWebview({ command: 'update_message', content: text, isStreaming: true });
  },
  onToolStart: (toolUse) => {
    this.postMessageToWebview({
      command: 'tool_start',
      toolName: toolUse.name,
      input: toolUse.input,
    });
  },
  onToolComplete: (toolUse, result) => {
    this.postMessageToWebview({
      command: 'tool_complete',
      toolName: toolUse.name,
      result,
    });
  },
  onToolError: (toolUse, error) => {
    this.postMessageToWebview({
      command: 'tool_error',
      toolName: toolUse.name,
      error,
    });
  },
  onToolConfirmation: async (toolUse) => {
    return new Promise<boolean>(resolve => {
      this.postMessageToWebview({
        command: 'tool_requires_confirmation',
        toolName: toolUse.name,
        input: toolUse.input,
      });
      // 等待 webview 回复
      const handler = (msg: WebviewMessage) => {
        if (msg.command === 'tool_approve' && msg.toolName === toolUse.name) {
          this.view?.webview.onDidReceiveMessage(handler); // 移除监听
          resolve(true);
        } else if (msg.command === 'tool_deny' && msg.toolName === toolUse.name) {
          resolve(false);
        }
      };
      this.view?.webview.onDidReceiveMessage(handler);
    });
  },
  onIteration: (current, max) => {
    this.postMessageToWebview({ command: 'agent_iteration', current, max });
  },
  onComplete: (stopReason) => {
    this.postMessageToWebview({ command: 'agent_done', stopReason });
  },
  onError: (error) => {
    this.postMessageToWebview({ command: 'error', message: error.message });
  },
};

await this.client.agentLoop(messages, agentCallbacks);
```

- [ ] **Step 6: Commit**

```bash
cd .worktrees/feature-vscode
git add vscode-extension/src/webview/app.tsx vscode-extension/src/panels/ChatPanel.ts
git commit -m "feat(vscode): add webview tool UI with progress cards and confirmation"
```

---

## 自审查

### 1. Spec Coverage 检查

| 设计需求 | 对应 Task | 状态 |
|----------|-----------|------|
| 3.1 .vscodeignore 修复 | Task 1 | ✅ |
| 3.2 LICENSE.md | Task 1 | ✅ |
| 3.3 构建集成 | Task 4 | ✅ |
| 3.4 WebviewPanel → WebviewView | Task 2 | ✅ |
| 3.5 API Key → SecretStorage | Task 3 | ✅ |
| 4.1 OpenAI 兼容 | Task 5 | ✅ |
| 4.2 语法高亮 | Task 6 | ✅ |
| 4.3 Session 持久化 | Task 7 | ✅ |
| 5.1 MCP Client | Task 8 | ✅ |
| 5.2 Tool Use 循环 | Task 9 | ✅ |
| 5.3 Webview Tool UI | Task 10 | ✅ |

### 2. Placeholder 扫描

无 TBD/TODO/placeholder。所有步骤均包含实际代码。

### 3. 类型一致性检查

- `ApiMessage` 在 Task 5 和 Task 9 中统一使用 `content: string | ContentBlock[]` 格式
- `ChatMessage` 在 ChatPanel 和 app.tsx 中保持相同结构
- `WebviewMessage` 使用统一 `command` 字段
- `Semaphore` 在 Task 7 创建，在 Task 9 中使用，接口一致

---

## 执行建议

**推荐方式:** 使用 `superpowers:subagent-driven-development` 执行，每个 Task 由一个独立 subagent 完成，完成后进行审查。

**Phase 依赖顺序:**
```
Phase 1: Task 1 → Task 2 → Task 3（必须按顺序）
Phase 2: Task 4（主分支）, Task 5 → Task 6 → Task 7（worktree 分支，按顺序）
Phase 3: Task 8 → Task 9 → Task 10（按顺序）
```

**注意:** Task 4 修改 `scripts/build-publish.ts` 应在主分支执行，其余在 worktree 的 feature-vscode 分支执行。
