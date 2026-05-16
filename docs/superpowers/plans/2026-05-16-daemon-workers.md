# Daemon/Worker 系统详细设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现常驻后台的 Daemon 进程管理 + Worker 进程池，支持 `--bg` 后台执行会话、`ps`/`logs`/`attach`/`kill` 命令

**Architecture:** 主从架构。Daemon 作为常驻守护进程管理 Worker 生命周期；Worker 是轻量子进程执行实际任务；CLI 通过 Unix socket/HTTP 与 Daemon 通信。使用文件注册表记录活跃会话。

**Tech Stack:** TypeScript, Bun.spawn, Unix Domain Sockets, JSON-over-socket IPC

---

## 核心架构

```
┌─────────────┐     Unix Socket      ┌─────────────────────────┐
│   CLI Client│◄────────────────────►│   Daemon (常驻进程)      │
│   (ps/logs/ │                      │                         │
│    attach)  │                      │  ┌───────────────────┐  │
└──────┬──────┘                      │  │  Session Manager  │  │
       │                             │  │  (状态注册表)      │  │
       │ --bg "任务描述"              │  └───────────────────┘  │
       │                             │         │               │
       │                             │  ┌───────────────────┐  │
       │                             │  │  Warm Spare Pool  │  │
       │                             │  │  (预热备用 Worker) │  │
       │                             │  └───────────────────┘  │
       │                             │         │               │
       │                             │  ┌───────────────────┐  │
       │                             │  │  Worker 1,2,3...  │  │
       │                             │  │  (Bun.spawn 子进程)│  │
       │                             │  └───────────────────┘  │
       └─────────────────────────────┼─────────────────────────┘
                                     │
                              Bun.spawn (fork)
                                     │
                              ┌──────▼──────┐
                              │  Worker     │
                              │  (执行任务)  │
                              │  ┌───────┐  │
                              │  │ Query │  │
                              │  │Engine │  │
                              │  └───────┘  │
                              └─────────────┘
```

## 文件结构

```
src/
├── daemon/
│   ├── main.ts              # Daemon 主进程入口
│   ├── workerRegistry.ts    # Worker 注册与调度
│   ├── worker.ts            # Worker 进程执行逻辑
│   ├── warmSpare.ts         # Warm-spare 池管理
│   ├── sessionManager.ts    # 会话状态管理
│   ├── socketServer.ts      # Unix socket 服务器
│   ├── protocol.ts          # IPC 协议定义
│   └── config.ts            # Daemon 配置
├── cli/
│   └── bg.ts                # BG CLI 命令 (ps/logs/attach/kill/--bg)
└── services/
    └── daemon/
        └── client.ts        # Daemon CLI 客户端 (socket 通信)
```

---

## Phase 4A: 基础会话注册表 (最快见效)

**核心思路:** 先实现基于文件注册表的简单版本，不依赖常驻 Daemon 进程。`--bg` 启动独立子进程，CLI 命令通过读取注册表获取状态。这是最小可用版本。

### Task 1: 会话注册表

**Files:**
- Create: `src/daemon/sessionRegistry.ts` - 基于文件的会话注册表
- Create: `src/cli/bg.ts` - BG CLI 命令实现

- [ ] **Step 1: 创建会话注册表**

创建 `src/daemon/sessionRegistry.ts`:

```typescript
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export interface SessionEntry {
  id: string
  pid: number
  status: 'running' | 'completed' | 'failed' | 'killed'
  prompt: string
  workdir: string
  startedAt: number
  lastActivity: number
  logPath?: string
  exitCode?: number
}

const getSessionDir = (): string => {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  return path.join(base, 'sessions')
}

export async function initSessionRegistry(): Promise<void> {
  const dir = getSessionDir()
  await fs.mkdir(dir, { recursive: true })
}

export async function registerSession(entry: SessionEntry): Promise<void> {
  await initSessionRegistry()
  const filePath = path.join(getSessionDir(), `${entry.id}.json`)
  await fs.writeFile(filePath, JSON.stringify(entry, null, 2))
}

export async function updateSession(id: string, updates: Partial<SessionEntry>): Promise<void> {
  const existing = await getSession(id)
  if (!existing) return
  const updated = { ...existing, ...updates, lastActivity: Date.now() }
  await registerSession(updated)
}

export async function getSession(id: string): Promise<SessionEntry | null> {
  try {
    const filePath = path.join(getSessionDir(), `${id}.json`)
    const data = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function listSessions(): Promise<SessionEntry[]> {
  await initSessionRegistry()
  try {
    const files = await fs.readdir(getSessionDir())
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    const sessions = await Promise.all(
      jsonFiles.map(async (f) => {
        try {
          const data = await fs.readFile(path.join(getSessionDir(), f), 'utf-8')
          return JSON.parse(data) as SessionEntry
        } catch {
          return null
        }
      })
    )
    return sessions.filter(Boolean) as SessionEntry[]
  } catch {
    return []
  }
}

export async function removeSession(id: string): Promise<void> {
  const filePath = path.join(getSessionDir(), `${id}.json`)
  await fs.unlink(filePath).catch(() => {})
}

export async function cleanupDeadSessions(): Promise<void> {
  const sessions = await listSessions()
  for (const s of sessions) {
    if (s.status === 'running') {
      try {
        process.kill(s.pid, 0) // 检查进程是否存在
      } catch {
        await updateSession(s.id, { status: 'failed', exitCode: -1 })
      }
    }
  }
}
```

- [ ] **Step 2: 创建 BG CLI 命令**

创建 `src/cli/bg.ts`:

```typescript
import { spawn } from 'child_process'
import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import {
  registerSession,
  listSessions,
  getSession,
  updateSession,
  removeSession,
  cleanupDeadSessions,
  type SessionEntry,
} from '../daemon/sessionRegistry.js'

function generateSessionId(): string {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

function getSessionLogPath(id: string): string {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  const logDir = path.join(base, 'sessions', 'logs')
  return path.join(logDir, `${id}.log`)
}

/**
 * Handle `ola-cc --bg "prompt"` - start a background session
 */
export async function handleBgFlag(args: string[]): Promise<void> {
  await cleanupDeadSessions()

  const bgIndex = args.indexOf('--bg')
  const bgIndexAlt = args.indexOf('--background')
  const index = bgIndex >= 0 ? bgIndex : bgIndexAlt
  if (index < 0) {
    console.error('Usage: ola-cc --bg "your prompt here"')
    process.exit(1)
  }

  const prompt = args[index + 1]
  if (!prompt) {
    console.error('Error: --bg requires a prompt argument')
    console.error('Usage: ola-cc --bg "your prompt here"')
    process.exit(1)
  }

  const id = generateSessionId()
  const logPath = getSessionLogPath(id)

  // Ensure log directory exists
  await fs.mkdir(path.dirname(logPath), { recursive: true })

  const sessionEntry: SessionEntry = {
    id,
    pid: 0, // Will be set after spawn
    status: 'running',
    prompt,
    workdir: process.cwd(),
    startedAt: Date.now(),
    lastActivity: Date.now(),
    logPath,
  }

  // Spawn child process running the same binary with the prompt
  const child = spawn(
    process.execPath,
    [process.argv[1], '--bg-worker', id, '--print', prompt],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    }
  )

  sessionEntry.pid = child.pid!
  await registerSession(sessionEntry)

  // Pipe output to log file
  child.stdout?.pipe(fs.createWriteStream(logPath, { flags: 'a' }))
  child.stderr?.pipe(fs.createWriteStream(logPath, { flags: 'a' }))

  child.on('exit', (code) => {
    updateSession(id, {
      status: code === 0 ? 'completed' : 'failed',
      exitCode: code ?? -1,
      lastActivity: Date.now(),
    }).catch(() => {})
  })

  child.unref()

  console.log(`Background session started: ${id}`)
  console.log(`View logs:  ola-cc logs ${id}`)
  console.log(`Check status: ola-cc ps`)
}

/**
 * Handle `ola-cc ps` - list background sessions
 */
export async function psHandler(_args: string[]): Promise<void> {
  await cleanupDeadSessions()
  const sessions = await listSessions()

  if (sessions.length === 0) {
    console.log('No background sessions.')
    return
  }

  // Sort by startedAt, newest first
  sessions.sort((a, b) => b.startedAt - a.startedAt)

  // Print table
  console.log(
    'ID'.padEnd(32),
    'STATUS'.padEnd(12),
    'PID'.padEnd(8),
    'STARTED'.padEnd(20),
    'PROMPT'
  )
  console.log('-'.repeat(100))

  for (const s of sessions) {
    const started = new Date(s.startedAt).toLocaleString()
    const prompt = s.prompt.length > 40 ? s.prompt.slice(0, 37) + '...' : s.prompt
    console.log(
      s.id.padEnd(32),
      s.status.padEnd(12),
      String(s.pid).padEnd(8),
      started.padEnd(20),
      prompt
    )
  }
}

/**
 * Handle `ola-cc logs <id>` - show session logs
 */
export async function logsHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('Usage: ola-cc logs <session-id>')
    process.exit(1)
  }

  const session = await getSession(id)
  if (!session) {
    console.error(`Session ${id} not found.`)
    process.exit(1)
  }

  if (!session.logPath) {
    console.log('No logs available for this session.')
    return
  }

  try {
    const logData = await fs.readFile(session.logPath, 'utf-8')
    console.log(logData)
  } catch {
    console.log('No logs available (file not found).')
  }
}

/**
 * Handle `ola-cc attach <id>` - attach to a running session
 */
export async function attachHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('Usage: ola-cc attach <session-id>')
    process.exit(1)
  }

  const session = await getSession(id)
  if (!session) {
    console.error(`Session ${id} not found.`)
    process.exit(1)
  }

  if (session.status !== 'running') {
    console.error(`Session ${id} is ${session.status}, not running.`)
    process.exit(1)
  }

  console.log(`Attaching to session ${id} (PID: ${session.pid})...`)
  console.log('Use Ctrl+C to detach.')

  // In a full implementation, this would connect to the worker's output stream.
  // For now, tail the log file.
  const logPath = session.logPath
  if (logPath) {
    const { execSync } = await import('child_process')
    try {
      execSync(`tail -f "${logPath}"`, { stdio: 'inherit' })
    } catch {
      // User pressed Ctrl+C
    }
  }
}

/**
 * Handle `ola-cc kill <id>` - terminate a session
 */
export async function killHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('Usage: ola-cc kill <session-id>')
    process.exit(1)
  }

  const session = await getSession(id)
  if (!session) {
    console.error(`Session ${id} not found.`)
    process.exit(1)
  }

  try {
    process.kill(session.pid, 'SIGTERM')
    await updateSession(id, { status: 'killed', lastActivity: Date.now() })
    console.log(`Session ${id} terminated.`)
  } catch (err) {
    console.error(`Failed to kill session ${id}: ${err}`)
    // Force kill as fallback
    try {
      process.kill(session.pid, 'SIGKILL')
      await updateSession(id, { status: 'killed', lastActivity: Date.now() })
      console.log(`Session ${id} force-killed.`)
    } catch {
      await updateSession(id, { status: 'failed', lastActivity: Date.now() })
      console.log(`Session ${id} marked as failed (process not found).`)
    }
  }
}
```

- [ ] **Step 3: 修改 cli.tsx 添加 --bg-worker 内部路径**

在 `src/entrypoints/cli.tsx` 中，`--daemon-worker` 路径后添加:

```typescript
// Fast-path for `--bg-worker=<id>` (internal — spawned by --bg flag).
if (feature('BG_SESSIONS') && args[0] === '--bg-worker') {
  const { enableConfigs } = await import('../utils/config.js')
  enableConfigs()
  const { runBgWorker } = await import('../daemon/bgWorker.js')
  await runBgWorker(args[1], args.slice(2))
  return
}
```

- [ ] **Step 4: 创建 bgWorker.ts**

创建 `src/daemon/bgWorker.ts`:

```typescript
import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import { updateSession } from './sessionRegistry.js'

/**
 * Run as a background worker process.
 * Executes the given prompt as a non-interactive session.
 */
export async function runBgWorker(sessionId: string, remainingArgs: string[]): Promise<void> {
  const logPath = await getSessionLogPath(sessionId)

  // Redirect stdout/stderr to log file
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })
  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  const originalStderrWrite = process.stderr.write.bind(process.stderr)

  process.stdout.write = (chunk: any, ...args: any[]) => {
    logStream.write(chunk)
    return originalStdoutWrite(chunk, ...args)
  }
  process.stderr.write = (chunk: any, ...args: any[]) => {
    logStream.write(chunk)
    return originalStderrWrite(chunk, ...args)
  }

  try {
    await updateSession(sessionId, { lastActivity: Date.now() })

    // Load the main query engine and execute non-interactively
    const { main: queryMain } = await import('../main.js')
    const result = await queryMain({
      bgMode: true,
      bgSessionId: sessionId,
      initialPrompt: remainingArgs.join(' '),
    })

    await updateSession(sessionId, {
      status: result?.success ? 'completed' : 'failed',
      exitCode: result?.success ? 0 : 1,
      lastActivity: Date.now(),
    })
  } catch (err) {
    await updateSession(sessionId, {
      status: 'failed',
      exitCode: -1,
      lastActivity: Date.now(),
    })
    logStream.write(`Worker error: ${err}\n`)
  } finally {
    logStream.end()
  }
}

async function getSessionLogPath(id: string): Promise<string> {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  const logDir = path.join(base, 'sessions', 'logs')
  await fs.mkdir(logDir, { recursive: true })
  return path.join(logDir, `${id}.log`)
}
```

- [ ] **Step 5: 提交**

```bash
git add src/daemon/sessionRegistry.ts src/cli/bg.ts src/daemon/bgWorker.ts src/entrypoints/cli.tsx
git commit -m "feat(daemon): add file-based session registry and bg CLI commands

- Add sessionRegistry.ts for file-based session tracking
- Add bg.ts with ps/logs/attach/kill/--bg handlers
- Add bgWorker.ts for background worker process execution
- Integrate --bg-worker fast-path in cli.tsx
- Sessions stored in ~/.ola-cc/sessions/*.json"
```

---

## Phase 4B: Daemon 常驻进程

**核心思路:** 实现常驻 Daemon 进程，提供 Unix socket 接口，管理 Worker 生命周期。

### Task 2: Daemon 主进程

**Files:**
- Create: `src/daemon/protocol.ts` - IPC 协议定义
- Create: `src/daemon/socketServer.ts` - Unix socket 服务器
- Create: `src/daemon/main.ts` - Daemon 主进程入口

- [ ] **Step 1: 定义 IPC 协议**

创建 `src/daemon/protocol.ts`:

```typescript
// Request types
export type DaemonRequest =
  | { type: 'start_session'; prompt: string; workdir: string }
  | { type: 'list_sessions' }
  | { type: 'get_session'; id: string }
  | { type: 'kill_session'; id: string }
  | { type: 'get_logs'; id: string; tail?: number }
  | { type: 'attach_session'; id: string }
  | { type: 'ping' }

// Response types
export type DaemonResponse =
  | { type: 'ok'; data?: unknown }
  | { type: 'error'; message: string; code?: string }
  | { type: 'session_output'; id: string; output: string }

// Session status
export type SessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'killed'

export interface SessionInfo {
  id: string
  status: SessionStatus
  pid: number
  prompt: string
  workdir: string
  startedAt: number
  lastActivity: number
}

// Protocol version for compatibility checking
export const PROTOCOL_VERSION = 1
export const MAGIC_HEADER = 'OLACC-DAEMON'
```

- [ ] **Step 2: 创建 Socket 服务器**

创建 `src/daemon/socketServer.ts`:

```typescript
import net from 'net'
import path from 'path'
import os from 'os'
import fs from 'fs'
import type { DaemonRequest, DaemonResponse } from './protocol.js'

function getSocketPath(): string {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  return path.join(base, 'daemon.sock')
}

export function createDaemonSocketServer(handlers: {
  handleRequest: (req: DaemonRequest) => Promise<DaemonResponse>
}): net.Server {
  const socketPath = getSocketPath()

  // Remove stale socket
  try { fs.unlinkSync(socketPath) } catch {}

  const server = net.createServer((socket) => {
    let buffer = ''

    socket.on('data', async (data) => {
      buffer += data.toString()

      // Each message is newline-delimited JSON
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const req = JSON.parse(line) as DaemonRequest
          const res = await handlers.handleRequest(req)
          socket.write(JSON.stringify(res) + '\n')
        } catch (err) {
          const errorRes: DaemonResponse = {
            type: 'error',
            message: `Invalid request: ${err}`,
            code: 'INVALID_REQUEST',
          }
          socket.write(JSON.stringify(errorRes) + '\n')
        }
      }
    })
  })

  return server
}

export { getSocketPath }
```

- [ ] **Step 3: 创建 Daemon 主进程**

创建 `src/daemon/main.ts`:

```typescript
import fs from 'fs'
import type { DaemonRequest, DaemonResponse } from './protocol.js'
import { createDaemonSocketServer, getSocketPath } from './socketServer.js'
import {
  registerSession,
  listSessions,
  getSession,
  updateSession,
  removeSession,
  cleanupDeadSessions,
  type SessionEntry,
} from './sessionRegistry.js'

function generateSessionId(): string {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

async function handleRequest(req: DaemonRequest): Promise<DaemonResponse> {
  try {
    switch (req.type) {
      case 'ping':
        return { type: 'ok', data: { version: 1 } }

      case 'list_sessions':
        await cleanupDeadSessions()
        return { type: 'ok', data: await listSessions() }

      case 'get_session':
        return { type: 'ok', data: await getSession(req.id) }

      case 'kill_session': {
        const session = await getSession(req.id)
        if (!session) {
          return { type: 'error', message: 'Session not found', code: 'NOT_FOUND' }
        }
        try {
          process.kill(session.pid, 'SIGTERM')
          await updateSession(req.id, { status: 'killed' })
          return { type: 'ok' }
        } catch {
          return { type: 'error', message: 'Failed to kill process', code: 'KILL_FAILED' }
        }
      }

      case 'start_session': {
        const id = generateSessionId()
        const entry: SessionEntry = {
          id,
          pid: 0,
          status: 'running',
          prompt: req.prompt,
          workdir: req.workdir,
          startedAt: Date.now(),
          lastActivity: Date.now(),
        }
        await registerSession(entry)

        // Spawn worker via CLI self-invocation
        const { spawn } = await import('child_process')
        const logPath = await ensureLogPath(id)
        const child = spawn(
          process.execPath,
          [process.argv[1], '--bg-worker', id, '--print', req.prompt],
          {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: req.workdir,
          }
        )

        entry.pid = child.pid!
        entry.logPath = logPath
        await registerSession(entry)

        child.stdout?.pipe(fs.createWriteStream(logPath, { flags: 'a' }))
        child.stderr?.pipe(fs.createWriteStream(logPath, { flags: 'a' }))

        child.on('exit', (code) => {
          updateSession(id, {
            status: code === 0 ? 'completed' : 'failed',
            exitCode: code ?? -1,
          }).catch(() => {})
        })

        child.unref()
        return { type: 'ok', data: { id } }
      }

      case 'get_logs': {
        const session = await getSession(req.id)
        if (!session?.logPath) {
          return { type: 'error', message: 'No logs available', code: 'NO_LOGS' }
        }
        try {
          const data = fs.readFileSync(session.logPath, 'utf-8')
          const lines = data.split('\n')
          const tail = req.tail ?? 100
          return { type: 'ok', data: { logs: lines.slice(-tail).join('\n') } }
        } catch {
          return { type: 'error', message: 'Log file not found', code: 'NOT_FOUND' }
        }
      }

      default:
        return { type: 'error', message: 'Unknown request', code: 'UNKNOWN' }
    }
  } catch (err) {
    return { type: 'error', message: String(err), code: 'INTERNAL' }
  }
}

async function ensureLogPath(id: string): Promise<string> {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  const logDir = path.join(base, 'sessions', 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  return path.join(logDir, `${id}.log`)
}

export async function daemonMain(args: string[] = []): Promise<void> {
  const pidFile = path.join(path.dirname(getSocketPath()), 'daemon.pid')

  // Check if daemon is already running
  try {
    const existingPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
    try {
      process.kill(existingPid, 0)
      console.log(`Daemon already running (PID: ${existingPid})`)
      return
    } catch {
      // Stale PID file, clean up
      fs.unlinkSync(pidFile)
    }
  } catch {}

  // Handle subcommands
  if (args[0] === 'stop') {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
      process.kill(pid, 'SIGTERM')
      fs.unlinkSync(pidFile)
      console.log('Daemon stopped.')
    } catch {
      console.log('Daemon is not running.')
    }
    return
  }

  if (args[0] === 'status') {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
      process.kill(pid, 0)
      console.log(`Daemon is running (PID: ${pid})`)
      console.log(`Socket: ${getSocketPath()}`)
    } catch {
      console.log('Daemon is not running.')
    }
    return
  }

  // Start daemon
  const server = createDaemonSocketServer({ handleRequest })

  await new Promise<void>((resolve, reject) => {
    server.listen(getSocketPath(), () => {
      fs.chmodSync(getSocketPath(), 0o600)
      fs.writeFileSync(pidFile, String(process.pid))
      console.log(`Daemon started (PID: ${process.pid})`)
      console.log(`Socket: ${getSocketPath()}`)
      resolve()
    })
    server.on('error', reject)
  })

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    server.close(() => {
      try { fs.unlinkSync(getSocketPath()) } catch {}
      try { fs.unlinkSync(pidFile) } catch {}
      process.exit(0)
    })
  })

  process.on('SIGINT', () => {
    server.close(() => {
      try { fs.unlinkSync(getSocketPath()) } catch {}
      try { fs.unlinkSync(pidFile) } catch {}
      process.exit(0)
    })
  })
}
```

- [ ] **Step 4: 提交**

```bash
git add src/daemon/protocol.ts src/daemon/socketServer.ts src/daemon/main.ts
git commit -m "feat(daemon): add daemon process with unix socket IPC

- Add protocol.ts with request/response type definitions
- Add socketServer.ts for newline-delimited JSON IPC
- Add main.ts with daemon lifecycle (start/stop/status)
- Session management via file-based registry
- PID file and socket cleanup on shutdown"
```

---

## Phase 4C: CLI 客户端集成

### Task 3: Daemon 客户端 + CLI 集成

**Files:**
- Create: `src/services/daemon/client.ts` - Daemon socket 客户端
- Modify: `src/cli/bg.ts` - 支持 daemon 模式
- Modify: `src/entrypoints/cli.tsx` - 添加 daemon 子命令

- [ ] **Step 1: 创建 Daemon 客户端**

创建 `src/services/daemon/client.ts`:

```typescript
import net from 'net'
import path from 'path'
import os from 'os'
import type { DaemonRequest, DaemonResponse } from '../../daemon/protocol.js'

function getSocketPath(): string {
  const base = process.env.OLA_CC_HOME || path.join(os.homedir(), '.ola-cc')
  return path.join(base, 'daemon.sock')
}

export async function isDaemonRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: getSocketPath() })
    const timeout = setTimeout(() => { socket.destroy(); resolve(false) }, 1000)

    socket.on('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(true)
    })

    socket.on('error', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}

export async function sendDaemonRequest(req: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: getSocketPath() })
    let buffer = ''

    socket.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.trim()) {
          try {
            resolve(JSON.parse(line) as DaemonResponse)
            socket.destroy()
            return
          } catch {}
        }
      }
    })

    socket.on('error', (err) => {
      resolve({ type: 'error', message: `Daemon not running: ${err}`, code: 'DAEMON_UNAVAILABLE' })
    })

    socket.on('connect', () => {
      socket.write(JSON.stringify(req) + '\n')
    })

    setTimeout(() => {
      socket.destroy()
      resolve({ type: 'error', message: 'Daemon request timed out', code: 'TIMEOUT' })
    }, 5000)
  })
}
```

- [ ] **Step 2: 修改 bg.ts 支持 daemon 模式**

在 `bg.ts` 的每个 handler 中添加 daemon 检测:

```typescript
import { isDaemonRunning, sendDaemonRequest } from '../services/daemon/client.js'

export async function handleBgFlag(args: string[]): Promise<void> {
  // Try daemon mode first
  if (await isDaemonRunning()) {
    const prompt = extractBgPrompt(args)
    if (!prompt) {
      console.error('Error: --bg requires a prompt argument')
      process.exit(1)
    }
    const res = await sendDaemonRequest({
      type: 'start_session',
      prompt,
      workdir: process.cwd(),
    })
    if (res.type === 'ok') {
      console.log(`Background session started: ${(res.data as any).id}`)
      console.log(`View logs:  ola-cc logs ${(res.data as any).id}`)
    } else {
      console.error(`Failed: ${res.message}`)
      process.exit(1)
    }
    return
  }

  // Fallback: direct spawn mode (Phase 4A)
  // ... existing implementation
}
```

- [ ] **Step 3: 提交**

```bash
git add src/services/daemon/client.ts src/cli/bg.ts src/entrypoints/cli.tsx
git commit -m "feat(daemon): add client and integrate with bg CLI

- Add daemon client for unix socket communication
- Modify bg handlers to prefer daemon mode with fallback
- Add daemon start/stop/status commands to CLI"
```

---

## 依赖关系

```
Task 1 (Session Registry + bg CLI)
  └── Task 2 (Daemon Process)
        └── Task 3 (Client + Integration)
```

---

## 测试策略

1. **单元测试:** sessionRegistry.ts 的 CRUD 操作
2. **集成测试:** bg CLI 命令的 --help 和错误处理
3. **手动测试:**
   - `ola-cc --bg "write a hello world script"` → 创建后台会话
   - `ola-cc ps` → 列出会话
   - `ola-cc logs <id>` → 查看日志
   - `ola-cc kill <id>` → 终止会话
   - `ola-cc daemon start` → 启动守护进程
   - `ola-cc daemon status` → 检查状态

---

## 预期性能

| 指标 | 目标 |
|------|------|
| `--bg` 启动时间 | < 500ms |
| `ps` 响应时间 | < 100ms |
| Daemon IPC 延迟 | < 10ms |
| 内存开销 (Daemon) | < 20MB |

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-16-daemon-workers.md`**

**Execution options:**

**1. Subagent-Driven (recommended)** - 每个 task 派发独立 subagent，两阶段审查

**2. Inline Execution** - 在当前 session 中依次执行

**Which approach?**
