type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

// CPU debug: track setAppState call frequency
// eslint-disable-next-line no-var
var _setStateCount = 0
// eslint-disable-next-line no-var
var _setStateSampleCounter = 0
var _setStateLastReport = 0
const _CPU_DEBUG = process.env.OLA_CC_CPU_DEBUG === '1'
if (_CPU_DEBUG) console.error('[cpuDebug] store.ts loaded, debug mode ACTIVE')

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

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
        // Sample caller every ~100 calls
        _setStateSampleCounter++
        if (_setStateSampleCounter >= 100) {
          _setStateSampleCounter = 0
          try {
            throw new Error()
          } catch (e) {
            const stack = (e as Error).stack ?? ''
            const lines = stack.split('\n').filter(l => l.includes('/src/'))
            const topCaller = lines[1] ?? lines[0] ?? 'unknown'
            console.error(`[cpuDebug] setState caller: ${topCaller.replace(/.*\/src\//, 'src/').replace(/:\d+:\d+\)?$/, ')')}`)
          }
        }
        const now = Date.now()
        if (now - _setStateLastReport >= 1000) {
          const rate = _setStateCount / ((now - _setStateLastReport) / 1000)
          console.error(`[cpuDebug] setState: ${_setStateCount} calls in ${now - _setStateLastReport}ms (${rate.toFixed(0)}/s)`)
          _setStateCount = 0
          _setStateLastReport = now
        }
      }

      for (const listener of listeners) listener()
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
