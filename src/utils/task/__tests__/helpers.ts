/**
 * Shared test helpers for CPU 100% regression tests.
 *
 * Provides mock stores that mirror real store.ts behavior:
 * - noop guard: skip state update when updater returns same reference
 * - valuesEqual: recursive shallow-equal for selector change detection
 * - selector-aware subscriptions: only notify when selected slice changes
 */
import type { AppState } from '../../../state/AppState.js'
import type { TaskState } from '../types.js'

/**
 * Recursive shallow-equal check — mirrors store.ts valuesEqual.
 * Prevents false-positive change detection on nested objects with
 * identical values but different references.
 */
export function valuesEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && depth < 3) {
    const aObj = a as object
    const bObj = b as object
    const aKeys = Object.keys(aObj)
    const bKeys = Object.keys(bObj)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
      if (!(key in bObj)) return false
      if (!valuesEqual((aObj as any)[key], (bObj as any)[key], depth + 1)) return false
    }
    return true
  }
  return false
}

/**
 * Basic mock store with noop guard — for framework.ts tests.
 * Tracks callCount to verify setAppState invocation count.
 */
export function createBasicStore(initialTasks: Record<string, TaskState> = {}) {
  let state: AppState = { tasks: initialTasks } as AppState
  let callCount = 0
  return {
    getState: () => state,
    get callCount() { return callCount },
    setAppState: (updater: (prev: AppState) => AppState) => {
      const next = updater(state)
      if (next === state) return
      state = next
      callCount++
    },
  }
}

/**
 * Selector-aware mock store — for agentProgress tests.
 * Mirrors store.ts subscribe(selector) behavior: only notifies
 * listeners whose selector value changed (via recursive valuesEqual).
 */
export function createSelectorStore(initialTasks: Record<string, any> = {}) {
  let state: AppState = { tasks: initialTasks } as any
  let notifyCount = 0
  const subscriptions = new Map<() => void, { selector?: (s: AppState) => unknown; lastValue: unknown }>()

  return {
    getState: () => state,
    get notifyCount() { return notifyCount },
    setAppState: (updater: (prev: AppState) => AppState) => {
      const next = updater(state)
      if (next === state) return
      state = next
      notifyCount++
      for (const [fn, entry] of subscriptions) {
        if (entry.selector) {
          const newValue = entry.selector(state)
          if (valuesEqual(newValue, entry.lastValue)) continue
          entry.lastValue = newValue
        }
        fn()
      }
    },
    subscribe: (fn: () => void, selector?: (s: AppState) => unknown) => {
      subscriptions.set(fn, {
        selector,
        lastValue: selector ? selector(state) : undefined,
      })
      return () => { subscriptions.delete(fn) }
    },
  }
}

/**
 * Create a minimal TaskState for tests.
 */
export function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    status: 'running',
    outputOffset: 0,
    notified: false,
    description: 'Test task',
    ...overrides,
  } as TaskState
}
