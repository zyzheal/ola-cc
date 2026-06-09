import type { PlatformOps } from './types.js'
import type { ProcessInfo, SocketInfo } from '../types.js'
import { EXEC_TIMEOUT_MS } from '../constants.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// --- Helpers ---

async function run(cmd: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

// --- ToolHelp32 快照缓存 (通过 wmic/tasklist 模拟) ---

interface SnapshotEntry {
  pid: number
  ppid: number
  exeFile: string
  threads: number
}

let snapshotCache: { data: Map<number, SnapshotEntry>; expiresAt: number } | null = null
const SNAPSHOT_TTL_MS = 1000

async function getSnapshot(): Promise<Map<number, SnapshotEntry>> {
  if (snapshotCache && Date.now() < snapshotCache.expiresAt) {
    return snapshotCache.data
  }
  // tasklist /FO CSV 获取所有进程
  const output = await run('tasklist', ['/FO', 'CSV', '/NH'])
  const map = new Map<number, SnapshotEntry>()
  for (const line of output.split('\n')) {
    const match = line.match(/^"([^"]+)",\s*"(\d+)",\s*"([^"]*)",\s*"(\d+)",\s*"([^"]*)"/)
    if (match) {
      const pid = Number(match[2])
      if (!isNaN(pid)) {
        map.set(pid, {
          pid,
          ppid: 0, // tasklist 不直接提供 PPID
          exeFile: match[1],
          threads: Number(match[4]) || 0,
        })
      }
    }
  }
  // 补充 PPID: wmic 需要逐进程查询（慢），改用 PowerShell
  // 简化: 遍历 snapshot 用 wmic 获取 PPID 只做一次批量
  const wmicOutput = await run('wmic', ['process', 'get', 'ProcessId,ParentProcessId', '/FORMAT:CSV'])
  for (const line of wmicOutput.split('\n')) {
    const match = line.match(/,(\d+),(\d+)/)
    if (match) {
      const ppid = Number(match[1])
      const pid = Number(match[2])
      const entry = map.get(pid)
      if (entry) entry.ppid = ppid
    }
  }
  snapshotCache = { data: map, expiresAt: Date.now() + SNAPSHOT_TTL_MS }
  return map
}

// --- 服务映射缓存 ---

let serviceMapCache: { data: Map<number, string>; expiresAt: number } | null = null
const SERVICE_MAP_TTL_MS = 2000

async function getServiceMap(): Promise<Map<number, string>> {
  if (serviceMapCache && Date.now() < serviceMapCache.expiresAt) {
    return serviceMapCache.data
  }
  const map = new Map<number, string>()
  // sc query 获取所有服务的 PID
  const output = await run('sc', ['query', 'state=', 'all', ' bufsize=', '16384'])
  let serviceName = ''
  for (const line of output.split('\n')) {
    const nameMatch = line.match(/SERVICE_NAME:\s*(\S+)/)
    if (nameMatch) serviceName = nameMatch[1]
    const pidMatch = line.match(/PID\s*:\s*(\d+)/)
    if (pidMatch && serviceName) {
      const pid = Number(pidMatch[1])
      if (pid > 0 && !map.has(pid)) {
        // "first writer wins" for svchost.exe shared processes
        map.set(pid, serviceName)
      }
    }
  }
  serviceMapCache = { data: map, expiresAt: Date.now() + SERVICE_MAP_TTL_MS }
  return map
}

// --- netstat 端口解析 ---

interface NetstatEntry {
  protocol: string
  localAddr: string
  localPort: number
  foreignAddr: string
  foreignPort: number
  state: string
  pid: number
}

function parseNetstatAno(output: string): NetstatEntry[] {
  const entries: NetstatEntry[] = []
  for (const line of output.split('\n')) {
    // TCP 格式: TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    1234
    // UDP 格式: UDP    0.0.0.0:53    *:*                     1234
    const tcpMatch = line.match(
      /\s+(TCP|TCP6)\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)/
    )
    if (tcpMatch) {
      entries.push({
        protocol: tcpMatch[1],
        localAddr: normalizeWinAddr(tcpMatch[2]),
        localPort: Number(tcpMatch[3]),
        foreignAddr: normalizeWinAddr(tcpMatch[4]),
        foreignPort: Number(tcpMatch[5]),
        state: normalizeState(tcpMatch[6]),
        pid: Number(tcpMatch[7]),
      })
      continue
    }
    const udpMatch = line.match(
      /\s+(UDP|UDP6)\s+(\S+):(\d+)\s+\S+\s+(\d+)/
    )
    if (udpMatch) {
      entries.push({
        protocol: udpMatch[1],
        localAddr: normalizeWinAddr(udpMatch[2]),
        localPort: Number(udpMatch[3]),
        foreignAddr: '*',
        foreignPort: 0,
        state: 'UNSPEC',
        pid: Number(udpMatch[4]),
      })
    }
  }
  return entries
}

function normalizeWinAddr(addr: string): string {
  // [::] → 0.0.0.0, [::1] → 127.0.0.1, [fe80::...] → 保留
  if (addr === '[::]' || addr === '0.0.0.0') return '0.0.0.0'
  if (addr === '[::1]' || addr === '127.0.0.1') return '127.0.0.1'
  return addr
}

function normalizeState(state: string): string {
  // LISTENING → LISTEN (与跨平台一致)
  if (state === 'LISTENING') return 'LISTEN'
  return state
}

// --- 进程详情 ---

async function readProcessDetails(pid: number): Promise<ProcessInfo> {
  // tasklist 获取基本 + wmic 获取详细
  const snapshot = await getSnapshot()
  const entry = snapshot.get(pid)

  // wmic 获取更多字段
  const wmicOutput = await run('wmic', [
    'process', 'where', `ProcessId=${pid}`,
    'get', 'CommandLine,ExecutablePath,KernelModeTime,UserModeTime,WorkingSetSize',
    '/FORMAT:LIST',
  ])

  let cmdline = ''
  let exe = ''
  let memoryRSS = 0
  for (const line of wmicOutput.split('\n')) {
    const [key, ...valueParts] = line.split('=')
    const value = valueParts.join('=')
    if (key === 'CommandLine') cmdline = value
    if (key === 'ExecutablePath') exe = value
    if (key === 'WorkingSetSize') memoryRSS = Number(value) || 0
  }

  // 用户: tasklist /V /FI "PID eq <pid>"
  const userOutput = await run('tasklist', ['/V', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
  let user = 'unknown'
  const userMatch = userOutput.match(/"([^"]+)",\s*"\d+",\s*"[^"]*",\s*"\d+",\s*"([^"]*)"/)
  if (userMatch) user = userMatch[2] || 'unknown'

  // 服务检测
  const serviceMap = await getServiceMap()
  const serviceName = serviceMap.get(pid)

  return {
    pid,
    ppid: entry?.ppid ?? 0,
    command: (entry?.exeFile || 'unknown').replace('.exe', ''),
    cmdline,
    exe,
    startedAt: new Date(), // Windows 不易获取精确启动时间
    user,
    cpuPercent: 0,
    memoryRSS,
    workingDir: '',
    sockets: [],
    health: 'healthy',
    exeDeleted: false,
    service: serviceName,
  }
}

// --- PlatformOps ---

const win32Ops: PlatformOps = {
  async findPIDs(query: { type: string; value: string; exact?: boolean }): Promise<number[]> {
    const { type, value, exact } = query

    if (type === 'pid') {
      const pid = Number(value)
      if (isNaN(pid) || pid <= 0) return []
      const snapshot = await getSnapshot()
      return snapshot.has(pid) ? [pid] : []
    }

    if (type === 'port') {
      const port = Number(value)
      if (isNaN(port) || port <= 0) return []
      // netstat -ano → 精确端口匹配
      const output = await run('netstat', ['-ano'])
      const entries = parseNetstatAno(output)
      const pids = new Set<number>()
      for (const entry of entries) {
        if (entry.localPort === port && entry.state === 'LISTEN') {
          if (entry.pid > 0) pids.add(entry.pid)
        }
      }
      return [...pids]
    }

    if (type === 'name') {
      const snapshot = await getSnapshot()
      const pids: number[] = []
      const target = exact ? value : value.toLowerCase()
      for (const [pid, entry] of snapshot) {
        const exeName = entry.exeFile.replace('.exe', '')
        const source = exact ? exeName : exeName.toLowerCase()
        if (source.includes(target)) {
          pids.push(pid)
        }
      }
      return pids
    }

    return []
  },

  async readProcess(pid: number): Promise<ProcessInfo> {
    return readProcessDetails(pid)
  },

  async getParentPID(pid: number): Promise<number | null> {
    const snapshot = await getSnapshot()
    const entry = snapshot.get(pid)
    return entry?.ppid && entry.ppid > 0 ? entry.ppid : null
  },

  async getInitPID(): Promise<number> {
    // services.exe PID（系统关键进程，通常为 4 或较小的 PID）
    const snapshot = await getSnapshot()
    for (const [pid, entry] of snapshot) {
      if (entry.exeFile.toLowerCase() === 'services.exe') return pid
    }
    return 4
  },

  async readSockets(pid: number): Promise<SocketInfo[]> {
    const output = await run('netstat', ['-ano'])
    const entries = parseNetstatAno(output)
    const sockets: SocketInfo[] = []
    for (const entry of entries) {
      if (entry.pid === pid) {
        sockets.push({
          port: entry.localPort,
          address: entry.localAddr,
          state: entry.state,
          protocol: entry.protocol.toLowerCase(),
        })
      }
    }
    return sockets
  },

  async listChildren(pid: number): Promise<number[]> {
    const snapshot = await getSnapshot()
    const children: number[] = []
    for (const [childPid, entry] of snapshot) {
      if (entry.ppid === pid) children.push(childPid)
    }
    return children
  },

  async readEnvironment(_pid: number): Promise<string[]> {
    // P3b 功能 (PEB 读取)，MVP 不实现
    return []
  },

  async detectContainer(_pid: number): Promise<string | null> {
    // 检查命令行是否包含 docker 相关
    const wmicOutput = await run('wmic', [
      'process', 'where', `ProcessId=${_pid}`,
      'get', 'CommandLine', '/FORMAT:LIST',
    ])
    if (wmicOutput.includes('docker') || wmicOutput.includes('DockerDesktop')) {
      return 'docker-desktop'
    }
    return null
  },

  async readServiceInfo(pid: number): Promise<{
    name: string; description: string; unitFile?: string;
  } | null> {
    const serviceMap = await getServiceMap()
    const serviceName = serviceMap.get(pid)
    if (!serviceName) return null
    // sc GetDisplayName 获取描述
    const displayName = await run('sc', ['GetDisplayName', serviceName])
    return {
      name: serviceName,
      description: displayName || `Windows service: ${serviceName}`,
    }
  },
}

export default win32Ops
