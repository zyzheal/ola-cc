import type { ProcessInfo, Source, Warning, WarningRule } from '../types.js'
import { countRestarts } from '../process/restart.js'
import {
  ONE_DAY_MS, LONG_RUNNING_DAYS, HIGH_CPU_PERCENT, HIGH_MEMORY_BYTES,
  RESTART_THRESHOLD, SUSPICIOUS_CWDS, MAX_ANCESTRY_DEPTH,
} from '../constants.js'

const rules: WarningRule[] = [
  {
    id: 'running-as-root',
    check: (proc) => {
      const rootUsers = ['root', 'SYSTEM', 'Administrator', 'NT AUTHORITY\\SYSTEM']
      return rootUsers.some(u => proc.user.toLowerCase() === u.toLowerCase())
        ? { type: 'running-as-root', message: `Process is running as ${proc.user}`, severity: 'warn' }
        : null
    },
  },
  {
    id: 'public-listen',
    check: (proc) => proc.sockets.some(s =>
      s.state === 'LISTEN' && (s.address === '0.0.0.0' || s.address === '::')
    ) ? { type: 'public-listen', message: 'Listening on public interface', severity: 'warn' }
      : null,
  },
  {
    id: 'zombie',
    check: (proc) => proc.health === 'zombie'
      ? { type: 'zombie', message: 'Zombie process detected', severity: 'critical' }
      : null,
    platforms: ['darwin', 'linux', 'freebsd'],
  },
  {
    id: 'stopped',
    check: (proc) => proc.health === 'stopped'
      ? { type: 'stopped', message: 'Process is stopped (SIGSTOP)', severity: 'warn' }
      : null,
  },
  {
    id: 'high-cpu',
    check: (proc) => proc.cpuPercent > HIGH_CPU_PERCENT
      ? { type: 'high-cpu', message: `High CPU usage: ${proc.cpuPercent.toFixed(1)}%`, severity: 'warn' }
      : null,
  },
  {
    id: 'high-memory',
    check: (proc) => proc.memoryRSS > HIGH_MEMORY_BYTES
      ? { type: 'high-memory', message: `High memory usage: ${(proc.memoryRSS / 1024 / 1024).toFixed(0)}MB`, severity: 'warn' }
      : null,
  },
  {
    id: 'deleted-binary',
    check: (proc) => proc.exeDeleted
      ? { type: 'deleted-binary', message: 'Executable file has been deleted', severity: 'critical' }
      : null,
  },
  {
    id: 'unknown-source',
    check: (_proc, _ancestry, source) => source.type === 'unknown'
      ? { type: 'unknown-source', message: 'Unable to determine process origin', severity: 'info' }
      : null,
  },
  {
    id: 'long-running',
    check: (proc) => {
      const ageDays = (Date.now() - proc.startedAt.getTime()) / ONE_DAY_MS
      return ageDays > LONG_RUNNING_DAYS
        ? { type: 'long-running', message: `Process has been running for ${Math.floor(ageDays)} days`, severity: 'info' }
        : null
    },
  },
  {
    id: 'suspicious-cwd',
    check: (proc) => SUSPICIOUS_CWDS.includes(proc.workingDir)
      ? { type: 'suspicious-cwd', message: `Suspicious working directory: ${proc.workingDir}`, severity: 'warn' }
      : null,
    platforms: ['darwin', 'linux', 'freebsd'],
  },
  {
    id: 'ld-preload',
    check: (proc) => proc.env?.some(e => e.startsWith('LD_PRELOAD='))
      ? { type: 'ld-preload', message: 'LD_PRELOAD detected — possible library injection', severity: 'warn' }
      : null,
    platforms: ['linux'],
  },
  {
    id: 'dyld-inject',
    check: (proc) => proc.env?.some(e => e.startsWith('DYLD_'))
      ? { type: 'dyld-inject', message: 'DYLD environment variable detected — possible library injection', severity: 'warn' }
      : null,
    platforms: ['darwin'],
  },
  {
    id: 'restart-threshold',
    check: (proc, ancestry) => {
      const restarts = countRestarts(ancestry, proc.command)
      return restarts > RESTART_THRESHOLD
        ? { type: 'restart-threshold', message: `Command "${proc.command}" restarted ${restarts} times`, severity: 'warn' }
        : null
    },
  },
  {
    id: 'partial-ancestry',
    check: (_proc, ancestry) => ancestry.length >= MAX_ANCESTRY_DEPTH
      ? { type: 'partial-ancestry', message: `Ancestry chain truncated at ${MAX_ANCESTRY_DEPTH} depth`, severity: 'info' }
      : null,
  },
]

export function detectWarnings(
  proc: ProcessInfo,
  ancestry: ProcessInfo[],
  source: Source,
  platform: NodeJS.Platform = process.platform,
): Warning[] {
  return rules
    .filter(rule => !rule.platforms || rule.platforms.includes(platform))
    .map(rule => rule.check(proc, ancestry, source))
    .filter((w): w is Warning => w !== null)
}
