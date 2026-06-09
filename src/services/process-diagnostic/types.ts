// === 核心类型 ===

export type ProcessHealth = 'healthy' | 'zombie' | 'stopped' | 'high-cpu' | 'high-mem'

export interface SocketInfo {
  port: number
  address: string       // 0.0.0.0, 127.0.0.1, ::
  state: string         // LISTEN, ESTABLISHED, LISTENING(Windows), etc.
  protocol: string      // tcp, udp, TCP6, UDP6
}

export interface ProcessInfo {
  pid: number
  ppid: number
  command: string       // 派生命令名（解决内核截断）
  cmdline: string       // 完整命令行
  exe: string           // 可执行文件路径
  startedAt: Date
  user: string          // macOS/Linux: "root", Windows: "DOMAIN\user"
  cpuPercent: number
  memoryRSS: number     // bytes
  workingDir: string
  gitRepo?: string
  gitBranch?: string
  container?: string
  service?: string      // systemd unit / launchd label / Windows service / rc.d name
  sockets: SocketInfo[]
  health: ProcessHealth
  env?: string[]        // key=value, 仅在 verbose 模式，自动脱敏
  exeDeleted: boolean
}

export interface Source {
  type: SourceType
  name: string          // systemd unit / launchd label / Windows service / rc.d script
  description: string
  unitFile?: string     // unit 文件路径 / plist 路径 / 注册表键 / rc 脚本路径
  details: Record<string, string>
}

export type SourceType =
  | 'systemd' | 'launchd' | 'bsdrc' | 'winservice'
  | 'container' | 'ssh' | 'shell' | 'supervisor' | 'cron' | 'init' | 'unknown'

export interface DiagnosticResult {
  target: { type: string; value: string }
  process: ProcessInfo
  ancestry: ProcessInfo[]   // [init/services.exe, ..., parent, target]
  children: ProcessInfo[]
  source: Source
  warnings: Warning[]
  restartCount: number
  capabilities: DiagnosticCapabilities
}

export interface DiagnosticCapabilities {
  canReadProcess: boolean
  canReadSockets: boolean
  canReadEnvironment: boolean
  canReadExtended: boolean
  canDetectSource: boolean
  limitations: string[]
}

export interface Warning {
  type: WarningType
  message: string
  severity: 'info' | 'warn' | 'critical'
}

export interface WarningRule {
  id: string
  check: (proc: ProcessInfo, ancestry: ProcessInfo[], source: Source) => Warning | null
  platforms?: NodeJS.Platform[]
}

export type WarningType =
  | 'running-as-root' | 'public-listen' | 'zombie' | 'stopped'
  | 'high-cpu' | 'high-memory' | 'unknown-source' | 'long-running'
  | 'deleted-binary' | 'ld-preload' | 'dyld-inject' | 'suspicious-cwd'
  | 'container-no-healthcheck' | 'dangerous-capabilities'
  | 'restart-threshold' | 'service-name-mismatch'
  | 'partial-ancestry'

export interface ContainerMatch {
  id: string
  name: string
  image: string
  command: string
  state: string
  status: string
  ports: string
  labels: Record<string, string>
  composeProject?: string
  composeService?: string
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none'
  runtime: string
}

export interface ContainerRuntime {
  name: string
  available(): boolean | Promise<boolean>
  list(): Promise<ContainerMatch[]>
  hostPID(id: string): Promise<number | null>
}

// === 错误类型 ===

export class DiagnosticError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'DiagnosticError'
  }
}

export class NotFoundError extends DiagnosticError {
  constructor(message: string) {
    super(message, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class AmbiguousError extends DiagnosticError {
  constructor(message: string, public pids: number[]) {
    super(message, 'AMBIGUOUS')
    this.name = 'AmbiguousError'
  }
}

export class TimeoutError extends DiagnosticError {
  constructor(message: string) {
    super(message, 'TIMEOUT')
    this.name = 'TimeoutError'
  }
}
