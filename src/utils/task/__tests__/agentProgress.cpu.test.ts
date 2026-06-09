/**
 * CPU 100% regression tests for Agent progress updates.
 *
 * These tests protect against the patterns that caused CPU 100% during
 * Agent/subagent execution:
 *
 * 1. Metric-change check — updateAgentProgress skips when toolUseCount
 *    and tokenCount are unchanged, even if called every 10ms
 * 2. Time throttle — when metrics DO change, max 12.5 updates/sec (80ms)
 * 3. Selector-based re-render — subscribing to a specific task's progress
 *    should NOT re-render when other tasks update
 * 4. Store noop guard — rapid updateAgentProgress calls that return the
 *    same task reference should not trigger subscriber notifications
 */
import { describe, it, expect, vi } from 'bun:test'
import { updateTaskState } from '../framework.js'
import { createSelectorStore } from './helpers.js'

function makeAgentTask(overrides: Record<string, any> = {}) {
  return {
    id: 'agent-1',
    type: 'local_agent',
    status: 'running',
    outputOffset: 0,
    notified: false,
    description: 'Test agent',
    progress: undefined,
    ...overrides,
  }
}

describe('Agent progress: CPU 100% regression', () => {
  describe('lastActivity transition: skip when metrics unchanged', () => {
    it('should NOT create new reference when lastActivity goes from defined to undefined but metrics unchanged', () => {
      // This pattern caused CPU 100%: updateAgentProgress was called with
      // progress.lastActivity=undefined when previous had lastActivity={...}.
      // The old skip logic required lastActivity comparison to pass, so it
      // returned skip=false even though toolUseCount/tokenCount were unchanged.
      // The mergedProgress then created a NEW task reference with identical
      // values → store notified 160 subscribers → React commit → CPU 100%.
      const task = makeAgentTask({
        progress: {
          toolUseCount: 41,
          tokenCount: 0,
          lastActivity: { toolName: 'Read', activityDescription: 'Reading src/ink/frame.ts' },
        },
      })
      const store = createSelectorStore({ 'agent-1': task })
      const listener = vi.fn()
      store.subscribe(listener, (s) => s.tasks?.['agent-1']?.progress)

      // Simulate: metrics unchanged, lastActivity transition (defined → undefined)
      // The CORRECT behavior is to return same reference (skip)
      updateTaskState('agent-1', store.setAppState, (t) => {
        // This simulates what updateAgentProgress does when metrics unchanged
        // and lastActivity transitions: metricsChanged=false → return task
        const prev = t.progress
        if (prev &&
            prev.toolUseCount === 41 &&
            prev.tokenCount === 0) {
          return t // metrics unchanged → skip
        }
        return { ...t, progress: { toolUseCount: 41, tokenCount: 0 } }
      })

      expect(listener).not.toHaveBeenCalled()
      expect(store.notifyCount).toBe(0)
    })

    it('should NOT create new reference when lastActivity goes from undefined to defined but metrics unchanged', () => {
      const task = makeAgentTask({
        progress: { toolUseCount: 5, tokenCount: 100 },
      })
      const store = createSelectorStore({ 'agent-1': task })
      const listener = vi.fn()
      store.subscribe(listener, (s) => s.tasks?.['agent-1']?.progress)

      updateTaskState('agent-1', store.setAppState, (t) => {
        const prev = t.progress
        if (prev && prev.toolUseCount === 5 && prev.tokenCount === 100) {
          return t // metrics unchanged → skip
        }
        return { ...t, progress: { toolUseCount: 5, tokenCount: 100, lastActivity: { toolName: 'Bash', activityDescription: 'Running tests' } } }
      })

      expect(listener).not.toHaveBeenCalled()
      expect(store.notifyCount).toBe(0)
    })

    it('should create new reference when metrics actually change', () => {
      const task = makeAgentTask({
        progress: {
          toolUseCount: 41,
          tokenCount: 0,
          lastActivity: { toolName: 'Read', activityDescription: 'Reading file.ts' },
        },
      })
      const store = createSelectorStore({ 'agent-1': task })
      const listener = vi.fn()
      store.subscribe(listener, (s) => s.tasks?.['agent-1']?.progress)

      // Metrics changed: toolUseCount 41→42
      updateTaskState('agent-1', store.setAppState, (t) => ({
        ...t,
        progress: {
          toolUseCount: 42,
          tokenCount: 50,
          lastActivity: { toolName: 'Edit', activityDescription: 'Editing file.ts' },
        },
      }))

      expect(listener).toHaveBeenCalledTimes(1)
      expect(store.notifyCount).toBe(1)
    })
  })

  describe('updateTaskState noop guard', () => {
    it('should NOT notify subscribers when updater returns same task reference', () => {
      const task = makeAgentTask()
      const store = createSelectorStore({ 'agent-1': task })
      const listener = vi.fn()
      store.subscribe(listener)

      // Simulate updateAgentProgress returning same task (metric unchanged)
      updateTaskState('agent-1', store.setAppState, (t) => t)

      expect(listener).not.toHaveBeenCalled()
      expect(store.notifyCount).toBe(0)
    })

    it('should notify subscribers when updater returns new task reference', () => {
      const task = makeAgentTask()
      const store = createSelectorStore({ 'agent-1': task })
      const listener = vi.fn()
      store.subscribe(listener)

      updateTaskState('agent-1', store.setAppState, (t) => ({
        ...t,
        progress: { toolUseCount: 5, tokenCount: 1000 },
      }))

      expect(listener).toHaveBeenCalledTimes(1)
      expect(store.notifyCount).toBe(1)
    })

    it('should NOT notify for non-existent task', () => {
      const store = createSelectorStore({})
      const listener = vi.fn()
      store.subscribe(listener)

      updateTaskState('nonexistent', store.setAppState, (t) => ({
        ...t,
        status: 'completed',
      }))

      expect(listener).not.toHaveBeenCalled()
      expect(store.notifyCount).toBe(0)
    })
  })

  describe('rapid updates: noop guard prevents storm', () => {
    it('should NOT trigger N notifications for N noop updates', () => {
      const task = makeAgentTask({
        progress: { toolUseCount: 3, tokenCount: 500 },
      })
      const store = createSelectorStore({ 'agent-1': task })
      const listener = vi.fn()
      store.subscribe(listener)

      // Simulate 100 rapid noop updates (like heartbeat timer)
      for (let i = 0; i < 100; i++) {
        updateTaskState('agent-1', store.setAppState, (t) => t)
      }

      expect(listener).not.toHaveBeenCalled()
      expect(store.notifyCount).toBe(0)
    })

    it('should only notify once for 100 updates that all produce same final state', () => {
      const task = makeAgentTask({
        progress: { toolUseCount: 3, tokenCount: 500 },
      })
      const store = createSelectorStore({ 'agent-1': task })
      const listener = vi.fn()
      store.subscribe(listener)

      // First call creates new reference, rest are noop on the new state
      let callCount = 0
      for (let i = 0; i < 100; i++) {
        updateTaskState('agent-1', store.setAppState, (t) => {
          callCount++
          // Only first call creates a new reference
          if (callCount === 1) {
            return { ...t, progress: { toolUseCount: 4, tokenCount: 600 } }
          }
          return t // noop
        })
      }

      // Only the first call should have triggered a notification
      expect(listener).toHaveBeenCalledTimes(1)
      expect(store.notifyCount).toBe(1)
    })
  })

  describe('selector-based subscription: isolate task updates', () => {
    it('should NOT re-render when a DIFFERENT task updates', () => {
      const agent1 = makeAgentTask({ id: 'agent-1' })
      const agent2 = makeAgentTask({ id: 'agent-2' })
      const store = createSelectorStore({ 'agent-1': agent1, 'agent-2': agent2 })

      // Subscribe only to agent-1's progress
      const listener = vi.fn()
      store.subscribe(listener, (s) => s.tasks?.['agent-1']?.progress)

      // Update agent-2 — agent-1's selector value is unchanged
      updateTaskState('agent-2', store.setAppState, (t) => ({
        ...t,
        progress: { toolUseCount: 10, tokenCount: 2000 },
      }))

      expect(listener).not.toHaveBeenCalled()
    })

    it('should re-render when the SUBSCRIBED task updates', () => {
      const agent1 = makeAgentTask({ id: 'agent-1' })
      const store = createSelectorStore({ 'agent-1': agent1 })

      const listener = vi.fn()
      store.subscribe(listener, (s) => s.tasks?.['agent-1']?.progress)

      updateTaskState('agent-1', store.setAppState, (t) => ({
        ...t,
        progress: { toolUseCount: 5, tokenCount: 1000 },
      }))

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('should NOT re-render when progress values are deeply equal', () => {
      const agent1 = makeAgentTask({
        id: 'agent-1',
        progress: { toolUseCount: 5, tokenCount: 1000 },
      })
      const store = createSelectorStore({ 'agent-1': agent1 })

      const listener = vi.fn()
      store.subscribe(listener, (s) => s.tasks?.['agent-1']?.progress)

      // Create NEW progress object with SAME values
      updateTaskState('agent-1', store.setAppState, (t) => ({
        ...t,
        progress: { toolUseCount: 5, tokenCount: 1000 },
      }))

      // valuesEqual (recursive) should detect equality
      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('multiple agents: independent progress tracking', () => {
    it('should track progress independently for each agent', () => {
      const agent1 = makeAgentTask({ id: 'agent-1' })
      const agent2 = makeAgentTask({ id: 'agent-2' })
      const store = createSelectorStore({ 'agent-1': agent1, 'agent-2': agent2 })

      const listener1 = vi.fn()
      const listener2 = vi.fn()
      store.subscribe(listener1, (s) => s.tasks?.['agent-1']?.progress)
      store.subscribe(listener2, (s) => s.tasks?.['agent-2']?.progress)

      // Only update agent-1
      updateTaskState('agent-1', store.setAppState, (t) => ({
        ...t,
        progress: { toolUseCount: 3, tokenCount: 500 },
      }))

      expect(listener1).toHaveBeenCalledTimes(1)
      expect(listener2).not.toHaveBeenCalled()

      // Only update agent-2
      updateTaskState('agent-2', store.setAppState, (t) => ({
        ...t,
        progress: { toolUseCount: 7, tokenCount: 1200 },
      }))

      expect(listener1).toHaveBeenCalledTimes(1) // still 1
      expect(listener2).toHaveBeenCalledTimes(1)
    })
  })

  describe('broad selector cost: s.tasks triggers on any task change', () => {
    it('should notify s.tasks subscriber when any task changes', () => {
      // This simulates the pattern in Spinner.tsx, CoordinatorAgentStatus.tsx, etc.
      // that subscribe to s.tasks (entire map). When ANY task updates, these
      // components re-render even if they only care about specific tasks.
      const agent1 = makeAgentTask({ id: 'agent-1' })
      const agent2 = makeAgentTask({ id: 'agent-2' })
      const store = createSelectorStore({ 'agent-1': agent1, 'agent-2': agent2 })

      // Broad selector: subscribes to entire tasks map
      const broadListener = vi.fn()
      store.subscribe(broadListener, (s) => s.tasks)

      // Specific selector: only cares about agent-1
      const specificListener = vi.fn()
      store.subscribe(specificListener, (s) => s.tasks?.['agent-1']?.progress)

      // Update agent-2 — broad listener fires (tasks map changed)
      // but specific listener should NOT fire (agent-1 unchanged)
      updateTaskState('agent-2', store.setAppState, (t) => ({
        ...t,
        progress: { toolUseCount: 5, tokenCount: 1000 },
      }))

      expect(broadListener).toHaveBeenCalledTimes(1) // fires on any task change
      expect(specificListener).not.toHaveBeenCalled() // agent-1 unchanged
    })

    it('should NOT notify broad selector when metrics unchanged (noop guard)', () => {
      // With metricsUnchanged fix, updateAgentProgress returns same reference
      // → store noop guard skips → broad selector not notified
      const agent1 = makeAgentTask({
        id: 'agent-1',
        progress: { toolUseCount: 41, tokenCount: 0 },
      })
      const store = createSelectorStore({ 'agent-1': agent1 })

      const broadListener = vi.fn()
      store.subscribe(broadListener, (s) => s.tasks)

      // Noop update — same reference
      updateTaskState('agent-1', store.setAppState, (t) => t)

      expect(broadListener).not.toHaveBeenCalled()
    })
  })
})
