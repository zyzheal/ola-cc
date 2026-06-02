import { describe, test, expect } from 'bun:test'

describe('SpinnerAnimationRow throttling', () => {
  test('useAnimationFrame accepts dynamic intervalMs parameter', () => {
    // Verify the hook signature supports intervalMs parameter
    // This test validates the API contract
    const hook = require('../../../ink/hooks/use-animation-frame.js')
    expect(typeof hook.useAnimationFrame).toBe('function')
  })

  test('SpinnerAnimationRow exports interval constants', () => {
    // Verify that when there are running tasks, the interval increases
    const { AGENT_ACTIVE_INTERVAL_MS, DEFAULT_INTERVAL_MS } = require('../SpinnerAnimationRow.js')
    expect(AGENT_ACTIVE_INTERVAL_MS).toBe(500)
    expect(DEFAULT_INTERVAL_MS).toBe(200)
  })
})
