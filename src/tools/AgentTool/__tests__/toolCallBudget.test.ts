import { describe, test, expect } from 'bun:test'
import { getMaxToolCalls } from '../toolCallBudget.js'

describe('ToolCallBudget', () => {
  test('getMaxToolCalls returns env var when set', () => {
    const original = process.env.OLA_CC_TOOL_CALL_BUDGET
    process.env.OLA_CC_TOOL_CALL_BUDGET = '25'
    const result = getMaxToolCalls(undefined)
    expect(result).toBe(25)
    if (original !== undefined) {
      process.env.OLA_CC_TOOL_CALL_BUDGET = original
    } else {
      delete process.env.OLA_CC_TOOL_CALL_BUDGET
    }
  })

  test('getMaxToolCalls returns agent budget when no env var', () => {
    const original = process.env.OLA_CC_TOOL_CALL_BUDGET
    delete process.env.OLA_CC_TOOL_CALL_BUDGET
    const result = getMaxToolCalls(30)
    expect(result).toBe(30)
    if (original !== undefined) {
      process.env.OLA_CC_TOOL_CALL_BUDGET = original
    }
  })

  test('getMaxToolCalls returns default 40 when nothing set', () => {
    const original = process.env.OLA_CC_TOOL_CALL_BUDGET
    delete process.env.OLA_CC_TOOL_CALL_BUDGET
    const result = getMaxToolCalls(undefined)
    expect(result).toBe(40)
    if (original !== undefined) {
      process.env.OLA_CC_TOOL_CALL_BUDGET = original
    }
  })

  test('getMaxToolCalls returns undefined when env var is 0 or -1', () => {
    const original = process.env.OLA_CC_TOOL_CALL_BUDGET
    process.env.OLA_CC_TOOL_CALL_BUDGET = '0'
    expect(getMaxToolCalls(undefined)).toBeUndefined()
    process.env.OLA_CC_TOOL_CALL_BUDGET = '-1'
    expect(getMaxToolCalls(undefined)).toBeUndefined()
    if (original !== undefined) {
      process.env.OLA_CC_TOOL_CALL_BUDGET = original
    } else {
      delete process.env.OLA_CC_TOOL_CALL_BUDGET
    }
  })

  test('getMaxToolCalls: env var overrides agent budget', () => {
    const original = process.env.OLA_CC_TOOL_CALL_BUDGET
    process.env.OLA_CC_TOOL_CALL_BUDGET = '100'
    expect(getMaxToolCalls(30)).toBe(100)
    if (original !== undefined) {
      process.env.OLA_CC_TOOL_CALL_BUDGET = original
    } else {
      delete process.env.OLA_CC_TOOL_CALL_BUDGET
    }
  })

  test('getMaxToolCalls: NaN env var falls back to agent budget', () => {
    const original = process.env.OLA_CC_TOOL_CALL_BUDGET
    process.env.OLA_CC_TOOL_CALL_BUDGET = 'invalid'
    expect(getMaxToolCalls(30)).toBe(30)
    if (original !== undefined) {
      process.env.OLA_CC_TOOL_CALL_BUDGET = original
    } else {
      delete process.env.OLA_CC_TOOL_CALL_BUDGET
    }
  })
})
