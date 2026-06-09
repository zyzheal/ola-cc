# LSP Tools Integration Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: oh-my-claudecode v4.14.4
**Priority**: P0
**Effort**: M (3 new files + 2 modified)

---

## 1. Overview

LSP (Language Server Protocol) 工具提供代码智能分析能力，包括跳转定义、查找引用、符号搜索、诊断、重命名等 12 个工具。oh-my-claudecode 通过 `withLspClient` 包装器和 `lspClientManager` 实现了统一的 LSP 客户端管理。

## 2. Tool List (12)

| Tool | Function | LSP Method |
|------|----------|------------|
| `lsp_hover` | Get type info and documentation at position | `textDocument/hover` |
| `lsp_goto_definition` | Jump to symbol definition | `textDocument/definition` |
| `lsp_find_references` | Find all references to a symbol | `textDocument/references` |
| `lsp_document_symbols` | List symbols in a file | `textDocument/documentSymbol` |
| `lsp_workspace_symbols` | Search symbols across workspace | `workspace/symbol` |
| `lsp_diagnostics` | Get errors/warnings for a file | `textDocument/publishDiagnostics` |
| `lsp_rename` | Rename a symbol across project | `textDocument/rename` |
| `lsp_format` | Format code | `textDocument/formatting` |
| `lsp_code_actions` | Get available code actions | `textDocument/codeAction` |
| `lsp_completion` | Get code completions | `textDocument/completion` |
| `lsp_signature_help` | Get function signature help | `textDocument/signatureHelp` |
| `lsp_folding_range` | Get code folding ranges | `textDocument/foldingRange` |

## 3. Architecture

```
src/tools/LspTools/
├── lspClientManager.ts  — Per-language client lifecycle
├── tools.ts             — 12 tool definitions with withLspClient wrapper
└── types.ts             — TypeScript types
```

### 3.1 LspClientManager

#### createLspClient() 核心实现

```typescript
interface LspServerConfig {
  command: string        // e.g. "typescript-language-server"
  args: string[]         // e.g. ["--stdio"]
  languageId: string     // e.g. "typescript"
  initializationOptions?: Record<string, unknown>
}

async function createLspClient(config: LspServerConfig): Promise<LspClient> {
  // 1. 启动 LSP server 进程 (child_process.spawn)
  const process = spawn(config.command, config.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // 2. 绑定 stdin/stdout 为 JSON-RPC 通道
  const connection = createJsonRpcConnection(process.stdin, process.stdout)

  // 3. 发送 initialize 请求 (capabilities, rootUri)
  const initResult = await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: workspaceRoot,
    capabilities: {
      textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] } },
      workspace: { symbol: { dynamicRegistration: false } },
    },
    initializationOptions: config.initializationOptions,
  })

  // 4. 等待 initialize 响应 (serverCapabilities)
  const serverCapabilities = initResult.capabilities

  // 5. 发送 initialized 通知
  await connection.sendNotification('initialized', {})

  // 6. 返回 LspClient 实例
  return new LspClient(connection, serverCapabilities, process)
}
```

#### LspClientManager 类

```typescript
class LspClientManager {
  private clients: Map<string, LspClient>  // languageId → client
  private idleTimers: Map<string, ReturnType<typeof setTimeout>>  // 空闲超时
  private retryCounts: Map<string, number>  // 崩溃重试计数
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000  // 5 分钟
  private readonly MAX_RETRIES = 3

  getClientForFile(filePath: string): LspClient | null {
    const languageId = detectLanguage(filePath)
    if (!languageId) return null
    if (!this.clients.has(languageId)) {
      const client = createLspClient(languageId)
      this.clients.set(languageId, client)
      this.setupCrashRecovery(languageId, client)
      this.retryCounts.set(languageId, 0)
    }
    this.resetIdleTimer(languageId)
    return this.clients.get(languageId)!
  }

  private resetIdleTimer(languageId: string): void {
    if (this.idleTimers.has(languageId)) clearTimeout(this.idleTimers.get(languageId))
    this.idleTimers.set(languageId, setTimeout(() => {
      this.clients.get(languageId)?.dispose()
      this.clients.delete(languageId)
    }, this.IDLE_TIMEOUT))
  }

  private setupCrashRecovery(languageId: string, client: LspClient): void {
    client.onExit(() => {
      const count = this.retryCounts.get(languageId) ?? 0
      if (count < this.MAX_RETRIES) {
        this.retryCounts.set(languageId, count + 1)
        const newClient = createLspClient(languageId)
        this.clients.set(languageId, newClient)
        this.setupCrashRecovery(languageId, newClient)
      } else {
        this.clients.delete(languageId)  // 标记为不可用
      }
    })
  }

  async dispose(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    for (const client of this.clients.values()) {
      await client.dispose()
    }
  }
}
```

### 3.2 withLspClient Wrapper

```typescript
function withLspClient(
  handler: (client: LspClient, args: unknown) => Promise<unknown>
): ToolCallHandler {
  return async (args, context) => {
    const filePath = args.file_path || args.textDocument?.uri
    const client = lspClientManager.getClientForFile(filePath)
    if (!client) {
      return { error: `No LSP server available for ${filePath}` }
    }
    return handler(client, args)
  }
}
```

### 3.3 Tool Definition Examples

```typescript
// lsp_hover
{
  name: 'lsp_hover',
  description: 'Get type information and documentation at a specific position in a file',
  inputSchema: z.object({
    file_path: z.string().describe('Path to the file'),
    line: z.number().describe('Line number (0-based)'),
    character: z.number().describe('Character position (0-based)'),
  }),
  call: withLspClient(async (client, args) => {
    return client.hover({
      textDocument: { uri: fileUri(args.file_path) },
      position: { line: args.line, character: args.character },
    })
  }),
}

// lsp_definitions
const LspDefinitionsSchema = z.object({
  file: z.string().describe('File path'),
  line: z.number().int().min(0).describe('0-based line number'),
  character: z.number().int().min(0).describe('0-based character position')
})

// lsp_diagnostics
const LspDiagnosticsSchema = z.object({
  file: z.string().describe('File path to check')
})
```

## 4. Integration Points

### 4.1 Tool Registration

**File**: `src/tools.ts`

```typescript
import { lspTools } from './tools/LspTools/tools.js'

// Add to tool pool:
...lspTools,
```

### 4.2 LSP Server Detection

The manager needs to detect which LSP servers are available. Detection uses `child_process.execSync` 运行版本命令，超时 2 秒，失败则跳过该语言。

| 语言 | Server | 检测命令 |
|------|--------|---------|
| TypeScript | typescript-language-server | `npx typescript-language-server --version` |
| Python | pylsp | `python -m pylsp --version` |
| Rust | rust-analyzer | `rust-analyzer --version` |
| Go | gopls | `gopls version` |

### 4.3 File Language Detection

```typescript
function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.rs': 'rust', '.go': 'go'
  }
  return EXT_TO_LANG[ext] || null
}
```

也可复用现有 syntax highlighting 或 build system 的语言检测逻辑。

## 5. Files to Modify

| File | Operation | Description |
|------|-----------|-------------|
| `src/tools/LspTools/lspClientManager.ts` | **New** | Client lifecycle management |
| `src/tools/LspTools/tools.ts` | **New** | 12 tool definitions |
| `src/tools/LspTools/types.ts` | **New** | TypeScript types |
| `src/tools.ts` | Modify | Register LSP tools |
| `package.json` | — | 无需修改（使用直接 JSON-RPC，复用现有基础设施） |

### 5.1 LOC 估算

| 模块 | 文件 | 预估 LOC | 说明 |
|------|------|----------|------|
| `createLspClient()` | `lspClientManager.ts` | ~80 | spawn 进程 + JSON-RPC 绑定 + initialize 握手 |
| `LspClientManager` 类 | `lspClientManager.ts` | ~120 | client 缓存 + idle timer + crash recovery + dispose |
| `withLspClient` 包装器 | `tools.ts` | ~40 | 路由分发 + 错误处理 + language 检测 |
| 12 个工具定义 | `tools.ts` | ~240 | 每工具 ~20 LOC（schema + handler） |
| 类型定义 | `types.ts` | ~60 | LspClient/LspServerConfig/ToolInput interfaces |
| `src/tools.ts` 集成 | `tools.ts` | ~5 | import + spread 注册 |
| **合计** | — | **~545** | — |

**难度标注**：

| 模块 | 难度 | 风险点 |
|------|------|--------|
| `createLspClient()` | Medium | JSON-RPC 协议实现、stdio 双向绑定 |
| `LspClientManager` | High | 并发安全、crash recovery 状态机、内存泄漏防护 |
| `withLspClient` | Low | 纯路由逻辑 |
| 工具定义 | Low | 重复性工作，schema 驱动 |

## 6. Dependencies

- **LSP 客户端库：直接 JSON-RPC**（决策已定）
  - `vscode-languageclient` 依赖 VS Code 运行时，不适合 CLI 环境
  - 直接 JSON-RPC 更轻量，ola-cc 已有 `src/services/lsp/` 基础设施可复用
  - 复用现有 LSP 连接管理代码，减少额外依赖
- Language server binaries (user must install separately)

## 7. LSP Server 生命周期管理

### 7.1 启动策略：懒启动

- 首次请求时才启动对应语言的 LSP server
- 避免启动时加载所有语言 server 造成资源浪费
- `LspClientManager.getClientForFile()` 在无缓存时触发 `createLspClient()`

### 7.2 崩溃恢复

- 监听 LSP server 进程 `exit`/`error` 事件
- 检测到进程退出后自动重启，最多重试 3 次
- 超过重试次数后标记该语言 server 为不可用，返回错误提示用户检查 server 安装
- 重试计数在进程正常运行 60 秒后重置

### 7.3 空闲超时

- 5 分钟无请求后优雅关闭 LSP server 进程
- 下次请求时重新启动（回到懒启动流程）
- 通过 `setTimeout` 追踪空闲状态，每次请求重置计时器

### 7.4 多 Server 隔离

- 每个语言独立进程，互不干扰
- 端口自动分配（使用 stdio 通信，无需端口管理）
- Map 结构：`languageId → LspClient`，一一对应
- session 结束时通过 `dispose()` 统一清理所有 client

---

## 8. Feature Flags

| Flag | 默认 | 环境变量覆盖 | 降级策略 |
|------|------|-------------|---------|
| `OLA_CC_LSP_TOOLS` | off | `OLA_CC_LSP_TOOLS=1` | 见 8.1 降级策略 |

### 8.1 降级策略（LSP_TOOLS=off）

当 `LSP_TOOLS` feature flag 关闭时，系统行为如下：

| 维度 | 降级行为 |
|------|---------|
| **工具注册** | `lspTools` 数组不注入 `src/tools.ts`，12 个 LSP 工具对 model 不可见 |
| **LSP Server** | 不启动任何 LSP server 进程，不消耗额外内存（~50-150MB per language server） |
| **功能回退** | 用户/query 回退到现有文件级工具：`Grep`（符号搜索）、`Read`（跳转定义的近似）、`Bash`+`rg`（引用查找） |
| **性能影响** | 无额外启动延迟，无 idle timer 管理开销 |
| **错误处理** | 无 `No LSP server available` 错误路径，因为工具根本不存在 |

**回退能力对比**：

| LSP 功能 | 回退工具 | 精度损失 |
|----------|---------|---------|
| `lsp_hover` | `Read` + 手动定位 | 丢失类型信息和文档 |
| `lsp_goto_definition` | `Grep` 按符号名搜索 | 可能匹配多个位置 |
| `lsp_find_references` | `Grep -r "symbol"` | 无法区分定义/引用/字符串 |
| `lsp_rename` | `Grep` + `Edit` 批量替换 | 可能误改同名字符串 |
| `lsp_diagnostics` | `Bash` + 编译器/检查工具 | 需用户手动运行 |
| `lsp_format` | `Bash` + prettier/black 等 | 需外部格式化器已安装 |

### 8.2 环境变量覆盖

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `OLA_CC_LSP_TOOLS` | `0` | 设为 `1` 启用 LSP 工具 |
| `OLA_CC_LSP_SERVER_PATH` | 自动检测 | 自定义 LSP server 可执行文件路径，格式：`typescript:/path/to/ts-server,python:/path/to/pylsp` |
| `OLA_CC_LSP_IDLE_TIMEOUT` | `300000` (5min) | 空闲超时毫秒数，设为 `0` 禁用自动关闭 |
| `OLA_CC_LSP_MAX_RETRIES` | `3` | server 崩溃后最大重试次数 |
| `OLA_CC_LSP_INIT_TIMEOUT` | `10000` (10s) | initialize 请求超时毫秒数 |

**LSP_SERVER_PATH 解析逻辑**：

```typescript
function resolveServerPath(languageId: string, defaultCommand: string): string {
  const override = process.env.OLA_CC_LSP_SERVER_PATH
  if (!override) return defaultCommand
  // 格式: "typescript:/usr/bin/ts-server,python:/usr/bin/pylsp"
  const entries = override.split(',')
  for (const entry of entries) {
    const [lang, ...pathParts] = entry.split(':')
    if (lang === languageId) return pathParts.join(':')  // 复原含 : 的路径
  }
  return defaultCommand
}
```

---

## 9. Risks

- LSP server availability varies by environment
- Binary detection adds startup latency
- Multiple LSP servers may conflict on same file
- Memory usage for multiple concurrent LSP clients
