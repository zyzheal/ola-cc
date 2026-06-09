import type { DiagnosticCache } from './cache.js'
import { resolveAncestry } from './process/ancestry.js'
import { countRestarts } from './process/restart.js'
import { getPlatformOps } from './platform/index.js'
import { detectSource } from './source/detect.js'
import { detectWarnings } from './warnings/index.js'
import { redactCmdline } from './redact.js'
import { resolveContainer, findContainerHostPID } from './container/runtime.js'
import { EXEC_TIMEOUT_MS } from './constants.js'
import type { DiagnosticCapabilities, DiagnosticResult, ProcessInfo } from './types.js'
import { AmbiguousError, NotFoundError, TimeoutError } from './types.js'
import type { PlatformOps } from './platform/types.js'

/** I8: 查询类型联合 */
export type TargetType = 'port' | 'name' | 'pid' | 'file' | 'container'

export async function analyze(config: {
  target: { type: string; value: string }
  verbose?: boolean
  exact?: boolean
  cache?: DiagnosticCache
}): Promise<DiagnosticResult> {
  const platform = getPlatformOps()

  // C2: container 类型特殊处理 — 先解析容器 → 宿主 PID
  let targetValue = config.target.value
  if (config.target.type === 'container') {
    const container = await withTimeout(
      resolveContainer(config.target.value, config.exact ?? false),
      EXEC_TIMEOUT_MS,
      'resolveContainer',
    )
    if (!container) {
      throw new NotFoundError(`No container found for "${config.target.value}"`)
    }
    const hostPid = await withTimeout(
      findContainerHostPID(container.id),
      EXEC_TIMEOUT_MS,
      'findContainerHostPID',
    )
    if (!hostPid) {
      throw new NotFoundError(`Container "${container.name}" found but host PID unavailable`)
    }
    targetValue = String(hostPid)
  }

  // Step 1: 解析目标 → PID 列表
  const queryType = config.target.type === 'container' ? 'pid' : config.target.type
  const pids = await withTimeout(
    platform.findPIDs({ type: queryType, value: targetValue, exact: config.exact }),
    EXEC_TIMEOUT_MS,
    `findPIDs(${queryType}:${targetValue})`,
  )
  if (pids.length === 0) {
    const displayTarget = config.target.type === 'container' ? config.target.value : targetValue
    throw new NotFoundError(`No process found for ${config.target.type}:${displayTarget}`)
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

  // Step 5: 读取目标进程详情（合并 socket 数据 + 脱敏 + C7 缓存）
  const targetProc = ancestry[ancestry.length - 1]
  const targetProcess: ProcessInfo = {
    ...targetProc,
    cmdline: redactCmdline(targetProc.cmdline),
    sockets: sockets.length > 0 && targetProc.sockets.length === 0 ? sockets : targetProc.sockets,
  }

  // C3: verbose 模式读取环境变量
  if (config.verbose && platform.readEnvironment) {
    const env = await withTimeout(
      platform.readEnvironment(pid), EXEC_TIMEOUT_MS, 'readEnvironment',
    ).catch(() => [] as string[])
    targetProcess.env = env
  }

  // I5: 子进程发现 — 将 PID 列表转为 ProcessInfo
  let children: ProcessInfo[] = []
  if (config.verbose && platform.listChildren) {
    const childPids = await withTimeout(
      platform.listChildren(pid), EXEC_TIMEOUT_MS, 'listChildren',
    ).catch(() => [] as number[])
    children = await Promise.all(
      childPids.map(cpid => platform.readProcess(cpid).catch(() => null)),
    ).then(results => results.filter((r): r is ProcessInfo => r !== null))
  }

  // Step 7: 警告检测
  const warnings = detectWarnings(targetProcess, ancestry, source)

  // Step 8: 重启计数
  const restartCount = countRestarts(ancestry, targetProcess.command)

  // Step 9: 诊断能力评估
  const capabilities = assessCapabilities(platform, targetProcess, config.verbose)

  return { target: config.target, process: targetProcess, ancestry, children, source, warnings, restartCount, capabilities }
}

function assessCapabilities(
  platform: PlatformOps,
  process: Pick<ProcessInfo, 'sockets' | 'env' | 'memoryRSS' | 'cpuPercent'>,
  verbose?: boolean,
): DiagnosticCapabilities {
  const limitations: string[] = []
  const canReadProcess = !!process
  const canReadSockets = process.sockets.length > 0
  const canReadEnvironment = verbose && (process.env?.length ?? 0) > 0
  const canReadExtended = !!(process.memoryRSS > 0 || process.cpuPercent !== undefined)
  const canDetectSource = true

  if (!verbose) limitations.push('verbose=false: environment and children not loaded')
  if (!platform.readSockets) limitations.push('platform does not support socket reading')
  if (process.sockets.length === 0 && platform.readSockets) limitations.push('no sockets found or permission denied')

  return { canReadProcess, canReadSockets, canReadEnvironment, canReadExtended, canDetectSource, limitations }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}
