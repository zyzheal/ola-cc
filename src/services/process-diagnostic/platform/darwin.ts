import type { PlatformOps } from './types.js'
import type { ProcessInfo, SocketInfo } from '../types.js'
import { redactEnv } from '../redact.js'
import { EXEC_TIMEOUT_MS, HIGH_CPU_PERCENT } from '../constants.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'

const execFileAsync = promisify(execFile)

// --- Helpers ---

async function run(cmd: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

function parsePsLine(line: string): {
  pid: number; ppid: number; comm: string; state: string;
  pcpu: number; rss: number; args: string; lstart: string;
} | null {
  // ps 输出可能包含空格，用固定宽度或特殊分隔
  // 使用 -o pid=,ppid=,comm=,lstart=,state=,pcpu=,rss=,args=
  // 但 lstart 包含空格，需要特殊处理
  // 改用 tab 分隔: -o pid=$'\t',ppid=$'\t' 等
  // 简单方案: 用正则解析
  const match = line.match(
    /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s+([A-Z])\s+(\d+\.?\d*)\s+(\d+)\s+(.*)$/
  )
  if (!match) return null
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    comm: match[3],
    lstart: match[4].trim(),
    state: match[5],
    pcpu: Number(match[6]),
    rss: Number(match[7]),
    args: match[8],
  }
}

function parseLsofF(output: string, prefix: string): string | null {
  // lsof -F 输出: 每行一个字段，首字符为类型
  // p<pid>, f<fd>, t<type>, n<name>, ...
  for (const line of output.split('\n')) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length)
    }
  }
  return null
}

function parseLsofSockets(output: string): SocketInfo[] {
  // lsof -i -P -n 输出格式:
  // COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
  // node   12345 heal  22u  IPv4 0x...      0t0  TCP *:3000 (LISTEN)
  const sockets: SocketInfo[] = []
  for (const line of output.split('\n')) {
    const match = line.match(
      /\s+(TCP|UDP|TCP6|UDP6)\s+(\S+):(\d+)\s+\((\w+)\)/
    )
    if (match) {
      const protocol = match[1]
      const address = match[2]
      const port = Number(match[3])
      const state = match[4]
      sockets.push({ protocol, address, port, state })
    }
  }
  return sockets
}

function parseDate(dateStr: string): Date {
  // lstart 格式: "Mon Jan  1 00:00:00 2024" 或类似
  const d = new Date(dateStr)
  return isNaN(d.getTime()) ? new Date() : d
}

function deriveCommand(comm: string, args: string, exe: string): string {
  if (comm) {
    if (exe && exe.length > comm.length) {
      const exeBase = path.basename(exe)
      if (exeBase.startsWith(comm)) return exeBase
    }
    return comm
  }
  return extractExecutableName(args) || 'unknown'
}

function extractExecutableName(cmdline: string): string | null {
  if (!cmdline) return null
  const parts = cmdline.split(/\s+/)
  const SHELL_PREFIX_COMMANDS: Record<string, string[]> = {
    'sudo': ['-u', '-g', '-C', '--group', '--chdir'],
    'env': ['-u', '--unset'],
    'nice': ['-n', '--adjustment'],
    'nohup': [],
    'time': [],
  }
  let skipNext = false
  let lastPrefixCmd: string | null = null
  for (const part of parts) {
    if (skipNext) { skipNext = false; continue }
    if (/^[A-Z_][A-Z0-9_]*=/.test(part)) continue
    const base = path.basename(part.replace(/^["']|["']$/g, ''))
    if (base in SHELL_PREFIX_COMMANDS) { lastPrefixCmd = base; continue }
    if (part.startsWith('-')) {
      const knownFlags = lastPrefixCmd ? SHELL_PREFIX_COMMANDS[lastPrefixCmd] : []
      if (knownFlags.includes(part)) skipNext = true
      continue
    }
    return base
  }
  return null
}

// --- Launchd detection ---

async function detectLaunchd(pid: number): Promise<{
  name: string; description: string; unitFile?: string;
} | null> {
  // launchctl blame <pid> → 服务标签
  const blameOutput = await run('launchctl', ['blame', String(pid)])
  if (blameOutput && !blameOutput.includes('not found')) {
    const label = blameOutput.split('\n')[0]?.trim()
    if (label && label !== 'com.apple.xpc.launchd') {
      // 搜索 plist 路径
      const plistPath = await findPlist(label)
      return {
        name: label,
        description: `launchd service: ${label}`,
        unitFile: plistPath ?? undefined,
      }
    }
  }
  return null
}

async function findPlist(label: string): Promise<string | null> {
  const searchPaths = [
    `/Library/LaunchDaemons/${label}.plist`,
    `/Library/LaunchAgents/${label}.plist`,
    `${process.env.HOME}/Library/LaunchAgents/${label}.plist`,
    `/System/Library/LaunchDaemons/${label}.plist`,
    `/System/Library/LaunchAgents/${label}.plist`,
  ]
  for (const p of searchPaths) {
    try {
      await execFileAsync('test', ['-f', p], { timeout: 1000 })
      return p
    } catch {
      // not found, continue
    }
  }
  return null
}

// --- PlatformOps implementation ---

const darwinOps: PlatformOps = {
  async findPIDs(query: { type: string; value: string; exact?: boolean }): Promise<number[]> {
    const { type, value, exact } = query

    if (type === 'pid') {
      const pid = Number(value)
      if (isNaN(pid) || pid <= 0) return []
      // 验证进程存在
      const output = await run('ps', ['-p', String(pid), '-o', 'pid='])
      return output.trim() ? [pid] : []
    }

    if (type === 'port') {
      const port = Number(value)
      if (isNaN(port) || port <= 0) return []

      // 三级 lsof 回退
      // 1. TCP 监听
      let output = await run('lsof', ['-i', `TCP:${port}`, '-s', 'TCP:LISTEN', '-F', 'p'])
      if (output) return parseLsofPIDs(output)

      // 2. UDP
      output = await run('lsof', ['-i', `UDP:${port}`, '-F', 'p'])
      if (output) return parseLsofPIDs(output)

      // 3. 任意协议
      output = await run('lsof', ['-i', `:${port}`, '-F', 'p'])
      if (output) return parseLsofPIDs(output)

      // netstat -anv 不显示 PID，无法用于端口→PID 查找
      return []
    }

    if (type === 'name') {
      // ps -axo pid=,comm=,args= 全进程扫描
      const output = await run('ps', ['-axo', 'pid=,comm=,args='])
      const pids: number[] = []
      for (const line of output.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/)
        if (!match) continue
        const pid = Number(match[1])
        const comm = match[2]
        const args = match[3]
        const target = exact ? value : value.toLowerCase()
        const source = exact ? comm : comm.toLowerCase()
        const argsLower = exact ? args : args.toLowerCase()
        if (source.includes(target) || argsLower.includes(target)) {
          pids.push(pid)
        }
      }
      return pids
    }

    if (type === 'file') {
      const output = await run('lsof', ['-F', 'p', value])
      return parseLsofPIDs(output)
    }

    return []
  },

  async readProcess(pid: number): Promise<ProcessInfo> {
    // ps 获取基本信息
    const psOutput = await run('ps', [
      '-p', String(pid),
      '-o', 'pid=,ppid=,comm=,lstart=,state=,pcpu=,rss=,args=',
    ])
    const parsed = parsePsLine(psOutput)

    // lsof 获取 cwd 和 exe
    const lsofOutput = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd,txt', '-F', 'fn'])
    const cwd = parseLsofF(lsofOutput, 'n') || ''
    // txt 文件描述符对应可执行文件
    const lines = lsofOutput.split('\n')
    let exe = ''
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('fc') && lines[i].includes('txt')) {
        // 下一行的 n 字段是 exe
        if (i + 1 < lines.length && lines[i + 1].startsWith('n')) {
          exe = lines[i + 1].slice(1)
        }
      }
    }
    // 回退: 直接从 lsof 获取 txt
    if (!exe) {
      const txtOutput = await run('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-F', 'n'])
      for (const line of txtOutput.split('\n')) {
        if (line.startsWith('n')) {
          exe = line.slice(1)
          break
        }
      }
    }

    // 用户
    const userOutput = await run('ps', ['-p', String(pid), '-o', 'user='])
    const user = userOutput.trim() || 'unknown'

    // launchd 服务检测
    const launchdInfo = await detectLaunchd(pid)

    // sockets 由 analyze.ts 统一管理，不在 readProcess 内部读取
    const sockets: SocketInfo[] = []
    // env 由 analyze.ts 在 verbose 模式下单独调用 readEnvironment
    const env: string[] = []

    const command = parsed
      ? deriveCommand(parsed.comm, parsed.args, exe)
      : 'unknown'

    return {
      pid,
      ppid: parsed?.ppid ?? 0,
      command,
      cmdline: parsed?.args ?? '',
      exe: exe || '',
      startedAt: parsed ? parseDate(parsed.lstart) : new Date(),
      user,
      cpuPercent: parsed?.pcpu ?? 0,
      memoryRSS: (parsed?.rss ?? 0) * 1024, // ps rss 是 KB，转为 bytes
      workingDir: cwd,
      sockets,
      health: parsed?.state === 'Z' ? 'zombie'
        : parsed?.state === 'T' ? 'stopped'
        : (parsed?.pcpu ?? 0) > HIGH_CPU_PERCENT ? 'high-cpu'
        : 'healthy',
      env: env.length > 0 ? env : undefined,
      exeDeleted: exe.includes('(deleted)'),
      service: launchdInfo?.name,
    }
  },

  async getParentPID(pid: number): Promise<number | null> {
    const output = await run('ps', ['-p', String(pid), '-o', 'ppid='])
    const ppid = Number(output.trim())
    return isNaN(ppid) || ppid === 0 ? null : ppid
  },

  async getInitPID(): Promise<number> {
    return 1 // launchd on macOS
  },

  async readSockets(pid: number): Promise<SocketInfo[]> {
    const output = await run('lsof', ['-a', '-p', String(pid), '-i', '-P', '-n'])
    return parseLsofSockets(output)
  },

  async listChildren(pid: number): Promise<number[]> {
    // pgrep -P <pid>
    let output = await run('pgrep', ['-P', String(pid)])
    if (output) {
      return output.split('\n').map(Number).filter(n => !isNaN(n) && n > 0)
    }
    // 回退: ps -axo pid=,ppid=
    output = await run('ps', ['-axo', 'pid=,ppid='])
    const children: number[] = []
    for (const line of output.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)/)
      if (match && Number(match[2]) === pid) {
        children.push(Number(match[1]))
      }
    }
    return children
  },

  async readEnvironment(pid: number): Promise<string[]> {
    // macOS 没有 /proc/[pid]/environ，使用 ps 获取有限信息
    // 或者使用 lsof 读取 environ 文件
    const output = await run('ps', ['-p', String(pid), '-E', '-o', 'env='])
    if (output) {
      return redactEnv(output.split('\n').filter(Boolean))
    }
    return []
  },

  async detectContainer(pid: number): Promise<string | null> {
    // macOS Docker Desktop: 检查进程命令行是否包含 docker 相关
    const cmdline = await run('ps', ['-p', String(pid), '-o', 'args='])
    if (cmdline.includes('docker') || cmdline.includes('com.docker')) {
      return 'docker-desktop'
    }
    return null
  },

  async readServiceInfo(pid: number): Promise<{
    name: string; description: string; unitFile?: string;
  } | null> {
    return detectLaunchd(pid)
  },
}

// --- Port parsing helpers ---

function parseLsofPIDs(output: string): number[] {
  const pids: number[] = []
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1))
      if (!isNaN(pid) && pid > 0) pids.push(pid)
    }
  }
  return pids
}

export default darwinOps
