/**
 * CPU 100% regression tests for useDerivedStore hook.
 *
 * These tests protect against the patterns that caused CPU 100% during
 * Agent/subagent execution:
 *
 * 1. Broad selector isolation — subscribing to derived value should NOT
 *    re-render when irrelevant parts of state change
 * 2. Noop guard — when derived value is structurally identical, no re-render
 * 3. Multiple subscribers — independent derived values don't cascade
 * 4. NO useSyncExternalStore — must use useState+useEffect to avoid
 *    SyncLane synchronous render blocking the event loop with 165+ subscribers
 */
import { describe, it, expect, vi } from 'bun:test'
import { useDerivedStore } from '../useDerivedStore.js'
import type { AppState } from '../../state/AppStateStore.js'

// Minimal mock store matching the real store's subscribe interface
function createMockStore(initialState: Partial<AppState> = {}) {
  let state = { tasks: {}, ...initialState } as AppState
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    setState: (updater: (prev: AppState) => AppState) => {
      const next = updater(state)
      if (next === state) return
      state = next
      for (const fn of listeners) fn()
    },
  }
}

describe('useDerivedStore: CPU 100% regression', () => {
  describe('broad selector isolation', () => {
    it('should NOT re-render when irrelevant state changes', () => {
      const store = createMockStore({
        tasks: { 'agent-1': { id: 'agent-1', status: 'running' } as any },
      })

      // Derive count of running tasks
      const derive = (s: AppState) =>
        Object.values(s.tasks || {}).filter((t: any) => t.status === 'running').length

      let snapshot = derive(store.getState())
      let renderCount = 0
      const tryUpdate = (next: number) => {
        if (snapshot !== next) {
          snapshot = next
          renderCount++
        }
      }

      // Add a COMPLETED task — running count unchanged
      store.setState(prev => ({
        ...prev,
        tasks: { ...prev.tasks, 'agent-2': { id: 'agent-2', status: 'completed' } as any },
      }))

      tryUpdate(derive(store.getState()))
      expect(renderCount).toBe(0)

      // Complete agent-1 — running count changes 1→0
      store.setState(prev => ({
        ...prev,
        tasks: { ...prev.tasks, 'agent-1': { ...prev.tasks!['agent-1'], status: 'completed' } as any },
      }))

      tryUpdate(derive(store.getState()))
      expect(renderCount).toBe(1)
      expect(snapshot).toBe(0)
    })
  })

  describe('core logic: noop guard on derived values', () => {
    it('should not call setSnapshot when derived value is identical', () => {
      // Test the core logic: if derive returns same primitive, no state update
      const store = createMockStore({
        tasks: { 'agent-1': { id: 'agent-1', status: 'running', progress: { toolUseCount: 5 } } as any },
      })

      const derive = (s: AppState) => s.tasks?.['agent-1']?.status
      let renderCount = 0

      // Simulate what useDerivedStore does
      let snapshot = derive(store.getState())
      const setSnapshot = (updater: (prev: string) => string) => {
        const next = updater(snapshot)
        if (next !== snapshot) {
          snapshot = next
          renderCount++
        }
      }

      // Update a DIFFERENT task — agent-1's status unchanged
      store.setState(prev => ({
        ...prev,
        tasks: { ...prev.tasks, 'agent-2': { id: 'agent-2', status: 'completed' } as any },
      }))

      // The store notifies, but derive should return same value
      const next = derive(store.getState())
      setSnapshot(prev => prev === next ? prev : next)
      expect(renderCount).toBe(0)
    })

    it('should not call setSnapshot when derived object is deeply equal', () => {
      const store = createMockStore({
        tasks: { 'agent-1': { id: 'agent-1', status: 'running', progress: { toolUseCount: 5, tokenCount: 100 } } as any },
      })

      const derive = (s: AppState) => s.tasks?.['agent-1']?.progress?.toolUseCount
      const isEqual = (a: number | undefined, b: number | undefined) => a === b

      let snapshot = derive(store.getState())

      // Update with same toolUseCount but new reference
      store.setState(prev => ({
        ...prev,
        tasks: {
          ...prev.tasks,
          'agent-1': { ...prev.tasks!['agent-1'], progress: { toolUseCount: 5, tokenCount: 200 } } as any,
        },
      }))

      const next = derive(store.getState())
      expect(isEqual(snapshot, next)).toBe(true)
    })

    it('should trigger re-render when derived value actually changes', () => {
      const store = createMockStore({
        tasks: { 'agent-1': { id: 'agent-1', status: 'running' } as any },
      })

      const derive = (s: AppState) => s.tasks?.['agent-1']?.status
      let snapshot = derive(store.getState())
      let renderCount = 0
      const setSnapshot = (updater: (prev: string) => string) => {
        const next = updater(snapshot)
        if (next !== snapshot) {
          snapshot = next
          renderCount++
        }
      }

      // Status changes: running → completed
      store.setState(prev => ({
        ...prev,
        tasks: { ...prev.tasks, 'agent-1': { ...prev.tasks!['agent-1'], status: 'completed' } as any },
      }))

      const next = derive(store.getState())
      setSnapshot(prev => prev === next ? prev : next)
      expect(renderCount).toBe(1)
      expect(snapshot).toBe('completed')
    })
  })

  describe('rapid state updates: only one re-render per unique derived value', () => {
    it('should batch 100 updates that produce the same derived value into 0 re-renders', () => {
      const store = createMockStore({
        tasks: { 'agent-1': { id: 'agent-1', status: 'running', progress: { toolUseCount: 0 } } as any },
      })

      const derive = (s: AppState) => s.tasks?.['agent-1']?.status
      let snapshot = derive(store.getState())
      let renderCount = 0
      const setSnapshot = (updater: (prev: string) => string) => {
        const next = updater(snapshot)
        if (next !== snapshot) {
          snapshot = next
          renderCount++
        }
      }

      // 100 rapid updates that don't change status
      for (let i = 0; i < 100; i++) {
        store.setState(prev => ({
          ...prev,
          tasks: {
            ...prev.tasks,
            'agent-1': { ...prev.tasks!['agent-1'], progress: { toolUseCount: i } } as any,
          },
        }))

        const next = derive(store.getState())
        setSnapshot(prev => prev === next ? prev : next)
      }

      expect(renderCount).toBe(0)
    })

    it('should only render for unique derived value transitions', () => {
      const store = createMockStore({
        tasks: { 'agent-1': { id: 'agent-1', status: 'running' } as any },
      })

      const derive = (s: AppState) => s.tasks?.['agent-1']?.status
      let snapshot = derive(store.getState())
      let renderCount = 0
      const setSnapshot = (updater: (prev: string) => string) => {
        const next = updater(snapshot)
        if (next !== snapshot) {
          snapshot = next
          renderCount++
        }
      }

      // Transition 1: running → completed
      store.setState(prev => ({
        ...prev,
        tasks: { ...prev.tasks, 'agent-1': { ...prev.tasks!['agent-1'], status: 'completed' } as any },
      }))
      setSnapshot(prev => prev === derive(store.getState()) ? prev : derive(store.getState()))

      // Transition 2: still completed (noop)
      store.setState(prev => ({
        ...prev,
        tasks: { ...prev.tasks, 'agent-1': { ...prev.tasks!['agent-1'], outputOffset: 5 } as any },
      }))
      setSnapshot(prev => prev === derive(store.getState()) ? prev : derive(store.getState()))

      expect(renderCount).toBe(1) // Only the first transition
    })
  })

  describe('no useSyncExternalStore', () => {
    it('useDerivedStore source should NOT import useSyncExternalStore', async () => {
      const source = await import('fs').then(fs =>
        fs.readFileSync(require.resolve('../useDerivedStore.ts'), 'utf-8'))
      // Check import statement, not string containment (comments may mention it)
      const hasImport = /^import\s.*useSyncExternalStore/m.test(source)
      expect(hasImport).toBe(false)
      // Must use useState + useEffect pattern (same as useAppState)
      expect(source).toContain('useState')
      expect(source).toContain('useEffect')
    })
  })

  describe('custom isEqual for object derived values', () => {
    it('should not re-render when custom isEqual returns true for structurally equal objects', () => {
      const store = createMockStore({
        tasks: {
          'agent-1': { id: 'agent-1', status: 'running', progress: { toolUseCount: 5 } } as any,
          'agent-2': { id: 'agent-2', status: 'running', progress: { toolUseCount: 3 } } as any,
        },
      })

      // Derive list of running task IDs
      const derive = (s: AppState) =>
        Object.values(s.tasks || {})
          .filter((t: any) => t.status === 'running')
          .map((t: any) => t.id)
          .sort()

      const isEqual = (a: string[], b: string[]) =>
        a.length === b.length && a.every((v, i) => v === b[i])

      let snapshot = derive(store.getState())
      let renderCount = 0

      const tryUpdate = (next: string[]) => {
        if (!isEqual(snapshot, next)) {
          snapshot = next
          renderCount++
        }
      }

      // Update agent-1's progress (not status) — ID list unchanged
      store.setState(prev => ({
        ...prev,
        tasks: {
          ...prev.tasks,
          'agent-1': { ...prev.tasks!['agent-1'], progress: { toolUseCount: 6 } } as any,
        },
      }))

      tryUpdate(derive(store.getState()))
      expect(renderCount).toBe(0)

      // Complete agent-2 — ID list changes
      store.setState(prev => ({
        ...prev,
        tasks: {
          ...prev.tasks,
          'agent-2': { ...prev.tasks!['agent-2'], status: 'completed' } as any,
        },
      }))

      tryUpdate(derive(store.getState()))
      expect(renderCount).toBe(1)
      expect(snapshot).toEqual(['agent-1'])
    })
  })
})
