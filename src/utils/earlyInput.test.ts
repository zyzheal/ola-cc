/**
 * Test for earlyInput.ts stopCapturingEarlyInput function
 * Verifies that setRawMode(false) is called to properly reset stdin state
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test'
import {
  startCapturingEarlyInput,
  stopCapturingEarlyInput,
  consumeEarlyInput,
  isCapturingEarlyInput
} from './earlyInput.js'

describe('earlyInput', () => {
  let originalStdin: typeof process.stdin
  let mockStdin: any
  let setRawModeSpy: any

  beforeEach(() => {
    // Save original stdin
    originalStdin = process.stdin

    // Create mock stdin with TTY support
    mockStdin = {
      isTTY: true,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      ref: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      read: vi.fn().mockReturnValue(null),
      removeAllListeners: vi.fn()
    }

    // Replace process.stdin with mock
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      writable: true,
      configurable: true
    })

    setRawModeSpy = mockStdin.setRawMode
  })

  afterEach(() => {
    // Restore original stdin
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      writable: true,
      configurable: true
    })

    // Clean up
    stopCapturingEarlyInput()
    vi.clearAllMocks()
  })

  describe('startCapturingEarlyInput', () => {
    it('should call setRawMode(true) when stdin is TTY', () => {
      startCapturingEarlyInput()
      expect(setRawModeSpy).toHaveBeenCalledWith(true)
    })

    it('should not start capturing when stdin is not TTY', () => {
      mockStdin.isTTY = false
      startCapturingEarlyInput()
      expect(setRawModeSpy).not.toHaveBeenCalled()
      expect(isCapturingEarlyInput()).toBe(false)
    })

    it('should not start capturing when -p flag is present', () => {
      process.argv.push('-p')
      try {
        startCapturingEarlyInput()
        expect(setRawModeSpy).not.toHaveBeenCalled()
        expect(isCapturingEarlyInput()).toBe(false)
      } finally {
        process.argv.pop()
      }
    })
  })

  describe('stopCapturingEarlyInput', () => {
    it('should call setRawMode(false) to reset stdin state', () => {
      // Start capturing first
      startCapturingEarlyInput()
      expect(setRawModeSpy).toHaveBeenCalledTimes(1)
      expect(setRawModeSpy).toHaveBeenCalledWith(true)

      // Stop capturing - should call setRawMode(false)
      stopCapturingEarlyInput()
      expect(setRawModeSpy).toHaveBeenCalledTimes(2)
      expect(setRawModeSpy).toHaveBeenCalledWith(false)
    })

    it('should remove readable listener', () => {
      startCapturingEarlyInput()
      expect(mockStdin.on).toHaveBeenCalledWith('readable', expect.any(Function))

      stopCapturingEarlyInput()
      expect(mockStdin.removeListener).toHaveBeenCalledWith('readable', expect.any(Function))
    })

    it('should be idempotent - can be called multiple times safely', () => {
      startCapturingEarlyInput()
      stopCapturingEarlyInput()

      // Second call should not throw or call setRawMode again
      setRawModeSpy.mockClear()
      stopCapturingEarlyInput()
      expect(setRawModeSpy).not.toHaveBeenCalled()
    })

    it('should handle setRawMode errors gracefully', () => {
      mockStdin.setRawMode.mockImplementation(() => {
        throw new Error('TTY error')
      })

      startCapturingEarlyInput()

      // Should not throw
      expect(() => stopCapturingEarlyInput()).not.toThrow()
    })
  })

  describe('consumeEarlyInput', () => {
    it('should stop capturing and return buffered input', () => {
      startCapturingEarlyInput()

      // Simulate some input by directly adding to buffer (internal)
      // This is a bit hacky but tests the consume path

      const result = consumeEarlyInput()
      expect(result).toBe('') // Empty since no actual input
      expect(setRawModeSpy).toHaveBeenCalledWith(false)
      expect(isCapturingEarlyInput()).toBe(false)
    })
  })

  describe('Node.js 22+ compatibility', () => {
    it('should properly reset raw mode for clean Ink handoff', () => {
      // This test verifies the fix for Node.js 22 raw mode issues
      startCapturingEarlyInput()

      // Verify raw mode was enabled
      expect(setRawModeSpy).toHaveBeenCalledWith(true)

      // Stop capturing - the fix ensures setRawMode(false) is called
      stopCapturingEarlyInput()

      // Verify raw mode was disabled (this is the key fix)
      expect(setRawModeSpy).toHaveBeenCalledWith(false)

      // Verify call order: true then false
      const calls = setRawModeSpy.mock.calls
      expect(calls.length).toBe(2)
      expect(calls[0][0]).toBe(true)
      expect(calls[1][0]).toBe(false)
    })
  })
})
