import type { PlatformOps } from './types.js'
import type { ProcessInfo, SocketInfo } from '../types.js'
import { redactEnv } from '../redact.js'
import { EXEC_TIMEOUT_MS } from '../constants.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const execFileAsync = promisify(execFile)

// --- Helpers ---

async function readFile(p: string): Promise<string> {
  try {
    return (await fs.readFile(p, 'utf8')).trim()
  } catch {
    return ''
  }
}

async function readLink(p: string): Promise<string> {
  try {
    return await fs.readlink(p)
  } catch {
    return ''
  }
}

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

// --- /proc/[pid]/stat 解析 ---

interface ProcStat {
  pid: number; ppid: number; comm: string; state: string;
  utime: number; stime: number; rss: number; starttime: number;
}

function parseStat(content: string): ProcStat | null {
  // /proc/[pid]/stat: pid (comm) state ppid pgrp session tty_nr tpgid flags
  //   minflt cminflt majflt cmajflt utime stime cutime cstime priority nice
  //   numthreads itrealvalue starttime vsize rss ...
  // comm 可能包含空格和括号，从最后一个 ) 前截取
  const lastParen = content.lastIndexOf(')')
  if (lastParen < 0) return null
  const pidComm = content.slice(0, lastParen + 1)
  const rest = content.slice(lastParen + 2).split(/\s+/)
  const pidMatch = pidComm.match(/^(\d+) \((.+)\)$/)
  if (!pidMatch) return null
  return {
    pid: Number(pidMatch[1]),
    comm: pidMatch[2],
    state: rest[0] || '?',
    ppid: Number(rest[1]) || 0,
    utime: Number(rest[11]) || 0,
    stime: Number(rest[12]) || 0,
    starttime: Number(rest[19]) || 0,
    rss: Number(rest[21]) || 0,
  }
}

// --- /proc/net/tcp 解析 ---

interface ProcNetEntry {
  localPort: number
  localAddr: string
  remotePort: number
  remoteAddr: string
  state: string  // 0A=LISTEN, 01=ESTABLISHED, ...
  inode: number
  uid: number
}

function parseProcNetTcpFull(content: string): ProcNetEntry[] {
  const entries: ProcNetEntry[] = []
  const lines = content.split('\n').slice(1) // skip header
  for (const line of lines) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    const localParts = fields[1].split(':')
    const remoteParts = fields[2].split(':')
    if (localParts.length !== 2 || remoteParts.length !== 2) continue
    entries.push({
      localAddr: hexIpToDotted(localParts[0]),
      localPort: parseInt(localParts[1], 16),
      remoteAddr: hexIpToDotted(remoteParts[0]),
      remotePort: parseInt(remoteParts[1], 16),
      state: fields[3],
      inode: Number(fields[9]),
      uid: Number(fields[7]),
    })
  }
  return entries
}

function hexIpToDotted(hex: string): string {
  if (hex === '00000000') return '0.0.0.0'
  if (hex.length === 8) {
    return [
      parseInt(hex.slice(6, 8), 16),
      parseInt(hex.slice(4, 6), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(0, 2), 16),
    ].join('.')
  }
  // IPv6: 32 hex chars
  if (hex.length === 32) {
    const parts: string[] = []
    for (let i = 0; i < 32; i += 4) {
      parts.push(hex.slice(i, i + 4))
    }
    return parts.join(':')
  }
  return hex
}

function stateToString(hexState: string): string {
  const map: Record<string, string> = {
    '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV',
    '04': 'FIN_WAIT1', '05': 'FIN_WAIT2', '06': 'TIME_WAIT',
    '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK',
    '0A': 'LISTEN', '0B': 'CLOSING',
  }
  return map[hexState] || hexState
}

// --- 启动时间计算 ---

let cachedBootTime = 0
let ticksPerSecond = 100 // 默认值

async function getBootTime(): Promise<number> {
  if (cachedBootTime) return cachedBootTime
  const stat = await readFile('/proc/stat')
  const match = stat.match(/btime\s+(\d+)/)
  cachedBootTime = match ? Number(match[1]) * 1000 : Date.now()
  // sysconf(_SC_CLK_TCK) 通常为 100
  try {
    const { stdout } = await execFileAsync('getconf', ['CLK_TCK'], { timeout: 1000 })
    ticksPerSecond = Number(stdout.trim()) || 100
  } catch {
    ticksPerSecond = 100
  }
  return cachedBootTime
}

function ticksToDate(startTicks: number, bootTimeMs: number): Date {
  return new Date(bootTimeMs + (startTicks / ticksPerSecond) * 1000)
}

// --- UID → username ---

const uidCache = new Map<number, string>()

async function uidToName(uid: number): Promise<string> {
  if (uidCache.has(uid)) return uidCache.get(uid)!
  // 先尝试 /etc/passwd
  try {
    const { stdout } = await execFileAsync('getent', ['passwd', String(uid)], { timeout: 1000 })
    const name = stdout.split(':')[0]
    if (name) { uidCache.set(uid, name); return name }
  } catch {
    // getent not available, try id command
  }
  try {
    const { stdout } = await execFileAsync('id', ['-nu', String(uid)], { timeout: 1000 })
    const name = stdout.trim()
    if (name) { uidCache.set(uid, name); return name }
  } catch {
    // ignore
  }
  const fallback = `uid:${uid}`
  uidCache.set(uid, fallback)
  return fallback
}

// --- BusyBox 检测 ---

let busyboxDetected: boolean | null = null

async function isBusyBox(): Promise<boolean> {
  if (busyboxDetected !== null) return busyboxDetected
  try {
    const { stdout } = await execFileAsync('ss', ['--help'], { timeout: 1000 })
    busyboxDetected = stdout.includes('BusyBox') || stdout.includes('applet')
  } catch {
    busyboxDetected = false
  }
  return busyboxDetected
}

// --- 端口 → PID 解析 ---

async function findPIDByPortViaProc(targetPort: number): Promise<number[]> {
  // 读取 /proc/net/tcp 和 /proc/net/tcp6
  const [tcp4, tcp6] = await Promise.all([
    readFile('/proc/net/tcp'),
    readFile('/proc/net/tcp6'),
  ])
  const entries = [
    ...parseProcNetTcpFull(tcp4),
    ...parseProcNetTcpFull(tcp6),
  ]

  // 找到匹配端口的 LISTEN 条目，收集 inode
  const listenInodes = new Set<number>()
  for (const entry of entries) {
    if (entry.localPort === targetPort && entry.state === '0A') {
      listenInodes.add(entry.inode)
    }
  }
  if (listenInodes.size === 0) return []

  // 遍历 /proc/[pid]/fd，readlink 匹配 socket:[inode]
  const procDir = await fs.readdir('/proc')
  const pids: number[] = []
  for (const entry of procDir) {
    const pid = Number(entry)
    if (isNaN(pid) || pid <= 0) continue
    try {
      const fdDir = await fs.readdir(`/proc/${pid}/fd`)
      for (const fd of fdDir) {
        const link = await readLink(`/proc/${pid}/fd/${fd}`)
        const socketMatch = link.match(/^socket:\[(\d+)\]$/)
        if (socketMatch && listenInodes.has(Number(socketMatch[1]))) {
          pids.push(pid)
          break
        }
      }
    } catch {
      // permission denied, skip
    }
  }
  return pids
}

// --- systemd 检测 ---

async function detectSystemd(pid: number): Promise<{
  name: string; description: string; unitFile?: string;
} | null> {
  try {
    await fs.access('/run/systemd/system')
  } catch {
    return null
  }

  // cgroup 提取 unit 名
  const cgroup = await readFile(`/proc/${pid}/cgroup`)
  // systemd cgroup 格式: 0::/system.slice/nginx.service
  const unitMatch = cgroup.match(/\/(?:system\.slice|user\.slice)\/(.+?)(?:\.service|\.scope)/)
  if (unitMatch) {
    const unitName = unitMatch[1]
    // 用 systemctl 获取详细信息
    const desc = await run('systemctl', ['show', '-p', 'Description', '--value', '--', `${unitName}.service`])
    const unitFile = await run('systemctl', ['show', '-p', 'FragmentPath', '--value', '--', `${unitName}.service`])
    return {
      name: `${unitName}.service`,
      description: desc || `systemd service: ${unitName}`,
      unitFile: unitFile || undefined,
    }
  }
  return null
}

// --- 主要读取函数 ---

async function readProcessFromProc(pid: number): Promise<ProcessInfo> {
  const [stat, cmdlineRaw, comm, exe, cwd, statusRaw] = await Promise.all([
    readFile(`/proc/${pid}/stat`),
    readFile(`/proc/${pid}/cmdline`),
    readFile(`/proc/${pid}/comm`),
    readLink(`/proc/${pid}/exe`),
    readLink(`/proc/${pid}/cwd`),
    readFile(`/proc/${pid}/status`),
  ])

  const parsed = parseStat(stat)
  const cmdline = cmdlineRaw.replace(/\0/g, ' ').trim()

  // UID → username
  const uidMatch = statusRaw.match(/Uid:\s+(\d+)/)
  const uid = uidMatch ? Number(uidMatch[1]) : 0
  const user = await uidToName(uid)

  // 启动时间
  const bootTime = await getBootTime()
  const startedAt = parsed ? ticksToDate(parsed.starttime, bootTime) : new Date()

  // 内存 (KB → bytes)
  const memoryRSS = (parsed?.rss ?? 0) * 4096

  // CPU 使用率 (从 /proc/[pid]/stat 的 utime+stime 计算)
  const cpuPercent = 0 // 需要两次采样才能计算，简化处理

  // 容器检测
  const container = await linuxOps.detectContainer(pid)

  // 服务检测
  const serviceInfo = await linuxOps.readServiceInfo(pid)

  const command = deriveCommand(comm || parsed?.comm || '', cmdline, exe)

  return {
    pid,
    ppid: parsed?.ppid ?? 0,
    command,
    cmdline,
    exe: exe || '',
    startedAt,
    user,
    cpuPercent,
    memoryRSS,
    workingDir: cwd || '',
    sockets: [],
    health: parsed?.state === 'Z' ? 'zombie'
      : parsed?.state === 'T' ? 'stopped'
      : 'healthy',
    env: undefined, // verbose 模式单独加载
    exeDeleted: exe.includes('(deleted)'),
    container: container ?? undefined,
    service: serviceInfo?.name,
  }
}

function deriveCommand(comm: string, cmdline: string, exe: string): string {
  if (!comm) return extractExecutableName(cmdline) || 'unknown'
  if (exe && exe.length > comm.length) {
    const exeBase = path.basename(exe)
    if (exeBase.startsWith(comm)) return exeBase
  }
  return extractExecutableName(cmdline) || comm
}

function extractExecutableName(cmdline: string): string | null {
  if (!cmdline) return null
  const parts = cmdline.split(/\s+/)
  const SHELL_PREFIX_COMMANDS: Record<string, string[]> = {
    'sudo': ['-u', '-g', '-C', '--group', '--chdir'],
    'env': ['-u', '--unset'],
    'nice': ['-n', '--adjustment'],
    'nohup': [], 'time': [],
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

// --- PlatformOps ---

const linuxOps: PlatformOps = {
  async findPIDs(query: { type: string; value: string; exact?: boolean }): Promise<number[]> {
    const { type, value, exact } = query

    if (type === 'pid') {
      const pid = Number(value)
      if (isNaN(pid) || pid <= 0) return []
      try {
        await fs.access(`/proc/${pid}`)
        return [pid]
      } catch {
        return []
      }
    }

    if (type === 'port') {
      const port = Number(value)
      if (isNaN(port) || port <= 0) return []

      // 优先: ss -tlnp sport = :<port> (直接获取监听 PID)
      const isBB = await isBusyBox()
      if (!isBB) {
        const ssOutput = await run('ss', ['-tlnp', `sport = ${port}`])
        if (ssOutput) {
          const pids = parseSsPIDs(ssOutput)
          if (pids.length > 0) return pids
        }
        // UDP
        const ssUdp = await run('ss', ['-ulnp', `sport = ${port}`])
        if (ssUdp) {
          const pids = parseSsPIDs(ssUdp)
          if (pids.length > 0) return pids
        }
      }

      // 回退: /proc/net/tcp + /proc/[pid]/fd inode 关联
      return findPIDByPortViaProc(port)
    }

    if (type === 'name') {
      const procDir = await fs.readdir('/proc')
      const pids: number[] = []
      for (const entry of procDir) {
        const pid = Number(entry)
        if (isNaN(pid) || pid <= 0) continue
        const comm = await readFile(`/proc/${pid}/comm`)
        const cmdline = (await readFile(`/proc/${pid}/cmdline`)).replace(/\0/g, ' ')
        const target = exact ? value : value.toLowerCase()
        const commLower = exact ? comm : comm.toLowerCase()
        const argsLower = exact ? cmdline : cmdline.toLowerCase()
        if (commLower.includes(target) || argsLower.includes(target)) {
          pids.push(pid)
        }
      }
      // 尝试 systemd 服务名
      const svcPids = await findPidsBySystemdUnit(value)
      for (const pid of svcPids) {
        if (!pids.includes(pid)) pids.push(pid)
      }
      return pids
    }

    if (type === 'file') {
      const resolvedPath = await resolveFilePath(value)
      const procDir = await fs.readdir('/proc')
      const pids: number[] = []
      for (const entry of procDir) {
        const pid = Number(entry)
        if (isNaN(pid) || pid <= 0) continue
        try {
          const fdDir = await fs.readdir(`/proc/${pid}/fd`)
          for (const fd of fdDir) {
            const link = await readLink(`/proc/${pid}/fd/${fd}`)
            if (link === resolvedPath) {
              pids.push(pid)
              break
            }
          }
        } catch {
          // permission denied
        }
      }
      return pids
    }

    return []
  },

  async readProcess(pid: number): Promise<ProcessInfo> {
    return readProcessFromProc(pid)
  },

  async getParentPID(pid: number): Promise<number | null> {
    const stat = parseStat(await readFile(`/proc/${pid}/stat`))
    return stat?.ppid && stat.ppid > 0 ? stat.ppid : null
  },

  async getInitPID(): Promise<number> {
    return 1
  },

  async readSockets(pid: number): Promise<SocketInfo[]> {
    // 读取 /proc/[pid]/fd，收集 socket inode
    const socketInodes = new Map<number, string>() // inode → fd
    try {
      const fdDir = await fs.readdir(`/proc/${pid}/fd`)
      for (const fd of fdDir) {
        const link = await readLink(`/proc/${pid}/fd/${fd}`)
        const match = link.match(/^socket:\[(\d+)\]$/)
        if (match) socketInodes.set(Number(match[1]), fd)
      }
    } catch {
      return []
    }
    if (socketInodes.size === 0) return []

    // 读取 /proc/net/tcp 和 /proc/net/tcp6
    const [tcp4, tcp6, udp4, udp6] = await Promise.all([
      readFile('/proc/net/tcp'),
      readFile('/proc/net/tcp6'),
      readFile('/proc/net/udp'),
      readFile('/proc/net/udp6'),
    ])

    const sockets: SocketInfo[] = []
    for (const [content, proto] of [
      [tcp4, 'tcp'], [tcp6, 'tcp6'], [udp4, 'udp'], [udp6, 'udp6'],
    ] as const) {
      const entries = parseProcNetTcpFull(content)
      for (const entry of entries) {
        if (socketInodes.has(entry.inode)) {
          sockets.push({
            port: entry.localPort,
            address: entry.localAddr,
            state: stateToString(entry.state),
            protocol: proto,
          })
        }
      }
    }
    return sockets
  },

  async listChildren(pid: number): Promise<number[]> {
    // Linux 3.5+: /proc/[pid]/task/[pid]/children
    const children = await readFile(`/proc/${pid}/task/${pid}/children`)
    if (children) {
      return children.split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0)
    }
    // 回退: 遍历 /proc
    const procDir = await fs.readdir('/proc')
    const result: number[] = []
    for (const entry of procDir) {
      const childPid = Number(entry)
      if (isNaN(childPid) || childPid <= 0) continue
      const stat = parseStat(await readFile(`/proc/${childPid}/stat`))
      if (stat?.ppid === pid) result.push(childPid)
    }
    return result
  },

  async readEnvironment(pid: number): Promise<string[]> {
    const environ = await readFile(`/proc/${pid}/environ`)
    return environ ? redactEnv(environ.split('\0').filter(Boolean)) : []
  },

  async detectContainer(pid: number): Promise<string | null> {
    const cgroup = await readFile(`/proc/${pid}/cgroup`)
    if (!cgroup) return null
    if (cgroup.includes('docker')) return 'docker'
    if (cgroup.includes('podman')) return 'podman'
    if (cgroup.includes('kubepods')) return 'kubernetes'
    if (cgroup.includes('containerd')) return 'containerd'
    if (cgroup.includes('lxc')) return 'lxc'
    return null
  },

  async readServiceInfo(pid: number): Promise<{
    name: string; description: string; unitFile?: string;
  } | null> {
    return detectSystemd(pid)
  },
}

// --- 辅助函数 ---

function parseSsPIDs(output: string): number[] {
  // ss -tlnp 输出:
  // State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port  Process
  // LISTEN 0      128     0.0.0.0:80          0.0.0.0:*          users:(("nginx",pid=1234,fd=6))
  const pids: number[] = []
  for (const line of output.split('\n')) {
    const matches = line.matchAll(/pid=(\d+)/g)
    for (const m of matches) {
      const pid = Number(m[1])
      if (pid > 0) pids.push(pid)
    }
  }
  return pids
}

async function findPidsBySystemdUnit(unitName: string): Promise<number[]> {
  // systemctl show -p MainPID --value -- <unit>
  const variants = [
    unitName,
    unitName.endsWith('.service') ? unitName : `${unitName}.service`,
  ]
  for (const variant of variants) {
    const output = await run('systemctl', ['show', '-p', 'MainPID', '--value', '--', variant])
    const pid = Number(output)
    if (!isNaN(pid) && pid > 0) return [pid]
  }
  return []
}

async function resolveFilePath(p: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('realpath', [p], { timeout: 1000 })
    return stdout.trim()
  } catch {
    return p
  }
}

export default linuxOps
