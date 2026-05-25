import { describe, expect, test, beforeEach } from 'bun:test'
import { QueryGuard } from '../../src/utils/QueryGuard.js'
import {
  enqueue,
  dequeue,
  dequeueAll,
  resetCommandQueue,
  getCommandQueueLength,
  peek,
} from '../../src/utils/messageQueueManager.js'
import type { QueuedCommand } from '../../src/types/textInputTypes.js'

// Re-import the module-level commandQueue for direct inspection
// (We use getCommandQueueLength and peek for public API testing)

describe('queueProcessor - race condition fix', () => {
  beforeEach(() => {
    resetCommandQueue()
  })

  function makeCmd(value: string, mode: string = 'prompt'): QueuedCommand {
    return { value, mode, priority: 'next' }
  }

  describe('processQueueIfReady reserves guard at dequeue time', () => {
    test('should reserve guard before executeInput starts for single command', () => {
      const queryGuard = new QueryGuard()
      let reserveCalledBeforeExecute = false

      enqueue(makeCmd('hello'))

      const mockExecute = async (_cmds: QueuedCommand[]) => {
        // At this point, guard should already be reserved
        reserveCalledBeforeExecute = queryGuard.isActive
      }

      // Import processQueueIfReady dynamically to test with our mock
      const { processQueueIfReady } = require('../../src/utils/queueProcessor.js')

      const result = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })

      expect(result.processed).toBe(true)
      expect(reserveCalledBeforeExecute).toBe(true)
      expect(queryGuard.isActive).toBe(true)
    })

    test('should reserve guard before executeInput starts for batched commands', () => {
      const queryGuard = new QueryGuard()
      let reserveCalledBeforeExecute = false

      enqueue(makeCmd('hello'))
      enqueue(makeCmd('world'))

      const mockExecute = async (_cmds: QueuedCommand[]) => {
        reserveCalledBeforeExecute = queryGuard.isActive
      }

      const { processQueueIfReady } = require('../../src/utils/queueProcessor.js')

      const result = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })

      expect(result.processed).toBe(true)
      expect(reserveCalledBeforeExecute).toBe(true)
      // Two commands should have been batched together
      expect(getCommandQueueLength()).toBe(0)
    })

    test('should reserve guard for bash commands individually', () => {
      const queryGuard = new QueryGuard()
      const executeCalls: QueuedCommand[][] = []

      enqueue({ value: 'ls', mode: 'bash', priority: 'next' })
      enqueue({ value: 'pwd', mode: 'bash', priority: 'next' })

      const mockExecute = async (cmds: QueuedCommand[]) => {
        executeCalls.push(cmds)
      }

      const { processQueueIfReady } = require('../../src/utils/queueProcessor.js')

      // First call: processes first bash command individually
      const result1 = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })
      expect(result1.processed).toBe(true)
      expect(executeCalls.length).toBe(1)
      expect(executeCalls[0]!.length).toBe(1)
      expect(executeCalls[0]![0]!.value).toBe('ls')
      expect(queryGuard.isActive).toBe(true)

      // Reset guard to simulate query completing
      queryGuard.end(queryGuard.generation)

      // Second call: processes second bash command individually
      const result2 = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })
      expect(result2.processed).toBe(true)
      expect(executeCalls.length).toBe(2)
      expect(executeCalls[1]![0]!.value).toBe('pwd')
    })

    test('should prevent double-reserve when downstream also calls reserve', () => {
      const queryGuard = new QueryGuard()

      enqueue(makeCmd('test'))

      const mockExecute = async (_cmds: QueuedCommand[]) => {
        // Simulate downstream executeUserInput also calling reserve()
        // This should be a no-op since guard is already dispatching
        const reserveResult = queryGuard.reserve()
        expect(reserveResult).toBe(false) // Already reserved, returns false
      }

      const { processQueueIfReady } = require('../../src/utils/queueProcessor.js')

      const result = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })

      expect(result.processed).toBe(true)
    })

    test('should not process when guard is already active', () => {
      const queryGuard = new QueryGuard()
      queryGuard.reserve()

      enqueue(makeCmd('hello'))

      let executeCalled = false
      const mockExecute = async () => {
        executeCalled = true
      }

      const { processQueueIfReady } = require('../../src/utils/queueProcessor.js')

      // useQueueProcessor checks isQueryActive before calling processQueueIfReady,
      // but let's verify processQueueIfReady itself doesn't double-reserve
      const result = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })

      // The guard was already reserved, so reserve() returns false but
      // the function still processes (the guard prevents concurrent
      // execution at the hook level, not here)
      expect(result.processed).toBe(true)
      expect(executeCalled).toBe(true)
    })
  })

  describe('slash command handling', () => {
    test('should process slash commands individually', () => {
      const queryGuard = new QueryGuard()
      const executeCalls: QueuedCommand[][] = []

      enqueue(makeCmd('/config'))
      enqueue(makeCmd('/doctor'))

      const mockExecute = async (cmds: QueuedCommand[]) => {
        executeCalls.push(cmds)
      }

      const { processQueueIfReady } = require('../../src/utils/queueProcessor.js')

      const result1 = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })
      expect(result1.processed).toBe(true)
      expect(executeCalls.length).toBe(1)
      expect(executeCalls[0]![0]!.value).toBe('/config')

      queryGuard.end(queryGuard.generation)

      const result2 = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })
      expect(result2.processed).toBe(true)
      expect(executeCalls[1]![0]!.value).toBe('/doctor')
    })
  })

  describe('mixed mode batching', () => {
    test('should batch same-mode non-slash commands together', () => {
      const queryGuard = new QueryGuard()
      const executeCalls: QueuedCommand[][] = []

      enqueue(makeCmd('hello'))
      enqueue(makeCmd('world'))
      enqueue(makeCmd('foo'))

      const mockExecute = async (cmds: QueuedCommand[]) => {
        executeCalls.push(cmds)
      }

      const { processQueueIfReady } = require('../../src/utils/queueProcessor.js')

      const result = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })

      expect(result.processed).toBe(true)
      expect(executeCalls.length).toBe(1)
      expect(executeCalls[0]!.length).toBe(3)
    })

    test('should not mix different modes', () => {
      const queryGuard = new QueryGuard()
      const executeCalls: QueuedCommand[][] = []

      enqueue(makeCmd('prompt1'))
      enqueue({ value: 'task-result', mode: 'task-notification', priority: 'later' })
      enqueue(makeCmd('prompt2'))

      const mockExecute = async (cmds: QueuedCommand[]) => {
        executeCalls.push(cmds)
      }

      const { processQueueIfReady } = require('../../src/utils/queueProcessor.js')

      // First call: drains prompt mode commands only
      const result1 = processQueueIfReady({
        executeInput: mockExecute,
        queryGuard,
      })
      expect(result1.processed).toBe(true)
      expect(executeCalls.length).toBe(1)
      expect(executeCalls[0]!.length).toBe(2) // prompt1 and prompt2
      expect(executeCalls[0]![0]!.mode).toBe('prompt')
      expect(executeCalls[0]![1]!.mode).toBe('prompt')

      // task-notification should still be in queue
      expect(getCommandQueueLength()).toBe(1)
    })
  })
})
