import { expect, test, describe } from 'bun:test'
import { stringWidthWasmSync, isWasmAvailable } from '../wasm/stringWidth.js'
import { stringWidth } from '../ink/stringWidth.js'

describe('stringWidthWasmSync', () => {
  test('empty string returns 0', () => {
    expect(stringWidthWasmSync('')).toBe(0)
  })

  test('ASCII string', () => {
    expect(stringWidthWasmSync('hello')).toBe(5)
    expect(stringWidthWasmSync('Hello World!')).toBe(12)
  })

  test('CJK characters', () => {
    // Chinese characters are typically width 2
    expect(stringWidthWasmSync('\u4E2D')).toBe(2)
    expect(stringWidthWasmSync('\u4E2D\u6587')).toBe(4)
  })

  test('emoji', () => {
    // Emoji are width 2
    expect(stringWidthWasmSync('\u{1F600}')).toBe(2)
  })

  test('ANSI escape sequences are stripped', () => {
    const colored = '\x1b[31mred\x1b[0m'
    expect(stringWidthWasmSync(colored)).toBe(3)
  })

  test('combining marks are zero-width', () => {
    // e + combining acute accent
    expect(stringWidthWasmSync('e\u0301')).toBe(1)
  })

  test('mixed ASCII and CJK', () => {
    expect(stringWidthWasmSync('hello\u4E2D')).toBe(7) // 5 + 2
  })
})

describe('WASM availability', () => {
  test('falls back to JS when WASM is not available', () => {
    // WASM may or may not be loaded, but the fallback should work
    const result = stringWidthWasmSync('hello')
    expect(result).toBe(5)
  })
})

describe('consistency with fallback', () => {
  test('ASCII strings match', () => {
    expect(stringWidthWasmSync('hello world')).toBe(stringWidth('hello world'))
  })

  test('CJK strings match', () => {
    expect(stringWidthWasmSync('\u4E2D\u6587')).toBe(stringWidth('\u4E2D\u6587'))
  })
})
