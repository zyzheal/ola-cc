/**
 * CPU 100% regression tests for task/framework.ts
 *
 * These tests protect against:
 * 1. updateTaskState noop — when updater returns same reference, skip
 *    setAppState entirely (avoids triggering subscriber notifications)
 * 2. registerTask retain merge — when re-registering a task (e.g., resume),
 *    carry forward UI-held state (retain, startTime, messages)
 * 3. evictTerminalTask — only evict when terminal + notified + past grace
 */
import { describe, it, expect, vi } from 'bun:test'
import {
  updateTaskState,
  registerTask,
  evictTerminalTask,
} from '../framework.js'
import type { TaskState } from '../types.js'
import { createBasicStore, makeTask } from './helpers.js'

describe('updateTaskState: CPU 100% regression', () => {
  it('should NOT call setAppState when updater returns same reference', () => {
    const store = createBasicStore()
    const task = makeTask()

    // Pre-register the task
    store.setAppState((prev) => ({
      ...prev,
      tasks: { 'task-1': task },
    }))
    const before = store.callCount

    // Updater returns same reference — should be noop
    updateTaskState('task-1', store.setAppState, (t) => t)

    expect(store.callCount).toBe(before)
  })

  it('should call setAppState when updater returns new reference', () => {
    const store = createBasicStore()
    const task = makeTask()

    store.setAppState((prev) => ({
      ...prev,
      tasks: { 'task-1': task },
    }))
    const before = store.callCount

    // Updater returns new reference — should trigger
    updateTaskState('task-1', store.setAppState, (t) => ({
      ...t,
      status: 'completed',
    }))

    expect(store.callCount).toBe(before + 1)
  })

  it('should NOT call setAppState for non-existent task', () => {
    const store = createBasicStore()

    updateTaskState('nonexistent', store.setAppState, (t) => ({
      ...t,
      status: 'completed',
    }))

    expect(store.callCount).toBe(0)
  })
})

describe('registerTask: retain merge', () => {
  it('should merge retain from existing task on re-register', () => {
    const store = createBasicStore()
    const existingTask = makeTask({ retain: true, startTime: 1000 } as any)
    const newTask = makeTask({ retain: false } as any)

    // First register
    store.setAppState((prev) => ({
      ...prev,
      tasks: { 'task-1': existingTask },
    }))

    // Re-register (simulates resume)
    registerTask(newTask as TaskState, store.setAppState)

    const registered = store.getState().tasks?.['task-1'] as any
    expect(registered?.retain).toBe(true)
    expect(registered?.startTime).toBe(1000)
  })
})

describe('evictTerminalTask: CPU 100% regression', () => {
  it('should NOT evict running task', () => {
    const store = createBasicStore()
    const task = makeTask({ status: 'running', notified: true })

    store.setAppState((prev) => ({
      ...prev,
      tasks: { 'task-1': task },
    }))

    evictTerminalTask('task-1', store.setAppState)

    expect(store.getState().tasks?.['task-1']).toBeDefined()
  })

  it('should NOT evict non-notified terminal task', () => {
    const store = createBasicStore()
    const task = makeTask({ status: 'completed', notified: false })

    store.setAppState((prev) => ({
      ...prev,
      tasks: { 'task-1': task },
    }))

    evictTerminalTask('task-1', store.setAppState)

    expect(store.getState().tasks?.['task-1']).toBeDefined()
  })

  it('should evict completed+notified task without retain', () => {
    const store = createBasicStore()
    const task = makeTask({ status: 'completed', notified: true })

    store.setAppState((prev) => ({
      ...prev,
      tasks: { 'task-1': task },
    }))

    evictTerminalTask('task-1', store.setAppState)

    expect(store.getState().tasks?.['task-1']).toBeUndefined()
  })

  it('should NOT evict retained task within grace period', () => {
    const store = createBasicStore()
    const task = makeTask({
      status: 'completed',
      notified: true,
      retain: true,
      evictAfter: Date.now() + 60000,
    } as any)

    store.setAppState((prev) => ({
      ...prev,
      tasks: { 'task-1': task },
    }))

    evictTerminalTask('task-1', store.setAppState)

    expect(store.getState().tasks?.['task-1']).toBeDefined()
  })
})
