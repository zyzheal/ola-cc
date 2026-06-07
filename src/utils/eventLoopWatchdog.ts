/**
 * 事件循环看门狗 — 检测 JS 层卡死和 CPU 忙碌
 *
 * 环境变量:
 *   OLA_CC_CPU_DEBUG=1     启用 CPU 热点检测和采样
 *   OLA_CC_CPU_LOG_FILE=<path>  将诊断日志写入文件而非 stderr
 *
 * 仅在 OLA_CC_CPU_DEBUG=1 时激活，否则所有功能为空操作。
 */

const CHECK_INTERVAL_MS = 100
const STUCK_THRESHOLD_MS = 5000

let lastAliveTime = Date.now()
let lastCaller = 'init'
let stuckReported = false
let _lastTimerFire = Date.now()

// --- CPU 热点检测 ---
// IMPORTANT: Read process.env at CALL TIME, not module load time.
// Bun bundler initializes modules at bundle time when process.env may be empty.
// The user sets OLA_CC_CPU_DEBUG=1 at runtime, so we must check dynamically.
// DO NOT cache the result — the /debug command sets OLA_CC_CPU_DEBUG after load.
function _isCpuDebug(): boolean {
  return process.env.OLA_CC_CPU_DEBUG === '1'
}

// 日志输出函数：同步写文件或静默（绝不写 stderr，避免破坏 Ink TUI 渲染）
// CRITICAL: Uses appendFileSync (not stream.write) so logs are flushed to disk
// even when the main thread is stuck in a synchronous CPU loop. Stream writes
// buffer in memory and never flush when the event loop is blocked.
let _logFile: string | null = null
function _log(msg: string): void {
  if (!_isCpuDebug()) return
  if (!_logFile) {
    _logFile = process.env.OLA_CC_CPU_LOG_FILE ?? null
  }
  if (_logFile) {
    try {
      const fs = require('fs') as typeof import('fs')
      fs.appendFileSync(_logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {}
  }
}

/**
 * 检查 CPU 占用：在关键路径入口/出口调用。
 * 如果自上次调用以来 CPU 累计时间超过阈值，输出调用栈。
 *
 * 使用方法：
 *   checkCpuHotspot('myFunction')  // 入口
 *   // ... 做一些工作 ...
 *   checkCpuHotspot('myFunction')  // 出口（检测是否在两次调用之间 CPU 时间过长）
 */
let _lastCpuCheckTime = _isCpuDebug() ? performance.now() : 0
let _cpuHotspotCount = 0
let _cpuHotspotLastReport = 0

export function checkCpuHotspot(location: string): void {
  if (!_isCpuDebug()) return

  const now = performance.now()
  const elapsed = now - _lastCpuCheckTime
  _lastCpuCheckTime = now

  // 如果两次检查点之间超过 50ms，说明有同步阻塞
  if (elapsed > 50) {
    _log(`[cpuHotspot] ${location}: ${elapsed.toFixed(1)}ms since last check`)
    try {
      const stack = new Error().stack ?? ''
      const frames = stack.split('\n').slice(1, 8)
        .map(l => l.trim())
        .filter(l => !l.includes('eventLoopWatchdog'))
        .join(' <- ')
      _log(`[cpuHotspot] stack: ${frames}`)
    } catch {}
  }

  _cpuHotspotCount++
  if (now - _cpuHotspotLastReport >= 1000) {
    if (_cpuHotspotCount > 0) {
      _log(`[cpuHotspot] ${_cpuHotspotCount} checks/s`)
    }
    _cpuHotspotCount = 0
    _cpuHotspotLastReport = now
  }
}

/**
 * 同步 CPU 时间采样：在 setInterval 回调中检测事件循环延迟。
 * 如果延迟超过阈值，说明有同步阻塞正在进行（或刚结束）。
 * 此时 Error().stack 能捕获当前执行上下文。
 */
let _sampleEnabled = false
let _sampleInterval: ReturnType<typeof setInterval> | null = null
let _lastSampleCheck = Date.now()
// CPU usage tracking: compare process.cpuUsage() between samples
let _lastCpuUsage: NodeJS.CpuUsage | null = null
let _cpuUsageLog: ReturnType<typeof setInterval> | null = null

export function startCpuSampling(): void {
  if (!_isCpuDebug()) return
  if (!_isCpuDebug() || _sampleInterval) return
  _sampleEnabled = true

  // CPU usage tracker: every 1s, report user/system CPU time
  _lastCpuUsage = process.cpuUsage()
  _cpuUsageLog = setInterval(() => {
    if (!_lastCpuUsage) return
    const current = process.cpuUsage(_lastCpuUsage)
    _lastCpuUsage = process.cpuUsage()
    const userMs = current.user / 1000 // microseconds to ms
    const sysMs = current.system / 1000
    const totalMs = userMs + sysMs
    const cpuPercent = (totalMs / 1000) * 100 // ms per 1000ms = %
    if (cpuPercent > 10) {
      _log(`[cpuUsage] user=${userMs.toFixed(0)}ms sys=${sysMs.toFixed(0)}ms total=${totalMs.toFixed(0)}ms (${cpuPercent.toFixed(0)}%)`)
    }
  }, 1000)

  // Event loop delay detector (reduced frequency to minimize overhead)
  // 200ms interval (5/s) instead of 20ms (50/s) — the old 20ms interval
  // itself became a CPU burden when combined with stack capture on blocks.
  // 1000ms threshold — only report significant blocks, not transient jitter.
  _sampleInterval = setInterval(() => {
    const now = Date.now()
    const delay = now - _lastSampleCheck
    _lastSampleCheck = now

    if (delay > 1000) {
      _log(`[cpuSampler] event loop blocked for ${delay}ms`)
      try {
        const stack = new Error().stack ?? ''
        const frames = stack.split('\n').slice(1, 6)
          .map(l => l.trim())
          .filter(l => !l.includes('eventLoopWatchdog'))
          .join(' <- ')
        _log(`[cpuSampler] post-block stack: ${frames}`)
      } catch {}
    }
  }, 200)
}
// --- END CPU 热点检测 ---

/**
 * 公开的诊断日志函数，供其他模块使用。
 * 当 OLA_CC_CPU_LOG_FILE 设置时写入文件，否则写 stderr。
 * 仅在 OLA_CC_CPU_DEBUG=1 时输出，否则为空操作。
 */
export function logCpuDiag(msg: string): void {
  _log(msg)
}

/**
 * 通知看门狗当前代码正在执行
 */
export function heartbeat(caller: string): void {
  lastAliveTime = Date.now()
  lastCaller = caller
  stuckReported = false
  // Debug: log heartbeat calls periodically
  if (_isCpuDebug() && Math.random() < 0.01) { // 1% sampling
    _log(`[heartbeat] ${caller} at ${new Date().toISOString()}`)
  }
}

/**
 * 启动看门狗定时器
 */
export function startEventLoopWatchdog(): void {
  _log(`[watchdog] startEventLoopWatchdog called at ${new Date().toISOString()}`)
  const watchdogStartTime = Date.now()
  setInterval(() => {
    const now = Date.now()

    // Skip CPU BUSY detection during warmup period (first 5 seconds)
    // to avoid false positives from startup delays
    const timeSinceStart = now - watchdogStartTime
    if (timeSinceStart < STUCK_THRESHOLD_MS) {
      lastAliveTime = now  // Keep alive during warmup
      return
    }

    // 检测事件循环完全卡死: timer 触发间隔远大于预期
    const timerGap = now - _lastTimerFire
    _lastTimerFire = now
    if (timerGap > CHECK_INTERVAL_MS + 200) {
      _log(`[watchdog] EVENT_LOOP_FROZE for ${timerGap}ms (timer delayed by ${timerGap - CHECK_INTERVAL_MS}ms)`)
      try {
        throw new Error('Watchdog freeze stack')
      } catch (e) {
        _log(`[watchdog] Stack: ${(e as Error).stack?.split('\n').slice(1, 6).join(' <- ')}`)
      }
    }

    // 检测主线程忙碌: heartbeat 未及时调用
    const lag = now - lastAliveTime
    if (lag > STUCK_THRESHOLD_MS && !stuckReported) {
      stuckReported = true
      _log(`[watchdog] CPU BUSY! ${lag}ms since last heartbeat (caller=${lastCaller})`)
      _log(`[watchdog] Last alive: ${new Date(lastAliveTime).toISOString()}`)
      _log(`[watchdog] Current: ${new Date(now).toISOString()}`)
      _log(`[watchdog] Event loop responsive but main thread busy`)

      try {
        throw new Error('Watchdog stack trace')
      } catch (e) {
        _log(`[watchdog] Stack: ${(e as Error).stack?.split('\n').slice(1, 6).join(' <- ')}`)
      }
    }
  }, CHECK_INTERVAL_MS)
}
