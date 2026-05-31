type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

// CPU debug: track setState call frequency
// eslint-disable-next-line no-var
var _setStateCount = 0
// eslint-disable-next-line no-var
var _setStateSampleCounter = 0
// eslint-disable-next-line no-var
var _setStateLastReport = Date.now()
// eslint-disable-next-line no-var
var _listenerNotifyCount = 0
// eslint-disable-next-line no-var
var _listenerSkipCount = 0
// eslint-disable-next-line no-var
var _listenerTotalMs = 0
// eslint-disable-next-line no-var
var _selectorSkipCount = 0
const _CPU_DEBUG = process.env.OLA_CC_CPU_DEBUG === '1'
const _CPU_LOG_FILE = process.env.OLA_CC_CPU_LOG_FILE

// 日志输出函数：写文件或静默（绝不写 stderr，避免破坏 Ink TUI 渲染）
let _logStream: ReturnType<typeof import('fs').createWriteStream> | null = null
function _log(msg: string): void {
  if (!_CPU_DEBUG) return
  if (_CPU_LOG_FILE) {
    if (!_logStream) {
      const fs = require('fs') as typeof import('fs')
      _logStream = fs.createWriteStream(_CPU_LOG_FILE, { flags: 'a' })
    }
    _logStream.write(msg + '\n')
  }
  // When OLA_CC_CPU_LOG_FILE is not set, silently skip logging.
  // Writing to stderr in TUI mode corrupts Ink's terminal rendering.
}

if (_CPU_DEBUG) _log('[cpuDebug] store.ts loaded, debug mode ACTIVE')

/**
 * Compare two selector values. Uses Object.is for primitives and
 * shallow-equal for plain objects/arrays. This prevents unnecessary
 * re-renders when selectors return object references that change
 * identity but have the same content (e.g. goalRuntime?.convergenceState).
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  // Shallow-equal for plain objects
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object)
    const bKeys = Object.keys(b as object)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
      if (!(key in (b as object))) return false
      if (!Object.is((a as any)[key], (b as any)[key])) return false
    }
    return true
  }
  return false
}

/**
 * Selector-aware subscription entry.
 * - selector: extracts a slice from state; listener only notified if slice changes
 * - listener: callback to invoke when selector result changes
 * - lastValue: cached selector result for change detection
 */
interface SubscriptionEntry<T> {
  listener: Listener
  selector?: (state: T) => unknown
  lastValue: unknown
}

/**
 * Deduplication for listener notifications within a synchronous frame.
 *
 * When multiple setState calls happen in the same event-loop turn (e.g.
 * Goal system makes 4 consecutive setState calls), this ensures each
 * listener is only notified once per frame — they'll read the latest
 * consolidated state via getState().
 *
 * The frame boundary is the next microtask after the last setState.
 */
class ListenerDedup {
  private notified: Set<Listener> | null = null

  /** Returns true if this listener has NOT been notified in the current
   *  synchronous frame and should be called. */
  shouldNotify(listener: Listener): boolean {
    if (this.notified?.has(listener)) return false
    if (!this.notified) this.notified = new Set()
    this.notified.add(listener)
    return true
  }

  /** End of synchronous frame — schedule a microtask that resets. */
  scheduleReset() {
    queueMicrotask(() => { this.notified = null })
  }
}

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener, selector?: (state: T) => unknown) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  // Selector-aware subscriptions: each entry tracks its selector and last value
  const subscriptions = new Map<Listener, SubscriptionEntry<T>>()
  const dedup = new ListenerDedup()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
      state = next
      onChange?.({ newState: next, oldState: prev })

      if (_CPU_DEBUG) {
        _setStateCount++
        _setStateSampleCounter++
        if (_setStateSampleCounter >= 100) {
          _setStateSampleCounter = 0
          try {
            throw new Error()
          } catch (e) {
            const stack = (e as Error).stack ?? ''
            const lines = stack.split('\n').filter(l => l.includes('/src/'))
            const topCaller = lines[1] ?? lines[0] ?? 'unknown'
            _log(`[cpuDebug] setState caller: ${topCaller.replace(/.*\/src\//, 'src/').replace(/:\d+:\d+\)?$/, '')}`)
          }
        }
        const now = Date.now()
        if (now - _setStateLastReport >= 1000) {
          const elapsed = (now - _setStateLastReport) / 1000
          const rate = _setStateCount / elapsed
          _log(`[cpuDebug] setState: ${_setStateCount} calls in ${now - _setStateLastReport}ms (${rate.toFixed(0)}/s) | subs: ${subscriptions.size} | notified: ${_listenerNotifyCount} | dedupSkip: ${_listenerSkipCount} | selectorSkip: ${_selectorSkipCount} | listenerMs: ${_listenerTotalMs.toFixed(0)}`)
          _setStateCount = 0
          _listenerNotifyCount = 0
          _listenerSkipCount = 0
          _selectorSkipCount = 0
          _setStateLastReport = now
          _listenerTotalMs = 0
        }
      }

      // Selector-aware notification: only notify listeners whose selector value changed
      const _notifyStart = _CPU_DEBUG ? performance.now() : 0
      for (const [listener, entry] of subscriptions) {
        // Check if selector value changed
        if (entry.selector) {
          const newValue = entry.selector(next)
          if (valuesEqual(newValue, entry.lastValue)) {
            // Selector value unchanged — skip notification
            if (_CPU_DEBUG) _selectorSkipCount++
            continue
          }
          // Update cached value
          entry.lastValue = newValue
        }

        // Deduplication: skip if already notified in this frame
        if (dedup.shouldNotify(listener)) {
          if (_CPU_DEBUG) _listenerNotifyCount++
          listener()
        } else {
          if (_CPU_DEBUG) _listenerSkipCount++
        }
      }
      if (_CPU_DEBUG) {
        _listenerTotalMs += performance.now() - _notifyStart
        // Report which state keys changed to help identify unnecessary re-renders
        if (prev !== next && typeof prev === 'object' && prev !== null && typeof next === 'object' && next !== null) {
          const changedKeys: string[] = []
          for (const key of Object.keys(next as object)) {
            if (!(key in (prev as object)) || (prev as any)[key] !== (next as any)[key]) {
              changedKeys.push(key)
            }
          }
          if (changedKeys.length > 0 && changedKeys.length < 10) {
            _log(`[stateChange] keys=[${changedKeys.join(',')}] subs=${subscriptions.size}`)
          }
        }
      }
      dedup.scheduleReset()
    },

    subscribe: (listener: Listener, selector?: (state: T) => unknown) => {
      // Store subscription with selector and initial cached value
      const entry: SubscriptionEntry<T> = {
        listener,
        selector,
        lastValue: selector ? selector(state) : undefined,
      }
      subscriptions.set(listener, entry)
      if (_CPU_DEBUG) {
        _log(`[subscribe] +1 sub (hasSelector=${!!selector}) total=${subscriptions.size}`)
      }
      return () => subscriptions.delete(listener)
    },
  }
}
