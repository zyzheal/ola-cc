# Process Diagnostic Tool Design — Inspired by witr

**Date:** 2026-06-02
**Status:** Draft (已合并第二轮三方评审意见)
**Source:** [pranshuparmar/witr](https://github.com/pranshuparmar/witr) architecture analysis
**Platforms:** macOS, Linux, Windows, FreeBSD

---

## 1. Problem Statement

ola-cc 作为 AI 编码助手，经常需要诊断开发环境中的进程/端口/容器问题：
- "端口 3000 被谁占了？"
- "为什么我的 dev server 启动失败？"
- "哪个进程在消耗 CPU？"
- "Docker 容器里的进程状态如何？"

目前只能通过 Bash 工具执行 `ps`/`lsof`/`netstat` 等命令，需要多次调用且手动关联结果。witr 的设计思路可以将这些整合为一个因果链分析工具。

**ProcessDiagnosticTool vs BashTool 的核心差异：**

| 维度 | BashTool | ProcessDiagnosticTool |
|------|----------|----------------------|
| 调用次数 | "端口 3000 被谁占了" 需要 3-5 次调用 (lsof → ps → systemctl) | **1 次调用**获得完整因果链 |
| 因果链分析 | 无法自动关联 PID → 祖先链 → 源检测 | 自动构建 PID→PPID→...→init 因果链 |
| 源检测 | 需要手动执行 systemctl/launchctl/sc 等命令 | 自动检测 systemd/launchd/SSH/容器等来源 |
| 跨平台 | 用户需知道各平台命令差异 | 统一接口，平台差异封装 |
| 警告系统 | 无 | 16+ 安全规则自动检测 |

## 2. witr 核心设计模式提取

### 2.1 因果链模型 (Causal Chain)

witr 的核心抽象：**一切皆因果链**。

```
查询目标 → PID → 祖先链 → 源检测 → 警告 → 结果
```

关键算法：`ResolveAncestry(pid)` — 从目标 PID 沿 PPID 向上追溯到 init/launchd/services.exe，构建完整因果链。使用 `seen` map 防止 PPID 循环。

### 2.2 多目标统一解析 (Unified Target Resolution)

5 种查询类型统一为 `Target{Type, Value}`，每个平台有独立实现：

| Type | macOS | Linux | Windows | FreeBSD |
|------|-------|-------|---------|---------|
| name | `ps -axo` + launchd 服务 | `/proc` 扫描 + systemd 服务 | ToolHelp32 快照 + PEB 读取 | `ps -axww` + rc.d PID 文件 |
| port | `lsof` 三级回退 | `/proc/net/tcp` + fd 扫描 | `netstat -ano` 解析 | `sockstat -4/-6` + `fstat` 回退 |
| pid | 直接使用 | 直接使用 | 直接使用 | 直接使用 |
| file | `lsof -F p` | `/proc/[pid]/fd` readlink | **不支持** | `fstat <file>` |
| container | `docker ps` + inspect | cgroup 检测 + `docker ps` | `docker ps` + inspect | `jls --libxo=json` + `docker ps` |

**关键差异：**
- **Windows** 不依赖 PowerShell/WMI，全部使用 Win32 API (ToolHelp32, PSAPI, SCM)，启动快且不阻塞
- **FreeBSD** 使用 `procstat`/`sockstat`/`fstat`/`jls` 原生工具链
- **Windows** 不支持按文件查找进程（无 POSIX fd 机制）

### 2.3 源检测优先级链 (Source Detection Priority)

witr 使用统一的 `Detect()` 函数，按优先级调用所有检测器。不适用的平台检测器返回 `nil`（通过 Go build tags 实现空函数）：

```
Container → SSH → Shell → Systemd → Launchd → BsdRc → Supervisor → Cron → WindowsService → Init → Unknown
```

| 检测器 | macOS | Linux | Windows | FreeBSD |
|--------|-------|-------|---------|---------|
| Container | cgroup + cmdline | `/proc/[pid]/cgroup` | cmdline 解析 | JID 检测 + cmdline |
| SSH | `sshd` + `SSH_CLIENT` env | `sshd` + `SSH_CLIENT` env | `sshd` + `SSH_CLIENT` env | `sshd` + `SSH_CLIENT` env |
| Shell | bash/zsh/fish + tmux | bash/zsh/fish + tmux | cmd/powershell/pwsh | bash/zsh/fish + tmux |
| Systemd | `nil` (stub) | `/run/systemd/system` + cgroup + `systemctl show` | `nil` (stub) | `nil` (stub) |
| Launchd | `launchctl blame` + plist 解析 | `nil` (stub) | `nil` (stub) | `nil` (stub) |
| BsdRc | `nil` (stub) | `nil` (stub) | `nil` (stub) | `/var/run/*.pid` + `/etc/rc.d/` |
| Supervisor | 30+ 已知命令名匹配 | 同左 | 同左 | 同左 |
| Cron | 祖先链含 cron/crond | 同左 | 同左 | 同左 |
| WindowsService | `nil` (stub) | `nil` (stub) | SCM `EnumServicesStatusExW` | `nil` (stub) |
| Init | PID 1 实际命令名 | 同左 | N/A (NT kernel) | PID 1 实际命令名 |

### 2.4 容器运行时注册表 (Container Runtime Registry)

```go
type ContainerRuntime interface {
    Name() string
    Available() bool
    List() []*ContainerMatch
    HostPID(id string) int
}
```

| 运行时 | 可用性检测 | 列表命令 | PID 获取 | 平台 |
|--------|-----------|---------|---------|------|
| Docker | `binAvailable("docker")` | `docker ps` | `docker inspect` | 全平台 |
| Podman | `binAvailable("podman")` | `podman ps` | `podman inspect` | macOS/Linux/Windows |
| nerdctl | `binAvailable("nerdctl")` | `nerdctl ps` | `nerdctl inspect` | Linux |
| K8s (crictl) | `binAvailable("crictl")` | `crictl ps -o json` | `crictl inspect` | Linux |
| FreeBSD Jail | `binAvailable("jls")` | `jls --libxo=json` | `ps -J <id>` | FreeBSD |

Docker/Podman/nerdctl 共享 `dockerLikeList()` 通用实现（`runtime_dockerlike.go`），使用 Go template 格式化 `docker ps` 输出。

### 2.5 警告系统 (Warning System)

16+ 种安全检查，跨平台统一：

| 警告 | 触发条件 | 平台 |
|------|---------|------|
| running-as-root | User == "root" / "SYSTEM" / "Administrator" | 全平台 |
| public-listen | socket Address 为 0.0.0.0 或 ::，状态 LISTEN | 全平台 |
| zombie | 进程状态 Z | macOS/Linux/FreeBSD |
| stopped | 进程状态 T | macOS/Linux/FreeBSD |
| high-cpu | CPU 时间 >2 小时 | 全平台 |
| high-memory | RSS >1GB | 全平台 |
| unknown-source | 源检测全部失败 | 全平台 |
| long-running | 运行超 90 天 | 全平台 |
| deleted-binary | 可执行文件已删除 | 全平台 |
| ld-preload | `LD_PRELOAD` 环境变量 | Linux |
| dyld-inject | `DYLD_*` 环境变量 | macOS |
| suspicious-cwd | 工作目录为 /, /tmp, /var/tmp | macOS/Linux/FreeBSD |
| dangerous-capabilities | CAP_SYS_ADMIN/PTRACE/NET_RAW 等 | Linux |
| service-name-mismatch | 服务名与进程名无子串关系 | 全平台 |
| restart-threshold | 祖先链中相同命令连续出现 >5 次 | 全平台 |

## 3. TypeScript 方案设计

### 3.1 架构决策

**三层架构：Module + Tool + Skill**

- **模块** (`src/services/process-diagnostic/`)：纯逻辑层，可被任何工具/Skill 调用
- **Tool** (`src/tools/ProcessDiagnosticTool/`)：注册为 ola-cc 内置 Tool，供 LLM Agent 自主调用诊断进程/端口/容器问题
- **Skill** (`~/.ola-cc/skills/process-diagnostic.md`)：Markdown + frontmatter 格式，用户通过 `/proc-diag` 命令触发。Skill 内部通过调用 `process_diagnostic` Tool 完成实际逻辑，提供格式化表格等交互式体验

理由：
1. **Tool 是必要的**：LLM Agent 在遇到 "端口被占"、"进程异常" 等场景时需要自主调用诊断工具，而非等待用户手动触发 Skill。Tool 让 Agent 能在对话流中无缝集成进程诊断能力
2. **Skill 提供交互体验**：用户也可通过 `/proc-diag` 命令直接触发，获得格式化表格、选择器等交互式体验
3. **Module 保持独立**：核心逻辑层可被 Tool 和 Skill 共同调用，独立可测试

### 3.1.1 Build vs Buy 分析

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A: 封装 witr --json** | 零维护成本，Go 生态成熟 | 外部二进制依赖，跨平台分发复杂，无法深度集成 ola-cc 上下文 |
| **B: 纯 TypeScript 重实现** | 与 ola-cc 同语言，可访问上下文，无外部依赖 | 开发工作量大，需覆盖 4 平台 |
| **C: Module + Tool + Skill（推荐）** | 结合 B 的优势 + Agent 自主调用 + 用户交互 | 架构略复杂 |

**结论**：选择方案 C。理由：
1. ola-cc 已有成熟的 Tool 注册体系，集成成本低
2. TypeScript 实现可直接访问当前工作目录、git 信息等 ola-cc 上下文
3. 避免外部二进制分发的跨平台问题（尤其 Windows）
4. Agent 自主诊断能力是核心需求，仅靠 Skill 无法满足

### 3.2 数据结构

```typescript
// === 核心类型 ===

interface ProcessInfo {
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

// 脱敏规则：匹配常见敏感模式并遮蔽值
// 使用后缀匹配 (_TOKEN/_KEY/_SECRET 等) 避免误匹配如 MONKEY_PATCH_ENABLED
// 包含完整敏感词 (如 GITHUB_TOKEN) 直接匹配
const SENSITIVE_PATTERNS = [
  /(?:^|_)TOKEN$/i, /(?:^|_)KEY$/i, /(?:^|_)SECRET$/i,
  /(?:^|_)PASSWORD$/i, /(?:^|_)CREDENTIAL$/i, /(?:^|_)CRED$/i,
  /DATABASE_URL$/i, /REDIS_URL$/i, /MONGO_URI$/i, /(?:^|_)SMTP$/i,
  /GITHUB_TOKEN$/i, /NPM_TOKEN$/i, /AWS_ACCESS_KEY$/i, /API_KEY$/i,
]

function redactEnv(env: string[]): string[] {
  return env.map(e => {
    const [key, ...rest] = e.split('=')
    if (SENSITIVE_PATTERNS.some(p => p.test(key))) {
      return `${key}=<REDACTED>`
    }
    // URL 中的密码: postgres://user:password@host → postgres://user:***@host
    const value = rest.join('=')
    if (/\/.*:.*@/.test(value)) {
      return `${key}=${value.replace(/(:\/\/[^:]*:)[^@]@/, '$1***@')}`
    }
    return e
  })
}

function redactCmdline(cmdline: string): string {
  return cmdline
    .replace(/--password=\S+/g, '--password=<REDACTED>')
    .replace(/--token=\S+/g, '--token=<REDACTED>')
    .replace(/--api-key=\S+/g, '--api-key=<REDACTED>')
}

type ProcessHealth = 'healthy' | 'zombie' | 'stopped' | 'high-cpu' | 'high-mem'

interface SocketInfo {
  port: number
  address: string       // 0.0.0.0, 127.0.0.1, ::
  state: string         // LISTEN, ESTABLISHED, LISTENING(Windows), etc.
  protocol: string      // tcp, udp, TCP6, UDP6
}

interface Source {
  type: SourceType
  name: string          // systemd unit / launchd label / Windows service / rc.d script
  description: string
  unitFile?: string     // unit 文件路径 / plist 路径 / 注册表键 / rc 脚本路径
  details: Record<string, string>
}

type SourceType =
  | 'container' | 'systemd' | 'launchd' | 'bsdrc' | 'supervisor'
  | 'cron' | 'ssh' | 'shell' | 'windows_service' | 'init' | 'unknown'

interface ContainerMatch {
  runtime: string       // docker, podman, k8s, containerd, jail
  id: string
  name: string
  image: string
  command: string
  state: string
  status: string
  health?: string       // healthy, unhealthy, starting
  startedAt?: Date
  ports: string
  composeProject?: string
  composeService?: string
}

interface DiagnosticResult {
  target: { type: string; value: string }
  process: ProcessInfo
  ancestry: ProcessInfo[]   // [init/services.exe, ..., parent, target]
  children: ProcessInfo[]
  source: Source
  warnings: Warning[]
  restartCount: number
  capabilities: DiagnosticCapabilities  // 当前诊断能力（取决于权限）
}

interface DiagnosticCapabilities {
  canReadProcess: boolean      // 能否读取目标进程详情
  canReadSockets: boolean      // 能否读取网络连接
  canReadEnvironment: boolean  // 能否读取环境变量
  canReadExtended: boolean     // 能否读取扩展信息（内存/IO）
  canDetectSource: boolean     // 能否检测进程来源
  limitations: string[]        // 受限原因说明
}

interface Warning {
  type: WarningType
  message: string
  severity: 'info' | 'warn' | 'critical'
}

type WarningType =
  | 'running-as-root' | 'public-listen' | 'zombie' | 'stopped'
  | 'high-cpu' | 'high-memory' | 'unknown-source' | 'long-running'
  | 'deleted-binary' | 'ld-preload' | 'dyld-inject' | 'suspicious-cwd'
  | 'container-no-healthcheck' | 'dangerous-capabilities'
  | 'restart-threshold' | 'service-name-mismatch'
  | 'partial-ancestry'  // 祖先链因超时/深度限制不完整

// === 错误类型 ===
class DiagnosticError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'DiagnosticError'
  }
}

class NotFoundError extends DiagnosticError {
  constructor(message: string) {
    super(message, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

class AmbiguousError extends DiagnosticError {
  constructor(message: string, public pids: number[]) {
    super(message, 'AMBIGUOUS')
    this.name = 'AmbiguousError'
    // 携带所有匹配的 PID，让 Agent 决定如何处理
  }
}

class TimeoutError extends DiagnosticError {
  constructor(message: string) {
    super(message, 'TIMEOUT')
    this.name = 'TimeoutError'
  }
}
```

### 3.3 模块结构

```
src/services/process-diagnostic/
├── index.ts                    # 公共 API 导出
├── types.ts                    # 上述类型定义
├── cache.ts                    # 全局缓存（按类型 TTL）
├── resolve.ts                  # 目标解析路由
├── targets/
│   ├── name.ts                 # 按名称解析 → PID (平台分发)
│   ├── port.ts                 # 按端口解析 → PID (平台分发)
│   └── file.ts                 # 按文件解析 → PID (平台分发)
├── process/
│   ├── read.ts                 # 读取单进程信息 (平台分发)
│   ├── ancestry.ts             # 祖先链构建 (跨平台统一, 含 PID 复用检测)
│   ├── restart.ts              # 重启计数算法
│   ├── children.ts             # 子进程发现 (平台分发)
│   ├── snapshot.ts             # 进程快照 (平台分发)
│   └── command.ts              # 命令名派生 (跨平台统一)
├── source/
│   ├── detect.ts               # 源检测调度器 (跨平台统一)
│   ├── container.ts            # 容器检测 (跨平台, cgroup/cmdline/JID, 嵌套支持)
│   ├── systemd.ts              # systemd 检测 (仅 Linux)
│   ├── launchd.ts              # launchd 检测 (仅 macOS)
│   ├── bsdrc.ts                # BSD rc.d 检测 (仅 FreeBSD)
│   ├── winservice.ts           # Windows 服务检测 (仅 Windows)
│   ├── ssh.ts                  # SSH 会话检测 (跨平台)
│   ├── shell.ts                # Shell/工具检测 (跨平台)
│   └── supervisor.ts           # Supervisor 匹配 (跨平台)
├── container/
│   ├── runtime.ts              # ContainerRuntime 接口 + 注册表
│   ├── docker.ts               # Docker 运行时 (全平台)
│   ├── podman.ts               # Podman 运行时
│   ├── k8s.ts                  # Kubernetes crictl (Linux)
│   └── jail.ts                 # FreeBSD Jail (FreeBSD)
├── warnings.ts                 # 警告系统 (跨平台)
├── analyze.ts                  # 分析管线 (核心编排, 含并行+超时+降级)
└── platform/
    ├── index.ts                # getPlatformOps() 分发
    ├── types.ts                # PlatformOps 接口定义 (可选方法用 ?)
    ├── darwin.ts               # macOS 实现
    ├── linux.ts                # Linux 实现
    ├── windows.ts              # Windows 实现
    └── freebsd.ts              # FreeBSD 实现

src/tools/ProcessDiagnosticTool/
├── index.ts                    # Tool 导出
└── ProcessDiagnosticTool.ts    # Tool 实现 (注册到 src/tools.ts)
```

### 3.4 平台抽象层

```typescript
// platform/types.ts
export interface PlatformOps {
  // 进程读取（必需）
  readProcess(pid: number): Promise<ProcessInfo | null>
  listProcesses(): Promise<ProcessInfo[]>
  listProcessSnapshot(): Promise<{ pid: number; ppid: number; command: string }[]>

  // 目标解析（必需）
  resolveName(name: string, exact: boolean): Promise<number[]>
  resolvePort(port: number): Promise<number[]>

  // 可选方法（平台不支持时返回 undefined，不抛异常）
  resolveFile?(path: string): Promise<number[]>
  readSockets?(pid: number): Promise<SocketInfo[]>
  readEnvironment?(pid: string): Promise<string[]>
  readExtendedInfo?(pid: number): Promise<ExtendedInfo>
  detectPlatformSource?(ancestry: ProcessInfo[]): Source | null
  listChildren?(pid: number): Promise<number[]>
}

interface ExtendedInfo {
  memory: { vms: number; rss: number }
  io: { readBytes: number; writeBytes: number }
  threadCount: number
  fdCount: number
  fdLimit: number
}
```

#### 3.4.1 macOS 实现 (`platform/darwin.ts`)

```typescript
const darwinOps: PlatformOps = {
  async readProcess(pid) {
    // ps -p <pid> -o pid=,ppid=,comm=,lstart=,state=,pcpu=,rss=,args=
    // lsof -a -p <pid> -d cwd,txt -F fn  → 获取 cwd 和 exe
    // launchctl blame <pid>  → 检测 launchd 服务
    // socketsForPID(pid)  → 2秒缓存的 socket 列表
  },

  async resolvePort(port) {
    // 三级回退:
    // 1. lsof -i TCP:<port> -s TCP:LISTEN -F p
    // 2. lsof -i UDP:<port> -F p
    // 3. lsof -i :<port> -F p
    // 4. netstat -anv -p tcp/udp 兜底
  },

  async resolveName(name, exact) {
    // ps -axo pid=,comm=,args= 全进程扫描
    // 排除自身和祖先进程
    // 尝试 launchd 服务标签: name, com.apple.name, org.name, io.name
  },

  async resolveFile(path) {
    // lsof -F p <file>
  },

  async readSockets(pid) {
    // lsof -a -p <pid> -i -P -n → 仅读取目标进程的网络连接（避免全量扫描）
    // 解析输出提取 port, address, state, protocol
  },

  async detectPlatformSource(ancestry) {
    // detectLaunchd: 检查 PID 1 是否为 launchd → launchctl blame → plist 解析
    return detectLaunchd(ancestry)
  },

  async listChildren(pid) {
    // pgrep -P <pid> → 直接获取子进程 PID 列表
    // 回退: ps -axo pid=,ppid= → 过滤 ppid === pid
  },
}
```

#### 3.4.2 Linux 实现 (`platform/linux.ts`)

```typescript
const linuxOps: PlatformOps = {
  async readProcess(pid) {
    // /proc/[pid]/stat → 解析 comm (括号内), ppid, state, utime, stime, rss
    // /proc/[pid]/cmdline → 完整命令行
    // /proc/[pid]/environ → 环境变量 (\x00 分隔)
    // /proc/[pid]/cwd → symlink 获取工作目录
    // /proc/[pid]/cgroup → 容器检测 (docker/podman/kubepods/containerd)
    // /proc/[pid]/exe → symlink 获取可执行路径 + "(deleted)" 检测
    // 启动时间: bootTime() + startTicks / ticksPerSecond()
  },

  async resolvePort(port) {
    // 优先: ss -tlnp sport = :<port> (直接获取监听 PID，O(1) 复杂度)
    // 回退: ss -ulnp sport = :<port> (UDP)
    // 兜底: /proc/net/tcp + /proc/[pid]/fd 遍历（仅在 ss 不可用时）
    // 注意: 过滤 PID 1 (systemd socket activation)
    //
    // Alpine/BusyBox 兼容: BusyBox 的 ss 输出格式可能不同
    // 检测: if (isBusyBox()) 回退到 /proc/net/tcp 解析
  },

  async resolveName(name, exact) {
    // 遍历 /proc 目录，读取每个进程的 comm 和 cmdline
    // 排除自身和祖先
    // 尝试 systemd 服务: systemctl show -p MainPID --value -- foo.service
  },

  async resolveFile(path) {
    // 遍历 /proc/[pid]/fd，readlink 与目标路径比对 (含 symlink 解析)
  },

  async readSockets(pid) {
    // /proc/[pid]/fd → readlink 匹配 socket:[inode] → 关联 /proc/net/tcp 条目
    // 双栈 IPv6: 读取 /proc/sys/net/ipv6/bindv6only，为 0 则合成 0.0.0.0 映射
  },

  async detectPlatformSource(ancestry) {
    // detectSystemd: 验证 /run/systemd/system 存在 → cgroup 提取 unit 名 → systemctl show
    return detectSystemd(ancestry)
  },

  async listChildren(pid) {
    // /proc/[pid]/task/[tid]/children → 直接读取子进程列表（Linux 3.5+）
    // 回退: 遍历 /proc 目录，读取每个进程的 ppid
  },
}
```

#### 3.4.3 Windows 实现 (`platform/windows.ts`)

```typescript
const windowsOps: PlatformOps = {
  async readProcess(pid) {
    // === P3a 基础实现（MVP）===
    // ToolHelp32: CreateToolhelp32Snapshot → Process32First/Next
    //   获取 PID, PPID, ExeFile, ThreadCount
    //   带 1 秒缓存 (snapshotCache)
    // 用户: OpenProcessToken → GetTokenUser → LookupAccount → "DOMAIN\user"
    //   回退到 PROCESS_QUERY_LIMITED_INFORMATION
    // 容器: 命令行解析 detectContainerFromCmdline()
    //
    // === P3b 增强实现（高级功能）===
    // PEB 读取: NtQueryInformationProcess → CommandLine, CWD, Environment
    //   风险: 未文档化 Native API，不同 Windows 版本 PEB 布局可能变化
    //   风险: 需要 PROCESS_QUERY_INFORMATION | PROCESS_VM_READ，普通用户无法读取其他用户进程
    //   风险: Bun FFI 在 Windows 上的 Win32 API 调用成熟度不足
    //   风险: 可能触发 EDR/AV 安全软件告警
    //   降级: 权限不足时只显示 ToolHelp32 基本信息（PID、ExeFile、用户名）
    //   替代: wmic process where ProcessId=X get CommandLine（慢但更可靠）
    // 服务: EnumServicesStatusExW → PID→service name 映射 (2秒缓存)
  },

  async resolvePort(port) {
    // netstat -ano 解析:
    //   TCP: Proto LocalAddr ForeignAddr State PID
    //   UDP: Proto LocalAddr *:* PID
    // 优先 LISTENING 状态的 PID，回退到所有连接
  },

  async resolveName(name, exact) {
    // Pass 1: ToolHelp32 快照 → 匹配 ExeFile basename (快速)
    // Pass 2: 对候选 PID 读取 PEB CommandLine (精确, 仅在 Pass 1 无结果时)
    // 排除自身和祖先
  },

  // resolveFile 不实现（Windows 无 POSIX fd 机制），接口定义为可选

  async readSockets(pid) {
    // netstat -ano → 按 PID 筛选所有 TCP/UDP 连接
  },

  async readEnvironment(pid) {
    // PEB 读取: NtQueryInformationProcess → ProcessParameters → Environment
  },

  async readExtendedInfo(pid) {
    // GetProcessMemoryInfo (psapi.dll) → WorkingSetSize, PrivateUsage
    // GetProcessIoCounters (kernel32.dll) → Read/Write Transfer Count
    // GetProcessHandleCount (kernel32.dll) → handle count (替代 FD count)
    // ToolHelp32 → ThreadCount
  },

  async detectPlatformSource(ancestry) {
    // detectWindowsService:
    //   1. 祖先链中查找 p.service != "" → SCM 服务名
    //   2. 祖先链含 services.exe → Service Control Manager
    //   3. 父进程为 services.exe → 从子进程命令名推断服务
    //   描述: sc GetDisplayName <service>
    //   注册表键: HKLM\SYSTEM\CurrentControlSet\Services\<name>
    return detectWindowsService(ancestry)
  },

  async listChildren(pid) {
    // ToolHelp32 快照 → 过滤 th32ParentProcessID === pid
    // 复用已有的 snapshotCache
  },
}
```

**Windows 特殊处理：**
- 不依赖 PowerShell/WMI，全部 Win32 API → 快速启动，不阻塞
- ToolHelp32 快照带 1 秒缓存，避免重复系统调用
- 服务映射带 2 秒缓存（`serviceMapForPIDs`），祖先链遍历只付一次 SCM 扫描代价
- svchost.exe (共享进程宿主) 使用 "first writer wins" 策略保持服务名稳定
- 文件锁分析不支持（Windows 使用 sharing modes，无 POSIX 锁）
- `LISTENING` 状态需标准化为 `LISTEN`（与跨平台一致）

#### 3.4.4 FreeBSD 实现 (`platform/freebsd.ts`)

```typescript
const freebsdOps: PlatformOps = {
  async readProcess(pid) {
    // ps -p <pid> -o pid=,ppid=,uid=,jid=,state=,pcpu=,rss=,lstart=,args=
    //   额外字段: jid (Jail ID), uid
    // procstat -f <pid> → 获取 cwd 和 text (可执行文件路径)
    // procstat -e <pid> → 获取环境变量
    //   LC_ALL=C 确保 lstart 英文格式
    // 启动时间: sysctl -n kern.boottime → 解析 "sec = N" 格式
    // 容器: JID != 0 → resolveJailName(jid) + detectContainerFromCmdline()
    // 服务: detectRcService(pid) → /var/run/*.pid 文件匹配
  },

  async resolvePort(port) {
    // sockstat -4/-6 -P tcp/udp -p <port> (优先)
    //   解析: USER COMMAND PID FD PROTO LOCAL FOREIGN
    //   多地址监听时保留最小 PID (master/worker 模式)
    //   多不同地址时显示歧义提示
    // netstat -an -p tcp/udp 回退
    // fstat 兜底 (解析 tcp/udp 行中的端口号)
  },

  async resolveName(name, exact) {
    // ps -axww -o pid,comm,args 全进程扫描
    // 排除自身和祖先
    // rc.d 服务: /var/run/<name>.pid + service <name> status
    //   输入校验: ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ 防注入
  },

  async resolveFile(path) {
    // fstat <file> → 解析 PID 列表
  },

  async readSockets(pid) {
    // sockstat -4/-6 → 全端口列表 (2秒缓存) → 按 PID 筛选
    //   parseSockstatAddr: 处理 *:port, [::]:port, 127.0.0.1:port 格式
  },

  async readEnvironment(pid) {
    // procstat -e <pid> → 解析 PID COMM ENVVAR=VALUE 格式
  },

  async readExtendedInfo(pid) {
    // fstat -p <pid> → open files count
    // procstat -l <pid> → openfiles limit
    // sysctl -n kern.maxfilesperproc → 系统级回退
    // fstat 输出启发式: .lock/.pid/lock 路径 → locked files
  },

  async detectPlatformSource(ancestry) {
    // detectBsdRc:
    //   1. 祖先链中 p.service != "" → /etc/rc.d/ 或 /usr/local/etc/rc.d/ 脚本
    //      读取 "# description:" 头注释
    //   2. PPID == 1 且无 shell → 从命令名推断 rc 服务
    return detectBsdRc(ancestry)
  },

  async listChildren(pid) {
    // ps -o pid= -P <pid> → 获取子进程 PID 列表
    // 回退: ps -axo pid=,ppid= → 过滤 ppid === pid
  },
}
```

**FreeBSD 特殊处理：**
- 使用 `procstat` 替代 `/proc` 文件系统（FreeBSD 不默认挂载 procfs）
- `sockstat` 替代 `lsof`/`netstat`，输出更结构化
- Jail 容器通过 `jls --libxo=json` 获取 JSON 输出（现代 FreeBSD），回退到 `jls -h` 文本解析
- 端口解析有多地址歧义处理（当同一端口绑定了不同地址时提示用户）
- `LC_ALL=C` 确保 `ps lstart` 输出英文格式

#### 3.4.5 平台分发

```typescript
// platform/index.ts
export function getPlatformOps(): PlatformOps {
  switch (process.platform) {
    case 'darwin':  return darwinOps
    case 'linux':   return linuxOps
    case 'win32':   return windowsOps
    case 'freebsd': return freebsdOps
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}
```

### 3.5 分析管线 (Analysis Pipeline)

```typescript
// analyze.ts
const EXEC_TIMEOUT_MS = 5000  // 子进程超时 5 秒

export async function analyze(config: {
  target: { type: string; value: string }
  verbose?: boolean
  exact?: boolean
  cache?: DiagnosticCache  // 可选缓存实例，由 Tool 层传入
}): Promise<DiagnosticResult> {
  const platform = getPlatformOps()
  const cache = config.cache  // 平台实现可通过闭包访问缓存

  // Step 1: 解析目标 → PID 列表
  const pids = await withTimeout(
    resolveTarget(config.target, platform, config.exact),
    EXEC_TIMEOUT_MS,
    `resolveTarget(${config.target.type}:${config.target.value})`
  )
  if (pids.length === 0) {
    throw new NotFoundError(`No process found for ${config.target.type}:${config.target.value}`)
  }
  if (pids.length > 1) {
    throw new AmbiguousError(`Multiple matches found`, pids)
  }

  const pid = pids[0]

  // Step 2+3: 并行执行 — 祖先链 + socket 读取
  const [ancestry, sockets] = await Promise.all([
    withTimeout(resolveAncestry(pid, platform), EXEC_TIMEOUT_MS, 'resolveAncestry'),
    platform.readSockets
      ? withTimeout(platform.readSockets(pid), EXEC_TIMEOUT_MS, 'readSockets').catch(() => [])
      : Promise.resolve([]),
  ])

  // Step 4: 源检测 (跨平台统一 + 平台特定)
  const source = detectSource(ancestry, platform)

  // Step 5: 读取目标进程详情（合并 socket 数据）
  const process = ancestry[ancestry.length - 1]
  if (sockets.length > 0 && process.sockets.length === 0) {
    process.sockets = sockets
  }

  // Step 6: 子进程发现（可选）
  const children = config.verbose && platform.listChildren
    ? await withTimeout(platform.listChildren(pid), EXEC_TIMEOUT_MS, 'listChildren').catch(() => [])
    : []

  // Step 7: 警告检测
  const warnings = detectWarnings(process, ancestry, source)

  // Step 8: 重启计数
  const restartCount = countRestarts(ancestry, process.command)

  // Step 9: 诊断能力评估
  const capabilities = assessCapabilities(platform, process, config.verbose)

  return { target: config.target, process, ancestry, children, source, warnings, restartCount, capabilities }
}

function assessCapabilities(
  platform: PlatformOps,
  process: ProcessInfo,
  verbose?: boolean,
): DiagnosticCapabilities {
  const limitations: string[] = []
  const canReadProcess = !!process
  const canReadSockets = process.sockets.length > 0
  const canReadEnvironment = verbose && (process.env?.length ?? 0) > 0
  const canReadExtended = !!(process.memoryRSS > 0 || process.cpuPercent !== undefined)
  const canDetectSource = true  // 总是尝试检测，最差返回 unknown

  if (!verbose) limitations.push('verbose=false: environment and children not loaded')
  if (!platform.readSockets) limitations.push('platform does not support socket reading')
  if (process.sockets.length === 0 && platform.readSockets) limitations.push('no sockets found or permission denied')

  return { canReadProcess, canReadSockets, canReadEnvironment, canReadExtended, canDetectSource, limitations }
}

// 超时包装器
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}
```

#### 3.5.1 降级策略

当某个步骤超时或失败时，管线应降级而非中断：

| 步骤 | 失败行为 | 降级输出 |
|------|---------|---------|
| resolveTarget | 抛出 NotFoundError | 终止（无法继续） |
| resolveAncestry | 返回已收集的部分链 | warnings 添加 `partial-ancestry` |
| readSockets | 返回空数组 | `sockets: []` |
| detectSource | 返回 `unknown` | 正常输出 |
| listChildren | 返回空数组 | `children: []` |
| readExtendedInfo | 返回默认值 | `extended: null` |
| readEnvironment | 返回空数组 | `env: []` |

### 3.6 祖先链构建

跨平台统一算法（移植自 witr + 评审改进）：

```typescript
// process/ancestry.ts
const MAX_ANCESTRY_DEPTH = 64  // 防止异常链导致无限遍历

export async function resolveAncestry(
  pid: number,
  platform: PlatformOps
): Promise<ProcessInfo[]> {
  const chain: ProcessInfo[] = []
  const seen = new Set<number>()
  let current = pid
  let depth = 0

  while (current > 0) {
    // 循环保护
    if (seen.has(current)) break
    seen.add(current)

    // 深度保护
    if (depth++ >= MAX_ANCESTRY_DEPTH) break

    const proc = await platform.readProcess(current)
    if (!proc) break

    // PID 复用检测：父进程的启动时间必须早于子进程
    // 使用容差阈值而非严格比较，因为:
    // - macOS/FreeBSD ps lstart 精度仅到秒
    // - Linux /proc/[pid]/stat starttime 精度 10ms (HZ=100)
    // - Docker entrypoint、systemd 批量启动可能同秒创建多进程
    const PID_REUSE_THRESHOLD_MS = 5000  // 5秒容差
    if (chain.length > 0) {
      const child = chain[chain.length - 1]
      const diff = proc.startedAt.getTime() - child.startedAt.getTime()
      if (diff > PID_REUSE_THRESHOLD_MS) {
        // 父进程启动时间比子进程晚超过阈值，判定为 PID 复用
        break
      }
      // 注意: Linux 上应优先使用 /proc/uptime 单调时钟推算，避免 NTP 回拨影响
    }

    chain.push(proc)

    // 终止条件:
    // - macOS/Linux/FreeBSD: PID 1 (init/launchd)
    // - Windows: PPID 0 (System Idle Process) 或 PID 4 (System)
    if (proc.ppid === 0 || proc.pid === 1) break
    current = proc.ppid
  }

  // 反转: [root, ..., parent, target]
  return chain.reverse()
}
```

#### 3.6.1 重启计数算法

```typescript
// process/restart.ts
// SHELL_PATTERNS: 用于 countRestarts() 中跳过 shell 中介进程
// 注意区分: isShell() 用于重启计数跳过 shell (此处),
//            detectShell() 用于源检测 (3.7 节) — 两者职责不同。
//            tmux/screen 不在此列表，因为它们是终端复用器而非 shell，
//            重启计数不应跳过它们，但源检测会识别它们为 shell 来源。
const SHELL_PATTERNS = [
  /\/bash$/, /\/zsh$/, /\/fish$/, /\/sh$/, /\/dash$/, /\/ksh$/,
  /\/csh$/, /\/tcsh$/, /\/ash$/, /\/busybox$/,
  /\\cmd\.exe$/i, /\\powershell\.exe$/i, /\\pwsh\.exe$/i, /\\explorer\.exe$/i,
]

function isShell(proc: ProcessInfo): boolean {
  const name = proc.exe || proc.command
  return SHELL_PATTERNS.some(p => p.test(name))
}

function countRestarts(ancestry: ProcessInfo[], targetCommand: string): number {
  // 从目标进程向上扫描，统计连续相同命令名的进程数
  // 排除 shell/terminal 等中介进程（通过 exe 路径匹配，非硬编码名称）
  let count = 0

  for (let i = ancestry.length - 1; i >= 0; i--) {
    if (isShell(ancestry[i])) continue  // 跳过 shell
    const cmd = deriveCommand(ancestry[i].command, ancestry[i].cmdline, ancestry[i].exe)
    if (cmd === targetCommand) count++
    else break  // 遇到不同命令则停止
  }

  // count 包含目标进程自身，重启次数 = count - 1
  return Math.max(0, count - 1)
}
```

#### 3.6.2 PID 1 Socket Activation 处理

当 Linux 端口解析返回 PID 1 (systemd) 时，可能是 socket activation 场景：

```typescript
// 遇到 PID 1 时的处理策略
async function handlePid1SocketActivation(port: number, platform: PlatformOps): Promise<number[]> {
  // 1. 检查 systemd 是否可用: systemctl --version
  // 2. 精确解析 systemctl list-sockets --no-legend 输出（非 grep，避免 :80 匹配 :8080）
  //    提取 Listen 字段的端口号做数值比较
  // 3. 如果找到 socket unit，查找对应的 service unit
  // 4. 处理 Accept=true 场景（一个 socket 触发多个 service）
  // 5. 返回 service unit 的 MainPID（如果有活跃实例）
  // 6. 如果无活跃实例，返回 PID 1 并标记为 "socket-activated"
  //
  // 非 systemd 系统回退: upstart/SysV init/OpenRC 不支持 socket activation
  // 此时返回 PID 1 并标记为 "unknown-source"
}
```

### 3.7 源检测器

```typescript
// source/detect.ts
type SourceDetector = (ancestry: ProcessInfo[]) => Source | null

// 跨平台检测器 (所有平台共享)
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
  platform: PlatformOps
): Source {
  // 1. 跨平台检测器
  for (const { detect } of crossPlatformDetectors) {
    const result = detect(ancestry)
    if (result) return result
  }

  // 2. 平台特定检测器 (systemd/launchd/bsdrc/windows_service)
  const platformResult = platform.detectPlatformSource(ancestry)
  if (platformResult) return platformResult

  return { type: 'unknown', name: 'unknown', description: 'Unable to determine source', details: {} }
}
```

每个检测器的关键逻辑：

- **container**: Linux 检查 `/proc/[pid]/cgroup`；macOS/Windows/FreeBSD 从命令行检测；FreeBSD 检查 JID。支持嵌套容器检测（Docker-in-Docker、Podman-in-Podman），**最大递归深度 3 层**，含循环检测（防止两个容器互相挂载导致无限递归）
- **ssh**: 祖先链中找 sshd 进程，从 `SSH_CLIENT`/`SSH_CONNECTION` 环境变量提取远程 IP
- **shell**: 从目标向父反向扫描。macOS/Linux/FreeBSD: bash/zsh/fish/sh + tmux/screen；Windows: cmd/powershell/pwsh/explorer
- **systemd**: 验证 `/run/systemd/system` 存在 + cgroup 提取 unit 名 + `systemctl show` 获取描述/定时器
- **launchd**: `launchctl blame <pid>` 获取服务标签 + 5 路径 plist 搜索 + XML 解析
- **bsdrc**: `/var/run/*.pid` 匹配 + `/etc/rc.d/` 和 `/usr/local/etc/rc.d/` 脚本查找 + `# description:` 头注释
- **winservice**: SCM `EnumServicesStatusExW` 枚举 → PID→服务名映射 + `sc GetDisplayName` 获取描述
- **supervisor**: 30+ 已知 supervisor 命令名匹配 (pm2, supervisord, runit, etc.)
- **cron**: 检查祖先链中是否有 cron/crond 进程
- **init**: 祖先链根为 PID 1 且无 shell，使用 PID 1 实际命令名

#### 嵌套容器检测（含循环保护）

```typescript
// source/containerDetect.ts
const MAX_CONTAINER_DEPTH = 3

interface ContainerChain {
  container: ContainerMatch
  depth: number
  parent?: ContainerChain  // 嵌套容器的父容器
}

/**
 * 从进程信息检测容器链，支持嵌套容器（Docker-in-Docker 等）
 * 使用 seen Set 防止循环引用（两个容器互相挂载导致无限递归）
 */
export function detectContainerChain(
  proc: ProcessInfo,
  platform: PlatformOps,
): ContainerChain | null {
  return detectContainerChainInner(proc, platform, new Set<string>(), 0)
}

function detectContainerChainInner(
  proc: ProcessInfo,
  platform: PlatformOps,
  seen: Set<string>,       // 已访问容器 ID 集合，用于循环检测
  depth: number,
): ContainerChain | null {
  if (depth >= MAX_CONTAINER_DEPTH) return null

  const containerInfo = detectContainerInfo(proc, platform)
  if (!containerInfo) return null

  // 循环检测：如果该容器 ID 已经访问过，终止递归
  if (seen.has(containerInfo.id)) {
    return { container: containerInfo, depth }  // 返回当前层，不继续递归
  }
  seen.add(containerInfo.id)

  // 尝试检测父容器（嵌套场景）
  // 通过检查容器内的 cgroup 或进程树来发现外层容器
  const parentContainer = detectParentContainer(proc, platform, seen, depth + 1)

  return {
    container: containerInfo,
    depth,
    parent: parentContainer ?? undefined,
  }
}

function detectContainerInfo(proc: ProcessInfo, platform: PlatformOps): ContainerMatch | null {
  // Linux: /proc/[pid]/cgroup → docker/podman/kubepods/containerd
  // macOS/Windows/FreeBSD: 命令行解析 detectContainerFromCmdline()
  // FreeBSD: JID != 0 → resolveJailName(jid)
  // ... 平台分发逻辑
  return null
}

function detectParentContainer(
  proc: ProcessInfo,
  platform: PlatformOps,
  seen: Set<string>,
  depth: number,
): ContainerChain | null {
  if (depth >= MAX_CONTAINER_DEPTH) return null
  // 检查父进程是否也在容器中（Docker-in-Docker 场景）
  // 检查 /proc/[ppid]/cgroup 或父进程的 cgroup 信息
  return null
}
```

### 3.8 容器运行时注册表

```typescript
// container/runtime.ts
interface ContainerRuntime {
  name: string
  available(): boolean
  list(): Promise<ContainerMatch[]>
  hostPID(id: string): Promise<number | null>
}

const runtimes: ContainerRuntime[] = []

export function registerRuntime(rt: ContainerRuntime) {
  runtimes.push(rt)
}

export async function resolveContainer(query: string, exact: boolean): Promise<ContainerMatch | null> {
  for (const rt of runtimes) {
    if (!rt.available()) continue
    const containers = await rt.list()
    for (const c of containers) {
      if (matchContainer(c, query, exact)) return c
    }
  }
  return null
}

// Docker-like 运行时共享实现 (移植自 runtime_dockerlike.go)
async function dockerLikeList(bin: string, runtime: string): Promise<ContainerMatch[]> {
  // 使用 JSON 输出格式，避免分隔符歧义问题
  // <bin> ps --format '{{json .}}' --no-trunc
  // JSON 解析每行输出，提取 ID, Names, Image, Command, State, Status, CreatedAt, Ports, Labels
  // Compose 标签: com.docker.compose.project, com.docker.compose.service
  // healthFromStatus(): 从状态字符串提取 healthy/unhealthy/starting
  //
  // 注意: 不使用 | 分隔符，因为 Labels/Command/Mounts 可能包含 | 字符
}

// container/jail.ts (FreeBSD)
class JailRuntime implements ContainerRuntime {
  name = 'jail'
  available() { return isCommandAvailable('jls') }

  async list() {
    // 优先: jls --libxo=json → JSON 解析 (现代 FreeBSD)
    // 回退: jls -h → 文本解析
    // 字段: jid, name, host.hostname, path, dying
  }

  async hostPID(id: string) {
    // ps -J <id> -o pid= → 获取 jail 内首个 PID
  }
}

// Rootless 运行时特权降级 (Podman/nerdctl)
// 当 witr 在 sudo 下运行时，降级回原始用户身份:
//   HOME, USER, XDG_RUNTIME_DIR 环境变量重置
//   SysProcAttr.Credential 设置原始 UID/GID
```

### 3.9 警告系统

```typescript
// warnings.ts
interface WarningRule {
  id: string
  check: (proc: ProcessInfo, ancestry: ProcessInfo[], source: Source) => Warning | null
  platforms?: NodeJS.Platform[]  // 不指定则全平台
}

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
    id: 'ld-preload',
    check: (proc) => proc.env?.some(e => e.startsWith('LD_PRELOAD='))
      ? { type: 'ld-preload', message: 'LD_PRELOAD detected', severity: 'critical' }
      : null,
    platforms: ['linux'],
  },
  {
    id: 'dyld-inject',
    check: (proc) => proc.env?.some(e => e.startsWith('DYLD_'))
      ? { type: 'dyld-inject', message: 'DYLD_* injection detected', severity: 'critical' }
      : null,
    platforms: ['darwin'],
  },
  {
    id: 'deleted-binary',
    check: (proc) => proc.exeDeleted
      ? { type: 'deleted-binary', message: 'Running from deleted binary', severity: 'warn' }
      : null,
  },
  {
    id: 'long-running',
    check: (proc) => Date.now() - proc.startedAt.getTime() > 90 * 24 * 60 * 60 * 1000
      ? { type: 'long-running', message: 'Running for over 90 days', severity: 'info' }
      : null,
  },
  // ... 更多规则
]

export function detectWarnings(proc: ProcessInfo, ancestry: ProcessInfo[], source: Source): Warning[] {
  const platform = process.platform
  return rules
    .filter(rule => !rule.platforms || rule.platforms.includes(platform))
    .map(rule => rule.check(proc, ancestry, source))
    .filter((w): w is Warning => w !== null)
}
```

### 3.10 输出格式

`analyze()` 返回原始 `DiagnosticResult` 对象，`formatDiagnosticResult()` 同时支持两种输出格式：

```typescript
// format.ts
export function formatDiagnosticResult(
  result: DiagnosticResult,
  format: 'json' | 'text' = 'json',
): string {
  if (format === 'json') {
    return JSON.stringify({
      target: result.target,
      process: {
        pid: result.process.pid,
        command: result.process.command,
        user: result.process.user,
        health: result.process.health,
        startedAt: result.process.startedAt,
        workingDir: result.process.workingDir,
        gitRepo: result.process.gitRepo,
        gitBranch: result.process.gitBranch,
      },
      ancestry: result.ancestry.map(p => ({ pid: p.pid, command: p.command })),
      children: result.children.map(p => ({ pid: p.pid, command: p.command, health: p.health })),
      source: result.source,
      warnings: result.warnings,
      restartCount: result.restartCount,
      capabilities: result.capabilities,
    }, null, 2)
  }

  // text 格式：人类可读的结构化文本
  const lines: string[] = []
  lines.push(`=== Process Diagnostic ===`)
  lines.push(`Target: ${result.target.value} (${result.target.type})`)
  lines.push('')
  lines.push(`Process: ${result.process.command} (pid ${result.process.pid})`)
  lines.push(`User: ${result.process.user}`)
  lines.push(`Command: ${result.process.cmdline}`)
  lines.push(`Health: ${result.process.health}`)
  if (result.process.workingDir) lines.push(`Working Dir: ${result.process.workingDir}`)
  if (result.process.gitRepo) lines.push(`Git: ${result.process.gitRepo} (${result.process.gitBranch})`)
  lines.push('')
  lines.push(`Why It Exists:`)
  lines.push(`  ${result.ancestry.map(p => `${p.command} (${p.pid})`).join(' → ')}`)
  lines.push('')
  lines.push(`Source: ${result.source.name} (${result.source.description})`)
  if (result.process.sockets.length > 0) {
    lines.push(`Listening:`)
    for (const s of result.process.sockets) {
      lines.push(`  ${s.address}:${s.port} (${s.protocol}, ${s.state})`)
    }
  }
  if (result.warnings.length > 0) {
    lines.push('Warnings:')
    for (const w of result.warnings) {
      lines.push(`  ⚠ ${w.message}`)
    }
  }
  if (result.restartCount > 0) lines.push(`Restart Count: ${result.restartCount}`)
  return lines.join('\n')
}
```

**格式选择策略：**
- Tool 调用：默认返回 JSON 结构化数据（便于 Agent 后续工具链处理），`mapToolResultToToolResultBlockParam` 中序列化
- Skill 调用：返回人类可读的格式化文本
- `output` 参数可选 `'json' | 'text'`，默认 `'json'`

**JSON 输出示例：**
```json
{
  "target": { "type": "port", "value": "3000" },
  "process": { "pid": 14233, "command": "node", "user": "heal", "health": "healthy" },
  "ancestry": [
    { "pid": 1, "command": "systemd" },
    { "pid": 892, "command": "sshd" },
    { "pid": 14233, "command": "node" }
  ],
  "source": { "type": "ssh", "name": "ssh session", "description": "from 192.168.1.5" },
  "warnings": [{ "type": "public-listen", "message": "Listening on public interface", "severity": "warn" }],
  "restartCount": 0,
  "capabilities": { "canReadEnvironment": true, "limitations": [] }
}
```

**文本输出示例（LLM 友好）：**

```
=== Process Diagnostic ===
Target: :3000 (port)

Process: node (pid 14233)
User: heal
Command: node server.js
Started: 2 hours ago
Health: healthy

Why It Exists:
  systemd (pid 1) → sshd (pid 892) → bash (pid 14200) → node (pid 14233)

Source: ssh session (from 192.168.1.5, terminal /dev/ttys001)

Listening: 0.0.0.0:3000 (tcp, LISTEN)
Working Dir: /Users/heal/my-project
Git: my-project (main)

Warnings:
  ⚠ Listening on public interface (0.0.0.0)
```

Windows 示例：
```
=== Process Diagnostic ===
Target: :8080 (port)

Process: nginx.exe (pid 4520)
User: BUILTIN\nginx
Command: nginx -g "daemon off;"
Started: 3 days ago
Health: healthy

Why It Exists:
  System (pid 4) → services.exe (pid 680) → nginx.exe (pid 4520)

Source: Windows Service "nginx" (HKLM\SYSTEM\CurrentControlSet\Services\nginx)

Listening: 0.0.0.0:8080 (tcp, LISTEN)
Working Dir: C:\nginx

Warnings:
  ⚠ Listening on public interface (0.0.0.0)
```

### 3.11 全局缓存策略

避免重复系统调用，按数据类型设置不同 TTL：

```typescript
// cache.ts
// 缓存绑定到 ToolUseContext 生命周期，session 结束时自动清理
// 使用 LRU 策略限制缓存大小，避免内存增长

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

export class DiagnosticCache {
  private cache = new Map<string, CacheEntry<any>>()
  private maxSize = 256  // LRU 最大条目数

  // TTL 配置（毫秒）
  private static TTL = {
    process:    10_000,   // 进程信息 10s
    socket:      2_000,   // socket 列表 2s（变化频繁，连续查询时延长到 5s）
    service:    30_000,   // 服务映射 30s（已知服务），未知服务 5s
    container:   5_000,   // 容器列表 5s
    snapshot:    1_000,   // 进程快照 1s（Windows ToolHelp32）
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }
    // LRU: 刷新访问顺序 — 先删后插，使该条目移到 Map 尾部
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.data
  }

  set<T>(key: string, data: T, type: keyof typeof DiagnosticCache.TTL): void {
    // LRU 淘汰：超过 maxSize 时删除最久未访问的条目（Map 头部）
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + DiagnosticCache.TTL[type],
    })
  }

  clear(): void {
    this.cache.clear()
  }
}

// 全局缓存实例管理：通过 ToolUseContext 绑定到 session 生命周期
const cacheInstances = new WeakMap<object, DiagnosticCache>()

export function getOrCreateCache(context: { abortController: AbortController }): DiagnosticCache {
  let cache = cacheInstances.get(context.abortController)
  if (!cache) {
    cache = new DiagnosticCache()
    cacheInstances.set(context.abortController, cache)
    // session 结束时清理缓存
    context.abortController.signal.addEventListener('abort', () => cache!.clear(), { once: true })
  }
  return cache
}
```

### 3.12 ProcessDiagnosticTool 包装器

注册为 ola-cc 内置 Tool，供 LLM Agent 自主调用：

```typescript
// src/tools/ProcessDiagnosticTool/ProcessDiagnosticTool.ts
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'  // ola-cc 标准 Tool 构建模式
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    target_type: z.enum(['port', 'name', 'pid', 'file', 'container'])
      .describe('Query type'),
    target_value: z.string()
      .describe('Query value (port number, process name, PID, file path, container name/ID)'),
    verbose: z.boolean().optional()
      .describe('Include children and extended info. WARNING: may expose sensitive env vars (auto-redacted)'),
    exact: z.boolean().optional()
      .describe('Exact match for name queries'),
    output: z.enum(['json', 'text']).optional()
      .describe('Output format, default json'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export const ProcessDiagnosticTool = buildTool({
  name: 'process_diagnostic',
  searchHint: 'diagnose port process container socket ancestry lsof netstat ss',
  maxResultSizeChars: 32_768,          // 结果最大 32KB (含祖先链+容器信息)

  async description() {
    return [
      'Diagnose who is using a port, what process is running, where it came from (ancestry chain),',
      'and container status. Use when the user asks about port conflicts, zombie processes,',
      'high CPU usage, container health, or "what is running on port X".',
    ].join(' ')
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  isReadOnly(_input: Input) {
    return true              // 只读操作，不修改系统状态
  },
  isConcurrencySafe(_input: Input) {
    return true              // 可并发调用
  },

  // 权限检查: 基本查询自动授权，verbose 需要确认
  async checkPermissions(input: Input) {
    if (input.verbose) {
      return {
        behavior: 'ask' as const,
        message: 'verbose 模式会读取进程环境变量（自动脱敏），是否继续？',
      }
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },

  // Tool 执行提示
  async prompt() {
    return [
      'This tool diagnoses process/port/container issues by building a causal chain (PID → ancestry → source).',
      'It returns structured JSON with process info, ancestry chain, source detection, and warnings.',
      'For port queries, it identifies the listening process and traces back to its origin (systemd, SSH, container, etc.).',
    ].join('\n')
  },

  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: content.success
        ? JSON.stringify(content.data, null, 2)
        : `Error: ${content.error}`,
    }
  },

  async call(input: Input, context): Promise<{ data: Output }> {
    const cache = getOrCreateCache(context)
    const result = await analyze({
      target: { type: input.target_type, value: input.target_value },
      verbose: input.verbose,
      exact: input.exact,
      cache,
    })
    const formatted = formatDiagnosticResult(result, input.output || 'json')
    return {
      data: {
        success: true,
        data: formatted,
      },
    }
  },
})
```

**Tool vs Skill 互补关系：**

| 维度 | Tool | Skill |
|------|------|-------|
| 调用方 | LLM Agent 自主调用 | 用户通过 `/proc-diag` 命令触发 |
| 输出格式 | 结构化文本（LLM 友好） | 格式化表格 + 选择器（用户友好） |
| 适用场景 | 对话中遇到进程/端口问题时自动诊断 | 用户主动排查环境问题 |
| 权限 | 需要 Tool 执行权限 | 需要 Skill 触发权限 |

**Skill Frontmatter 设计：**

```markdown
---
name: process-diagnostic
description: Diagnose process/port/container issues with ancestry chain analysis
trigger: port process container zombie socket lsof netstat ss diagnose
priority: 55
conflicts-with: []
---

# Process Diagnostic Tool

诊断进程、端口、容器问题，构建因果链（PID → 祖先链 → 源检测）。

## 使用方式

通过 `/proc-diag <target>` 命令触发，支持以下查询类型：
- **端口查询**: `/proc-diag :8080` — 查找占用端口的进程
- **进程名查询**: `/proc-diag nginx` — 查找指定名称的进程
- **PID 查询**: `/proc-diag 1234` — 查找指定 PID 的进程
- **容器查询**: `/proc-diag my-container` — 查找容器及其宿主进程

## 输出格式

返回格式化表格，包含：
1. 目标进程信息（PID、命令、用户、状态）
2. 祖先链（从 init 到目标进程的完整路径）
3. 源检测结果（systemd/launchd/SSH/container 等）
4. 警告信息（如有）
5. 子进程列表（verbose 模式）

## 调用链

Skill 内部调用 `process_diagnostic` Tool 完成实际逻辑，
格式化为人类可读的表格输出。
```

**Skill → Tool 端到端调用流程：**

```typescript
// Skill 执行流程 (由 ola-cc Skill 框架驱动):
// 1. 用户输入 `/proc-diag :3000`
// 2. Skill 框架解析参数，提取 target_type=port, target_value=3000
// 3. Skill 调用 process_diagnostic Tool:
//    - Tool.call({ target_type: 'port', target_value: '3000' }, context)
//    - Tool 内部: analyze() → formatDiagnosticResult(result, 'json')
//    - Tool 返回: { data: { success: true, data: "<JSON string>" } }
// 4. Skill 接收 Tool 返回的 JSON，调用 formatDiagnosticResult(result, 'text')
//    转换为格式化文本（此时 Skill 已有 DiagnosticResult 对象）
// 5. Skill 输出格式化文本给用户
//
// 注意: Skill 不直接调用 analyze()，而是通过 Tool 间接调用。
// 这样 Tool 的权限检查 (checkPermissions) 和缓存 (getOrCreateCache)
// 自动生效，Skill 无需重复实现。
```

### 3.13 与 ola-cc 的集成方式

在 `src/services/process-diagnostic/` 实现完整的 TypeScript 模块，通过 Tool 和 Skill 双通道暴露。核心逻辑使用异步子进程调用（`child_process.execFile` 异步版本或 `Bun.spawn`），**禁止使用 `spawnSync`/`execSync`**，避免阻塞 Ink TUI 事件循环。超时通过 `Promise.race` 实现（参见 3.5 节 `withTimeout`）。

集成要点：
1. 与 ola-cc 代码库同语言，易于维护
2. 可以直接访问 ola-cc 的上下文（当前工作目录、git 信息）
3. 不引入外部依赖
4. 跨平台统一接口，平台差异封装在 `platform/` 目录下
5. Tool 注册在 `src/tools.ts`，Skill 注册在 `~/.ola-cc/skills/`

### 3.14 实现优先级

| Phase | 内容 | 平台 | 复杂度 |
|-------|------|------|--------|
| P0 | 核心类型 + 平台抽象接口 + 祖先链算法 + **Tool 注册** + 脱敏机制 | 全平台 | 低 |
| P1 | macOS 实现 (进程读取 + 端口解析 + Shell/SSH 检测 + launchd) | macOS | 中 |
| P2 | Linux 实现 (/proc + ss 端口解析 + systemd 检测 + Alpine/BusyBox 回退) | Linux | 中 |
| P3a | Windows 基础 (ToolHelp32 + netstat + 基本进程信息，无 PEB) | Windows | 中 |
| P4 | 容器运行时 (Docker 全平台 + K8s Linux) | 全平台 | 中 |
| P5 | 警告系统 + **Skill 集成** + 结构化输出 + 全局缓存 | 全平台 | 中 |
| P6 | P3b Windows 增强 (PEB 读取 + SCM 服务检测) + FreeBSD 实现 | Windows/FreeBSD | 高 |
| P7 | Podman/nerdctl + launchd 详细解析 + 扩展信息 | 高级 | 高 |

**MVP (P0+P1) 交付物：**
- `src/services/process-diagnostic/` 核心模块
- `src/tools/ProcessDiagnosticTool/` Tool 注册
- macOS 平台完整实现（端口/名称/PID 查询 + 祖先链 + launchd 检测）
- 可被 LLM Agent 在对话中自主调用

### 3.15 关键实现细节

#### macOS 端口解析三级回退

```typescript
async function resolvePortDarwin(port: number): Promise<number[]> {
  // Level 1: TCP LISTEN (最常见场景)
  let result = await exec(`lsof -i TCP:${port} -s TCP:LISTEN -F p`)
  if (result) return parsePids(result)

  // Level 2: UDP 绑定
  result = await exec(`lsof -i UDP:${port} -F p`)
  if (result) return parsePids(result)

  // Level 3: 所有连接 (包括非监听)
  result = await exec(`lsof -i :${port} -F p`)
  if (result) return parsePids(result)

  // Level 4: netstat 兜底
  result = await exec(`netstat -anv -p tcp | grep .${port}`)
  return parseNetstatPids(result)
}
```

#### Linux 端口解析 (ss + procfs 回退)

```typescript
async function resolvePortLinux(port: number): Promise<number[]> {
  // 优先: ss -tlnp sport = :<port> (TCP 监听，直接获取 PID)
  //   输出: LISTEN  0  128  0.0.0.0:3000  0.0.0.0:*  users:(("node",pid=1234,fd=6))
  //   正则提取 pid=(\d+)
  const tcpResult = await exec(`ss -tlnp sport = :${port}`)
  if (tcpResult) return extractPidsFromSs(tcpResult)

  // 回退: ss -ulnp sport = :<port> (UDP)
  const udpResult = await exec(`ss -ulnp sport = :${port}`)
  if (udpResult) return extractPidsFromSs(udpResult)

  // 兜底: /proc/net/tcp + /proc/[pid]/fd 遍历（ss 不可用时）
  const entries = await parseProcNet(port)
  const inodes = new Set(entries.map(e => e.inode))
  const pids: number[] = []
  for (const pid of await listPids()) {
    const fds = await readLinkFds(pid)
    if (fds.some(fd => inodes.has(fd))) pids.push(pid)
  }
  return pids
}
```

#### Windows 端口解析 (netstat)

```typescript
async function resolvePortWindows(port: number): Promise<number[]> {
  // netstat -ano 输出:
  //   TCP    0.0.0.0:135           0.0.0.0:0        LISTENING       888
  //   TCP    [::]:135              [::]:0           LISTENING       888
  //   UDP    0.0.0.0:123           *:*                          999
  const output = await exec('netstat -ano')
  const listenPIDs: number[] = []
  const fallbackPIDs: number[] = []

  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4) continue
    // 精确端口匹配：提取 LocalAddr 字段的端口号做数值比较
    // 避免 :80 误匹配 :8080 等前缀匹配问题
    const localAddr = fields[1] || ''
    const portMatch = localAddr.match(/:(\d+)$/)
    if (!portMatch || parseInt(portMatch[1]) !== port) continue

    // TCP: Proto LocalAddr ForeignAddr State PID (5 fields)
    // UDP: Proto LocalAddr *:* PID (4 fields)
    if (fields[0]?.startsWith('TCP')) {
      if (fields[3] === 'LISTENING') listenPIDs.push(parseInt(fields[4]))
      else fallbackPIDs.push(parseInt(fields[4]))
    } else if (fields[0]?.startsWith('UDP')) {
      listenPIDs.push(parseInt(fields[3]))
    }
  }
  return listenPIDs.length > 0 ? listenPIDs : fallbackPIDs
}
```

#### FreeBSD 端口解析 (sockstat)

```typescript
async function resolvePortFreeBSD(port: number): Promise<number[]> {
  // sockstat -4 -P tcp -p <port> -l  (监听)
  // sockstat -6 -P tcp -p <port> -l  (IPv6 监听)
  // sockstat -4 -P udp -p <port>     (UDP)
  // 输出: USER COMMAND PID FD PROTO LOCAL FOREIGN
  //   root nginx 1234 6 tcp4 *:80 *:*
  // 多地址歧义时保留最小 PID (master/worker 模式)

  // 回退: netstat -an -p tcp → 检测端口存在 → fstat 查 PID
}
```

#### 命令名派生 (跨平台统一)

```typescript
const MAX_COMMAND_LENGTH = 256  // 防止异常长 cmdline 导致输出膨胀

function deriveCommand(comm: string, cmdline: string, exe: string): string {
  if (!comm) return truncateCommand(extractExecutableName(cmdline) || 'unknown')

  // 内核 comm 字段通常截断到 15-16 字符 (Linux/FreeBSD)
  // 如果 exe 存在且 comm 是其 basename 的前缀，使用完整 exe 名
  if (exe && exe.length > comm.length) {
    const exeBase = path.basename(exe)
    if (exeBase.startsWith(comm)) {
      return truncateCommand(exeBase)
    }
  }

  // 从 cmdline 提取可执行文件名，跳过环境变量赋值 (如 FOO=bar node server.js)
  // 处理: 引号 ("my app" --flag)、shell 内置命令 (time node)、绝对路径
  return truncateCommand(extractExecutableName(cmdline) || comm)
}

function truncateCommand(cmd: string): string {
  return cmd.length > MAX_COMMAND_LENGTH
    ? cmd.slice(0, MAX_COMMAND_LENGTH) + '…'
    : cmd
}

function extractExecutableName(cmdline: string): string | null {
  if (!cmdline) return null
  const parts = cmdline.split(/\s+/)
  // shell 前缀命令及其已知需要跳过一个额外参数的标志
  const SHELL_PREFIX_COMMANDS: Record<string, string[]> = {
    'sudo': ['-u', '-g', '-C', '--group', '--chdir'],
    'env': ['-u', '--unset'],
    'nice': ['-n', '--adjustment'],
    'nohup': [],
    'time': [],
  }
  let skipNext = false
  let lastPrefixCmd: string | null = null  // 跟踪最近遇到的前缀命令
  for (const part of parts) {
    // 跳过上一轮标记的标志参数值 (如 sudo -u root 中的 root)
    if (skipNext) {
      skipNext = false
      continue
    }
    // 跳过环境变量赋值 (KEY=VALUE)
    if (/^[A-Z_][A-Z0-9_]*=/.test(part)) continue
    const base = path.basename(part.replace(/^["']|["']$/g, ''))
    if (base in SHELL_PREFIX_COMMANDS) {
      // 如果是 sudo 等前缀命令，记录并继续扫描后续参数
      lastPrefixCmd = base
      continue
    }
    // 跳过以 - 开头的标志 (如 -u, --user, --flag)
    if (part.startsWith('-')) {
      // 检查这个标志是否需要消耗下一个参数
      // 使用最近遇到的前缀命令（而非 parts.find 的第一个）
      const knownFlags = lastPrefixCmd
        ? SHELL_PREFIX_COMMANDS[lastPrefixCmd]
        : []
      if (knownFlags.includes(part)) {
        skipNext = true  // 下一个是该标志的值，需要跳过
      }
      continue  // 无论是否需要跳过下一个，当前标志本身要跳过
    }
    return base
  }
  return null
}
```

## 4. 不做的事情

1. **不做 TUI** — ola-cc 已有 Ink TUI，进程诊断用 Skill 文本输出即可
2. **不做进程操作** (kill/term/renice) — 安全风险太高，让用户自己操作
3. **不做文件锁分析** — Windows 不支持，其他平台使用场景有限
4. **不做 FreeBSD CI** — FreeBSD 实现推迟到 P6，标记为社区贡献优先级
5. **不做 PEB 同步调用** — Windows PEB 读取为 P3b 高级功能，MVP 不包含

## 5. 测试策略

| 平台 | 测试重点 |
|------|---------|
| macOS | lsof 三级回退、launchd plist 解析、tmux/screen 检测、per-PID lsof |
| Linux | ss 端口解析（优先）、/proc 回退、systemd cgroup/unit 提取、IPv6 双栈、Alpine/BusyBox |
| Windows | ToolHelp32 快照缓存、netstat IPv6 精确解析、服务枚举（P3b: PEB） |
| 跨平台 | 祖先链循环保护+PID 复用+最大深度、容器运行时注册表、警告规则引擎、超时降级、脱敏 |

**Mock 策略**：使用依赖注入 mock `PlatformOps` 接口（而非 mock 底层 exec），这样可以：
1. 测试检测器逻辑而不依赖系统命令
2. 集成测试单独验证每个 `PlatformOps` 实现
3. 使用 fixture 文件存储各平台命令的真实输出

**性能预期**：
| 操作 | 预期延迟 | 超时 |
|------|---------|------|
| 端口查询 | <1s | 5s |
| 名称查询 | <3s（取决于进程数量） | 5s |
| PID 查询 | <0.5s | 5s |
| 容器查询 | <2s | 5s |

- 单元测试：每个检测器独立测试（mock PlatformOps）
- 集成测试：每个平台用真实进程测试完整管线
- 边界测试：PID 循环、PID 复用（5s 容差）、最大深度 64、端口回退链、容器不可见、权限不足、多地址歧义、子进程超时、PID 1 socket activation、嵌套容器 3 层

## 6. 总结

witr 的核心价值在于将分散的系统信息整合为**因果链**。将其设计思路移植到 TypeScript，可以让 ola-cc 在诊断开发环境问题时提供更智能的分析能力。

关键移植点：
1. **因果链模型** — PID → 祖先链 → 源检测（跨平台统一），含 PID 复用检测（5s 容差）+ 最大深度保护
2. **多目标统一解析** — name/port/pid/file/container 统一入口，每平台独立实现
3. **源检测优先级链** — Container > SSH > Shell > Systemd/Launchd/BsdRc/WinService > Supervisor > Cron > Init
4. **容器运行时注册表** — Docker(全平台) + K8s(Linux)，JSON 输出避免分隔符歧义
5. **警告系统** — 16+ 安全检查规则，按平台过滤
6. **平台抽象层** — `PlatformOps` 接口 + 4 平台实现，可选方法用 `?` 声明
7. **三层架构** — Module(核心逻辑) + Tool(Agent 自主调用，buildTool 模式) + Skill(Markdown 格式)
8. **全局缓存** — 按类型 TTL + LRU 淘汰 + session 生命周期绑定
9. **异步执行** — 全部使用异步子进程 API，禁止 spawnSync/execSync
10. **安全脱敏** — 环境变量/命令行自动脱敏（TOKEN/KEY/PASSWORD/URL 中的密码）
11. **权限模型** — 基本查询自动授权，verbose 模式需用户确认
12. **双输出格式** — Tool 返回 JSON 结构化数据，Skill 返回格式化文本

各平台实现要点：

| 平台 | 进程读取 | 端口解析 | 服务检测 | 特殊工具 |
|------|---------|---------|---------|---------|
| macOS | `ps` + `lsof` | `lsof` 三级回退 | `launchctl blame` + plist | `sysctl kern.boottime` |
| Linux | `/proc` 文件系统 | `ss -tlnp` (优先) + `/proc/net/tcp` 回退 | `systemctl show` + cgroup | `stat /proc/[pid]/exe` |
| Windows | ToolHelp32 (P3a) + PEB (P3b) | `netstat -ano` (精确端口匹配) | SCM (P3b) | psapi/kernel32 DLL |
| FreeBSD | `ps` + `procstat` | `sockstat` + `fstat` | `/var/run/*.pid` + rc.d | `jls --libxo=json` |
