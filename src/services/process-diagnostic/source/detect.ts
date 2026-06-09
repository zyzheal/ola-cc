import type { ProcessInfo, Source, SourceType } from '../types.js'
import type { PlatformOps } from '../platform/types.js'
import { SHELL_PATTERNS_FOR_DETECT } from '../constants.js'

type SourceDetector = (ancestry: ProcessInfo[], platform: PlatformOps) => Source | null

function isShell(proc: ProcessInfo): boolean {
  const name = proc.exe || proc.command
  return SHELL_PATTERNS_FOR_DETECT.some(p => p.test(name))
}

function detectContainer(ancestry: ProcessInfo[]): Source | null {
  for (const proc of ancestry) {
    if (proc.container) {
      return {
        type: 'container',
        name: proc.container,
        description: `Container: ${proc.container}`,
        details: {},
      }
    }
  }
  return null
}

function detectSSH(ancestry: ProcessInfo[]): Source | null {
  for (const proc of ancestry) {
    if (proc.command === 'sshd' || proc.exe?.includes('sshd')) {
      return {
        type: 'ssh',
        name: 'ssh session',
        description: `SSH session via sshd (pid ${proc.pid})`,
        details: {},
      }
    }
  }
  return null
}

function detectShell(ancestry: ProcessInfo[]): Source | null {
  // 从目标向父反向扫描
  for (let i = ancestry.length - 1; i >= 0; i--) {
    if (isShell(ancestry[i])) {
      return {
        type: 'shell',
        name: ancestry[i].command,
        description: `Shell session: ${ancestry[i].command} (pid ${ancestry[i].pid})`,
        details: {},
      }
    }
  }
  return null
}

// S9: 模块级常量，避免每次调用重建
const SUPERVISOR_COMMANDS = new Set([
  'pm2', 'supervisord', 'runit', 's6-svscan', 'daemontools',
  'launchd', 'init', 'systemd', 'upstart',
])

function detectSupervisor(ancestry: ProcessInfo[]): Source | null {
  for (const proc of ancestry) {
    // I1: PID 1 进程由 detectInit 处理，supervisor 跳过
    if (proc.pid === 1) continue
    const cmd = proc.command.split('/').pop()!  // 取 basename
    if (SUPERVISOR_COMMANDS.has(cmd)) {
      return {
        type: 'supervisor',
        name: proc.command,
        description: `Supervised by ${proc.command} (pid ${proc.pid})`,
        details: {},
      }
    }
  }
  return null
}

function detectCron(ancestry: ProcessInfo[]): Source | null {
  for (const proc of ancestry) {
    if (proc.command === 'cron' || proc.command === 'crond') {
      return {
        type: 'cron',
        name: proc.command,
        description: `Cron job via ${proc.command} (pid ${proc.pid})`,
        details: {},
      }
    }
  }
  return null
}

function detectInit(ancestry: ProcessInfo[]): Source | null {
  if (ancestry.length === 0) return null
  const root = ancestry[0]
  if (root.pid === 1) {
    return {
      type: 'init',
      name: root.command,
      description: `Init process: ${root.command} (pid 1)`,
      details: {},
    }
  }
  return null
}

/**
 * 根据 service 名称格式推断平台服务类型:
 * - *.service → systemd (Linux)
 * - com.xxx.yyy 格式 (≥2 段 . 分隔) → launchd label (macOS)
 * - 其他 → 通用服务
 */
// I2: 更严格的 launchd 匹配 — 要求至少 2 段 . 分隔标识符
const LAUNCHD_LABEL_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+){2,}$/

function detectServiceSource(service: string): Source {
  let serviceType: SourceType = 'unknown'
  if (service.endsWith('.service')) {
    serviceType = 'systemd' as SourceType
  } else if (LAUNCHD_LABEL_RE.test(service)) {
    serviceType = 'launchd' as SourceType
  }

  return {
    type: serviceType,
    name: service,
    description: `Service: ${service}`,
    details: {},
  }
}

// 跨平台检测器
const crossPlatformDetectors: { type: SourceType; detect: SourceDetector }[] = [
  { type: 'container',  detect: detectContainer },
  { type: 'ssh',        detect: detectSSH },
  { type: 'shell',      detect: detectShell },
  { type: 'supervisor', detect: detectSupervisor },
  { type: 'cron',       detect: detectCron },
  { type: 'init',       detect: detectInit },
]

export function detectSource(
  ancestry: ProcessInfo[],
  platform: PlatformOps,
): Source {
  // 1. 跨平台检测器
  for (const { detect } of crossPlatformDetectors) {
    const result = detect(ancestry, platform)
    if (result) return result
  }

  // 2. 平台特定检测: service 字段 (systemd unit / launchd label / Windows service)
  const target = ancestry[ancestry.length - 1]
  if (target?.service) {
    return detectServiceSource(target.service)
  }

  // 3. 无法检测来源
  return {
    type: 'unknown',
    name: 'unknown',
    description: 'Unable to determine process origin',
    details: {},
  }
}
