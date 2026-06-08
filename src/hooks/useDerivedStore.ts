/**
 * useDerivedStore — subscribes to AppState and only triggers React re-render
 * when a *derived* value changes, not on every raw state reference change.
 *
 * Problem: `useAppState(s => s.tasks)` re-renders on every task update because
 * the tasks map reference changes. But components often only need derived data
 * (e.g. count of running tasks, a specific task by ID).
 *
 * Solution: subscribe to the store with a selector function that reads from
 * a ref (so it always uses the latest derive), leveraging the store's
 * selectorSkip mechanism. The store will call our selector on every setState,
 * compare the result with lastValue via valuesEqual, and skip our listener
 * if the value hasn't changed. This is critical: without selector-level
 * filtering, every store.update calls our listener (166+ per update), even
 * though isEqual would skip setSnapshot — the listener execution itself is
 * expensive.
 *
 * Uses useState + useEffect (same as useAppState) to avoid useSyncExternalStore's
 * SyncLane synchronous render which blocks the event loop with 165+ subscribers.
 *
 * IMPORTANT: Do NOT use useSyncExternalStore here. See AppState.tsx:189-195
 * for the rationale.
 */
import { useEffect, useRef, useState } from 'react'
import { useAppStateStore } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'

const STRICT_EQUALITY = <T,>(a: T, b: T): boolean => a === b

export function useDerivedStore<T>(
  derive: (state: AppState) => T,
  isEqual: (a: T, b: T) => boolean = STRICT_EQUALITY,
): T {
  const store = useAppStateStore()
  const [snapshot, setSnapshot] = useState(() => derive(store.getState()))

  // Always use latest derive/isEqual without causing re-subscribe
  const deriveRef = useRef(derive)
  const isEqualRef = useRef(isEqual)
  deriveRef.current = derive
  isEqualRef.current = isEqual

  useEffect(() => {
    // Compute initial snapshot in case derive changed
    const initial = deriveRef.current(store.getState())
    setSnapshot(prev => isEqualRef.current(prev, initial) ? prev : initial)

    // The selector reads from deriveRef so it always uses the latest derive
    // function. The store compares selector results via valuesEqual and
    // skips our listener if the derived value hasn't changed (selectorSkip).
    const dynamicSelector = (state: AppState) => deriveRef.current(state)

    // Use store.subscribe with selector — this leverages the store's
    // selectorSkip mechanism to avoid calling our listener when the
    // derived value hasn't changed at the selector level.
    const unsubscribe = store.subscribe(() => {
      // Even if selector said the value changed (selectorNotify), we
      // still apply isEqual as a secondary guard for structural equality
      // (e.g. two arrays with same contents but different references).
      const next = deriveRef.current(store.getState())
      setSnapshot(prev => isEqualRef.current(prev, next) ? prev : next)
    }, dynamicSelector)

    return unsubscribe
  }, [store])

  return snapshot
}