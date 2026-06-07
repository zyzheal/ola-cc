import { describe, it, expect } from 'bun:test'
import { tokenizeCJK, jaccardSimilarity, textSimilarity, containsCJK } from './tokenizer'

describe('tokenizeCJK', () => {
  it('tokenizes ASCII text into words', () => {
    expect(tokenizeCJK('hello world')).toEqual(['hello', 'world'])
  })

  it('handles CamelCase', () => {
    const tokens = tokenizeCJK('FileReadTool')
    expect(tokens).toContain('filereadtool')
  })

  it('tokenizes CJK text into bigrams', () => {
    expect(tokenizeCJK('你好世界')).toEqual(['你好', '好世', '世界'])
  })

  it('handles single CJK character', () => {
    expect(tokenizeCJK('你')).toEqual(['你'])
  })

  it('handles mixed CJK and ASCII', () => {
    const tokens = tokenizeCJK('read文件')
    expect(tokens).toContain('read')
    expect(tokens).toContain('文件') // bigram of 2 CJK chars
  })

  it('treats punctuation as separators', () => {
    expect(tokenizeCJK('hello, world!')).toEqual(['hello', 'world'])
  })

  it('handles empty string', () => {
    expect(tokenizeCJK('')).toEqual([])
  })

  it('handles numbers in text', () => {
    const tokens = tokenizeCJK('read123file')
    expect(tokens).toContain('read123file')
  })

  it('handles Japanese hiragana/katakana', () => {
    const tokens = tokenizeCJK('こんにちは')
    expect(tokens.length).toBe(4) // こん, んに, にち, ちは
  })

  it('handles Korean hangul', () => {
    const tokens = tokenizeCJK('안녕하세요')
    expect(tokens.length).toBe(4)
  })
})

describe('jaccardSimilarity', () => {
  it('returns 0 for completely different sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0)
  })

  it('returns 1 for identical sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['a', 'b'])).toBe(1)
  })

  it('returns 0.5 for partial overlap', () => {
    // intersection = {a}, union = {a,b,c} → 1/3
    expect(jaccardSimilarity(['a', 'b'], ['a', 'c'])).toBeCloseTo(1/3, 5)
  })

  it('returns 0 for both empty', () => {
    expect(jaccardSimilarity([], [])).toBe(0)
  })

  it('returns 0 for one empty', () => {
    expect(jaccardSimilarity(['a'], [])).toBe(0)
  })

  it('handles duplicate tokens', () => {
    // duplicates are collapsed by Set
    expect(jaccardSimilarity(['a', 'a', 'b'], ['a', 'b'])).toBe(1)
  })
})

describe('textSimilarity', () => {
  it('returns >0 for similar Chinese text', () => {
    const sim = textSimilarity('你好世界', '世界你好')
    expect(sim).toBeGreaterThan(0)
    // Bigrams: {你好,好世,世界} vs {世界,界你,你好} → intersection=2, union=4
    expect(sim).toBeCloseTo(2/4, 5)
  })

  it('returns 0 for completely different CJK text', () => {
    expect(textSimilarity('你好', '再见')).toBe(0)
  })

  it('returns >0 for similar English text', () => {
    const sim = textSimilarity('hello world', 'hello there')
    expect(sim).toBeGreaterThan(0)
  })

  it('handles empty strings', () => {
    expect(textSimilarity('', '')).toBe(0)
  })

  it('returns 0 for one empty', () => {
    expect(textSimilarity('hello', '')).toBe(0)
  })
})

describe('containsCJK', () => {
  it('detects Chinese characters', () => {
    expect(containsCJK('你好')).toBe(true)
  })

  it('detects Japanese characters', () => {
    expect(containsCJK('こんにちは')).toBe(true)
  })

  it('detects Korean characters', () => {
    expect(containsCJK('안녕')).toBe(true)
  })

  it('returns false for pure ASCII', () => {
    expect(containsCJK('hello')).toBe(false)
  })

  it('detects mixed text', () => {
    expect(containsCJK('hello你')).toBe(true)
  })
})
