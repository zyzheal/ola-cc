import type { PlatformOps } from './types.js'
import type { ProcessInfo, SocketInfo } from '../types.js'
import { redactEnv } from '../redact.js'
import { EXEC_TIMEOUT_MS } from '../constants.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'

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

// --- ps 输出解析 ---

interface PsEntry {
  pid: number; ppid: number; user: string; jid: number;
  state: string; pcpu: number; rss: number; lstart: string; args: string;
}

function parsePsOutput(output: string): PsEntry[] {
  const entries: PsEntry[] = []
  for (const line of output.split('\n')) {
    // ps -axo pid=,ppid=,uid=,jid=,state=,pcpu=,rss=,lstart=,args=
    // lstart 格式包含空格，需要特殊处理
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([A-Z])\s+(\d+\.?\d*)\s+(\d+)\s+(.+?)\s{2,}(.*)$/
    )
    if (match) {
      entries.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        user: match[3],
        jid: Number(match[4]),
        state: match[5],
        pcpu: Number(match[6]),
        rss: Number(match[7]),
        lstart: match[8].trim(),
        args: match[9],
      })
    }
  }
  return entries
}

// --- sockstat 解析 ---

interface SockstatEntry {
  user: string; command: string; pid: number; fd: number;
  proto: string; localAddr: string; localPort: number;
  foreignAddr: string; foreignPort: number;
}

function parseSockstat(output: string): SockstatEntry[] {
  const entries: SockstatEntry[] = []
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 6) continue
    // USER COMMAND PID FD PROTO LOCAL FOREIGN
    const pid = Number(fields[2])
    if (isNaN(pid) || pid <= 0) continue
    const localMatch = fields[5]?.match(/(.+):(\d+|[*])$/)
    const foreignMatch = fields[6]?.match(/(.+):(\d+|[*])$/)
    entries.push({
      user: fields[0],
      command: fields[1],
      pid,
      fd: Number(fields[3]) || 0,
      proto: fields[4] || '',
      localAddr: localMatch ? localMatch[1] : fields[5] || '',
      localPort: localMatch ? (Number(localMatch[2]) || 0) : 0,
      foreignAddr: foreignMatch ? foreignMatch[1] : fields[6] || '',
      foreignPort: foreignMatch ? (Number(foreignMatch[2]) || 0) : 0,
    })
  }
  return entries
}

// --- Jail 检测 ---

async function detectJail(pid: number): Promise<string | null> {
  const jidOutput = await run('ps', ['-p', String(pid), '-o', 'jid='])
  const jid = Number(jidOutput.trim())
  if (isNaN(jid) || jid === 0) return null

  // 获取 jail 名称
  const jlsOutput = await run('jls', ['jid', String(jid), 'name'])
  if (jlsOutput) {
    const name = jlsOutput.split('\n')[0]?.trim()
    if (name && name !== '0') return `jail:${name}`
  }
  return `jail:${jid}`
}

// --- rc.d 服务检测 ---

async function detectRcService(pid: number): Promise<{
  name: string; description: string; unitFile?: string;
} | null> {
  // 检查 /var/run/*.pid 文件
  try {
    const pidFiles = await fs.readdir('/var/run')
    for (const pidFile of pidFiles) {
      if (!pidFile.endsWith('.pid')) continue
      const content = (await fs.readFile(`/var/run/${pidFile}`, 'utf8')).trim()
      if (Number(content) === pid) {
        const name = pidFile.replace('.pid', '')
        return {
          name,
          description: `rc.d service: ${name}`,
        }
      }
    }
  } catch {
    // /var/run not accessible
  }

  // 尝试 procstat 获取命令名，匹配 rc.d 脚本
  const commOutput = await run('ps', ['-p', String(pid), '-o', 'comm='])
  const comm = commOutput.trim()
  if (!comm) return null

  const rcPaths = ['/etc/rc.d', '/usr/local/etc/rc.d']
  for (const rcDir of rcPaths) {
    try {
      const scripts = await fs.readdir(rcDir)
      for (const script of scripts) {
        if (script === comm || script.startsWith(comm)) {
          return {
            name: script,
            description: `rc.d service: ${script}`,
            unitFile: `${rcDir}/${script}`,
          }
        }
      }
    } catch {
      // directory not accessible
    }
  }

  return null
}

// --- 启动时间 ---

async function getBootTime(): Promise<number> {
  const output = await run('sysctl', ['-n', 'kern.boottime'])
  // 格式: { sec = 1234567890, usec = 123456 } Mon Jan  1 00:00:00 2024
  const match = output.match(/sec\s*=\s*(\d+)/)
  return match ? Number(match[1]) * 1000 : Date.now()
}

// --- PlatformOps ---

const freebsdOps: PlatformOps = {
  async findPIDs(query: { type: string; value: string; exact?: boolean }): Promise<number[]> {
    const { type, value, exact } = query

    if (type === 'pid') {
      const pid = Number(value)
      if (isNaN(pid) || pid <= 0) return []
      const output = await run('ps', ['-p', String(pid), '-o', 'pid='])
      return output.trim() ? [pid] : []
    }

    if (type === 'port') {
      const port = Number(value)
      if (isNaN(port) || port <= 0) return []
      // sockstat -4 -6 -P tcp -p <port> -l
      const output = await run('sockstat', ['-4', '-6', '-P', 'tcp', '-p', String(port), '-l'])
      const entries = parseSockstat(output)
      const pids = new Set<number>()
      for (const entry of entries) {
        if (entry.localPort === port && entry.pid > 0) {
          pids.add(entry.pid)
        }
      }
      return [...pids]
    }

    if (type === 'name') {
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
      // fstat <file>
      const output = await run('fstat', [value])
      const pids = new Set<number>()
      for (const line of output.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length >= 3) {
          const pid = Number(fields[2])
          if (!isNaN(pid) && pid > 0) pids.add(pid)
        }
      }
      return [...pids]
    }

    return []
  },

  async readProcess(pid: number): Promise<ProcessInfo> {
    const psOutput = await run('ps', [
      '-p', String(pid),
      '-o', 'pid=,ppid=,uid=,jid=,state=,pcpu=,rss=,lstart=,args=',
    ])
    const entries = parsePsOutput(psOutput)
    const entry = entries[0]

    // procstat 获取 exe 和 cwd
    const procstatOutput = await run('procstat', ['-f', String(pid)])
    let exe = ''
    let cwd = ''
    for (const line of procstatOutput.split('\n')) {
      if (line.includes('text') && line.includes('vnode')) {
        const match = line.match(/vnode\s+(\S+)/)
        if (match) exe = match[1]
      }
      if (line.includes('cwd') && line.includes('vnode')) {
        const match = line.match(/vnode\s+(\S+)/)
        if (match) cwd = match[1]
      }
    }

    // 用户名
    const uid = entry?.user || 'unknown'
    const userOutput = await run('id', ['-nu', uid])
    const user = userOutput || uid

    // Jail 检测
    const container = await detectJail(pid)

    // rc.d 服务检测
    const serviceInfo = await detectRcService(pid)

    // 启动时间
    const bootTime = await getBootTime()

    return {
      pid,
      ppid: entry?.ppid ?? 0,
      command: entry?.args?.split(/\s+/)[0]?.split('/').pop() || 'unknown',
      cmdline: entry?.args || '',
      exe,
      startedAt: new Date(), // 简化处理
      user,
      cpuPercent: entry?.pcpu ?? 0,
      memoryRSS: (entry?.rss ?? 0) * 1024,
      workingDir: cwd,
      sockets: [],
      health: entry?.state === 'Z' ? 'zombie'
        : entry?.state === 'T' ? 'stopped'
        : 'healthy',
      exeDeleted: false,
      container: container ?? undefined,
      service: serviceInfo?.name,
    }
  },

  async getParentPID(pid: number): Promise<number | null> {
    const output = await run('ps', ['-p', String(pid), '-o', 'ppid='])
    const ppid = Number(output.trim())
    return isNaN(ppid) || ppid === 0 ? null : ppid
  },

  async getInitPID(): Promise<number> {
    return 1
  },

  async readSockets(pid: number): Promise<SocketInfo[]> {
    // sockstat -4 -6 → 按 PID 筛选
    const output = await run('sockstat', ['-4', '-6'])
    const entries = parseSockstat(output)
    const sockets: SocketInfo[] = []
    for (const entry of entries) {
      if (entry.pid === pid && entry.localPort > 0) {
        sockets.push({
          port: entry.localPort,
          address: entry.localAddr === '*' ? '0.0.0.0' : entry.localAddr,
          state: 'LISTEN',
          protocol: entry.proto,
        })
      }
    }
    return sockets
  },

  async listChildren(pid: number): Promise<number[]> {
    const output = await run('pgrep', ['-P', String(pid)])
    if (output) {
      return output.split('\n').map(Number).filter(n => !isNaN(n) && n > 0)
    }
    // 回退: ps
    const psOutput = await run('ps', ['-axo', 'pid=,ppid='])
    const children: number[] = []
    for (const line of psOutput.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)/)
      if (match && Number(match[2]) === pid) {
        children.push(Number(match[1]))
      }
    }
    return children
  },

  async readEnvironment(pid: number): Promise<string[]> {
    // procstat -e <pid>
    const output = await run('procstat', ['-e', String(pid)])
    if (output) {
      const env = output.split('\n').filter(Boolean)
      return redactEnv(env)
    }
    return []
  },

  async detectContainer(pid: number): Promise<string | null> {
    return detectJail(pid)
  },

  async readServiceInfo(pid: number): Promise<{
    name: string; description: string; unitFile?: string;
  } | null> {
    return detectRcService(pid)
  },
}

export default freebsdOps
