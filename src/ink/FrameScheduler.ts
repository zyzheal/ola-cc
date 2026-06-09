/**
 * 帧调度器 — 自适应渲染频率管理
 *
 * 功能:
 * 1. 帧预算跟踪: 监控每帧的各阶段耗时
 * 2. 自适应节流: 帧超时时自动降低渲染频率 (带迟滞防振荡)
 * 3. 背压控制: 当渲染跟不上时，跳过非关键更新
 * 4. 诊断接口: 暴露帧指标供调试使用
 *
 * 设计原则:
 * - 最小侵入: 只在 onRender 末尾添加 reportFrame()
 * - 向后兼容: 不改变现有 API
 * - 可扩展: 支持未来添加 Worker 线程渲染
 *
 * 三层防护架构:
 *   第1层: ClockContext FrameCoalescer — tick 合并 + setTimeout(0)
 *   第2层: reconciler setTimeout(0) — 让路给事件循环
 *   第3层: FrameScheduler — 帧预算 + 自适应降频
 *
 * 专家评审修复记录:
 *   P1: setImmediate → setTimeout(0) 兼容 Bun
 *   P2: getStats() 排序结果缓存
 *   P3: 环形缓冲区替代 Array.shift()
 *   A1: shouldRender() 实现帧预算检查
 *   A2: 多监听器支持
 *   O1/O2: 集成 CPU_DEBUG 日志
 *   Q3: 迟滞防振荡
 */

import { isEnvTruthy } from '../utils/envUtils.js'

// --- 日志 (复用 CPU_DEBUG 基础设施) ---
const _CPU_DEBUG = isEnvTruthy(process.env.OLA_CC_CPU_DEBUG)
const _CPU_LOG_FILE = process.env.OLA_CC_CPU_LOG_FILE
let _logStream: ReturnType<typeof import('fs').createWriteStream> | null = null

function _log(msg: string): void {
  if (!_CPU_DEBUG) return
  if (_CPU_LOG_FILE) {
    if (!_logStream) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs') as typeof import('fs')
      _logStream = fs.createWriteStream(_CPU_LOG_FILE, { flags: 'a' })
    }
    _logStream.write(`[frameScheduler] ${msg}\n`)
  }
}

// --- 类型 ---

export type FramePhase = {
  reconcile: number   // React commit 阶段
  layout: number      // Yoga layout 阶段
  render: number      // frame buffer 渲染
  diff: number        // 帧差异计算
  optimize: number    // diff 优化
  write: number       // terminal 输出
}

export type FrameMetrics = {
  totalMs: number
  phases: FramePhase
  commitCount: number      // 本帧内的 React commit 次数
  timestamp: number
  skipped: boolean         // 是否因超时被跳过
}

export type AdaptiveState = 'normal' | 'degraded' | 'minimal'

type MetricsListener = (metrics: FrameMetrics) => void

// --- 环形缓冲区 (修复 P3) ---

class RingBuffer<T> {
  private readonly buffer: (T | undefined)[]
  private head = 0
  private count = 0

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity)
  }

  push(item: T): void {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  /** 返回所有有效元素 (从旧到新) */
  toArray(): T[] {
    if (this.count === 0) return []
    const start = this.count < this.capacity
      ? 0
      : this.head
    const result: T[] = []
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity
      const item = this.buffer[idx]
      if (item !== undefined) result.push(item)
    }
    return result
  }

  get length(): number { return this.count }

  clear(): void {
    this.buffer.fill(undefined)
    this.head = 0
    this.count = 0
  }
}

// --- 帧调度器 ---

export class FrameScheduler {
  // --- 帧预算配置 ---
  private readonly TARGET_FRAME_MS = 16    // 目标: 60fps
  private readonly DEGRADED_FRAME_MS = 33  // 降级: 30fps
  private readonly MINIMAL_FRAME_MS = 100  // 最小: 10fps
  private readonly STALL_THRESHOLD_MS = 200 // 帧停滞阈值

  // --- 迟滞阈值 (修复 Q3: 防止状态振荡) ---
  // 升级到 degraded 需要连续 3 个慢帧
  // 降级回 normal 需要连续 15 个快帧 (比升级阈值高 5x)
  // 升级到 minimal 需要连续 10 个慢帧
  // 降级回 degraded 需要连续 20 个快帧
  private readonly SLOW_TO_DEGRADED = 3
  private readonly DEGRADED_TO_NORMAL = 15
  private readonly SLOW_TO_MINIMAL = 10
  private readonly MINIMAL_TO_DEGRADED = 20

  // --- 自适应状态 ---
  private state: AdaptiveState = 'normal'
  private consecutiveSlowFrames = 0
  private consecutiveFastFrames = 0
  private currentIntervalMs = this.TARGET_FRAME_MS

  // --- 帧历史 (环形缓冲区, 修复 P3) ---
  private frameHistory = new RingBuffer<FrameMetrics>(60)

  // --- 帧预算跟踪 (修复 A1) ---
  private lastRenderEnd = 0
  private frameBudgetExhausted = false
  // Grace period: always allow renders for the first 5 seconds after startup
  private readonly _startTime = performance.now()

  // --- 诊断 ---
  private totalFrames = 0
  private totalSkipped = 0

  // --- 多监听器 (修复 A2) ---
  private listeners = new Set<MetricsListener>()

  // --- 统计缓存 (修复 P2) ---
  private statsCache: ReturnType<typeof this.computeStats> | null = null
  private statsDirty = true

  // --- 间隔变化监听器 (供 Ink Ink.tsx throttle 动态调整) ---
  private intervalListeners: Set<(intervalMs: number) => void> = new Set()

  /**
   * 注册间隔变化监听器。当 FrameScheduler 自适应状态变化导致
   * 渲染间隔改变时，通知所有监听器。用于 Ink.tsx 的 scheduleRender
   * throttle 动态调整间隔 (normal 16ms → degraded 33ms → minimal 100ms)。
   * 返回取消注册函数。
   */
  addIntervalChangeListener(listener: (intervalMs: number) => void): () => void {
    this.intervalListeners.add(listener)
    return () => { this.intervalListeners.delete(listener) }
  }

  /**
   * 报告一帧完成。在 onRender 末尾调用。
   */
  reportFrame(metrics: Omit<FrameMetrics, 'skipped'>): void {
    const fullMetrics: FrameMetrics = { ...metrics, skipped: false }
    this.totalFrames++
    this.statsDirty = true

    // 更新帧历史 (环形缓冲区)
    this.frameHistory.push(fullMetrics)

    // 更新帧预算
    this.lastRenderEnd = performance.now()
    this.frameBudgetExhausted = false

    // 自适应逻辑
    this.adapt(metrics.totalMs)

    // 日志 (修复 O1/O2)
    if (_CPU_DEBUG && this.totalFrames % 60 === 0) {
      const stats = this.getStats()
      _log(`[stats] state=${stats.state} interval=${stats.intervalMs}ms avg=${stats.avgFrameMs.toFixed(1)}ms p95=${stats.p95FrameMs.toFixed(1)}ms slow=${(stats.slowFrameRate * 100).toFixed(0)}% total=${stats.totalFrames}`)
    }

    // 通知所有监听器 (修复 A2)
    for (const listener of this.listeners) {
      try {
        listener(fullMetrics)
      } catch (e) {
        _log(`[error] listener threw: ${e}`)
      }
    }
  }

  /**
   * 判断当前帧是否应该渲染 (修复 A1)。
   * 基于帧预算: 如果距上次渲染不足当前间隔，跳过。
   */
  shouldRender(): boolean {
    // Startup grace period: always allow renders for the first 5 seconds.
    // During startup, the TUI needs to be responsive for initial user input.
    // The FrameScheduler may degrade to 'minimal' (100ms) due to cold JIT
    // and heavy layout, which starves input-triggered renders.
    if (performance.now() - this._startTime < 5000) {
      return true
    }

    // 帧预算检查
    const now = performance.now()
    const elapsed = now - this.lastRenderEnd

    if (elapsed < this.currentIntervalMs) {
      // 距上次渲染不足一个间隔 — 跳过
      if (!this.frameBudgetExhausted) {
        this.frameBudgetExhausted = true
        this.totalSkipped++
        this.statsDirty = true
      }
      return false
    }

    return true
  }

  /**
   * 获取当前建议的渲染间隔 (ms)。
   * ClockContext 和 throttle 应使用此值。
   */
  getIntervalMs(): number {
    return this.currentIntervalMs
  }

  /**
   * 获取当前自适应状态。
   */
  getState(): AdaptiveState {
    return this.state
  }

  /**
   * 获取帧统计信息 (修复 P2: 缓存排序结果)。
   */
  getStats(): {
    state: AdaptiveState
    intervalMs: number
    avgFrameMs: number
    p95FrameMs: number
    totalFrames: number
    totalSkipped: number
    slowFrameRate: number
  } {
    if (!this.statsDirty && this.statsCache) {
      return this.statsCache
    }
    this.statsCache = this.computeStats()
    this.statsDirty = false
    return this.statsCache
  }

  private computeStats(): {
    state: AdaptiveState
    intervalMs: number
    avgFrameMs: number
    p95FrameMs: number
    totalFrames: number
    totalSkipped: number
    slowFrameRate: number
  } {
    const history = this.frameHistory.toArray()

    const avg = history.length > 0
      ? history.reduce((s, f) => s + f.totalMs, 0) / history.length
      : 0

    // P2 修复: 只在需要时排序，缓存结果
    const sorted = history.slice().sort((a, b) => a.totalMs - b.totalMs)
    const p95 = sorted.length > 0
      ? sorted[Math.floor(sorted.length * 0.95)]?.totalMs ?? 0
      : 0

    const slowFrames = history.filter(f => f.totalMs > this.TARGET_FRAME_MS).length
    const slowRate = history.length > 0
      ? slowFrames / history.length
      : 0

    return {
      state: this.state,
      intervalMs: this.currentIntervalMs,
      avgFrameMs: avg,
      p95FrameMs: p95,
      totalFrames: this.totalFrames,
      totalSkipped: this.totalSkipped,
      slowFrameRate: slowRate,
    }
  }

  /**
   * 注册帧指标监听器 (修复 A2: 支持多个监听器)。
   * 返回取消注册函数。
   */
  onMetrics(callback: MetricsListener): () => void {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  /**
   * 重置为初始状态。
   */
  reset(): void {
    this.state = 'normal'
    this.consecutiveSlowFrames = 0
    this.consecutiveFastFrames = 0
    this.currentIntervalMs = this.TARGET_FRAME_MS
    this.frameHistory.clear()
    this.totalFrames = 0
    this.totalSkipped = 0
    this.lastRenderEnd = 0
    this.frameBudgetExhausted = false
    this.statsCache = null
    this.statsDirty = true
  }

  // --- 内部: 自适应逻辑 (修复 Q3: 迟滞防振荡) ---

  private adapt(frameMs: number): void {
    if (frameMs > this.STALL_THRESHOLD_MS) {
      // 帧停滞 — 快速累积慢帧计数
      this.consecutiveSlowFrames += 3
      this.consecutiveFastFrames = 0
    } else if (frameMs > this.TARGET_FRAME_MS * 1.5) {
      // 帧超时 — 累积慢帧计数
      this.consecutiveSlowFrames++
      this.consecutiveFastFrames = 0  // 慢帧重置快帧计数
    } else {
      // 帧正常 — 累积快帧计数
      this.consecutiveFastFrames++
      // 注意: 快帧不重置慢帧计数，需要连续快帧才能恢复
    }

    // 状态转换 (迟滞: 升级快，降级慢)
    const prevState = this.state

    switch (this.state) {
      case 'normal':
        if (this.consecutiveSlowFrames >= this.SLOW_TO_MINIMAL) {
          this.state = 'minimal'
          this.currentIntervalMs = this.MINIMAL_FRAME_MS
        } else if (this.consecutiveSlowFrames >= this.SLOW_TO_DEGRADED) {
          this.state = 'degraded'
          this.currentIntervalMs = this.DEGRADED_FRAME_MS
        }
        break

      case 'degraded':
        if (this.consecutiveSlowFrames >= this.SLOW_TO_MINIMAL) {
          this.state = 'minimal'
          this.currentIntervalMs = this.MINIMAL_FRAME_MS
        } else if (this.consecutiveFastFrames >= this.DEGRADED_TO_NORMAL) {
          this.state = 'normal'
          this.currentIntervalMs = this.TARGET_FRAME_MS
        }
        break

      case 'minimal':
        // 只有持续大量快帧才能从 minimal 恢复到 degraded
        if (this.consecutiveFastFrames >= this.MINIMAL_TO_DEGRADED) {
          this.state = 'degraded'
          this.currentIntervalMs = this.DEGRADED_FRAME_MS
        }
        // minimal 不直接跳回 normal — 必须经过 degraded
        break
    }

    // 状态变化时重置计数器 + 日志 + 通知间隔监听器
    if (prevState !== this.state) {
      _log(`[stateChange] ${prevState} → ${this.state} (slow=${this.consecutiveSlowFrames} fast=${this.consecutiveFastFrames} interval=${this.currentIntervalMs}ms)`)
      this.consecutiveSlowFrames = 0
      this.consecutiveFastFrames = 0
      // Notify Ink.tsx to re-create scheduleRender throttle with new interval
      for (const listener of this.intervalListeners) {
        try { listener(this.currentIntervalMs) } catch {}
      }
    }
  }
}

// --- 全局单例 (可注入用于测试) ---

let _instance: FrameScheduler | null = null

export function getFrameScheduler(): FrameScheduler {
  if (!_instance) {
    _instance = new FrameScheduler()
  }
  return _instance
}

/**
 * 注入自定义实例 (用于测试, 修复 A3)。
 */
export function setFrameScheduler(instance: FrameScheduler): void {
  _instance = instance
}

export function disposeFrameScheduler(): void {
  _instance = null
}
